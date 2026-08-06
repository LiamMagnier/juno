import Foundation

public enum GrantedPathError: Error, Equatable, Sendable {
    case empty
    case absolute
    case traversal
    case invalidComponent
    case tooLong
}

extension GrantedPathError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .empty:
            "Juno was given an empty file name."
        case .absolute:
            "Juno only works with locations inside the folder you granted, and that was a location on the wider disk."
        case .traversal:
            "That location steps outside the folder you granted, so Juno did not use it."
        case .invalidComponent:
            "That file name contains characters Juno cannot use safely."
        case .tooLong:
            "That location is too long for Juno to use."
        }
    }
}

/// A validated, display-safe location relative to the root of one grant.
///
/// **This type guarantees shape, and shape only. It is never an authorization
/// capability.** Holding a `GrantedPath` means the string cannot climb out of a
/// folder by spelling; it says nothing about whether the folder is still
/// granted, whether the mode permits the operation, or where the location
/// actually points once the filesystem resolves it. Every touch must go through
/// ``GrantAccessing/resolveForReading(_:)`` or
/// ``GrantAccessing/resolveForMutation(_:)`` immediately before the filesystem
/// is reached.
///
/// The distinction is written down here because losing it is exactly what
/// produced the escape the equivalent JunoCode type exists to prevent: a
/// validated relative path was treated as proof of containment, a symlink
/// inside the folder pointed elsewhere, and a "workspace-relative" write landed
/// outside the workspace. Nothing about the string was wrong. The string was
/// never the boundary.
public struct GrantedPath: Hashable, Codable, Sendable, Comparable, CustomStringConvertible {
    /// Generous enough for a deeply nested library, short enough that a
    /// pathological value cannot be used to blow up a preview on a phone.
    public static let maximumUTF8Bytes = 4_096

    public let value: String

    public init(_ raw: String) throws {
        guard !raw.isEmpty else { throw GrantedPathError.empty }
        guard raw.utf8.count <= Self.maximumUTF8Bytes else { throw GrantedPathError.tooLong }
        // `~` is rejected alongside `/` because a tilde-prefixed string is
        // expanded to the home directory by several Foundation and shell paths
        // that a location like this eventually reaches, which makes it absolute
        // in effect even though it does not look it.
        guard !raw.hasPrefix("/"), !raw.hasPrefix("~"), !raw.contains("\\") else {
            throw GrantedPathError.absolute
        }
        let components = raw.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains("..") else { throw GrantedPathError.traversal }
        guard
            !components.contains(where: { component in
                // An empty component catches a leading, trailing or doubled
                // slash; `.` is rejected because it makes two spellings of one
                // location, and two spellings defeat the duplicate and conflict
                // detection a batch preview is built on. NUL and every other
                // control character are rejected here: a NUL truncates the
                // string at the C boundary, so a name that passed inspection is
                // not the name the kernel is handed.
                component.isEmpty || component == "."
                    || component.unicodeScalars.contains {
                        CharacterSet.controlCharacters.contains($0)
                    }
            })
        else {
            throw GrantedPathError.invalidComponent
        }
        self.value = raw
    }

    public var description: String { value }

    public var components: [String] {
        value.split(separator: "/").map(String.init)
    }

    public var lastComponent: String {
        components.last ?? value
    }

    /// The single name a person would read out loud. This is the only part of a
    /// location that may appear in a preview: see ``WorkBatchPreview``.
    public var displayName: String { lastComponent }

    public var fileExtension: String? {
        let name = lastComponent
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return nil }
        let ext = String(name[name.index(after: dot)...])
        return ext.isEmpty ? nil : ext
    }

    public var parent: GrantedPath? {
        let parts = components
        guard parts.count > 1 else { return nil }
        return try? GrantedPath(parts.dropLast().joined(separator: "/"))
    }

    /// Every folder that must exist for this location to exist, outermost first.
    ///
    /// The batch planner uses this to discover that a move depends on a folder
    /// an earlier operation creates.
    public var ancestors: [GrantedPath] {
        let parts = components
        guard parts.count > 1 else { return [] }
        var result: [GrantedPath] = []
        var prefix: [String] = []
        for part in parts.dropLast() {
            prefix.append(part)
            if let ancestor = try? GrantedPath(prefix.joined(separator: "/")) {
                result.append(ancestor)
            }
        }
        return result
    }

    public func appending(_ component: String) throws -> GrantedPath {
        try GrantedPath(value + "/" + component)
    }

    /// The same location with its final component replaced, for a rename.
    public func renamed(to newName: String) throws -> GrantedPath {
        guard let parent else { return try GrantedPath(newName) }
        return try parent.appending(newName)
    }

    public func isDescendant(of ancestor: GrantedPath) -> Bool {
        let mine = components
        let theirs = ancestor.components
        guard mine.count > theirs.count else { return false }
        return Array(mine.prefix(theirs.count)) == theirs
    }

    public static func < (lhs: GrantedPath, rhs: GrantedPath) -> Bool {
        lhs.value < rhs.value
    }

    /// Decoding re-validates.
    ///
    /// A location arriving from the relay is untrusted text no matter which of
    /// Juno's own components sent it, and a decoder that accepted `../` would
    /// hand a caller a value whose whole point is that it cannot contain one.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        do {
            try self.init(raw)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsafe grant-relative path"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}
