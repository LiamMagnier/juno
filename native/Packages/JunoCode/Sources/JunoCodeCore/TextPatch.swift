import Foundation

public enum TextPatchError: Error, Equatable, Sendable {
    case targetNotFound
    case ambiguousTarget(occurrences: Int)
    case emptyTarget
    case noChange
}

/// An exact search-and-replace edit. Ambiguity is an error: the agent must
/// provide enough context to identify one unique target.
public struct TextPatch: Hashable, Codable, Sendable {
    public let target: String
    public let replacement: String
    public let replaceAll: Bool

    public init(target: String, replacement: String, replaceAll: Bool = false) {
        self.target = target
        self.replacement = replacement
        self.replaceAll = replaceAll
    }

    public func apply(to content: String) throws -> String {
        guard !target.isEmpty else { throw TextPatchError.emptyTarget }
        guard target != replacement else { throw TextPatchError.noChange }
        let occurrences = content.ranges(of: target).count
        guard occurrences > 0 else { throw TextPatchError.targetNotFound }
        if replaceAll {
            return content.replacingOccurrences(of: target, with: replacement)
        }
        guard occurrences == 1 else {
            throw TextPatchError.ambiguousTarget(occurrences: occurrences)
        }
        guard let range = content.range(of: target) else {
            throw TextPatchError.targetNotFound
        }
        return content.replacingCharacters(in: range, with: replacement)
    }
}
