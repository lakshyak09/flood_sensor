import CoreBluetooth
import Observation

/// What the sensor says about itself over BLE (the `info` characteristic).
struct SensorInfo: Decodable, Equatable {
    let deviceId: String
    let deviceKey: String
    let firmwareVersion: String

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case deviceKey = "device_key"
        case firmwareVersion = "firmware_version"
    }
}

/// A WiFi network the sensor can hear. Its radio is 2.4 GHz only, so this list
/// is also the list of networks it can actually join.
struct WiFiNetwork: Identifiable, Equatable {
    let ssid: String
    let rssi: Int
    let secure: Bool
    var id: String { ssid }
}

/// Setting up a sensor over Bluetooth, start to finish.
///
/// Find it → read its id and key → claim it on the server → hand it WiFi and
/// the server address → watch it report in. Claiming comes before WiFi on
/// purpose: the sensor's first heartbeat then already counts, so "online" at
/// the end means the whole chain works, not just the radio.
///
/// The BLE contract is `firmware/flood/flood.ino`; the status strings handled
/// in `handleStatus` are the ones it sends.
@MainActor
@Observable
final class SensorSetupModel: NSObject {
    enum Bluetooth { case starting, on, off, unauthorized, unsupported }

    enum Step: Equatable {
        case find
        case connecting
        case details
        case wifi
        case joining(JoinStage)
        case online
    }

    enum JoinStage: Int, Comparable {
        case sending, joiningWiFi, reachingServer
        static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
    }

    struct Nearby: Identifiable {
        let id: UUID
        let name: String
        var rssi: Int
        let peripheral: CBPeripheral
    }

    static let serviceUUID = CBUUID(string: "6E400001-F100-4D5A-9C3B-000000000001")
    static let infoUUID = CBUUID(string: "6E400003-F100-4D5A-9C3B-000000000001")
    static let configUUID = CBUUID(string: "6E400004-F100-4D5A-9C3B-000000000001")
    static let statusUUID = CBUUID(string: "6E400005-F100-4D5A-9C3B-000000000001")
    static let networksUUID = CBUUID(string: "6E400006-F100-4D5A-9C3B-000000000001")

    // What the screens show.
    var bluetooth: Bluetooth = .starting
    var nearby: [Nearby] = []
    var step: Step = .find
    var sensorName = ""
    var error: String?
    var busy = false
    var reconnecting = false
    /// Set when the sensor is already in this account, e.g. being moved to a
    /// new network. Naming and claiming are skipped.
    var existingName: String?

    /// What the sensor found when it looked for WiFi, strongest first.
    var networks: [WiFiNetwork] = []
    var scanningNetworks = false
    /// Firmware older than 0.4.0 can't scan; the name is typed instead.
    /// Remembered across a dropped connection so the screen doesn't flicker.
    private(set) var canScanNetworks = false
    /// The join sheet, when it's up: asks for a password, and for "Other
    /// network…" the name too. Works like joining WiFi in iPhone Settings.
    var joinPrompt: JoinPrompt?

    struct JoinPrompt: Identifiable {
        let id = UUID()
        /// nil for "Other network…", where the name is typed.
        let networkName: String?
    }

    // What the person types. Kept here so going back a step doesn't lose it.
    var name = ""
    var location = ""
    var material: SurfaceMaterial = .unknown
    var ssid = ""
    var password = ""

    let serverURL = AppConfig.baseURL

    /// The sensor is a different machine: an address that means "this device"
    /// on the phone would point the sensor at itself.
    var serverUnreachableFromSensor: Bool {
        let host = serverURL.host() ?? ""
        return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }

    private let api: APIClient
    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var config: CBCharacteristic?
    private var networksChar: CBCharacteristic?
    private var info: SensorInfo?
    private var timeout: Task<Void, Never>?
    private var scanTimeout: Task<Void, Never>?

    init(api: APIClient) {
        self.api = api
    }

    // MARK: - Lifecycle

