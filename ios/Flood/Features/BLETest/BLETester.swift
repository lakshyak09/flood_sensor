import CoreBluetooth
import Observation

/// Developer tool for talking to the sensor over BLE (`firmware/ble_hello` or
/// `firmware/flood`).
///
/// Finds the sensor by its service UUID, connects, and subscribes to what it
/// offers. The ping/pong characteristic answers `ping` with `pong` and echoes
/// everything else. On `firmware/flood` it can also send WiFi settings and
/// shows the status the sensor reports back. Not the real setup flow; that
/// comes later, built on what this proves.
@MainActor
@Observable
final class BLETester: NSObject {
    static let serviceUUID = CBUUID(string: "6E400001-F100-4D5A-9C3B-000000000001")
    static let messageUUID = CBUUID(string: "6E400002-F100-4D5A-9C3B-000000000001")
    static let configUUID = CBUUID(string: "6E400004-F100-4D5A-9C3B-000000000001")
    static let statusUUID = CBUUID(string: "6E400005-F100-4D5A-9C3B-000000000001")

    struct LogLine: Identifiable {
        enum Kind { case sent, received, status, info }
        let id = UUID()
        let kind: Kind
        let text: String
    }

    var status = "Starting Bluetooth…"
    var ready = false
    /// Only `firmware/flood` has the WiFi characteristics; `ble_hello` doesn't.
    var canSendWiFi = false
    var log: [LogLine] = []

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var message: CBCharacteristic?
    private var config: CBCharacteristic?

    /// Creating the manager is what makes iOS ask for Bluetooth permission,
    /// so it waits until the screen is actually open.
    func start() {
        guard central == nil else { return }
        // Main queue: every delegate callback lands on the main actor.
        central = CBCentralManager(delegate: self, queue: .main)
    }

    func stop() {
        central?.stopScan()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        central = nil
        peripheral = nil
        message = nil
        config = nil
        ready = false
        canSendWiFi = false
    }

    func send(_ text: String) {
        guard let peripheral, let message, !text.isEmpty else { return }
        peripheral.writeValue(Data(text.utf8), for: message, type: .withResponse)
        log.append(LogLine(kind: .sent, text: text))
    }

    /// Written as JSON with a response, so iOS splits it into pieces if it is
    /// longer than one packet. The password is never logged.
    func sendWiFi(ssid: String, password: String, serverURL: String) {
        guard let peripheral, let config else { return }
        let body = ["ssid": ssid, "password": password, "server_url": serverURL]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        peripheral.writeValue(data, for: config, type: .withResponse)
        log.append(LogLine(kind: .sent, text: "WiFi \"\(ssid)\" + server \(serverURL)"))
    }

    private func scan() {
        status = "Looking for Flood-Hello…"
        central?.scanForPeripherals(withServices: [Self.serviceUUID])
    }

    private func note(_ text: String) {
        status = text
        log.append(LogLine(kind: .info, text: text))
    }
}

extension BLETester: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated {
            switch central.state {
            case .poweredOn: scan()
            case .poweredOff: status = "Bluetooth is off. Turn it on in Control Center."
            case .unauthorized: status = "Bluetooth permission denied. Allow it in iPhone Settings → Flood."
            case .unsupported: status = "This device has no Bluetooth (the simulator doesn't)."
            default: status = "Waiting for Bluetooth…"
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                                    advertisementData: [String: Any], rssi RSSI: NSNumber) {
        MainActor.assumeIsolated {
            central.stopScan()
            // Must be held on to, or iOS drops the connection immediately.
            self.peripheral = peripheral
            peripheral.delegate = self
            note("Found \(peripheral.name ?? "sensor") (\(RSSI) dBm), connecting…")
            central.connect(peripheral)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        MainActor.assumeIsolated {
            note("Connected, finding the message slot…")
            peripheral.discoverServices([Self.serviceUUID])
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral,
                                    error: Error?) {
        MainActor.assumeIsolated {
            note("Couldn't connect: \(error?.localizedDescription ?? "unknown error")")
            scan()
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                                    error: Error?) {
        MainActor.assumeIsolated {
            ready = false
            canSendWiFi = false
            message = nil
            config = nil
            self.peripheral = nil
            // `central` is nil once the screen has closed; only reconnect while open.
            guard self.central != nil else { return }
            note("Disconnected.")
            scan()
        }
    }
}

extension BLETester: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        MainActor.assumeIsolated {
            guard let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
                note("The sensor doesn't have the expected service.")
                return
            }
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
                                error: Error?) {
        MainActor.assumeIsolated {
            let characteristics = service.characteristics ?? []
            guard let characteristic = characteristics.first(where: { $0.uuid == Self.messageUUID }) else {
                note("The sensor doesn't have the expected message slot.")
                return
            }
            message = characteristic
            // Replies arrive as notifications; the first read gets the greeting.
            peripheral.setNotifyValue(true, for: characteristic)
            peripheral.readValue(for: characteristic)

            config = characteristics.first { $0.uuid == Self.configUUID }
            if let status = characteristics.first(where: { $0.uuid == Self.statusUUID }) {
                peripheral.setNotifyValue(true, for: status)
                peripheral.readValue(for: status)
            }
            canSendWiFi = config != nil
            ready = true
            note("Ready. Send it something.")
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                                error: Error?) {
        MainActor.assumeIsolated {
            guard let data = characteristic.value else { return }
            let text = String(decoding: data, as: UTF8.self)
            let kind: LogLine.Kind = characteristic.uuid == Self.statusUUID ? .status : .received
            log.append(LogLine(kind: kind, text: text))
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic,
                                error: Error?) {
        MainActor.assumeIsolated {
            if let error { note("Send failed: \(error.localizedDescription)") }
        }
    }
}
