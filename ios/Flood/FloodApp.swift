import SwiftUI

@main
struct FloodApp: App {
    /// Only here because remote notifications are delivered to a UIKit app
    /// delegate and nowhere else. It owns the `PushManager` the views observe.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @State private var session = SessionStore()
    @State private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(settings)
                .environment(appDelegate.push)
                // Applied at the root so every sheet and every alert inherits
                // it; a modifier further down would leave presented views on
                // the system setting.
                .preferredColorScheme(settings.appearance.colorScheme)
                .task {
                    await session.restore()
                    settings.adoptAccountTheme(session.user?.theme)

                    // The token is worth nothing without an account to attach
                    // it to, so this waits until there is one.
                    appDelegate.push.attach(api: session.api)
                    await appDelegate.push.refreshStatus()
                }
        }
    }
}
