import SwiftUI
import Observation

@MainActor
@Observable
final class AlertsModel {
    var alerts: [AlertRecord] = []
    var nextCursor: String?
    var error: String?
    var loaded = false
    var loadingMore = false

    private let api: APIClient
    init(api: APIClient) { self.api = api }

    var unacknowledgedCount: Int {
        alerts.filter { !$0.isAcknowledged }.count
    }

    /// Visiting this screen is also what makes the server notice a sensor has
    /// gone quiet -- it sweeps before answering -- so a refresh here can produce
    /// alerts that did not exist a moment ago.
    func load() async {
        do {
            let page: AlertsPage = try await api.authorized(.alerts(limit: 50))
            alerts = page.alerts
            nextCursor = page.nextCursor
            error = nil
        } catch let err as APIError {
            if case .sessionExpired = err {} else { error = err.errorDescription }
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    func loadMore() async {
        guard let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page: AlertsPage = try await api.authorized(.alerts(limit: 50, cursor: cursor))
            alerts.append(contentsOf: page.alerts)
            nextCursor = page.nextCursor
        } catch {
            // A failed page is not worth a banner over the whole list; the row
            // simply stays and can be retried by scrolling again.
        }
    }

    /// Clearing the list in one gesture.
    ///
    /// Someone coming back from a weekend to eleven alerts should not have to
    /// swipe eleven times, and the badge is only useful if it can be put back
    /// to zero. The writes go out together and the list is reloaded once, so a
    /// partial failure is visible rather than silently half-applied.
    func acknowledgeAll() async {
        let pending = alerts.filter { !$0.isAcknowledged }
        guard !pending.isEmpty else { return }
        await withTaskGroup(of: Void.self) { group in
            for alert in pending {
                group.addTask { [api] in
                    try? await api.authorizedVoid(.acknowledgeAlert(alert.id))
                }
            }
        }
        await load()
    }

    func acknowledge(_ alert: AlertRecord) async {
        guard !alert.isAcknowledged else { return }
        // Optimistic: the server is idempotent here and first-write-wins, so the
        // worst case is that the badge clears a moment before the round trip.
        if let index = alerts.firstIndex(where: { $0.id == alert.id }) {
            alerts[index] = AlertRecord(
                id: alert.id, deviceId: alert.deviceId, deviceName: alert.deviceName,
                type: alert.type, firedAt: alert.firedAt, score: alert.score,
                level: alert.level, message: alert.message, notified: alert.notified,
                acknowledgedAt: Date()
            )
        }
        do {
            try await api.authorizedVoid(.acknowledgeAlert(alert.id))
        } catch {
            await load()
        }
    }
}

struct AlertsView: View {
    /// Handed in rather than created here: the tab badge needs the same count
    /// this screen shows, and two models would be two answers.
    let model: AlertsModel

    @Environment(PushManager.self) private var push

    var body: some View {
        NavigationStack {
            content(model)
                .navigationTitle("Alerts")
                .toolbar {
                    if model.unacknowledgedCount > 0 {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Mark all seen") {
                                Haptics.light()
                                Task {
                                    await model.acknowledgeAll()
                                    push.setBadge(model.unacknowledgedCount)
                                }
                            }
                            .font(.subheadline)
                        }
                    }
                }
        }
        .task {
            await model.load()
            push.setBadge(model.unacknowledgedCount)
        }
    }

    @ViewBuilder
    private func content(_ model: AlertsModel) -> some View {
        if !model.loaded {
            ProgressView()
        } else if model.alerts.isEmpty {
            ContentUnavailableView {
                Label("Nothing to report", systemImage: "bell.slash")
            } description: {
                Text("You'll see a record here whenever a sensor crosses into high risk, "
                     + "goes quiet, or starts reporting again.")
            }
        } else {
            List {
                if let error = model.error {
                    ErrorBanner(message: error) { Task { await model.load() } }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

                ForEach(model.alerts) { alert in
                    AlertRow(alert: alert)
                        .swipeActions(edge: .trailing) {
                            if !alert.isAcknowledged {
                                Button("Mark seen") {
                                    Haptics.light()
                                    Task {
                                        await model.acknowledge(alert)
                                        push.setBadge(model.unacknowledgedCount)
                                    }
                                }
                                .tint(.blue)
                            }
                        }
                        .onAppear {
                            if alert.id == model.alerts.last?.id {
                                Task { await model.loadMore() }
                            }
                        }
                }

                if model.nextCursor != nil {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            }
            .listStyle(.plain)
            .refreshable { await model.load() }
        }
    }
}

struct AlertRow: View {
    let alert: AlertRecord

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: alert.type.symbol)
                .foregroundStyle(alert.level.map { ChartPalette.status($0) } ?? .secondary)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 3) {
                Text(alert.message)
                    .font(.subheadline)
                    .fontWeight(alert.isAcknowledged ? .regular : .medium)

                HStack(spacing: 6) {
                    Text(Format.relative(alert.firedAt))
                    if let score = alert.score {
                        Text("· score \(score)").monospacedDigit()
                    }
                    if !alert.notified {
                        // Quiet hours store the alert but keep the phone silent.
                        // Saying so is the point of the field.
                        Text("· silenced")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer()

            if !alert.isAcknowledged {
                Circle().fill(Color.accentColor).frame(width: 8, height: 8)
                    .padding(.top, 6)
            }
        }
        .padding(.vertical, 4)
    }
}
