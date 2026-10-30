import UIKit
import UserNotifications

/// The small amount of app that SwiftUI still cannot express.
///
/// Remote notifications are delivered through `UIApplicationDelegate` callbacks
/// and nothing else, so this exists to receive three of them and hand each one
/// to `PushManager`. It owns the manager so that the object receiving the token
/// and the object the views observe are the same one.
final class AppDelegate: NSObject, UIApplicationDelegate {

    let push = PushManager()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = push
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in self.push.didRegister(deviceToken: deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in self.push.didFailToRegister(error: error) }
    }
}