    /// Creating the manager is what makes iOS ask for Bluetooth permission, so
    /// this waits until the setup screen is actually open.
    func start() {
        guard central == nil else { return }
        central = CBCentralManager(delegate: self, queue: .main)
    }

    func stop() {
        timeout?.cancel()
        scanTimeout?.cancel()
        central?.stopScan()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        central = nil
        peripheral = nil
    }

    // MARK: - Steps

    func choose(_ sensor: Nearby) {
        central?.stopScan()
        error = nil
        sensorName = sensor.name
        peripheral = sensor.peripheral
        sensor.peripheral.delegate = self
        step = .connecting
        central?.connect(sensor.peripheral)

        startTimeout(seconds: 15) { [weak self] in
            guard let self, self.step == .connecting else { return }
            self.backToFind("Couldn't connect to \(self.sensorName). Make sure it's plugged in and "
                            + "close to your phone, then try again.")
        }
    }

    func backToFind(_ message: String? = nil) {
        timeout?.cancel()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        peripheral = nil
        config = nil
        networksChar = nil
        canScanNetworks = false
        networks = []
        scanningNetworks = false
        info = nil
        existingName = nil
        reconnecting = false
        nearby = []
        error = message
        step = .find
        scan()
    }

    /// Claim the sensor for this account, or skip that if it's already ours.
    func claim() async {
        guard let info else { return }
        if existingName != nil {
            error = nil
            step = .wifi
            return
        }

        busy = true
        defer { busy = false }
        do {
            let trimmedLocation = location.trimmingCharacters(in: .whitespaces)
            let _: DeviceDetail = try await api.authorized(
                .claimDevice(id: info.deviceId, key: info.deviceKey,
                             name: name.trimmingCharacters(in: .whitespaces),
                             location: trimmedLocation.isEmpty ? nil : trimmedLocation,
                             material: material)
            )
            error = nil
            step = .wifi
        } catch let err as APIError {
            switch err.code {
            case "device_already_claimed":
                error = "This sensor is already set up on another Flood account. "
                    + "Remove it from that account first, then try again."
            case "invalid_device_credentials":
                error = "Your Flood server doesn't recognize this sensor. It may have been "
                    + "made for a different server."
            default:
                error = err.errorDescription
            }
            Haptics.failure()
        } catch {
            self.error = error.localizedDescription
            Haptics.failure()
        }
    }

