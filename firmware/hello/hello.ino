// Step 1 sanity check: prints a counter over serial and blinks the onboard LED.

const int LED_PIN = 2;  // blue onboard LED on most ESP32 DevKit boards

unsigned long count = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  delay(500);
  Serial.println();
  Serial.println("flood sensor: hello from ESP32");
}

void loop() {
  digitalWrite(LED_PIN, count % 2 ? LOW : HIGH);
  Serial.print("alive, count = ");
  Serial.println(count++);
  delay(1000);
}
