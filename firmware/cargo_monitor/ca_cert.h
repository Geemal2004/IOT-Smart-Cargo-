/**
 * @file ca_cert.h
 * @brief Root CA certificate for MQTTS TLS verification.
 *
 * How to obtain your broker's root CA:
 *   openssl s_client -connect YOUR_BROKER:8883 -showcerts </dev/null 2>/dev/null \
 *     | openssl x509 -outform PEM
 *
 * Replace the placeholder below with the real PEM string from your broker.
 * For HiveMQ Cloud the root CA is "ISRG Root X1" (Let's Encrypt).
 * For Mosquitto with self-signed certs, use the ca.crt you generated.
 *
 * If you want to SKIP server certificate verification during development,
 * call client.setInsecure() in place of client.setCACert(ROOT_CA_CERT).
 * NEVER use setInsecure() in production – it disables TLS validation.
 */

#ifndef CA_CERT_H
#define CA_CERT_H

// ── Let's Encrypt ISRG Root X1 (expires 2035-06-04) ──────────────────────
// Used by HiveMQ Cloud and most public MQTT brokers with free TLS certs.
static const char ROOT_CA_CERT[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoBggIBAK3oJHPtYjikXbmaKRWZ
KZAMxBAmVwMRLjFyMEpJyVFdWgEFIv4JNT4DRBKUmLyKRCwFmqG8ym7X1O4BNZV
e+oJuHC7YA2C0RaecaGe6p6Yb5+TLtWPLQRuWGjFxCRqFmIqvJnWEQjt5Xf8V1W
...REPLACE THIS PLACEHOLDER WITH YOUR ACTUAL ROOT CA PEM...
-----END CERTIFICATE-----
)EOF";

#endif // CA_CERT_H
