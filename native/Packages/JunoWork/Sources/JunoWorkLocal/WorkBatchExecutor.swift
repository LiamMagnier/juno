import Foundation
import JunoWorkCore

// MARK: - Refusals that happen before anything is applied

/// Reasons a batch never starts.
///
/// Every case here is thrown, and throwing is the signal that **nothing was
/// applied**. Once the first operation has run the executor stops throwing and
/// starts returning a ``WorkBatchExecution``, because a thrown error carries no
/// journal and a batch that changed eleven files and then threw would leave the
/// caller with no way to name what changed.
public enum WorkBatchExecutionRefusal: Error, Equatable, Sendable {
    /// The plan's stored digest is not the digest of the operations it is
    /// carrying.
    case planDigestDoesNotMatchItsOperations
    /// The approval names a different batch, a different grant, or has expired.
    case approvalDoesNotAuthorizeThisPlan
    case planIsForADifferentGrant(planGrantID: String, grantID: String)
    case modeForbidsOperations(indices: [Int], mode: WorkAccessMode)
    /// A write in the plan has no bytes to write.
    case writeContentMissing(path: String)
    /// The supplied bytes are not the bytes whose fingerprint was approved.
    case writeContentDoesNotMatchApproval(path: String)
}

extension WorkBatchExecutionRefusal: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .planDigestDoesNotMatchItsOperations:
            "This list of changes does not match its own summary, so Juno did not run it."
        case .approvalDoesNotAuthorizeThisPlan:
            "These are not the changes you approved, so Juno did not run them."
        case .planIsForADifferentGrant:
            "These changes were prepared for a different folder."
        case .modeForbidsOperations(let indices, _):
            "\(indices.count == 1 ? "One of these changes" : "\(indices.count) of these changes") is not something this folder was shared with Juno for."
        case .writeContentMissing(let path):
            "Juno no longer has the text it was going to write to \(path)."
        case .writeContentDoesNotMatchApproval(let path):
            "The text Juno was going to write to \(path) is not the text you approved."
        }
    }
}

/// Why one operation stopped the batch.
public enum WorkBatchOperationFailure: Error, Equatable, Sendable {
    case sourceMissing(path: String)
    /// Something is at the destination that was not there when the batch was
    /// previewed, so replacing it was never approved.
    case unapprovedConflict(path: String)
    /// The destination held something different from what the planner saw.
    case destinationChangedSincePlanning(path: String)
    /// Replacing a whole folder is refused: there is no way to put it back.
    case wouldReplaceAFolder(path: String)
    /// The journal could not be written, so a change made now could not be
    /// described afterwards.
    case journalNotPersisted(message: String)
}

extension WorkBatchOperationFailure: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .sourceMissing(let path):
            "\(path) is no longer there, so Juno stopped."
        case .unapprovedConflict(let path):
            "Something new is at \(path) that was not there when you approved this, so Juno stopped rather than replace it."
        case .destinationChangedSincePlanning(let path):
            "\(path) changed after you approved this, so Juno stopped rather than replace the newer version."
        case .wouldReplaceAFolder(let path):
            "Finishing this would replace the whole folder at \(path), and Juno cannot put a folder back."
        case .journalNotPersisted(let message):
            "Juno could not record what it was about to do (\(message)), so it stopped — a change it cannot describe is a change you cannot undo."
        }
    }
}

// MARK: - What came of it

/// The result of applying a batch: what ran, and what stopped it.
public struct WorkBatchExecution: Sendable {
    public struct Failure: Sendable {
        public let operationIndex: Int
        public let kind: WorkFileOperation.Kind
        public let reason: String
    }

    public let planDigest: String
    /// Exactly the operations that were applied, in the order they ran. This is
    /// what an undo reverses — no more, and never less.
    public let journal: UndoJournal
    public let failure: Failure?

    public var appliedOperationCount: Int { journal.records.count }
    public var isComplete: Bool { failure == nil }

    fileprivate init(planDigest: String, journal: UndoJournal, failure: Failure?) {
        self.planDigest = planDigest
        self.journal = journal
        self.failure = failure
    }
}

// MARK: - The executor

