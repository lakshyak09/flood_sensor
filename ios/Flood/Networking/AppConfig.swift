import Foundation

/// Where the server is.
///
/// Overridable at runtime so the address can move -- to a LAN IP when this runs
/// on a real phone, or to a deployed host -- without a rebuild. The simulator
/// shares the Mac's network stack, so the loopback default just works there.
enum AppConfig {
    static let baseURLDefaultsKey = "FloodBaseURL"

    static var baseURL: URL {
        if let override = UserDefaults.standard.string(forKey: baseURLDefaultsKey),
           let url = URL(string: override) {
            return url
        }
        return URL(string: "http://127.0.0.1:3000/api/v1")!
    }

    static func setBaseURL(_ string: String?) {
        if let string, !string.isEmpty {
            UserDefaults.standard.set(string, forKey: baseURLDefaultsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: baseURLDefaultsKey)
        }
    }
}
