import SwiftUI

/// The visual vocabulary for risk. One definition, so the list card, the detail
/// header and the history chart can never disagree about what "high" looks like.
extension RiskLevel {
    var tint: Color {
        switch self {
        case .low: .green
        case .moderate: .yellow
        case .high: .orange
        case .critical: .red
        case .unknown: .secondary
        }
    }

    /// A background that stays legible in both color schemes -- a flat fill at
    /// full saturation is unreadable in dark mode.
    var wash: Color { tint.opacity(0.14) }

    var symbol: String {
        switch self {
        case .low: "checkmark.circle.fill"
        case .moderate: "eye.fill"
        case .high: "exclamationmark.triangle.fill"
        case .critical: "exclamationmark.octagon.fill"
        case .unknown: "questionmark.circle"
        }
    }
}

enum Format {
    /// The unit the reader picked, kept here so every call site formats the
    /// same way without threading a setting through half the view tree.
    /// `AppSettings` owns it and is the only thing that writes it, on the main
    /// actor, before any view that reads it is built.
    static var temperatureUnit: TemperatureUnit = .celsius

    /// Temperatures arrive from the server in Celsius, always. Conversion
    /// happens here and nowhere else, so there is exactly one place a unit bug
    /// could live.
    static func temperature(_ c: Double) -> String {
        String(format: "%.1f%@", temperatureUnit.from(celsius: c), temperatureUnit.suffix)
    }

    static func humidity(_ pct: Double) -> String {
        String(format: "%.0f%%", pct)
    }

    static func dewPoint(_ c: Double) -> String {
        temperature(c)
    }

    /// A gap between two temperatures, which converts differently from a
    /// temperature itself.
    static func temperatureDifference(_ c: Double) -> String {
        String(format: "%.1f%@", temperatureUnit.fromDifference(celsius: c), temperatureUnit.suffix)
    }

    /// "2 minutes ago". Used for `last_seen_at`, where the absolute time is
    /// rarely what the reader wants.
    static func relative(_ date: Date, now: Date = Date()) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: now)
    }

    static func absolute(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }

    static func hour(_ h: Int) -> String {
        var components = DateComponents()
        components.hour = h
        components.minute = 0
        let date = Calendar.current.date(from: components) ?? Date()
        return date.formatted(date: .omitted, time: .shortened)
    }
}
