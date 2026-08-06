import Foundation

/// A decoded JSON value of unknown shape.
///
/// Needed in exactly one place — an instance's per-node `overrides`, whose
/// values are whatever property is being overridden — and deliberately nowhere
/// else. Everything with a known shape is modelled properly; a document that
/// carried untyped bags everywhere would defeat the point of having a contract.
public enum DesignJSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([DesignJSONValue])
    case object([String: DesignJSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([DesignJSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: DesignJSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
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
}
