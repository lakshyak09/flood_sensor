import XCTest
@testable import Flood

/// The auth plumbing, which is where the bugs that waste an afternoon live.
final class APIClientTests: XCTestCase {

    private let baseURL = URL(string: "http://test.local/api/v1")!

    private func makeClient(_ transport: MockTransport,
                            storedRefreshToken: String? = "stored-refresh") -> APIClient {
        APIClient(transport: transport,
                  baseURL: baseURL,
                  tokens: InMemoryTokenStore(token: storedRefreshToken))
    }

    private static let meJSON = """
    {"id":"u1","email":"a@b.com","display_name":"A","is_admin":false,
     "theme":"light","device_count":2,"created_at":"2026-09-09T14:00:00.000Z"}
    """

    private static let refreshJSON = """
    {"access_token":"fresh-access","refresh_token":"rotated-refresh","expires_in":900}
    """

    func testExpiredAccessTokenIsRefreshedAndTheRequestRetried() async throws {
        let transport = MockTransport()
        // The server answers by the credential presented: the stale token 401s,
        // the refreshed one works.
        await transport.stubRequiringToken("me", token: "fresh-access", body: Self.meJSON)
        await transport.stub("auth/refresh", response: .ok(Self.refreshJSON))

        let client = makeClient(transport)
        await client.adopt(RefreshedSession(accessToken: "stale-access",
                                            refreshToken: "stored-refresh", expiresIn: 900))

        let user: User = try await client.authorized(.me)

        XCTAssertEqual(user.email, "a@b.com")
        let meCalls = await transport.callCount("me")
        let refreshCalls = await transport.callCount("auth/refresh")
        XCTAssertEqual(meCalls, 2, "should retry exactly once")
        XCTAssertEqual(refreshCalls, 1)

        // The retry must carry the *new* token, not the dead one.
        let sent = await transport.headers("me")
        XCTAssertEqual(sent.last, "Bearer fresh-access")
    }

    /// The one that matters most.
    ///
    /// The server revokes every session on the account when a spent refresh
    /// token is replayed. A screen firing several requests at once will get
    /// several simultaneous 401s, so if each refreshed independently the app
    /// would log itself out. Exactly one refresh must happen.
    func testConcurrentUnauthorizedRequestsRefreshOnlyOnce() async throws {
        let transport = MockTransport()
        await transport.stubRequiringToken("me", token: "fresh-access", body: Self.meJSON)
        await transport.stub("auth/refresh", response: .ok(Self.refreshJSON))

        let client = makeClient(transport)
        await client.adopt(RefreshedSession(accessToken: "stale-access",
                                            refreshToken: "stored-refresh", expiresIn: 900))

        try await withThrowingTaskGroup(of: User.self) { group in
            for _ in 0..<4 {
                group.addTask { try await client.authorized(.me) }
            }
            for try await user in group {
                XCTAssertEqual(user.email, "a@b.com")
            }
        }

        let refreshes = await transport.callCount("auth/refresh")
        XCTAssertEqual(refreshes, 1,
                       "four concurrent 401s must share one refresh, not race \(refreshes)")
    }

    /// Launching with a stored refresh token but no access token should cost
    /// exactly one refresh -- not one to get a token and a second because the
    /// first request went out before it was adopted.
    func testColdStartRefreshesOnce() async throws {
        let transport = MockTransport()
        await transport.stubRequiringToken("me", token: "fresh-access", body: Self.meJSON)
        await transport.stub("auth/refresh", response: .ok(Self.refreshJSON))

        let client = makeClient(transport)
        let user: User = try await client.authorized(.me)

        XCTAssertEqual(user.email, "a@b.com")
        let refreshes = await transport.callCount("auth/refresh")
        let meCalls = await transport.callCount("me")
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(meCalls, 1, "the first request should already carry the new token")
    }

