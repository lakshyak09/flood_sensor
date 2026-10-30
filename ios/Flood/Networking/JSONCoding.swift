import Foundation

/// Date handling deserves its own file because `.iso8601` is not enough.
///
/// The server writes `2026-09-09T14:00:00.000Z` -- ISO 8601 **with** fractional
/// seconds -- but some values it echoes back (a `from`/`to` the client supplied,
/// a timestamp normalised from a device) can arrive without them. Foundation's
/// built-in `.iso8601` strategy handles exactly one of those two forms and
/// throws on the other, so both are tried here.
enum JSONCoding {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let withoutFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func date(from string: String) -> Date? {
        withFraction.date(from: string) ?? withoutFraction.date(from: string)
    }

    static func string(from date: Date) -> String {
        withFraction.string(from: date)
    }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = JSONCoding.date(from: raw) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath,
                          debugDescription: "Not an ISO 8601 timestamp: \(raw)")
                )
            }
            return date
        }
        return d
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(JSONCoding.string(from: date))
        }
        return e
    }()
}
