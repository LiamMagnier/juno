import Foundation

public enum FileOperationError: Error, Equatable, Sendable {
    case notFound(path: String)
    case alreadyExists(path: String)
    case isADirectory(path: String)
    case notUTF8Text(path: String)
    case tooLarge(path: String, byteCount: Int, maximumBytes: Int)
    case concurrentModification(path: String)
    /// An overwrite of an existing file arrived with no base fingerprint.
    ///
    /// Distinct from `concurrentModification`, which means a base was supplied
    /// and did not match. The two have different remedies — re-read and retry
    /// versus supply the fingerprint you already have — and collapsing them
    /// sent callers to the wrong one.
    case baseFingerprintRequired(path: String)
    case patchFailed(path: String, underlying: TextPatchError)
    case ioFailure(path: String, message: String)
}

public struct FileReadResult: Equatable, Sendable {
    public let path: WorkspacePath
    /// Possibly truncated text handed to the caller.
    public let content: String
    public let wasTruncated: Bool
    /// Fingerprint of the complete on-disk content, not the truncated view.
    public let fingerprint: FileFingerprint
    public let byteCount: Int
    public let lineCount: Int

    public init(
        path: WorkspacePath,
        content: String,
        wasTruncated: Bool,
        fingerprint: FileFingerprint,
        byteCount: Int,
        lineCount: Int
    ) {
        self.path = path
        self.content = content
        self.wasTruncated = wasTruncated
        self.fingerprint = fingerprint
        self.byteCount = byteCount
        self.lineCount = lineCount
    }
}

public struct FileMutationResult: Equatable, Sendable {
    public let path: WorkspacePath
    public let kind: FileChangeKind
    public let diff: TextDiff?
    public let newFingerprint: FileFingerprint?
    public let checkpointID: String?

    public init(
        path: WorkspacePath,
        kind: FileChangeKind,
        diff: TextDiff?,
        newFingerprint: FileFingerprint?,
        checkpointID: String?
    ) {
        self.path = path
        self.kind = kind
        self.diff = diff
        self.newFingerprint = newFingerprint
        self.checkpointID = checkpointID
    }
}

/// Workspace file operations. Every mutation re-resolves containment through
/// the workspace access gateway immediately before touching the filesystem,
/// captures a checkpoint, and writes atomically.
public protocol FileOperating: Sendable {
    func read(_ path: WorkspacePath, limit: OutputLimit) async throws -> FileReadResult

    /// Creates a new file; fails if the path already exists.
    func create(
        _ path: WorkspacePath,
        content: String,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult

    /// Overwrites or creates a file.
    ///
    /// Overwriting an **existing** file requires `expectedBase`, and fails with
    /// `concurrentModification` when the on-disk content no longer matches it.
    /// Passing nil is only valid for a path that does not exist yet; an
    /// unguarded overwrite is otherwise refused with `baseFingerprintRequired`,
    /// because a blind whole-file write is how an agent silently discards work
    /// it never read.
    func write(
        _ path: WorkspacePath,
        content: String,
        expectedBase: FileFingerprint?,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult

    func applyPatch(
        _ path: WorkspacePath,
        patch: TextPatch,
        expectedBase: FileFingerprint?,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult

    func delete(
        _ path: WorkspacePath,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult

    func move(
        from source: WorkspacePath,
        to destination: WorkspacePath,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult
}
