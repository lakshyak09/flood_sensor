import Foundation

/// Anything that can perform a request. Exists so the tests can hand the client
/// canned responses instead of standing up a server.
protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPTransport {}

/// The one place that talks to the server.
///
/// An `actor` because of one specific problem: the access token lives fifteen
/// minutes, and a screen that fires four requests at once will get four
/// simultaneous 401s. Without serialisation each would refresh independently,
/// and since the server **revokes every session when a spent refresh token is
/// replayed**, three of those four would log the user out. So refresh happens
/// once and the others await it.
actor APIClient {
    private let transport: HTTPTransport
    private let baseURL: URL
    private let tokens: TokenStoring

    private var accessToken: String?
    private var refreshToken: String?

    /// The in-flight refresh, if there is one. This is the single-flight guard.
    private var refreshTask: Task<String, Error>?

    /// Called when the session is beyond saving, so the UI can return to login.
    private var onSessionExpired: (@Sendable () -> Void)?

    init(transport: HTTPTransport = URLSession.shared,
         baseURL: URL = AppConfig.baseURL,
         tokens: TokenStoring = TokenStore()) {
        self.transport = transport
        self.baseURL = baseURL
        self.tokens = tokens
        self.refreshToken = tokens.load()
    }

    func setSessionExpiredHandler(_ handler: @escaping @Sendable () -> Void) {
        onSessionExpired = handler
    }

    var hasStoredSession: Bool { refreshToken != nil }

    // MARK: - Session

    func adopt(_ bundle: TokenBundle) {
        accessToken = bundle.accessToken
        refreshToken = bundle.refreshToken
        tokens.save(bundle.refreshToken)
    }

    func adopt(_ session: RefreshedSession) {
        accessToken = session.accessToken
        refreshToken = session.refreshToken
        tokens.save(session.refreshToken)
    }

    func signOutLocally() {
        accessToken = nil
        refreshToken = nil
        refreshTask = nil
        tokens.clear()
    }

    // MARK: - Requests

    /// A request that needs a signed-in user. Refreshes and retries once if the
    /// access token has expired underneath it.
    func authorized<T: Decodable>(_ endpoint: Endpoint, as type: T.Type = T.self) async throws -> T {
        let data = try await authorizedData(endpoint)
        return try decode(data)
    }

    @discardableResult
    func authorizedVoid(_ endpoint: Endpoint) async throws -> Data {
        try await authorizedData(endpoint)
    }

    /// A request with no credentials -- register, login, refresh.
    func anonymous<T: Decodable>(_ endpoint: Endpoint, as type: T.Type = T.self) async throws -> T {
        let data = try await perform(endpoint.urlRequest(baseURL: baseURL, token: nil))
        return try decode(data)
    }

    private func authorizedData(_ endpoint: Endpoint) async throws -> Data {
        let token = try await validAccessToken()

        do {
            return try await perform(endpoint.urlRequest(baseURL: baseURL, token: token))
        } catch let error as APIError where error.isExpiredAccessToken {
            // One retry, against a token refreshed exactly once across every
            // caller that hit this at the same moment.
            let fresh = try await refreshedAccessToken(replacing: token)
            return try await perform(endpoint.urlRequest(baseURL: baseURL, token: fresh))
        }
    }

    private func validAccessToken() async throws -> String {
        if let accessToken { return accessToken }
        return try await refreshedAccessToken(replacing: nil)
    }

    /// Refresh, but only once at a time.
    ///
    /// `replacing` guards the race where several callers all 401 against the
    /// same dead token: the first one refreshes, and the rest find that the
    /// token has already moved on and simply use the new one.
    private func refreshedAccessToken(replacing stale: String?) async throws -> String {
        if let current = accessToken, current != stale { return current }

        if let refreshTask {
            return try await refreshTask.value
        }

        guard let refreshToken else {
            expireSession()
            throw APIError.sessionExpired
        }

        let task = Task<String, Error> { [baseURL, transport] in
            let request = Endpoint.refresh(refreshToken)
                .urlRequest(baseURL: baseURL, token: nil)
            let data = try await Self.perform(request, using: transport)
            let session = try JSONCoding.decoder.decode(RefreshedSession.self, from: data)
            return await self.acceptRefreshed(session)
        }
        refreshTask = task

        defer { refreshTask = nil }
        do {
            return try await task.value
        } catch {
            // A refresh that fails is not retryable: either the token was spent,
            // in which case the server has just revoked the whole account's
            // sessions, or it expired. Both mean signing in again.
            expireSession()
            throw APIError.sessionExpired
        }
    }

    private func acceptRefreshed(_ session: RefreshedSession) -> String {
        adopt(session)
        return session.accessToken
    }

    private func expireSession() {
        signOutLocally()
        onSessionExpired?()
    }

    // MARK: - Transport

    private func perform(_ request: URLRequest) async throws -> Data {
        try await Self.perform(request, using: transport)
    }

    private static func perform(_ request: URLRequest, using transport: HTTPTransport) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport.data(for: request)
        } catch {
            throw APIError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.unexpectedStatus(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            if let server = try? JSONCoding.decoder.decode(ServerError.self, from: data) {
                throw APIError.server(status: http.statusCode,
                                      code: server.error.code,
                                      message: server.error.message)
            }
            throw APIError.unexpectedStatus(http.statusCode)
        }
        return data
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        // 204 carries no body; a caller asking for a value from one is a bug,
        // but an empty `Data` decoding into `EmptyResponse` is legitimate.
        if data.isEmpty, let empty = EmptyResponse() as? T { return empty }
        do {
            return try JSONCoding.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }
}

/// Stand-in for the body of a 204.
struct EmptyResponse: Decodable {}
