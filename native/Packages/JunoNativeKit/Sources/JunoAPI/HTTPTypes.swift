import Foundation

public enum HTTPMethod: String, Codable, CaseIterable, Sendable {
    case delete = "DELETE"
    case get = "GET"
    case patch = "PATCH"
    case post = "POST"
    case put = "PUT"
}

public enum HTTPHeaderError: Error, Equatable, Sendable {
    case emptyName
    case invalidName(String)
    case duplicateName(String)
    case valueTooLarge(name: String, maximumUTF8Bytes: Int)
    case invalidValue(name: String)
}

/// Case-insensitive, injection-safe HTTP fields.
public struct HTTPHeaders: Equatable, Sendable {
    public static let maximumValueUTF8Bytes = 8_192

    private var storage: [String: String]

    public init() {
        storage = [:]
    }

    public init(_ fields: [String: String]) throws {
        storage = [:]
        storage.reserveCapacity(fields.count)
        for (name, value) in fields {
            try set(value, for: name)
        }
    }

    public var count: Int { storage.count }
    public var allFields: [String: String] { storage }

    public subscript(name: String) -> String? {
        storage[name.lowercased()]
    }

    public mutating func set(_ value: String, for name: String) throws {
        let normalized = name.lowercased()
        guard !normalized.isEmpty else {
            throw HTTPHeaderError.emptyName
        }
        guard Self.isValidName(normalized) else {
            throw HTTPHeaderError.invalidName(name)
        }
        guard storage[normalized] == nil else {
            throw HTTPHeaderError.duplicateName(name)
        }
        guard value.utf8.count <= Self.maximumValueUTF8Bytes else {
            throw HTTPHeaderError.valueTooLarge(
                name: normalized,
                maximumUTF8Bytes: Self.maximumValueUTF8Bytes
            )
        }
        guard !value.utf8.contains(0x00), !value.utf8.contains(0x0A),
            !value.utf8.contains(0x0D)
        else {
            throw HTTPHeaderError.invalidValue(name: normalized)
        }
        storage[normalized] = value
    }

    private static func isValidName(_ name: String) -> Bool {
        !name.utf8.isEmpty && name.utf8.allSatisfy { byte in
            switch byte {
            case 48...57, 65...90, 97...122:
                true
            case 33, 35...39, 42, 43, 45, 46, 94, 95, 96, 124, 126:
                true
            default:
                false
            }
        }
    }
}

public struct HTTPRequest: Equatable, Sendable {
    public let url: URL
    public let method: HTTPMethod
    public let headers: HTTPHeaders
    public let body: Data?

    public init(
        url: URL,
        method: HTTPMethod,
        headers: HTTPHeaders = HTTPHeaders(),
        body: Data? = nil
    ) {
        self.url = url
        self.method = method
        self.headers = headers
        self.body = body
    }
}

public struct HTTPResponse: Equatable, Sendable {
    public let statusCode: Int
    public let headers: HTTPHeaders
    public let body: Data

    public init(statusCode: Int, headers: HTTPHeaders, body: Data) {
        self.statusCode = statusCode
        self.headers = headers
        self.body = body
    }
}