    /// Ask the sensor to look for WiFi. It answers `networks_ready` on the
    /// status characteristic, and the list is then read from its own one.
    func scanForNetworks() {
        guard let peripheral, let networksChar, !scanningNetworks else { return }
        scanningNetworks = true
        peripheral.writeValue(Data("scan".utf8), for: networksChar, type: .withResponse)

        scanTimeout?.cancel()
        scanTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled else { return }
            self?.scanningNetworks = false
        }
    }

    /// A locked network asks for its password; an open one joins right away.
    func chooseNetwork(_ network: WiFiNetwork) {
        error = nil
        if network.ssid != ssid { password = "" }
        ssid = network.ssid
        if network.secure {
            joinPrompt = JoinPrompt(networkName: network.ssid)
        } else {
            password = ""
            sendWiFi()
        }
    }

    func chooseOtherNetwork() {
        error = nil
        ssid = ""
        password = ""
        joinPrompt = JoinPrompt(networkName: nil)
    }

    func sendWiFi() {
        guard let peripheral, let config else {
            error = "Lost the connection to the sensor. Move closer to it and try again."
            return
        }
        let body = ["ssid": ssid, "password": password, "server_url": serverURL.absoluteString]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }

        error = nil
        joinPrompt = nil
        step = .joining(.sending)
        // Write with response: iOS splits it into pieces if it's long.
        peripheral.writeValue(data, for: config, type: .withResponse)

        // The sensor gives joining up to 20 s, twice, and the server check a
        // few more. Past that, something has gone quiet.
        startTimeout(seconds: 60) { [weak self] in
            guard let self, case .joining = self.step else { return }
            self.failJoin("The sensor stopped responding. Make sure it's still plugged in and "
                          + "try again.")
        }
    }

    // MARK: - Internals

    private func scan() {
        guard bluetooth == .on else { return }
        central?.scanForPeripherals(withServices: [Self.serviceUUID],
                                    options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    }

    private func startTimeout(seconds: Double, _ fire: @escaping @MainActor () -> Void) {
        timeout?.cancel()
        timeout = Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            fire()
        }
    }

    private func failJoin(_ message: String) {
        timeout?.cancel()
        error = message
        step = .wifi
        Haptics.failure()
    }

    private func gotNetworks(_ data: Data) {
        scanTimeout?.cancel()
        scanningNetworks = false
        // [["name", rssi, secure], ...]
        guard let rows = try? JSONSerialization.jsonObject(with: data) as? [[Any]] else { return }
        networks = rows.compactMap { row in
            guard row.count == 3, let ssid = row[0] as? String,
                  let rssi = row[1] as? Int, let secure = row[2] as? Int else { return nil }
            return WiFiNetwork(ssid: ssid, rssi: rssi, secure: secure != 0)
        }
    }

    private func gotInfo(_ data: Data) {
        guard step == .connecting else { return }
        guard let decoded = try? JSONDecoder().decode(SensorInfo.self, from: data) else {
            backToFind("\(sensorName) didn't answer the way a Flood sensor should. "
                       + "It may need a firmware update.")
            return
        }
        info = decoded
        Task {
            // Already ours? Then this is a move to a new network, not a new sensor.
            if let list: DeviceList = try? await api.authorized(.devices) {
                existingName = list.devices.first { $0.id == decoded.deviceId }?.name
            }
            timeout?.cancel()
            step = .details
            Haptics.light()
        }
    }

    /// The sensor's progress after it has been sent WiFi. Only listened to
    /// while joining, so a status left over from earlier can't be mistaken for
    /// an answer.
    private func handleStatus(_ status: String) {
        // Scan results can arrive on any step: the scan starts right after
        // connecting, so the list is ready by the time it's needed.
        if status == "networks_ready" {
            if let peripheral, let networksChar { peripheral.readValue(for: networksChar) }
            return
        }
        guard case let .joining(stage) = step else { return }

        switch status {
        case "connecting_wifi":
            step = .joining(max(stage, .joiningWiFi))
        case _ where status.hasPrefix("wifi_ok"):
            step = .joining(.reachingServer)
        case "server_ok":
            timeout?.cancel()
            step = .online
            Haptics.success()
            // Setup is done; the sensor talks to the server from here on.
            if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        case "wifi_failed:wrong_password":
            password = ""
            failJoin("That password didn't work. Check it and try again.")
            // Straight back to the password, the one thing to fix.
            joinPrompt = JoinPrompt(networkName: ssid)
        case "wifi_failed:network_not_found":
            failJoin("The sensor couldn't find “\(ssid)”. Check the name (capital letters matter) "
                     + "and that the sensor is in range of your router. It needs a 2.4 GHz network, "
                     + "which almost every home router has.")
        case "wifi_failed:timeout":
            failJoin("The sensor couldn't join “\(ssid)”. Try moving it closer to your router.")
        case "server_failed:unreachable", "server_failed:bad_url":
            failJoin("The sensor is on WiFi but can't reach your Flood server at "
                     + "\(serverURL.host() ?? serverURL.absoluteString). Make sure the server is "
                     + "running and on the same network.")
        case "config_invalid":
            failJoin("The sensor didn't accept those settings. Check the network name and try again.")
        case _ where status.hasPrefix("server_failed"):
            failJoin("Your Flood server turned the sensor away (\(status.dropFirst(14))). "
                     + "Try again, or remove the sensor and set it up from the start.")
        default:
            break
        }
    }
}

// MARK: - CoreBluetooth

