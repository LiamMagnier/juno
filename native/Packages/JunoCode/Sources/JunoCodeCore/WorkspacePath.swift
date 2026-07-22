import Foundation

public enum WorkspacePathError: Error, Equatable, Sendable {
    case empty
    case absolute
    case traversal
    case invalidComponent
    case tooLong
}

/// A validated, display-safe path relative to a workspace root.
///
/// This type guarantees shape only. It is never an authorization capability:
/// every mutation must still pass canonical containment checks against the
/// live workspace root immediately before the filesystem is touched.
public struct WorkspacePath: Hashable, Codable, Sendable, CustomStringConvertible {
    public static let maximumUTF8Bytes = 4_096

    public let value: String

    public init(_ raw: String) throws {
        guard !raw.isEmpty else { throw WorkspacePathError.empty }
        guard raw.utf8.count <= Self.maximumUTF8Bytes else { throw WorkspacePathError.tooLong }
        guard !raw.hasPrefix("/"), !raw.hasPrefix("~"), !raw.contains("\\") else {
            throw WorkspacePathError.absolute
        }
        let components = raw.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains("..") else { throw WorkspacePathError.traversal }
        guard !components.contains(where: { component in
            component.isEmpty || component == "." || component.unicodeScalars.contains {
                CharacterSet.controlCharacters.contains($0)
            }
        }) else {
            throw WorkspacePathError.invalidComponent
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

    public var fileExtension: String? {
        let name = lastComponent
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return nil }
        let ext = String(name[name.index(after: dot)...])
        return ext.isEmpty ? nil : ext
    }

    public var parent: WorkspacePath? {
        let parts = components
        guard parts.count > 1 else { return nil }
        return try? WorkspacePath(parts.dropLast().joined(separator: "/"))
    }

    public func appending(_ component: String) throws -> WorkspacePath {
        try WorkspacePath(value + "/" + component)
    }

    public func isDescendant(of ancestor: WorkspacePath) -> Bool {
        let mine = components
        let theirs = ancestor.components
        guard mine.count > theirs.count else { return false }
        return Array(mine.prefix(theirs.count)) == theirs
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        do {
            try self.init(raw)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsafe workspace-relative path"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}
