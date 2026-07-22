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

    public let name = "grep"
    public let description =
        "Search file contents. Literal by default; set is_regex for regular expressions. Optional include glob restricts the files searched."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "pattern": ["type": "string"],
                "is_regex": ["type": "boolean"],
                "case_sensitive": ["type": "boolean"],
                "include": ["type": "string"],
                "limit": ["type": "integer"],
            ],
            "required": ["pattern"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        "Search for \"\(input["pattern"]?.stringValue ?? "?")\""
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let pattern = input["pattern"]?.stringValue else {
            throw ToolError.invalidInput(message: "Missing 'pattern'.")
        }
        let query = GrepQuery(
            pattern: pattern,
            isRegex: input["is_regex"]?.boolValue ?? false,
            caseSensitive: input["case_sensitive"]?.boolValue ?? false,
            includeGlob: input["include"]?.stringValue,
            maximumMatches: min(max(input["limit"]?.intValue ?? 100, 1), 500)
        )
        let matches = try await index.grep(query)
        guard !matches.isEmpty else {
            return ToolResult(content: "No matches for \"\(pattern)\".")
        }
        let lines = matches.map { "\($0.path.value):\($0.lineNumber): \($0.lineText)" }
        return ToolResult(content: lines.joined(separator: "\n"))
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