extension SensorSetupModel: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated {
            switch central.state {
            case .poweredOn:
                bluetooth = .on
                if step == .find { scan() }
            case .poweredOff: bluetooth = .off
            case .unauthorized: bluetooth = .unauthorized
            case .unsupported: bluetooth = .unsupported
            default: bluetooth = .starting
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                                    advertisementData: [String: Any], rssi RSSI: NSNumber) {
        MainActor.assumeIsolated {
            // 127 means iOS couldn't measure it; not worth showing as a reading.
            let rssi = RSSI.intValue == 127 ? -100 : RSSI.intValue
            if let index = nearby.firstIndex(where: { $0.id == peripheral.identifier }) {
                // Smoothed, so the list doesn't reshuffle on every packet.
                nearby[index].rssi = (nearby[index].rssi * 3 + rssi) / 4
            } else {
                let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String
                    ?? peripheral.name ?? "Flood sensor"
                nearby.append(Nearby(id: peripheral.identifier, name: name, rssi: rssi,
                                     peripheral: peripheral))
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        MainActor.assumeIsolated {
            peripheral.discoverServices([Self.serviceUUID])
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral,
                                    error: Error?) {
        MainActor.assumeIsolated {
            guard step == .connecting else { return }
            backToFind("Couldn't connect to \(sensorName). Try again.")
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                                    error: Error?) {
        MainActor.assumeIsolated {
            config = nil
            networksChar = nil
            switch step {
            case .find, .online:
                return
            case .connecting:
                backToFind("\(sensorName) disconnected. Try again.")
            case .details, .wifi, .joining:
                // Keep going: a connect with no timeout waits for the sensor to
                // come back in range, and it re-advertises as soon as it drops.
                reconnecting = true
                self.central?.connect(peripheral)
            }
        }
    }
}

extension SensorSetupModel: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        MainActor.assumeIsolated {
            guard let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
                backToFind("\(sensorName) isn't a Flood sensor, or needs a firmware update.")
                return
            }
            peripheral.discoverCharacteristics(
                [Self.infoUUID, Self.configUUID, Self.statusUUID, Self.networksUUID], for: service)
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
                                error: Error?) {
        MainActor.assumeIsolated {
            let characteristics = service.characteristics ?? []
            let infoChar = characteristics.first { $0.uuid == Self.infoUUID }
            let statusChar = characteristics.first { $0.uuid == Self.statusUUID }
            config = characteristics.first { $0.uuid == Self.configUUID }
            networksChar = characteristics.first { $0.uuid == Self.networksUUID }
            if networksChar != nil { canScanNetworks = true }

            guard let infoChar, let statusChar, config != nil else {
                backToFind("\(sensorName) needs a firmware update before it can be set up.")
                return
            }
            peripheral.setNotifyValue(true, for: statusChar)

            if reconnecting {
                reconnecting = false
                // Catch up on anything said while the link was down.
                if case .joining = step { peripheral.readValue(for: statusChar) }
                // A scan cut off by the drop never answers; ask again.
                if scanningNetworks || networks.isEmpty, step != .online {
                    scanningNetworks = false
                    if case .joining = step {} else { scanForNetworks() }
                }
            } else {
                peripheral.readValue(for: infoChar)
                scanForNetworks()
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                                error: Error?) {
        MainActor.assumeIsolated {
            guard let data = characteristic.value else { return }
            switch characteristic.uuid {
            case Self.infoUUID: gotInfo(data)
            case Self.statusUUID: handleStatus(String(decoding: data, as: UTF8.self))
            case Self.networksUUID: gotNetworks(data)
            default: break
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic,
                                error: Error?) {
        MainActor.assumeIsolated {
            guard characteristic.uuid == Self.configUUID, case let .joining(stage) = step else { return }
            if error != nil {
                failJoin("Couldn't send the WiFi details to the sensor. Move closer to it and try again.")
            } else {
                // The sensor may already have reported further along than this.
                step = .joining(max(stage, .joiningWiFi))
            }
        }
    }
}
