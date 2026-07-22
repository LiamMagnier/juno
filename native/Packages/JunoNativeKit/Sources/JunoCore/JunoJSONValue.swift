import Foundation

/// A decoded JSON value of unknown shape.
///
/// The Code relay carries event and command payloads whose contents depend on
/// the kind — a `file_change` payload and a `test_update` payload share nothing
/// — and this build must be able to hold, forward and re-encode a payload whose
/// shape it does not know. Modelling every kind as a Swift type would mean a
/// host running a newer build could emit an event the phone silently drops.
///
/// `[String: Any]` would do the same job and is not `Sendable`, `Equatable` or
/// `Codable`, all three of which this needs.
///
/// Named `JunoJSONValue` rather than the obvious `JSONValue` because
/// `JunoCodeCore` already exports a type by that name, and the Mac app imports
/// both — an unqualified `JSONValue` there is ambiguous, which is a compile
/// error in one target and a silently wrong type in another.
public enum JunoJSONValue: Equatable, Sendable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JunoJSONValue])
    case object([String: JunoJSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JunoJSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JunoJSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Unsupported JSON value."
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// An ISO-8601 timestamp, which is how every date crosses this wire.
    /// Fractional seconds are optional because the relay emits them and hand-
    /// written fixtures usually do not.
    public var date: Date? {
        guard case .string(let value) = self else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = withFraction.date(from: value) { return parsed }
        return ISO8601DateFormatter().date(from: value)
    }
}
