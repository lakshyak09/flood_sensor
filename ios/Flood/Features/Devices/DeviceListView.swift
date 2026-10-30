import SwiftUI
import Observation
import Combine   // Timer.publish(...).autoconnect()

@MainActor
@Observable
final class DeviceListModel {
    var devices: [DeviceSummary] = []
    var error: String?
    var loaded = false

    private let api: APIClient
    init(api: APIClient) { self.api = api }

    /// Worst first.
    ///
    /// The server returns sensors in the order they were claimed, which is the
    /// order they stop mattering in. Someone opening this app during a leak
    /// should not have to scroll past four dry rooms to find the wet one, so
    /// the highest risk sorts to the top, then anything that has gone quiet,
    /// then the rest by name.
    var ordered: [DeviceSummary] {
        devices.sorted { first, second in
            let firstRank = first.risk?.level.rank ?? -1
            let secondRank = second.risk?.level.rank ?? -1
            if firstRank != secondRank { return firstRank > secondRank }
            if first.online != second.online { return second.online }
            return first.name.localizedCaseInsensitiveCompare(second.name) == .orderedAscending
        }
    }

    /// Sensors that want a human: high or worse, or one that has stopped
    /// reporting after having reported before. A sensor that has never said
    /// anything is still being set up, which is not the same as a problem.
    var needingAttention: [DeviceSummary] {
        devices.filter { device in
            if let level = device.risk?.level, level.rank >= RiskLevel.high.rank { return true }
            return !device.online && device.lastSeenAt != nil
        }
    }

    func load() async {
        do {
            let list: DeviceList = try await api.authorized(.devices)
            devices = list.devices
            error = nil
        } catch let err as APIError {
            // An expired session is handled centrally; showing a banner for it
            // would flash on the way to the login screen.
            if case .sessionExpired = err {} else { error = err.errorDescription }
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

struct DeviceListView: View {
    @Environment(SessionStore.self) private var session
    @Environment(PushManager.self) private var push
    @State private var model: DeviceListModel?
    @State private var showingClaim = false
    @State private var path: [String] = []

    /// The home screen polls even though alerts are pushed: a push only fires
    /// when something crosses a threshold, and this screen shows numbers that
    /// move constantly. It is also one of the two screens whose visit makes the
    /// server notice a sensor has gone quiet.
    private let poll = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let model {
                    content(model)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Sensors")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add sensor", systemImage: "plus") { showingClaim = true }
                }
            }
            .sheet(isPresented: $showingClaim) {
                SensorSetupView { await model?.load() }
            }
        }
        .task {
            if model == nil { model = DeviceListModel(api: session.api) }
            await model?.load()

            #if DEBUG
            // Debug builds only: `-demoOpenDevice <index>` opens straight to a
            // sensor's detail screen, so iterating on that screen does not mean
            // tapping through the list on every rebuild.
            if path.isEmpty,
               let raw = UserDefaults.standard.string(forKey: "demoOpenDevice"),
               let index = Int(raw),
               let devices = model?.ordered, devices.indices.contains(index) {
                path = [devices[index].id]
            }
            #endif
        }
        .onReceive(poll) { _ in
            Task { await model?.load() }
        }
        // Checked on appear as well as on change: a tap that launches the app
        // from cold sets the route before this screen exists, and an `onChange`
        // alone would never see it.
        .onChange(of: push.route) { _, _ in openRoutedDevice() }
        .onAppear { openRoutedDevice() }
    }

    /// Open the sensor a tapped notification was about, then forget the route
    /// so the next tap on the same sensor is a change again.
    private func openRoutedDevice() {
        guard case let .device(id) = push.route else { return }
        if path.last != id { path = [id] }
        push.route = nil
    }

    @ViewBuilder
    private func content(_ model: DeviceListModel) -> some View {
        if !model.loaded {
            ProgressView()
        } else if model.devices.isEmpty {
            ContentUnavailableView {
                Label("No sensors yet", systemImage: "sensor")
            } description: {
                Text("Add your first sensor to start watching a damp spot.")
            } actions: {
                Button("Add sensor") { showingClaim = true }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            List {
                if let error = model.error {
                    Section {
                        ErrorBanner(message: error) {
                            Task { await model.load() }
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    }
                }
                Section {
                    FleetSummary(needingAttention: model.needingAttention.count,
                                 total: model.devices.count)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

                ForEach(model.ordered) { device in
                    NavigationLink(value: device.id) {
                        DeviceCard(device: device)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationDestination(for: String.self) { id in
                DeviceDetailView(deviceId: id)
            }
            .refreshable { await model.load() }
        }
    }
}

/// One line at the top of the list answering the only question someone opens
/// this app to ask: is anything wrong right now?
private struct FleetSummary: View {
    let needingAttention: Int
    let total: Int

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: needingAttention == 0
                  ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(needingAttention == 0 ? Color.green : Color.orange)
            Text(message)
                .font(.subheadline)
            Spacer()
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private var message: String {
        switch needingAttention {
        case 0: total == 1 ? "Your sensor is fine." : "All \(total) sensors are fine."
        case 1: "1 sensor needs attention."
        default: "\(needingAttention) sensors need attention."
        }
    }
}

struct DeviceCard: View {
    let device: DeviceSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(device.name).font(.headline)
                    if let location = device.location, !location.isEmpty {
                        Text(location).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                RiskBadge(score: device.risk?.score, level: device.risk?.level, compact: true)
            }

            ReadingRow(reading: device.latestReading, showDewPoint: false)

            OnlineDot(online: device.online, lastSeenAt: device.lastSeenAt)
        }
        .padding(.vertical, 4)
    }
}
