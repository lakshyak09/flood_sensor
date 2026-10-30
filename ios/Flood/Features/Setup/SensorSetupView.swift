import SwiftUI
import UIKit

/// Add sensor: the guided Bluetooth setup, with the old paste-the-details
/// screen (`ClaimDeviceView`) one tap away for when Bluetooth isn't an option.
struct SensorSetupView: View {
    let onFinished: () async -> Void

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model: SensorSetupModel?
    @State private var manual = false

    var body: some View {
        if manual {
            ClaimDeviceView(onClaimed: onFinished)
        } else {
            NavigationStack {
                Group {
                    if let model {
                        StepView(model: model, manual: $manual, finish: finish)
                    } else {
                        ProgressView()
                    }
                }
                .navigationTitle("Add sensor")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if model?.step != .online {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { dismiss() }
                        }
                    }
                }
            }
            .interactiveDismissDisabled(model?.step.isJoining ?? false)
            .task {
                if model == nil { model = SensorSetupModel(api: session.api) }
                model?.start()
            }
            .onDisappear { model?.stop() }
        }
    }

    private func finish() {
        Task {
            await onFinished()
            dismiss()
        }
    }
}

private extension SensorSetupModel.Step {
    var isJoining: Bool {
        if case .joining = self { return true }
        return false
    }
}

private struct StepView: View {
    @Bindable var model: SensorSetupModel
    @Binding var manual: Bool
    let finish: () -> Void

    var body: some View {
        Group {
            switch model.step {
            case .find: FindStep(model: model, manual: $manual)
            case .connecting: WaitingStep(title: "Connecting to \(model.sensorName)…")
            case .details: DetailsStep(model: model)
            case .wifi: WiFiStep(model: model)
            case let .joining(stage): JoiningStep(model: model, stage: stage)
            case .online: OnlineStep(name: model.existingName ?? model.name, finish: finish)
            }
        }
        .animation(.default, value: model.step)
        .safeAreaInset(edge: .top) {
            if model.reconnecting {
                Label("Reconnecting to \(model.sensorName)…", systemImage: "antenna.radiowaves.left.and.right")
                    .font(.footnote)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    .background(.orange.opacity(0.2))
            }
        }
    }
}

// MARK: - Shared pieces

/// A big full-width button pinned to the bottom of a step.
private struct PrimaryButton: View {
    let title: String
    var busy = false
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if busy { ProgressView() } else { Text(title) }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .disabled(disabled || busy)
        .padding(.horizontal)
        .padding(.bottom, 8)
    }
}

private struct ErrorRow: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.subheadline)
            .foregroundStyle(.red)
    }
}

private struct WaitingStep: View {
    let title: String

    var body: some View {
        VStack(spacing: 16) {
            ProgressView().controlSize(.large)
            Text(title).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - 1. Find

private struct FindStep: View {
    let model: SensorSetupModel
    @Binding var manual: Bool
    /// Nothing has turned up for a while. The search carries on, since a sensor
    /// plugged in now should still just appear, but the spinner alone stops
    /// saying anything useful.
    @State private var searchingAWhile = false

    var body: some View {
        switch model.bluetooth {
        case .starting:
            WaitingStep(title: "Starting Bluetooth…")
        case .off:
            ContentUnavailableView {
                Label("Bluetooth is off", systemImage: "antenna.radiowaves.left.and.right.slash")
            } description: {
                Text("Turn on Bluetooth in Control Center so your phone can find the sensor.")
            } actions: {
                manualButton
            }
        case .unauthorized:
            ContentUnavailableView {
                Label("Bluetooth isn't allowed", systemImage: "hand.raised")
            } description: {
                Text("Flood needs Bluetooth to set up a sensor. You can allow it in Settings.")
            } actions: {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .buttonStyle(.borderedProminent)
                manualButton
            }
        case .unsupported:
            ContentUnavailableView {
                Label("No Bluetooth here", systemImage: "antenna.radiowaves.left.and.right.slash")
            } description: {
                Text("This device can't use Bluetooth. You can still add a sensor with its setup details.")
            } actions: {
                manualButton
            }
        case .on:
            list
        }
    }

    private var list: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "sensor.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.tint)
                    Text("Plug in your sensor")
                        .font(.title2.bold())
                    Text("Keep your phone close to it. It will show up below within a few seconds.")
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
                .listRowBackground(Color.clear)
            }

            if let error = model.error {
                Section { ErrorRow(message: error) }
            }

            Section {
                if model.nearby.isEmpty {
                    if searchingAWhile {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("No sensors found yet")
                                .font(.headline)
                            Text("Make sure your sensor is plugged in and your phone is within a "
                                 + "few feet of it. A sensor that's already online won't show up "
                                 + "here. Sensors only appear when they're new or can't reach "
                                 + "their WiFi.")
                                .foregroundStyle(.secondary)
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text("Still looking…")
                            }
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.top, 4)
                        }
                        .padding(.vertical, 4)
                    } else {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Looking for sensors…").foregroundStyle(.secondary)
                        }
                    }
                }
                ForEach(model.nearby.sorted { $0.rssi > $1.rssi }) { sensor in
                    Button {
                        model.choose(sensor)
                    } label: {
                        HStack {
                            Label(sensor.name, systemImage: "sensor")
                                .foregroundStyle(.primary)
                            Spacer()
                            SignalBars(rssi: sensor.rssi)
                            Image(systemName: "chevron.right")
                                .font(.footnote.bold())
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            } header: {
                Text("Nearby sensors")
            } footer: {
                // The empty list already says this at length.
                if !model.nearby.isEmpty {
                    Text("Don't see yours? A sensor that's already online won't show up here. "
                         + "Sensors only appear when they're new or can't reach their WiFi.")
                }
            }

            Section {
                manualButton
            }
        }
        .task(id: model.nearby.isEmpty) {
            searchingAWhile = false
            guard model.nearby.isEmpty else { return }
            try? await Task.sleep(for: .seconds(15))
            if !Task.isCancelled { searchingAWhile = true }
        }
    }

    private var manualButton: some View {
        Button("Set up without Bluetooth") { manual = true }
    }
}

