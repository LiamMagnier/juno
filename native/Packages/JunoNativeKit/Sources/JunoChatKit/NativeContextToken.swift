import Foundation
import JunoAuth
import JunoCore

/// Typed references use the same owner-scoped /api/mentions and chat context
/// wire as the web. Labels describe a reference; the server grants authority.
public struct NativeContextToken: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case file, project, app, crew, skill, chat, artifact
    }
    public struct Range: Codable, Equatable, Sendable {
        public let start: Int
        public let end: Int
        public init(start: Int, end: Int) { self.start = start; self.end = end }
    }
    public let kind: Kind
    public let id: String
    public let label: String
    public var range: Range?
    public var identity: String { "\(kind.rawValue):\(id)" }

    public init(kind: Kind, id: String, label: String, range: Range? = nil) {
        self.kind = kind
        self.id = id
        self.label = String(label.prefix(120))
        self.range = range
    }
}

public struct NativeMentionItem: Decodable, Equatable, Sendable, Identifiable {
    public let kind: NativeContextToken.Kind
    public let id: String
    public let label: String
    public let subtitle: String?
    public let available: Bool?
    public var token: NativeContextToken { NativeContextToken(kind: kind, id: id, label: label) }
}

public struct NativeMentionResults: Decodable, Sendable {
    public let items: [NativeMentionItem]
}
