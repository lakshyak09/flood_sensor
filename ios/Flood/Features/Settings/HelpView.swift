import SwiftUI

/// What the numbers mean, in the words someone would use out loud.
///
/// The detail screen already explains a particular score. This explains the
/// idea behind all of them, which is the question a first-time reader actually
/// has: why is a wall at 80% humidity fine on Tuesday and a problem on Friday?
struct HelpView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    section(
                        "What the sensor does",
                        "Each sensor measures the temperature and the humidity of the air "
                        + "next to a surface, a few times an hour. On its own a single "
                        + "reading says very little. Mold grows over days, not moments."
                    )

                    levels

                    section(
                        "Why one wet reading doesn't count",
                        "A shower can push a bathroom past 90% humidity twice a day and "
                        + "nothing will ever grow there, because it dries out in between. "
                        + "The score is built from a whole week, so short spikes stay low "
                        + "and a wall that never dries climbs."
                    )

                    section(
                        "Dew point, without the jargon",
                        "The dew point is the temperature at which the air has to give up "
                        + "its moisture as water. When a surface is close to it, that water "
                        + "appears on the surface. Think of the wet window on a cold morning. "
                        + "That is why a cold wall is riskier than a warm one at exactly "
                        + "the same humidity."
                    )

                    section(
                        "Surfaces are not equal",
                        "Drywall starts supporting growth around 65% humidity. Tile needs "
                        + "85% and mostly shrugs it off. Telling a sensor what it is "
                        + "pointed at is what makes its score mean anything, so it is worth "
                        + "getting right in the sensor's settings."
                    )

                    section(
                        "When a sensor goes quiet",
                        "Sensors are marked offline after half an hour of silence. Usually "
                        + "that is a flat battery or a Wi-Fi drop. The readings it already "
                        + "sent are kept, and the score stops moving until it comes back."
                    )
                }
                .padding()
            }
            .navigationTitle("How this works")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func section(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            Text(body)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The bands, in the same colors the rest of the app uses for them -- this
    /// is the key to every badge the reader has already seen.
    private var levels: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("What the score means").font(.headline)

            band(.low, "0–24", "Dry enough. Nothing to do.")
            band(.moderate, "25–49", "Worth watching. Air the room out.")
            band(.high, "50–74", "Run a dehumidifier and look for the source.")
            band(.critical, "75–100", "Condensation is imminent or already happening. "
                 + "Find the leak and dry the area now.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func band(_ level: RiskLevel, _ range: String, _ meaning: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: level.symbol)
                .foregroundStyle(level.tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(level.label).font(.subheadline.weight(.medium))
                    Text(range).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }
                Text(meaning)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(level.wash, in: RoundedRectangle(cornerRadius: 10))
    }
}
