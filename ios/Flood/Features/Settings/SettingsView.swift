import SwiftUI
import UIKit
import Observation

@MainActor
@Observable
final class PreferencesModel {

    /// What the footer says about the last edit. A setting that saves itself
    /// still has to *show* that it saved, or the reader is left guessing.
    enum SaveState: Equatable {
        case idle, pending, saving, saved
        case failed(String)
    }

    var prefs: Preferences = .fallback
    var loaded = false
    var saveState: SaveState = .idle
    var error: String?

    private let api: APIClient
    private var saveTask: Task<Void, Never>?

    /// Bumped on every edit. A save carries the revision it was built from, so
    /// a reply that arrives after the reader has moved on is ignored rather
    /// than overwriting the newer choice on screen.
    private var revision = 0

    init(api: APIClient) { self.api = api }

    func load() async {
        do {
            prefs = try await api.authorized(.preferences)
            error = nil
        } catch let err as APIError {
            if case .sessionExpired = err {} else { error = err.errorDescription }
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    /// A binding that saves. Every control on this screen goes through here, so
    /// there is no way to change a setting without scheduling the write.
    func binding<Value>(_ keyPath: WritableKeyPath<Preferences, Value>) -> Binding<Value> {
        Binding(
            get: { self.prefs[keyPath: keyPath] },
            set: { newValue in
                self.prefs[keyPath: keyPath] = newValue
                self.scheduleSave()
            }
        )
    }

    /// Wait for the flurry to stop before writing.
    ///
    /// Toggling four switches is four edits and should not be four round trips
    /// -- and a picker spun through twelve hours would otherwise be twelve. The
    /// pause is short enough that "Saved" still appears while the reader is
    /// looking at the row they just touched.
    private func scheduleSave() {
        revision += 1
        saveState = .pending
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await self?.save()
        }
    }

    /// The server's PUT is a full replacement, so this always sends the whole
    /// object -- which is why the screen edits a complete value rather than
    /// accumulating a diff.
    func save() async {
        let sent = revision
        saveState = .saving
        do {
            let stored: Preferences = try await api.authorized(.savePreferences(prefs))
            // Only trust the reply if nothing has changed since it was sent.
            if sent == revision {
                prefs = stored
                saveState = .saved
            }
            error = nil
        } catch let err as APIError {
            if case .sessionExpired = err {
                saveState = .idle
            } else {
                saveState = .failed(err.errorDescription ?? "Couldn't save.")
            }
        } catch {
            saveState = .failed(error.localizedDescription)
        }
    }

    /// For the Retry button, which should not wait out the debounce.
    func saveNow() async {
        saveTask?.cancel()
        await save()
    }
}

struct SettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppSettings.self) private var settings
    @Environment(PushManager.self) private var push
    @State private var model: PreferencesModel?
    @State private var showingServer = false
    @State private var showingHelp = false
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                appearanceSection
                notificationsSection
                if let model, model.loaded {
                    if let error = model.error {
                        Section {
                            ErrorBanner(message: error) { Task { await model.load() } }
                                .listRowInsets(EdgeInsets())
                                .listRowBackground(Color.clear)
                        }
                    }
                    alertSections(model)
                } else {
                    Section { ProgressView() }
                }
                helpSection
                bluetoothTestSection
                serverSection
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showingServer) { ServerSettingsView() }
            .sheet(isPresented: $showingHelp) { HelpView() }
            .alert("Sign out?", isPresented: $confirmingSignOut) {
                Button("Sign out", role: .destructive) {
                    Task {
                        // Before the session goes: a phone still registered to
                        // this account would keep receiving its alerts.
                        await push.unregister()
                        await session.signOut()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your sensors keep reporting while you're signed out.")
            }
        }
        .task {
            if model == nil { model = PreferencesModel(api: session.api) }
            await model?.load()
            await session.refreshUser()
            // Permission can change in iPhone Settings while the app is in the
            // background, so this row is re-read rather than remembered.
            await push.refreshStatus()
        }
    }

    // MARK: - Account

    private var accountSection: some View {
        Section("Account") {
            if let user = session.user {
                LabeledContent("Signed in as", value: user.email)
                LabeledContent("Name", value: user.displayName)
                if let count = user.deviceCount {
                    LabeledContent("Sensors", value: "\(count)")
                }
                if user.isAdmin {
                    Label("Administrator", systemImage: "key.fill")
                        .foregroundStyle(.secondary)
                }
            }
            Button("Sign out", role: .destructive) { confirmingSignOut = true }
        }
    }

    // MARK: - Notifications

    /// Permission lives with iOS, not with this app, so this row reports rather
    /// than pretends to control. The preferences below decide *which* alerts
    /// are worth a notification; this decides whether any can arrive at all.
    @ViewBuilder
    private var notificationsSection: some View {
        Section {
            switch push.status {
            case .authorized:
                Label("Notifications are on", systemImage: "bell.badge.fill")
                    .foregroundStyle(.primary)
            case .notDetermined, .unknown:
                Button {
                    Task { await push.requestAuthorization() }
                } label: {
                    Label("Turn on notifications", systemImage: "bell")
                }
            case .denied:
                Label("Notifications are off", systemImage: "bell.slash")
                    .foregroundStyle(.secondary)
                Button("Open iPhone Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text(push.status == .denied
                 ? "iOS is holding these back. Alerts are still recorded and still show in the "
                   + "Alerts tab. You just won't hear about them."
                 : "Alerts you've asked for below arrive as notifications. You can switch them "
                   + "off entirely in iPhone Settings at any time.")
        }
    }

    // MARK: - Appearance

    private var appearanceSection: some View {
        Section {
            // `AppSettings` is a class, so its properties are writable straight
            // through the environment reference; the explicit bindings exist
            // only because each one has something to do besides store a value.
            Picker("Appearance", selection: Binding(
                get: { settings.appearance },
                set: { newValue in
                    settings.appearance = newValue
                    // Kept on the account as well, so the next phone this
                    // person signs in on opens the way they left it.
                    Task { await session.updateTheme(newValue.serverTheme) }
                }
            )) {
                ForEach(AppAppearance.allCases) { option in
                    Label(option.label, systemImage: option.symbol).tag(option)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()

            Picker("Temperature", selection: Binding(
                get: { settings.temperatureUnit },
                set: { settings.temperatureUnit = $0 }
            )) {
                ForEach(TemperatureUnit.allCases) { unit in
                    Text(unit.label).tag(unit)
                }
            }
        } header: {
            Text("Display")
        } footer: {
            Text("Automatic follows your iPhone's light and dark setting.")
        }
    }

    // MARK: - Alerts

    @ViewBuilder
    private func alertSections(_ model: PreferencesModel) -> some View {
        Section {
            Toggle("High risk", isOn: model.binding(\.riskHigh))
            Toggle("Critical risk", isOn: model.binding(\.riskCritical))
            Toggle("Sensor goes quiet", isOn: model.binding(\.deviceOffline))
            Toggle("Sensor comes back", isOn: model.binding(\.deviceRecovered))
        } header: {
            Text("Tell me about")
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Text("Turning one off means the event is never recorded for this account at all, "
                     + "so it won't appear in the alerts list either.")
                SaveStatus(state: model.saveState) { Task { await model.saveNow() } }
            }
        }

        Section {
            Toggle("Daily summary", isOn: model.binding(\.dailySummary))
            if model.prefs.dailySummary {
                Picker("Send at", selection: model.binding(\.dailySummaryHour)) {
                    ForEach(0..<24, id: \.self) { hour in
                        Text(Format.hour(hour)).tag(hour)
                    }
                }
            }
        } footer: {
            // Honesty beats a toggle that silently does nothing.
            Text("The server stores this preference but does not send a daily summary yet, "
                 + "there is no scheduler to send it.")
        }

        Section {
            Toggle("Quiet hours", isOn: model.binding(\.quietHours.enabled))
            if model.prefs.quietHours.enabled {
                Picker("From", selection: model.binding(\.quietHours.startHour)) {
                    ForEach(0..<24, id: \.self) { Text(Format.hour($0)).tag($0) }
                }
                Picker("Until", selection: model.binding(\.quietHours.endHour)) {
                    ForEach(0..<24, id: \.self) { Text(Format.hour($0)).tag($0) }
                }
            }
            LabeledContent("Time zone", value: model.prefs.timezone)
        } header: {
            Text("Quiet hours")
        } footer: {
            Text("Quiet hours silence the phone, not the record. Alerts are still saved. "
                 + "Critical risk always comes through.")
        }
    }

    // MARK: - Help and server

    private var helpSection: some View {
        Section {
            Button {
                showingHelp = true
            } label: {
                Label("How this works", systemImage: "questionmark.circle")
            }
        } footer: {
            Text("These settings decide both what gets recorded and what reaches your phone. "
                 + "They are the same decision, so the Alerts tab and your lock screen can "
                 + "never disagree.")
        }
    }

    private var bluetoothTestSection: some View {
        Section {
            NavigationLink {
                BLETestView()
            } label: {
                Label("Bluetooth test", systemImage: "antenna.radiowaves.left.and.right")
            }
        } header: {
            Text("Developer")
        } footer: {
            Text("Sends ping to a sensor running firmware/ble_hello.")
        }
    }

    private var serverSection: some View {
        Section("Server") {
            LabeledContent("Address", value: AppConfig.baseURL.absoluteString)
                .font(.footnote)
            Button("Change server") { showingServer = true }
        }
    }
}

/// The receipt for a screen with no save button.
private struct SaveStatus: View {
    let state: PreferencesModel.SaveState
    let retry: () -> Void

    var body: some View {
        switch state {
        case .idle:
            EmptyView()
        case .pending, .saving:
            Label("Saving…", systemImage: "arrow.triangle.2.circlepath")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .saved:
            Label("Saved", systemImage: "checkmark.circle.fill")
                .font(.footnote)
                .foregroundStyle(.green)
                // Announced rather than merely drawn: the whole point of this
                // row is reassurance, and VoiceOver users need it most.
                .accessibilityAddTraits(.updatesFrequently)
        case let .failed(message):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                Button("Retry", action: retry).font(.footnote.bold())
            }
        }
    }
}
