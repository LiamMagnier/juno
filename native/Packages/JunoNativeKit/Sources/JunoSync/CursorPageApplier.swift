import Foundation
import JunoStorage

public struct SyncChangePage: Equatable, Sendable {
    public let accountID: StorageAccountID
    public let previousCursor: String?
    public let nextCursor: String
    public let changes: [StoredRecord]

    public init(
        accountID: StorageAccountID,
        previousCursor: String?,
        nextCursor: String,
        changes: [StoredRecord]
    ) {
        self.accountID = accountID
        self.previousCursor = previousCursor
        self.nextCursor = nextCursor
        self.changes = changes
    }
}

public struct CursorPageApplyResult: Equatable, Sendable {
    public enum Disposition: Equatable, Sendable {
        case applied
        case alreadyApplied
    }

    public let disposition: Disposition
    public let cursor: String
    public let appliedRecordCount: Int
    public let ignoredRecordCount: Int

    public init(
        disposition: Disposition,
        cursor: String,
        appliedRecordCount: Int,
        ignoredRecordCount: Int
    ) {
        self.disposition = disposition
        self.cursor = cursor
        self.appliedRecordCount = appliedRecordCount
        self.ignoredRecordCount = ignoredRecordCount
    }
}

public enum CursorPageError: Error, Equatable, Sendable {
    case invalidNextCursor
    case nonAdvancingCursor(String)
    case corruptStoredCursor
    case cursorGap(expected: String?, received: String?)
    case recordAccountMismatch(key: RecordKey)
    case conflictingPageRevision(key: RecordKey, revision: UInt64)
    case conflictingStoredRevision(key: RecordKey, revision: UInt64)
    case concurrentWriteLimitExceeded
}

extension CursorPageError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidNextCursor:
            "The sync page has an empty next cursor."
        case let .nonAdvancingCursor(cursor):
            "The sync page does not advance beyond cursor \(cursor)."
        case .corruptStoredCursor:
            "The persisted sync cursor is not valid UTF-8."
        case let .cursorGap(expected, received):
            "The sync page starts at \(received ?? "nil"), expected \(expected ?? "nil")."
        case let .recordAccountMismatch(key):
            "The sync change for \(key.namespace)/\(key.id) belongs to another account."
        case let .conflictingPageRevision(key, revision):
            "The page contains conflicting values for \(key.namespace)/\(key.id) at revision \(revision)."
        case let .conflictingStoredRevision(key, revision):
            "The store and server disagree for \(key.namespace)/\(key.id) at revision \(revision)."
        case .concurrentWriteLimitExceeded:
            "The account store remained busy while applying the sync page."
        }
    }
}

/// Atomically applies ordered change pages and their cursor.
///
/// The actor serializes page application while the repository's optimistic
/// version protects against writers outside this actor. Replaying the most
/// recently committed page is an idempotent no-op.
public actor CursorPageApplier<Repository: AccountScopedRepository> {
    public static var cursorMetadataKey: String { "sync.changeCursor" }

    private let repository: Repository
    private let maximumTransactionAttempts: Int

    public init(repository: Repository, maximumTransactionAttempts: Int = 4) {
        self.repository = repository
        self.maximumTransactionAttempts = max(1, maximumTransactionAttempts)
    }

    public func apply(_ page: SyncChangePage) async throws -> CursorPageApplyResult {
        guard !page.nextCursor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CursorPageError.invalidNextCursor
        }
        if page.previousCursor == page.nextCursor {
            throw CursorPageError.nonAdvancingCursor(page.nextCursor)
        }

        let collapsedChanges = try collapse(page.changes, for: page.accountID)

        for attempt in 0 ..< maximumTransactionAttempts {
            let snapshot = try await repository.snapshot(for: page.accountID)
            let storedCursor = try decodeCursor(snapshot.metadata[Self.cursorMetadataKey])

            if storedCursor == page.nextCursor {
                return CursorPageApplyResult(
                    disposition: .alreadyApplied,
                    cursor: page.nextCursor,
                    appliedRecordCount: 0,
                    ignoredRecordCount: page.changes.count
                )
            }

            guard storedCursor == page.previousCursor else {
                throw CursorPageError.cursorGap(
                    expected: storedCursor,
                    received: page.previousCursor
                )
            }

            var operations: [StorageOperation] = []
            var ignoredCount = page.changes.count - collapsedChanges.count

            for record in collapsedChanges.values.sorted(by: recordOrder) {
                if let existing = snapshot.records[record.key] {
                    if record.revision < existing.revision {
                        ignoredCount += 1
                        continue
                    }
                    if record.revision == existing.revision {
                        guard record == existing else {
                            throw CursorPageError.conflictingStoredRevision(
                                key: record.key,
                                revision: record.revision
                            )
                        }
                        ignoredCount += 1
                        continue
                    }
                }
                operations.append(.upsert(record))
            }

            operations.append(
                .setMetadata(
                    key: Self.cursorMetadataKey,
                    value: Data(page.nextCursor.utf8)
                )
            )

            do {
                let commit = try await repository.apply(
                    StorageTransaction(
                        accountID: page.accountID,
                        expectedStoreVersion: snapshot.version,
                        operations: operations
                    )
                )
                return CursorPageApplyResult(
                    disposition: .applied,
                    cursor: page.nextCursor,
                    appliedRecordCount: commit.changedRecords.count,
                    ignoredRecordCount: ignoredCount
                )
            } catch AccountStorageError.versionConflict where attempt + 1 < maximumTransactionAttempts {
                continue
            } catch AccountStorageError.versionConflict {
                throw CursorPageError.concurrentWriteLimitExceeded
            }
        }

        throw CursorPageError.concurrentWriteLimitExceeded
    }

    private func decodeCursor(_ data: Data?) throws -> String? {
        guard let data else { return nil }
        guard let cursor = String(data: data, encoding: .utf8) else {
            throw CursorPageError.corruptStoredCursor
        }
        return cursor
    }

    private func collapse(
        _ records: [StoredRecord],
        for accountID: StorageAccountID
    ) throws -> [RecordKey: StoredRecord] {
        var result: [RecordKey: StoredRecord] = [:]

        for record in records {
            guard record.accountID == accountID else {
                throw CursorPageError.recordAccountMismatch(key: record.key)
            }
            guard let existing = result[record.key] else {
                result[record.key] = record
                continue
            }

            if record.revision > existing.revision {
                result[record.key] = record
            } else if record.revision == existing.revision, record != existing {
                throw CursorPageError.conflictingPageRevision(
                    key: record.key,
                    revision: record.revision
                )
            }
        }

        return result
    }

    private func recordOrder(_ lhs: StoredRecord, _ rhs: StoredRecord) -> Bool {
        if lhs.key.namespace != rhs.key.namespace {
            return lhs.key.namespace < rhs.key.namespace
        }
        return lhs.key.id < rhs.key.id
    }
}
