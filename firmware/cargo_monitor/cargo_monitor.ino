/**
 * ============================================================
 *  IoT Smart Cargo Monitor — ESP32-S3 Firmware
 * ============================================================
 *  Hardware  : ESP32-S3 DevKit
 *  Sensors   : DHT22 (temp/hum) · MPU6050 (shock via I2C)
 *  Storage   : SD card (SPI) for offline buffering
 *  Protocol  : MQTTS (TLS port 8883) · ArduinoJson payloads
 *
 *  Required Libraries (install via Arduino Library Manager):
 *    - PubSubClient          by Nick O'Leary      >= 2.8.0
 *    - ArduinoJson           by Benoit Blanchon   >= 7.0.0
 *    - DHT sensor library    by Adafruit          >= 1.4.6
 *    - Adafruit MPU6050      by Adafruit          >= 2.2.6
 *    - Adafruit Unified Sensor                    >= 1.1.14
 *    - SD (built-in ESP32 core)
 *    - Wire (built-in)
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────
//  Includes
// ─────────────────────────────────────────────────────────────
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <SD.h>
#include <SPI.h>

#include "secrets.h"
#include "ca_cert.h"

// ─────────────────────────────────────────────────────────────
//  Pin Definitions
// ─────────────────────────────────────────────────────────────
#define DHT_PIN         4       // DHT22 data pin
#define DHT_TYPE        DHT22

// SD card — hardware SPI on ESP32-S3 default SPI bus
#define SD_CS_PIN       10      // Chip Select
// MOSI = 11, MISO = 13, SCK = 12 (ESP32-S3 defaults; adjust if needed)

// MPU6050 uses I2C — default SDA=8, SCL=9 on many ESP32-S3 boards
// Override with Wire.begin(SDA_PIN, SCL_PIN) if your board differs
#define I2C_SDA         8
#define I2C_SCL         9

// ─────────────────────────────────────────────────────────────
//  Application Constants
// ─────────────────────────────────────────────────────────────
// Shock threshold in G-force (1 G ≈ 9.81 m/s²)
constexpr float     SHOCK_THRESHOLD_G      = 2.5f;

// MPU6050 sampling interval (50 Hz → 20 ms)
constexpr uint32_t  MPU_SAMPLE_INTERVAL_MS = 20;

// Normal telemetry publish interval (every 5 seconds)
constexpr uint32_t  TELEMETRY_INTERVAL_MS  = 5000;

// Wi-Fi reconnect attempt interval
constexpr uint32_t  WIFI_RECONNECT_MS      = 10000;

// MQTT reconnect attempt interval
constexpr uint32_t  MQTT_RECONNECT_MS      = 5000;

// Max MQTT payload size in bytes (must match PubSubClient buffer)
constexpr uint16_t  MQTT_MAX_PAYLOAD       = 512;

// Offline buffer file on SD card
constexpr char      BUFFER_FILE[]          = "/log.txt";

// Static placeholder GPS coordinates (Los Angeles — replace with GPS later)
constexpr float     GPS_LAT                = 34.0522f;
constexpr float     GPS_LON                = -118.2437f;

// ─────────────────────────────────────────────────────────────
//  Global Objects
// ─────────────────────────────────────────────────────────────
WiFiClientSecure  secureClient;
PubSubClient      mqttClient(secureClient);
DHT               dht(DHT_PIN, DHT_TYPE);
Adafruit_MPU6050  mpu;

// ─────────────────────────────────────────────────────────────
//  State Variables
// ─────────────────────────────────────────────────────────────
static bool       sdAvailable      = false;
static bool       shockAlertPending = false;   // set by ISR-safe shock detector
static float      latestShockG     = 0.0f;

// Timestamps for non-blocking scheduling
static uint32_t   lastTelemetryMs  = 0;
static uint32_t   lastWiFiCheckMs  = 0;
static uint32_t   lastMqttCheckMs  = 0;
static uint32_t   lastMpuSampleMs  = 0;

// ═════════════════════════════════════════════════════════════
//  FORWARD DECLARATIONS
// ═════════════════════════════════════════════════════════════
void wifiConnect();
bool mqttReconnect();
void mqttCallback(char* topic, byte* payload, unsigned int length);
bool publishPayload(const char* topic, const char* jsonStr);
void buildTelemetryJson(char* buf, size_t bufLen,
                        float temp, float hum,
                        float shockG, bool doorOpen);
void buildAlertJson(char* buf, size_t bufLen, float shockG);
void sampleMPU();
void readDHTAndPublish();
void drainOfflineBuffer();
void writeToBuffer(const char* jsonLine);
bool isConnected();

// ═════════════════════════════════════════════════════════════
//  SETUP
// ═════════════════════════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    while (!Serial && millis() < 3000) { /* wait for USB-CDC */ }

    Serial.println(F("\n[BOOT] IoT Cargo Monitor — ESP32-S3 Firmware"));
    Serial.println(F("[BOOT] Firmware Date: 2026-02-23"));
    Serial.printf("[BOOT] Device ID: %s\n", DEVICE_ID);

    // ── I2C & MPU6050 ──────────────────────────────────────
    Wire.begin(I2C_SDA, I2C_SCL);
    if (!mpu.begin()) {
        Serial.println(F("[MPU6050] FATAL: Sensor not found. Check wiring!"));
        // Non-fatal in production — continue without shock detection
    } else {
        mpu.setAccelerometerRange(MPU6050_RANGE_8_G);  // ±8G covers shock events
        mpu.setGyroRange(MPU6050_RANGE_500_DEG);
        mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);    // Anti-aliasing filter
        Serial.println(F("[MPU6050] Initialized — ±8G range, 21Hz LPF"));
    }

    // ── DHT22 ──────────────────────────────────────────────
    dht.begin();
    Serial.println(F("[DHT22]   Initialized"));

    // ── SD Card ────────────────────────────────────────────
    SPI.begin();
    if (!SD.begin(SD_CS_PIN)) {
        Serial.println(F("[SD]      Warning: SD card not found — offline buffer disabled"));
        sdAvailable = false;
    } else {
        sdAvailable = true;
        uint64_t cardSizeMB = SD.cardSize() / (1024 * 1024);
        Serial.printf("[SD]      Initialized — %.0llu MB\n", cardSizeMB);
    }

    // ── Wi-Fi ──────────────────────────────────────────────
    wifiConnect();

    // ── MQTT / TLS ─────────────────────────────────────────
    // Set Root CA for server certificate validation
    secureClient.setCACert(ROOT_CA_CERT);
    // For development with self-signed certs, comment above and use:
    //   secureClient.setInsecure();

    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);
    mqttClient.setBufferSize(MQTT_MAX_PAYLOAD);
    mqttClient.setKeepAlive(60);  // Send PINGREQ every 60s

    if (WiFi.isConnected()) {
        mqttReconnect();
    }

    Serial.println(F("[BOOT] Setup complete — entering main loop"));
    Serial.println(F("─────────────────────────────────────────────────────"));
}

