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

/// A mutation's risk, raised to destructive when it would touch one of the
/// project's policy files.
///
/// Destructive is what makes the existing machinery hold the line: every mode
/// asks, an allow rule never silences it, and no "Always allow" is offered.
/// Without it, a write to `.juno/settings.local.json` was an ordinary edit
/// that Auto-edit made unasked.
private func policyRisk(_ base: ActionRisk, _ input: JSONValue, fields: [String] = ["path"]) -> ActionRisk {
    let touchesPolicy = fields.contains { field in
        input[field]?.stringValue.map(WorkspacePolicyPaths.isProtected) ?? false
    }
    return touchesPolicy ? .destructive : base
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

        Long files return their first \(ReadFileTool.defaultLineLimit) lines, \
        or as many whole lines as fit in \(ReadFileTool.maximumContentBytes / 1_024) KB. \
        Pass "offset" (1-based first line) and "limit" (line count) to read \
        another window; the header's "first_line", "last_line" and \
        "total_lines" say where you are. A windowed read is partial, so it \
        carries no "base_sha256" either.

        A juno://command-output/ path that run_command gave you reads the \
        whole saved output of that command, paged the same way.
        """

    /// Lines returned when the caller does not ask for a window. Enough for
    /// almost every source file whole; a generated file or a log is paged
    /// instead of landing in the context window in one piece.
    static let defaultLineLimit = 2_000

    /// The most content one read returns, in bytes.
    ///
    /// Well under the orchestrator's tool-result cap
    /// (`AgentOrchestrator.Configuration.maximumToolResultBytes`) so that cap
    /// never has to cut a read. It cuts the middle out of what it is given,
    /// and a read cut there would still carry the whole file's `base_sha256`
    /// and a `last_line` it never showed: a full overwrite from it would
    /// silently delete the missing middle, and paging from `last_line + 1`
    /// would skip it for good.
    static let maximumContentBytes = 100 * 1_024

    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "path": ["type": "string", "description": "Workspace-relative file path"],
                "offset": ["type": "integer", "description": "1-based line to start from"],
                "limit": ["type": "integer", "description": "Number of lines to return"],
            ],
            "required": ["path"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        "Read \(input["path"]?.stringValue ?? "?")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let offset = input["offset"]?.intValue
        let limit = input["limit"]?.intValue
        // A command's saved output: in this session's own folder, never the
        // workspace, and only by the bare file name run_command handed out.
        if let raw = input["path"]?.stringValue, raw.hasPrefix(CommandOutputSpill.pathPrefix) {
            guard let url = CommandOutputSpill.resolve(raw, in: context.commandOutputDirectory) else {
                throw ToolError.invalidInput(message: "No saved command output at \(raw).")
            }
            return ToolResult(content: try CommandOutputSpill.render(
                url: url,
                modelPath: raw,
                offset: offset,
                limit: limit,
                maximumBytes: Self.maximumContentBytes
            ))
        }
        let path = try workspacePath(from: input)
        let result = try await files.read(path, limit: .fileRead)
        return ToolResult(content: ReadFileTool.render(result, offset: offset, limit: limit))
    }

    /// The read, narrowed to a window of lines when one was asked for, or when
    /// the file is longer than the default line count or the byte budget.
    static func render(_ result: FileReadResult, offset: Int?, limit: Int?) -> String {
        // Split the way `lineCount` was counted. `String.split(separator:)`
        // compares Characters, and "\r\n" is one grapheme that is not "\n",
        // so a CRLF file read as a single line: never paged, and past its
        // "end" at offset 2. `splitLines` splits on the "\n" code unit, keeps
        // each "\r", and does not count a trailing newline as a line.
        let lines = DiffEngine.splitLines(result.content)
        let total = lines.count
        let fitsWhole = result.content.utf8.count <= maximumContentBytes
        if offset == nil, limit == nil, total <= defaultLineLimit, fitsWhole {
            return renderWhole(result)
        }
        // An empty file has no window to take; it is its own whole read.
        guard total > 0 else { return renderWhole(result) }
        let start = max(1, offset ?? 1)
        let count = max(1, limit ?? defaultLineLimit)
        guard start <= total else {
            return "{\"path\":\(quoted(result.path.value)),\"total_lines\":\(total),\"note\":\"offset is past the end of the file\"}\n"
        }
        let requestedEnd = count > total - start ? total : start + count - 1

        // Whole lines only, up to the byte budget, so `last_line` is exactly
        // the last line shown and the next offset loses nothing.
        var used = 0
        var end = start - 1
        for number in start...requestedEnd {
            let cost = lines[number - 1].utf8.count + (number > start ? 1 : 0)
            if used + cost > maximumContentBytes { break }
            used += cost
            end = number
        }
        if start == 1, end == total, !result.wasTruncated {
            // The window is the whole file. Return it as one, trailing newline
            // included, so the content shown is exactly what base_sha256 covers.
            return renderWhole(result)
        }

        let window: String
        let note: String?
        if end < start {
            // One line longer than the whole budget — minified code, a data
            // blob. Its head is shown rather than nothing, or paging could
            // never get past it.
            window = prefix(of: lines[start - 1], fittingBytes: maximumContentBytes)
            end = start
            note = "line \(start) is longer than \(maximumContentBytes / 1_024) KB; only its first \(window.utf8.count) bytes are shown"
                + (end < total ? "; pass offset \(end + 1) to continue" : "")
        } else {
            window = lines[(start - 1)..<end].joined(separator: "\n")
            if end < total {
                note = "partial read; pass offset \(end + 1) to continue"
            } else if result.wasTruncated {
                note = "the file is larger than read_file returns; lines past this point cannot be paged"
            } else {
                note = nil
            }
        }
        // A window is never the whole file, so it never carries a base.
        var header: [String] = [
            "\"path\":\(quoted(result.path.value))",
            "\"first_line\":\(start)",
            "\"last_line\":\(end)",
            "\"total_lines\":\(total)",
            "\"truncated\":true",
        ]
        if let note {
            header.append("\"note\":\(quoted(note))")
        }
        return "{\(header.joined(separator: ","))}\n" + window
    }

    /// The whole read, within the same byte budget as a window: a file over
    /// the budget is returned as its first window instead.
    static func render(_ result: FileReadResult) -> String {
        render(result, offset: nil, limit: nil)
    }

    /// Makes a read that something other than this tool must cut safe to
    /// show.
    ///
    /// The tool keeps every read under ``maximumContentBytes``, so this only
    /// runs when a caller's cap is set lower than that. The cut keeps the head,
    /// so the lines shown stay contiguous, and the header is rewritten: no
    /// `base_sha256`, since a digest of a file the model was not shown whole
    /// is not a base to overwrite from, `truncated` set, and `last_line` and
    /// the next offset recomputed from what survived.
    static func bounded(_ rendered: String, maximumBytes: Int) -> String {
        guard rendered.utf8.count > maximumBytes else { return rendered }
        guard let newline = rendered.firstIndex(of: "\n"),
              var fields = (try? JSONSerialization.jsonObject(
                  with: Data(rendered[..<newline].utf8)
              )) as? [String: Any]
        else {
            return OutputLimiter.apply(OutputLimit(maximumBytes: maximumBytes), to: rendered).text
        }
        let firstLine = fields["first_line"] as? Int ?? 1
        fields["base_sha256"] = nil
        fields["truncated"] = true
        fields["first_line"] = firstLine
        fields["last_line"] = nil
        fields["note"] = "cut by the tool-result limit; no base_sha256 is issued for a partial read"
        let provisional = (try? JSONSerialization.data(
            withJSONObject: fields,
            options: [.sortedKeys, .withoutEscapingSlashes]
        )) ?? Data()
        // Room for the header as it will finally read, with a last line and
        // a continuation offset that are at most a few digits longer.
        let bodyBudget = max(0, maximumBytes - provisional.count - 64)
        let body = String(rendered[rendered.index(after: newline)...])
        let kept = prefix(of: body, fittingBytes: bodyBudget)
        // Counted in code units: "\r\n" is one Character, not a "\n".
        let lastNewline = kept.utf8.lastIndex(of: UInt8(ascii: "\n"))
        let completeLines = kept.utf8.reduce(0) { $1 == UInt8(ascii: "\n") ? $0 + 1 : $0 }
        if completeLines > 0 {
            let lastLine = firstLine + completeLines - 1
            fields["last_line"] = lastLine
            fields["note"] = "cut by the tool-result limit; no base_sha256 is issued for a partial read; pass offset \(lastLine + 1) to continue"
        }
        let header = (try? JSONSerialization.data(
            withJSONObject: fields,
            options: [.sortedKeys, .withoutEscapingSlashes]
        )).flatMap { String(data: $0, encoding: .utf8) } ?? "{\"truncated\":true}"
        // Only whole lines, so the continuation offset repeats nothing and
        // skips nothing.
        let shown = lastNewline.map { String(decoding: kept.utf8[..<$0], as: UTF8.self) } ?? kept
        return header + "\n" + shown
    }

    /// The longest prefix of `text` within `bytes` UTF-8 bytes, never cutting
    /// a character.
    private static func prefix(of text: String, fittingBytes bytes: Int) -> String {
        var used = 0
        var end = text.startIndex
        for index in text.indices {
            let size = text[index].utf8.count
            if used + size > bytes { break }
            used += size
            end = text.index(after: index)
        }
        return String(text[..<end])
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
    private static func renderWhole(_ result: FileReadResult) -> String {
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

    public func assessRisk(input: JSONValue) -> ActionRisk { policyRisk(.write, input) }

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

    public func assessRisk(input: JSONValue) -> ActionRisk { policyRisk(.write, input) }

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

    public func assessRisk(input: JSONValue) -> ActionRisk { policyRisk(.write, input) }

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
    public func assessRisk(input: JSONValue) -> ActionRisk { policyRisk(.critical, input) }

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

    public func assessRisk(input: JSONValue) -> ActionRisk { policyRisk(.write, input, fields: ["from", "to"]) }

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
