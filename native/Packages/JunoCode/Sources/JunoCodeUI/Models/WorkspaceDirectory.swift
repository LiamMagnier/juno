import Foundation
import JunoCodeCore
import JunoCodeLocal

/// One persisted workspace grant: descriptor plus the security-scoped
/// bookmark that is the only durable filesystem capability.
public struct WorkspaceRecord: Codable, Sendable, Identifiable, Hashable {
    public var id: WorkspaceID { descriptor.id }
    public var descriptor: WorkspaceDescriptor
    public var bookmarkData: Data

    public init(descriptor: WorkspaceDescriptor, bookmarkData: Data) {
        self.descriptor = descriptor
        self.bookmarkData = bookmarkData
    }
}

public enum WorkspaceDirectoryError: Error, Equatable, Sendable {
    case persistenceFailed(message: String)
    case workspaceNotFound
}

/// Disk-backed directory of granted workspaces (recents), ordered by last
/// use. Raw paths are display hints only; reopening always goes through the
/// bookmark.
public actor WorkspaceDirectory {
    private let fileURL: URL
    private var records: [WorkspaceRecord] = []
    private var loaded = false

    public init(directoryURL: URL) {
        self.fileURL = directoryURL.appendingPathComponent("workspaces.json")
    }

    public func allWorkspaces() -> [WorkspaceRecord] {
        try? loadIfNeeded()
        return records.sorted { $0.descriptor.lastOpenedAt > $1.descriptor.lastOpenedAt }
    }

    public func record(for id: WorkspaceID) -> WorkspaceRecord? {
        try? loadIfNeeded()
        return records.first { $0.id == id }
    }

    /// Registers (or refreshes) a workspace from a user-granted URL and
    /// returns the opened access.
    public func register(grantedURL: URL) throws -> (WorkspaceRecord, WorkspaceAccess) {
        try loadIfNeeded()
        let bookmark = try WorkspaceAccess.makeBookmark(for: grantedURL)
        if let existingIndex = records.firstIndex(where: {
            URL(fileURLWithPath: $0.descriptor.localPathHint).standardizedFileURL.path
                == grantedURL.standardizedFileURL.path
        }) {
            var record = records[existingIndex]
            record.bookmarkData = bookmark
            record.descriptor.lastOpenedAt = Date()
            let access = try WorkspaceAccess(
                workspaceID: record.id,
                bookmarkData: bookmark
            )
            record.descriptor.isGitRepository = access.isGitRepository
            records[existingIndex] = record
            try persist()
            return (record, access)
        }
        let workspaceID = WorkspaceID()
        let access = try WorkspaceAccess(workspaceID: workspaceID, grantedURL: grantedURL)
        let descriptor = WorkspaceDescriptor(
            id: workspaceID,
            displayName: grantedURL.lastPathComponent,
            localPathHint: grantedURL.path,
            isGitRepository: access.isGitRepository,
            lastOpenedAt: Date()
        )
        let record = WorkspaceRecord(descriptor: descriptor, bookmarkData: bookmark)
        records.append(record)
        try persist()
        return (record, access)
    }

    /// Reopens a known workspace strictly through its bookmark.
    public func open(id: WorkspaceID) throws -> (WorkspaceRecord, WorkspaceAccess) {
        try loadIfNeeded()
        guard let index = records.firstIndex(where: { $0.id == id }) else {
            throw WorkspaceDirectoryError.workspaceNotFound
        }
        var record = records[index]
        let access = try WorkspaceAccess(
            workspaceID: record.id,
            bookmarkData: record.bookmarkData
        )
        // Self-healing: a bookmark that resolved but reported itself stale is
        // re-minted here, so the next launch does not depend on the system
        // still being able to resolve outdated data. Best-effort — a failure to
        // re-mint must not fail an open that already succeeded.
        if access.bookmarkNeedsRefresh,
            let refreshed = try? WorkspaceAccess.makeBookmark(for: access.rootURL)
        {
            record.bookmarkData = refreshed
        }
        // The folder may have moved since it was granted; the bookmark tracks it
        // by file id, so the stored path hint is the thing that goes stale.
        record.descriptor.localPathHint = access.rootURL.path
        record.descriptor.lastOpenedAt = Date()
        record.descriptor.isGitRepository = access.isGitRepository
        records[index] = record
        try persist()
        return (record, access)
    }

    /// Replaces a known workspace's lapsed bookmark with a freshly granted one,
    /// **keeping its identity**.
    ///
    /// `register(grantedURL:)` would also work when the user picks the same
    /// folder — it matches on path — but it silently creates a *new* workspace
    /// when they pick a moved or renamed one, stranding every session,
    /// checkpoint and transcript recorded against the old id. A folder grant
    /// lapsing is precisely the case where the folder may have moved, so the
    /// re-grant path has to be explicit about which project it is repairing.
    ///
    /// The path hint and display name are refreshed from the new URL, since that
    /// is now where the project lives.
    public func regrant(
        id: WorkspaceID,
        grantedURL: URL
    ) throws -> (WorkspaceRecord, WorkspaceAccess) {
        try loadIfNeeded()
        guard let index = records.firstIndex(where: { $0.id == id }) else {
            throw WorkspaceDirectoryError.workspaceNotFound
        }
        // Built before anything is mutated: a URL the user picked that cannot be
        // bookmarked must leave the stored record exactly as it was.
        let bookmark = try WorkspaceAccess.makeBookmark(for: grantedURL)
        let access = try WorkspaceAccess(workspaceID: id, bookmarkData: bookmark)

        var record = records[index]
        record.bookmarkData = bookmark
        record.descriptor.localPathHint = grantedURL.path
        record.descriptor.displayName = grantedURL.lastPathComponent
        record.descriptor.isGitRepository = access.isGitRepository
        record.descriptor.lastOpenedAt = Date()
        records[index] = record
        try persist()
        return (record, access)
    }

    public func remove(id: WorkspaceID) throws {
        try loadIfNeeded()
        records.removeAll { $0.id == id }
        try persist()
    }

    /// Renames Juno's saved project label without renaming the folder on disk.
    public func rename(id: WorkspaceID, displayName: String) throws {
        try loadIfNeeded()
        guard let index = records.firstIndex(where: { $0.id == id }) else {
            throw WorkspaceDirectoryError.workspaceNotFound
        }
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        records[index].descriptor.displayName = name
        try persist()
    }

    // MARK: - Persistence

    private func loadIfNeeded() throws {
        guard !loaded else { return }
        loaded = true
        try? FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        records = (try? decoder.decode([WorkspaceRecord].self, from: data)) ?? []
    }

    private func persist() throws {
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(records)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            throw WorkspaceDirectoryError.persistenceFailed(message: String(describing: error))
        }
    }
}
