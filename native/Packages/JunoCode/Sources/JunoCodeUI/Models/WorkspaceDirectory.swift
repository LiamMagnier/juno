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
        record.descriptor.lastOpenedAt = Date()
        record.descriptor.isGitRepository = access.isGitRepository
        records[index] = record
        try persist()
        return (record, access)
    }

    public func remove(id: WorkspaceID) throws {
        try loadIfNeeded()
        records.removeAll { $0.id == id }
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
