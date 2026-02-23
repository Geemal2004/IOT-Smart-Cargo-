/**
 * Dashboard.jsx — IoT Cargo Monitor Live Dashboard
 * ─────────────────────────────────────────────────
 * React 18 · socket.io-client · react-leaflet · Recharts · Tailwind CSS
 *
 * Socket.IO events consumed:
 *   cargo:telemetry   — live sensor reading
 *   cargo:alert       — threshold-crossing alert from backend
 *   cargo:shock_alert — shock-only alert from device
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { io } from 'socket.io-client';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

// ─────────────────────────────────────────────────────────────
//  Fix Leaflet default icon path broken by Vite asset bundling
// ─────────────────────────────────────────────────────────────
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon   from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:       markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl:     markerShadow,
});

// ─────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────
const BACKEND_URL       = 'http://localhost:4000';
const SHOCK_THRESHOLD   = 2.5;    // G  — mirrors backend ALERT_SHOCK_G_MAX
const TEMP_THRESHOLD    = 8.0;    // °C — mirrors backend ALERT_TEMP_MAX
const MAX_CHART_POINTS  = 60;     // Rolling window for live chart
const MAX_ALERT_ENTRIES = 50;     // Max alerts kept in local feed
const ALERT_DISMISS_MS  = 8000;   // Auto-dismiss banner after 8 s
const DEFAULT_CENTER    = [34.0522, -118.2437]; // Fallback: Los Angeles
const DEFAULT_ZOOM      = 13;

// ─────────────────────────────────────────────────────────────
//  Formatting helpers
// ─────────────────────────────────────────────────────────────
const fmtTime = (ts) => {
  if (!ts) return '--';
  // ts is device millis (relative) — display as HH:MM:SS from received time
  return new Date().toLocaleTimeString('en-US', { hour12: false });
};

const fmtTemp  = (v) => (v != null ? `${Number(v).toFixed(1)} °C` : '--');
const fmtHum   = (v) => (v != null ? `${Number(v).toFixed(1)} %`  : '--');
const fmtShock = (v) => (v != null ? `${Number(v).toFixed(3)} G`  : '--');
const fmtCoord = (v) => (v != null ? Number(v).toFixed(4)          : '--');

// ═════════════════════════════════════════════════════════════
//  CUSTOM HOOK — useTelemetry
//  Manages Socket.IO connection, telemetry state, alert state
// ═════════════════════════════════════════════════════════════
function useTelemetry() {
  const [connected,    setConnected]    = useState(false);
  const [latest,       setLatest]       = useState(null);   // most recent reading
  const [chartData,    setChartData]    = useState([]);      // rolling 60-point array
  const [alerts,       setAlerts]       = useState([]);      // alert feed entries
  const [bannerAlert,  setBannerAlert]  = useState(null);    // top banner (auto-dismiss)
  const bannerTimerRef = useRef(null);
  const socketRef      = useRef(null);

  // ── Push a new alert entry ─────────────────────────────
  const pushAlert = useCallback((type, data) => {
    const entry = {
      id:        `${Date.now()}-${Math.random()}`,
      type,       // 'threshold' | 'shock'
      device_id: data.device_id,
      message:   type === 'shock'
        ? `⚡ SHOCK ${Number(data.shock_g).toFixed(3)} G on ${data.device_id}`
        : `⚠ ALERT: ${(data.alerts ?? []).join(' | ')} on ${data.device_id}`,
      ts:        new Date().toLocaleTimeString(),
      raw:       data,
    };

    setAlerts((prev) => [entry, ...prev].slice(0, MAX_ALERT_ENTRIES));

    // Banner with auto-dismiss
    setBannerAlert(entry);
    clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => setBannerAlert(null), ALERT_DISMISS_MS);
  }, []);

  // ── Append a new data point to the chart buffer ────────
  const appendChartPoint = useCallback((reading) => {
    setChartData((prev) => {
      const point = {
        time:    new Date().toLocaleTimeString('en-US', {
          hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
        }),
        temp:    Number(Number(reading.temp).toFixed(2)),
        shock_g: Number(Number(reading.shock_g).toFixed(3)),
        hum:     Number(Number(reading.hum).toFixed(1)),
      };
      const next = [...prev, point];
      return next.length > MAX_CHART_POINTS ? next.slice(-MAX_CHART_POINTS) : next;
    });
  }, []);

  // ── Socket.IO setup ────────────────────────────────────
  useEffect(() => {
    const socket = io(BACKEND_URL, {
      transports:        ['websocket', 'polling'],
      reconnectionDelay:  2000,
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;

    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    // Real-time telemetry
    socket.on('cargo:telemetry', (data) => {
      setLatest(data);
      appendChartPoint(data);
    });

    // Threshold alert (temp or shock) from backend
    socket.on('cargo:alert', (data) => {
      pushAlert('threshold', data);
    });

    // Shock alert published directly from device firmware
    socket.on('cargo:shock_alert', (data) => {
      pushAlert('shock', data);
      setLatest((prev) => ({
        ...prev,
        ...data,
        shock_g: data.shock_g,
      }));
      appendChartPoint({ temp: data.temp ?? 0, hum: data.hum ?? 0, shock_g: data.shock_g });
    });

    return () => {
      clearTimeout(bannerTimerRef.current);
      socket.disconnect();
    };
  }, [appendChartPoint, pushAlert]);

  const dismissBanner = useCallback(() => {
    clearTimeout(bannerTimerRef.current);
    setBannerAlert(null);
  }, []);

  return { connected, latest, chartData, alerts, bannerAlert, dismissBanner };
}

// ═════════════════════════════════════════════════════════════
//  SUB-COMPONENT — ConnectionBadge
// ═════════════════════════════════════════════════════════════
function ConnectionBadge({ connected }) {
  return (
    <div className={`
      inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold
      ${connected
        ? 'bg-emerald-900/60 text-emerald-400 ring-1 ring-emerald-500/40'
        : 'bg-red-900/60    text-red-400    ring-1 ring-red-500/40'}
    `}>
      <span className={`
        w-2 h-2 rounded-full
        ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400 animate-pulse-fast'}
      `} />
      {connected ? 'LIVE' : 'DISCONNECTED'}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
//  SUB-COMPONENT — AlertBanner
// ═════════════════════════════════════════════════════════════
function AlertBanner({ alert, onDismiss }) {
  if (!alert) return null;
  return (
    <div className="animate-fade-in flex items-start justify-between gap-4 bg-red-600
                    text-white px-4 py-3 rounded-lg shadow-lg shadow-red-900/40
                    ring-1 ring-red-400/50">
      <div className="flex items-center gap-3">
        <span className="text-xl select-none">🚨</span>
        <div>
          <p className="font-bold text-sm tracking-wide">CRITICAL SHIPMENT ALERT</p>
          <p className="text-xs opacity-90 mt-0.5">{alert.message}</p>
        </div>
      </div>
      <button
        onClick={onDismiss}
        className="text-white/70 hover:text-white text-lg leading-none mt-0.5 shrink-0"
        aria-label="Dismiss alert"
      >
        ✕
      </button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
//  SUB-COMPONENT — SensorCard
// ═════════════════════════════════════════════════════════════
function SensorCard({ label, value, unit, icon, highlight, subtext }) {
  return (
    <div className={`
      flex flex-col gap-1 p-4 rounded-xl ring-1 transition-all duration-300
      ${highlight
        ? 'bg-red-950/80 ring-red-500 shadow-lg shadow-red-900/50'
        : 'bg-gray-800/60 ring-gray-700/50'}
    `}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium tracking-widest text-gray-400 uppercase">
          {label}
        </span>
        <span className="text-lg">{icon}</span>
      </div>
      <div className={`
        text-2xl font-bold font-mono tracking-tight
        ${highlight ? 'text-red-300' : 'text-white'}
      `}>
        {value}
        <span className={`
          text-sm font-normal ml-1.5
          ${highlight ? 'text-red-400' : 'text-gray-400'}
        `}>{unit}</span>
      </div>
      {subtext && (
        <p className={`text-xs mt-0.5 ${highlight ? 'text-red-400' : 'text-gray-500'}`}>
          {subtext}
        </p>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
//  SUB-COMPONENT — StatusPanel
//  The entire panel turns bright red when shock_g > 2.5
// ═════════════════════════════════════════════════════════════
function StatusPanel({ latest }) {
  const shockCritical = (latest?.shock_g ?? 0) > SHOCK_THRESHOLD;
  const tempCritical  = (latest?.temp    ?? 0) > TEMP_THRESHOLD;
  const anyCritical   = shockCritical || tempCritical;

  if (!latest) {
    return (
      <div className="bg-gray-800/40 ring-1 ring-gray-700/50 rounded-2xl p-5">
        <h2 className="text-gray-400 text-sm font-semibold tracking-wider uppercase mb-4">
          Status Panel
        </h2>
        <p className="text-gray-500 text-sm text-center py-6">
          Waiting for first telemetry packet...
        </p>
      </div>
    );
  }

  return (
    <div className={`
      rounded-2xl p-5 ring-1 transition-all duration-500
      ${anyCritical
        ? 'bg-red-950/90 ring-red-500 shadow-[0_0_40px_rgba(239,68,68,0.3)]'
        : 'bg-gray-800/40 ring-gray-700/50'}
    `}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className={`
          text-sm font-semibold tracking-wider uppercase
          ${anyCritical ? 'text-red-400' : 'text-gray-400'}
        `}>
          Status Panel
        </h2>
        {anyCritical && (
          <span className="animate-pulse-fast text-xs font-bold text-red-300 tracking-widest">
            ● CRITICAL
          </span>
        )}
      </div>

      {/* Device identity row */}
      <div className="flex items-center gap-3 mb-4 pb-4 border-b border-white/5">
        <span className="text-2xl">📦</span>
        <div>
          <p className={`font-bold text-sm ${anyCritical ? 'text-red-200' : 'text-white'}`}>
            {latest.device_id ?? 'Unknown Device'}
          </p>
          <p className="text-xs text-gray-500">
            Last update: <span className="text-gray-400">{new Date().toLocaleTimeString()}</span>
          </p>
        </div>
        {/* Door status pill */}
        <div className={`
          ml-auto inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full
          ${latest.door_open
            ? 'bg-orange-900/70 text-orange-300 ring-1 ring-orange-500/50'
            : 'bg-emerald-900/50 text-emerald-400 ring-1 ring-emerald-700/50'}
        `}>
          {latest.door_open ? '🔓 OPEN' : '🔒 SEALED'}
        </div>
      </div>

      {/* Sensor cards grid */}
      <div className="grid grid-cols-2 gap-3">
        <SensorCard
          label="Temperature"
          value={latest.temp != null ? Number(latest.temp).toFixed(1) : '--'}
          unit="°C"
          icon="🌡️"
          highlight={tempCritical}
          subtext={tempCritical ? `Threshold: ${TEMP_THRESHOLD} °C` : null}
        />
        <SensorCard
          label="Humidity"
          value={latest.hum != null ? Number(latest.hum).toFixed(1) : '--'}
          unit="%"
          icon="💧"
          highlight={false}
        />
        <SensorCard
          label="Shock (G-force)"
          value={latest.shock_g != null ? Number(latest.shock_g).toFixed(3) : '--'}
          unit="G"
          icon="💥"
          highlight={shockCritical}
          subtext={shockCritical ? `Threshold: ${SHOCK_THRESHOLD} G` : null}
        />
        <SensorCard
          label="GPS Position"
          value={fmtCoord(latest.lat)}
          unit=""
          icon="📍"
          highlight={false}
          subtext={latest.lon != null ? `${fmtCoord(latest.lon)} lon` : null}
        />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