/// Applies a ``WorkBatchPlan`` as transactionally as a filesystem allows, and
/// writes the undo journal as it goes.
///
/// A filesystem has no transactions, so "transactional" here means three
/// specific things and no more:
///
/// - **Everything that can be refused is refused before anything is applied.**
///   The digest, the approval, the grant, the mode and the bytes for every write
///   are all checked while the folder is untouched.
/// - **The journal is written after every operation, not at the end.** The case
///   the journal exists for is the one where the process does not reach the end
///   — a crash, a forced quit, a Mac going to sleep mid-batch — and a journal
///   flushed once at the end describes only the batches that never needed it. If
///   the flush fails, the batch stops: a change Juno cannot describe is a change
///   the person cannot undo.
/// - **A failure partway stops immediately and hands back the journal**, so the
///   caller can undo precisely what was applied rather than guessing.
///
/// Every path is re-resolved through the grant at execution time. The plan was
/// made earlier — possibly minutes earlier, while somebody read the preview on
/// their phone — and in that time a folder inside the grant can have been
/// replaced by a symlink pointing somewhere else.
public final class WorkBatchExecutor: Sendable {
    private let access: any GrantAccessing
    private let service: WorkFileService
    private let replacedContentDirectory: URL
    private let journalURL: URL?

    /// - Parameters:
    ///   - replacedContentDirectory: where the bytes of files this batch
    ///     replaces are kept so an undo can put them back.
    ///     **Must be outside every grant** — a stash inside the folder being
    ///     reorganised would itself be reorganised — and must outlive the batch
    ///     for as long as undo is offered.
    ///   - journalURL: where the journal is flushed after each operation. Nil
    ///     means the caller accepts losing the record if the process dies, which
    ///     is only reasonable for a batch nobody will be offered an undo for.
    public init(
        access: any GrantAccessing,
        service: WorkFileService,
        replacedContentDirectory: URL,
        journalURL: URL? = nil
    ) {
        self.access = access
        self.service = service
        self.replacedContentDirectory = replacedContentDirectory
        self.journalURL = journalURL
    }

    // MARK: - Executing

    /// Applies a plan the person approved.
    ///
    /// - Parameter writeContents: the bytes for every ``WorkFileOperation/write``
    ///   in the plan. The plan carries only fingerprints — a batch preview is
    ///   not a data transfer — so the bytes arrive separately and are checked
    ///   against the approved fingerprint before anything is written.
    /// - Throws: ``WorkBatchExecutionRefusal`` when the batch never starts.
    ///   Anything that goes wrong once it has started is reported on the
    ///   returned value instead, with the journal.
    public func execute(
        _ plan: WorkBatchPlan,
        approvedBy approval: WorkBatchApproval,
        writeContents: [GrantedPath: Data] = [:],
        at now: Date = Date()
    ) async throws -> WorkBatchExecution {
        // Re-derived from the operations rather than trusted. A plan travels
        // over the relay next to an approval that names a digest; if the stored
        // digest were taken on faith, a plan whose operations were edited in
        // transit could carry the digest the person actually approved and every
        // downstream comparison would pass.
        let recomputed = WorkDigests.sha256Hex(
            WorkDigests.canonicalRecord(
                [WorkBatchPlan.digestDomain, plan.grantID.value]
                    + plan.operations.map(\.canonicalForm)
            )
        )
        guard recomputed == plan.digest else {
            throw WorkBatchExecutionRefusal.planDigestDoesNotMatchItsOperations
        }
        guard plan.grantID == access.grantID else {
            throw WorkBatchExecutionRefusal.planIsForADifferentGrant(
                planGrantID: plan.grantID.value,
                grantID: access.grantID.value
            )
        }
        // Covers the digest, the grant and the expiry in one call, so a plan
        // that was rebuilt after the person said yes — a different digest for
        // the same intent — is refused rather than run on last minute's consent.
        guard approval.authorizes(plan, at: now) else {
            throw WorkBatchExecutionRefusal.approvalDoesNotAuthorizeThisPlan
        }
        let forbidden = plan.operationsForbidden(under: access.mode)
        guard forbidden.isEmpty else {
            throw WorkBatchExecutionRefusal.modeForbidsOperations(
                indices: forbidden,
                mode: access.mode
            )
        }
        for operation in plan.operations {
            guard case .write(let path, let content, _) = operation else { continue }
            guard let bytes = writeContents[path] else {
                throw WorkBatchExecutionRefusal.writeContentMissing(path: path.value)
            }
            guard WorkContentFingerprint(of: bytes) == content else {
                throw WorkBatchExecutionRefusal.writeContentDoesNotMatchApproval(path: path.value)
            }
        }

        let plannedFingerprints = Self.fingerprintsRecordedByThePlanner(plan)
        let approvedConflicts = Set(plan.analysis.conflicts.map(\.operationIndex))
        var journal = UndoJournal(planDigest: plan.digest, grantID: plan.grantID)

        for (index, operation) in plan.operations.enumerated() {
            do {
                try Task.checkCancellation()
                let record = try await apply(
                    operation,
                    at: index,
                    approvedConflicts: approvedConflicts,
                    plannedFingerprints: plannedFingerprints,
                    writeContents: writeContents,
                    now: Date()
                )
                journal.record(record)
                try flush(journal)
            } catch {
                return WorkBatchExecution(
                    planDigest: plan.digest,
                    journal: journal,
                    failure: WorkBatchExecution.Failure(
                        operationIndex: index,
                        kind: operation.kind,
                        reason: error.localizedDescription
                    )
                )
            }
        }
        return WorkBatchExecution(planDigest: plan.digest, journal: journal, failure: nil)
    }

