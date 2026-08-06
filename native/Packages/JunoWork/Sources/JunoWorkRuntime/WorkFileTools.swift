import Foundation
import JunoWorkCore
import JunoWorkLocal

// MARK: - Shared argument parsing

/// Reads a grant-relative location from an argument.
///
/// The refusal names the field rather than echoing the offending string. A
/// rejected location is repeated back to the model, and a model that pasted
/// something it should not have should not have it read back to it.
private func grantedPath(
    from input: WorkToolValue,
    field: String = "path"
) throws -> GrantedPath {
    guard let raw = input[field]?.stringValue else {
        throw WorkToolError.invalidInput(message: "Missing '\(field)'.")
    }
    do {
        return try GrantedPath(raw)
    } catch {
        throw WorkToolError.invalidInput(
            message: "'\(field)' is not a location inside the folder Juno was given. \(error.localizedDescription)"
        )
    }
}

/// Parses the `sha256:byteCount` token ``ReadFileTool`` issues.
///
/// One field rather than two, because a fingerprint split across `base_sha256`
/// and `base_bytes` is a fingerprint a caller can supply half of — and half a
/// fingerprint compares unequal to everything, which surfaces as "this file
/// changed underneath you" about a file nobody touched.
private func fingerprintToken(
    from input: WorkToolValue,
    field: String
) throws -> WorkContentFingerprint? {
    guard let raw = input[field]?.stringValue, !raw.isEmpty else { return nil }
    let parts = raw.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2, let byteCount = Int(parts[1]),
        let fingerprint = try? WorkContentFingerprint(
            validating: String(parts[0]),
            byteCount: byteCount
        )
    else {
        throw WorkToolError.invalidInput(
            message: "'\(field)' must be the exact \"base\" value read_file returned for this file."
        )
    }
    return fingerprint
}

// MARK: - Looking

public struct ListFolderTool: WorkTool {
    private let files: WorkFileService

    public init(files: WorkFileService) {
        self.files = files
    }

    public let name = "list_folder"
    public let description = """
        List what is directly inside one folder. Omit "path" for the top of the \
        folder you were given. Folders come first, then files, each with its \
        size in bytes.
        """
    public let schema = WorkToolSchema([
        .init("path", .string, "Location inside the granted folder. Omit for the top level.")
    ])

    public func assessRisk(input: WorkToolValue) -> WorkRiskLevel { .safe }

    public func summary(input: WorkToolValue) -> String {
        "List \(input["path"]?.stringValue ?? "the top of this folder")"
    }

    public func execute(input: WorkToolValue, context: WorkToolContext) async throws -> WorkToolResult {
        var path: GrantedPath?
        if input["path"]?.stringValue != nil { path = try grantedPath(from: input) }
        let entries = try await files.list(path)
        guard !entries.isEmpty else {
            return WorkToolResult(content: "That folder is empty.", detail: ["items": 0])
        }
        let lines = entries.map { entry -> String in
            let size = entry.byteCount.map { " (\($0) bytes)" } ?? ""
            return "\(entry.isDirectory ? "folder" : "file")\t\(entry.path.value)\(size)"
        }
        return WorkToolResult(
            content: lines.joined(separator: "\n"),
            detail: ["items": .number(Double(entries.count))]
        )
    }
}

public struct ReadFileTool: WorkTool {
    private let files: WorkFileService

    public init(files: WorkFileService) {
        self.files = files
    }

    public let name = "read_file"
    public let description = """
        Read one file. The first line of the result is a JSON header describing \
        the read; the file's content follows it.

        When the whole file was returned the header carries "base" — pass that \
        value straight back to apply_changes as "expected_base" for a write, so \
        the change fails safely if somebody edited the file in the meantime.

        A file too large to return whole has "truncated": true and NO "base", \
        because a fingerprint of bytes you were not shown is not a version you \
        can safely overwrite from.
        """
    public let schema = WorkToolSchema([
        .init("path", .string, "Location inside the granted folder.", required: true),
        .init("max_bytes", .integer, "Stop after this many bytes."),
    ])

    public func assessRisk(input: WorkToolValue) -> WorkRiskLevel { .safe }

    public func summary(input: WorkToolValue) -> String {
        "Read \(input["path"]?.stringValue ?? "a file")"
    }

