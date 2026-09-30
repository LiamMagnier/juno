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
        let url = try resolveMutationTarget(path)
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
        let url = try resolveMutationTarget(path)
        let previous = FileManager.default.fileExists(atPath: url.path)
            ? try readText(at: url, path: path)
            : nil
        if let expectedBase {
            guard let previous, FileFingerprint(of: previous) == expectedBase else {
                throw FileOperationError.concurrentModification(path: path.value)
            }
        } else if previous != nil {
            // Enforced here rather than in the tool: this is the only place
            // that knows whether the path already held content, and every
            // caller — tools, subagents, the remote host — reaches the
            // filesystem through it.
            throw FileOperationError.baseFingerprintRequired(path: path.value)
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
        let url = try resolveMutationTarget(path)
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
        let url = try resolveMutationTarget(path)
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
        let sourceURL = try resolveMutationTarget(source)
        let destinationURL = try resolveMutationTarget(destination)
        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            throw FileOperationError.notFound(path: source.value)
        }
        guard !FileManager.default.fileExists(atPath: destinationURL.path) else {
            throw FileOperationError.alreadyExists(path: destination.value)
        }
        let content = try readText(at: sourceURL, path: source)
        // Both ends of the move, so undo can put the file back *and* take the
        // copy away. Recording only the source is what used to turn an undone
        // rename into two files.
        let checkpoint = Checkpoint(
            sessionID: sessionID,
            createdAt: Date(),
            entries: [
                CheckpointEntry(
                    path: source,
                    preContent: content,
                    postFingerprint: nil
                ),
                CheckpointEntry(
                    path: destination,
                    preContent: nil,
                    postFingerprint: FileFingerprint(of: content)
                ),
            ]
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

    // MARK: - Raw reads

    public func readData(_ path: WorkspacePath, maximumBytes: Int) async throws -> FileDataReadResult {
        let url = try access.resolveForReading(path)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw FileOperationError.notFound(path: path.value)
        }
        guard !isDirectory.boolValue else {
            throw FileOperationError.isADirectory(path: path.value)
        }
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let total = Int(try handle.seekToEnd())
            try handle.seek(toOffset: 0)
            let data = try handle.read(upToCount: max(0, min(maximumBytes, total))) ?? Data()
            return FileDataReadResult(path: path, data: data, totalByteCount: total)
        } catch {
            throw FileOperationError.ioFailure(path: path.value, message: String(describing: error))
        }
    }

    // MARK: - Change sets

    public func applyChangeSet(
        _ changes: [FileChangeRequest],
        sessionID: CodeSessionID
    ) async throws -> [FileMutationResult] {
        guard !changes.isEmpty else {
            throw FileOperationError.invalidChangeSet(message: "The change set is empty.")
        }
        var claimed = Set<String>()
        for change in changes {
            for path in change.touchedPaths where !claimed.insert(path.value).inserted {
                throw FileOperationError.invalidChangeSet(
                    message: "\(path.value) is named by more than one change; combine them into one."
                )
            }
        }

        // Validate everything before writing anything: each target resolves
        // inside the workspace, exists or not as its change requires, and
        // still holds exactly the content the new content was computed from.
        struct Planned {
            let change: FileChangeRequest
            let url: URL
            let destinationURL: URL?
            let previous: String?
        }
        var planned: [Planned] = []
        for change in changes {
            let url = try resolveMutationTarget(change.path)
            switch change {
            case let .create(path, content):
                guard !FileManager.default.fileExists(atPath: url.path) else {
                    throw FileOperationError.alreadyExists(path: path.value)
                }
                try validateSize(content, path: path)
                planned.append(Planned(change: change, url: url, destinationURL: nil, previous: nil))
            case let .update(path, content, expectedBase, moveTo):
                let previous = try readText(at: url, path: path)
                guard FileFingerprint(of: previous) == expectedBase else {
                    throw FileOperationError.concurrentModification(path: path.value)
                }
                try validateSize(content, path: path)
                var destinationURL: URL?
                if let moveTo, moveTo != path {
                    let destination = try resolveMutationTarget(moveTo)
                    guard !FileManager.default.fileExists(atPath: destination.path) else {
                        throw FileOperationError.alreadyExists(path: moveTo.value)
                    }
                    destinationURL = destination
                }
                planned.append(Planned(change: change, url: url, destinationURL: destinationURL, previous: previous))
            case let .delete(path, expectedBase):
                let previous = try readText(at: url, path: path)
                guard FileFingerprint(of: previous) == expectedBase else {
                    throw FileOperationError.concurrentModification(path: path.value)
                }
                planned.append(Planned(change: change, url: url, destinationURL: nil, previous: previous))
            }
        }

        // One checkpoint for the whole set, so undo takes the operation back
        // as the reader saw it happen: every file, or none.
        var entries: [CheckpointEntry] = []
        for item in planned {
            switch item.change {
            case let .create(path, content):
                entries.append(CheckpointEntry(path: path, preContent: nil, postFingerprint: FileFingerprint(of: content)))
            case let .update(path, content, _, moveTo):
                if let moveTo, item.destinationURL != nil {
                    entries.append(CheckpointEntry(path: path, preContent: item.previous, postFingerprint: nil))
                    entries.append(CheckpointEntry(path: moveTo, preContent: nil, postFingerprint: FileFingerprint(of: content)))
                } else {
                    entries.append(CheckpointEntry(path: path, preContent: item.previous, postFingerprint: FileFingerprint(of: content)))
                }
            case let .delete(path, _):
                entries.append(CheckpointEntry(path: path, preContent: item.previous, postFingerprint: nil))
            }
        }
        let checkpoint = Checkpoint(sessionID: sessionID, createdAt: Date(), entries: entries)
        try await checkpoints.record(checkpoint)

        // Each write is re-checked against the fingerprint it was validated
        // with, and logged so a later failure can put it back.
        var undo: [(url: URL, previous: String?)] = []
        do {
            for item in planned {
                switch item.change {
                case let .create(path, content):
                    guard !FileManager.default.fileExists(atPath: item.url.path) else {
                        throw FileOperationError.alreadyExists(path: path.value)
                    }
                    undo.append((item.url, nil))
                    try writeAtomically(content, to: item.url, path: path)
                case let .update(path, content, expectedBase, moveTo):
                    let current = try readText(at: item.url, path: path)
                    guard FileFingerprint(of: current) == expectedBase else {
                        throw FileOperationError.concurrentModification(path: path.value)
                    }
                    if let destinationURL = item.destinationURL, let moveTo {
                        guard !FileManager.default.fileExists(atPath: destinationURL.path) else {
                            throw FileOperationError.alreadyExists(path: moveTo.value)
                        }
                        undo.append((destinationURL, nil))
                        try writeAtomically(content, to: destinationURL, path: moveTo)
                        undo.append((item.url, current))
                        do {
                            try FileManager.default.removeItem(at: item.url)
                        } catch {
                            throw FileOperationError.ioFailure(path: path.value, message: String(describing: error))
                        }
                    } else {
                        undo.append((item.url, current))
                        try writeAtomically(content, to: item.url, path: path)
                    }
                case let .delete(path, expectedBase):
                    let current = try readText(at: item.url, path: path)
                    guard FileFingerprint(of: current) == expectedBase else {
                        throw FileOperationError.concurrentModification(path: path.value)
                    }
                    undo.append((item.url, current))
                    do {
                        try FileManager.default.removeItem(at: item.url)
                    } catch {
                        throw FileOperationError.ioFailure(path: path.value, message: String(describing: error))
                    }
                }
            }
        } catch {
            for change in undo.reversed() {
                if let previous = change.previous {
                    try? FileManager.default.createDirectory(
                        at: change.url.deletingLastPathComponent(),
                        withIntermediateDirectories: true
                    )
                    try? AtomicFileWriter.write(previous, to: change.url)
                } else if FileManager.default.fileExists(atPath: change.url.path) {
                    try? FileManager.default.removeItem(at: change.url)
                }
            }
            throw error
        }
        try await checkpoints.sealCheckpoint(id: checkpoint.id, postFingerprint: entries[0].postFingerprint)

        return planned.map { item in
            switch item.change {
            case let .create(path, content):
                return FileMutationResult(
                    path: path,
                    kind: .created,
                    diff: try? DiffEngine.diff(old: "", new: content),
                    newFingerprint: FileFingerprint(of: content),
                    checkpointID: checkpoint.id
                )
            case let .update(path, content, _, moveTo):
                let moved = item.destinationURL != nil
                return FileMutationResult(
                    path: moved ? (moveTo ?? path) : path,
                    kind: moved ? .moved : .modified,
                    diff: try? DiffEngine.diff(old: item.previous ?? "", new: content),
                    newFingerprint: FileFingerprint(of: content),
                    checkpointID: checkpoint.id
                )
            case let .delete(path, _):
                return FileMutationResult(
                    path: path,
                    kind: .deleted,
                    diff: try? DiffEngine.diff(old: item.previous ?? "", new: ""),
                    newFingerprint: nil,
                    checkpointID: checkpoint.id
                )
            }
        }
    }

    // MARK: - Helpers

    /// The containment-checked location for a mutation, refused when it is
    /// one of the project's policy files reached under another name.
    ///
    /// The file tools ask before touching those files in every mode, but
    /// they judge by the path the model wrote. A link inside the workspace
    /// (`cfg` pointing at `.juno`) would make `cfg/settings.local.json` read
    /// as an ordinary edit, so a target that resolves to a policy file has to
    /// be named as one.
    private func resolveMutationTarget(_ path: WorkspacePath) throws -> URL {
        let url = try access.resolveForMutation(path)
        if !WorkspacePolicyPaths.isProtected(path.value),
           let actual = try? access.makeRelative(url),
           WorkspacePolicyPaths.isProtected(actual.value)
        {
            throw FileOperationError.ioFailure(
                path: path.value,
                message: "This path leads to \(actual.value), one of the project's policy files. Name that file directly, so the change is reviewed as one."
            )
        }
        return url
    }

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
