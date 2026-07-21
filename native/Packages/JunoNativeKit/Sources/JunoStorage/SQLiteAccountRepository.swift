import Foundation
import SQLite3

public enum SQLiteAccountRepositoryError: Error, Equatable, Sendable {
    case invalidDatabaseURL
    case openFailed(code: Int32)
    case databaseClosed
    case unsupportedSchemaVersion(Int32)
    case unexpectedUnversionedSchema
    case statementFailed(operation: String, code: Int32)
    case corruptStoredValue(field: String)
    case valueOutOfRange(field: String)
    case encryptionFailed(RecordKey)
    case decryptionFailed(RecordKey)
    case fileProtectionFailed
}

extension SQLiteAccountRepositoryError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidDatabaseURL:
            "The local account database URL is invalid."
        case .openFailed:
            "Juno could not open its local account database."
        case .databaseClosed:
            "The local account database is closed."
        case .unsupportedSchemaVersion:
            "The local account database was created by an unsupported version of Juno."
        case .unexpectedUnversionedSchema:
            "Juno found an unversioned local database and left it untouched."
        case .statementFailed:
            "The local account database operation failed."
        case .corruptStoredValue:
            "The local account database contains an invalid value."
        case .valueOutOfRange:
            "A value is too large for the local account database."
        case .encryptionFailed:
            "Juno could not encrypt a locally stored record."
        case .decryptionFailed:
            "Juno could not authenticate a locally stored record."
        case .fileProtectionFailed:
            "Juno could not protect its local account database."
        }
    }
}