//  SUB-COMPONENT — MapViewUpdater (must be a child of MapContainer)
//  Smoothly flies the map to new coordinates as they arrive
// ═════════════════════════════════════════════════════════════
function MapViewUpdater({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center) {
      map.flyTo(center, DEFAULT_ZOOM, { duration: 1.4, easeLinearity: 0.25 });
    }
  }, [map, center]);
  return null;
}

// ═════════════════════════════════════════════════════════════
//  SUB-COMPONENT — LiveMap
// ═════════════════════════════════════════════════════════════
function LiveMap({ latest }) {
  const position = useMemo(() => {
    if (latest?.lat != null && latest?.lon != null) {
      return [latest.lat, latest.lon];
    }
    return null;
  }, [latest?.lat, latest?.lon]);

  const shockCritical = (latest?.shock_g ?? 0) > SHOCK_THRESHOLD;

  // Custom marker icon — red when shock critical
  const customIcon = useMemo(() => L.divIcon({
    className: '',
    html: `
      <div style="
        background: ${shockCritical ? '#ef4444' : '#3b82f6'};
        width: 18px; height: 18px;
        border-radius: 50%;
        border: 3px solid white;
        box-shadow: 0 0 ${shockCritical ? '12px 4px rgba(239,68,68,0.8)' : '6px 2px rgba(59,130,246,0.5)'};
      "></div>`,
    iconSize:   [18, 18],
    iconAnchor: [9, 9],
  }), [shockCritical]);

  return (
    <div className="bg-gray-800/40 ring-1 ring-gray-700/50 rounded-2xl p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-gray-400 text-sm font-semibold tracking-wider uppercase">
          Live Location
        </h2>
        {position && (
          <span className="text-xs text-gray-500 font-mono">
            {Number(position[0]).toFixed(4)}, {Number(position[1]).toFixed(4)}
          </span>
        )}
      </div>

      {/* Map container — explicit height required by Leaflet */}
      <div className="rounded-xl overflow-hidden" style={{ height: '300px' }}>
        <MapContainer
          center={position ?? DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          scrollWheelZoom={true}
          style={{ width: '100%', height: '100%' }}
          zoomControl={true}
        >
          {/* Smooth map tile updates when position changes */}
          {position && <MapViewUpdater center={position} />}

          {/* OpenStreetMap tiles — no API key required */}
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* Cargo device marker */}
          {position && (
            <Marker position={position} icon={customIcon}>
              <Popup>
                <div className="text-sm font-sans">
                  <p className="font-bold text-gray-800 mb-1">
                    📦 {latest?.device_id ?? 'Cargo Device'}
                  </p>
                  <p>🌡 Temp: <strong>{fmtTemp(latest?.temp)}</strong></p>
                  <p>💧 Hum:  <strong>{fmtHum(latest?.hum)}</strong></p>
                  <p>💥 Shock: <strong>{fmtShock(latest?.shock_g)}</strong></p>
                  <p>📍 {fmtCoord(latest?.lat)}, {fmtCoord(latest?.lon)}</p>
                </div>
              </Popup>
            </Marker>
          )}
        </MapContainer>
      </div>

      {!position && (
        <p className="text-xs text-gray-500 text-center -mt-1">
          Map centered on default coordinates — awaiting live GPS
        </p>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
//  SUB-COMPONENT — TelemetryChart
//  Dual-axis live line chart: Temperature (left) · Shock G (right)
// ═════════════════════════════════════════════════════════════
function TelemetryChart({ data }) {
  const hasData = data.length > 0;

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-gray-900 ring-1 ring-gray-700 rounded-lg p-3 text-xs shadow-xl">
        <p className="text-gray-400 mb-1.5">{label}</p>
        {payload.map((entry) => (
          <p key={entry.name} style={{ color: entry.color }} className="font-mono">
            {entry.name === 'shock_g'
              ? `Shock: ${Number(entry.value).toFixed(3)} G`
              : `Temp:  ${Number(entry.value).toFixed(1)} °C`}
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className="bg-gray-800/40 ring-1 ring-gray-700/50 rounded-2xl p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-gray-400 text-sm font-semibold tracking-wider uppercase">
          Live Telemetry
        </h2>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-blue-400 inline-block rounded" />
            Temperature
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-orange-400 inline-block rounded" />
            Shock (G)
          </span>
        </div>
      </div>

      {!hasData ? (
        <div className="flex items-center justify-center h-64 text-gray-600 text-sm">
          Waiting for data...
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" strokeOpacity={0.6} />

            <XAxis
              dataKey="time"
              tick={{ fill: '#6b7280', fontSize: 10 }}
              tickLine={{ stroke: '#374151' }}
              axisLine={{ stroke: '#374151' }}
              interval="preserveStartEnd"
            />

            {/* Left Y axis — Temperature */}
            <YAxis
              yAxisId="temp"
              orientation="left"
              domain={[-10, 60]}
              tick={{ fill: '#60a5fa', fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: '#374151' }}
              tickFormatter={(v) => `${v}°`}
              width={36}
            />

            {/* Right Y axis — Shock G-force */}
            <YAxis
              yAxisId="shock"
              orientation="right"
              domain={[0, 10]}
              tick={{ fill: '#fb923c', fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: '#374151' }}
              tickFormatter={(v) => `${v}G`}
              width={36}
            />

            <Tooltip content={<CustomTooltip />} />

            {/* Threshold reference lines */}
            <ReferenceLine yAxisId="temp"  y={TEMP_THRESHOLD}  stroke="#ef4444" strokeDasharray="4 4"
              label={{ value: `${TEMP_THRESHOLD}°C`, fill: '#ef4444', fontSize: 9, position: 'right' }} />
            <ReferenceLine yAxisId="shock" y={SHOCK_THRESHOLD} stroke="#f97316" strokeDasharray="4 4"
              label={{ value: `${SHOCK_THRESHOLD}G`, fill: '#f97316', fontSize: 9, position: 'right' }} />

            <Line
              yAxisId="temp"
              type="monotone"
              dataKey="temp"
              name="temp"
              stroke="#60a5fa"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: '#60a5fa' }}
              isAnimationActive={false}
            />

            <Line
              yAxisId="shock"
              type="monotone"
              dataKey="shock_g"
              name="shock_g"
              stroke="#fb923c"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: '#fb923c' }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      <p className="text-xs text-gray-600 text-right -mt-2">
        Rolling {MAX_CHART_POINTS}-point buffer · {data.length} points shown
      </p>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
//  SUB-COMPONENT — AlertFeed
//  Scrollable feed of all received alert events
// ═════════════════════════════════════════════════════════════
function AlertFeed({ alerts }) {
  return (
    <div className="bg-gray-800/40 ring-1 ring-gray-700/50 rounded-2xl p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-gray-400 text-sm font-semibold tracking-wider uppercase">
          Alert Feed
        </h2>
        {alerts.length > 0 && (
          <span className="bg-red-900/70 text-red-300 text-xs font-bold px-2 py-0.5 rounded-full ring-1 ring-red-700/50">
            {alerts.length}
          </span>
        )}
      </div>

      <div className="alert-scroll overflow-y-auto max-h-48 flex flex-col gap-2 pr-1">
        {alerts.length === 0 ? (
          <p className="text-gray-600 text-xs text-center py-4">
            No alerts yet — system nominal
          </p>
        ) : (
          alerts.map((a) => (
            <div
              key={a.id}
              className={`
                flex items-start gap-2.5 px-3 py-2.5 rounded-lg ring-1 text-xs animate-fade-in
                ${a.type === 'shock'
                  ? 'bg-red-950/60 ring-red-800/50 text-red-300'
                  : 'bg-amber-950/60 ring-amber-800/50 text-amber-300'}
              `}
            >
              <span className="shrink-0 mt-0.5">{a.type === 'shock' ? '⚡' : '⚠️'}</span>
              <div className="min-w-0">
                <p className="font-medium truncate">{a.message}</p>
                <p className="text-gray-500 mt-0.5">{a.ts}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
//  MAIN — Dashboard
// ═════════════════════════════════════════════════════════════
export default function Dashboard() {
  const {
    connected,
    latest,
    chartData,
    alerts,
    bannerAlert,
    dismissBanner,
  } = useTelemetry();

  const anyCritical = (latest?.shock_g ?? 0) > SHOCK_THRESHOLD
                   || (latest?.temp    ?? 0) > TEMP_THRESHOLD;

  return (
    <div className={`
      min-h-screen font-sans transition-colors duration-700
      ${anyCritical ? 'bg-gray-950' : 'bg-gray-950'}
    `}>
      {/* ── Top nav bar ─────────────────────────────────── */}
      <header className={`
        sticky top-0 z-50 backdrop-blur-md border-b transition-all duration-500
        ${anyCritical
          ? 'bg-red-950/80 border-red-800/50'
          : 'bg-gray-900/80 border-gray-800/60'}
      `}>
        <div className="max-w-screen-2xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📦</span>
            <div>
              <h1 className="text-white font-bold text-base tracking-tight">
                Smart Cargo Monitor
              </h1>
              <p className="text-gray-500 text-xs">Enterprise IoT Dashboard</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {latest?.device_id && (
              <span className="hidden sm:block text-xs text-gray-500 font-mono">
                {latest.device_id}
              </span>
            )}
            <ConnectionBadge connected={connected} />
          </div>
        </div>
      </header>

      {/* ── Alert banner ────────────────────────────────── */}
      {bannerAlert && (
        <div className="max-w-screen-2xl mx-auto px-6 pt-4">
          <AlertBanner alert={bannerAlert} onDismiss={dismissBanner} />
        </div>
      )}

      {/* ── Main grid ───────────────────────────────────── */}
      <main className="max-w-screen-2xl mx-auto px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* ── Left column: Status Panel + Alert Feed ──── */}
          <div className="flex flex-col gap-6">
            <StatusPanel latest={latest} />
            <AlertFeed alerts={alerts} />
          </div>

          {/* ── Right columns: Map + Chart ──────────────── */}
          <div className="lg:col-span-2 flex flex-col gap-6">
            <LiveMap latest={latest} />
            <TelemetryChart data={chartData} />
          </div>

        </div>
      </main>

      {/* ── Footer ──────────────────────────────────────── */}
      <footer className="text-center text-gray-700 text-xs py-6">
        IoT Smart Cargo Monitor · Real-time via Socket.IO · Data stored in MongoDB
      </footer>
    </div>
  );
}