private struct SignalBars: View {
    let rssi: Int

    private var bars: Int {
        switch rssi {
        case (-60)...: 3
        case (-75)...: 2
        default: 1
        }
    }

    var body: some View {
        Image(systemName: "cellularbars", variableValue: Double(bars) / 3)
            .foregroundStyle(.secondary)
            .accessibilityLabel(bars == 3 ? "Strong signal" : bars == 2 ? "Good signal" : "Weak signal")
    }
}

// MARK: - 2. Name it

private struct DetailsStep: View {
    @Bindable var model: SensorSetupModel

    var body: some View {
        Form {
            Section {
                Label("Connected to \(model.sensorName)", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }

            if let existing = model.existingName {
                Section {
                    Text("This sensor is already in your account as “\(existing)”. "
                         + "Next, you'll connect it to WiFi.")
                }
            } else {
                Section {
                    TextField("Name, like Basement north wall", text: $model.name)
                    TextField("Location (optional)", text: $model.location)
                } header: {
                    Text("Name it")
                } footer: {
                    Text("Pick something you'll recognize in an alert.")
                }

                Section {
                    Picker("Surface", selection: $model.material) {
                        ForEach(SurfaceMaterial.allCases) { m in
                            Text(m.label).tag(m)
                        }
                    }
                } header: {
                    Text("What is it pointed at?")
                } footer: {
                    Text("This changes the mold risk model. \(model.material.label) is treated as "
                         + "favorable for growth above \(model.material.thresholdPct)% humidity.")
                }
            }

            if let error = model.error {
                Section { ErrorRow(message: error) }
                Section {
                    Button("Choose a different sensor") { model.backToFind() }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(title: "Continue", busy: model.busy,
                          disabled: model.existingName == nil
                              && model.name.trimmingCharacters(in: .whitespaces).isEmpty) {
                Task { await model.claim() }
            }
        }
    }
}

// MARK: - 3. WiFi

private struct WiFiStep: View {
    @Bindable var model: SensorSetupModel

    var body: some View {
        Form {
            // Problems go first: below a list of twenty networks, nobody sees them.
            if model.serverUnreachableFromSensor {
                Section {
                    ErrorRow(message: "The app is using \(model.serverURL.host() ?? "this device") "
                             + "as the server address, which the sensor can't reach. Change it in "
                             + "Settings → Change server to your computer's network address.")
                }
            } else if let error = model.error, model.joinPrompt == nil {
                Section { ErrorRow(message: error) }
            }

            Section {
                if model.canScanNetworks {
                    if model.networks.isEmpty {
                        if model.scanningNetworks {
                            HStack(spacing: 12) {
                                ProgressView()
                                Text("Looking for networks…").foregroundStyle(.secondary)
                            }
                        } else {
                            Text("The sensor didn't find any WiFi. Move it closer to your router and "
                                 + "tap refresh, or choose Other network.")
                                .foregroundStyle(.secondary)
                        }
                    }

                    ForEach(model.networks) { network in
                        Button {
                            model.chooseNetwork(network)
                        } label: {
                            NetworkRow(network: network)
                        }
                    }
                }

                Button(model.canScanNetworks ? "Other network…" : "Enter network details…") {
                    model.chooseOtherNetwork()
                }
            } header: {
                HStack {
                    Text("Choose your WiFi")
                    Spacer()
                    if model.canScanNetworks {
                        Button {
                            model.scanForNetworks()
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .disabled(model.scanningNetworks)
                        .accessibilityLabel("Look for networks again")
                    }
                }
            } footer: {
                Text(model.canScanNetworks
                     ? "These are the networks your sensor can hear. It works with 2.4 GHz WiFi, "
                       + "which almost every home router has, so your home network should be here."
                     : "Use your home WiFi. The sensor needs a 2.4 GHz network, which almost every "
                       + "home router has.")
            }
            .disabled(model.serverUnreachableFromSensor)
        }
        .onAppear {
            if model.canScanNetworks && model.networks.isEmpty { model.scanForNetworks() }
        }
        .sheet(item: $model.joinPrompt) { prompt in
            JoinNetworkSheet(model: model, prompt: prompt)
        }
    }
}

/// The password prompt, in the shape iPhone Settings uses for joining WiFi.
private struct JoinNetworkSheet: View {
    @Bindable var model: SensorSetupModel
    let prompt: SensorSetupModel.JoinPrompt

    @Environment(\.dismiss) private var dismiss
    @State private var showPassword = false
    @FocusState private var focus: Field?

    private enum Field { case name, password }

    private var askingName: Bool { prompt.networkName == nil }

    var body: some View {
        NavigationStack {
            Form {
                if let error = model.error {
                    Section { ErrorRow(message: error) }
                }

                if askingName {
                    Section {
                        TextField("Network name", text: $model.ssid)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .name)
                            .submitLabel(.next)
                            .onSubmit { focus = .password }
                    } footer: {
                        Text("Type it exactly as it appears. Capital letters matter.")
                    }
                }

                Section {
                    HStack {
                        Group {
                            if showPassword {
                                TextField("Password", text: $model.password)
                            } else {
                                SecureField("Password", text: $model.password)
                            }
                        }
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .password)
                        .submitLabel(.join)
                        .onSubmit(join)

                        Button {
                            showPassword.toggle()
                        } label: {
                            Image(systemName: showPassword ? "eye.slash" : "eye")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(showPassword ? "Hide password" : "Show password")
                    }
                } header: {
                    if let name = prompt.networkName {
                        Text("Enter the password for “\(name)”")
                            .textCase(nil)
                    }
                } footer: {
                    Text(askingName
                         ? "Leave the password empty if the network doesn't have one. "
                           + "It goes straight to the sensor, and the app doesn't keep it."
                         : "Your password goes straight to the sensor. The app doesn't keep it.")
                }
            }
            .navigationTitle(askingName ? "Other Network" : "Enter Password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Join", action: join)
                        .disabled(!canJoin)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            // A beat for the sheet to settle, or the keyboard doesn't come up.
            try? await Task.sleep(for: .milliseconds(350))
            focus = askingName ? .name : .password
        }
    }

    private var canJoin: Bool {
        let hasName = !model.ssid.trimmingCharacters(in: .whitespaces).isEmpty
        // A locked network always has a password; a typed one might be open.
        return hasName && (askingName || !model.password.isEmpty)
    }

    private func join() {
        guard canJoin else { return }
        model.sendWiFi()
    }
}

private struct NetworkRow: View {
    let network: WiFiNetwork

    private var strength: Double {
        switch network.rssi {
        case (-60)...: 1
        case (-72)...: 0.66
        default: 0.33
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "wifi", variableValue: strength)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            Text(network.ssid)
                .foregroundStyle(.primary)
            Spacer()
            if network.secure {
                Image(systemName: "lock.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Needs a password")
            }
        }
    }
}

// MARK: - 4. Joining

private struct JoiningStep: View {
    let model: SensorSetupModel
    let stage: SensorSetupModel.JoinStage

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Setting up \(model.sensorName)")
                .font(.title2.bold())

            VStack(alignment: .leading, spacing: 18) {
                row("Sending WiFi details", for: .sending)
                row("Joining “\(model.ssid)”", for: .joiningWiFi)
                row("Checking in with Flood", for: .reachingServer)
            }

            Text("This usually takes less than half a minute. Keep your phone near the sensor.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func row(_ title: String, for rowStage: SensorSetupModel.JoinStage) -> some View {
        HStack(spacing: 12) {
            Group {
                if rowStage < stage {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                } else if rowStage == stage {
                    ProgressView()
                } else {
                    Image(systemName: "circle").foregroundStyle(.tertiary)
                }
            }
            .frame(width: 24)
            Text(title)
                .foregroundStyle(rowStage > stage ? .secondary : .primary)
        }
        .font(.body)
    }
}

// MARK: - 5. Done

private struct OnlineStep: View {
    let name: String
    let finish: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.green)
                .symbolEffect(.bounce, value: true)
            Text("“\(name)” is online")
                .font(.title2.bold())
                .multilineTextAlignment(.center)
            Text("It's connected to WiFi and checking in with Flood. You'll find it in your sensor list.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding()
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(title: "Done", action: finish)
        }
    }
}
