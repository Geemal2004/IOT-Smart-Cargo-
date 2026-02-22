import paho.mqtt.client as mqtt
import json
import time
import random
import ssl
from datetime import datetime

# --- HiveMQ Cloud Configuration ---
# Find these in your HiveMQ Cloud Console
BROKER_ADDRESS = "YOUR_CLUSTER_URL.s2.eu.hivemq.cloud" 
PORT = 8883 # Standard port for TLS/SSL
USERNAME = "YOUR_USERNAME"
PASSWORD = "YOUR_PASSWORD"
TOPIC = "cargo/telemetry"

# Timing Settings
INTERVAL = 5 
DURATION_HOURS = 5
TOTAL_STEPS = (DURATION_HOURS * 3600) // INTERVAL

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("Successfully connected to HiveMQ Cloud!")
    else:
        print(f"Connection failed with code {rc}")

client = mqtt.Client()
client.on_connect = on_connect

# --- Security Settings (Required for HiveMQ Cloud) ---
client.username_pw_set(USERNAME, PASSWORD)
client.tls_set(tls_version=ssl.PROTOCOL_TLS_VERSION) # Enables encryption

def generate_cargo_data():
    return {
        "device_id": "CARGO-ESP32-001",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "location": {
            "lat": round(1.3521 + random.uniform(-0.001, 0.001), 4),
            "lon": round(103.8198 + random.uniform(-0.001, 0.001), 4)
        },
        "temperature": round(4.2 + random.uniform(-0.5, 0.5), 1),
        "battery": round(87 - (random.random() * 2), 1)
    }

def run_simulation():
    try:
        print(f"Connecting to {BROKER_ADDRESS}...")
        client.connect(BROKER_ADDRESS, PORT, 60)
        client.loop_start()
        
        for i in range(TOTAL_STEPS):
            data = generate_cargo_data()
            client.publish(TOPIC, json.dumps(data), qos=1)
            
            print(f"[{i+1}/{TOTAL_STEPS}] Published to HiveMQ: {data['temperature']}°C")
            time.sleep(INTERVAL)
            
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        client.loop_stop()
        client.disconnect()

if __name__ == "__main__":
    run_simulation()
