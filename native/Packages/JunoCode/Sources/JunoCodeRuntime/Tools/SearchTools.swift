import Foundation
import JunoCodeCore

public struct ListDirectoryTool: CodeTool {
    private let index: any WorkspaceIndexing

    public init(index: any WorkspaceIndexing) {
        self.index = index
    }

    public let name = "list_directory"
    public let description = "List the entries of a workspace directory (the root when path is omitted)."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": ["path": ["type": "string"]],
            "required": [],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        "List \(input["path"]?.stringValue ?? "workspace root")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        var path: WorkspacePath?
        if let raw = input["path"]?.stringValue, !raw.isEmpty {
            guard let parsed = try? WorkspacePath(raw) else {
                throw ToolError.invalidInput(message: "Unsafe path '\(raw)'.")
            }
            path = parsed
        }
        let entries = try await index.listDirectory(path)
        guard !entries.isEmpty else {
            return ToolResult(content: "(empty directory)")
        }
        let lines = entries.map { entry in
            entry.isDirectory ? entry.path.lastComponent + "/" : entry.path.lastComponent
        }
        return ToolResult(content: lines.joined(separator: "\n"))
    }
}

public struct GlobTool: CodeTool {
    private let index: any WorkspaceIndexing

    public init(index: any WorkspaceIndexing) {
        self.index = index
    }

    public let name = "glob"
    public let description =
        "Find files by glob pattern, e.g. '**/*.swift' or 'src/**/test_*.py'. '*' does not cross directories; '**' does."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "pattern": ["type": "string"],
                "limit": ["type": "integer"],
            ],
            "required": ["pattern"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        "Glob \(input["pattern"]?.stringValue ?? "?")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let pattern = input["pattern"]?.stringValue else {
            throw ToolError.invalidInput(message: "Missing 'pattern'.")
        }
        let limit = min(max(input["limit"]?.intValue ?? 100, 1), 500)
        let entries = try await index.glob(pattern, limit: limit)
        guard !entries.isEmpty else {
            return ToolResult(content: "No files match \(pattern).")
        }
        return ToolResult(content: entries.map(\.path.value).joined(separator: "\n"))
    }
}

public struct GrepTool: CodeTool {
    private let index: any WorkspaceIndexing

    public init(index: any WorkspaceIndexing) {
        self.index = index
    }

    /// The most text one search returns, so context lines on a broad pattern
    /// cannot crowd out the rest of the conversation.
    static let maximumOutputBytes = 64 * 1_024

