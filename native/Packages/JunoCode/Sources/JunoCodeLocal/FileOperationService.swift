import Foundation
import JunoCodeCore

/// Local implementation of workspace file operations: containment-checked
/// resolution, UTF-8 validation, size bounds, checkpoint capture before every
/// mutation, atomic writes, and diff computation for the transcript.
public final class FileOperationService: FileOperating, Sendable {
    public static let defaultMaximumFileBytes = 2 * 1_024 * 1_024

    private let access: any WorkspaceAccessing
    private let checkpoints: any Checkpointing
    private let maximumFileBytes: Int

    public init(
        access: any WorkspaceAccessing,
        checkpoints: any Checkpointing,
        maximumFileBytes: Int = FileOperationService.defaultMaximumFileBytes
    ) {
        self.access = access
        self.checkpoints = checkpoints
        self.maximumFileBytes = maximumFileBytes
    }

    // MARK: - Read

    public func read(_ path: WorkspacePath, limit: OutputLimit) async throws -> FileReadResult {
        let url = try access.resolveForReading(path)
        let content = try readText(at: url, path: path)
        let limited = OutputLimiter.apply(limit, to: content)
        return FileReadResult(
            path: path,
            content: limited.text,
            wasTruncated: limited.wasTruncated,
            fingerprint: FileFingerprint(of: content),
            byteCount: limited.originalByteCount,
            lineCount: DiffEngine.splitLines(content).count
        )
    }

    // MARK: - Mutations

