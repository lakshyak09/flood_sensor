import Foundation

/// What the sensor is pointed at. The server's risk model is material-dependent,
/// so this is a real input and not a label.
enum SurfaceMaterial: String, Codable, CaseIterable, Identifiable {
    case drywall, wood, concrete, masonry, tile, unknown

    var id: String { rawValue }

    var label: String {
        switch self {
        case .drywall: "Drywall"
        case .wood: "Wood"
        case .concrete: "Concrete"
        case .masonry: "Masonry"
        case .tile: "Tile"
        case .unknown: "Not sure"
        }
    }

    /// The humidity at which this surface starts to favour growth, straight from
    /// the server's MATERIALS table. Shown as guidance on the picker, because
    /// "drywall" and "tile" are not remotely the same choice.
    var thresholdPct: Int {
        switch self {
        case .drywall: 65
        case .wood: 70
        case .masonry, .concrete: 80
        case .tile: 85
        case .unknown: 70
        }
    }

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SurfaceMaterial(rawValue: raw) ?? .unknown
    }
}

/// A dashboard card. Deliberately smaller than `DeviceDetail`: the list route
/// omits the dew point, the surface material and the counters, so this type
/// omits them too rather than carrying optionals the list can never fill.
struct DeviceSummary: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let location: String?
    let online: Bool
    let lastSeenAt: Date?
    let latestReading: Reading?
    let risk: RiskSummary?

    enum CodingKeys: String, CodingKey {
        case id, name, location, online, risk
        case lastSeenAt = "last_seen_at"
        case latestReading = "latest_reading"
    }
}

struct DeviceList: Codable {
    let devices: [DeviceSummary]
}

struct DeviceDetail: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let location: String?
    let surfaceMaterial: SurfaceMaterial
    let online: Bool
    let lastSeenAt: Date?
    let firmwareVersion: String?
    let readingCount: Int
    let firstReadingAt: Date?
    let latestReading: Reading?
    let risk: RiskSummary?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, name, location, online, risk
        case surfaceMaterial = "surface_material"
        case lastSeenAt = "last_seen_at"
        case firmwareVersion = "firmware_version"
        case readingCount = "reading_count"
        case firstReadingAt = "first_reading_at"
        case latestReading = "latest_reading"
        case createdAt = "created_at"
    }
}
