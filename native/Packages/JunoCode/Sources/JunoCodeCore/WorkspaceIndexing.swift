import Foundation

public struct FileEntry: Hashable, Codable, Sendable, Identifiable {
    public var id: String { path.value }
    public let path: WorkspacePath
    public let isDirectory: Bool
    public let byteCount: Int?

    public init(path: WorkspacePath, isDirectory: Bool, byteCount: Int?) {
        self.path = path
        self.isDirectory = isDirectory
        self.byteCount = byteCount
    }
}

public struct GrepMatch: Hashable, Codable, Sendable {
    public let path: WorkspacePath
    public let lineNumber: Int
    public let lineText: String

    public init(path: WorkspacePath, lineNumber: Int, lineText: String) {
        self.path = path
        self.lineNumber = lineNumber
        self.lineText = lineText
    }
}

public struct GrepQuery: Sendable {
    public let pattern: String
    public let isRegex: Bool
    public let caseSensitive: Bool
    /// Restrict the search to paths matching this glob, when present.
    public let includeGlob: String?
    public let maximumMatches: Int

    public init(
        pattern: String,
        isRegex: Bool = false,
        caseSensitive: Bool = false,
        includeGlob: String? = nil,
        maximumMatches: Int = 200
    ) {
        self.pattern = pattern
        self.isRegex = isRegex
        self.caseSensitive = caseSensitive
        self.includeGlob = includeGlob
        self.maximumMatches = maximumMatches
    }
}

public enum WorkspaceIndexError: Error, Equatable, Sendable {
    case invalidPattern
    case notADirectory(path: String)
}

/// Read-only workspace navigation and search. Implementations respect
/// `.gitignore`, skip binary and oversized files for content search, apply
/// hard result limits, and honor task cancellation.
public protocol WorkspaceIndexing: Sendable {
    /// Shallow listing of one directory (workspace root when nil).
    func listDirectory(_ path: WorkspacePath?) async throws -> [FileEntry]

    /// Case-insensitive substring match on file names.
    func findFiles(nameContains query: String, limit: Int) async throws -> [FileEntry]

    /// All files matching a glob pattern.
    func glob(_ pattern: String, limit: Int) async throws -> [FileEntry]

    /// Content search across text files.
    func grep(_ query: GrepQuery) async throws -> [GrepMatch]
}
