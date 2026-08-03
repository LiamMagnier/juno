import Foundation

public enum CheckpointError: Error, Equatable, Sendable {
    case notFound(id: String)
    case currentContentDiverged(path: String)
    case restoreFailed(path: String, message: String)
}

/// One path touched by an operation, with the state it was in before and the
/// state the operation was expected to leave it in.
///
/// `preContent == nil` means the path did not exist beforehand, so undoing
/// removes it. `postFingerprint == nil` means the operation left nothing there,
/// so undoing recreates it.
public struct CheckpointEntry: Hashable, Codable, Sendable {
    public let path: WorkspacePath
    public let preContent: String?
    public let postFingerprint: FileFingerprint?

    public init(
        path: WorkspacePath,
        preContent: String?,
        postFingerprint: FileFingerprint?
    ) {
        self.path = path
        self.preContent = preContent
        self.postFingerprint = postFingerprint
    }
}

/// A snapshot captured immediately before a mutation, covering **every** path
/// the mutation touches.
///
/// It began as one path per checkpoint, which is right for a create, a write
/// and a delete but wrong for a move: recording only the source meant undo
/// wrote the source back and left the destination sitting there, so undoing a
/// rename produced two files where there had been one.
///
/// `entries` is the real record. The original single-path fields are still
/// stored and still decoded, so checkpoints written before this change remain
/// readable — `resolvedEntries` presents those as a one-entry operation.
public struct Checkpoint: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let sessionID: CodeSessionID
    public let path: WorkspacePath
    public let createdAt: Date
    public let preContent: String?
    public let postFingerprint: FileFingerprint?
    /// Every path the operation touched. Absent on records written before
    /// operation-level checkpoints existed, which is why it is optional rather
    /// than defaulted — a missing key must decode, not fail.
    public let entries: [CheckpointEntry]?

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        path: WorkspacePath,
        createdAt: Date,
        preContent: String?,
        postFingerprint: FileFingerprint?,
        entries: [CheckpointEntry]? = nil
    ) {
        self.id = id
        self.sessionID = sessionID
        self.path = path
        self.createdAt = createdAt
        self.preContent = preContent
        self.postFingerprint = postFingerprint
        self.entries = entries
    }

    /// An operation spanning several paths.
    ///
    /// `path`, `preContent` and `postFingerprint` are still populated from the
    /// first entry so that anything reading the old shape — persisted JSON, the
    /// history list, a checkpoint written by this build and read by an older
    /// one — keeps seeing a coherent single-path record.
    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        createdAt: Date,
        entries: [CheckpointEntry]
    ) {
        precondition(!entries.isEmpty, "a checkpoint must cover at least one path")
        self.id = id
        self.sessionID = sessionID
        self.createdAt = createdAt
        self.path = entries[0].path
        self.preContent = entries[0].preContent
        self.postFingerprint = entries[0].postFingerprint
        self.entries = entries
    }

    /// The operation's paths, whichever shape it was persisted in.
    public var resolvedEntries: [CheckpointEntry] {
        if let entries, !entries.isEmpty { return entries }
        return [
            CheckpointEntry(
                path: path,
                preContent: preContent,
                postFingerprint: postFingerprint
            )
        ]
    }
}

public protocol Checkpointing: Sendable {
    /// Records a snapshot captured before a mutation and returns its id.
    func record(_ checkpoint: Checkpoint) async throws

    /// Updates the post-mutation fingerprint once the change has landed.
    func sealCheckpoint(id: String, postFingerprint: FileFingerprint?) async throws

    func checkpoint(id: String) async -> Checkpoint?

    /// All checkpoints for a session, most recent first.
    func checkpoints(for sessionID: CodeSessionID) async -> [Checkpoint]

    /// Restores the pre-mutation content for one checkpoint after verifying
    /// the file still matches the checkpoint's post-mutation fingerprint.
    /// `force` skips the divergence check for explicit user-driven rollback.
    func restore(id: String, force: Bool) async throws

    func removeCheckpoints(for sessionID: CodeSessionID) async throws
}
