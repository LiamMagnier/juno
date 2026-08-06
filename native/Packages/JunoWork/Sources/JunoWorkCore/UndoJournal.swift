import Foundation

/// One step of putting a folder back the way it was.
///
/// The journal names *what* must happen; how it happens belongs to whoever
/// applied the batch. `restoreContent` in particular says "put the bytes with
/// this fingerprint back at this location" and assumes the applier kept those
/// bytes — the journal never carries file content, because it is written to disk
/// beside the folder it describes and a journal that holds copies of everything
/// is a second, unmanaged copy of the person's documents.
public enum WorkUndoAction: Hashable, Sendable {
    case moveBack(from: GrantedPath, to: GrantedPath)
    case removeCreated(GrantedPath)
    case restoreContent(path: GrantedPath, fingerprint: WorkContentFingerprint)
    case restoreFromTrash(token: String, to: GrantedPath)
    case restoreTags(path: GrantedPath, tags: [String])
}

/// Everything needed to reverse one operation that actually happened.
///
/// Recorded **after** the operation succeeded and **before** the next one
/// starts, so the journal never claims something was done that was not.
public struct WorkUndoRecord: Hashable, Codable, Sendable {
    /// The operation's index in the plan that was applied, so an undo report can
    /// be lined up against the preview the person approved.
    public let operationIndex: Int
    public let kind: WorkFileOperation.Kind
    /// Where the item was before this operation ran.
    public let priorLocation: GrantedPath?
    /// Where the item is now.
    public let newLocation: GrantedPath?
    /// The content that was at ``newLocation`` before this operation replaced
    /// it, when it replaced something.
    public let priorFingerprint: WorkContentFingerprint?
    /// Whether something was already at the destination.
    ///
    /// The single fact that decides whether undoing means "take the new thing
    /// away" or "put the old thing back", and getting it wrong in the second
    /// direction deletes a file the person never asked to lose.
    public let destinationExisted: Bool
    /// The Trash's own identifier for the item, from the API that put it there.
    /// Without it an undo can find no way back: the Trash renames collisions.
    public let trashToken: String?
    /// The tags the item carried before it was tagged.
    public let priorTags: [String]?
    /// Locations this operation brought into existence that are not
    /// ``newLocation`` — the contents of an unpacked archive.
    public let createdPaths: [GrantedPath]
    public let appliedAt: Date

    public init(
        operationIndex: Int,
        kind: WorkFileOperation.Kind,
        priorLocation: GrantedPath? = nil,
        newLocation: GrantedPath? = nil,
        priorFingerprint: WorkContentFingerprint? = nil,
        destinationExisted: Bool = false,
        trashToken: String? = nil,
        priorTags: [String]? = nil,
        createdPaths: [GrantedPath] = [],
        appliedAt: Date
    ) {
        self.operationIndex = operationIndex
        self.kind = kind
        self.priorLocation = priorLocation
        self.newLocation = newLocation
        self.priorFingerprint = priorFingerprint
        self.destinationExisted = destinationExisted
        self.trashToken = trashToken
        self.priorTags = priorTags
        self.createdPaths = createdPaths
        self.appliedAt = appliedAt
    }

