import SwiftUI
import Observation
import Combine   // Timer.publish(...).autoconnect()

@MainActor
@Observable
final class DeviceDetailModel {
    var detail: DeviceDetail?
    var risk: RiskDetail?
    var readings: ReadingsPage?
    var riskHistory: RiskHistoryPage?
    var error: String?
    var range: HistoryRange = .day

    enum HistoryRange: String, CaseIterable, Identifiable {
        case day = "24h", week = "7d", month = "30d"
        var id: String { rawValue }

        var hours: Double {
            switch self {
            case .day: 24
            case .week: 168
            case .month: 720
            }
        }

        /// The risk route only offers hourly and daily buckets.
        var riskBucket: String { self == .day ? "1h" : "1d" }
    }

    private let api: APIClient
    let deviceId: String

    init(api: APIClient, deviceId: String) {
        self.api = api
        self.deviceId = deviceId
    }

    func load() async {
        let from = Date().addingTimeInterval(-range.hours * 3600)
        do {
            // Four independent reads; no reason to make them wait on each other.
            async let detail: DeviceDetail = api.authorized(.device(deviceId))
            async let risk: RiskDetail = api.authorized(.risk(deviceId))
            async let readings: ReadingsPage = api.authorized(
                .readings(deviceId, from: from, to: nil, bucket: .auto)
            )
            async let history: RiskHistoryPage = api.authorized(
                .riskHistory(deviceId, from: from, to: nil, bucket: range.riskBucket)
            )

            self.detail = try await detail
            self.risk = try await risk
            self.readings = try await readings
            self.riskHistory = try await history
            self.error = nil
        } catch let err as APIError {
            if case .sessionExpired = err {} else { error = err.errorDescription }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct DeviceDetailView: View {
    let deviceId: String

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model: DeviceDetailModel?
    @State private var showingEdit = false

    /// Readings keep arriving while this screen is open, and a chart that only
    /// moves when you pull it down reads as a broken chart. Same interval as the
    /// sensor list, so the two screens never disagree about how old the data is.
    private let poll = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if let model, let detail = model.detail {
                ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if let error = model.error {
                            ErrorBanner(message: error) { Task { await model.load() } }
                        }

                        RiskHeader(risk: model.risk, detail: detail)
                        NowCard(detail: detail)

                        if let risk = model.risk, risk.isScored, let factors = risk.factors {
                            FactorBreakdown(factors: factors, score: risk.score ?? 0,
                                            windowHours: risk.windowHours)
                        }

                        RangePicker(range: Binding(
                            get: { model.range },
                            set: { model.range = $0; Task { await model.load() } }
                        ))

                        if let readings = model.readings {
                            ReadingsChart(page: readings,
                                          thresholdPct: detail.surfaceMaterial.thresholdPct)
                                .id("charts")
                        }
                        if let history = model.riskHistory, !history.points.isEmpty {
                            RiskHistoryChart(page: history)
                        }

                        DeviceFacts(detail: detail)
                    }
                    .padding()
                }
                .refreshable { await model.load() }
                .onAppear {
                    #if DEBUG
                    // Debug builds only: `-demoScrollTo charts` opens with the
                    // charts in view, so iterating on them does not mean
                    // scrolling past the header on every rebuild.
                    if UserDefaults.standard.string(forKey: "demoScrollTo") == "charts" {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                            withAnimation { proxy.scrollTo("charts", anchor: .top) }
                        }
                    }
                    #endif
                }
                }
                .navigationTitle(detail.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Edit", systemImage: "slider.horizontal.3") { showingEdit = true }
                    }
                }
                .sheet(isPresented: $showingEdit) {
                    DeviceEditView(detail: detail,
                                   onSaved: { await model.load() },
                                   onDeleted: { dismiss() })
                }
            } else {
                ProgressView()
            }
        }
        .task {
            if model == nil { model = DeviceDetailModel(api: session.api, deviceId: deviceId) }
            await model?.load()
        }
        .onReceive(poll) { _ in
            // Not while the edit sheet is up: reloading underneath it would
            // swap the values the form was opened with.
            guard !showingEdit else { return }
            Task { await model?.load() }
        }
    }
}

