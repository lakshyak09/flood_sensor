import SwiftUI

/// The score and its level. The one element that has to read the same on every
/// screen, so it lives here rather than being rebuilt per view.
struct RiskBadge: View {
    let score: Int?
    let level: RiskLevel?
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: (level ?? .unknown).symbol)
                .font(compact ? .caption : .subheadline)
            if let score, let level {
                Text("\(score)")
                    .font(compact ? .caption.bold() : .subheadline.bold())
                    .monospacedDigit()
                Text(level.label)
                    .font(compact ? .caption : .subheadline)
            } else {
                Text("Not scored yet")
                    .font(compact ? .caption : .subheadline)
            }
        }
        .padding(.horizontal, compact ? 8 : 12)
        .padding(.vertical, compact ? 4 : 7)
        .background((level ?? .unknown).wash, in: Capsule())
        .foregroundStyle(level == nil ? Color.secondary : (level ?? .unknown).tint)
        // Read as a sentence rather than as "triangle, 56, High" -- the icon
        // carries no information VoiceOver needs to repeat.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenLabel)
    }

    private var spokenLabel: String {
        guard let score, let level else { return "Not scored yet" }
        return "Risk \(level.label), \(score) out of 100"
    }
}

/// A dot plus a word. `online` is derived from `last_seen_at` server-side, so
/// this never second-guesses it.
struct OnlineDot: View {
    let online: Bool
    let lastSeenAt: Date?

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(online ? Color.green : Color.secondary.opacity(0.5))
                .frame(width: 7, height: 7)
            if online {
                Text("Online")
            } else if let lastSeenAt {
                Text("Last seen \(Format.relative(lastSeenAt))")
            } else {
                Text("Never reported")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}

/// Temperature / humidity / dew point, in the order they matter.
struct ReadingRow: View {
    let reading: Reading?
    var showDewPoint = true

    var body: some View {
        if let reading {
            HStack(spacing: 16) {
                measure("thermometer.medium", Format.temperature(reading.temperatureC))
                measure("humidity", Format.humidity(reading.humidityPct))
                if showDewPoint, let dew = reading.dewPointC {
                    measure("drop.degreesign", Format.dewPoint(dew))
                }
            }
            // Three glyphs and three numbers are meaningless read out in order;
            // the words are what make them a reading.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spokenLabel(reading))
        } else {
            Text("No readings yet")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private func spokenLabel(_ reading: Reading) -> String {
        var parts = [
            "Temperature \(Format.temperature(reading.temperatureC))",
            "humidity \(Format.humidity(reading.humidityPct))",
        ]
        if showDewPoint, let dew = reading.dewPointC {
            parts.append("dew point \(Format.dewPoint(dew))")
        }
        return parts.joined(separator: ", ")
    }

    private func measure(_ symbol: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol).foregroundStyle(.secondary)
            Text(value).monospacedDigit()
        }
        .font(.subheadline)
    }
}

struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message)
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Retry", action: retry).font(.footnote.bold())
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}