/// Durable, account-partitioned storage for synced entity payloads and metadata.
///
/// The database uses WAL and full synchronous commits. Record payloads are
/// encrypted by the required cipher; the key is never stored in this database.
/// SQLite secure deletion and a truncated WAL are used when an account is wiped.
public actor SQLiteAccountRepository: AccountScopedRepository {
    public static let schemaVersion: Int32 = 1

    public nonisolated let databaseURL: URL

    private let database: SQLiteDatabase
    private let cipher: any AccountDataCipher

    public init(databaseURL: URL, cipher: any AccountDataCipher) throws {
        guard databaseURL.isFileURL, !databaseURL.path.isEmpty else {
            throw SQLiteAccountRepositoryError.invalidDatabaseURL
        }
        self.databaseURL = databaseURL
        self.cipher = cipher
        self.database = try SQLiteDatabase(
            url: databaseURL,
            schemaVersion: Self.schemaVersion
        )
    }

    public func snapshot(
        for accountID: StorageAccountID
    ) throws -> AccountStoreSnapshot {
        try StorageValidation.accountID(accountID)
        let version = try loadVersion(for: accountID)
        let records = try loadRecords(for: accountID)
        let metadata = try loadMetadata(for: accountID)
        return AccountStoreSnapshot(
            accountID: accountID,
            version: version,
            records: records,
            metadata: metadata
        )
    }

    @discardableResult
    public func apply(_ transaction: StorageTransaction) throws -> StorageCommit {
        try StorageValidation.transaction(transaction)
        try validateSQLiteValues(in: transaction)
        try database.execute("BEGIN IMMEDIATE", operation: "begin transaction")
        var committed = false

        do {
            let currentVersion = try loadVersion(for: transaction.accountID)
            if let expected = transaction.expectedStoreVersion,
                expected != currentVersion
            {
                throw AccountStorageError.versionConflict(
                    expected: expected,
                    actual: currentVersion
                )
            }

            var changedRecords = Set<RecordKey>()
            var changedMetadata = Set<String>()

            for operation in transaction.operations {
                switch operation {
                case .upsert(let record):
                    if try loadRecord(
                        accountID: transaction.accountID,
                        key: record.key
                    ) != record {
                        try ensureAccountRow(
                            accountID: transaction.accountID,
                            version: currentVersion
                        )
                        try upsert(record)
                        changedRecords.insert(record.key)
                    }

                case .remove(let key):
                    if try recordExists(accountID: transaction.accountID, key: key) {
                        try deleteRecord(accountID: transaction.accountID, key: key)
                        changedRecords.insert(key)
                    }

                case .setMetadata(let key, let value):
                    if try loadMetadataValue(
                        accountID: transaction.accountID,
                        key: key
                    ) != value {
                        try ensureAccountRow(
                            accountID: transaction.accountID,
                            version: currentVersion
                        )
                        try upsertMetadata(
                            accountID: transaction.accountID,
                            key: key,
                            value: value
                        )
                        changedMetadata.insert(key)
                    }

                case .removeMetadata(let key):
                    if try loadMetadataValue(
                        accountID: transaction.accountID,
                        key: key
                    ) != nil {
                        try deleteMetadata(accountID: transaction.accountID, key: key)
                        changedMetadata.insert(key)
                    }
                }
            }

            let nextVersion: UInt64
            if changedRecords.isEmpty, changedMetadata.isEmpty {
                nextVersion = currentVersion
            } else {
                guard currentVersion < UInt64(Int64.max) else {
                    throw SQLiteAccountRepositoryError.valueOutOfRange(
                        field: "store version"
                    )
                }
                nextVersion = currentVersion + 1
                try updateVersion(nextVersion, for: transaction.accountID)
            }

            try database.execute("COMMIT", operation: "commit transaction")
            committed = true
            try database.protectFiles()
            return StorageCommit(
                accountID: transaction.accountID,
                version: nextVersion,
                changedRecords: changedRecords,
                changedMetadataKeys: changedMetadata
            )
        } catch {
            if !committed {
                try? database.execute("ROLLBACK", operation: "rollback transaction")
            }
            throw error
        }
    }

    public func wipe(accountID: StorageAccountID) throws {
        try StorageValidation.accountID(accountID)
        try database.execute("BEGIN IMMEDIATE", operation: "begin wipe")
        var committed = false
        do {
            try database.withStatement(
                "DELETE FROM accounts WHERE account_id = ?",
                operation: "wipe account"
            ) { statement in
                try database.bind(accountID.rawValue, at: 1, to: statement)
                try database.expectDone(statement, operation: "wipe account")
            }
            try database.execute("COMMIT", operation: "commit wipe")
            committed = true
        } catch {
            if !committed {
                try? database.execute("ROLLBACK", operation: "rollback wipe")
            }
            throw error
        }
        try database.execute(
            "PRAGMA wal_checkpoint(TRUNCATE)",
            operation: "truncate wipe log"
        )
        try database.protectFiles()
    }

    public func close() throws {
        try database.close()
    }

    private func validateSQLiteValues(in transaction: StorageTransaction) throws {
        if let expected = transaction.expectedStoreVersion,
            expected > UInt64(Int64.max)
        {
            throw SQLiteAccountRepositoryError.valueOutOfRange(
                field: "expected store version"
            )
        }
        for operation in transaction.operations {
            switch operation {
            case .upsert(let record):
                guard record.revision <= UInt64(Int64.max) else {
                    throw SQLiteAccountRepositoryError.valueOutOfRange(
                        field: "revision"
                    )
                }
                guard record.updatedAt.timeIntervalSince1970.isFinite else {
                    throw SQLiteAccountRepositoryError.valueOutOfRange(
                        field: "updatedAt"
                    )
                }
                guard (record.payload?.count ?? 0) <= Int(Int32.max) else {
                    throw SQLiteAccountRepositoryError.valueOutOfRange(
                        field: "record payload"
                    )
                }
            case .setMetadata(_, let value):
                guard value.count <= Int(Int32.max) else {
                    throw SQLiteAccountRepositoryError.valueOutOfRange(
                        field: "metadata value"
                    )
                }
            case .remove, .removeMetadata:
                break
            }
        }
    }

    private func loadVersion(for accountID: StorageAccountID) throws -> UInt64 {
        try database.withStatement(
            "SELECT store_version FROM accounts WHERE account_id = ?",
            operation: "load account version"
        ) { statement in
            try database.bind(accountID.rawValue, at: 1, to: statement)
            switch try database.step(statement, operation: "load account version") {
            case SQLITE_DONE:
                return 0
            case SQLITE_ROW:
                let value = sqlite3_column_int64(statement, 0)
                guard value >= 0 else {
                    throw SQLiteAccountRepositoryError.corruptStoredValue(
                        field: "store version"
                    )
                }
                return UInt64(value)
            default:
                preconditionFailure("SQLite step returned an unexpected result")
            }
        }
    }

    private func loadRecords(
        for accountID: StorageAccountID
    ) throws -> [RecordKey: StoredRecord] {
        try database.withStatement(
            """
            SELECT namespace, record_id, revision, updated_at, is_tombstone, payload
            FROM records WHERE account_id = ?
            """,
            operation: "load account records"
        ) { statement in
            try database.bind(accountID.rawValue, at: 1, to: statement)
            var records: [RecordKey: StoredRecord] = [:]
            while try database.step(statement, operation: "load account records")
                == SQLITE_ROW
            {
                let record = try decodeRecord(statement, accountID: accountID)
                guard records.updateValue(record, forKey: record.key) == nil else {
                    throw SQLiteAccountRepositoryError.corruptStoredValue(
                        field: "duplicate record"
                    )
                }
            }
            return records
        }
    }

    private func loadRecord(
        accountID: StorageAccountID,
        key: RecordKey
    ) throws -> StoredRecord? {
        try database.withStatement(
            """
            SELECT namespace, record_id, revision, updated_at, is_tombstone, payload
            FROM records
            WHERE account_id = ? AND namespace = ? AND record_id = ?
            """,
            operation: "load record"
        ) { statement in
            try database.bind(accountID.rawValue, at: 1, to: statement)
            try database.bind(key.namespace, at: 2, to: statement)
            try database.bind(key.id, at: 3, to: statement)
            switch try database.step(statement, operation: "load record") {
            case SQLITE_DONE:
                return nil
            case SQLITE_ROW:
                return try decodeRecord(statement, accountID: accountID)
            default:
                preconditionFailure("SQLite step returned an unexpected result")
            }
        }
    }

    private func recordExists(
        accountID: StorageAccountID,
        key: RecordKey
    ) throws -> Bool {
        try database.withStatement(
            """
            SELECT 1 FROM records
            WHERE account_id = ? AND namespace = ? AND record_id = ?
            """,
            operation: "check record"
        ) { statement in
            try database.bind(accountID.rawValue, at: 1, to: statement)
            try database.bind(key.namespace, at: 2, to: statement)
            try database.bind(key.id, at: 3, to: statement)
            return try database.step(statement, operation: "check record") == SQLITE_ROW
        }
    }

    private func decodeRecord(
        _ statement: OpaquePointer,
        accountID: StorageAccountID
    ) throws -> StoredRecord {
        let namespace = try database.text(
            statement,
            column: 0,
            field: "record namespace"
        )
        let recordID = try database.text(
            statement,
            column: 1,
            field: "record ID"
        )
        let key = RecordKey(namespace: namespace, id: recordID)
        try StorageValidation.key(key)

        let revisionValue = sqlite3_column_int64(statement, 2)
        let timestamp = sqlite3_column_double(statement, 3)
        let tombstoneValue = sqlite3_column_int(statement, 4)
        guard revisionValue >= 0, timestamp.isFinite,
            tombstoneValue == 0 || tombstoneValue == 1
        else {
            throw SQLiteAccountRepositoryError.corruptStoredValue(
                field: "record fields"
            )
        }

        let revision = UInt64(revisionValue)
        let updatedAt = Date(timeIntervalSince1970: timestamp)
        let isTombstone = tombstoneValue == 1
        let payload: Data?
        if isTombstone {
            guard sqlite3_column_type(statement, 5) == SQLITE_NULL else {
                throw SQLiteAccountRepositoryError.corruptStoredValue(
                    field: "tombstone payload"
                )
            }
            payload = nil
        } else if sqlite3_column_type(statement, 5) == SQLITE_NULL {
            payload = nil
        } else {
            let encrypted = try database.data(
                statement,
                column: 5,
                field: "record payload"
            )
            do {
                payload = try cipher.open(
                    encrypted,
                    context: AccountDataCipherContext(
                        accountID: accountID,
                        recordKey: key,
                        revision: revision,
                        updatedAt: updatedAt
                    )
                )
            } catch {
                throw SQLiteAccountRepositoryError.decryptionFailed(key)
            }
        }

        return StoredRecord(
            accountID: accountID,
            key: key,
            revision: revision,
            updatedAt: updatedAt,
            isTombstone: isTombstone,
            payload: payload
        )
    }

    private func loadMetadata(
        for accountID: StorageAccountID
    ) throws -> [String: Data] {
        try database.withStatement(
            "SELECT metadata_key, value FROM metadata WHERE account_id = ?",
            operation: "load account metadata"
        ) { statement in
            try database.bind(accountID.rawValue, at: 1, to: statement)
            var metadata: [String: Data] = [:]
            while try database.step(statement, operation: "load account metadata")
                == SQLITE_ROW
            {
                let key = try database.text(
                    statement,
                    column: 0,
                    field: "metadata key"
                )
                try StorageValidation.metadataKey(key)
                let value = try database.data(
                    statement,
                    column: 1,
                    field: "metadata value"
                )
                guard metadata.updateValue(value, forKey: key) == nil else {
                    throw SQLiteAccountRepositoryError.corruptStoredValue(
                        field: "duplicate metadata"
                    )
                }
            }
            return metadata
        }
    }

    private func loadMetadataValue(
        accountID: StorageAccountID,
        key: String
    ) throws -> Data? {
        try database.withStatement(
            "SELECT value FROM metadata WHERE account_id = ? AND metadata_key = ?",
            operation: "load metadata"
        ) { statement in
            try database.bind(accountID.rawValue, at: 1, to: statement)
            try database.bind(key, at: 2, to: statement)
            switch try database.step(statement, operation: "load metadata") {
            case SQLITE_DONE:
                return nil
            case SQLITE_ROW:
                return try database.data(
                    statement,
                    column: 0,
                    field: "metadata value"
                )
            default:
                preconditionFailure("SQLite step returned an unexpected result")
            }
        }
    }

    private func ensureAccountRow(
        accountID: StorageAccountID,
        version: UInt64
    ) throws {
        try database.withStatement(
            "INSERT OR IGNORE INTO accounts(account_id, store_version) VALUES(?, ?)",
            operation: "create account partition"
        ) { statement in
            try database.bind(accountID.rawValue, at: 1, to: statement)
            try database.bind(Int64(version), at: 2, to: statement)
            try database.expectDone(statement, operation: "create account partition")
        }
    }

    private func upsert(_ record: StoredRecord) throws {
        let sealedPayload: Data?
        if let payload = record.payload {
            do {
                sealedPayload = try cipher.seal(
                    payload,
                    context: AccountDataCipherContext(
                        accountID: record.accountID,
                        recordKey: record.key,
                        revision: record.revision,
                        updatedAt: record.updatedAt
                    )
                )
            } catch {
                throw SQLiteAccountRepositoryError.encryptionFailed(record.key)
            }
        } else {
            sealedPayload = nil
        }

        try database.withStatement(
            """
            INSERT INTO records(
                account_id, namespace, record_id, revision, updated_at,
                is_tombstone, payload
            ) VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, namespace, record_id) DO UPDATE SET
                revision = excluded.revision,
                updated_at = excluded.updated_at,
                is_tombstone = excluded.is_tombstone,
                payload = excluded.payload
            """,
            operation: "upsert record"
        ) { statement in
            try database.bind(record.accountID.rawValue, at: 1, to: statement)
            try database.bind(record.key.namespace, at: 2, to: statement)
            try database.bind(record.key.id, at: 3, to: statement)
            try database.bind(Int64(record.revision), at: 4, to: statement)
            try database.bind(record.updatedAt.timeIntervalSince1970, at: 5, to: statement)
            try database.bind(
                Int32(record.isTombstone ? 1 : 0),
                at: 6,
                to: statement
            )
            try database.bind(sealedPayload, at: 7, to: statement)
            try database.expectDone(statement, operation: "upsert record")
        }
    }

    private func deleteRecord(
        accountID: StorageAccountID,
        key: RecordKey
    ) throws {
        try database.withStatement(
            """
            DELETE FROM records
            WHERE account_id = ? AND namespace = ? AND record_id = ?
            """,
            operation: "delete record"
        ) { statement in
            try database.bind(accountID.rawValue, at: 1, to: statement)
            try database.bind(key.namespace, at: 2, to: statement)
            try database.bind(key.id, at: 3, to: statement)
            try database.expectDone(statement, operation: "delete record")
        }
    }

    private func upsertMetadata(
        accountID: StorageAccountID,
        key: String,
        value: Data
    ) throws {
        try database.withStatement(
            """
            INSERT INTO metadata(account_id, metadata_key, value) VALUES(?, ?, ?)
            ON CONFLICT(account_id, metadata_key) DO UPDATE SET value = excluded.value
            """,
            operation: "upsert metadata"
        ) { statement in
            try database.bind(accountID.rawValue, at: 1, to: statement)
            try database.bind(key, at: 2, to: statement)
            try database.bind(value, at: 3, to: statement)
            try database.expectDone(statement, operation: "upsert metadata")
        }
    }

    private func deleteMetadata(
        accountID: StorageAccountID,
        key: String
    ) throws {
        try database.withStatement(
            "DELETE FROM metadata WHERE account_id = ? AND metadata_key = ?",
            operation: "delete metadata"
        ) { statement in
            try database.bind(accountID.rawValue, at: 1, to: statement)
            try database.bind(key, at: 2, to: statement)
            try database.expectDone(statement, operation: "delete metadata")
        }
    }

    private func updateVersion(
        _ version: UInt64,
        for accountID: StorageAccountID
    ) throws {
        try database.withStatement(
            "UPDATE accounts SET store_version = ? WHERE account_id = ?",
            operation: "update account version"
        ) { statement in
            try database.bind(Int64(version), at: 1, to: statement)
            try database.bind(accountID.rawValue, at: 2, to: statement)
            try database.expectDone(statement, operation: "update account version")
        }
    }
}
