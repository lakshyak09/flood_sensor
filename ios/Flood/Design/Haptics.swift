import UIKit

/// The three moments in this app worth feeling.
///
/// Deliberately short: haptics that fire on everything stop meaning anything,
/// so this covers a thing created, a thing dismissed, and a thing that failed.
/// Nothing that happens on its own -- a poll landing, a score changing -- ever
/// taps the reader on the shoulder.
@MainActor
enum Haptics {
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func failure() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }

    /// For a deliberate small action, such as marking an alert as seen.
    static func light() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}