    public func execute(input: WorkToolValue, context: WorkToolContext) async throws -> WorkToolResult {
        let path = try grantedPath(from: input)
        let result = try await files.read(path, maximumBytes: input["max_bytes"]?.intValue)

        var header: [String: WorkToolValue] = [
            "path": .string(path.value),
            "bytes": .number(Double(result.totalByteCount)),
            "truncated": .bool(result.wasTruncated),
        ]
        // Withheld on a truncated read, and that is the whole truncation guard.
        // The fingerprint covers the complete file, so handing it over would let
        // a caller that saw the first two megabytes pass a *matching*
        // expected_base for a full overwrite and silently discard the rest.
        if let fingerprint = result.fingerprint {
            header["base"] = .string(fingerprint.canonicalForm)
        } else {
            header["note"] = .string(
                "content truncated; no base is issued for a partial read"
            )
        }
        guard let text = result.text else {
            header["note"] = .string("this file is not text, so its contents were not returned")
            return WorkToolResult(
                content: WorkToolValue.object(header).canonicalJSONString(),
                detail: ["bytes": .number(Double(result.totalByteCount))]
            )
        }
        return WorkToolResult(
            content: WorkToolValue.object(header).canonicalJSONString() + "\n" + text,
            detail: [
                "bytes": .number(Double(result.totalByteCount)),
                "truncated": .bool(result.wasTruncated),
            ]
        )
    }
}

public struct SearchFilesTool: WorkTool {
    private let files: WorkFileService

    public init(files: WorkFileService) {
        self.files = files
    }

    public let name = "search_files"
    public let description = """
        Find files by name, by their text contents, or both. At least one of \
        "name_contains" and "content_contains" is required. Binary files and \
        anything large are skipped rather than read.
        """
    public let schema = WorkToolSchema([
        .init("name_contains", .string, "Match against file names, case-insensitively."),
        .init("content_contains", .string, "Match against file contents, case-insensitively."),
        .init("limit", .integer, "Stop after this many matches. Defaults to 100."),
    ])

    public func assessRisk(input: WorkToolValue) -> WorkRiskLevel { .safe }

    public func precheck(input: WorkToolValue) -> WorkToolError? {
        let name = input["name_contains"]?.stringValue ?? ""
        let content = input["content_contains"]?.stringValue ?? ""
        guard name.isEmpty, content.isEmpty else { return nil }
        // Refused rather than answered with everything. A search with no terms
        // walks the whole grant and returns a list nobody asked for, which is
        // both slow and a way to enumerate somebody's folder by accident.
        return .invalidInput(
            message: "Give at least one of 'name_contains' or 'content_contains'."
        )
    }

    public func summary(input: WorkToolValue) -> String {
        let terms = [input["name_contains"]?.stringValue, input["content_contains"]?.stringValue]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return "Search this folder for \(terms.joined(separator: " and "))"
    }

    public func execute(input: WorkToolValue, context: WorkToolContext) async throws -> WorkToolResult {
        var query = WorkSearchQuery()
        query.nameContains = input["name_contains"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        query.contentContains = input["content_contains"]?.stringValue.flatMap {
            $0.isEmpty ? nil : $0
        }
        if let limit = input["limit"]?.intValue { query.limit = max(1, limit) }

        let results = try await files.search(query)
        guard !results.isEmpty else {
            return WorkToolResult(content: "Nothing matched.", detail: ["matches": 0])
        }
        let lines = results.map { result -> String in
            guard let line = result.matchedLine, let number = result.lineNumber else {
                return result.entry.path.value
            }
            return "\(result.entry.path.value):\(number): \(line)"
        }
        return WorkToolResult(
            content: lines.joined(separator: "\n"),
            detail: ["matches": .number(Double(results.count))]
        )
    }
}

public struct FileDetailsTool: WorkTool {
    private let files: WorkFileService

    public init(files: WorkFileService) {
        self.files = files
    }

    public let name = "file_details"
    public let description =
        "Size, dates and Finder tags for one file or folder, without reading its contents."
    public let schema = WorkToolSchema([
        .init("path", .string, "Location inside the granted folder.", required: true)
    ])

    public func assessRisk(input: WorkToolValue) -> WorkRiskLevel { .safe }

    public func summary(input: WorkToolValue) -> String {
        "Look at \(input["path"]?.stringValue ?? "an item")"
    }