// ═════════════════════════════════════════════════════════════
//  MAIN LOOP
// ═════════════════════════════════════════════════════════════
void loop() {
    uint32_t now = millis();

    // ── 1. Maintain Wi-Fi ──────────────────────────────────
    if (!WiFi.isConnected() && (now - lastWiFiCheckMs >= WIFI_RECONNECT_MS)) {
        lastWiFiCheckMs = now;
        Serial.println(F("[WiFi] Connection lost — reconnecting..."));
        wifiConnect();
    }

    // ── 2. Maintain MQTT ───────────────────────────────────
    if (WiFi.isConnected()) {
        if (!mqttClient.connected() && (now - lastMqttCheckMs >= MQTT_RECONNECT_MS)) {
            lastMqttCheckMs = now;
            mqttReconnect();
        }
        if (mqttClient.connected()) {
            mqttClient.loop();  // Process incoming messages & keepalive
        }
    }

    // ── 3. MPU6050 Shock Detection at 50 Hz ───────────────
    if (now - lastMpuSampleMs >= MPU_SAMPLE_INTERVAL_MS) {
        lastMpuSampleMs = now;
        sampleMPU();
    }

    // ── 4. Publish Shock Alert (immediate, outside telemetry window) ──
    if (shockAlertPending) {
        shockAlertPending = false;
        char alertBuf[MQTT_MAX_PAYLOAD];
        buildAlertJson(alertBuf, sizeof(alertBuf), latestShockG);

        Serial.printf("[SHOCK]   G-force: %.2f G — publishing ALERT\n", latestShockG);

        if (!publishPayload(TOPIC_ALERT, alertBuf)) {
            Serial.println(F("[SHOCK]   MQTT unavailable — buffering alert to SD"));
            writeToBuffer(alertBuf);
        }
    }

    // ── 5. Periodic Telemetry Publish ─────────────────────
    if (now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
        lastTelemetryMs = now;
        readDHTAndPublish();
    }

    // ── 6. Drain Offline Buffer when back online ───────────
    if (isConnected() && sdAvailable) {
        drainOfflineBuffer();
    }
}