    // MARK: - One operation

    private func apply(
        _ operation: WorkFileOperation,
        at index: Int,
        approvedConflicts: Set<Int>,
        plannedFingerprints: [GrantedPath: WorkContentFingerprint],
        writeContents: [GrantedPath: Data],
        now: Date
    ) async throws -> WorkUndoRecord {
        switch operation {
        case .createFolder(let path):
            let created = try await service.createFolder(at: path)
            return WorkUndoRecord(
                operationIndex: index,
                kind: .createFolder,
                newLocation: path,
                destinationExisted: !created,
                appliedAt: now
            )

        case .copy(let source, let destination):
            try requireSource(source)
            let displaced = try displacedItem(
                at: destination,
                operationIndex: index,
                approvedConflicts: approvedConflicts,
                plannedFingerprints: plannedFingerprints
            )
            try await service.copy(
                from: source,
                to: destination,
                replacingApprovedExistingItem: displaced != nil
            )
            return WorkUndoRecord(
                operationIndex: index,
                kind: .copy,
                priorLocation: source,
                newLocation: destination,
                priorFingerprint: displaced,
                destinationExisted: displaced != nil,
                appliedAt: now
            )

        case .move(let source, let destination):
            try requireSource(source)
            let displaced = try displacedItem(
                at: destination,
                operationIndex: index,
                approvedConflicts: approvedConflicts,
                plannedFingerprints: plannedFingerprints
            )
            try await service.move(
                from: source,
                to: destination,
                replacingApprovedExistingItem: displaced != nil
            )
            return WorkUndoRecord(
                operationIndex: index,
                kind: .move,
                priorLocation: source,
                newLocation: destination,
                priorFingerprint: displaced,
                destinationExisted: displaced != nil,
                appliedAt: now
            )

        case .rename(let path, let newName):
            try requireSource(path)
            guard let destination = operation.destination else {
                throw WorkFileServiceError.ioFailure(
                    path: path.value,
                    message: "\"\(newName)\" is not a usable name"
                )
            }
            let displaced = try displacedItem(
                at: destination,
                operationIndex: index,
                approvedConflicts: approvedConflicts,
                plannedFingerprints: plannedFingerprints
            )
            try await service.rename(
                path,
                to: newName,
                replacingApprovedExistingItem: displaced != nil
            )
            return WorkUndoRecord(
                operationIndex: index,
                kind: .rename,
                priorLocation: path,
                newLocation: destination,
                priorFingerprint: displaced,
                destinationExisted: displaced != nil,
                appliedAt: now
            )

        case .write(let path, _, let expectedBase):
            // Checked here as well as in the service, because this is the check
            // that stops the batch and produces a journal rather than throwing
            // out of one method.
            let existing = try existingFingerprint(at: path)
            if let expectedBase, let existing, existing != expectedBase {
                throw WorkFileServiceError.contentChangedUnderneath(path: path.value)
            }
            if let existing { try stash(fingerprint: existing, from: path) }
            guard let bytes = writeContents[path] else {
                throw WorkBatchExecutionRefusal.writeContentMissing(path: path.value)
            }
            try await service.write(path, data: bytes, expectedBase: expectedBase)
            return WorkUndoRecord(
                operationIndex: index,
                kind: .write,
                newLocation: path,
                priorFingerprint: existing,
                destinationExisted: existing != nil,
                appliedAt: now
            )

        case .trash(let path):
            try requireSource(path)
            let token = try await service.trash(path)
            return WorkUndoRecord(
                operationIndex: index,
                kind: .trash,
                priorLocation: path,
                trashToken: token,
                appliedAt: now
            )

        case .tag(let path, let tags):
            try requireSource(path)
            let prior = try service.tags(of: path)
            try await service.setTags(tags, on: path)
            return WorkUndoRecord(
                operationIndex: index,
                kind: .tag,
                newLocation: path,
                priorTags: prior,
                appliedAt: now
            )

        case .archive(let sources, let destination):
            for source in sources { try requireSource(source) }
            let displaced = try displacedItem(
                at: destination,
                operationIndex: index,
                approvedConflicts: approvedConflicts,
                plannedFingerprints: plannedFingerprints
            )
            try await service.archive(
                sources: sources,
                to: destination,
                replacingApprovedExistingItem: displaced != nil
            )
            return WorkUndoRecord(
                operationIndex: index,
                kind: .archive,
                newLocation: destination,
                priorFingerprint: displaced,
                destinationExisted: displaced != nil,
                appliedAt: now
            )

        case .unarchive(let archive, let destination):
            try requireSource(archive)
            let created = try await service.unarchive(archive, into: destination)
            return WorkUndoRecord(
                operationIndex: index,
                kind: .unarchive,
                newLocation: destination,
                createdPaths: created,
                appliedAt: now
            )
        }
    }