    /// The steps that undo this operation, in order, or the reason there are
    /// none.
    public var reversal: Result<[WorkUndoAction], WorkUndoRefusal> {
        switch kind {
        case .createFolder:
            guard let folder = newLocation else { return .failure(.missingLocation) }
            // A folder that was already there was not created, so removing it
            // would delete something the batch never made.
            return .success(destinationExisted ? [] : [.removeCreated(folder)])

        case .copy, .archive:
            guard let destination = newLocation else { return .failure(.missingLocation) }
            guard destinationExisted else { return .success([.removeCreated(destination)]) }
            guard let priorFingerprint else { return .failure(.replacedContentNotCaptured) }
            return .success([.restoreContent(path: destination, fingerprint: priorFingerprint)])

        case .move, .rename:
            guard let priorLocation, let newLocation else { return .failure(.missingLocation) }
            var steps: [WorkUndoAction] = [.moveBack(from: newLocation, to: priorLocation)]
            if destinationExisted {
                guard let priorFingerprint else { return .failure(.replacedContentNotCaptured) }
                // Order matters: the displaced file can only go back once the
                // mover has vacated the name it was occupying.
                steps.append(.restoreContent(path: newLocation, fingerprint: priorFingerprint))
            }
            return .success(steps)

        case .write:
            guard let path = newLocation else { return .failure(.missingLocation) }
            guard destinationExisted else { return .success([.removeCreated(path)]) }
            guard let priorFingerprint else { return .failure(.replacedContentNotCaptured) }
            return .success([.restoreContent(path: path, fingerprint: priorFingerprint)])

        case .trash:
            guard let priorLocation else { return .failure(.missingLocation) }
            guard let trashToken else { return .failure(.trashLocationNotCaptured) }
            return .success([.restoreFromTrash(token: trashToken, to: priorLocation)])

        case .tag:
            guard let path = newLocation ?? priorLocation else { return .failure(.missingLocation) }
            guard let priorTags else { return .failure(.priorTagsNotCaptured) }
            return .success([.restoreTags(path: path, tags: priorTags)])

        case .unarchive:
            guard !createdPaths.isEmpty else { return .failure(.extractedItemsNotCaptured) }
            // Deepest first, so a folder is emptied before it is removed.
            return .success(
                createdPaths.sorted().reversed().map { WorkUndoAction.removeCreated($0) }
            )
        }
    }

    /// Whether this record holds enough to be reversed at all.
    public var isReversible: Bool {
        if case .success = reversal { return true }
        return false
    }
}

/// Why one recorded operation cannot be reversed.
public enum WorkUndoRefusal: Error, Hashable, Sendable {
    case missingLocation
    case replacedContentNotCaptured
    case trashLocationNotCaptured
    case priorTagsNotCaptured
    case extractedItemsNotCaptured
}

extension WorkUndoRefusal: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .missingLocation:
            "Juno did not record where this item came from, so it cannot put it back."
        case .replacedContentNotCaptured:
            "This change replaced a file whose earlier version Juno did not keep, so undoing it would lose that version."
        case .trashLocationNotCaptured:
            "Juno did not record where this went in the Trash, so it cannot bring it back on its own."
        case .priorTagsNotCaptured:
            "Juno did not record this item's earlier tags."
        case .extractedItemsNotCaptured:
            "Juno did not record what came out of this archive, so it cannot tidy it away again."
        }
    }
}

/// Performs one reversal step. Implemented by whoever applied the batch, because
/// only they know where the replaced bytes were kept.
public protocol WorkUndoPerforming: Sendable {
    func perform(_ action: WorkUndoAction, for record: WorkUndoRecord) async throws
}

/// The result of an undo, shaped so it cannot be reported as more than it was.
///
/// There is no initializer outside this file, `isComplete` is derived rather
/// than stored, and the records that were *not* reversed are carried alongside
/// the ones that were. A caller cannot construct "undone" while items remain
/// changed, and cannot show "Undone" without having ignored a value it was
/// handed. Half an undo announced as a whole one is worse than a refused undo:
/// the person stops looking.
public struct WorkUndoOutcome: Hashable, Sendable {
    public struct Failure: Hashable, Sendable {
        /// The operation whose reversal did not finish.
        public let record: WorkUndoRecord
        /// How many of that record's reversal steps had already succeeded, so a
        /// report can say "partly reversed" when that is the truth.
        public let completedSteps: Int
        public let totalSteps: Int
        public let reason: String

        public var wasPartiallyReversed: Bool { completedSteps > 0 && completedSteps < totalSteps }
    }

    /// Fully reversed, in the order they were reversed — newest first, because
    /// an undo runs backwards.
    public let reversed: [WorkUndoRecord]
    /// Still in effect, in the order they were originally applied. Includes the
    /// record that failed.
    public let stillApplied: [WorkUndoRecord]
    public let failure: Failure?

    /// True only when nothing is left in effect and nothing failed.
    public var isComplete: Bool { failure == nil && stillApplied.isEmpty }

