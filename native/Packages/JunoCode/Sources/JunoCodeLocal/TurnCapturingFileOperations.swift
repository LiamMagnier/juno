import Foundation
import JunoCodeCore

/// The file operations the agent's tools are given: the workspace's own,
/// with each path snapshotted into the open turn before a tool changes it.
///
/// A wrapper handed to the tool registry rather than a behaviour of
/// ``FileOperationService`` itself, because the reader writes through that
/// service too — a hunk reverted in the Changes panel, a file saved in the
/// editor. Those are the reader's changes, not the agent's; recorded as the
/// agent's, a rewind would overwrite them without asking.
public struct TurnCapturingFileOperations: FileOperating {
    private let base: any FileOperating
    private let turns: TurnCheckpointStore

    public init(base: any FileOperating, turns: TurnCheckpointStore) {
        self.base = base
        self.turns = turns
    }

    public func read(_ path: WorkspacePath, limit: OutputLimit) async throws -> FileReadResult {
        try await base.read(path, limit: limit)
    }

    public func create(
        _ path: WorkspacePath,
        content: String,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult {
        try await capturing([path], sessionID: sessionID) {
            try await base.create(path, content: content, sessionID: sessionID)
        }
    }

    public func write(
        _ path: WorkspacePath,
        content: String,
        expectedBase: FileFingerprint?,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult {
        try await capturing([path], sessionID: sessionID) {
            try await base.write(path, content: content, expectedBase: expectedBase, sessionID: sessionID)
        }
    }

    public func applyPatch(
        _ path: WorkspacePath,
        patch: TextPatch,
        expectedBase: FileFingerprint?,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult {
        try await capturing([path], sessionID: sessionID) {
            try await base.applyPatch(path, patch: patch, expectedBase: expectedBase, sessionID: sessionID)
        }
    }

    public func delete(
        _ path: WorkspacePath,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult {
        try await capturing([path], sessionID: sessionID) {
            try await base.delete(path, sessionID: sessionID)
        }
    }

    /// Both ends: rewinding a rename has to put the source back *and* take the
    /// destination away.
    public func move(
        from source: WorkspacePath,
        to destination: WorkspacePath,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult {
        try await capturing([source, destination], sessionID: sessionID) {
            try await base.move(from: source, to: destination, sessionID: sessionID)
        }
    }

    public func readData(_ path: WorkspacePath, maximumBytes: Int) async throws -> FileDataReadResult {
        try await base.readData(path, maximumBytes: maximumBytes)
    }

    /// Every path the set touches, a move's destination included.
    public func applyChangeSet(
        _ changes: [FileChangeRequest],
        sessionID: CodeSessionID
    ) async throws -> [FileMutationResult] {
        try await capturing(changes.flatMap(\.touchedPaths), sessionID: sessionID) {
            try await base.applyChangeSet(changes, sessionID: sessionID)
        }
    }

    /// Reads each path before, and records the outcome after — on failure
    /// too: whatever a tool left on disk is what the agent last left there,
    /// and a rewind judges every later edit against it. A pre-image is only
    /// kept for a path the operation changed, so one the service refused
    /// costs the turn nothing.
    private func capturing<Value: Sendable>(
        _ paths: [WorkspacePath],
        sessionID: CodeSessionID,
        _ operation: () async throws -> Value
    ) async throws -> Value {
        var preImages: [TurnCheckpointStore.PreImage?] = []
        for path in paths {
            preImages.append(await turns.capturePreImage(of: path, sessionID: sessionID))
        }
        let result: Result<Value, any Error>
        do {
            result = .success(try await operation())
        } catch {
            result = .failure(error)
        }
        let succeeded = if case .success = result { true } else { false }
        for (path, preImage) in zip(paths, preImages) {
            await turns.recordAgentWrite(
                to: path,
                preImage: preImage,
                succeeded: succeeded,
                sessionID: sessionID
            )
        }
        return try result.get()
    }
}
