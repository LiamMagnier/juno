import Foundation

public enum GitServiceError: Error, Equatable, Sendable {
    case notARepository
    case commandFailed(message: String)
    case nothingToCommit
}

public struct GitFileStatus: Hashable, Codable, Sendable, Identifiable {
    public var id: String { path }
    /// Raw path as reported by git (may name files outside strict
    /// WorkspacePath shape, e.g. during renames "old -> new").
    public let path: String
    /// Index (staged) state letter, e.g. "M", "A", "D", "R", "?" .
    public let indexState: String
    /// Worktree (unstaged) state letter.
    public let worktreeState: String

    public init(path: String, indexState: String, worktreeState: String) {
        self.path = path
        self.indexState = indexState
        self.worktreeState = worktreeState
    }

    public var isUntracked: Bool { indexState == "?" && worktreeState == "?" }
    public var isStaged: Bool { indexState != " " && indexState != "?" }
    public var hasUnstagedChanges: Bool { worktreeState != " " && worktreeState != "?" }
    public var isConflicted: Bool {
        indexState == "U" || worktreeState == "U"
            || (indexState == "A" && worktreeState == "A")
            || (indexState == "D" && worktreeState == "D")
    }
}

public struct GitStatusSummary: Hashable, Codable, Sendable {
    public let branch: String?
    public let upstream: String?
    public let ahead: Int
    public let behind: Int
    public let files: [GitFileStatus]

    public init(branch: String?, upstream: String?, ahead: Int, behind: Int, files: [GitFileStatus]) {
        self.branch = branch
        self.upstream = upstream
        self.ahead = ahead
        self.behind = behind
        self.files = files
    }

    public var isClean: Bool { files.isEmpty }
    public var hasConflicts: Bool { files.contains { $0.isConflicted } }
    public var stagedCount: Int { files.filter(\.isStaged).count }
    public var untrackedCount: Int { files.filter(\.isUntracked).count }
}

public struct GitCommitInfo: Hashable, Codable, Sendable, Identifiable {
    public var id: String { hash }
    public let hash: String
    public let shortHash: String
    public let subject: String
    public let author: String
    public let date: Date

    public init(hash: String, shortHash: String, subject: String, author: String, date: Date) {
        self.hash = hash
        self.shortHash = shortHash
        self.subject = subject
        self.author = author
        self.date = date
    }
}

/// Non-destructive Git operations for the inspector and commit preparation.
/// History-rewriting and forced operations are deliberately not part of this
/// protocol; they can only go through the command tool where the classifier
/// marks them critical and approval is always required.
public protocol GitServicing: Sendable {
    func isRepository() async -> Bool
    func status() async throws -> GitStatusSummary
    /// Unified diff text, bounded by the implementation.
    func diff(staged: Bool, path: WorkspacePath?) async throws -> String
    func log(limit: Int) async throws -> [GitCommitInfo]
    func stage(paths: [String]) async throws
    func unstage(paths: [String]) async throws
    func createBranch(named name: String) async throws
    func commit(message: String) async throws -> GitCommitInfo
}

public enum GitStatusParser {
    /// Parses `git status --porcelain --branch` output.
    public static func parse(_ output: String) -> GitStatusSummary {
        var branch: String?
        var upstream: String?
        var ahead = 0
        var behind = 0
        var files: [GitFileStatus] = []
        for line in output.components(separatedBy: "\n") {
            guard !line.isEmpty else { continue }
            if line.hasPrefix("## ") {
                let header = String(line.dropFirst(3))
                // Forms: "main", "main...origin/main", "main...origin/main [ahead 1, behind 2]",
                // "No commits yet on main", "HEAD (no branch)".
                var name = header
                if let bracket = name.range(of: " [") {
                    let tracking = name[bracket.upperBound...].dropLast(name.hasSuffix("]") ? 1 : 0)
                    for part in tracking.components(separatedBy: ", ") {
                        if part.hasPrefix("ahead ") {
                            ahead = Int(part.dropFirst(6)) ?? 0
                        } else if part.hasPrefix("behind ") {
                            behind = Int(part.dropFirst(7)) ?? 0
                        }
                    }
                    name = String(name[..<bracket.lowerBound])
                }
                if let dots = name.range(of: "...") {
                    upstream = String(name[dots.upperBound...])
                    name = String(name[..<dots.lowerBound])
                }
                if name.hasPrefix("No commits yet on ") {
                    name = String(name.dropFirst("No commits yet on ".count))
                }
                branch = name == "HEAD (no branch)" ? nil : name
                continue
            }
            guard line.count >= 4 else { continue }
            let indexState = String(line[line.startIndex])
            let worktreeState = String(line[line.index(after: line.startIndex)])
            let path = String(line.dropFirst(3))
            files.append(
                GitFileStatus(path: path, indexState: indexState, worktreeState: worktreeState)
            )
        }
        return GitStatusSummary(
            branch: branch,
            upstream: upstream,
            ahead: ahead,
            behind: behind,
            files: files
        )
    }
}
