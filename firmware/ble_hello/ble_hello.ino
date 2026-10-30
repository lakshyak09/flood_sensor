// Step 4 sanity check: the simplest possible BLE message pass.
// The ESP32 advertises as "Flood-Hello". A phone connects and writes text to
// one characteristic; the ESP32 replies on the same characteristic:
//   "ping"   -> "pong"
//   anything -> "echo: <anything>"
// Every message is printed to serial (115200) and blinks the onboard LED.

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>

const int LED_PIN = 2;

// Random UUIDs, just for this test.
#define SERVICE_UUID "6e400001-f100-4d5a-9c3b-000000000001"
#define MESSAGE_UUID "6e400002-f100-4d5a-9c3b-000000000001"

BLECharacteristic *message;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    Serial.println("phone connected");
  }
  void onDisconnect(BLEServer *server) override {
    Serial.println("phone disconnected, advertising again");
    BLEDevice::startAdvertising();
  }
};

class MessageCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String got = c->getValue();
    got.trim();
    Serial.printf("received: \"%s\"\n", got.c_str());

    String reply = got.equalsIgnoreCase("ping") ? "pong" : "echo: " + got;
    c->setValue(reply);
    c->notify();
    Serial.printf("replied:  \"%s\"\n", reply.c_str());

    digitalWrite(LED_PIN, HIGH);
    delay(150);
    digitalWrite(LED_PIN, LOW);
  }
};

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  delay(500);
  Serial.println();
  Serial.println("flood sensor: BLE hello");

  BLEDevice::init("Flood-Hello");
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService *service = server->createService(SERVICE_UUID);
  message = service->createCharacteristic(
      MESSAGE_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE |
          BLECharacteristic::PROPERTY_NOTIFY);
  message->addDescriptor(new BLE2902());
  message->setCallbacks(new MessageCallbacks());
  message->setValue("hello from flood");
  service->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.println("advertising as \"Flood-Hello\"");
}

void loop() {
  delay(1000);
}
