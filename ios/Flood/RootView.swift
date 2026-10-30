import SwiftUI
import Combine   // Timer.publish(...).autoconnect()

struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppSettings.self) private var settings
    @Environment(PushManager.self) private var push

    /// Owned here rather than inside the Alerts tab, because the tab badge has
    /// to be right whether or not that tab has ever been opened.
    @State private var alerts: AlertsModel?

    @State private var tab: String = {
        #if DEBUG
        // Debug builds only: `-demoTab alerts` opens on that tab.
        UserDefaults.standard.string(forKey: "demoTab") ?? "sensors"
        #else
        "sensors"
        #endif
    }()

    /// Slower than the screens themselves poll: this only feeds a number on a
    /// tab, and a minute-old count is not worth a request every thirty seconds.
    private let poll = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    var body: some View {
        switch session.state {
        case .restoring:
            ProgressView("Signing in…")
        case .signedOut:
            AuthView()
        case .signedIn:
            TabView(selection: $tab) {
                Tab("Sensors", systemImage: "sensor", value: "sensors") {
                    DeviceListView()
                }
                Tab("Alerts", systemImage: "bell", value: "alerts") {
                    if let alerts {
                        AlertsView(model: alerts)
                    } else {
                        ProgressView()
                    }
                }
                // Zero draws nothing, which is exactly the wanted behavior for
                // an account with everything acknowledged.
                .badge(alerts?.unacknowledgedCount ?? 0)

                Tab("Settings", systemImage: "gearshape", value: "settings") {
                    SettingsView()
                }
            }
            // Temperatures are formatted through `Format`, which is a plain
            // static and therefore invisible to observation. Keying the tab
            // tree on the unit rebuilds every screen the moment it changes, so
            // a reader switching to Fahrenheit sees it everywhere at once
            // rather than on whichever screen happens to reload next.
            .id(settings.temperatureUnit)
            .task {
                if alerts == nil { alerts = AlertsModel(api: session.api) }

                // Asked at launch, before anything else. This app's whole
                // purpose is telling someone about a wall they cannot see;
                // an install that never gets permission is an install that
                // never does its job, so this is not a question to defer.
                if push.status == .notDetermined {
                    await push.requestAuthorization()
                }

                await refresh()
            }
            .onReceive(poll) { _ in
                Task { await refresh() }
            }
            .onChange(of: push.route) { _, route in
                // A tapped notification is about one sensor, so it opens that
                // sensor. The Sensors tab owns the navigation stack, so it only
                // has to be the visible one -- `DeviceListView` does the rest.
                switch route {
                case .device: tab = "sensors"
                case .alerts: tab = "alerts"
                case nil: break
                }
            }
        }
    }

    /// Reloading the alerts also refreshes the icon badge, because the count
    /// the server last pushed goes stale the moment anything is acknowledged.
    private func refresh() async {
        await alerts?.load()
        push.setBadge(alerts?.unacknowledgedCount ?? 0)
    }
}
