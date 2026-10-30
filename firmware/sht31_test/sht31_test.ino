// Step 2 sanity check: find the SHT31 on I2C and print temperature/humidity.
// Wiring: VIN->3V3, GND->GND, SCL->GPIO22, SDA->GPIO21 (see docs/device_specs.md).

#include <Wire.h>
#include <Adafruit_SHT31.h>

const int LED_PIN = 2;
const unsigned long READ_INTERVAL_MS = 2000;

Adafruit_SHT31 sht31;
bool sensorFound = false;

// Lists every device that answers on the I2C bus. The SHT31 should show up at 0x44.
void scanI2C() {
  int found = 0;
  Serial.println("scanning I2C bus...");
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  device at 0x%02X\n", addr);
      found++;
    }
  }
  if (found == 0) Serial.println("  no devices found (check wiring / pin contact)");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  delay(500);
  Serial.println();
  Serial.println("flood sensor: SHT31 test");

  Wire.begin(21, 22);  // SDA, SCL
  scanI2C();

  sensorFound = sht31.begin(0x44);
  Serial.println(sensorFound ? "SHT31 found" : "SHT31 NOT found");
}

void loop() {
  digitalWrite(LED_PIN, HIGH);

  if (!sensorFound) {
    sensorFound = sht31.begin(0x44);
    Serial.println(sensorFound ? "SHT31 found" : "SHT31 NOT found, retrying...");
  }

  if (sensorFound) {
    float t = sht31.readTemperature();
    float h = sht31.readHumidity();
    if (isnan(t) || isnan(h)) {
      Serial.println("read failed (loose contact?)");
    } else {
      Serial.printf("temperature_c = %.2f  humidity_pct = %.2f\n", t, h);
    }
  }

  delay(100);
  digitalWrite(LED_PIN, LOW);
  delay(READ_INTERVAL_MS - 100);
}
