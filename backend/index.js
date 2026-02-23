/**
 * =============================================================
 *  IoT Smart Cargo Monitor — Node.js Backend
 * =============================================================
 *  Stack : Express.js · Mongoose (MongoDB) · MQTT.js · Socket.IO
 *  Topics: cargo/+/telemetry  (wildcard single-level per device)
 *          cargo/alert/shock
 *
 *  Setup:
 *    cp .env.example .env   # fill in your values
 *    npm install
 *    npm run dev            # development (nodemon)
 *    npm start              # production
 * =============================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────
//  Environment
// ─────────────────────────────────────────────────────────────
require('dotenv').config();

const {
  MONGO_URI         = 'mongodb://127.0.0.1:27017/cargo_monitor',
  MQTT_BROKER_URL   = 'mqtt://localhost:1883',
  MQTT_USERNAME     = '',
  MQTT_PASSWORD     = '',
  MQTT_CA_CERT_PATH = '',
  PORT              = 4000,
  ALERT_TEMP_MAX    = 8.0,
  ALERT_SHOCK_G_MAX = 2.5,
  CORS_ORIGIN       = 'http://localhost:3000',
} = process.env;

// Parse numeric env vars (dotenv gives strings)
const TEMP_THRESHOLD  = parseFloat(ALERT_TEMP_MAX);
const SHOCK_THRESHOLD = parseFloat(ALERT_SHOCK_G_MAX);

// ─────────────────────────────────────────────────────────────
//  Imports
// ─────────────────────────────────────────────────────────────
const fs         = require('fs');
const path       = require('path');
const http       = require('http');
const express    = require('express');
const mongoose   = require('mongoose');
const mqtt       = require('mqtt');
const { Server } = require('socket.io');

// ─────────────────────────────────────────────────────────────
//  Logging helpers (timestamped, levelled)
// ─────────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString();
const log   = (...a) => console.log(`[${ts()}] [INFO ]`, ...a);
const warn  = (...a) => console.warn(`[${ts()}] [WARN ]`, ...a);
const error = (...a) => console.error(`[${ts()}] [ERROR]`, ...a);

// Bold red for critical alerts — ANSI escape codes
const CRITICAL = (...a) =>
  console.error(`\x1b[1;31m[${ts()}] [CRITICAL SHIPMENT ALERT]\x1b[0m`, ...a);

// ═════════════════════════════════════════════════════════════
//  1. MONGOOSE — MongoDB Connection & Schema
// ═════════════════════════════════════════════════════════════

// ── Schema ────────────────────────────────────────────────────
/**
 * CargoTelemetry: mirrors the firmware JSON payload.
 * Stored in a time-series-friendly collection with compound
 * indexes on (device_id + receivedAt) for efficient range queries.
 */
const telemetrySchema = new mongoose.Schema(
  {
    device_id:  { type: String,  required: true, index: true },
    temp:       { type: Number,  required: true },
    hum:        { type: Number,  required: true },
    shock_g:    { type: Number,  required: true },
    lat:        { type: Number,  default: null  },
    lon:        { type: Number,  default: null  },
    door_open:  { type: Boolean, default: false },
    // 'ts' from the device (device-local millis or epoch ms).
    // We store it as-received for fidelity.
    ts:         { type: Number,  required: true },
    // Server-side receive time — authoritative for queries
    receivedAt: { type: Date,    default: Date.now },   // index defined below
    // Which MQTT topic this arrived on
    topic:      { type: String },
  },
  {
    collection: 'telemetry',
    // Lean documents by default for better read perf
    versionKey: false,
  }
);

// Compound index: all queries are (device_id + time-descending)
telemetrySchema.index({ device_id: 1, receivedAt: -1 });

// TTL index — auto-expire documents after 90 days (optional, remove if unwanted)
telemetrySchema.index({ receivedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

const CargoTelemetry = mongoose.model('CargoTelemetry', telemetrySchema);

// ── Seperate model for shock alerts ──────────────────────────
const alertSchema = new mongoose.Schema(
  {
    device_id:  { type: String, required: true, index: true },
    alert:      { type: String, default: 'SHOCK_DETECTED' },
    shock_g:    { type: Number, required: true },
    lat:        { type: Number, default: null },
    lon:        { type: Number, default: null },
    ts:         { type: Number, required: true },
    receivedAt: { type: Date,   default: Date.now },   // index defined below
  },
  { collection: 'alerts', versionKey: false }
);

const CargoAlert = mongoose.model('CargoAlert', alertSchema);

// ── Connection ────────────────────────────────────────────────
async function connectMongo() {
  log(`MongoDB connecting → ${MONGO_URI}`);
  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS:          45_000,
  });
  log('MongoDB connected ✓');
}

