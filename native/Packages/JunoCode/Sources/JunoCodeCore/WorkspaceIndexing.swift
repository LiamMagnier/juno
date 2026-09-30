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
    /// The matching line; for a multiline match, every line it spans.
    public let lineText: String
    /// The last line of a multiline match, when it spans more than one.
    public let endLineNumber: Int?
    /// Up to the requested number of lines before and after the match.
    public let contextBefore: [String]
    public let contextAfter: [String]

    public init(
        path: WorkspacePath,
        lineNumber: Int,
        lineText: String,
        endLineNumber: Int? = nil,
        contextBefore: [String] = [],
        contextAfter: [String] = []
    ) {
        self.path = path
        self.lineNumber = lineNumber
        self.lineText = lineText
        self.endLineNumber = endLineNumber
        self.contextBefore = contextBefore
        self.contextAfter = contextAfter
    }

    /// The last line the match itself covers.
    public var lastLineNumber: Int { endLineNumber ?? lineNumber }
}

/// How many times one file matched.
public struct GrepFileCount: Hashable, Codable, Sendable {
    public let path: WorkspacePath
    public let count: Int

    public init(path: WorkspacePath, count: Int) {
        self.path = path
        self.count = count
    }
}

public struct GrepQuery: Sendable {
    public let pattern: String
    public let isRegex: Bool
    public let caseSensitive: Bool
    /// Restrict the search to paths matching this glob, when present.
    public let includeGlob: String?
    public let maximumMatches: Int
    /// Search only this file, or this folder and everything under it.
    public let path: WorkspacePath?
    /// Lines of context to return around each match.
    public let contextBefore: Int
    public let contextAfter: Int
    /// Match across line breaks: the pattern runs over each whole file, `.`
    /// matches a newline, and one match may span several lines.
    public let multiline: Bool

    /// Context lines are capped here, per side.
    public static let maximumContextLines = 20

    public init(
        pattern: String,
        isRegex: Bool = false,
        caseSensitive: Bool = false,
        includeGlob: String? = nil,
        maximumMatches: Int = 200,
        path: WorkspacePath? = nil,
        contextBefore: Int = 0,
        contextAfter: Int = 0,
        multiline: Bool = false
    ) {
        self.pattern = pattern
        self.isRegex = isRegex
        self.caseSensitive = caseSensitive
        self.includeGlob = includeGlob
        self.maximumMatches = maximumMatches
        self.path = path
        self.contextBefore = min(max(0, contextBefore), Self.maximumContextLines)
        self.contextAfter = min(max(0, contextAfter), Self.maximumContextLines)
        self.multiline = multiline
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

    /// Every file with at least one match and how many it has, in path
    /// order, at most `query.maximumMatches` files. Counts are not capped by
    /// the per-match limit the way `grep` is.
    func grepCounts(_ query: GrepQuery) async throws -> [GrepFileCount]
}