    public func execute(input: WorkToolValue, context: WorkToolContext) async throws -> WorkToolResult {
        let path = try grantedPath(from: input)
        let metadata = try await files.metadata(of: path)
        let formatter = ISO8601DateFormatter()
        var fields: [String: WorkToolValue] = [
            "path": .string(metadata.path.value),
            "kind": .string(metadata.isDirectory ? "folder" : "file"),
            "bytes": .number(Double(metadata.byteCount)),
            "tags": .array(metadata.tags.map { .string($0) }),
        ]
        if let created = metadata.createdAt {
            fields["created"] = .string(formatter.string(from: created))
        }
        if let modified = metadata.modifiedAt {
            fields["modified"] = .string(formatter.string(from: modified))
        }
        return WorkToolResult(
            content: WorkToolValue.object(fields).canonicalJSONString(),
            detail: [
                "kind": .string(metadata.isDirectory ? "folder" : "file"),
                "bytes": .number(Double(metadata.byteCount)),
            ]
        )
    }
}

// MARK: - Changing

/// The single door through which anything in a granted folder changes.
///
/// One tool rather than nine, and the reason is the approval rather than the
/// tidiness. A person asked forty separate times whether Juno may move a file
/// stops reading by the fourth; a person shown one ordered, conflict-checked
/// preview of forty moves is being asked something they can actually answer. The
/// batch is also what makes the answer *binding*: the preview and the approval
/// name the same digest, and ``WorkBatchExecutor`` refuses anything else.
///
/// The flow never varies, and each step is there because skipping it has a
/// consequence:
///
/// 1. **Plan.** Ordering a batch up front is what turns "these forty changes
///    depend on each other in a loop" into a refusal before anything moves,
///    rather than a discovery twenty files in.
/// 2. **Preview.** Emitted before the question, so what a person approves is
///    something they were shown.
/// 3. **Ask, bound to the plan's digest.**
/// 4. **Re-verify that digest immediately before executing.**
/// 5. **Execute through ``WorkBatchExecutor``**, which re-resolves every
///    location through the grant and flushes the undo journal after each
///    operation rather than at the end.
public struct ApplyChangesTool: WorkTool {
    /// Files above this are not fingerprinted while the preview is built.
    ///
    /// The fingerprints feed duplicate detection and the "this changed after you
    /// approved it" check, both of which are worth having and neither of which
    /// is worth reading forty gigabytes of video to obtain. Where there is no
    /// fingerprint the executor simply has no evidence and says so, which is
    /// better than a check that always passes.
    private static let maximumFingerprintBytes = 8 * 1_024 * 1_024

    /// How long a batch running under a standing policy — nobody asked — stays
    /// authorised. It only has to cover the gap between minting the approval and
    /// the executor re-checking it, which is the same instant.
    private static let standingApprovalWindow: TimeInterval = 60

    private let files: WorkFileService
    private let batches: WorkBatchExecutor
    private let undo: WorkUndoLedger

    public init(files: WorkFileService, batches: WorkBatchExecutor, undo: WorkUndoLedger) {
        self.files = files
        self.batches = batches
        self.undo = undo
    }

    public let name = "apply_changes"
    public let description = """
        Make a set of changes to the granted folder in one reviewed batch.

        Every change is an object with a "kind":
          create_folder  path
          copy           source, destination
          move           source, destination
          rename         path, new_name
          write          path, content, expected_base (required when the file exists)
          trash          path
          tag            path, tags
          archive        sources, destination
          unarchive      archive, destination

        The batch is ordered for you, checked for conflicts and shown to the \
        person before any of it happens, so put everything related in one call \
        rather than calling this repeatedly.
        """
    public let schema = WorkToolSchema([
        .init("operations", .objectArray, "The changes to make, in any order.", required: true)
    ])

    public var approvalBinding: WorkApprovalBinding { .aPlanTheToolBuilds }

    /// The risk of the batch, read from the kinds alone.
    ///
    /// Falls back to `.edit` rather than `.safe` when nothing parses. A batch
    /// whose contents could not be read is not a batch that changes nothing, and
    /// the arguments are parsed properly a moment later anyway.
    public func assessRisk(input: WorkToolValue) -> WorkRiskLevel {
        let kinds = (input["operations"]?.arrayValue ?? []).compactMap {
            $0["kind"]?.stringValue.flatMap(WorkFileOperation.Kind.init(rawValue:))
        }
        return kinds.map(WorkRisk.level(of:)).max() ?? .edit
    }

