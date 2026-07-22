import Foundation
import JunoCodeCore

public struct GitStatusTool: CodeTool {
    private let git: any GitServicing

    public init(git: any GitServicing) {
        self.git = git
    }

    public let name = "git_status"
    public let description = "Show the current branch, tracking info and changed files."
    public var inputSchema: JSONValue {
        ["type": "object", "properties": [:], "required": []]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String { "Git status" }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let status = try await git.status()
        var lines: [String] = []
        if let branch = status.branch {
            var header = "On branch \(branch)"
            if let upstream = status.upstream {
                header += " (tracking \(upstream)"
                if status.ahead > 0 { header += ", ahead \(status.ahead)" }
                if status.behind > 0 { header += ", behind \(status.behind)" }
                header += ")"
            }
            lines.append(header)
        } else {
            lines.append("Detached HEAD")
        }
        if status.isClean {
            lines.append("Working tree clean.")
        } else {
            for file in status.files {
                lines.append("\(file.indexState)\(file.worktreeState) \(file.path)")
            }
        }
        return ToolResult(content: lines.joined(separator: "\n"))
    }
}

public struct GitDiffTool: CodeTool {
    private let git: any GitServicing

    public init(git: any GitServicing) {
        self.git = git
    }

    public let name = "git_diff"
    public let description = "Unified diff of unstaged (default) or staged changes, optionally for one path."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "staged": ["type": "boolean"],
                "path": ["type": "string"],
            ],
            "required": [],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        (input["staged"]?.boolValue ?? false) ? "Git diff (staged)" : "Git diff"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        var path: WorkspacePath?
        if let raw = input["path"]?.stringValue, !raw.isEmpty {
            guard let parsed = try? WorkspacePath(raw) else {
                throw ToolError.invalidInput(message: "Unsafe path '\(raw)'.")
            }
            path = parsed
        }
        let diff = try await git.diff(staged: input["staged"]?.boolValue ?? false, path: path)
        return ToolResult(content: diff.isEmpty ? "No changes." : diff)
    }
}

public struct GitLogTool: CodeTool {
    private let git: any GitServicing

    public init(git: any GitServicing) {
        self.git = git
    }

    public let name = "git_log"
    public let description = "Recent commits, newest first."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": ["limit": ["type": "integer"]],
            "required": [],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String { "Git log" }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let limit = min(max(input["limit"]?.intValue ?? 20, 1), 100)
        let commits = try await git.log(limit: limit)
        guard !commits.isEmpty else {
            return ToolResult(content: "No commits yet.")
        }
        let lines = commits.map { "\($0.shortHash) \($0.subject) (\($0.author))" }
        return ToolResult(content: lines.joined(separator: "\n"))
    }
}

public struct GitCommitTool: CodeTool {
    private let git: any GitServicing

    public init(git: any GitServicing) {
        self.git = git
    }

    public let name = "git_commit"
    public let description =
        "Stage the given paths (or all changes when omitted) and create a commit with the message."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "message": ["type": "string"],
                "paths": ["type": "array"],
            ],
            "required": ["message"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .execute }

    public func summary(input: JSONValue) -> String {
        "Commit: \(input["message"]?.stringValue ?? "?")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let message = input["message"]?.stringValue,
              !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw ToolError.invalidInput(message: "Missing 'message'.")
        }
        let paths: [String]
        if let explicit = input["paths"]?.arrayValue {
            paths = explicit.compactMap(\.stringValue)
        } else {
            let status = try await git.status()
            paths = status.files.map(\.path)
        }
        guard !paths.isEmpty else {
            throw ToolError.executionFailed(message: "Nothing to commit.")
        }
        try await git.stage(paths: paths)
        let commit = try await git.commit(message: message)
        return ToolResult(content: "Committed \(commit.shortHash): \(commit.subject)")
    }
}
