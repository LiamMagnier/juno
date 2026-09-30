import Foundation

/// Any JSON value, for the two places the protocol carries JSON it does not
/// type: an event of a type this build does not know (kept whole, so it can be
/// forwarded or shown as raw), and a field declared `json` in the contract.
///
/// This target depends on nothing, so it cannot borrow `JunoCore`'s JSON value
/// or `JunoCodeCore`'s; both of those can convert through `Data`.
public enum AgentJSONValue: Hashable, Sendable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([AgentJSONValue])
    case object([String: AgentJSONValue])

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
        } else if let value = try? container.decode([AgentJSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: AgentJSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .number(let value):
            // A whole number goes out as one, so an integer field read back
            // from a raw event is still an integer to a strict reader.
            if value.rounded() == value, abs(value) < 9_007_199_254_740_992 {
                try container.encode(Int64(value))
            } else {
                try container.encode(value)
            }
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }

    /// The value under `key`, when this is an object.
    public subscript(key: String) -> AgentJSONValue? {
        guard case .object(let object) = self else { return nil }
        return object[key]
    }

    public var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }
}

/// An array whose malformed elements are skipped rather than failing the
/// event: the Swift half of the TypeScript reader's "an array element that is
/// malformed is skipped".
public struct AgentLossyArray<Element: Decodable & Sendable>: Decodable, Sendable {
    public let elements: [Element]

    public init(from decoder: any Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var elements: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                elements.append(element)
            } else if (try? container.decode(AgentJSONValue.self)) == nil {
                // Step past the element that did not decode; if even that
                // fails, the array is not JSON and there is nothing to skip to.
                break
            }
        }
        self.elements = elements
    }
}

public extension AgentEvent {
    /// One event from one line of JSON, or nil when the line is not an event
    /// this build can read (not an object, no envelope, another major version).
    static func decode(line: some StringProtocol) -> AgentEvent? {
        try? JSONDecoder().decode(AgentEvent.self, from: Data(line.utf8))
    }

    /// The event as a JSON object, with the contract's keys.
    func jsonData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}
