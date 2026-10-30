// The real sensor firmware. It grows one stage at a time (see "Setup flow" in
// docs/project_desc.md).
//
// It advertises as "Flood-XXXX" (the last 4 characters of its device id) and
// offers, over BLE:
//   message (read, write, notify)  the ping/pong test from ble_hello, kept so
//                                  Settings -> Bluetooth test still works
//   info    (read)                 {"device_id", "device_key", "firmware_version"}
//   config  (write)                {"ssid", "password", "server_url"}
//   status  (read, notify)         connecting_wifi | wifi_ok:<ip> | wifi_failed:<reason>
//                                  | server_ok | server_failed:<reason> | networks_ready
//   networks (read, write)         write "scan" to look for WiFi; when status says
//                                  networks_ready, read [["ssid",rssi,secure],...]
//                                  (strongest first, 2.4 GHz only, as that's all
//                                  this radio can hear)
//
// When Bluetooth is on (setup mode): whenever the sensor doesn't have working
// WiFi, and never when it does.
//   - no WiFi saved yet                -> on until someone sets it up
//   - saved WiFi not working for 5 min -> on until it's back online (moved
//                                         house, router password changed)
//   - online                           -> off, so nobody nearby can connect
// A restart with working WiFi stays off: a power outage shouldn't leave every
// sensor in the house open to anyone in range. The 5 minutes lets a router
// reboot pass without opening up. A phone that is connected is never cut off;
// the rules apply once it leaves.
//
// So a working sensor can't be moved to another network over Bluetooth. That
// needs a "Change WiFi" command sent through the server (not built yet).
//
// New WiFi settings are only saved once the sensor has actually joined with
// them. If they fail, it goes back to the network it had, so a typo can't
// knock a working sensor offline.
//
// Readings. The SHT31 (I2C: SDA 21, SCL 22, address 0x44) is read every
// sample_interval_s. Each reading is queued in RAM and uploaded in batches to
// POST <server_url>/ingest/readings every upload_interval_s; the server confirms
// a batch before it leaves the queue, so readings taken while WiFi or the server
// is down go up later. The queue holds a day's worth at the default interval
// (oldest dropped past that) and is lost on a power cut. No SD card.
//
// Every reading is stamped with real time (NTP) exactly once, and keeps that
// stamp through retries: the server ignores a reading whose timestamp it
// already has, so a resend can never double up. Readings taken before the
// clock is set are stamped from their age once it is.
//
// The intervals come from GET <server_url>/device/config, fetched on joining
// WiFi and again whenever a response carries a newer config_version.
//
// A heartbeat (POST /ingest/heartbeat, every heartbeat_interval_s and straight
// after joining WiFi) reports health. Uploads count as being seen too. The
// server only accepts either once the device has been claimed; before that it
// answers 401 device_not_claimed, and readings wait in the queue.
//
// Onboard LED: fast blink = setup mode (Bluetooth on), slow blink = not online
// yet, solid = online. The app doesn't rely on it; the enclosure may hide it.
//
// The id and key come from device_identity.h, which `npm run provision:firmware`
// writes. It is git-ignored because the key is a secret.
//
// Needs the min_spiffs partition scheme: BLE and WiFi together don't fit the
// default one. Build with FQBN esp32:esp32:esp32:PartitionScheme=min_spiffs

#if __has_include("device_identity.h")
#include "device_identity.h"
#else
#error "Missing device_identity.h. Run `npm run provision:firmware` from the repo root first."
#endif

#include <ArduinoJson.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>
#include <time.h>

const char *FIRMWARE_VERSION = "0.7.0";
const int LED_PIN = 2;
const unsigned long WIFI_TIMEOUT_MS = 20000;

// Until the server says otherwise (GET /device/config); these are its defaults.
unsigned long sampleIntervalMs = 30000;
unsigned long uploadIntervalMs = 300000;
unsigned long heartbeatIntervalMs = 900000;
long configVersion = -1;
bool configDue = false;