    public func create(
        _ path: WorkspacePath,
        content: String,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult {
        let url = try access.resolveForMutation(path)
        guard !FileManager.default.fileExists(atPath: url.path) else {
            throw FileOperationError.alreadyExists(path: path.value)
        }
        try validateSize(content, path: path)
        let checkpoint = Checkpoint(
            sessionID: sessionID,
            path: path,
            createdAt: Date(),
            preContent: nil,
            postFingerprint: nil
        )
        try await checkpoints.record(checkpoint)
        try writeAtomically(content, to: url, path: path)
        let fingerprint = FileFingerprint(of: content)
        try await checkpoints.sealCheckpoint(id: checkpoint.id, postFingerprint: fingerprint)
        return FileMutationResult(
            path: path,
            kind: .created,
            diff: try? DiffEngine.diff(old: "", new: content),
            newFingerprint: fingerprint,
            checkpointID: checkpoint.id
        )
    }

    public func write(
        _ path: WorkspacePath,
        content: String,
        expectedBase: FileFingerprint?,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult {
        try validateSize(content, path: path)
        let url = try access.resolveForMutation(path)
        let previous = FileManager.default.fileExists(atPath: url.path)
            ? try readText(at: url, path: path)
            : nil
        if let expectedBase {
            guard let previous, FileFingerprint(of: previous) == expectedBase else {
                throw FileOperationError.concurrentModification(path: path.value)
            }
        }
        let checkpoint = Checkpoint(
            sessionID: sessionID,
            path: path,
            createdAt: Date(),
            preContent: previous,
            postFingerprint: nil
        )
        try await checkpoints.record(checkpoint)
        try writeAtomically(content, to: url, path: path)
        let fingerprint = FileFingerprint(of: content)
        try await checkpoints.sealCheckpoint(id: checkpoint.id, postFingerprint: fingerprint)
        return FileMutationResult(
            path: path,
            kind: previous == nil ? .created : .modified,
            diff: try? DiffEngine.diff(old: previous ?? "", new: content),
            newFingerprint: fingerprint,
            checkpointID: checkpoint.id
        )
    }

    public func applyPatch(
        _ path: WorkspacePath,
        patch: TextPatch,
        expectedBase: FileFingerprint?,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult {
        let url = try access.resolveForMutation(path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw FileOperationError.notFound(path: path.value)
        }
        let previous = try readText(at: url, path: path)
        if let expectedBase, FileFingerprint(of: previous) != expectedBase {
            throw FileOperationError.concurrentModification(path: path.value)
        }
        let updated: String
        do {
            updated = try patch.apply(to: previous)
        } catch let error as TextPatchError {
            throw FileOperationError.patchFailed(path: path.value, underlying: error)
        }
        try validateSize(updated, path: path)
        let checkpoint = Checkpoint(
            sessionID: sessionID,
            path: path,
            createdAt: Date(),
            preContent: previous,
            postFingerprint: nil
        )
        try await checkpoints.record(checkpoint)
        try writeAtomically(updated, to: url, path: path)
        let fingerprint = FileFingerprint(of: updated)
        try await checkpoints.sealCheckpoint(id: checkpoint.id, postFingerprint: fingerprint)
        return FileMutationResult(
            path: path,
            kind: .modified,
            diff: try? DiffEngine.diff(old: previous, new: updated),
            newFingerprint: fingerprint,
            checkpointID: checkpoint.id
        )
    }

    public func delete(
        _ path: WorkspacePath,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult {
        let url = try access.resolveForMutation(path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw FileOperationError.notFound(path: path.value)
        }
        var isDirectory: ObjCBool = false
        FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
        guard !isDirectory.boolValue else {
            throw FileOperationError.isADirectory(path: path.value)
        }
        let previous = try readText(at: url, path: path)
        let checkpoint = Checkpoint(
            sessionID: sessionID,
            path: path,
            createdAt: Date(),
            preContent: previous,
            postFingerprint: nil
        )
        try await checkpoints.record(checkpoint)
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            throw FileOperationError.ioFailure(path: path.value, message: String(describing: error))
        }
        try await checkpoints.sealCheckpoint(id: checkpoint.id, postFingerprint: nil)
        return FileMutationResult(
            path: path,
            kind: .deleted,
            diff: try? DiffEngine.diff(old: previous, new: ""),
            newFingerprint: nil,
            checkpointID: checkpoint.id
        )
    }

    public func move(
        from source: WorkspacePath,
        to destination: WorkspacePath,
        sessionID: CodeSessionID
    ) async throws -> FileMutationResult {
        let sourceURL = try access.resolveForMutation(source)
        let destinationURL = try access.resolveForMutation(destination)
        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            throw FileOperationError.notFound(path: source.value)
        }
        guard !FileManager.default.fileExists(atPath: destinationURL.path) else {
            throw FileOperationError.alreadyExists(path: destination.value)
        }
        let content = try readText(at: sourceURL, path: source)
        let checkpoint = Checkpoint(
            sessionID: sessionID,
            path: source,
            createdAt: Date(),
            preContent: content,
            postFingerprint: nil
        )
        try await checkpoints.record(checkpoint)
        do {
            try FileManager.default.createDirectory(
                at: destinationURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try FileManager.default.moveItem(at: sourceURL, to: destinationURL)
        } catch {
            throw FileOperationError.ioFailure(path: source.value, message: String(describing: error))
        }
        try await checkpoints.sealCheckpoint(id: checkpoint.id, postFingerprint: nil)
        return FileMutationResult(
            path: destination,
            kind: .moved,
            diff: nil,
            newFingerprint: FileFingerprint(of: content),
            checkpointID: checkpoint.id
        )
    }

    // MARK: - Helpers

    private func readText(at url: URL, path: WorkspacePath) throws -> String {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw FileOperationError.notFound(path: path.value)
        }
        guard !isDirectory.boolValue else {
            throw FileOperationError.isADirectory(path: path.value)
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw FileOperationError.ioFailure(path: path.value, message: String(describing: error))
        }
        guard data.count <= maximumFileBytes else {
            throw FileOperationError.tooLarge(
                path: path.value,
                byteCount: data.count,
                maximumBytes: maximumFileBytes
            )
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw FileOperationError.notUTF8Text(path: path.value)
        }
        return text
    }

    private func validateSize(_ content: String, path: WorkspacePath) throws {
        let byteCount = content.utf8.count
        guard byteCount <= maximumFileBytes else {
            throw FileOperationError.tooLarge(
                path: path.value,
                byteCount: byteCount,
                maximumBytes: maximumFileBytes
            )
        }
    }

    private func writeAtomically(_ content: String, to url: URL, path: WorkspacePath) throws {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try AtomicFileWriter.write(content, to: url)
        } catch {
            throw FileOperationError.ioFailure(path: path.value, message: String(describing: error))
        }
    }
}
