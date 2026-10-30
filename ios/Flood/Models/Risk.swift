import Foundation

/// The four bands the server can report. Kept as a real enum with an `unknown`
/// case so a level this build has never heard of renders as something neutral
/// instead of crashing a decode.
enum RiskLevel: String, Codable, CaseIterable {
    case low, moderate, high, critical
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RiskLevel(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .low: "Low"
        case .moderate: "Moderate"
        case .high: "High"
        case .critical: "Critical"
        case .unknown: "Unknown"
        }
    }

    /// Ordering for "is this worse than that". Mirrors LEVEL_RANK on the server.
    var rank: Int {
        switch self {
        case .unknown: -1
        case .low: 0
        case .moderate: 1
        case .high: 2
        case .critical: 3
        }
    }
}

/// The risk summary that rides along on a device. Absent entirely when the
/// device has too little history to score.
struct RiskSummary: Codable, Hashable {
    let score: Int
    let level: RiskLevel
    let recommendation: String?
    let computedAt: Date?

    enum CodingKeys: String, CodingKey {
        case score, level, recommendation
        case computedAt = "computed_at"
    }
}

struct RiskFactor: Codable, Hashable, Identifiable {
    let key: String
    let label: String
    let contribution: Int
    let detail: String
    /// The quantity behind `detail`, in Celsius, for the factors that have one.
    /// Absent on the others, and absent from older servers -- so `detail` stays
    /// the fallback rather than the exception.
    let valueC: Double?

    var id: String { key }

    enum CodingKeys: String, CodingKey {
        case key, label, contribution, detail
        case valueC = "value_c"
    }

    /// The factor explained in the reader's chosen units.
    ///
    /// The server writes `detail` in Celsius, which is right for a server and
    /// wrong for a phone set to Fahrenheit. Where the raw number came along,
    /// the sentence is rebuilt here; where it did not, the server's words stand.
    var readableDetail: String {
        guard key == "dew_point_margin", let margin = valueC else { return detail }
        return margin <= 0
            ? "Surface is at or below the dew point, so condensation is forming."
            : "Surface is within \(Format.temperatureDifference(margin)) of the dew point."
    }
}

struct RiskModel: Codable, Hashable {
    let name: String
    let version: String
    let surfaceMaterial: String

    enum CodingKeys: String, CodingKey {
        case name, version
        case surfaceMaterial = "surface_material"
    }
}

/// `GET /devices/:id/risk`.
///
/// Every field except `device_id` is nullable: a device with fewer than six
/// readings in the window is not a 404 and is not a zero, it is a device the
/// server cannot speak for yet. `isScored` is the only thing the UI should
/// branch on.
struct RiskDetail: Codable {
    let deviceId: String
    let score: Int?
    let level: RiskLevel?
    let recommendation: String?
    let computedAt: Date?
    let model: RiskModel?
    let factors: [RiskFactor]?
    let windowHours: Int?

    var isScored: Bool { score != nil && level != nil }

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case score, level, recommendation, model, factors
        case computedAt = "computed_at"
        case windowHours = "window_hours"
    }
}

struct RiskHistoryPoint: Codable, Hashable, Identifiable {
    let t: Date
    let score: Int
    let level: RiskLevel

    var id: Date { t }
}

struct RiskHistoryPage: Codable {
    let deviceId: String
    let from: Date
    let to: Date
    let bucket: String
    let truncated: Bool
    let points: [RiskHistoryPoint]

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case from, to, bucket, truncated, points
    }
}

/// `GET /devices/:id/latest` -- the cheap poll for a live screen.
struct LatestSnapshot: Codable {
    let deviceId: String
    let online: Bool
    let reading: Reading?
    let risk: RiskSummary?

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case online, reading, risk
    }
}
