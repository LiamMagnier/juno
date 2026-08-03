import Foundation
import JunoCodeCore

/// Disk-backed checkpoint store. Each checkpoint is one JSON file under the
/// store directory, so snapshots survive relaunch and crash recovery can
/// offer rollback for interrupted sessions.
public actor CheckpointStore: Checkpointing {
    private let directoryURL: URL
    private let access: any WorkspaceAccessing
    private var cache: [String: Checkpoint] = [:]
    private var loaded = false

    public init(directoryURL: URL, access: any WorkspaceAccessing) {
        self.directoryURL = directoryURL
        self.access = access
    }

    // MARK: - Checkpointing

    public func record(_ checkpoint: Checkpoint) async throws {
        try loadIfNeeded()
        cache[checkpoint.id] = checkpoint
        try persist(checkpoint)
    }

    public func sealCheckpoint(id: String, postFingerprint: FileFingerprint?) async throws {
        try loadIfNeeded()
        guard let existing = cache[id] else {
            throw CheckpointError.notFound(id: id)
        }
        // Sealing settles what the mutation produced at its *primary* path.
        // Rebuilding through the single-path initialiser would drop `entries`
        // and silently turn an undone move back into the duplicate-file bug,
        // so a multi-path operation keeps its other entries verbatim.
        let sealed: Checkpoint
        if let entries = existing.entries, !entries.isEmpty {
            var updated = entries
            updated[0] = CheckpointEntry(
                path: entries[0].path,
                preContent: entries[0].preContent,
                postFingerprint: postFingerprint
            )
            sealed = Checkpoint(
                id: existing.id,
                sessionID: existing.sessionID,
                createdAt: existing.createdAt,
                entries: updated
            )
        } else {
            sealed = Checkpoint(
                id: existing.id,
                sessionID: existing.sessionID,
                path: existing.path,
                createdAt: existing.createdAt,
                preContent: existing.preContent,
                postFingerprint: postFingerprint
            )
        }
        cache[id] = sealed
        try persist(sealed)
    }

    public func checkpoint(id: String) async -> Checkpoint? {
        try? loadIfNeeded()
        return cache[id]
    }

    public func checkpoints(for sessionID: CodeSessionID) async -> [Checkpoint] {
        try? loadIfNeeded()
        return cache.values
            .filter { $0.sessionID == sessionID }
            .sorted { $0.createdAt > $1.createdAt }
    }

    public func restore(id: String, force: Bool) async throws {
        try loadIfNeeded()
        guard let checkpoint = cache[id] else {
            throw CheckpointError.notFound(id: id)
        }
        let entries = checkpoint.resolvedEntries
        let urls = try entries.map { try access.resolveForMutation($0.path) }
        // Written before the first byte moves and removed after the last one.
        // Its presence on the next launch is the only evidence that a restore
        // was interrupted part-way — at that moment the workspace holds neither
        // the before state nor the after state, and nothing else can tell.
        try writeRestoreJournal(for: checkpoint.id)

        // Validate every path before touching any of them. Checking and
        // applying one entry at a time would half-undo a move whose second path
        // turns out to have diverged, leaving neither the before state nor the
        // after state on disk.
        if !force {
            for (entry, url) in zip(entries, urls) {
                let current = try? String(contentsOf: url, encoding: .utf8)
                switch (current, entry.postFingerprint) {
                case let (current?, post?):
                    guard FileFingerprint(of: current) == post else {
                        throw CheckpointError.currentContentDiverged(path: entry.path.value)
                    }
                case (nil, nil):
                    break
                case (nil, .some), (.some, nil):
                    throw CheckpointError.currentContentDiverged(path: entry.path.value)
                }
            }
        }

        // Apply with rollback. Each path's current bytes are held in memory
        // first, so a failure part-way through can put back what this call
        // already changed rather than leaving the operation half-undone.
        var applied: [(url: URL, previous: String?)] = []
        do {
            for (entry, url) in zip(entries, urls) {
                let previous = try? String(contentsOf: url, encoding: .utf8)
                if let preContent = entry.preContent {
                    try FileManager.default.createDirectory(
                        at: url.deletingLastPathComponent(),
                        withIntermediateDirectories: true
                    )
                    try AtomicFileWriter.write(preContent, to: url)
                } else if FileManager.default.fileExists(atPath: url.path) {
                    try FileManager.default.removeItem(at: url)
                }
                applied.append((url, previous))
            }
        } catch {
            for change in applied.reversed() {
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
            removeRestoreJournal(for: checkpoint.id)
            throw CheckpointError.restoreFailed(
                path: checkpoint.path.value,
                message: String(describing: error)
            )
        }
        removeRestoreJournal(for: checkpoint.id)
    }

    /// Finishes restores that were interrupted by a crash or a kill.
    ///
    /// Finishing forward rather than rolling back, because the user had already
    /// asked for the undo — and because re-applying a checkpoint's pre-state is
    /// idempotent, while "rolling back" to a half-restored workspace is not a
    /// state anyone asked for.
    ///
    /// No divergence check runs here, deliberately. Divergence asks "has this
    /// changed since the operation landed", and mid-restore the answer is yes
    /// by construction: that is exactly what was interrupted.
    ///
    /// - Returns: the ids of the checkpoints that were completed.
    @discardableResult
    public func recoverInterruptedRestores() throws -> [String] {
        try loadIfNeeded()
        var recovered: [String] = []
        for id in journalledRestoreIDs().sorted() {
            guard let checkpoint = cache[id] else {
                // The checkpoint is gone, so there is nothing left to finish
                // and the journal would otherwise be retried on every launch.
                removeRestoreJournal(for: id)
                continue
            }
            for entry in checkpoint.resolvedEntries {
                guard let url = try? access.resolveForMutation(entry.path) else { continue }
                if let preContent = entry.preContent {
                    try? FileManager.default.createDirectory(
                        at: url.deletingLastPathComponent(),
                        withIntermediateDirectories: true
                    )
                    try? AtomicFileWriter.write(preContent, to: url)
                } else if FileManager.default.fileExists(atPath: url.path) {
                    try? FileManager.default.removeItem(at: url)
                }
            }
            removeRestoreJournal(for: id)
            recovered.append(id)
        }
        return recovered
    }

    // MARK: - Restore journal

    private func restoreJournalURL(for id: String) -> URL {
        directoryURL.appendingPathComponent("\(id).restoring")
    }

    private func writeRestoreJournal(for id: String) throws {
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )
        try Data(id.utf8).write(to: restoreJournalURL(for: id), options: .atomic)
    }

    private func removeRestoreJournal(for id: String) {
        try? FileManager.default.removeItem(at: restoreJournalURL(for: id))
    }

    private func journalledRestoreIDs() -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil
        )) ?? []
        return files
            .filter { $0.pathExtension == "restoring" }
            .map { $0.deletingPathExtension().lastPathComponent }
    }

    public func removeCheckpoints(for sessionID: CodeSessionID) async throws {
        try loadIfNeeded()
        let matching = cache.values.filter { $0.sessionID == sessionID }
        for checkpoint in matching {
            let url = fileURL(for: checkpoint.id)
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
            cache.removeValue(forKey: checkpoint.id)
        }
    }

    /// Purges a session's persisted checkpoints when its workspace cannot be
    /// reopened. Deleting a transcript must not depend on a still-valid folder
    /// bookmark, because checkpoint JSON contains the full pre-edit source.
    public static func removePersistedCheckpoints(
        for sessionID: CodeSessionID,
        directoryURL: URL
    ) throws {
        guard FileManager.default.fileExists(atPath: directoryURL.path) else {
            return
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let files = try FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil
        )
        for file in files where file.pathExtension == "json" {
            let checkpoint = try decoder.decode(
                Checkpoint.self,
                from: Data(contentsOf: file)
            )
            if checkpoint.sessionID == sessionID {
                try FileManager.default.removeItem(at: file)
            }
        }
    }

    // MARK: - Persistence

    private func loadIfNeeded() throws {
        guard !loaded else { return }
        loaded = true
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil
        )) ?? []
        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file),
                  let checkpoint = try? decoder.decode(Checkpoint.self, from: data)
            else { continue }
            cache[checkpoint.id] = checkpoint
        }
    }

    private func persist(_ checkpoint: Checkpoint) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(checkpoint)
        try data.write(to: fileURL(for: checkpoint.id), options: .atomic)
    }

    private func fileURL(for id: String) -> URL {
        directoryURL.appendingPathComponent("\(id).json")
    }
}

enum AtomicFileWriter {
    /// Writes text atomically: full content to a temporary file in the same
    /// directory, then an atomic replace.
    static func write(_ content: String, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        let temporary = directory.appendingPathComponent(".juno-tmp-\(UUID().uuidString)")
        try Data(content.utf8).write(to: temporary, options: [])
        _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
    }
}