    public func summary(input: WorkToolValue) -> String {
        let count = input["operations"]?.arrayValue?.count ?? 0
        return "Make \(count) \(count == 1 ? "change" : "changes") in this folder"
    }

    public func execute(input: WorkToolValue, context: WorkToolContext) async throws -> WorkToolResult {
        guard context.authorization == .deferredToTheTool else {
            // Reached only by calling `executeAuthorized` behind the registry's
            // back. This tool asks for itself and must not run on an authority
            // granted for something else.
            throw WorkToolError.denied(
                reason: "Juno did not have permission to make these changes, so it made none."
            )
        }

        let parsed = try Self.parse(input)
        let plan = try WorkBatchPlan.plan(
            grantID: files.grantID,
            operations: parsed.operations,
            against: await snapshot(covering: parsed.operations)
        )
        let preview = plan.preview()
        await context.emit(Self.previewSentence(preview))

        let outcome = await context.approvals.authorize(
            action: name,
            runID: context.runID,
            actionDigest: plan.digest,
            risk: WorkRisk.level(of: plan),
            mode: files.mode,
            summary: preview.headline
        )
        let approval: WorkBatchApproval
        switch outcome {
        case .denied(let reason):
            throw WorkToolError.denied(reason: reason)
        case .approved(let receipt):
            // The digest re-check the whole batch path turns on, made against
            // the plan that is about to run rather than the one that was shown.
            guard receipt.authorizes(digest: plan.digest, at: Date()) else {
                throw WorkToolError.denied(
                    reason: "These are not the changes you approved, so Juno did not run them."
                )
            }
            approval = receipt.batchApproval(grantID: files.grantID)
        case .allowed:
            // Nobody was asked, because the person's standing policy already
            // covers changes of this risk. The executor still demands an
            // approval bound to this plan, so one is minted for this digest and
            // this moment — it is not somebody's yes and is never stored. What
            // it buys is that the executor's digest, grant and expiry checks
            // still run against the exact batch that was previewed.
            let decidedAt = Date()
            approval = WorkBatchApproval(
                grantID: files.grantID,
                planDigest: plan.digest,
                decidedAt: decidedAt,
                expiresAt: decidedAt.addingTimeInterval(Self.standingApprovalWindow)
            )
        }

        let execution = try await batches.execute(
            plan,
            approvedBy: approval,
            writeContents: parsed.writeContents
        )
        // Recorded even when the batch stopped partway: what ran is exactly what
        // an undo has to reverse, and a half-applied batch is precisely when
        // somebody reaches for it.
        await undo.record(execution.journal, grantID: files.grantID, forRun: context.runID)

        var detail: [String: WorkToolValue] = [
            "planDigest": .string(plan.digest),
            "applied": .number(Double(execution.appliedOperationCount)),
            "planned": .number(Double(plan.operations.count)),
            "headline": .string(preview.headline),
        ]
        guard let failure = execution.failure else {
            return WorkToolResult(
                content: "Applied all \(execution.appliedOperationCount) changes.",
                detail: detail
            )
        }
        detail["stoppedAt"] = .number(Double(failure.operationIndex))
        return WorkToolResult(
            content: """
                Applied \(execution.appliedOperationCount) of \(plan.operations.count) changes \
                and stopped at change \(failure.operationIndex + 1) (\(failure.kind.verb)): \
                \(failure.reason)
                """,
            isError: true,
            detail: detail
        )
    }

    // MARK: Building the batch

    private struct Parsed {
        let operations: [WorkFileOperation]
        let writeContents: [GrantedPath: Data]
    }