    // MARK: - Execution-time checks

    private func requireSource(_ path: GrantedPath) throws {
        guard service.exists(path) else {
            throw WorkBatchOperationFailure.sourceMissing(path: path.value)
        }
    }

    /// Decides whether landing on this destination is allowed, and keeps a copy
    /// of whatever is about to be displaced.
    ///
    /// Three separate questions, and each one has a different wrong answer:
    ///
    /// - Nothing is there: nothing to do.
    /// - Something is there that the preview did **not** show: the person never
    ///   approved replacing it, so the batch stops. This is the file somebody
    ///   saved between reading the preview and tapping approve.
    /// - Something is there that the preview *did* show, but its contents have
    ///   changed since the planner looked: they approved replacing a different
    ///   version, so the batch stops.
    private func displacedItem(
        at destination: GrantedPath,
        operationIndex: Int,
        approvedConflicts: Set<Int>,
        plannedFingerprints: [GrantedPath: WorkContentFingerprint]
    ) throws -> WorkContentFingerprint? {
        guard let url = try? access.resolveForMutation(destination),
            FileManager.default.fileExists(atPath: url.path)
        else { return nil }

        guard approvedConflicts.contains(operationIndex) else {
            throw WorkBatchOperationFailure.unapprovedConflict(path: destination.value)
        }
        var isDirectory: ObjCBool = false
        FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
        guard !isDirectory.boolValue else {
            throw WorkBatchOperationFailure.wouldReplaceAFolder(path: destination.value)
        }
        let current = try ContentFingerprint.fingerprint(ofFileAt: url)
        if let planned = plannedFingerprints[destination], planned != current {
            throw WorkBatchOperationFailure.destinationChangedSincePlanning(
                path: destination.value
            )
        }
        try stash(fingerprint: current, from: destination)
        return current
    }

    private func existingFingerprint(at path: GrantedPath) throws -> WorkContentFingerprint? {
        guard let url = try? access.resolveForMutation(path),
            FileManager.default.fileExists(atPath: url.path)
        else { return nil }
        var isDirectory: ObjCBool = false
        FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
        guard !isDirectory.boolValue else {
            throw WorkFileServiceError.isADirectory(path: path.value)
        }
        return try ContentFingerprint.fingerprint(ofFileAt: url)
    }

    /// The fingerprints the plan itself carries.
    ///
    /// Only duplicate groups record one, so this is a partial picture and is
    /// said to be: ``WorkFileOperation/write(path:content:expectedBase:)``
    /// carries `expectedBase` and is the complete check for a write, while for a
    /// copy or a move over an existing file this is the only evidence of what
    /// the planner saw. Where there is no evidence there is no check, which is
    /// better than inventing one that always passes.
    private static func fingerprintsRecordedByThePlanner(
        _ plan: WorkBatchPlan
    ) -> [GrantedPath: WorkContentFingerprint] {
        var result: [GrantedPath: WorkContentFingerprint] = [:]
        for group in plan.analysis.duplicates {
            for path in group.paths { result[path] = group.fingerprint }
        }
        return result
    }

