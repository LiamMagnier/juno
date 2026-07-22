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
        let sealed = Checkpoint(
            id: existing.id,
            sessionID: existing.sessionID,
            path: existing.path,
            createdAt: existing.createdAt,
            preContent: existing.preContent,
            postFingerprint: postFingerprint
        )
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
        let url = try access.resolveForMutation(checkpoint.path)
        let currentContent = try? String(contentsOf: url, encoding: .utf8)

        if !force {
            switch (currentContent, checkpoint.postFingerprint) {
            case let (current?, post?):
                guard FileFingerprint(of: current) == post else {
                    throw CheckpointError.currentContentDiverged(path: checkpoint.path.value)
                }
            case (nil, nil):
                break
            case (nil, .some), (.some, nil):
                throw CheckpointError.currentContentDiverged(path: checkpoint.path.value)
            }
        }

        do {
            if let preContent = checkpoint.preContent {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try AtomicFileWriter.write(preContent, to: url)
            } else if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
        } catch {
            throw CheckpointError.restoreFailed(
                path: checkpoint.path.value,
                message: String(describing: error)
            )
        }
    }

    public func removeCheckpoints(for sessionID: CodeSessionID) async throws {
        try loadIfNeeded()
        for checkpoint in cache.values where checkpoint.sessionID == sessionID {
            cache.removeValue(forKey: checkpoint.id)
            try? FileManager.default.removeItem(at: fileURL(for: checkpoint.id))
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
