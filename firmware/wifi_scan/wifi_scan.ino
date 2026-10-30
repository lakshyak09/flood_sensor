// Lists every WiFi network the ESP32 can see. It only has a 2.4 GHz radio, so
// a network that shows up here is one it can join.

#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("flood sensor: WiFi scan (2.4 GHz only)");
  WiFi.mode(WIFI_STA);
}

void loop() {
  int n = WiFi.scanNetworks();
  Serial.printf("found %d networks\n", n);
  for (int i = 0; i < n; i++) {
    Serial.printf("  %-32s  channel %2d  %4d dBm\n",
                  WiFi.SSID(i).c_str(), WiFi.channel(i), WiFi.RSSI(i));
  }
  WiFi.scanDelete();
  delay(10000);
}
