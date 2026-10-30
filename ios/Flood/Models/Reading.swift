import Foundation

/// A single measurement. The device sends temperature and humidity; the server
/// derives the dew point, so it can be absent on rows written before it was
/// stored -- hence the optional.
struct Reading: Codable, Hashable {
    let recordedAt: Date
    let temperatureC: Double
    let humidityPct: Double
    let dewPointC: Double?

    enum CodingKeys: String, CodingKey {
        case recordedAt = "recorded_at"
        case temperatureC = "temperature_c"
        case humidityPct = "humidity_pct"
        case dewPointC = "dew_point_c"
    }
}

/// A point on a history chart. On `bucket=raw` the server omits the aggregate
/// fields entirely -- a raw point is its own extreme -- so they are optional
/// rather than defaulted, and the chart can tell the two cases apart.
struct ReadingPoint: Codable, Hashable, Identifiable {
    let t: Date
    let temperatureC: Double
    let humidityPct: Double
    let dewPointC: Double?
    let humidityMin: Double?
    let humidityMax: Double?
    let sampleCount: Int?

    var id: Date { t }

    enum CodingKeys: String, CodingKey {
        case t
        case temperatureC = "temperature_c"
        case humidityPct = "humidity_pct"
        case dewPointC = "dew_point_c"
        case humidityMin = "humidity_min"
        case humidityMax = "humidity_max"
        case sampleCount = "sample_count"
    }
}

struct ReadingsPage: Codable {
    let deviceId: String
    let from: Date
    let to: Date
    /// The bucket the server actually chose, which is not necessarily the one
    /// that was asked for: `auto` resolves to a real width.
    let bucket: String
    let truncated: Bool
    let points: [ReadingPoint]

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case from, to, bucket, truncated, points
    }
}

/// The bucket widths the readings route accepts.
enum Bucket: String, CaseIterable {
    case auto, raw
    case oneMinute = "1m"
    case fiveMinutes = "5m"
    case oneHour = "1h"
    case oneDay = "1d"
}