    func testRejectedRefreshEndsTheSession() async throws {
        let transport = MockTransport()
        await transport.stub("me", response: .error(401, code: "invalid_token"))
        await transport.stub("auth/refresh",
                             response: .error(401, code: "invalid_refresh_token"))

        let client = makeClient(transport)

        let expired = expectation(description: "session expired handler ran")
        await client.setSessionExpiredHandler { expired.fulfill() }

        do {
            let _: User = try await client.authorized(.me)
            XCTFail("should not have succeeded")
        } catch let error as APIError {
            guard case .sessionExpired = error else {
                return XCTFail("expected sessionExpired, got \(error)")
            }
        }

        await fulfillment(of: [expired], timeout: 1)
        let stillHasSession = await client.hasStoredSession
        XCTAssertFalse(stillHasSession, "the stored token must be cleared")
    }

    func testStructuredServerErrorsSurviveAsCodeAndMessage() async throws {
        let transport = MockTransport()
        await transport.stub("devices/d1",
                             response: .error(404, code: "device_not_found",
                                              message: "No device with that id belongs to this account."))

        let client = makeClient(transport)
        // Seed a usable access token so this does not detour through a refresh.
        await client.adopt(RefreshedSession(accessToken: "a", refreshToken: "r", expiresIn: 900))

        do {
            let _: DeviceDetail = try await client.authorized(.device("d1"))
            XCTFail("should have thrown")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "device_not_found")
            XCTAssertEqual(error.status, 404)
            XCTAssertEqual(error.errorDescription,
                           "No device with that id belongs to this account.")
        }
    }

    /// A 403 is not an auth problem the app can fix by refreshing, so it must
    /// not trigger one.
    func testForbiddenDoesNotTriggerARefresh() async throws {
        let transport = MockTransport()
        await transport.stub("devices/d1", response: .error(403, code: "forbidden"))
        await transport.stub("auth/refresh", response: .ok(Self.refreshJSON))

        let client = makeClient(transport)
        await client.adopt(RefreshedSession(accessToken: "a", refreshToken: "r", expiresIn: 900))

        do {
            let _: DeviceDetail = try await client.authorized(.device("d1"))
            XCTFail("should have thrown")
        } catch {}

        let refreshCalls = await transport.callCount("auth/refresh")
        XCTAssertEqual(refreshCalls, 0)
    }

    func testNoStoredTokenMeansNoSessionRatherThanACrash() async throws {
        let transport = MockTransport()
        await transport.stub("me", response: .ok(Self.meJSON))

        let client = makeClient(transport, storedRefreshToken: nil)
        let hasSession = await client.hasStoredSession
        XCTAssertFalse(hasSession)

        do {
            let _: User = try await client.authorized(.me)
            XCTFail("should have thrown")
        } catch let error as APIError {
            guard case .sessionExpired = error else {
                return XCTFail("expected sessionExpired, got \(error)")
            }
        }
    }

    func testRequestsCarryTheBearerTokenAndJSONContentType() throws {
        let request = Endpoint.login(email: "a@b.com", password: "secret")
            .urlRequest(baseURL: baseURL, token: nil)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))

        let authed = Endpoint.devices.urlRequest(baseURL: baseURL, token: "tok")
        XCTAssertEqual(authed.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(authed.url?.path, "/api/v1/devices")
    }

    func testRangeQueryEncodesISO8601Timestamps() throws {
        let from = JSONCoding.date(from: "2026-09-08T14:00:00.000Z")!
        let request = Endpoint.readings("d1", from: from, to: nil, bucket: .fiveMinutes)
            .urlRequest(baseURL: baseURL, token: "t")
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []

        XCTAssertEqual(query.first { $0.name == "bucket" }?.value, "5m")
        XCTAssertEqual(query.first { $0.name == "from" }?.value, "2026-09-08T14:00:00.000Z")
        XCTAssertNil(query.first { $0.name == "to" }, "an omitted `to` must stay omitted")
    }
}
