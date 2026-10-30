import Foundation

struct User: Codable, Identifiable, Hashable {
    let id: String
    let email: String
    let displayName: String
    let isAdmin: Bool
    let theme: String?
    /// Only `GET /me` returns this; the register and login payloads omit it.
    let deviceCount: Int?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, email, theme
        case displayName = "display_name"
        case isAdmin = "is_admin"
        case deviceCount = "device_count"
        case createdAt = "created_at"
    }
}

/// What register and login return.
struct TokenBundle: Codable {
    let user: User
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int

    enum CodingKeys: String, CodingKey {
        case user
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
    }
}

/// What refresh returns -- deliberately no `user`, since nothing about the
/// account changed. Kept as its own type so that absence is a compile-time fact
/// rather than an optional nobody remembers to check.
struct RefreshedSession: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
    }
}