    /// True when the journal refused before touching anything.
    public var wasRefusedBeforeStarting: Bool { failure != nil && reversed.isEmpty }

    /// One sentence a person can act on, always naming both halves.
    public var summary: String {
        if stillApplied.isEmpty && failure == nil {
            return reversed.isEmpty
                ? "There was nothing to undo."
                : "Undid all \(reversed.count) changes."
        }
        if reversed.isEmpty {
            return "Nothing was undone. \(failure?.reason ?? "The undo could not start.")"
        }
        return "Undid \(reversed.count) of \(reversed.count + stillApplied.count) changes and stopped. \(failure?.reason ?? "")"
            .trimmingCharacters(in: .whitespaces)
    }

    fileprivate init(reversed: [WorkUndoRecord], stillApplied: [WorkUndoRecord], failure: Failure?) {
        self.reversed = reversed
        self.stillApplied = stillApplied
        self.failure = failure
    }
}

/// Operation-level undo for one applied batch.
///
/// One record per operation that actually ran, across every path that operation
/// touched. A move records both ends; recording only the source is what turns an
/// undone rename into two files.
///
/// **Persistence is the caller's job.** This type is `Codable` and writes
/// nothing: the local layer decides where the journal lives and when it is
/// flushed. It must be flushed *after each operation* rather than at the end of
/// the batch, because the case the journal exists for is the one where the
/// process does not reach the end — a crash, a forced quit, a Mac going to
/// sleep mid-batch. A journal written once at the end describes only the batches
/// that never needed it.
public struct UndoJournal: Hashable, Codable, Sendable {
    /// The digest of the plan that was applied, so a journal cannot be replayed
    /// against a different batch.
    public let planDigest: String
    public let grantID: WorkGrantID
    public private(set) var records: [WorkUndoRecord]

    public init(planDigest: String, grantID: WorkGrantID, records: [WorkUndoRecord] = []) {
        self.planDigest = planDigest
        self.grantID = grantID
        self.records = records
    }

    public var isEmpty: Bool { records.isEmpty }

    public mutating func record(_ record: WorkUndoRecord) {
        records.append(record)
    }

    /// Reverses every recorded operation, newest first, stopping at the first
    /// failure.
    ///
    /// Refuses before touching anything if any record lacks what its reversal
    /// needs. Discovering that on record eleven of forty leaves the folder in a
    /// state nobody planned and nobody can describe; discovering it before the
    /// first step leaves the folder exactly as the person last saw it, which is
    /// a state they can reason about.
    public func undo(using performer: some WorkUndoPerforming) async -> WorkUndoOutcome {
        guard !records.isEmpty else {
            return WorkUndoOutcome(reversed: [], stillApplied: [], failure: nil)
        }
        if let blocking = records.first(where: { !$0.isReversible }) {
            let reason: String
            if case .failure(let refusal) = blocking.reversal {
                reason = refusal.localizedDescription
            } else {
                reason = "This change cannot be undone."
            }
            return WorkUndoOutcome(
                reversed: [],
                stillApplied: records,
                failure: WorkUndoOutcome.Failure(
                    record: blocking,
                    completedSteps: 0,
                    totalSteps: 0,
                    reason: reason
                )
            )
        }

        var reversed: [WorkUndoRecord] = []
        var pending = Array(records.reversed())
        while !pending.isEmpty {
            let record = pending.removeFirst()
            guard case .success(let steps) = record.reversal else { continue }
            var completed = 0
            do {
                for step in steps {
                    try await performer.perform(step, for: record)
                    completed += 1
                }
                reversed.append(record)
            } catch {
                return WorkUndoOutcome(
                    reversed: reversed,
                    stillApplied: Array(([record] + pending).reversed()),
                    failure: WorkUndoOutcome.Failure(
                        record: record,
                        completedSteps: completed,
                        totalSteps: steps.count,
                        reason: error.localizedDescription
                    )
                )
            }
        }
        return WorkUndoOutcome(reversed: reversed, stillApplied: [], failure: nil)
    }
}