private struct RiskHeader: View {
    let risk: RiskDetail?
    let detail: DeviceDetail

    @State private var showingHelp = false

    var body: some View {
        let level = risk?.level ?? .unknown
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                if let score = risk?.score {
                    Text("\(score)")
                        .font(.system(size: 52, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(level.tint)
                    Text("/ 100").font(.title3).foregroundStyle(.secondary)
                }
                Spacer()
                RiskBadge(score: risk?.score, level: risk?.level)
                // A number out of a hundred invites exactly one question, and
                // the answer should be a tap away from the number itself.
                Button {
                    showingHelp = true
                } label: {
                    Image(systemName: "questionmark.circle")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("What this score means")
            }

            if let recommendation = risk?.recommendation {
                Text(recommendation).font(.subheadline)
            } else {
                // Not a failure and not a zero: the server cannot speak for this
                // device yet, and saying so is more honest than showing 0.
                Text("Not enough history to score this sensor yet. "
                     + "It needs at least six readings in the last seven days.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(level.wash, in: RoundedRectangle(cornerRadius: 14))
        .sheet(isPresented: $showingHelp) { HelpView() }
    }
}

private struct NowCard: View {
    let detail: DeviceDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Right now").font(.headline)
            ReadingRow(reading: detail.latestReading)
            if let reading = detail.latestReading {
                Text("Measured \(Format.relative(reading.recordedAt))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            OnlineDot(online: detail.online, lastSeenAt: detail.lastSeenAt)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

/// The "why" behind the score. The server guarantees the contributions sum to
/// the score exactly, which is what lets this draw an honest stacked bar.
private struct FactorBreakdown: View {
    let factors: [RiskFactor]
    let score: Int
    let windowHours: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Why").font(.headline)
                Spacer()
                if let windowHours {
                    Text("over \(windowHours / 24) days")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            GeometryReader { geo in
                HStack(spacing: 2) {
                    ForEach(Array(factors.enumerated()), id: \.element.id) { index, factor in
                        RoundedRectangle(cornerRadius: 3)
                            .fill(shade(index))
                            .frame(width: max(0, geo.size.width * CGFloat(factor.contribution) / 100.0))
                    }
                    if score < 100 {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Color(.tertiarySystemFill))
                    }
                }
            }
            .frame(height: 10)

            ForEach(Array(factors.enumerated()), id: \.element.id) { index, factor in
                HStack(alignment: .top, spacing: 10) {
                    Circle().fill(shade(index)).frame(width: 9, height: 9).padding(.top, 5)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(factor.label).font(.subheadline.weight(.medium))
                            Spacer()
                            Text("+\(factor.contribution)")
                                .font(.subheadline.bold()).monospacedDigit()
                        }
                        Text(factor.readableDetail).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    /// Categorical slots in fixed order, never cycled and never invented: the
    /// three factors are a fixed set, so slot 1 is always "current humidity".
    private func shade(_ index: Int) -> Color {
        ChartPalette.series[index % ChartPalette.series.count]
    }
}

private struct RangePicker: View {
    @Binding var range: DeviceDetailModel.HistoryRange

    var body: some View {
        Picker("Range", selection: $range) {
            ForEach(DeviceDetailModel.HistoryRange.allCases) { r in
                Text(r.rawValue).tag(r)
            }
        }
        .pickerStyle(.segmented)
    }
}

private struct DeviceFacts: View {
    let detail: DeviceDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Sensor").font(.headline)
            fact("Surface", detail.surfaceMaterial.label)
            fact("Readings stored", detail.readingCount.formatted())
            if let first = detail.firstReadingAt {
                fact("First reading", Format.absolute(first))
            }
            fact("Firmware", detail.firmwareVersion ?? "Unknown")
            fact("Added", Format.absolute(detail.createdAt))
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
        }
        .font(.subheadline)
    }
}
