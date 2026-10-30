import Foundation

/// Every route the app uses, in one place, so a path or a parameter name appears
/// exactly once in the codebase.
struct Endpoint {
    enum Method: String {
        case get = "GET", post = "POST", patch = "PATCH", put = "PUT", delete = "DELETE"
    }

    var method: Method = .get
    var path: String
    var query: [URLQueryItem] = []
    var body: Data?

    func urlRequest(baseURL: URL, token: String?) -> URLRequest {
        var components = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        )!
        if !query.isEmpty { components.queryItems = query }

        var request = URLRequest(url: components.url!)
        request.httpMethod = method.rawValue
        request.httpBody = body
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private static func json(_ value: some Encodable) -> Data {
        // The bodies here are small, fixed shapes built by this app; an encoding
        // failure would be a programming error, not a runtime condition.
        try! JSONCoding.encoder.encode(value)
    }

    // MARK: - Auth

    static func register(email: String, password: String, displayName: String?) -> Endpoint {
        struct Body: Encodable {
            let email: String, password: String
            let display_name: String?
        }
        return Endpoint(method: .post, path: "auth/register",
                        body: json(Body(email: email, password: password,
                                        display_name: displayName)))
    }

    static func login(email: String, password: String) -> Endpoint {
        struct Body: Encodable { let email: String, password: String }
        return Endpoint(method: .post, path: "auth/login",
                        body: json(Body(email: email, password: password)))
    }

    static func refresh(_ refreshToken: String) -> Endpoint {
        struct Body: Encodable { let refresh_token: String }
        return Endpoint(method: .post, path: "auth/refresh",
                        body: json(Body(refresh_token: refreshToken)))
    }

    static func logout(_ refreshToken: String) -> Endpoint {
        struct Body: Encodable { let refresh_token: String }
        return Endpoint(method: .post, path: "auth/logout",
                        body: json(Body(refresh_token: refreshToken)))
    }

    static let me = Endpoint(path: "me")

    static func updateMe(displayName: String? = nil,
                         theme: String? = nil,
                         password: String? = nil,
                         currentPassword: String? = nil) -> Endpoint {
        struct Body: Encodable {
            let display_name: String?
            let theme: String?
            let password: String?
            let current_password: String?
        }
        return Endpoint(method: .patch, path: "me",
                        body: json(Body(display_name: displayName, theme: theme,
                                        password: password, current_password: currentPassword)))
    }

    // MARK: - Devices

    static let devices = Endpoint(path: "devices")

    static func device(_ id: String) -> Endpoint {
        Endpoint(path: "devices/\(id)")
    }

    static func claimDevice(id: String, key: String, name: String,
                            location: String?, material: SurfaceMaterial) -> Endpoint {
        struct Body: Encodable {
            let device_id: String, device_key: String, name: String
            let location: String?
            let surface_material: String
        }
        return Endpoint(method: .post, path: "devices/claim",
                        body: json(Body(device_id: id, device_key: key, name: name,
                                        location: location, surface_material: material.rawValue)))
    }

    static func updateDevice(_ id: String, name: String?, location: String?,
                             material: SurfaceMaterial?) -> Endpoint {
        struct Body: Encodable {
            let name: String?
            let location: String?
            let surface_material: String?
        }
        return Endpoint(method: .patch, path: "devices/\(id)",
                        body: json(Body(name: name, location: location,
                                        surface_material: material?.rawValue)))
    }

    static func deleteDevice(_ id: String) -> Endpoint {
        Endpoint(method: .delete, path: "devices/\(id)")
    }

    // MARK: - Readings and risk

    static func readings(_ id: String, from: Date?, to: Date?,
                         bucket: Bucket = .auto, limit: Int? = nil) -> Endpoint {
        var query: [URLQueryItem] = [.init(name: "bucket", value: bucket.rawValue)]
        if let from { query.append(.init(name: "from", value: JSONCoding.string(from: from))) }
        if let to { query.append(.init(name: "to", value: JSONCoding.string(from: to))) }
        if let limit { query.append(.init(name: "limit", value: String(limit))) }
        return Endpoint(path: "devices/\(id)/readings", query: query)
    }

    static func latest(_ id: String) -> Endpoint {
        Endpoint(path: "devices/\(id)/latest")
    }

    static func risk(_ id: String) -> Endpoint {
        Endpoint(path: "devices/\(id)/risk")
    }

    static func riskHistory(_ id: String, from: Date?, to: Date?, bucket: String = "1h") -> Endpoint {
        var query: [URLQueryItem] = [.init(name: "bucket", value: bucket)]
        if let from { query.append(.init(name: "from", value: JSONCoding.string(from: from))) }
        if let to { query.append(.init(name: "to", value: JSONCoding.string(from: to))) }
        return Endpoint(path: "devices/\(id)/risk/history", query: query)
    }

    // MARK: - Alerts and notifications

    static func alerts(deviceId: String? = nil, limit: Int? = nil, cursor: String? = nil) -> Endpoint {
        var query: [URLQueryItem] = []
        if let deviceId { query.append(.init(name: "device_id", value: deviceId)) }
        if let limit { query.append(.init(name: "limit", value: String(limit))) }
        if let cursor { query.append(.init(name: "cursor", value: cursor)) }
        return Endpoint(path: "alerts", query: query)
    }

    static func acknowledgeAlert(_ id: String) -> Endpoint {
        Endpoint(method: .post, path: "alerts/\(id)/acknowledge")
    }

    static let preferences = Endpoint(path: "notifications/preferences")

    /// A full replacement: the server requires every field, so this takes the
    /// whole object rather than a patch of it.
    static func savePreferences(_ prefs: Preferences) -> Endpoint {
        Endpoint(method: .put, path: "notifications/preferences", body: json(prefs))
    }

    static func registerPushToken(_ token: String, platform: String = "ios",
                                  appVersion: String?) -> Endpoint {
        struct Body: Encodable {
            let token: String, platform: String
            let app_version: String?
        }
        return Endpoint(method: .post, path: "push/tokens",
                        body: json(Body(token: token, platform: platform, app_version: appVersion)))
    }

    /// Run on sign-out, so a phone stops hearing about an account it left.
    static func deletePushToken(_ token: String) -> Endpoint {
        Endpoint(method: .delete, path: "push/tokens/\(token)")
    }
}