    // MARK: - Replaced content

    /// Keeps the bytes of a file that is about to be replaced.
    ///
    /// Keyed by fingerprint because that is what ``WorkUndoAction/restoreContent(path:fingerprint:)``
    /// names. Two files with identical contents share one stashed copy, which is
    /// correct: the bytes are the same bytes.
    private func stash(fingerprint: WorkContentFingerprint, from path: GrantedPath) throws {
        let url = try access.resolveForReading(path)
        try FileManager.default.createDirectory(
            at: replacedContentDirectory,
            withIntermediateDirectories: true
        )
        let stashed = replacedContentDirectory.appendingPathComponent(fingerprint.sha256)
        guard !FileManager.default.fileExists(atPath: stashed.path) else { return }
        try FileManager.default.copyItem(at: url, to: stashed)
    }

    private func flush(_ journal: UndoJournal) throws {
        guard let journalURL else { return }
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            try FileManager.default.createDirectory(
                at: journalURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try encoder.encode(journal).write(to: journalURL, options: [.atomic])
        } catch {
            throw WorkBatchOperationFailure.journalNotPersisted(
                message: error.localizedDescription
            )
        }
    }

    // MARK: - Undo

    /// Reverses everything a journal records, newest first.
    ///
    /// The refusal-before-starting rule lives in ``UndoJournal/undo(using:)``;
    /// this method only supplies the hands.
    public func undo(_ journal: UndoJournal) async -> WorkUndoOutcome {
        await journal.undo(using: self)
    }
}

// MARK: - Performing an undo

extension WorkBatchExecutor: WorkUndoPerforming {
    public func perform(_ action: WorkUndoAction, for record: WorkUndoRecord) async throws {
        guard access.mode.allowsWrite else {
            throw WorkGrantAccessError.modeForbidsWrite(
                path: record.newLocation?.value ?? record.priorLocation?.value ?? "",
                mode: access.mode
            )
        }
        switch action {
        case .moveBack(let from, let to):
            try await service.move(from: from, to: to)

        case .removeCreated(let path):
            try removeSomethingThisBatchCreated(path, recordedBy: record)

        case .restoreContent(let path, let fingerprint):
            let stashed = replacedContentDirectory.appendingPathComponent(fingerprint.sha256)
            guard FileManager.default.fileExists(atPath: stashed.path) else {
                throw WorkUndoRefusal.replacedContentNotCaptured
            }
            let bytes = try Data(contentsOf: stashed)
            // Verified before it is written back. A stash that no longer hashes
            // to what the journal named is not the file that was replaced, and
            // writing it would put the wrong document back under the right name.
            guard WorkContentFingerprint(of: bytes) == fingerprint else {
                throw WorkUndoRefusal.replacedContentNotCaptured
            }
            try await service.write(path, data: bytes)

        case .restoreFromTrash(let token, let destination):
            let trashed = URL(fileURLWithPath: token)
            guard FileManager.default.fileExists(atPath: trashed.path) else {
                // The person emptied the Trash, or took the file out themselves.
                // Either way Juno cannot put it back and must say so rather than
                // report a successful undo.
                throw WorkUndoRefusal.trashLocationNotCaptured
            }
            let url = try access.resolveForMutation(destination)
            guard !FileManager.default.fileExists(atPath: url.path) else {
                throw WorkFileServiceError.alreadyExists(path: destination.value)
            }
            try FileManager.default.moveItem(at: trashed, to: url)

        case .restoreTags(let path, let tags):
            try await service.setTags(tags, on: path)
        }
    }

    /// Removes something this batch brought into existence.
    ///
    /// **This is the one unlink in the whole layer, and it is deliberately not
    /// on ``WorkFileService``.** Undoing a copy has to remove the copy, and
    /// moving it to the Trash instead would both litter the Trash with files
    /// nobody ever saw and fail outright under a `read_write_no_delete` grant —
    /// a grant that permits the copy in the first place. What makes it safe is
    /// not the mode but the guard below: the location has to be one this journal
    /// recorded as created, so the only things reachable are things that did not
    /// exist before the batch ran.
    private func removeSomethingThisBatchCreated(
        _ path: GrantedPath,
        recordedBy record: WorkUndoRecord
    ) throws {
        guard record.newLocation == path || record.createdPaths.contains(path) else {
            throw WorkUndoRefusal.missingLocation
        }
        let url = try access.resolveForMutation(path)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }
}
