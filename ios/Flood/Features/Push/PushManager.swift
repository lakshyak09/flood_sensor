import UIKit
import UserNotifications
import Observation

/// Where a tapped notification should land.
enum PushRoute: Equatable {
    /// The notification named a sensor, so open that sensor.
    case device(String)
    /// It didn't, so the history is the best answer.
    case alerts
}

/// Permission, the device token, and what a tap should open.
///
/// The server already decides *whether* to notify someone -- preferences and
/// quiet hours are settled there, once, and the push and the alerts list are
/// the same decision. Nothing in here re-litigates that. This is only the
/// phone's half: asking iOS for permission, handing the token to the server,
/// and giving the app somewhere to go when a banner is tapped.
@MainActor
@Observable
final class PushManager: NSObject {

    enum Status: Equatable {
        case unknown, notDetermined, authorized, denied

        var isOn: Bool { self == .authorized }
    }

    private(set) var status: Status = .unknown

    /// Set when a notification is tapped, cleared once the app has navigated.
    var route: PushRoute?

    /// The APNs token, hex-encoded the way the server stores it. Nil until iOS
    /// hands one over, which it only does after permission is granted.
    private(set) var token: String?

    /// Set once the session exists. Registration can be triggered by iOS before
    /// anyone has signed in, so the token waits here until there is an account
    /// to attach it to.
    private var api: APIClient?

    func attach(api: APIClient) {
        self.api = api
        Task { await self.syncToken() }
    }

    // MARK: - Permission

    func refreshStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        status = switch settings.authorizationStatus {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .authorized, .provisional, .ephemeral: .authorized
        @unknown default: .unknown
        }

        // Already allowed on a previous launch: iOS does not re-issue the token
        // on its own, so ask for it again. Cheap, and the alternative is a
        // phone that is authorised but unreachable.
        if status.isOn { UIApplication.shared.registerForRemoteNotifications() }
    }

    /// Ask, once. A second call after a denial does nothing -- iOS only shows
    /// the system prompt one time, which is why the settings screen offers a
    /// route to the Settings app instead of asking again.
    @discardableResult
    func requestAuthorization() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge])) ?? false

        await refreshStatus()
        return granted
    }

    // MARK: - The token

    func didRegister(deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await self.syncToken() }
    }

    func didFailToRegister(error: Error) {
        // Expected in the simulator and in any build without the Push
        // Notifications capability. Local delivery still works, so this is a
        // note rather than something to show the reader.
        print("Remote notification registration failed: \(error.localizedDescription)")
    }

    /// Tell the server where to reach this phone.
    ///
    /// Safe to repeat: the token is unique server-side, so re-registering moves
    /// it to whichever account is signed in now rather than duplicating it.
    /// That is also what makes signing into a second account stop the first
    /// account's alerts arriving here.
    private func syncToken() async {
        guard let api, let token else { return }
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        _ = try? await api.authorizedVoid(.registerPushToken(token, appVersion: version))
    }

    /// Stop this phone hearing about an account it is no longer signed into.
    /// Best effort -- signing out must succeed offline too.
    func unregister() async {
        guard let api, let token else { return }
        try? await api.authorizedVoid(.deletePushToken(token))
    }

    // MARK: - Badge

    /// The number on the app icon, which is the count of alerts not yet looked
    /// at. The server sends it with each push; this keeps it honest while the
    /// app is open and the reader is clearing them.
    func setBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
    }
}

// MARK: - Delivery

extension PushManager: UNUserNotificationCenterDelegate {

    /// A notification that arrives while the app is open still shows.
    ///
    /// Suppressing it would be wrong here: someone reading yesterday's chart is
    /// not necessarily looking at the sensor that just went critical, and the
    /// banner is how they find out.
    ///
    /// Written as the completion-handler form, with an explicit `@objc`, and
    /// not as the prettier `async` one. Every method on this delegate is an
    /// *optional* Objective-C requirement, which means a signature the runtime
    /// does not recognize is not a compile error: it is simply never called,
    /// and iOS quietly falls back to showing nothing while the app is open.
    /// That failure is invisible in the code and obvious on the screen, so the
    /// unambiguous spelling is worth more here than the tidy one.
    @objc nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // `.list` as well as `.banner`: the banner is how it is noticed, and
        // Notification Center is where it is found again ten minutes later.
        completionHandler([.banner, .list, .sound, .badge])
    }

    /// The reader tapped it. Go where the notification was about.
    @objc nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let deviceId = response.notification.request.content.userInfo["device_id"] as? String

        Task { @MainActor in
            self.route = deviceId.map(PushRoute.device) ?? .alerts
            completionHandler()
        }
    }
}
