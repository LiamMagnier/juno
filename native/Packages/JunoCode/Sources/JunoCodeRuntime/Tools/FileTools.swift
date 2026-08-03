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

/// Reads the optional `base_sha256` argument, rejecting anything that is not a
/// SHA-256 digest.
///
/// Rejecting the shape matters more than it looks. An unparseable fingerprint
/// used to be passed through and then simply failed to compare equal, so the
/// model was told the file had changed underneath it — and went off to re-read
/// and re-reason about a file nobody had touched, sometimes in a loop. The two
/// failures need different sentences because they have different fixes.
private func parsedFingerprint(from input: JSONValue, field: String = "base_sha256") throws
    -> FileFingerprint?
{
    guard let raw = input[field]?.stringValue else { return nil }
    do {
        return try FileFingerprint(validating: raw)
    } catch {
        throw ToolError.invalidInput(
            message:
                "'\(field)' must be the 64-character SHA-256 that read_file returned for this file."
        )
    }
}

public struct ReadFileTool: CodeTool {
    private let files: any FileOperating

    public init(files: any FileOperating) {
        self.files = files
    }

    public let name = "read_file"
    public let description = """
        Read a UTF-8 text file inside the workspace.

        The first line of the result is a JSON header describing the read; the \
        file's content follows it. When the whole file was returned the header \
        carries "base_sha256" — pass that value straight back to write_file or \
        apply_patch so the edit fails safely if the file changed meanwhile.

        When the file was too large to return whole the header says \
        "truncated": true and carries NO "base_sha256", because a digest of \
        bytes you were not shown is not a base you can safely overwrite from. \
        Edit a truncated file with apply_patch, which matches an exact block \
        rather than replacing the file.
        """
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
        return ToolResult(content: ReadFileTool.render(result))
    }

    /// The machine-readable read contract: one line of JSON, a newline, then
    /// the content exactly as read.
    ///
    /// A header line rather than a JSON envelope around everything, because
    /// wrapping the content would re-encode every source file the agent looks
    /// at — escaping quotes and newlines through the model's context for no
    /// benefit. The header is a single line and the content starts after the
    /// first newline, so the split is unambiguous even when the file itself
    /// begins with `{`.
    static func render(_ result: FileReadResult) -> String {
        var header: [String] = [
            "\"path\":\(quoted(result.path.value))",
            "\"bytes\":\(result.byteCount)",
            "\"lines\":\(result.lineCount)",
            "\"truncated\":\(result.wasTruncated)",
        ]
        // Withheld on a truncated read — this is the whole truncation guard.
        // The digest covers the complete file, so handing it over would let a
        // model that saw the first megabyte of a file pass a *matching* base
        // for a full overwrite and silently discard the rest. Without the
        // value it cannot: it has no way to compute a digest of bytes it was
        // never shown.
        if !result.wasTruncated {
            header.append("\"base_sha256\":\(quoted(result.fingerprint.sha256))")
        } else {
            header.append(
                "\"note\":\"content truncated; no base_sha256 is issued for a partial read — use apply_patch, or read a smaller file\""
            )
        }
        return "{\(header.joined(separator: ","))}\n" + result.content
    }

    private static func quoted(_ value: String) -> String {
        // Small, dependency-free JSON string escaping: the header only ever
        // carries a workspace-relative path and a hex digest, but a path may
        // legitimately contain a quote or a backslash.
        var out = "\""
        for character in value.unicodeScalars {
            switch character {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if character.value < 0x20 {
                    out += String(format: "\\u%04x", character.value)
                } else {
                    out.unicodeScalars.append(character)
                }
            }
        }
        return out + "\""
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
    public let description = """
        Overwrite a file, or create one that does not exist yet.

        Overwriting an existing file REQUIRES base_sha256 — the fingerprint \
        read_file returned for it. The write is refused if the file changed \
        since that read, so the edit cannot silently discard someone else's \
        work. Creating a new file takes no fingerprint.

        A file that read_file returned truncated has no fingerprint you can \
        pass, and that is deliberate: use apply_patch to edit it.
        """
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
        let base = try parsedFingerprint(from: input)
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
        let base = try parsedFingerprint(from: input)
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

    /// Approval-gated in every mode except full access, where a deletion inside
    /// the granted folder is carried out — the checkpoint above makes it
    /// revertible, and a session the user set to full access is one that may
    /// refactor files away. Escaping the folder is `destructive` and still asks;
    /// `WorkspaceAccess` is what keeps `path` inside it.
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
