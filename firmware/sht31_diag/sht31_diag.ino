// SHT31 diagnostic: scans I2C and does a raw measurement, printing bytes + CRC status.

#include <Wire.h>

const uint8_t ADDR = 0x44;

uint8_t crc8(const uint8_t *data, int len) {
  uint8_t crc = 0xFF;
  for (int j = 0; j < len; j++) {
    crc ^= data[j];
    for (int i = 0; i < 8; i++) crc = (crc & 0x80) ? (crc << 1) ^ 0x31 : (crc << 1);
  }
  return crc;
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  Wire.setClock(100000);
}

void readStatus() {
  Wire.beginTransmission(ADDR);
  Wire.write(0xF3);
  Wire.write(0x2D);
  uint8_t err = Wire.endTransmission();
  delay(2);
  int n = Wire.requestFrom(ADDR, (uint8_t)3);
  Serial.printf("status: err=%u got %d bytes:", err, n);
  while (Wire.available()) Serial.printf(" %02X", Wire.read());
  Serial.println();
}

// Sends a single-shot measurement command, polls for the 6-byte result, prints raw bytes + CRC.
void measure(const char *label, uint8_t msb, uint8_t lsb) {
  Wire.beginTransmission(ADDR);
  Wire.write(msb);
  Wire.write(lsb);
  uint8_t err = Wire.endTransmission();
  int n = 0, tries = 0;
  for (; tries < 20 && n != 6; tries++) {
    delay(10);
    n = Wire.requestFrom(ADDR, (uint8_t)6);
  }
  uint8_t b[6] = {0};
  for (int i = 0; i < n && i < 6; i++) b[i] = Wire.read();
  bool crcT = crc8(b, 2) == b[2];
  bool crcH = crc8(b + 3, 2) == b[5];
  float t = -45 + 175 * ((b[0] << 8 | b[1]) / 65535.0);
  float h = 100 * ((b[3] << 8 | b[4]) / 65535.0);
  Serial.printf("%s err=%u tries=%d n=%d: %02X %02X %02X %02X %02X %02X crcT=%s crcH=%s -> %.2f C, %.2f %%RH\n",
                label, err, tries, n, b[0], b[1], b[2], b[3], b[4], b[5],
                crcT ? "ok" : "BAD", crcH ? "ok" : "BAD", t, h);
  delay(50);
}

// Simple contact check: one measurement every 0.5 s, printed as OK/FAIL so it's easy to watch live.
void loop() {
  Wire.beginTransmission(ADDR);
  Wire.write(0x24);
  Wire.write(0x00);
  Wire.endTransmission();
  int n = 0;
  for (int tries = 0; tries < 20 && n != 6; tries++) {
    delay(10);
    n = Wire.requestFrom(ADDR, (uint8_t)6);
  }
  uint8_t b[6] = {0};
  for (int i = 0; i < n && i < 6; i++) b[i] = Wire.read();
  bool ok = n == 6 && crc8(b, 2) == b[2] && crc8(b + 3, 2) == b[5] && (b[0] | b[1]);
  if (ok) {
    float t = -45 + 175 * ((b[0] << 8 | b[1]) / 65535.0);
    float h = 100 * ((b[3] << 8 | b[4]) / 65535.0);
    Serial.printf("OK    %.2f C   %.2f %%RH\n", t, h);
  } else {
    Serial.println("FAIL");
  }
  delay(500);
}