const size_t QUEUE_CAPACITY = 2880;  // a day at 30 s; 12 bytes each
const size_t UPLOAD_BATCH = 100;      // readings per request (server max 500)
const unsigned long WIFI_LOST_SETUP_MS = 5UL * 60 * 1000;
const unsigned long WIFI_RETRY_MS = 30000;

#define SERVICE_UUID "6E400001-F100-4D5A-9C3B-000000000001"
#define MESSAGE_UUID "6E400002-F100-4D5A-9C3B-000000000001"
#define INFO_UUID    "6E400003-F100-4D5A-9C3B-000000000001"
#define CONFIG_UUID  "6E400004-F100-4D5A-9C3B-000000000001"
#define STATUS_UUID  "6E400005-F100-4D5A-9C3B-000000000001"
#define NETWORKS_UUID "6E400006-F100-4D5A-9C3B-000000000001"

// One BLE read returns at most 512 bytes. The list stops short of that.
const size_t NETWORKS_MAX_BYTES = 480;

BLECharacteristic *statusChar;
BLECharacteristic *networksChar;
Preferences prefs;

Adafruit_SHT31 sht31;
bool sensorFound = false;
String lastError;  // sent with the heartbeat; empty when all is well

// A reading waiting to be uploaded. Stored as hundredths to stay small.
struct Reading {
  uint32_t epoch;  // real time in seconds, 0 until the clock is set
  uint32_t atMs;   // millis() when taken, to stamp it later if needed
  int16_t tempCenti;
  uint16_t humCenti;
};
Reading queue[QUEUE_CAPACITY];
size_t queueStart = 0, queueCount = 0;

unsigned long lastSampleAt = 0;
bool sampledOnce = false;
unsigned long lastUploadAt = 0;
bool uploadDue = false;

// Saved settings: the ones that have worked.
String ssid, password, serverUrl;

// Settings the phone just sent, not yet proven. Written by the BLE callback,
// acted on in loop(): joining WiFi takes seconds, and blocking inside a BLE
// callback stalls the Bluetooth stack.
String newSsid, newPassword, newServerUrl;
volatile bool joinRequested = false;
volatile bool scanRequested = false;

volatile bool phoneConnected = false;
bool advertising = false;

// Why the last WiFi attempt dropped, from the WiFi driver.
volatile uint8_t lastDisconnectReason = 0;

unsigned long lastJoinAttemptAt = 0;
unsigned long wifiDownSince = 0;  // 0 while connected (or never set up)

unsigned long lastHeartbeatAt = 0;
bool heartbeatDue = false;
String lastServerStatus;

void setStatus(const String &status) {
  Serial.printf("status: %s\n", status.c_str());
  statusChar->setValue(status);
  statusChar->notify();
}

// Only notifies when the answer changes, so a heartbeat every minute doesn't
// fill the app's log with the same line.
void setServerStatus(const String &status) {
  if (status == lastServerStatus) return;
  lastServerStatus = status;
  setStatus(status);
}

void updateLed() {
  bool online = WiFi.status() == WL_CONNECTED && lastServerStatus == "server_ok";
  unsigned long period = advertising || phoneConnected ? 200 : online ? 0 : 1000;
  digitalWrite(LED_PIN, period == 0 ? HIGH : (millis() / period) % 2);
}

// POST a JSON body to the server with the device key. Returns the HTTP status
// (negative when the server couldn't be reached) and fills in the reply.
int postJson(const char *path, JsonDocument &body, String &reply) {
  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(serverUrl + path)) return -100;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Device ") + DEVICE_KEY);
  String json;
  serializeJson(body, json);
  int code = http.POST(json);
  reply = code > 0 ? http.getString() : "";
  http.end();
  return code;
}

// What the server said, as a status the app understands. Shared by uploads
// and heartbeats: either one reaching the server means the same thing.
void reportServerResult(int code, const String &reply) {
  if (code == 200) {
    setServerStatus("server_ok");
  } else if (code == -100) {
    setServerStatus("server_failed:bad_url");
  } else if (code < 0) {
    setServerStatus("server_failed:unreachable");  // wrong address, or server not running
  } else if (reply.indexOf("device_not_claimed") >= 0) {
    setServerStatus("server_failed:not_claimed");
  } else if (reply.indexOf("invalid_device_credentials") >= 0) {
    setServerStatus("server_failed:unknown_device");
  } else {
    setServerStatus("server_failed:" + String(code));
  }
}