    private static func parse(_ input: WorkToolValue) throws -> Parsed {
        guard let raw = input["operations"]?.arrayValue, !raw.isEmpty else {
            throw WorkToolError.invalidInput(message: "'operations' must list at least one change.")
        }
        var operations: [WorkFileOperation] = []
        var writeContents: [GrantedPath: Data] = [:]
        for (index, element) in raw.enumerated() {
            do {
                guard let kindName = element["kind"]?.stringValue else {
                    throw WorkToolError.invalidInput(message: "Missing 'kind'.")
                }
                guard let kind = WorkFileOperation.Kind(rawValue: kindName) else {
                    // Refused rather than guessed. A near-miss like "delete"
                    // resolved to the closest thing Juno does understand is how
                    // an intent to remove something becomes a move somebody
                    // never asked for.
                    throw WorkToolError.invalidInput(
                        message: "Juno has no change of kind '\(kindName)'."
                    )
                }
                switch kind {
                case .createFolder:
                    operations.append(.createFolder(path: try grantedPath(from: element)))
                case .copy:
                    operations.append(
                        .copy(
                            source: try grantedPath(from: element, field: "source"),
                            destination: try grantedPath(from: element, field: "destination")
                        )
                    )
                case .move:
                    operations.append(
                        .move(
                            source: try grantedPath(from: element, field: "source"),
                            destination: try grantedPath(from: element, field: "destination")
                        )
                    )
                case .rename:
                    guard let newName = element["new_name"]?.stringValue else {
                        throw WorkToolError.invalidInput(message: "Missing 'new_name'.")
                    }
                    operations.append(
                        .rename(path: try grantedPath(from: element), newName: newName)
                    )
                case .write:
                    let path = try grantedPath(from: element)
                    guard let content = element["content"]?.stringValue else {
                        throw WorkToolError.invalidInput(message: "Missing 'content'.")
                    }
                    let bytes = Data(content.utf8)
                    // The plan carries the fingerprint, never the bytes: a
                    // preview a person reads on a phone is not a data transfer.
                    // The bytes travel beside it and the executor checks them
                    // against the fingerprint that was approved.
                    writeContents[path] = bytes
                    operations.append(
                        .write(
                            path: path,
                            content: WorkContentFingerprint(of: bytes),
                            expectedBase: try fingerprintToken(from: element, field: "expected_base")
                        )
                    )
                case .trash:
                    operations.append(.trash(path: try grantedPath(from: element)))
                case .tag:
                    guard let tags = element["tags"]?.arrayValue?.compactMap(\.stringValue) else {
                        throw WorkToolError.invalidInput(
                            message: "Missing 'tags', which must be an array of strings."
                        )
                    }
                    operations.append(.tag(path: try grantedPath(from: element), tags: tags))
                case .archive:
                    guard let sources = element["sources"]?.arrayValue else {
                        throw WorkToolError.invalidInput(
                            message: "Missing 'sources', which must be an array of locations."
                        )
                    }
                    operations.append(
                        .archive(
                            sources: try sources.map { source in
                                guard let raw = source.stringValue else {
                                    throw WorkToolError.invalidInput(
                                        message: "'sources' must be an array of locations."
                                    )
                                }
                                do {
                                    return try GrantedPath(raw)
                                } catch {
                                    throw WorkToolError.invalidInput(
                                        message: "'sources' names a location Juno cannot use. \(error.localizedDescription)"
                                    )
                                }
                            },
                            destination: try grantedPath(from: element, field: "destination")
                        )
                    )
                case .unarchive:
                    operations.append(
                        .unarchive(
                            archive: try grantedPath(from: element, field: "archive"),
                            destination: try grantedPath(from: element, field: "destination")
                        )
                    )
                }
            } catch let error as WorkToolError {
                guard case .invalidInput(let message) = error else { throw error }
                // Numbered from one, because the person and the model are both
                // reading a list, and "operation 0" is nobody's third item.
                throw WorkToolError.invalidInput(message: "Change \(index + 1): \(message)")
            }
        }
        return Parsed(operations: operations, writeContents: writeContents)
    }

    /// What the folder looks like right now, for the locations this batch is
    /// about.
    ///
    /// A photograph, and treated as one: the planner uses it to order the batch
    /// and to say what would collide, and the executor re-checks every one of
    /// those conclusions against the real folder immediately before it acts. The
    /// person may have spent four minutes reading the preview.
    private func snapshot(covering operations: [WorkFileOperation]) async -> WorkFileSnapshot {
        var interesting: Set<GrantedPath> = []
        for operation in operations {
            interesting.formUnion(operation.touchedPaths)
            interesting.formUnion(operation.requires)
        }
        var facts: [GrantedPath: WorkPathFacts] = [:]
        for path in interesting.sorted() {
            guard let metadata = try? await files.metadata(of: path) else { continue }
            var fingerprint: WorkContentFingerprint?
            if !metadata.isDirectory, metadata.byteCount <= Self.maximumFingerprintBytes {
                fingerprint = try? await files.fingerprint(of: path)
            }
            facts[path] = WorkPathFacts(
                exists: true,
                isDirectory: metadata.isDirectory,
                fingerprint: fingerprint
            )
        }
        return WorkFileSnapshot(facts)
    }

