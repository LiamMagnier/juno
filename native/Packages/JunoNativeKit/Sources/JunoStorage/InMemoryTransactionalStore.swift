import Foundation

/// Transactional actor intended only for deterministic tests and development.
///
/// Production applications must inject a durable, encrypted SQLite-backed
/// implementation of `AccountScopedRepository`. This type deliberately never
/// serializes records to JSON, UserDefaults, or the filesystem.
public actor InMemoryTransactionalStore: AccountScopedRepository {
    private struct Bucket {
        var version: UInt64 = 0
        var records: [RecordKey: StoredRecord] = [:]
        var metadata: [String: Data] = [:]
    }

    private var buckets: [StorageAccountID: Bucket] = [:]

    public init() {}

    public func snapshot(for accountID: StorageAccountID) throws -> AccountStoreSnapshot {
        try StorageValidation.accountID(accountID)
        let bucket = buckets[accountID] ?? Bucket()
        return AccountStoreSnapshot(
            accountID: accountID,
            version: bucket.version,
            records: bucket.records,
            metadata: bucket.metadata
        )
    }

    @discardableResult
    public func apply(_ transaction: StorageTransaction) throws -> StorageCommit {
        try StorageValidation.transaction(transaction)

        let current = buckets[transaction.accountID] ?? Bucket()
        if let expected = transaction.expectedStoreVersion, expected != current.version {
            throw AccountStorageError.versionConflict(
                expected: expected,
                actual: current.version
            )
        }

        // Work on a value copy so any validation failure rolls back the entire
        // transaction, including operations that preceded the invalid one.
        var candidate = current
        var changedRecords = Set<RecordKey>()
        var changedMetadata = Set<String>()

        for operation in transaction.operations {
            switch operation {
            case let .upsert(record):
                if candidate.records[record.key] != record {
                    candidate.records[record.key] = record
                    changedRecords.insert(record.key)
                }

            case let .remove(key):
                if candidate.records.removeValue(forKey: key) != nil {
                    changedRecords.insert(key)
                }

            case let .setMetadata(key, value):
                if candidate.metadata[key] != value {
                    candidate.metadata[key] = value
                    changedMetadata.insert(key)
                }

            case let .removeMetadata(key):
                if candidate.metadata.removeValue(forKey: key) != nil {
                    changedMetadata.insert(key)
                }
            }
        }

        if !changedRecords.isEmpty || !changedMetadata.isEmpty {
            candidate.version += 1
            buckets[transaction.accountID] = candidate
        }

        return StorageCommit(
            accountID: transaction.accountID,
            version: candidate.version,
            changedRecords: changedRecords,
            changedMetadataKeys: changedMetadata
        )
    }

    public func wipe(accountID: StorageAccountID) throws {
        try StorageValidation.accountID(accountID)
        buckets.removeValue(forKey: accountID)
    }
}