// A newer config_version in any reply means the intervals may have changed.
void noteConfigVersion(const String &reply) {
  JsonDocument doc;
  if (deserializeJson(doc, reply) != DeserializationError::Ok) return;
  if (doc["config_version"].is<long>() && doc["config_version"].as<long>() != configVersion) {
    configDue = true;
  }
}

void fetchConfig() {
  configDue = false;
  if (WiFi.status() != WL_CONNECTED || serverUrl.isEmpty()) return;

  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(serverUrl + "/device/config")) return;
  http.addHeader("Authorization", String("Device ") + DEVICE_KEY);
  int code = http.GET();
  String reply = code > 0 ? http.getString() : "";
  http.end();
  if (code != 200) return;  // not claimed yet, or unreachable: keep the defaults

  JsonDocument doc;
  if (deserializeJson(doc, reply) != DeserializationError::Ok) return;
  // Floors guard against a typo on the server turning into a flood of requests.
  sampleIntervalMs = max(5L, doc["sample_interval_s"] | 30L) * 1000UL;
  uploadIntervalMs = max(10L, doc["upload_interval_s"] | 300L) * 1000UL;
  heartbeatIntervalMs = max(30L, doc["heartbeat_interval_s"] | 900L) * 1000UL;
  configVersion = doc["config_version"] | -1L;
  Serial.printf("config v%ld: sample every %lus, upload every %lus, heartbeat every %lus\n",
                configVersion, sampleIntervalMs / 1000, uploadIntervalMs / 1000,
                heartbeatIntervalMs / 1000);
}

void sendHeartbeat() {
  lastHeartbeatAt = millis();
  if (WiFi.status() != WL_CONNECTED || serverUrl.isEmpty()) return;

  JsonDocument body;
  body["device_id"] = DEVICE_ID;
  body["firmware_version"] = FIRMWARE_VERSION;
  body["uptime_s"] = millis() / 1000;
  body["wifi_rssi"] = WiFi.RSSI();
  body["buffered_readings"] = queueCount;
  if (lastError.isEmpty()) body["last_error"] = nullptr;
  else body["last_error"] = lastError;

  String reply;
  int code = postJson("/ingest/heartbeat", body, reply);
  Serial.printf("heartbeat -> %d %s\n", code, reply.c_str());
  reportServerResult(code, reply);
  if (code == 200) noteConfigVersion(reply);
}

// MARK: readings

bool haveTime() {
  return time(nullptr) > 1700000000;  // anything before late 2023 means "not set yet"
}

void takeReading() {
  lastSampleAt = millis();
  sampledOnce = true;

  if (!sensorFound) {
    sensorFound = sht31.begin(0x44);
    if (!sensorFound) {
      lastError = "sensor_not_found";
      Serial.println("SHT31 not found (check wiring)");
      return;
    }
  }

  float t, h;
  if (!sht31.readBoth(&t, &h) || isnan(t) || isnan(h)) {
    lastError = "sensor_read_failed";
    Serial.println("SHT31 read failed");
    return;
  }
  lastError = "";

  if (queueCount == QUEUE_CAPACITY) {  // full: the oldest reading makes room
    queueStart = (queueStart + 1) % QUEUE_CAPACITY;
    queueCount--;
  }
  Reading &r = queue[(queueStart + queueCount) % QUEUE_CAPACITY];
  r.epoch = haveTime() ? (uint32_t)time(nullptr) : 0;
  r.atMs = millis();
  r.tempCenti = (int16_t)lroundf(t * 100);
  r.humCenti = (uint16_t)lroundf(h * 100);
  queueCount++;
  Serial.printf("reading %.2f C  %.2f %%RH  (%u queued)\n", t, h, queueCount);
}

