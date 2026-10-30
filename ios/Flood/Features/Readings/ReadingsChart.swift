import SwiftUI
import Charts

/// Humidity and temperature are plotted as **two charts, never one with two
/// y-axes**. A dual-scale chart lets the author decide where the lines appear to
/// cross, which is a statement the data never made.
struct ReadingsChart: View {
    let page: ReadingsPage
    /// This material's humidity threshold, drawn as a reference line: the number
    /// that decides whether conditions count as favorable for growth.
    let thresholdPct: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if page.points.isEmpty {
                ContentUnavailableView("No readings in this range",
                                       systemImage: "chart.xyaxis.line")
                    .frame(height: 160)
            } else {
                humidity
                temperature
                if page.truncated {
                    Label("Showing the most recent points only.", systemImage: "scissors")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - Humidity

    /// One series, so no legend: the title names it.
    private var humidity: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Humidity").font(.headline)
            Text("% relative humidity").font(.caption2).foregroundStyle(.secondary)

            Chart {
                // The spread inside each bucket, where the server gave us one.
                // For mold the peaks are the interesting part, and a mean alone
                // hides exactly the spikes this product exists to notice.
                ForEach(page.points) { point in
                    if let low = point.humidityMin, let high = point.humidityMax {
                        AreaMark(
                            x: .value("Time", point.t),
                            yStart: .value("Lowest", low),
                            yEnd: .value("Highest", high)
                        )
                        .foregroundStyle(ChartPalette.series1.opacity(0.16))
                    }
                }

                ForEach(page.points) { point in
                    LineMark(
                        x: .value("Time", point.t),
                        y: .value("Humidity", point.humidityPct)
                    )
                    .lineStyle(StrokeStyle(lineWidth: 2))
                    .foregroundStyle(ChartPalette.series1)
                    .interpolationMethod(.monotone)
                }

                RuleMark(y: .value("Threshold", thresholdPct))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .foregroundStyle(ChartPalette.axis)
                    .annotation(position: .top, alignment: .trailing) {
                        // Trailing, because leading collides with the y-axis
                        // labels the rule runs straight through.
                        Text("\(thresholdPct)% threshold")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
            }
            .chartYScale(domain: humidityDomain)
            .chartYAxis { axisMarks(unit: "%") }
            .chartXAxis { dateAxis }
            .frame(height: 180)
        }
    }

    /// The chart plots whatever unit the reader chose. Everything on the wire
    /// is Celsius, so the conversion happens here, at the point of drawing, and
    /// the axis and the domain go through the same function as the marks.
    private func plotted(_ celsius: Double) -> Double {
        Format.temperatureUnit.from(celsius: celsius)
    }

    /// Neither scale has a meaningful zero, so the axis fits the data instead of
    /// anchoring at 0 and spending half the plot on empty space.
    private var temperatureDomain: ClosedRange<Double> {
        let values = page.points
            .flatMap { [$0.temperatureC, $0.dewPointC].compactMap { $0 } }
            .map(plotted)
        let low = values.min() ?? 10
        let high = values.max() ?? 25
        let pad = max(1, (high - low) * 0.15)
        return (low - pad)...(high + pad)
    }

    /// Always include the threshold, so the line's position relative to it is
    /// visible even on a run of very dry readings.
    private var humidityDomain: ClosedRange<Double> {
        let values = page.points.flatMap { [$0.humidityPct, $0.humidityMin, $0.humidityMax].compactMap { $0 } }
        let low = min(values.min() ?? 30, Double(thresholdPct))
        let high = max(values.max() ?? 80, Double(thresholdPct))
        let pad = max(2, (high - low) * 0.1)
        return (low - pad)...(high + pad)
    }

    // MARK: - Temperature

    /// Two series, so a legend is present *and* both lines are directly labeled:
    /// slot 2 sits below 3:1 on the light surface, so identity cannot rest on
    /// color alone.
    private var temperature: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Temperature and dew point").font(.headline)
            Text("\(Format.temperatureUnit.suffix). Condensation forms where these meet")
                .font(.caption2).foregroundStyle(.secondary)

            Chart {
                ForEach(page.points) { point in
                    LineMark(
                        x: .value("Time", point.t),
                        y: .value("Temperature", plotted(point.temperatureC)),
                        series: .value("Series", "Temperature")
                    )
                    .lineStyle(StrokeStyle(lineWidth: 2))
                    .foregroundStyle(by: .value("Series", "Temperature"))
                    .interpolationMethod(.monotone)
                }

                ForEach(page.points) { point in
                    if let dew = point.dewPointC {
                        LineMark(
                            x: .value("Time", point.t),
                            y: .value("Temperature", plotted(dew)),
                            series: .value("Series", "Dew point")
                        )
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .foregroundStyle(by: .value("Series", "Dew point"))
                        .interpolationMethod(.monotone)
                    }
                }
            }
            .chartForegroundStyleScale([
                "Temperature": ChartPalette.series1,
                "Dew point": ChartPalette.series2,
            ])
            // The chips below are the legend, and they carry the current value
            // too. The built-in one would repeat them a row earlier.
            .chartLegend(.hidden)
            .chartYScale(domain: temperatureDomain)
            .chartYAxis { axisMarks(unit: "°") }
            .chartXAxis { dateAxis }
            .frame(height: 180)

            directLabels
        }
    }

    /// Legend and direct label in one row: a swatch for identity, the series
    /// name in ink, and its latest value. This is also the relief the light-mode
    /// contrast warning requires -- neither series is identified by hue alone.
    private var directLabels: some View {
        HStack(spacing: 16) {
            if let last = page.points.last {
                labelChip(ChartPalette.series1, "Temperature", Format.temperature(last.temperatureC))
                if let dew = last.dewPointC {
                    labelChip(ChartPalette.series2, "Dew point", Format.dewPoint(dew))
                }
            }
        }
    }

    private func labelChip(_ color: Color, _ name: String, _ value: String) -> some View {
        HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 10, height: 3)
            // Text stays in ink, never the series color.
            Text("\(name) \(value)")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    // MARK: - Axes

    private func axisMarks(unit: String) -> some AxisContent {
        AxisMarks(position: .leading) { value in
            AxisGridLine().foregroundStyle(ChartPalette.grid)
            AxisValueLabel {
                if let number = value.as(Double.self) {
                    Text("\(Int(number))\(unit)")
                        .font(.caption2)
                        .foregroundStyle(ChartPalette.axis)
                }
            }
        }
    }

    /// Four marks, and a format chosen for the span on screen. The default
    /// ("Sep 18 at 9 PM") is wide enough that the labels butt into each other
    /// with no gap between them.
    private var dateAxis: some AxisContent {
        AxisMarks(preset: .aligned, values: .automatic(desiredCount: 4)) { value in
            AxisGridLine().foregroundStyle(ChartPalette.grid)
            AxisValueLabel {
                if let date = value.as(Date.self) {
                    Text(date, format: isShortSpan
                         ? .dateTime.hour()
                         : .dateTime.month(.abbreviated).day())
                        .font(.caption2)
                        .foregroundStyle(ChartPalette.axis)
                }
            }
        }
    }

    /// Under two days, the day is the same on most labels and only the hour
    /// carries information.
    private var isShortSpan: Bool {
        page.to.timeIntervalSince(page.from) <= 48 * 3600
    }
}
