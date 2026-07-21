import Foundation

/// Marker protocol used to prevent identifiers from unrelated domains being mixed.
public protocol JunoIdentifierTag: Sendable {}

public enum IdentifierValidationError: Error, Equatable, Sendable {
    case empty
    case tooLong(maximumUTF8Bytes: Int)
    case containsControlCharacter
    case containsWhitespace
}

/// A validated, strongly typed identifier received from or sent to Juno services.
@frozen
public struct JunoID<Tag: JunoIdentifierTag>: Hashable, Codable, Sendable,
    CustomStringConvertible
{
    public static var maximumUTF8Bytes: Int { 256 }

    public let rawValue: String

    public init(_ rawValue: String) throws {
        guard !rawValue.isEmpty else {
            throw IdentifierValidationError.empty
        }
        guard rawValue.utf8.count <= Self.maximumUTF8Bytes else {
            throw IdentifierValidationError.tooLong(maximumUTF8Bytes: Self.maximumUTF8Bytes)
        }
        guard !rawValue.unicodeScalars.contains(where: { scalar in
            CharacterSet.controlCharacters.contains(scalar)
        }) else {
            throw IdentifierValidationError.containsControlCharacter
        }
        guard !rawValue.unicodeScalars.contains(where: { scalar in
            CharacterSet.whitespacesAndNewlines.contains(scalar)
        }) else {
            throw IdentifierValidationError.containsWhitespace
        }
        self.rawValue = rawValue
    }

    public var description: String { rawValue }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        do {
            try self.init(rawValue)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid Juno identifier: \(error)"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public enum AccountIDTag: JunoIdentifierTag {}
public enum DeviceIDTag: JunoIdentifierTag {}
public enum SessionIDTag: JunoIdentifierTag {}
public enum RequestIDTag: JunoIdentifierTag {}
public enum InstallationIDTag: JunoIdentifierTag {}
public enum MutationIDTag: JunoIdentifierTag {}

public typealias AccountID = JunoID<AccountIDTag>
public typealias DeviceID = JunoID<DeviceIDTag>
public typealias SessionID = JunoID<SessionIDTag>
public typealias RequestID = JunoID<RequestIDTag>
public typealias InstallationID = JunoID<InstallationIDTag>
public typealias MutationID = JunoID<MutationIDTag>
