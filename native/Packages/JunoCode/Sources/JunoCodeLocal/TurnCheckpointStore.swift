import Foundation
import JunoCodeCore

/// Disk-backed turn checkpoints for one workspace: what each of the reader's
/// turns changed, and what those files held before, so a turn can be rewound.
///
/// One folder per session under the store directory:
/// `<session>/journal.json` — every turn and the paths it changed, rewritten
/// after each change; `<session>/blobs/<sha256>` — pre-image bytes, stored once
/// each however many turns point at them.
///
/// **What is captured.** The first time an agent file tool changes a path in a
/// turn, the path's state from just before: its bytes and POSIX mode, or the
/// fact that it did not exist. Changes made by commands the agent runs are not
/// captured — the shell writes files Juno never sees, which is the same
/// boundary Claude Code draws.
///
/// **What is kept.** Snapshots for the most recent ``Limits/maximumTurns``
/// turns that changed anything, and no more than ``Limits/maximumBytes`` of
/// them per session. Past either, the oldest turn's snapshots are dropped and
/// the turn marked ``TurnSnapshotGap/pruned``: its conversation can still be
/// rewound, but its code — and any earlier turn's — cannot, because restoring
/// them would need the bytes that were let go.
public actor TurnCheckpointStore: TurnCheckpointing {
    public struct Limits: Sendable {
        /// Turns that keep file snapshots. Turns that changed nothing cost
        /// nothing and are not counted.
        public var maximumTurns: Int
        /// Snapshot bytes per session, counted once per distinct content.
        public var maximumBytes: Int
        /// The largest single file snapshotted. Agent file tools refuse files
        /// over 2 MB anyway; this only has to be comfortably above that.
        public var maximumFileBytes: Int

        public init(maximumTurns: Int, maximumBytes: Int, maximumFileBytes: Int) {
            self.maximumTurns = max(1, maximumTurns)
            self.maximumBytes = max(1, maximumBytes)
            self.maximumFileBytes = max(1, maximumFileBytes)
        }

        public static let standard = Limits(
            maximumTurns: 100,
            maximumBytes: 64 * 1_024 * 1_024,
            maximumFileBytes: 8 * 1_024 * 1_024
        )
    }

    private struct Journal: Codable {
        var version = 1
        var turns: [TurnCheckpoint]
    }

    private let directoryURL: URL
    private let access: any WorkspaceAccessing
    private let limits: Limits
    /// Loaded lazily, one session at a time: a workspace holds many sessions
    /// and a reader works in one.
    private var journals: [CodeSessionID: [TurnCheckpoint]] = [:]

    public init(
        directoryURL: URL,
        access: any WorkspaceAccessing,
        limits: Limits = .standard
    ) {
        self.directoryURL = directoryURL
        self.access = access
        self.limits = limits
    }

    // MARK: - Capture

    public func openTurn(id: String, sessionID: CodeSessionID, openedAt: Date) async {
        var turns = journal(for: sessionID)
        guard !turns.contains(where: { $0.id == id }) else { return }
        turns.append(TurnCheckpoint(id: id, sessionID: sessionID, openedAt: openedAt))
        store(turns, for: sessionID)
    }

    public func capturePreImage(of path: WorkspacePath, sessionID: CodeSessionID) async {
        var turns = journal(for: sessionID)
        guard let current = turns.indices.last,
              turns[current].gap == nil,
              !turns[current].files.contains(where: { $0.path == path })
        else { return }

        let state: TurnFileState
        do {
            guard let read = try readDisk(path) else {
                // A directory: the file tool refuses it, so there is nothing
                // to snapshot.
                return
            }
            if let data = read.data {
                guard data.count <= limits.maximumFileBytes else {
                    markUncaptured(&turns, at: current, sessionID: sessionID)
                    return
                }
                try writeBlob(data, sha256: read.state.sha256 ?? "", sessionID: sessionID)
            }
            state = read.state
        } catch is WorkspaceAccessError {
            // The path resolves outside the workspace. The tool fails on the
            // same check, so nothing is about to change.
            return
        } catch {
            markUncaptured(&turns, at: current, sessionID: sessionID)
            return
        }

        turns[current].files.append(TurnFileSnapshot(path: path, before: state, after: state))
        enforceLimits(&turns)
        if snapshotBytes(turns) > limits.maximumBytes {
            // Every older turn is already pruned and this one alone is over the
            // cap. Keeping part of a turn restores none of it, so the turn
            // gives its snapshots up rather than crowding out the next one.
            markUncaptured(&turns, at: current, sessionID: sessionID)
            return
        }
        store(turns, for: sessionID)
    }

    public func recordAgentWrite(to path: WorkspacePath, sessionID: CodeSessionID) async {
        var turns = journal(for: sessionID)
        guard let current = turns.indices.last,
              let index = turns[current].files.firstIndex(where: { $0.path == path })
        else { return }
        // Unreadable now leaves the last known state in place, which a later
        // rewind reads as a change it did not make and asks about — the safe
        // direction to be wrong in.
        guard let after = (try? readDisk(path, hashOnly: true))?.state,
              turns[current].files[index].after != after
        else { return }
        turns[current].files[index].after = after
        store(turns, for: sessionID)
    }

    // MARK: - Reading

    /// Every recorded turn for the session, oldest first.
    public func turns(for sessionID: CodeSessionID) -> [TurnCheckpoint] {
        journal(for: sessionID)
    }

    /// What restoring code to `turnID` would change, one entry per file.
    ///
    /// Files already back at their earlier state are left out: a rewind lists
    /// what it will do, not what the turns once did.
    public func preview(
        sessionID: CodeSessionID,
        toTurn turnID: String
    ) throws -> [TurnRestoreFile] {
        try pendingRestores(sessionID: sessionID, toTurn: turnID)
            .map(\.file)
            .sorted { $0.path.value < $1.path.value }
    }

    // MARK: - Restore

    /// Returns every path touched in `turnID` or any later turn to its state
    /// from before `turnID`: earlier content and mode written back, files the
    /// turns created removed, files they deleted recreated.
    ///
    /// Refuses with ``TurnCheckpointError/diverged(paths:)`` when any of those
    /// files changed after the agent last wrote it, unless `force` — the
    /// reader's explicit answer to that question. All-or-nothing: a failure
    /// part-way puts back what this call already changed.
    ///
    /// On success the turns' snapshots are cleared, because their changes are
    /// undone; the turns themselves stay, so their conversation can still be
    /// rewound. A restore cut short by a crash leaves the journal as it was,
    /// and restoring the same turn again finishes it: files already back at
    /// their earlier state are skipped as unchanged.
    @discardableResult
    public func restore(
        sessionID: CodeSessionID,
        toTurn turnID: String,
        force: Bool
    ) throws -> [WorkspacePath] {
        let pending = try pendingRestores(sessionID: sessionID, toTurn: turnID)
        let diverged = pending.filter(\.file.hasDiverged).map(\.file.path.value)
        if !force, !diverged.isEmpty {
            throw TurnCheckpointError.diverged(paths: diverged.sorted())
        }

        var applied: [(url: URL, previous: Data?, permissions: Int?)] = []
        do {
            for restore in pending {
                let url = try access.resolveForMutation(restore.file.path)
                let previous = try? Data(contentsOf: url)
                let permissions = Self.permissions(at: url)
                try apply(restore.before, at: url, path: restore.file.path, sessionID: sessionID)
                applied.append((url, previous, permissions))
            }
        } catch {
            for change in applied.reversed() {
                if let previous = change.previous {
                    try? FileManager.default.createDirectory(
                        at: change.url.deletingLastPathComponent(),
                        withIntermediateDirectories: true
                    )
                    try? AtomicFileWriter.write(previous, to: change.url)
                    if let permissions = change.permissions {
                        try? FileManager.default.setAttributes(
                            [.posixPermissions: permissions],
                            ofItemAtPath: change.url.path
                        )
                    }
                } else if FileManager.default.fileExists(atPath: change.url.path) {
                    try? FileManager.default.removeItem(at: change.url)
                }
            }
            if let failure = error as? TurnCheckpointError { throw failure }
            let path = pending.dropFirst(applied.count).first?.file.path.value ?? ""
            throw TurnCheckpointError.restoreFailed(path: path, message: String(describing: error))
        }

        var turns = journal(for: sessionID)
        if let index = turns.firstIndex(where: { $0.id == turnID }) {
            for later in index..<turns.count {
                turns[later].files = []
            }
            store(turns, for: sessionID)
            collectGarbage(turns, sessionID: sessionID)
        }
        return pending.map(\.file.path)
    }

    /// Drops `turnID` and every later turn, after the conversation that held
    /// them has been rewound past them and their files restored.
    public func forgetTurns(sessionID: CodeSessionID, from turnID: String) {
        var turns = journal(for: sessionID)
        guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
        turns.removeSubrange(index...)
        store(turns, for: sessionID)
        collectGarbage(turns, sessionID: sessionID)
    }

    /// Removes a session's snapshots, with its transcript.
    public func removeSession(_ sessionID: CodeSessionID) throws {
        journals.removeValue(forKey: sessionID)
        try Self.removePersisted(sessionID: sessionID, directoryURL: directoryURL)
    }

    /// Removes a session's snapshots when its workspace cannot be opened.
    /// Deleting a transcript must not depend on a still-valid folder grant,
    /// because the snapshots hold the full pre-edit source.
    public static func removePersisted(sessionID: CodeSessionID, directoryURL: URL) throws {
        let folder = directoryURL.appendingPathComponent(sessionID.value, isDirectory: true)
        guard FileManager.default.fileExists(atPath: folder.path) else { return }
        try FileManager.default.removeItem(at: folder)
    }

    // MARK: - Planning

    private struct PendingRestore {
        let file: TurnRestoreFile
        let before: TurnFileState
    }

    private func pendingRestores(
        sessionID: CodeSessionID,
        toTurn turnID: String
    ) throws -> [PendingRestore] {
        let turns = journal(for: sessionID)
        guard let index = turns.firstIndex(where: { $0.id == turnID }) else {
            throw TurnCheckpointError.notRecorded
        }
        if let gap = turns[index...].lazy.compactMap(\.gap).first {
            throw TurnCheckpointError.incomplete(gap)
        }
        var pending: [PendingRestore] = []
        for snapshot in TurnCheckpoint.netChanges(of: turns[index...]) {
            // Unreadable is treated as changed by someone else: a restore must
            // ask before overwriting what it cannot see.
            let current = (try? readDisk(snapshot.path, hashOnly: true))?.state
            guard let current else {
                pending.append(PendingRestore(
                    file: TurnRestoreFile(path: snapshot.path, change: .revert, hasDiverged: true),
                    before: snapshot.before
                ))
                continue
            }
            if current.matches(snapshot.before) { continue }
            let change: TurnRestoreFile.Change =
                !snapshot.before.exists ? .remove : (current.exists ? .revert : .recreate)
            pending.append(PendingRestore(
                file: TurnRestoreFile(
                    path: snapshot.path,
                    change: change,
                    hasDiverged: !current.hasSameContent(as: snapshot.after)
                ),
                before: snapshot.before
            ))
        }
        return pending
    }

    // MARK: - Limits

    private func enforceLimits(_ turns: inout [TurnCheckpoint]) {
        while true {
            let holding = turns.indices.filter { !turns[$0].files.isEmpty }
            guard holding.count > limits.maximumTurns
                || snapshotBytes(turns) > limits.maximumBytes
            else { return }
            // Never the newest turn: it is the one being captured.
            guard let oldest = holding.first, oldest < turns.count - 1 else { return }
            turns[oldest].files = []
            turns[oldest].gap = .pruned
        }
    }

    private func snapshotBytes(_ turns: [TurnCheckpoint]) -> Int {
        var seen: Set<String> = []
        var total = 0
        for file in turns.lazy.flatMap(\.files) {
            if case let .file(sha256, byteCount, _) = file.before, seen.insert(sha256).inserted {
                total += byteCount
            }
        }
        return total
    }

    private func markUncaptured(
        _ turns: inout [TurnCheckpoint],
        at index: Int,
        sessionID: CodeSessionID
    ) {
        turns[index].files = []
        turns[index].gap = .notCaptured
        store(turns, for: sessionID)
        collectGarbage(turns, sessionID: sessionID)
    }

    // MARK: - Disk

    /// The path's state, and its bytes unless only the digest is wanted. Nil
    /// for a directory.
    private func readDisk(
        _ path: WorkspacePath,
        hashOnly: Bool = false
    ) throws -> (state: TurnFileState, data: Data?)? {
        let url = try access.resolveForMutation(path)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            return (.absent, nil)
        }
        guard !isDirectory.boolValue else { return nil }
        let data = try Data(contentsOf: url)
        let state = TurnFileState.file(
            sha256: Digests.sha256Hex(data),
            byteCount: data.count,
            permissions: Self.permissions(at: url)
        )
        return (state, hashOnly ? nil : data)
    }

    private func apply(
        _ state: TurnFileState,
        at url: URL,
        path: WorkspacePath,
        sessionID: CodeSessionID
    ) throws {
        switch state {
        case .absent:
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
        case let .file(sha256, _, permissions):
            guard let data = try? Data(contentsOf: blobURL(sha256, sessionID: sessionID)),
                  Digests.sha256Hex(data) == sha256
            else {
                throw TurnCheckpointError.restoreFailed(
                    path: path.value,
                    message: "Its earlier version is missing from the checkpoint store."
                )
            }
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try AtomicFileWriter.write(data, to: url)
            if let permissions {
                try FileManager.default.setAttributes(
                    [.posixPermissions: permissions],
                    ofItemAtPath: url.path
                )
            }
        }
    }

    private static func permissions(at url: URL) -> Int? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions]
            .flatMap { ($0 as? NSNumber)?.intValue }
    }

    // MARK: - Persistence

    private func sessionFolder(_ sessionID: CodeSessionID) -> URL {
        directoryURL.appendingPathComponent(sessionID.value, isDirectory: true)
    }

    private func journalURL(_ sessionID: CodeSessionID) -> URL {
        sessionFolder(sessionID).appendingPathComponent("journal.json")
    }

    private func blobURL(_ sha256: String, sessionID: CodeSessionID) -> URL {
        sessionFolder(sessionID)
            .appendingPathComponent("blobs", isDirectory: true)
            .appendingPathComponent(sha256)
    }

    private func journal(for sessionID: CodeSessionID) -> [TurnCheckpoint] {
        if let cached = journals[sessionID] { return cached }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let turns = (try? Data(contentsOf: journalURL(sessionID)))
            .flatMap { try? decoder.decode(Journal.self, from: $0) }?
            .turns ?? []
        journals[sessionID] = turns
        return turns
    }

    /// Keeps the in-memory journal authoritative and writes it through. A
    /// failed write does not stop the agent: the turn is still recorded for
    /// this launch, and the next successful write carries it to disk.
    private func store(_ turns: [TurnCheckpoint], for sessionID: CodeSessionID) {
        journals[sessionID] = turns
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(Journal(turns: turns)) else { return }
        try? FileManager.default.createDirectory(
            at: sessionFolder(sessionID),
            withIntermediateDirectories: true
        )
        try? data.write(to: journalURL(sessionID), options: .atomic)
    }

    private func writeBlob(_ data: Data, sha256: String, sessionID: CodeSessionID) throws {
        let url = blobURL(sha256, sessionID: sessionID)
        guard !FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: url, options: .atomic)
    }

    /// Deletes blobs no turn points at any more.
    private func collectGarbage(_ turns: [TurnCheckpoint], sessionID: CodeSessionID) {
        let referenced = Set(turns.lazy.flatMap(\.files).compactMap(\.before.sha256))
        let folder = sessionFolder(sessionID).appendingPathComponent("blobs", isDirectory: true)
        let blobs = (try? FileManager.default.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: nil
        )) ?? []
        for blob in blobs where !referenced.contains(blob.lastPathComponent) {
            try? FileManager.default.removeItem(at: blob)
        }
    }
}
