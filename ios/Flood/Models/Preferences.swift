import Foundation

struct QuietHours: Codable, Hashable {
    var enabled: Bool
    var startHour: Int
    var endHour: Int

    enum CodingKeys: String, CodingKey {
        case enabled
        case startHour = "start_hour"
        case endHour = "end_hour"
    }
}

/// Notification preferences.
///
/// The server's PUT is a **full replacement** -- every field is required -- so
/// this is one value type that always carries the complete object. That is also
/// why the settings screen edits a copy of it and saves the whole thing.
struct Preferences: Codable, Hashable {
    var riskHigh: Bool
    var riskCritical: Bool
    var deviceOffline: Bool
    var deviceRecovered: Bool
    var dailySummary: Bool
    var dailySummaryHour: Int
    var timezone: String
    var quietHours: QuietHours

    enum CodingKeys: String, CodingKey {
        case timezone
        case riskHigh = "risk_high"
        case riskCritical = "risk_critical"
        case deviceOffline = "device_offline"
        case deviceRecovered = "device_recovered"
        case dailySummary = "daily_summary"
        case dailySummaryHour = "daily_summary_hour"
        case quietHours = "quiet_hours"
    }

    /// The same defaults the server reports for an account that has never saved.
    static let fallback = Preferences(
        riskHigh: true,
        riskCritical: true,
        deviceOffline: true,
        deviceRecovered: true,
        dailySummary: false,
        dailySummaryHour: 9,
        timezone: TimeZone.current.identifier,
        quietHours: QuietHours(enabled: false, startHour: 22, endHour: 7)
    )
}