mongoose.connection.on('disconnected', () => warn('MongoDB disconnected — will auto-reconnect'));
mongoose.connection.on('reconnected',  () => log('MongoDB reconnected ✓'));
mongoose.connection.on('error',        (err) => error('MongoDB error:', err.message));

// ═════════════════════════════════════════════════════════════
//  2. EXPRESS + HTTP SERVER + SOCKET.IO
// ═════════════════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);

// ── Socket.IO ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:  CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  // Compression for large bursts of telemetry data
  perMessageDeflate: { threshold: 512 },
});

io.on('connection', (socket) => {
  log(`Socket.IO client connected  id=${socket.id}`);
  socket.on('disconnect', (reason) =>
    log(`Socket.IO client disconnected id=${socket.id}  reason=${reason}`)
  );
});

// Helper: broadcast a named event to all connected clients
const broadcast = (event, payload) => io.emit(event, payload);

// ── Express Middleware ────────────────────────────────────────
app.use(express.json());

// CORS for REST endpoints (Socket.IO has its own cors config above)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    uptime:   process.uptime(),
    mongo:    mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    mqttConn: mqttConnected,
    ts:       new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────
//  REST API — GET /api/telemetry/:device_id
//  Returns the latest 100 records for a given device,
//  sorted newest-first. Accepts optional ?limit= (max 500).
// ─────────────────────────────────────────────────────────────
app.get('/api/telemetry/:device_id', async (req, res) => {
  try {
    const { device_id } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const records = await CargoTelemetry
      .find({ device_id })
      .sort({ receivedAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      device_id,
      count:   records.length,
      records,
    });
  } catch (err) {
    error('GET /api/telemetry error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  REST API — GET /api/alerts/:device_id
//  Returns the latest 50 shock alerts for a device.
// ─────────────────────────────────────────────────────────────
app.get('/api/alerts/:device_id', async (req, res) => {
  try {
    const { device_id } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const alerts = await CargoAlert
      .find({ device_id })
      .sort({ receivedAt: -1 })
      .limit(limit)
      .lean();

    res.json({ device_id, count: alerts.length, alerts });
  } catch (err) {
    error('GET /api/alerts error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  REST API — GET /api/devices
//  Returns unique list of device IDs seen in the last 24h.
// ─────────────────────────────────────────────────────────────
app.get('/api/devices', async (_req, res) => {
  try {
    const since   = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const devices = await CargoTelemetry.distinct('device_id', {
      receivedAt: { $gte: since },
    });
    res.json({ count: devices.length, devices });
  } catch (err) {
    error('GET /api/devices error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═════════════════════════════════════════════════════════════
//  3. MQTT CLIENT
// ═════════════════════════════════════════════════════════════
let mqttConnected = false;

/**
 * Build TLS options for MQTTS connections.
 * Loads CA cert from disk if MQTT_CA_CERT_PATH is set.
 */
function buildMqttOptions() {
  const opts = {
    clientId:             `cargo-backend-${Math.random().toString(16).slice(2, 8)}`,
    clean:                true,
    reconnectPeriod:      5_000,
    connectTimeout:       30_000,
    keepalive:            60,
    rejectUnauthorized:   true,   // Always verify broker cert in production
  };

  if (MQTT_USERNAME) opts.username = MQTT_USERNAME;
  if (MQTT_PASSWORD) opts.password = MQTT_PASSWORD;

  // Load CA cert for MQTTS
  if (MQTT_BROKER_URL.startsWith('mqtts://') || MQTT_BROKER_URL.startsWith('ssl://')) {
    if (MQTT_CA_CERT_PATH) {
      const certPath = path.resolve(MQTT_CA_CERT_PATH);
      if (fs.existsSync(certPath)) {
        opts.ca = fs.readFileSync(certPath);
        log(`MQTT TLS: loaded CA from ${certPath}`);
      } else {
        warn(`MQTT TLS: CA cert not found at ${certPath} — using system CAs`);
      }
    }
    // For dev with self-signed certs uncomment next line:
    // opts.rejectUnauthorized = false;
  }

  return opts;
}

// ── Topic subscription map ─────────────────────────────────────
// Subscribes to wildcard topic that covers all device IDs:
//   cargo/+/telemetry  → individual device telemetry
//   cargo/alert/shock  → shock alerts published by devices directly
const SUBSCRIBE_TOPICS = {
  'cargo/+/telemetry': { qos: 1 },
  'cargo/alert/shock': { qos: 1 },
  // Also cover the flat topic pattern used by hivemq_random_data.py
  'cargo/telemetry':   { qos: 1 },
};

function connectMqtt() {
  log(`MQTT connecting → ${MQTT_BROKER_URL}`);
  const mqttClient = mqtt.connect(MQTT_BROKER_URL, buildMqttOptions());

  // ── Event: connected ────────────────────────────────────
  mqttClient.on('connect', () => {
    mqttConnected = true;
    log('MQTT connected ✓');

    mqttClient.subscribe(SUBSCRIBE_TOPICS, (err, granted) => {
      if (err) {
        error('MQTT subscribe error:', err.message);
        return;
      }
      granted.forEach(({ topic, qos }) =>
        log(`MQTT subscribed → ${topic}  (QoS ${qos})`)
      );
    });
  });

  // ── Event: message ──────────────────────────────────────
  mqttClient.on('message', (topic, rawPayload) => {
    handleMessage(topic, rawPayload);
  });

  // ── Event: lifecycle ────────────────────────────────────
  mqttClient.on('reconnect',   () => { mqttConnected = false; warn('MQTT reconnecting...'); });
  mqttClient.on('offline',     () => { mqttConnected = false; warn('MQTT offline');         });
  mqttClient.on('close',       () => { mqttConnected = false; log('MQTT connection closed');});
  mqttClient.on('error',       (err) => error('MQTT error:', err.message));

  return mqttClient;
}

// ─────────────────────────────────────────────────────────────
//  Message Handler — parse, validate, alert, persist, broadcast
// ─────────────────────────────────────────────────────────────
async function handleMessage(topic, rawPayload) {
  // ── 1. Parse JSON ────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(rawPayload.toString('utf8'));
  } catch {
    warn(`MQTT [${topic}] invalid JSON — skipping`);
    return;
  }

  log(`MQTT RX [${topic}]`, JSON.stringify(data));

  // ── 2. Route by topic ────────────────────────────────────
  const isShockAlert = topic.endsWith('shock') || data.alert === 'SHOCK_DETECTED';

  if (isShockAlert) {
    await handleShockAlert(topic, data);
    return;
  }

  await handleTelemetry(topic, data);
}

// ── Payload normalizer ────────────────────────────────────
// Accepts both firmware format AND legacy simulator format:
//   Firmware : { temp, hum, shock_g, ts, lat, lon, door_open, device_id }
//   Simulator: { temperature, timestamp, location:{lat,lon}, battery, device_id }
function normalizePayload(raw) {
  const temp    = raw.temp    ?? raw.temperature    ?? null;
  const hum     = raw.hum     ?? raw.humidity       ?? 0;     // not in simulator — default 0
  const shock_g = raw.shock_g ?? raw.shock          ?? 0;     // not in simulator — default 0
  const lat     = raw.lat     ?? raw.location?.lat  ?? null;
  const lon     = raw.lon     ?? raw.location?.lon  ?? null;
  const door_open = raw.door_open ?? false;
  const battery   = raw.battery   ?? null;  // store simulator extra field

  // Normalise timestamp: ISO string → epoch ms, or pass-through number
  let ts = raw.ts ?? raw.timestamp ?? null;
  if (typeof ts === 'string') ts = new Date(ts).getTime();

  return { device_id: raw.device_id, temp, hum, shock_g, lat, lon, door_open, battery, ts };
}

// ── Telemetry handler ──────────────────────────────────────
async function handleTelemetry(topic, raw) {
  const data = normalizePayload(raw);

  // Validate required fields after normalization
  const { device_id, temp, hum, shock_g, ts } = data;

  if (!device_id || temp == null || ts == null) {
    warn(`Telemetry payload missing required fields from [${topic}]:`, raw);
    return;
  }

  // ── 3. Alert Logic ────────────────────────────────────────
  const alerts = [];
  if (temp > TEMP_THRESHOLD) {
    alerts.push(`TEMPERATURE EXCEEDED: ${temp}°C > threshold ${TEMP_THRESHOLD}°C`);
  }
  if (shock_g > SHOCK_THRESHOLD) {
    alerts.push(`SHOCK EXCEEDED: ${shock_g}G > threshold ${SHOCK_THRESHOLD}G`);
  }
  if (alerts.length > 0) {
    alerts.forEach((msg) =>
      CRITICAL(`Device=${device_id} | ${msg} | lat=${data.lat} lon=${data.lon} | ts=${ts}`)
    );
    // Broadcast a dedicated alert event to the frontend
    broadcast('cargo:alert', {
      device_id,
      alerts,
      temp,
      shock_g,
      lat:  data.lat  ?? null,
      lon:  data.lon  ?? null,
      ts,
      receivedAt: new Date().toISOString(),
    });
  }

  // ── 4. Persist to MongoDB ────────────────────────────────
  try {
    await CargoTelemetry.create({
      device_id,
      temp,
      hum,
      shock_g,
      lat:       data.lat       ?? null,
      lon:       data.lon       ?? null,
      door_open: data.door_open ?? false,
      ts,
      topic,
    });
  } catch (err) {
    error('MongoDB insert telemetry error:', err.message);
    return;
  }

  // ── 5. Broadcast to all WebSocket clients ─────────────────
  broadcast('cargo:telemetry', {
    device_id,
    temp,
    hum,
    shock_g,
    lat:       data.lat       ?? null,
    lon:       data.lon       ?? null,
    door_open: data.door_open ?? false,
    ts,
    receivedAt: new Date().toISOString(),
  });
}

// ── Shock alert handler ────────────────────────────────────
async function handleShockAlert(topic, data) {
  const { device_id, shock_g, ts } = data;

  if (!device_id || shock_g == null || ts == null) {
    warn(`Shock alert missing fields from [${topic}]:`, data);
    return;
  }

  CRITICAL(
    `SHOCK ALERT from Device=${device_id} | ${shock_g}G | ` +
    `lat=${data.lat ?? 'N/A'} lon=${data.lon ?? 'N/A'} | ts=${ts}`
  );

  try {
    await CargoAlert.create({
      device_id,
      alert:  data.alert ?? 'SHOCK_DETECTED',
      shock_g,
      lat: data.lat ?? null,
      lon: data.lon ?? null,
      ts,
    });
  } catch (err) {
    error('MongoDB insert alert error:', err.message);
    return;
  }

  broadcast('cargo:shock_alert', {
    device_id,
    shock_g,
    lat:       data.lat ?? null,
    lon:       data.lon ?? null,
    ts,
    receivedAt: new Date().toISOString(),
  });
}

// ═════════════════════════════════════════════════════════════
//  4. BOOTSTRAP — connect everything, then start HTTP server
// ═════════════════════════════════════════════════════════════
(async () => {
  try {
    // MongoDB must be available before we handle messages
    await connectMongo();

    // MQTT client (auto-reconnects on failure)
    connectMqtt();

    // Start HTTP + Socket.IO server
    server.listen(PORT, () => {
      log(`HTTP server listening on http://localhost:${PORT}`);
      log(`Socket.IO accepting connections on ws://localhost:${PORT}`);
      log('─────────────────────────────────────────────────────────');
      log(`Alert thresholds — Temp > ${TEMP_THRESHOLD}°C | Shock > ${SHOCK_THRESHOLD}G`);
    });
  } catch (err) {
    error('Bootstrap failed:', err);
    process.exit(1);
  }
})();

// ═════════════════════════════════════════════════════════════
//  5. GRACEFUL SHUTDOWN
// ═════════════════════════════════════════════════════════════
async function shutdown(signal) {
  warn(`Received ${signal} — shutting down gracefully...`);
  server.close(() => log('HTTP server closed'));
  await mongoose.disconnect();
  log('MongoDB disconnected');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => error('Uncaught Exception:',       err));
process.on('unhandledRejection', (err) => error('Unhandled Rejection:',      err));
