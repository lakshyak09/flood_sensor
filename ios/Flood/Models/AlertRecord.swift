import Foundation

enum AlertType: String, Codable {
    case riskHigh = "risk_high"
    case riskCritical = "risk_critical"
    case deviceOffline = "device_offline"
    case deviceRecovered = "device_recovered"
    case dailySummary = "daily_summary"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AlertType(rawValue: raw) ?? .unknown
    }

    var symbol: String {
        switch self {
        case .riskHigh, .riskCritical: "exclamationmark.triangle.fill"
        case .deviceOffline: "wifi.slash"
        case .deviceRecovered: "wifi"
        case .dailySummary: "sun.max"
        case .unknown: "bell"
        }
    }
}

/// A record of what the user was told. `deviceName` is a snapshot the server
/// took when the alert fired, not a join, so it keeps reading correctly after a
/// rename -- which is why this type does not try to re-resolve it.
struct AlertRecord: Codable, Identifiable, Hashable {
    let id: String
    let deviceId: String?
    let deviceName: String?
    let type: AlertType
    let firedAt: Date
    let score: Int?
    let level: RiskLevel?
    let message: String
    /// Whether a push *would* have gone out. Quiet hours store the alert with
    /// this false. Nothing sends pushes yet, so it is an intent, not a receipt.
    let notified: Bool
    let acknowledgedAt: Date?

    var isAcknowledged: Bool { acknowledgedAt != nil }

    enum CodingKeys: String, CodingKey {
        case id, type, score, level, message, notified
        case deviceId = "device_id"
        case deviceName = "device_name"
        case firedAt = "fired_at"
        case acknowledgedAt = "acknowledged_at"
    }
}

struct AlertsPage: Codable {
    let alerts: [AlertRecord]
    let nextCursor: String?

    enum CodingKeys: String, CodingKey {
        case alerts
        case nextCursor = "next_cursor"
    }
}
