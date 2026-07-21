import Foundation
import JunoCodeCore

private func workspacePath(from input: JSONValue, field: String = "path") throws -> WorkspacePath {
    guard let raw = input[field]?.stringValue else {
        throw ToolError.invalidInput(message: "Missing '\(field)'.")
    }
    do {
        return try WorkspacePath(raw)
    } catch {
        throw ToolError.invalidInput(message: "Unsafe path '\(raw)'.")
    }
}

public struct ReadFileTool: CodeTool {
    private let files: any FileOperating

    public init(files: any FileOperating) {
        self.files = files
    }

    public let name = "read_file"
    public let description =
        "Read a UTF-8 text file inside the workspace. Returns the content with line count and a fingerprint for later safe edits."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": ["path": ["type": "string", "description": "Workspace-relative file path"]],
            "required": ["path"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        "Read \(input["path"]?.stringValue ?? "?")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let path = try workspacePath(from: input)
        let result = try await files.read(path, limit: .fileRead)
        var header = "\(path.value) (\(result.lineCount) lines, \(result.byteCount) bytes"
        if result.wasTruncated { header += ", truncated" }
        header += ")\n"
        return ToolResult(content: header + result.content)
    }
}

public struct CreateFileTool: CodeTool {
    private let files: any FileOperating

    public init(files: any FileOperating) {
        self.files = files
    }

    public let name = "create_file"
    public let description = "Create a new text file. Fails if the file already exists."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "path": ["type": "string"],
                "content": ["type": "string"],
            ],
            "required": ["path", "content"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .write }

    public func summary(input: JSONValue) -> String {
        "Create \(input["path"]?.stringValue ?? "?")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let path = try workspacePath(from: input)
        guard let content = input["content"]?.stringValue else {
            throw ToolError.invalidInput(message: "Missing 'content'.")
        }
        let result = try await files.create(path, content: content, sessionID: context.sessionID)
        return ToolResult(
            content: "Created \(path.value) (+\(result.diff?.linesAdded ?? 0) lines).",
            sideEffects: [.fileChanged(fileChangedEvent(from: result))]
        )
    }
}

public struct WriteFileTool: CodeTool {
    private let files: any FileOperating

    public init(files: any FileOperating) {
        self.files = files
    }

    public let name = "write_file"
    public let description =
        "Overwrite a file (or create it). Pass the fingerprint from read_file as base_sha256 to fail safely if the file changed meanwhile."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "path": ["type": "string"],
                "content": ["type": "string"],
                "base_sha256": ["type": "string"],
            ],
            "required": ["path", "content"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .write }

    public func summary(input: JSONValue) -> String {
        "Write \(input["path"]?.stringValue ?? "?")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let path = try workspacePath(from: input)
        guard let content = input["content"]?.stringValue else {
            throw ToolError.invalidInput(message: "Missing 'content'.")
        }
        let base = input["base_sha256"]?.stringValue.map { FileFingerprint(sha256: $0) }
        let result = try await files.write(
            path,
            content: content,
            expectedBase: base,
            sessionID: context.sessionID
        )
        let added = result.diff?.linesAdded ?? 0
        let removed = result.diff?.linesRemoved ?? 0
        return ToolResult(
            content: "Wrote \(path.value) (+\(added) −\(removed)).",
            sideEffects: [.fileChanged(fileChangedEvent(from: result))]
        )
    }
}

public struct ApplyPatchTool: CodeTool {
    private let files: any FileOperating

    public init(files: any FileOperating) {
        self.files = files
    }

    public let name = "apply_patch"
    public let description =
        "Replace an exact unique text block in a file. Fails when the target is missing or ambiguous; provide more context lines in that case."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "path": ["type": "string"],
                "target": ["type": "string", "description": "Exact text to replace"],
                "replacement": ["type": "string"],
                "replace_all": ["type": "boolean"],
                "base_sha256": ["type": "string"],
            ],
            "required": ["path", "target", "replacement"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .write }

    public func summary(input: JSONValue) -> String {
        "Edit \(input["path"]?.stringValue ?? "?")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let path = try workspacePath(from: input)
        guard let target = input["target"]?.stringValue,
              let replacement = input["replacement"]?.stringValue
        else {
            throw ToolError.invalidInput(message: "Missing 'target' or 'replacement'.")
        }
        let base = input["base_sha256"]?.stringValue.map { FileFingerprint(sha256: $0) }
        let patch = TextPatch(
            target: target,
            replacement: replacement,
            replaceAll: input["replace_all"]?.boolValue ?? false
        )
        let result = try await files.applyPatch(
            path,
            patch: patch,
            expectedBase: base,
            sessionID: context.sessionID
        )
        let added = result.diff?.linesAdded ?? 0
        let removed = result.diff?.linesRemoved ?? 0
        return ToolResult(
            content: "Patched \(path.value) (+\(added) −\(removed)).",
            sideEffects: [.fileChanged(fileChangedEvent(from: result))]
        )
    }
}

public struct DeleteFileTool: CodeTool {
    private let files: any FileOperating

    public init(files: any FileOperating) {
        self.files = files
    }

    public let name = "delete_file"
    public let description = "Delete one file inside the workspace. A checkpoint is captured for undo."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": ["path": ["type": "string"]],
            "required": ["path"],
        ]
    }

    /// Deletion is always approval-gated, in every permission mode.
    public func assessRisk(input: JSONValue) -> ActionRisk { .critical }

    public func summary(input: JSONValue) -> String {
        "Delete \(input["path"]?.stringValue ?? "?")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let path = try workspacePath(from: input)
        let result = try await files.delete(path, sessionID: context.sessionID)
        return ToolResult(
            content: "Deleted \(path.value).",
            sideEffects: [.fileChanged(fileChangedEvent(from: result))]
        )
    }
}

public struct MoveFileTool: CodeTool {
    private let files: any FileOperating

    public init(files: any FileOperating) {
        self.files = files
    }

    public let name = "move_file"
    public let description = "Move or rename a file inside the workspace."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "from": ["type": "string"],
                "to": ["type": "string"],
            ],
            "required": ["from", "to"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .write }

    public func summary(input: JSONValue) -> String {
        "Move \(input["from"]?.stringValue ?? "?") → \(input["to"]?.stringValue ?? "?")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let from = try workspacePath(from: input, field: "from")
        let to = try workspacePath(from: input, field: "to")
        let result = try await files.move(from: from, to: to, sessionID: context.sessionID)
        return ToolResult(
            content: "Moved \(from.value) to \(to.value).",
            sideEffects: [.fileChanged(fileChangedEvent(from: result))]
        )
    }
}

private func fileChangedEvent(from result: FileMutationResult) -> FileChangedEvent {
    FileChangedEvent(
        path: result.path,
        kind: result.kind,
        linesAdded: result.diff?.linesAdded ?? 0,
        linesRemoved: result.diff?.linesRemoved ?? 0,
        checkpointID: result.checkpointID
    )
}
