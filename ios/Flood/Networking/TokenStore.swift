import Foundation
import Security

/// Somewhere to keep the refresh token. A protocol so tests can use memory
/// instead of the real Keychain, which is shared machine state and would make
/// them order-dependent.
protocol TokenStoring: Sendable {
    func save(_ token: String)
    func load() -> String?
    func clear()
}

/// Where the refresh token lives.
///
/// The Keychain rather than `UserDefaults`, because a refresh token is valid for
/// thirty days and re-using a stolen one revokes every session on the account --
/// so losing it is not a small thing. The access token is deliberately *not*
/// persisted: it lasts fifteen minutes, and a refresh on launch is cheaper than
/// reasoning about a stale one.
struct TokenStore: TokenStoring {
    private let service = "dev.flood.app"
    private let account = "refresh_token"

    func save(_ token: String) {
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)

        var insert = query
        insert[kSecValueData as String] = data
        // The token is only ever needed while someone is using the app, and it
        // should not survive onto a restored backup on another device.
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(insert as CFDictionary, nil)
    }

    func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}


/// For tests, and for previews that must not touch the Keychain.
final class InMemoryTokenStore: TokenStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?

    init(token: String? = nil) { self.token = token }

    func save(_ token: String) {
        lock.lock(); defer { lock.unlock() }
        self.token = token
    }

    func load() -> String? {
        lock.lock(); defer { lock.unlock() }
        return token
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        token = nil
    }
}