void uploadReadings() {
  // Waiting on WiFi or the clock: check again next loop, not a whole interval later.
  if (WiFi.status() != WL_CONNECTED || serverUrl.isEmpty() || !haveTime()) return;
  lastUploadAt = millis();

  // A few batches per turn, oldest first, so a backlog drains without
  // stalling everything else for long.
  for (int batch = 0; batch < 5 && queueCount > 0; batch++) {
    size_t n = min(queueCount, UPLOAD_BATCH);
    uint32_t now = (uint32_t)time(nullptr);

    JsonDocument body;
    body["device_id"] = DEVICE_ID;
    body["firmware_version"] = FIRMWARE_VERSION;
    JsonArray list = body["readings"].to<JsonArray>();
    for (size_t i = 0; i < n; i++) {
      Reading &r = queue[(queueStart + i) % QUEUE_CAPACITY];
      // Stamped once, from its age, and kept: a retry must send the same time.
      if (r.epoch == 0) r.epoch = now - (millis() - r.atMs) / 1000;
      time_t at = r.epoch;
      struct tm utc;
      gmtime_r(&at, &utc);
      char iso[25];
      strftime(iso, sizeof iso, "%Y-%m-%dT%H:%M:%SZ", &utc);

      JsonObject reading = list.add<JsonObject>();
      reading["recorded_at"] = iso;
      reading["temperature_c"] = r.tempCenti / 100.0;
      reading["humidity_pct"] = r.humCenti / 100.0;
    }

    String reply;
    int code = postJson("/ingest/readings", body, reply);
    reportServerResult(code, reply);
    if (code != 200) {
      Serial.printf("upload -> %d %s (%u stay queued)\n", code, reply.c_str(), queueCount);
      return;
    }

    // Accepted, duplicate or rejected as invalid: the server has had its say
    // on every one of them, so none needs sending again.
    queueStart = (queueStart + n) % QUEUE_CAPACITY;
    queueCount -= n;

    JsonDocument result;
    deserializeJson(result, reply);
    Serial.printf("uploaded %u: %d new, %d duplicate, %u rejected (%u left)\n", n,
                  result["accepted"] | 0, result["duplicates"] | 0,
                  result["rejected"].size(), queueCount);
    noteConfigVersion(reply);
  }
}

void loadSettings() {
  prefs.begin("flood", true);
  ssid = prefs.getString("ssid", "");
  password = prefs.getString("password", "");
  serverUrl = prefs.getString("server_url", "");
  prefs.end();
}

void saveSettings() {
  prefs.begin("flood", false);
  prefs.putString("ssid", ssid);
  prefs.putString("password", password);
  prefs.putString("server_url", serverUrl);
  prefs.end();
}

// Turns the driver's disconnect reason into something the app can show.
String failureReason() {
  switch (lastDisconnectReason) {
    case WIFI_REASON_NO_AP_FOUND:
      return "network_not_found";  // wrong name, out of range, or 5 GHz only
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_AUTH_EXPIRE:
      return "wrong_password";
    default:
      return "timeout";
  }
}

// Joins a network from scratch and says whether it worked.
bool tryJoin(const String &name, const String &pass) {
  lastJoinAttemptAt = millis();

  // Leave the current network first, and wait until it's really gone. The
  // disconnect is asynchronous: checking straight away can still see the old
  // connection and call a wrong password a success.
  WiFi.disconnect();
  unsigned long leaving = millis();
  while (WiFi.status() == WL_CONNECTED && millis() - leaving < 3000) {
    delay(50);
  }

  // Two tries. WiFi and BLE share one radio, and a handshake that times out
  // while Bluetooth is busy looks exactly like a wrong password. A real wrong
  // password fails both times; a collision almost never does.
  for (int attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      if (lastDisconnectReason == WIFI_REASON_NO_AP_FOUND) break;  // retrying won't find it
      Serial.printf("retrying (reason %d)...\n", lastDisconnectReason);
      WiFi.disconnect();
      delay(100);
    }
    lastDisconnectReason = 0;
    WiFi.begin(name.c_str(), pass.c_str());

    unsigned long started = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_TIMEOUT_MS) {
      updateLed();
      delay(100);
    }
    if (WiFi.status() == WL_CONNECTED) return true;
  }

  WiFi.disconnect();  // stop the driver retrying on its own
  return false;
}

