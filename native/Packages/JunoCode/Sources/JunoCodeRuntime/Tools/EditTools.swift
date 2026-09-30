import Foundation
import JunoCodeCore

/// A read with no output cap: an edit is computed from the whole file, and
/// the fingerprint it is checked against covers the whole file.
private let wholeFile = OutputLimit(maximumBytes: .max)

/// Makes several exact replacements in one file, all or nothing.
public struct MultiEditTool: CodeTool {
    private let files: any FileOperating

    public init(files: any FileOperating) {
        self.files = files
    }

    public static let maximumEdits = 100

    public let name = "multi_edit"
    public let description = """
        Make several exact text replacements in ONE file, in order, as a \
        single all-or-nothing edit.

        Each edit replaces old_string with new_string. Edits apply one after \
        another, so each old_string must match the file as the earlier edits \
        left it. old_string must match exactly — whitespace and indentation \
        included — and occur exactly once, unless replace_all is true. If any \
        edit fails, none is applied and the file is untouched.

        Pass the base_sha256 read_file returned to refuse the edit if the file \
        changed since you read it. Do not copy read_file's line-number prefixes \
        into old_string or new_string. The change is checkpointed and can be \
        undone from the transcript.
        """

    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "path": ["type": "string", "description": "Workspace-relative file path"],
                "edits": [
                    "type": "array",
                    "description": "Replacements, applied in order",
                    "items": [
                        "type": "object",
                        "properties": [
                            "old_string": ["type": "string"],
                            "new_string": ["type": "string"],
                            "replace_all": ["type": "boolean"],
                        ],
                        "required": ["old_string", "new_string"],
                    ],
                ],
                "base_sha256": ["type": "string"],
            ],
            "required": ["path", "edits"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { policyRisk(.write, input) }

    public func summary(input: JSONValue) -> String {
        let count = input["edits"]?.arrayValue?.count ?? 0
        return "Edit \(input["path"]?.stringValue ?? "?") (\(count) change\(count == 1 ? "" : "s"))"
    }

    public func precheck(input: JSONValue) -> ToolError? {
        do {
            _ = try Self.edits(from: input)
            return nil
        } catch let error as ToolError {
            return error
        } catch {
            return .invalidInput(message: String(describing: error))
        }
    }

    static func edits(from input: JSONValue) throws -> [TextPatch] {
        guard let items = input["edits"]?.arrayValue, !items.isEmpty else {
            throw ToolError.invalidInput(message: "'edits' needs at least one {old_string, new_string}.")
        }
        guard items.count <= maximumEdits else {
            throw ToolError.invalidInput(message: "At most \(maximumEdits) edits per call.")
        }
        return try items.enumerated().map { index, item in
            guard let old = item["old_string"]?.stringValue,
                  let new = item["new_string"]?.stringValue
            else {
                throw ToolError.invalidInput(
                    message: "Edit \(index + 1) needs string fields old_string and new_string."
                )
            }
            if let flag = item["replace_all"], !flag.isNull, flag.boolValue == nil {
                throw ToolError.invalidInput(message: "Edit \(index + 1): replace_all must be a boolean.")
            }
            return TextPatch(target: old, replacement: new, replaceAll: item["replace_all"]?.boolValue ?? false)
        }
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let path = try workspacePath(from: input)
        let edits = try Self.edits(from: input)
        let base = try parsedFingerprint(from: input)
        let current = try await files.read(path, limit: wholeFile)
        if let base, base != current.fingerprint {
            throw FileOperationError.concurrentModification(path: path.value)
        }
        let updated: String
        do {
            updated = try MultiEdit.apply(edits, to: current.content)
        } catch let error as MultiEditError {
            throw ToolError.executionFailed(message: "\(path.value): \(error)")
        }
        // Written against the fingerprint of the content the edits were
        // applied to, so a change landing in between refuses the write.
        let result = try await files.write(
            path,
            content: updated,
            expectedBase: current.fingerprint,
            sessionID: context.sessionID
        )
        let added = result.diff?.linesAdded ?? 0
        let removed = result.diff?.linesRemoved ?? 0
        return ToolResult(
            content: "Edited \(path.value): \(edits.count) change\(edits.count == 1 ? "" : "s") (+\(added) −\(removed)).",
            sideEffects: [.fileChanged(fileChangedEvent(from: result))]
        )
    }
}

