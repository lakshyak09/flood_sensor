import Foundation
@testable import Flood

/// A stand-in server. Hands back canned responses and records what was asked,
/// so a test can assert on how many times the client refreshed as well as on
/// what it decoded.
actor MockTransport: HTTPTransport {
    struct Response {
        let status: Int
        let body: Data

        static func ok(_ json: String) -> Response {
            Response(status: 200, body: Data(json.utf8))
        }
        static func error(_ status: Int, code: String, message: String = "nope") -> Response {
            Response(status: status,
                     body: Data(#"{"error":{"code":"\#(code)","message":"\#(message)"}}"#.utf8))
        }
    }

    /// Keyed by path suffix, so a test says "auth/refresh" rather than a URL.
    /// The handler sees the request itself, so a stub can answer the way the
    /// real server does -- by the credential presented -- rather than by
    /// counting calls.
    private var handlers: [String: @Sendable (URLRequest, Int) -> Response] = [:]
    private(set) var callCounts: [String: Int] = [:]
    private(set) var authorizationHeaders: [String: [String?]] = [:]

    func stub(_ path: String, with handler: @escaping @Sendable (URLRequest, Int) -> Response) {
        handlers[path] = handler
    }

    func stub(_ path: String, response: Response) {
        handlers[path] = { _, _ in response }
    }

    /// The common case: this bearer token works, anything else is expired.
    func stubRequiringToken(_ path: String, token: String, body: String) {
        handlers[path] = { request, _ in
            request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)"
                ? .ok(body)
                : .error(401, code: "invalid_token")
        }
    }

    func callCount(_ path: String) -> Int { callCounts[path] ?? 0 }

    func headers(_ path: String) -> [String?] { authorizationHeaders[path] ?? [] }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let url = request.url!
        guard let key = handlers.keys.first(where: { url.path.hasSuffix($0) }),
              let handler = handlers[key] else {
            fatalError("No stub for \(url.path)")
        }

        let priorCalls = callCounts[key] ?? 0
        callCounts[key] = priorCalls + 1
        authorizationHeaders[key, default: []]
            .append(request.value(forHTTPHeaderField: "Authorization"))

        // A little latency, so concurrent callers genuinely overlap and the
        // single-flight refresh is actually exercised rather than accidentally
        // serialised by an instant return.
        try await Task.sleep(nanoseconds: 10_000_000)

        let response = handler(request, priorCalls)
        let http = HTTPURLResponse(url: url, statusCode: response.status,
                                   httpVersion: nil, headerFields: nil)!
        return (response.body, http)
    }
}
