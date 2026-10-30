import Foundation

/// The server has exactly one error shape: `{ "error": { "code", "message" } }`.
struct ServerError: Codable, Hashable {
    struct Payload: Codable, Hashable {
        let code: String
        let message: String
    }
    let error: Payload
}

enum APIError: Error, LocalizedError {
    /// A structured error the server produced, with its HTTP status.
    case server(status: Int, code: String, message: String)
    /// A non-2xx with a body we could not parse as the documented shape. Worth
    /// keeping distinct: it means the server did something it is not documented
    /// to do, which is a different bug from an ordinary rejection.
    case unexpectedStatus(Int)
    case transport(Error)
    case decoding(Error)
    /// The refresh token was rejected. The session is over and cannot be saved.
    case sessionExpired

    var errorDescription: String? {
        switch self {
        case let .server(_, _, message): message
        case let .unexpectedStatus(status): "The server returned an unexpected response (\(status))."
        case .transport: "Could not reach the server. Check that it is running and that the address is right."
        case .decoding: "The server's response could not be read. The app and server may be different versions."
        case .sessionExpired: "Your session has expired. Please sign in again."
        }
    }

    var code: String? {
        if case let .server(_, code, _) = self { return code }
        return nil
    }

    var status: Int? {
        switch self {
        case let .server(status, _, _): status
        case let .unexpectedStatus(status): status
        default: nil
        }
    }

    /// An access token that expired or went bad -- the one case worth retrying
    /// after a refresh. `invalid_refresh_token` is deliberately not here: that
    /// one ends the session.
    var isExpiredAccessToken: Bool {
        status == 401 && (code == "invalid_token" || code == "unauthorized")
    }
}
