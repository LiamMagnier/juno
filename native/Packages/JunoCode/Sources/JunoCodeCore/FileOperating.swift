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
    /// A change set that cannot be applied as asked — a path named twice, a
    /// move onto an existing file — refused before anything was written.
    case invalidChangeSet(message: String)
}

extension FileOperationError: CustomStringConvertible {
    /// A sentence a model can act on. The tool loop reports a thrown error by
    /// its description, and the synthesized one (`concurrentModification(path:
    /// "a")`) names the case without saying what to do about it.
    public var description: String {
        switch self {
        case let .notFound(path):
            return "\(path) does not exist."
        case let .alreadyExists(path):
            return "\(path) already exists."
        case let .isADirectory(path):
            return "\(path) is a directory."
        case let .notUTF8Text(path):
            return "\(path) is not UTF-8 text."
        case let .tooLarge(path, byteCount, maximumBytes):
            return "\(path) is \(byteCount) bytes, over the \(maximumBytes)-byte limit."
        case let .concurrentModification(path):
            return "\(path) changed since it was read. Read it again and redo the edit against the current content."
        case let .baseFingerprintRequired(path):
            return "\(path) already exists; pass the base_sha256 read_file returned for it."
        case let .patchFailed(path, underlying):
            return "\(path): the edit did not apply (\(underlying))."
        case let .ioFailure(path, message):
            return "\(path): \(message)"
        case let .invalidChangeSet(message):
            return message
        }
    }
}

/// One file's part of a change set: the content it should end with, and the
/// state it must be in now for the change to apply.
///
/// Every request that touches an existing file carries the fingerprint of
/// the content the new content was computed from. The service re-checks each
/// one immediately before writing, so a file edited between the caller's read
/// and the write fails the whole set rather than being silently overwritten.
public enum FileChangeRequest: Equatable, Sendable {
    /// Create a file that must not exist yet.
    case create(path: WorkspacePath, content: String)
    /// Replace an existing file's content, optionally moving it to `moveTo`
    /// (which must not exist yet) in the same step.
    case update(path: WorkspacePath, content: String, expectedBase: FileFingerprint, moveTo: WorkspacePath? = nil)
    /// Delete an existing file.
    case delete(path: WorkspacePath, expectedBase: FileFingerprint)

    public var path: WorkspacePath {
        switch self {
        case let .create(path, _), let .update(path, _, _, _), let .delete(path, _):
            return path
        }
    }

    /// The source path and, for a move, its destination.
    public var touchedPaths: [WorkspacePath] {
        if case let .update(path, _, _, moveTo?) = self, moveTo != path {
            return [path, moveTo]
        }
        return [path]
    }
}

/// The raw bytes of a workspace file, for content that is not text: an image
/// or a PDF.
public struct FileDataReadResult: Equatable, Sendable {
    public let path: WorkspacePath
    /// At most the requested number of bytes, from the start of the file.
    public let data: Data
    /// The file's full size on disk.
    public let totalByteCount: Int

    public init(path: WorkspacePath, data: Data, totalByteCount: Int) {
        self.path = path
        self.data = data
        self.totalByteCount = totalByteCount
    }

    public var isComplete: Bool { data.count == totalByteCount }
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

    /// Reads up to `maximumBytes` of a file's raw bytes, whatever they encode.
    func readData(_ path: WorkspacePath, maximumBytes: Int) async throws -> FileDataReadResult

    /// Applies every change or none of them.
    ///
    /// Every request is validated first — containment, existence, the
    /// expected fingerprints, sizes — then one checkpoint covering every path
    /// is recorded, and the writes run in order. A failure part-way puts back
    /// what this call already changed before the error is thrown. Results
    /// come back in request order.
    func applyChangeSet(
        _ changes: [FileChangeRequest],
        sessionID: CodeSessionID
    ) async throws -> [FileMutationResult]
}
