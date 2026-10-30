import SwiftUI

/// Chart colors.
///
/// Dark mode is *selected*, not an automatic flip: each slot names its own step
/// for the dark surface. Both modes were validated against the card surfaces
/// these charts actually render on (light `#f2f2f7`, dark `#1c1c1e`) rather than
/// against a white page that does not exist in this app.
enum ChartPalette {
    /// Categorical slot 1. The primary series in any chart.
    static let series1 = dynamic(light: 0x2a78d6, dark: 0x3987e5)
    /// Categorical slot 2.
    ///
    /// On the light surface this sits at 2.87:1, below the 3:1 bar, so every
    /// chart that uses it carries a legend *and* direct labels -- identity never
    /// rests on the hue alone.
    static let series2 = dynamic(light: 0xeb6834, dark: 0xd95926)
    /// Categorical slot 3. Like slot 2 it is sub-3:1 on the light surface, so it
    /// only appears where every segment is labeled anyway.
    static let series3 = dynamic(light: 0x1baf7a, dark: 0x199e70)

    /// The first three slots in order. Validated as a set for all pairs in both
    /// modes, which is what a stacked bar needs -- every segment sits beside
    /// every other one, not just its neighbours.
    static let series: [Color] = [series1, series2, series3]

    static let grid = dynamic(light: 0xe1e0d9, dark: 0x2c2c2a)
    static let axis = dynamic(light: 0x898781, dark: 0x898781)

    /// Status, fixed in both modes. These are reserved for risk level and are
    /// never reused as a series color.
    static func status(_ level: RiskLevel) -> Color {
        switch level {
        case .low: dynamic(light: 0x0ca30c, dark: 0x0ca30c)
        case .moderate: dynamic(light: 0xfab219, dark: 0xfab219)
        case .high: dynamic(light: 0xec835a, dark: 0xec835a)
        case .critical: dynamic(light: 0xd03b3b, dark: 0xd03b3b)
        case .unknown: dynamic(light: 0x898781, dark: 0x898781)
        }
    }

    private static func dynamic(light: Int, dark: Int) -> Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
        })
    }
}

private extension UIColor {
    convenience init(hex: Int) {
        self.init(
            red: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: 1
        )
    }
}
