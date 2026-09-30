import Foundation

/// A skill as the agent is told about it before loading it: a name to ask
/// for and a line on when it helps.
public struct SkillSummary: Hashable, Codable, Sendable {
    public let name: String
    public let description: String
    public let path: String

    public init(name: String, description: String, path: String) {
        self.name = name
        self.description = description
        self.path = path
    }
}

/// A skill's instructions, loaded on demand.
public struct LoadedSkill: Hashable, Codable, Sendable {
    public let name: String
    public let path: String
    public let body: String

    public init(name: String, path: String, body: String) {
        self.name = name
        self.path = path
        self.body = body
    }
}

public enum SkillLoadError: Error, Equatable, Sendable, CustomStringConvertible {
    case unknown(name: String, available: [String])
    /// The file changed after the reader trusted it; the new text is not what
    /// they vouched for.
    case changedSinceTrusted(name: String)
    case unreadable(name: String)

    public var description: String {
        switch self {
        case let .unknown(name, available):
            let list = available.isEmpty ? "none are available" : "available: " + available.joined(separator: ", ")
            return "There is no trusted, enabled skill named \"\(name)\" (\(list))."
        case let .changedSinceTrusted(name):
            return "The skill \"\(name)\" changed after the reader trusted it, so it was not loaded. Ask them to review it in Settings > Skills."
        case let .unreadable(name):
            return "The skill \"\(name)\" could not be read."
        }
    }
}

/// The skills the agent may load: the reader's trusted, enabled ones only.
public protocol SkillProviding: Sendable {
    func availableSkills() async -> [SkillSummary]
    func loadSkill(named name: String) async throws -> LoadedSkill
}
