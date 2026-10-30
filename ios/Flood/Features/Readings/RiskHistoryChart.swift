import SwiftUI
import Charts

/// Score over time.
///
/// The bands are drawn behind the line in the status palette, so "am I in the
/// red" is answerable at a glance -- but each band is also labeled, because a
/// status color never carries meaning on its own. The line itself stays a single
/// series color: recoloring it segment by segment would imply the score changed
/// kind, when only its band did.
struct RiskHistoryChart: View {
    let page: RiskHistoryPage

    private static let bands: [(RiskLevel, Int, Int)] = [
        (.low, 0, 25), (.moderate, 25, 50), (.high, 50, 75), (.critical, 75, 100),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Risk over time").font(.headline)
            Text("score out of 100").font(.caption2).foregroundStyle(.secondary)

            Chart {
                ForEach(Self.bands, id: \.0) { level, low, high in
                    RectangleMark(
                        xStart: .value("From", page.from),
                        xEnd: .value("To", page.to),
                        yStart: .value("Low", low),
                        yEnd: .value("High", high)
                    )
                    .foregroundStyle(ChartPalette.status(level).opacity(0.10))
                }

                ForEach(page.points) { point in
                    LineMark(
                        x: .value("Time", point.t),
                        y: .value("Score", point.score)
                    )
                    .lineStyle(StrokeStyle(lineWidth: 2))
                    .foregroundStyle(ChartPalette.series1)
                    .interpolationMethod(.monotone)
                }

                if let last = page.points.last {
                    PointMark(
                        x: .value("Time", last.t),
                        y: .value("Score", last.score)
                    )
                    .symbolSize(80)
                    .foregroundStyle(ChartPalette.series1)
                    .annotation(position: .top) {
                        Text("\(last.score)")
                            .font(.caption2.bold())
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .chartYScale(domain: 0...100)
            .chartYAxis {
                AxisMarks(position: .leading, values: [0, 25, 50, 75, 100]) { value in
                    AxisGridLine().foregroundStyle(ChartPalette.grid)
                    AxisValueLabel {
                        if let score = value.as(Int.self) {
                            Text("\(score)").font(.caption2).foregroundStyle(ChartPalette.axis)
                        }
                    }
                }
            }
            .chartXAxis {
                AxisMarks(preset: .aligned) { value in
                    AxisGridLine().foregroundStyle(ChartPalette.grid)
                    AxisValueLabel {
                        if let date = value.as(Date.self) {
                            Text(date, format: .dateTime.month(.abbreviated).day())
                                .font(.caption2).foregroundStyle(ChartPalette.axis)
                        }
                    }
                }
            }
            .frame(height: 180)

            bandLegend
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    /// Icon plus word for every band -- the mitigation that lets the status
    /// colors be used at all.
    private var bandLegend: some View {
        HStack(spacing: 12) {
            ForEach(Self.bands, id: \.0) { level, _, _ in
                HStack(spacing: 4) {
                    Image(systemName: level.symbol)
                        .font(.system(size: 8))
                        .foregroundStyle(ChartPalette.status(level))
                    Text(level.label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