// ═════════════════════════════════════════════════════════════
//  Wi-Fi: Connect with retry and status reporting
// ═════════════════════════════════════════════════════════════
void wifiConnect() {
    if (WiFi.isConnected()) return;

    Serial.printf("[WiFi]    Connecting to SSID: %s\n", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    uint8_t  attempts = 0;
    uint32_t start    = millis();

    while (!WiFi.isConnected() && millis() - start < 15000) {
        delay(500);
        Serial.print('.');
        if (++attempts % 20 == 0) Serial.println();
    }

    if (WiFi.isConnected()) {
        Serial.printf("\n[WiFi]    Connected! IP: %s  RSSI: %d dBm\n",
                      WiFi.localIP().toString().c_str(),
                      WiFi.RSSI());
    } else {
        Serial.println(F("\n[WiFi]    Connection timed out — will retry"));
    }
}

// ═════════════════════════════════════════════════════════════
//  MQTT: Reconnect with exponential back-off cap
// ═════════════════════════════════════════════════════════════
bool mqttReconnect() {
    Serial.printf("[MQTT]    Connecting to %s:%d...\n", MQTT_BROKER, MQTT_PORT);

    bool connected;
    if (strlen(MQTT_USERNAME) > 0) {
        connected = mqttClient.connect(MQTT_CLIENT_ID,
                                       MQTT_USERNAME, MQTT_PASSWORD);
    } else {
        connected = mqttClient.connect(MQTT_CLIENT_ID);
    }

    if (connected) {
        Serial.println(F("[MQTT]    Connected!"));
        // Subscribe to any downlink command topics here if needed
        // mqttClient.subscribe("cargo/cmd/CARGO-UNIT-001");
        return true;
    } else {
        Serial.printf("[MQTT]    Failed (rc=%d) — will retry\n",
                      mqttClient.state());
        return false;
    }
}

// ═════════════════════════════════════════════════════════════
//  MQTT: Incoming message callback
// ═════════════════════════════════════════════════════════════
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    Serial.printf("[MQTT RX] Topic: %s | Payload: ", topic);
    for (unsigned int i = 0; i < length; i++) {
        Serial.print((char)payload[i]);
    }
    Serial.println();
    // TODO: Parse commands (OTA trigger, config change, etc.)
}

// ═════════════════════════════════════════════════════════════
//  MQTT: Publish with QoS-0 and offline fallback
// ═════════════════════════════════════════════════════════════
bool publishPayload(const char* topic, const char* jsonStr) {
    if (!mqttClient.connected()) return false;

    bool ok = mqttClient.publish(topic, jsonStr, false /* retain */);
    if (ok) {
        Serial.printf("[MQTT TX] [%s] %s\n", topic, jsonStr);
    } else {
        Serial.printf("[MQTT TX] Publish FAILED on topic: %s\n", topic);
    }
    return ok;
}

// ═════════════════════════════════════════════════════════════
//  MPU6050: Sample at 50 Hz + shock detection
// ═════════════════════════════════════════════════════════════
void sampleMPU() {
    sensors_event_t accel, gyro, temp;
    mpu.getEvent(&accel, &gyro, &temp);

    float ax = accel.acceleration.x;  // m/s²
    float ay = accel.acceleration.y;
    float az = accel.acceleration.z;

    // Vector magnitude (m/s²) → convert to G (1G = 9.80665 m/s²)
    float magnitude_ms2 = sqrtf(ax * ax + ay * ay + az * az);
    float magnitude_G   = magnitude_ms2 / 9.80665f;

    if (magnitude_G > SHOCK_THRESHOLD_G) {
        latestShockG      = magnitude_G;
        shockAlertPending = true;   // Picked up in main loop
    }
}

