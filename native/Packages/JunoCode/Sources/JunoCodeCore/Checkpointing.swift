import Foundation

public enum CheckpointError: Error, Equatable, Sendable {
    case notFound(id: String)
    case currentContentDiverged(path: String)
    case restoreFailed(path: String, message: String)
}

/// A per-file snapshot captured immediately before a mutation.
///
/// `preContent == nil` means the file did not exist before the change (undo
/// deletes it). `postFingerprint` records what the mutation produced; undo is
/// refused when the file has diverged from it since.
public struct Checkpoint: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let sessionID: CodeSessionID
    public let path: WorkspacePath
    public let createdAt: Date
    public let preContent: String?
    public let postFingerprint: FileFingerprint?

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        path: WorkspacePath,
        createdAt: Date,
        preContent: String?,
        postFingerprint: FileFingerprint?
    ) {
        self.id = id
        self.sessionID = sessionID
        self.path = path
        self.createdAt = createdAt
        self.preContent = preContent
        self.postFingerprint = postFingerprint
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
