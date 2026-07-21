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
        try validate(accountID: accountID)
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
        try validate(accountID: transaction.accountID)

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
                try validate(record: record, expectedAccountID: transaction.accountID)
                if candidate.records[record.key] != record {
                    candidate.records[record.key] = record
                    changedRecords.insert(record.key)
                }

            case let .remove(key):
                try validate(key: key)
                if candidate.records.removeValue(forKey: key) != nil {
                    changedRecords.insert(key)
                }

            case let .setMetadata(key, value):
                try validate(metadataKey: key)
                if candidate.metadata[key] != value {
                    candidate.metadata[key] = value
                    changedMetadata.insert(key)
                }

            case let .removeMetadata(key):
                try validate(metadataKey: key)
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
        try validate(accountID: accountID)
        buckets.removeValue(forKey: accountID)
    }

    private func validate(accountID: StorageAccountID) throws {
        guard !accountID.rawValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AccountStorageError.invalidAccountID
        }
    }

    private func validate(key: RecordKey) throws {
        let namespace = key.namespace.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = key.id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !namespace.isEmpty, !id.isEmpty else {
            throw AccountStorageError.invalidRecordKey(key)
        }
    }

    private func validate(metadataKey: String) throws {
        guard !metadataKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AccountStorageError.invalidMetadataKey(metadataKey)
        }
    }

    private func validate(
        record: StoredRecord,
        expectedAccountID: StorageAccountID
    ) throws {
        try validate(key: record.key)
        guard record.accountID == expectedAccountID else {
            throw AccountStorageError.recordAccountMismatch(
                expected: expectedAccountID,
                actual: record.accountID
            )
        }
    }
}