/// Edits files with a patch: a multi-file `*** Begin Patch` envelope applied
/// as one transaction, or — for callers written against the original tool —
/// a single exact replacement in one file.
public struct ApplyPatchTool: CodeTool {
    private let files: any FileOperating

    public init(files: any FileOperating) {
        self.files = files
    }

    public let name = "apply_patch"
    public let description = """
        Edit files with a patch. Two forms:

        1. `patch`: a multi-file patch, applied atomically — every file \
        changes or none does.

        *** Begin Patch
        *** Update File: src/app.swift
        @@ func run() {
             let a = 1
        -    let b = 2
        +    let b = 3
        *** Add File: docs/notes.md
        +Every line of a new file starts with +
        *** Delete File: old/unused.swift
        *** Update File: src/old_name.swift
        *** Move to: src/new_name.swift
        *** End Patch

        In an Update, each hunk starts with @@, optionally followed by a line \
        the hunk sits below (a function or type signature). Hunk lines start \
        with ' ' (unchanged context), '-' (remove) or '+' (add). Give about \
        three context lines around each change so it matches one place; hunks \
        apply top to bottom. Paths are workspace-relative. Do not copy \
        read_file's line-number prefixes into the patch.

        2. `path`, `target`, `replacement`: replace one exact text block that \
        appears once in the file (or everywhere, with replace_all). Pass \
        base_sha256 from read_file to refuse the edit if the file changed.

        Every change is checkpointed and can be undone from the transcript.
        """

    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "patch": ["type": "string", "description": "A *** Begin Patch … *** End Patch envelope"],
                "path": ["type": "string"],
                "target": ["type": "string", "description": "Exact text to replace"],
                "replacement": ["type": "string"],
                "replace_all": ["type": "boolean"],
                "base_sha256": ["type": "string"],
            ],
            "required": [],
        ]
    }

    /// The envelope's riskiest operation decides: a deletion is gated like
    /// `delete_file`, and any path among the project's policy files makes the
    /// whole patch destructive, as a write to one would be.
    public func assessRisk(input: JSONValue) -> ActionRisk {
        guard let text = input["patch"]?.stringValue else {
            return policyRisk(.write, input)
        }
        guard let envelope = try? PatchEnvelope.parse(text) else { return .write }
        if envelope.paths.contains(where: WorkspacePolicyPaths.isProtected) {
            return .destructive
        }
        let deletes = envelope.operations.contains {
            if case .delete = $0 { return true }
            return false
        }
        return deletes ? .critical : .write
    }

    public func summary(input: JSONValue) -> String {
        guard let text = input["patch"]?.stringValue else {
            return "Edit \(input["path"]?.stringValue ?? "?")"
        }
        guard let envelope = try? PatchEnvelope.parse(text) else { return "Apply a patch" }
        let paths = envelope.paths
        if paths.count == 1 { return "Edit \(paths[0])" }
        let shown = paths.prefix(4).joined(separator: ", ")
        return "Patch \(paths.count) files: \(shown)\(paths.count > 4 ? ", …" : "")"
    }

    public func precheck(input: JSONValue) -> ToolError? {
        let hasPatch = input["patch"]?.stringValue != nil
        let hasReplacement = input["target"] != nil || input["replacement"] != nil
        if hasPatch, hasReplacement || input["path"] != nil {
            return .invalidInput(message: "Pass either 'patch', or 'path' with 'target' and 'replacement' — not both.")
        }
        if let text = input["patch"]?.stringValue {
            do {
                let envelope = try PatchEnvelope.parse(text)
                for path in envelope.paths {
                    guard (try? WorkspacePath(path)) != nil else {
                        return .invalidInput(message: "Unsafe path '\(path)' in the patch.")
                    }
                }
            } catch {
                return .invalidInput(message: String(describing: error))
            }
            return nil
        }
        guard input["path"]?.stringValue != nil,
              input["target"]?.stringValue != nil,
              input["replacement"]?.stringValue != nil
        else {
            return .invalidInput(message: "Pass 'patch', or 'path' with 'target' and 'replacement'.")
        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        if let text = input["patch"]?.stringValue {
            return try await applyEnvelope(text, sessionID: context.sessionID)
        }
        return try await applyReplacement(input, sessionID: context.sessionID)
    }

    private func applyReplacement(_ input: JSONValue, sessionID: CodeSessionID) async throws -> ToolResult {
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
            sessionID: sessionID
        )
        let added = result.diff?.linesAdded ?? 0
        let removed = result.diff?.linesRemoved ?? 0
        return ToolResult(
            content: "Patched \(path.value) (+\(added) −\(removed)).",
            sideEffects: [.fileChanged(fileChangedEvent(from: result))]
        )
    }

    /// Computes every file's new content before anything is written, then
    /// hands the whole set to the file service as one transaction.
    private func applyEnvelope(_ text: String, sessionID: CodeSessionID) async throws -> ToolResult {
        let envelope: PatchEnvelope
        do {
            envelope = try PatchEnvelope.parse(text)
        } catch {
            throw ToolError.invalidInput(message: String(describing: error))
        }
        var changes: [FileChangeRequest] = []
        do {
            for operation in envelope.operations {
                switch operation {
                case let .add(raw, content):
                    changes.append(.create(path: try safePath(raw), content: content))
                case let .delete(raw):
                    let path = try safePath(raw)
                    let current = try await files.read(path, limit: wholeFile)
                    changes.append(.delete(path: path, expectedBase: current.fingerprint))
                case let .update(raw, moveTo, hunks):
                    let path = try safePath(raw)
                    let current = try await files.read(path, limit: wholeFile)
                    let updated = try PatchEnvelope.apply(hunks, to: current.content, path: raw)
                    let destination = try moveTo.map(safePath)
                    if updated == current.content, destination == nil || destination == path {
                        throw ToolError.executionFailed(
                            message: "\(raw): the hunks leave the file unchanged. No file was changed."
                        )
                    }
                    changes.append(
                        .update(path: path, content: updated, expectedBase: current.fingerprint, moveTo: destination)
                    )
                }
            }
        } catch let error as PatchEnvelopeError {
            throw ToolError.executionFailed(message: "\(error) No file was changed.")
        }
        let results = try await files.applyChangeSet(changes, sessionID: sessionID)
        let lines = zip(changes, results).map { change, result -> String in
            let added = result.diff?.linesAdded ?? 0
            let removed = result.diff?.linesRemoved ?? 0
            switch result.kind {
            case .created:
                return "A \(result.path.value) (+\(added))"
            case .deleted:
                return "D \(result.path.value)"
            case .moved:
                return "R \(change.path.value) → \(result.path.value) (+\(added) −\(removed))"
            case .modified:
                return "M \(result.path.value) (+\(added) −\(removed))"
            }
        }
        return ToolResult(
            content: "Applied the patch to \(results.count) file\(results.count == 1 ? "" : "s"):\n"
                + lines.joined(separator: "\n"),
            sideEffects: results.map { .fileChanged(fileChangedEvent(from: $0)) }
        )
    }

    private func safePath(_ raw: String) throws -> WorkspacePath {
        do {
            return try WorkspacePath(raw)
        } catch {
            throw ToolError.invalidInput(message: "Unsafe path '\(raw)' in the patch.")
        }
    }
}
