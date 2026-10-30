import XCTest
@testable import Flood

/// These payloads are copied from what the server actually returns, not from the
/// spec -- the point is to fail if the app and the server ever disagree.
final class DecodingTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder.decode(T.self, from: Data(json.utf8))
    }

    func testTimestampsWithAndWithoutFractionalSeconds() throws {
        // The server writes milliseconds, but values it echoes back can arrive
        // without them. Foundation's built-in .iso8601 handles only one form.
        XCTAssertNotNil(JSONCoding.date(from: "2026-09-09T14:00:00.000Z"))
        XCTAssertNotNil(JSONCoding.date(from: "2026-09-09T14:00:00Z"))
        XCTAssertNil(JSONCoding.date(from: "tuesday"))

        let withMillis = JSONCoding.date(from: "2026-09-09T14:00:00.000Z")
        let without = JSONCoding.date(from: "2026-09-09T14:00:00Z")
        XCTAssertEqual(withMillis, without)
    }

    func testDeviceListItemHasNoDewPoint() throws {
        let list = try decode(DeviceList.self, """
        {"devices":[{"id":"d1","name":"Basement","location":"Basement",
          "online":true,"last_seen_at":"2026-09-09T13:55:00.000Z",
          "latest_reading":{"recorded_at":"2026-09-09T13:55:00.000Z",
            "temperature_c":17.4,"humidity_pct":71.2},
          "risk":{"score":59,"level":"high"}}]}
        """)

        let device = try XCTUnwrap(list.devices.first)
        XCTAssertEqual(device.risk?.level, .high)
        XCTAssertEqual(device.risk?.score, 59)
        // The list route omits it by design; decoding must not demand it.
        XCTAssertNil(device.latestReading?.dewPointC)
    }

    func testDeviceWithNoReadingsDecodesAsNulls() throws {
        let list = try decode(DeviceList.self, """
        {"devices":[{"id":"d1","name":"New","location":null,"online":false,
          "last_seen_at":null,"latest_reading":null,"risk":null}]}
        """)
        let device = try XCTUnwrap(list.devices.first)
        XCTAssertNil(device.latestReading)
        XCTAssertNil(device.risk)
        XCTAssertNil(device.lastSeenAt)
    }

    /// The case most likely to be got wrong: a device with too little history
    /// answers 200 with *every* risk field null. It is not a 404 and not a zero.
    func testUnscoredRiskIsAllNullsNotZero() throws {
        let risk = try decode(RiskDetail.self, """
        {"device_id":"d1","score":null,"level":null,"recommendation":null,
         "computed_at":null,"model":null,"factors":null,"window_hours":null}
        """)
        XCTAssertFalse(risk.isScored)
        XCTAssertNil(risk.score)
        XCTAssertNotEqual(risk.score, 0)
    }

    func testScoredRiskCarriesFactorsThatSumToTheScore() throws {
        let risk = try decode(RiskDetail.self, """
        {"device_id":"d1","score":59,"level":"high",
         "recommendation":"Run a dehumidifier in this room and check for a moisture source.",
         "computed_at":"2026-09-09T14:00:00.000Z",
         "model":{"name":"vtt","version":"2","surface_material":"drywall"},
         "factors":[
           {"key":"humidity","label":"Current humidity","contribution":5,
            "detail":"71% RH (3-hour mean), above the 65% threshold for drywall."},
           {"key":"dew_point_margin","label":"Condensation proximity","contribution":14,
            "detail":"Surface is within 5.3 °C of the dew point."},
           {"key":"duration","label":"Sustained exposure","contribution":40,
            "detail":"Conditions favorable for growth for 24 of the last 24 hours."}],
         "window_hours":168}
        """)

        XCTAssertTrue(risk.isScored)
        XCTAssertEqual(risk.model?.version, "2")
        let factors = try XCTUnwrap(risk.factors)
        // The server guarantees this, and the breakdown bar depends on it.
        XCTAssertEqual(factors.reduce(0) { $0 + $1.contribution }, risk.score)
    }

    func testRawBucketOmitsAggregateFieldsAndBucketedIncludesThem() throws {
        let raw = try decode(ReadingsPage.self, """
        {"device_id":"d1","from":"2026-09-09T13:00:00.000Z","to":"2026-09-09T14:00:00.000Z",
         "bucket":"raw","truncated":false,
         "points":[{"t":"2026-09-09T13:30:00.000Z","temperature_c":17.4,
                    "humidity_pct":71.2,"dew_point_c":12.1}]}
        """)
        XCTAssertNil(raw.points[0].sampleCount)
        XCTAssertNil(raw.points[0].humidityMin)

        let bucketed = try decode(ReadingsPage.self, """
        {"device_id":"d1","from":"2026-09-09T13:00:00.000Z","to":"2026-09-09T14:00:00.000Z",
         "bucket":"5m","truncated":true,
         "points":[{"t":"2026-09-09T13:30:00.000Z","temperature_c":17.2,"humidity_pct":70.8,
                    "dew_point_c":11.9,"humidity_min":69.4,"humidity_max":72.1,
                    "sample_count":10}]}
        """)
        XCTAssertEqual(bucketed.points[0].sampleCount, 10)
        XCTAssertEqual(bucketed.points[0].humidityMax, 72.1)
        XCTAssertTrue(bucketed.truncated)
    }

    func testUnknownEnumValuesDoNotBreakDecoding() throws {
        // A level or alert type from a newer server build must not take the
        // whole screen down.
        let page = try decode(AlertsPage.self, """
        {"alerts":[{"id":"a1","device_id":"d1","device_name":"Basement",
          "type":"something_new","fired_at":"2026-09-09T14:00:00.000Z",
          "score":81,"level":"apocalyptic","message":"hi","notified":true,
          "acknowledged_at":null}],"next_cursor":null}
        """)
        XCTAssertEqual(page.alerts[0].type, .unknown)
        XCTAssertEqual(page.alerts[0].level, .unknown)
        XCTAssertFalse(page.alerts[0].isAcknowledged)
    }

    func testPreferencesRoundTripThroughTheFullReplacementShape() throws {
        let json = """
        {"risk_high":true,"risk_critical":true,"device_offline":true,
         "device_recovered":false,"daily_summary":false,"daily_summary_hour":9,
         "timezone":"Europe/London",
         "quiet_hours":{"enabled":true,"start_hour":22,"end_hour":7}}
        """
        let prefs = try decode(Preferences.self, json)
        XCTAssertEqual(prefs.timezone, "Europe/London")
        XCTAssertTrue(prefs.quietHours.enabled)
        XCTAssertFalse(prefs.deviceRecovered)

        // PUT is a full replacement, so every key must survive the round trip.
        let encoded = try JSONCoding.encoder.encode(prefs)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        for key in ["risk_high", "risk_critical", "device_offline", "device_recovered",
                    "daily_summary", "daily_summary_hour", "timezone", "quiet_hours"] {
            XCTAssertNotNil(object[key], "\(key) missing from the replacement body")
        }
    }

    func testServerErrorShape() throws {
        let error = try decode(ServerError.self, """
        {"error":{"code":"device_not_found",
                  "message":"No device with that id belongs to this account."}}
        """)
        XCTAssertEqual(error.error.code, "device_not_found")
    }
}