    public let name = "grep"
    public let description = """
        Search file contents across the workspace (or under "path"). Literal by \
        default; set is_regex for regular expressions. "include" is a glob that \
        restricts the files searched. Every .gitignore on the way down is \
        respected, and other checkouts of the repository (worktrees) are skipped.

        output_mode: "content" (default) prints matching lines as \
        path:line: text — add "context" (lines before and after), or \
        "before_context" / "after_context", to see surrounding lines, printed \
        as path-line- text with -- between separate hunks. \
        "files_with_matches" lists the files that match; "count" gives \
        matches per file. Use those two first on a broad pattern.

        multiline: true matches across line breaks (in a regex, . matches a \
        newline), for patterns that span lines.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "pattern": ["type": "string"],
                "path": ["type": "string", "description": "File or folder to search; the whole workspace by default"],
                "is_regex": ["type": "boolean"],
                "case_sensitive": ["type": "boolean"],
                "include": ["type": "string", "description": "Glob of files to search, e.g. **/*.swift"],
                "output_mode": [
                    "type": "string",
                    "enum": ["content", "files_with_matches", "count"],
                ],
                "context": ["type": "integer", "description": "Lines of context before and after each match"],
                "before_context": ["type": "integer"],
                "after_context": ["type": "integer"],
                "multiline": ["type": "boolean"],
                "limit": ["type": "integer", "description": "Most matches (content) or files (other modes)"],
            ],
            "required": ["pattern"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        let scope = input["path"]?.stringValue.map { " in \($0)" } ?? ""
        return "Search for \"\(input["pattern"]?.stringValue ?? "?")\"\(scope)"
    }

    public func precheck(input: JSONValue) -> ToolError? {
        if let mode = input["output_mode"]?.stringValue,
           !["content", "files_with_matches", "count"].contains(mode)
        {
            return .invalidInput(message: "output_mode is content, files_with_matches or count.")
        }
        if let raw = input["path"]?.stringValue, !raw.isEmpty, raw != ".", (try? WorkspacePath(raw)) == nil {
            return .invalidInput(message: "Unsafe path '\(raw)'.")
        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let pattern = input["pattern"]?.stringValue else {
            throw ToolError.invalidInput(message: "Missing 'pattern'.")
        }
        var scope: WorkspacePath?
        if let raw = input["path"]?.stringValue, !raw.isEmpty, raw != "." {
            guard let parsed = try? WorkspacePath(raw) else {
                throw ToolError.invalidInput(message: "Unsafe path '\(raw)'.")
            }
            scope = parsed
        }
        let both = input["context"]?.intValue ?? 0
        let mode = input["output_mode"]?.stringValue ?? "content"
        let query = GrepQuery(
            pattern: pattern,
            isRegex: input["is_regex"]?.boolValue ?? false,
            caseSensitive: input["case_sensitive"]?.boolValue ?? false,
            includeGlob: input["include"]?.stringValue,
            maximumMatches: min(max(input["limit"]?.intValue ?? (mode == "content" ? 100 : 200), 1), 500),
            path: scope,
            contextBefore: input["before_context"]?.intValue ?? both,
            contextAfter: input["after_context"]?.intValue ?? both,
            multiline: input["multiline"]?.boolValue ?? false
        )
        let scopeNote = scope.map { " under \($0.value)" } ?? ""
        switch mode {
        case "files_with_matches":
            let counts = try await index.grepCounts(query)
            guard !counts.isEmpty else { return ToolResult(content: "No files match \"\(pattern)\"\(scopeNote).") }
            return ToolResult(content: bounded(counts.map(\.path.value).joined(separator: "\n")))
        case "count":
            let counts = try await index.grepCounts(query)
            guard !counts.isEmpty else { return ToolResult(content: "No matches for \"\(pattern)\"\(scopeNote).") }
            let total = counts.reduce(0) { $0 + $1.count }
            let lines = counts.map { "\($0.path.value): \($0.count)" }
            return ToolResult(
                content: bounded(lines.joined(separator: "\n") + "\n\(total) match\(total == 1 ? "" : "es") in \(counts.count) file\(counts.count == 1 ? "" : "s").")
            )
        default:
            let matches = try await index.grep(query)
            guard !matches.isEmpty else { return ToolResult(content: "No matches for \"\(pattern)\"\(scopeNote).") }
            var text = Self.format(matches)
            if matches.count >= query.maximumMatches {
                text += "\n[stopped at \(query.maximumMatches) matches; narrow the search or raise limit]"
            }
            return ToolResult(content: bounded(text))
        }
    }

    private func bounded(_ text: String) -> String {
        OutputLimiter.apply(
            OutputLimit(
                maximumBytes: Self.maximumOutputBytes,
                truncationNotice: "\n… [output truncated; narrow the search with path, include or a more specific pattern]"
            ),
            to: text
        ).text
    }

    /// ripgrep's layout: `path:12: text` for a matching line, `path-11- text`
    /// for context, `--` between hunks that do not touch. A line printed once
    /// — as context of one match and the match of the next — is not printed
    /// twice.
    static func format(_ matches: [GrepMatch]) -> String {
        var matchLines: [String: Set<Int>] = [:]
        for match in matches {
            matchLines[match.path.value, default: []].formUnion(match.lineNumber...match.lastLineNumber)
        }
        let usesContext = matches.contains { !$0.contextBefore.isEmpty || !$0.contextAfter.isEmpty }
        var out: [String] = []
        var lastPath: String?
        var lastPrinted = 0
        for match in matches {
            let path = match.path.value
            let firstLine = match.lineNumber - match.contextBefore.count
            if path != lastPath {
                if usesContext, !out.isEmpty { out.append("--") }
                lastPath = path
                lastPrinted = 0
            } else if usesContext, firstLine > lastPrinted + 1 {
                out.append("--")
            }
            func emit(_ number: Int, _ text: String) {
                guard number > lastPrinted else { return }
                let isMatch = matchLines[path]?.contains(number) ?? false
                out.append("\(path)\(isMatch ? ":" : "-")\(number)\(isMatch ? ":" : "-") \(text)")
                lastPrinted = number
            }
            for (offset, text) in match.contextBefore.enumerated() {
                emit(firstLine + offset, text)
            }
            for (offset, text) in match.lineText.components(separatedBy: "\n").enumerated() {
                emit(match.lineNumber + offset, text)
            }
            for (offset, text) in match.contextAfter.enumerated() {
                emit(match.lastLineNumber + 1 + offset, text)
            }
        }
        return out.joined(separator: "\n")
    }
}

public struct FindFilesTool: CodeTool {
    private let index: any WorkspaceIndexing

    public init(index: any WorkspaceIndexing) {
        self.index = index
    }

    public let name = "find_files"
    public let description = "Find files whose name contains a substring (case-insensitive)."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "query": ["type": "string"],
                "limit": ["type": "integer"],
            ],
            "required": ["query"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        "Find files named *\(input["query"]?.stringValue ?? "?")*"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let query = input["query"]?.stringValue else {
            throw ToolError.invalidInput(message: "Missing 'query'.")
        }
        let limit = min(max(input["limit"]?.intValue ?? 50, 1), 200)
        let entries = try await index.findFiles(nameContains: query, limit: limit)
        guard !entries.isEmpty else {
            return ToolResult(content: "No file names contain \"\(query)\".")
        }
        return ToolResult(content: entries.map(\.path.value).joined(separator: "\n"))
    }
}