void onJoined() {
  Serial.printf("WiFi OK, ip %s, signal %d dBm\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  wifiDownSince = 0;
  lastServerStatus = "";  // report the server's answer again after a rejoin
  heartbeatDue = true;
  configDue = true;
  uploadDue = true;
  configTime(0, 0, "pool.ntp.org", "time.google.com");  // sets the clock in the background
}

// The saved network: at boot, and whenever the connection drops.
void joinSaved() {
  if (ssid.isEmpty()) {
    setStatus("no_wifi_saved");
    return;
  }
  Serial.printf("joining saved \"%s\"...\n", ssid.c_str());  // never print the password
  if (tryJoin(ssid, password)) {
    onJoined();
  } else {
    Serial.printf("couldn't join \"%s\" (%s)\n", ssid.c_str(), failureReason().c_str());
  }
}

// Settings the phone just sent. They're only kept if they work.
void joinNew() {
  Serial.printf("joining new \"%s\"...\n", newSsid.c_str());
  setStatus("connecting_wifi");

  if (tryJoin(newSsid, newPassword)) {
    ssid = newSsid;
    password = newPassword;
    serverUrl = newServerUrl;
    saveSettings();
    Serial.println("new WiFi settings saved");
    onJoined();
    setStatus("wifi_ok:" + WiFi.localIP().toString());
    return;
  }

  setStatus("wifi_failed:" + failureReason());

  // Back to the network that was working, quietly: the app is waiting on the
  // phone's next try, not on this.
  if (!ssid.isEmpty()) {
    Serial.printf("going back to \"%s\"\n", ssid.c_str());
    if (tryJoin(ssid, password)) onJoined();
  }
}

// Setup mode rules; see the top of this file.
void updateAdvertising() {
  bool wifiLost = wifiDownSince != 0 && millis() - wifiDownSince >= WIFI_LOST_SETUP_MS;
  bool wanted = ssid.isEmpty() || wifiLost;

  if (phoneConnected) return;  // never cut off a phone mid-setup
  if (wanted && !advertising) {
    BLEDevice::startAdvertising();
    advertising = true;
    Serial.println("Bluetooth on (setup mode)");
  } else if (!wanted && advertising) {
    BLEDevice::stopAdvertising();
    advertising = false;
    Serial.println("Bluetooth off");
  }
}

// Lists nearby networks for the app to choose from: strongest first, one entry
// per name, hidden networks left out.
void scanNetworks() {
  Serial.println("scanning for WiFi...");
  int found = WiFi.scanNetworks();

  JsonDocument doc;
  JsonArray list = doc.to<JsonArray>();
  // scanNetworks() already sorts by signal, so the first of each name is its best.
  for (int i = 0; i < found; i++) {
    String name = WiFi.SSID(i);
    if (name.isEmpty()) continue;
    bool seen = false;
    for (JsonArray entry : list) {
      if (name == entry[0].as<const char *>()) { seen = true; break; }
    }
    if (seen) continue;

    JsonArray entry = list.add<JsonArray>();
    entry.add(name);
    entry.add(WiFi.RSSI(i));
    entry.add(WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? 0 : 1);
    if (measureJson(doc) > NETWORKS_MAX_BYTES) {
      list.remove(list.size() - 1);
      break;
    }
  }
  WiFi.scanDelete();

  String json;
  serializeJson(doc, json);
  networksChar->setValue(json);
  Serial.printf("found %d networks, sending %d\n", found, list.size());
  setStatus("networks_ready");
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    Serial.println("phone connected");
    phoneConnected = true;
    advertising = false;  // the stack stops advertising once a phone connects
  }
  void onDisconnect(BLEServer *server) override {
    // loop() decides whether to advertise again.
    Serial.println("phone disconnected");
    phoneConnected = false;
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
  }
};

class InfoCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *c) override {
    Serial.println("phone read info");
  }
};

class ConfigCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    JsonDocument doc;
    if (deserializeJson(doc, c->getValue()) != DeserializationError::Ok ||
        !doc["ssid"].is<const char *>() || String((const char *)doc["ssid"]).isEmpty()) {
      setStatus("config_invalid");
      return;
    }

    newSsid = (const char *)doc["ssid"];
    newPassword = doc["password"] | "";
    newServerUrl = doc["server_url"] | "";
    Serial.printf("got config: ssid \"%s\", server %s\n", newSsid.c_str(), newServerUrl.c_str());
    joinRequested = true;
  }
};

class NetworksCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    if (c->getValue() == "scan") scanRequested = true;
  }
};

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  delay(500);
  Serial.println();
  Serial.printf("flood sensor %s\n", FIRMWARE_VERSION);
  Serial.printf("device id: %s\n", DEVICE_ID);

  Wire.begin(21, 22);  // SDA, SCL
  sensorFound = sht31.begin(0x44);
  Serial.println(sensorFound ? "SHT31 found" : "SHT31 NOT found (check wiring)");

  WiFi.persistent(false);        // this sketch keeps its own settings in Preferences
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);  // loop() decides when to try
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    lastDisconnectReason = info.wifi_sta_disconnected.reason;
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  String id = DEVICE_ID;
  String suffix = id.substring(id.length() - 4);
  suffix.toUpperCase();
  String name = "Flood-" + suffix;

  BLEDevice::init(name.c_str());
  // Room for the config JSON in one packet when the phone agrees to it; iOS
  // splits longer writes on its own either way.
  BLEDevice::setMTU(517);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  // The default of 15 handles is too few for five characteristics.
  BLEService *service = server->createService(BLEUUID(SERVICE_UUID), 30);

  BLECharacteristic *message = service->createCharacteristic(
      MESSAGE_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE |
          BLECharacteristic::PROPERTY_NOTIFY);
  message->addDescriptor(new BLE2902());
  message->setCallbacks(new MessageCallbacks());
  message->setValue("hello from flood");

  String info = String("{\"device_id\":\"") + DEVICE_ID + "\",\"device_key\":\"" + DEVICE_KEY +
                "\",\"firmware_version\":\"" + FIRMWARE_VERSION + "\"}";
  BLECharacteristic *infoChar =
      service->createCharacteristic(INFO_UUID, BLECharacteristic::PROPERTY_READ);
  infoChar->setCallbacks(new InfoCallbacks());
  infoChar->setValue(info);

  BLECharacteristic *configChar =
      service->createCharacteristic(CONFIG_UUID, BLECharacteristic::PROPERTY_WRITE);
  configChar->setCallbacks(new ConfigCallbacks());

  statusChar = service->createCharacteristic(
      STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  statusChar->addDescriptor(new BLE2902());
  statusChar->setValue("starting");

  networksChar = service->createCharacteristic(
      NETWORKS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE);
  networksChar->setCallbacks(new NetworksCallbacks());
  networksChar->setValue("[]");

  service->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  Serial.printf("Bluetooth name \"%s\"\n", name.c_str());

  loadSettings();
  updateAdvertising();  // on straight away if it has never been set up
  joinSaved();
}

void loop() {
  if (scanRequested) {
    scanRequested = false;
    scanNetworks();
  }
  if (joinRequested) {
    joinRequested = false;
    joinNew();
  }

  // Keep trying the saved network while it's down. Not while a phone is
  // connected: that's someone setting it up, and a join would get in the way.
  if (WiFi.status() != WL_CONNECTED && !ssid.isEmpty()) {
    if (wifiDownSince == 0) wifiDownSince = millis();
    if (!phoneConnected && millis() - lastJoinAttemptAt >= WIFI_RETRY_MS) joinSaved();
  }

  if (!sampledOnce || millis() - lastSampleAt >= sampleIntervalMs) takeReading();
  if (configDue) fetchConfig();
  if (heartbeatDue || millis() - lastHeartbeatAt >= heartbeatIntervalMs) {
    heartbeatDue = false;
    sendHeartbeat();
  }
  if (uploadDue || millis() - lastUploadAt >= uploadIntervalMs) {
    if (WiFi.status() == WL_CONNECTED && haveTime()) uploadDue = false;
    uploadReadings();
  }

  updateAdvertising();
  updateLed();
  delay(100);
}