// ═════════════════════════════════════════════════════════════
//  DHT22: Read and publish telemetry payload
// ═════════════════════════════════════════════════════════════
void readDHTAndPublish() {
    float temp = dht.readTemperature();  // Celsius
    float hum  = dht.readHumidity();

    if (isnan(temp) || isnan(hum)) {
        Serial.println(F("[DHT22]   Read error — skipping telemetry tick"));
        return;
    }

    Serial.printf("[DHT22]   Temp: %.1f°C  Hum: %.1f%%\n", temp, hum);

    char payloadBuf[MQTT_MAX_PAYLOAD];
    buildTelemetryJson(payloadBuf, sizeof(payloadBuf),
                       temp, hum, latestShockG, false /* door_open placeholder */);

    if (!publishPayload(TOPIC_TELEMETRY, payloadBuf)) {
        Serial.println(F("[BUFFER]  MQTT unavailable — writing to SD card"));
        writeToBuffer(payloadBuf);
    }
}

// ═════════════════════════════════════════════════════════════
//  JSON: Build standard telemetry payload
// ═════════════════════════════════════════════════════════════
void buildTelemetryJson(char* buf, size_t bufLen,
                        float temp, float hum,
                        float shockG, bool doorOpen) {
    JsonDocument doc;

    doc["device_id"] = DEVICE_ID;
    doc["temp"]      = serialized(String(temp, 2));
    doc["hum"]       = serialized(String(hum, 2));
    doc["shock_g"]   = serialized(String(shockG, 3));
    doc["lat"]       = GPS_LAT;
    doc["lon"]       = GPS_LON;
    doc["door_open"] = doorOpen;
    doc["ts"]        = millis();   // Replace with NTP epoch when RTC is added

    serializeJson(doc, buf, bufLen);
}

// ═════════════════════════════════════════════════════════════
//  JSON: Build shock alert payload
// ═════════════════════════════════════════════════════════════
void buildAlertJson(char* buf, size_t bufLen, float shockG) {
    JsonDocument doc;

    doc["device_id"] = DEVICE_ID;
    doc["alert"]     = "SHOCK_DETECTED";
    doc["shock_g"]   = serialized(String(shockG, 3));
    doc["lat"]       = GPS_LAT;
    doc["lon"]       = GPS_LON;
    doc["ts"]        = millis();

    serializeJson(doc, buf, bufLen);
}

// ═════════════════════════════════════════════════════════════
//  SD Card: Write a JSON line to the offline buffer file
// ═════════════════════════════════════════════════════════════
void writeToBuffer(const char* jsonLine) {
    if (!sdAvailable) {
        Serial.println(F("[SD]      SD unavailable — payload dropped!"));
        return;
    }

    File f = SD.open(BUFFER_FILE, FILE_APPEND);
    if (!f) {
        Serial.println(F("[SD]      Failed to open log.txt for append"));
        return;
    }

    f.println(jsonLine);  // One JSON object per line (NDJSON / JSON Lines)
    f.close();
    Serial.println(F("[SD]      Payload buffered to log.txt"));
}

// ═════════════════════════════════════════════════════════════
//  SD Card: Drain offline buffer and publish to MQTT
//  Called only when both Wi-Fi and MQTT are available.
//  Strategy: read-all → publish each line → delete file atomically.
// ═════════════════════════════════════════════════════════════
void drainOfflineBuffer() {
    if (!SD.exists(BUFFER_FILE)) return;   // Nothing to drain

    File f = SD.open(BUFFER_FILE, FILE_READ);
    if (!f) return;

    if (f.size() == 0) {
        f.close();
        SD.remove(BUFFER_FILE);
        return;
    }

    Serial.printf("[SD]      Draining offline buffer (%u bytes)...\n",
                  (unsigned int)f.size());

    uint32_t published = 0;
    uint32_t failed    = 0;

    while (f.available()) {
        String line = f.readStringUntil('\n');
        line.trim();
        if (line.length() == 0) continue;

        // Brief yield so MQTT keepalive runs
        mqttClient.loop();
        delay(20);

        if (publishPayload(TOPIC_TELEMETRY, line.c_str())) {
            published++;
        } else {
            failed++;
            Serial.println(F("[SD]      Drain publish failed — aborting drain"));
            break;
        }
    }

    f.close();

    if (failed == 0) {
        // All records published — safe to remove buffer
        SD.remove(BUFFER_FILE);
        Serial.printf("[SD]      Drain complete — %u records published, buffer cleared\n",
                      published);
    } else {
        Serial.printf("[SD]      Drain partial — %u published, %u failed\n",
                      published, failed);
        // File left intact; will retry on next isConnected() pass
    }
}

// ═════════════════════════════════════════════════════════════
//  Helper: True only when both Wi-Fi and MQTT are ready
// ═════════════════════════════════════════════════════════════
bool isConnected() {
    return WiFi.isConnected() && mqttClient.connected();
}
