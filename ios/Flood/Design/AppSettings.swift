import SwiftUI
import Observation

/// Choices that belong to the phone rather than to the account.
///
/// Appearance and units are read on every screen and changed on one, so they
/// live in a single observable object handed down through the environment.
/// They persist locally because they describe how this person wants to *read*
/// the data -- unlike notification preferences, which describe what the server
/// should do and therefore live on the server.
///
/// Appearance is the exception that goes both ways: the account carries a
/// `theme`, so a deliberate choice here is mirrored to the server and a fresh
/// install adopts whatever the account already said.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "Automatic"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var symbol: String {
        switch self {
        case .system: "iphone"
        case .light: "sun.max"
        case .dark: "moon"
        }
    }

    /// `nil` hands the decision back to iOS, which is what "Automatic" means.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// The server's `theme` only knows light and dark, so "Automatic" has
    /// nothing to send: it is a statement about this phone's settings, not
    /// about the account.
    var serverTheme: String? { self == .system ? nil : rawValue }
}

enum TemperatureUnit: String, CaseIterable, Identifiable {
    case celsius, fahrenheit

    var id: String { rawValue }

    var label: String {
        switch self {
        case .celsius: "Celsius"
        case .fahrenheit: "Fahrenheit"
        }
    }

    var suffix: String {
        switch self {
        case .celsius: "°C"
        case .fahrenheit: "°F"
        }
    }

    /// Everything the server stores and every threshold the risk model uses
    /// is Celsius. This converts for display only, at the last moment.
    func from(celsius: Double) -> Double {
        switch self {
        case .celsius: celsius
        case .fahrenheit: celsius * 9 / 5 + 32
        }
    }

    /// A difference, not a point on the scale -- 5 °C of headroom is 9 °F of
    /// headroom, with no 32 in it. Getting this wrong would misstate the dew
    /// point margin, which is the number the whole product turns on.
    func fromDifference(celsius: Double) -> Double {
        switch self {
        case .celsius: celsius
        case .fahrenheit: celsius * 9 / 5
        }
    }

    /// What the phone's own region suggests, used until the reader says
    /// otherwise. Someone in the US should not have to find this setting to
    /// understand their own hallway.
    static var regionDefault: TemperatureUnit {
        Locale.current.measurementSystem == .us ? .fahrenheit : .celsius
    }
}

@MainActor
@Observable
final class AppSettings {

    /// Written through a computed property rather than a `didSet`, so that
    /// persisting is part of the setter and observation has one plain stored
    /// property to track.
    private var storedAppearance: AppAppearance
    private var storedUnit: TemperatureUnit

    var appearance: AppAppearance {
        get { storedAppearance }
        set {
            guard newValue != storedAppearance else { return }
            storedAppearance = newValue
            defaults.set(newValue.rawValue, forKey: Keys.appearance)
            defaults.set(true, forKey: Keys.appearanceChosen)
            appearanceWasChosen = true
        }
    }

    var temperatureUnit: TemperatureUnit {
        get { storedUnit }
        set {
            guard newValue != storedUnit else { return }
            storedUnit = newValue
            defaults.set(newValue.rawValue, forKey: Keys.temperatureUnit)
            Format.temperatureUnit = newValue
        }
    }

    /// Whether this phone has ever been told explicitly. Until it has, the
    /// account's stored theme is allowed to win at sign-in.
    private(set) var appearanceWasChosen: Bool

    private enum Keys {
        static let appearance = "appearance"
        static let appearanceChosen = "appearanceChosen"
        static let temperatureUnit = "temperatureUnit"
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.storedAppearance = defaults.string(forKey: Keys.appearance)
            .flatMap(AppAppearance.init(rawValue:)) ?? .system
        self.appearanceWasChosen = defaults.bool(forKey: Keys.appearanceChosen)
        self.storedUnit = defaults.string(forKey: Keys.temperatureUnit)
            .flatMap(TemperatureUnit.init(rawValue:)) ?? .regionDefault

        Format.temperatureUnit = storedUnit
    }

    /// Take the account's theme, but only if this phone has no opinion of its
    /// own. Signing in on a new device should feel like coming home; signing in
    /// should never overrule a choice made here five minutes ago.
    func adoptAccountTheme(_ theme: String?) {
        guard !appearanceWasChosen,
              let theme, let accountAppearance = AppAppearance(rawValue: theme),
              accountAppearance != storedAppearance else { return }
        storedAppearance = accountAppearance
        defaults.set(accountAppearance.rawValue, forKey: Keys.appearance)
        // Adopting is not choosing: the next account to sign in on this phone
        // should still be able to bring its own theme.
    }
}