    /// The preview as one line of prose, for the transcript.
    ///
    /// Names and counts only, never a location — the preview is display-safe by
    /// construction and this must not be the place that undoes that.
    private static func previewSentence(_ preview: WorkBatchPreview) -> String {
        var sentence = preview.headline
        if preview.conflictCount > 0 {
            sentence += ", replacing \(preview.conflictCount) that already exist"
        }
        if preview.noOpCount > 0 {
            sentence += ", with \(preview.noOpCount) that would change nothing"
        }
        return sentence + "."
    }
}

/// The only route to an unrecoverable delete, and it stops and asks every time.
///
/// ``WorkFileService`` has no permanent-delete method at all, so this is the one
/// call site in Work that unlinks something a person put in their folder. Four
/// things guard it and all four are load-bearing:
///
/// 1. A grant shared without permission to remove anything refuses in
///    ``precheck(input:)``, before the action can even be offered for approval.
///    A "no delete" grant that still permitted a *permanent* delete when it
///    forbids the Trash would be nobody's reading of what they agreed to.
/// 2. ``WorkRisk`` classifies it `irreversible`, which no policy, mode or
///    standing allowance can lower to an automatic yes.
/// 3. This tool re-checks the receipt itself, against a digest recomputed from
///    the arguments it is about to act on. Calling
///    ``WorkToolRegistry/executeAuthorized(toolName:input:context:)`` directly
///    does not skip the question — it fails it.
/// 4. The location is resolved through the grant immediately before the unlink,
///    so a folder that became a symlink out of the grant while the person was
///    deciding cannot be followed.
public struct PermanentlyDeleteTool: WorkTool {
    private let access: any GrantAccessing
    private let files: WorkFileService

    public init(access: any GrantAccessing, files: WorkFileService) {
        self.access = access
        self.files = files
    }

    public let name = "permanently_delete"
    public let description = """
        Delete one file for good, without putting it in the Trash. This cannot \
        be undone and always asks the person first, whatever their settings say. \
        Use apply_changes with a "trash" change unless they explicitly asked for \
        a permanent deletion.
        """
    public let schema = WorkToolSchema([
        .init("path", .string, "The file to delete for good.", required: true)
    ])

    public func assessRisk(input: WorkToolValue) -> WorkRiskLevel { .irreversible }

    public func irreversibleAction(input: WorkToolValue) -> WorkIrreversibleAction? {
        .permanentDelete
    }

    public func precheck(input: WorkToolValue) -> WorkToolError? {
        guard !access.mode.allowsTrash else { return nil }
        return .denied(
            reason: "This folder was shared with Juno without permission to remove anything, so Juno cannot delete from it at all."
        )
    }

    public func summary(input: WorkToolValue) -> String {
        "Permanently delete \(input["path"]?.stringValue ?? "a file"), which cannot be undone"
    }

    public func execute(input: WorkToolValue, context: WorkToolContext) async throws -> WorkToolResult {
        let path = try grantedPath(from: input)
        guard case .approved(let receipt) = context.authorization,
            receipt.authorizes(digest: actionDigest(input: input), at: Date())
        else {
            throw WorkGrantAccessError.permanentDeleteRequiresApproval(path: path.value)
        }

        let url = try access.resolveForReading(path)
        var isDirectory: ObjCBool = false
        FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
        guard !isDirectory.boolValue else {
            // A folder is an unknown number of items, and the approval named
            // one. Whatever the person read, it was not a list of everything
            // inside a directory tree.
            throw WorkToolError.denied(
                reason: "\(path.displayName) is a folder. Juno only ever deletes one file at a time for good."
            )
        }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            throw WorkToolError.executionFailed(
                message: "Juno could not delete \(path.displayName) (\(error.localizedDescription))."
            )
        }
        return WorkToolResult(
            content: "Permanently deleted \(path.value). This cannot be undone.",
            detail: ["deleted": .string(path.displayName)]
        )
    }
}
