import Foundation
import Observation

/// Who is signed in, and the single `APIClient` every screen shares.
///
/// Sharing one client matters: it is the thing that serialises token refresh,
/// and two clients would mean two refreshes racing -- which the server treats as
/// a stolen token and answers by revoking the account's sessions.
@MainActor
@Observable
final class SessionStore {
    enum State {
        /// Before we know: there may be a refresh token on disk worth trying.
        case restoring
        case signedOut
        case signedIn(User)
    }

    private(set) var state: State = .restoring
    private(set) var expiryNotice: String?

    let api: APIClient

    init(api: APIClient = APIClient()) {
        self.api = api
    }

    var user: User? {
        if case let .signedIn(user) = state { return user }
        return nil
    }

    /// Called once at launch. A stored refresh token is worth a try; anything
    /// that goes wrong simply means signing in again.
    func restore() async {
        await api.setSessionExpiredHandler { [weak self] in
            Task { @MainActor in self?.sessionDidExpire() }
        }

        #if DEBUG
        // Debug builds only: `-demoEmail x -demoPassword y` as launch arguments
        // signs straight in, so a screen can be reached without retyping
        // credentials every rebuild. UserDefaults parses `-key value` arguments
        // for us, so there is nothing to hand-roll.
        //
        //   xcrun simctl launch booted dev.flood.app \
        //     -demoEmail demo@flood.local -demoPassword demo-password-123
        //
        // Compiled out of release builds entirely.
        if let email = UserDefaults.standard.string(forKey: "demoEmail"),
           let password = UserDefaults.standard.string(forKey: "demoPassword") {
            do {
                try await signIn(email: email, password: password)
                return
            } catch {
                state = .signedOut
                expiryNotice = "Demo sign-in failed: \(error.localizedDescription)"
                return
            }
        }
        #endif

        guard await api.hasStoredSession else {
            state = .signedOut
            return
        }
        do {
            let user: User = try await api.authorized(.me)
            state = .signedIn(user)
        } catch {
            await api.signOutLocally()
            state = .signedOut
        }
    }

    func signIn(email: String, password: String) async throws {
        let bundle: TokenBundle = try await api.anonymous(.login(email: email, password: password))
        await api.adopt(bundle)
        expiryNotice = nil
        state = .signedIn(bundle.user)
    }

    func register(email: String, password: String, displayName: String?) async throws {
        let bundle: TokenBundle = try await api.anonymous(
            .register(email: email, password: password, displayName: displayName)
        )
        await api.adopt(bundle)
        expiryNotice = nil
        state = .signedIn(bundle.user)
    }

    func signOut() async {
        // Best effort: tell the server to revoke this refresh token, but sign
        // out locally whatever happens. A user tapping "sign out" while offline
        // must still end up signed out.
        await api.signOutLocally()
        state = .signedOut
    }

    /// Mirror the appearance choice onto the account.
    ///
    /// Best effort by design: the theme is already applied locally, so a failed
    /// round trip costs nothing the reader can see. "Automatic" has nothing to
    /// send, since the server's theme has no such value.
    func updateTheme(_ theme: String?) async {
        guard case .signedIn = state, let theme else { return }
        if let user: User = try? await api.authorized(.updateMe(theme: theme)) {
            state = .signedIn(user)
        }
    }

    func refreshUser() async {
        guard case .signedIn = state else { return }
        if let user: User = try? await api.authorized(.me) {
            state = .signedIn(user)
        }
    }

    private func sessionDidExpire() {
        expiryNotice = "Your session expired. Please sign in again."
        state = .signedOut
    }
}
