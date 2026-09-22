import Foundation

/// What one workspace path held at a moment: nothing, or a file.
///
/// A file is named by the SHA-256 of its bytes rather than carrying them. The
/// journal that lists a turn's files is rewritten after every agent write, so
/// it has to stay small; the bytes themselves are stored once, by digest,
/// beside it.
public enum TurnFileState: Hashable, Codable, Sendable {
    case absent
    /// `permissions` is the POSIX mode, so a restored script is still
    /// executable. Nil when it could not be read.
    case file(sha256: String, byteCount: Int, permissions: Int?)

    public var exists: Bool {
        if case .file = self { return true }
        return false
    }

    public var sha256: String? {
        if case let .file(sha256, _, _) = self { return sha256 }
        return nil
    }

    /// Same existence and same bytes. Permissions are not content: a reader
    /// who only ran `chmod` has not edited the file.
    public func hasSameContent(as other: TurnFileState) -> Bool {
        exists == other.exists && sha256 == other.sha256
    }

    /// Same content, and the same mode wherever this state recorded one. A
    /// restore compares with this, so a file whose bytes came back but whose
    /// mode did not is still restored rather than skipped as unchanged.
    public func matches(_ target: TurnFileState) -> Bool {
        guard hasSameContent(as: target) else { return false }
        guard case let .file(_, _, wanted?) = target,
              case let .file(_, _, actual) = self
        else { return true }
        return actual == wanted
    }
}

/// One path a turn changed: how it was before the turn first touched it, and
/// how the agent last left it.
public struct TurnFileSnapshot: Hashable, Codable, Sendable {
    public let path: WorkspacePath
    /// Written back when the reader rewinds code to this turn.
    public let before: TurnFileState
    /// The agent's last write in the turn. When the disk no longer matches it,
    /// someone else — the reader, another tool — changed the file since, and a
    /// rewind must ask before discarding that.
    public var after: TurnFileState

    public init(path: WorkspacePath, before: TurnFileState, after: TurnFileState) {
        self.path = path
        self.before = before
        self.after = after
    }
}

/// Why a turn's snapshots cannot restore it whole. Either makes code rewind
/// unavailable for this turn and every earlier one, since restoring those
/// needs this turn's pre-images too.
public enum TurnSnapshotGap: String, Codable, Sendable {
    /// Dropped to keep the session's snapshots under the storage cap.
    case pruned
    /// A file the turn changed was too large to snapshot, or its snapshot could
    /// not be written.
    case notCaptured
}

/// The files one of the reader's turns changed, keyed by the turn's prompt.
///
/// A turn is everything the agent did between one message from the reader and
/// the next — a prompt that starts a run, or a steered or queued message that
/// entered the model's context mid-run. `id` is the transcript event of that
/// message, which is what a rewind names.
public struct TurnCheckpoint: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let sessionID: CodeSessionID
    public let openedAt: Date
    /// In the order the turn first touched each path.
    public var files: [TurnFileSnapshot]
    public var gap: TurnSnapshotGap?

    public init(
        id: String,
        sessionID: CodeSessionID,
        openedAt: Date,
        files: [TurnFileSnapshot] = [],
        gap: TurnSnapshotGap? = nil
    ) {
        self.id = id
        self.sessionID = sessionID
        self.openedAt = openedAt
        self.files = files
        self.gap = gap
    }

    /// The net effect of a run of consecutive turns, one entry per path.
    ///
    /// The *earliest* pre-image wins: restoring to the first of these turns
    /// means undoing all of them, so a path touched in three turns goes back
    /// to what it was before the first. The *latest* post-state wins too,
    /// because that is what the agent left on disk last.
    public static func netChanges<Turns: Collection>(
        of turns: Turns
    ) -> [TurnFileSnapshot] where Turns.Element == TurnCheckpoint {
        var order: [WorkspacePath] = []
        var merged: [WorkspacePath: TurnFileSnapshot] = [:]
        for turn in turns {
            for file in turn.files {
                if var existing = merged[file.path] {
                    existing.after = file.after
                    merged[file.path] = existing
                } else {
                    order.append(file.path)
                    merged[file.path] = file
                }
            }
        }
        return order.compactMap { merged[$0] }
    }
}

/// One file a code rewind would change, as the confirmation lists it.
public struct TurnRestoreFile: Hashable, Sendable, Identifiable {
    public enum Change: String, Sendable {
        /// The file exists and goes back to its earlier content.
        case revert
        /// The turn deleted it; it comes back.
        case recreate
        /// The turn created it; it goes.
        case remove
    }

    public var id: String { path.value }
    public let path: WorkspacePath
    public let change: Change
    /// The file changed after the agent last wrote it, so restoring it
    /// discards someone else's edit.
    public let hasDiverged: Bool

    public init(path: WorkspacePath, change: Change, hasDiverged: Bool) {
        self.path = path
        self.change = change
        self.hasDiverged = hasDiverged
    }
}

public enum TurnCheckpointError: Error, Equatable, Sendable {
    /// No snapshot was recorded for this turn — it predates turn checkpoints,
    /// or ran without a workspace.
    case notRecorded
    /// This turn, or a later one, cannot be restored whole.
    case incomplete(TurnSnapshotGap)
    /// These files changed after the agent last wrote them. Restoring again
    /// with `force` is the reader's explicit "Restore Anyway".
    case diverged(paths: [String])
    case restoreFailed(path: String, message: String)
}

/// Snapshots files before an agent turn first changes them, so the turn can
/// be rewound later.
///
/// Deliberately separate from ``Checkpointing``. Those are per mutation and
/// back the per-file revert in the Changes panel; these are per *turn* and
/// back a rewind of everything from one of the reader's messages onwards. The
/// two answer different questions, and one store trying to answer both would
/// either snapshot every write twice or lose the turn boundary.
public protocol TurnCheckpointing: Sendable {
    /// Starts the turn every later capture for `sessionID` belongs to.
    func openTurn(id: String, sessionID: CodeSessionID, openedAt: Date) async

    /// Records `path`'s current state as the open turn's pre-image, unless
    /// this turn already has one for it. Called immediately before an agent
    /// tool changes the path.
    func capturePreImage(of path: WorkspacePath, sessionID: CodeSessionID) async

    /// Records what an agent tool left at `path`, whether or not the change
    /// went through. Called immediately after.
    func recordAgentWrite(to path: WorkspacePath, sessionID: CodeSessionID) async
}
