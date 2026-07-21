import Foundation
import JunoAPI
import JunoCore
import JunoStorage

public enum NativeBootstrapBaselineError: Error, Equatable, Sendable {
    case accountMismatch
    case invalidCheckpoint
    case conflictingRecord(RecordKey)
    case corruptStoredCursor
    case baselineAlreadyInstalled(storedCursor: String, receivedCursor: String)
    case concurrentWriteLimitExceeded
}

/// Commits a fully hydrated bootstrap snapshot and its cursor in one account
/// transaction. Callers must fetch and decode all baseline entities before
/// invoking this installer; persisting the cursor earlier could skip data that
/// changed before hydration completed.
public actor NativeBootstrapBaselineInstaller<Repository: AccountScopedRepository> {
    public static var compactionFloorMetadataKey: String {
        "sync.compactionFloorCursor"
    }

    public static var modelManifestMetadataKey: String {
        "sync.modelManifestVersion"
    }

    public static var contractVersionMetadataKey: String {
        "sync.contractVersion"
    }

    private let repository: Repository
    private let maximumTransactionAttempts: Int

    public init(repository: Repository, maximumTransactionAttempts: Int = 4) {
        self.repository = repository
        self.maximumTransactionAttempts = max(1, maximumTransactionAttempts)
    }

    @discardableResult
    public func install(
        checkpoint: NativeBootstrapCheckpoint,
        records: [StoredRecord]
    ) async throws -> StorageCommit {
        guard isCanonicalCursor(checkpoint.currentChangeCursor),
            isCanonicalCursor(checkpoint.compactionFloorCursor),
            cursorValue(checkpoint.compactionFloorCursor)
                <= cursorValue(checkpoint.currentChangeCursor),
            isValidManifestVersion(checkpoint.modelManifestVersion)
        else {
            throw NativeBootstrapBaselineError.invalidCheckpoint
        }
        let accountID = StorageAccountID(checkpoint.profile.id.rawValue)
        guard records.allSatisfy({ $0.accountID == accountID }) else {
            throw NativeBootstrapBaselineError.accountMismatch
        }
        var uniqueRecords: [RecordKey: StoredRecord] = [:]
        for record in records {
            if let existing = uniqueRecords[record.key], existing != record {
                throw NativeBootstrapBaselineError.conflictingRecord(record.key)
            }
            uniqueRecords[record.key] = record
        }

        for attempt in 0..<maximumTransactionAttempts {
            let snapshot = try await repository.snapshot(for: accountID)
            let storedCursor = try decodeCursor(
                snapshot.metadata[CursorPageApplier<Repository>.cursorMetadataKey]
            )
            if let storedCursor, storedCursor != checkpoint.currentChangeCursor {
                throw NativeBootstrapBaselineError.baselineAlreadyInstalled(
                    storedCursor: storedCursor,
                    receivedCursor: checkpoint.currentChangeCursor
                )
            }

            var operations = uniqueRecords.values
                .sorted(by: recordOrder)
                .map(StorageOperation.upsert)
            operations.append(contentsOf: [
                .setMetadata(
                    key: CursorPageApplier<Repository>.cursorMetadataKey,
                    value: Data(checkpoint.currentChangeCursor.utf8)
                ),
                .setMetadata(
                    key: Self.compactionFloorMetadataKey,
                    value: Data(checkpoint.compactionFloorCursor.utf8)
                ),
                .setMetadata(
                    key: Self.modelManifestMetadataKey,
                    value: Data(checkpoint.modelManifestVersion.utf8)
                ),
                .setMetadata(
                    key: Self.contractVersionMetadataKey,
                    value: Data(JunoNativeContract.version.utf8)
                ),
            ])

            do {
                return try await repository.apply(
                    StorageTransaction(
                        accountID: accountID,
                        expectedStoreVersion: snapshot.version,
                        operations: operations
                    )
                )
            } catch AccountStorageError.versionConflict where
                attempt + 1 < maximumTransactionAttempts
            {
                continue
            } catch AccountStorageError.versionConflict {
                throw NativeBootstrapBaselineError.concurrentWriteLimitExceeded
            }
        }

        throw NativeBootstrapBaselineError.concurrentWriteLimitExceeded
    }

    private func decodeCursor(_ data: Data?) throws -> String? {
        guard let data else { return nil }
        guard let cursor = String(data: data, encoding: .utf8),
            isCanonicalCursor(cursor)
        else {
            throw NativeBootstrapBaselineError.corruptStoredCursor
        }
        return cursor
    }

    private func isCanonicalCursor(_ cursor: String) -> Bool {
        cursor == "0" || (
            cursor.first != "0"
                && cursor.utf8.allSatisfy { (48...57).contains($0) }
                && Int64(cursor) != nil
        )
    }

    private func cursorValue(_ cursor: String) -> Int64 {
        Int64(cursor) ?? -1
    }

    private func isValidManifestVersion(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return value == trimmed
            && (1...128).contains(value.utf8.count)
            && !value.unicodeScalars.contains {
                CharacterSet.controlCharacters.contains($0)
            }
    }

    private func recordOrder(_ lhs: StoredRecord, _ rhs: StoredRecord) -> Bool {
        if lhs.key.namespace != rhs.key.namespace {
            return lhs.key.namespace < rhs.key.namespace
        }
        return lhs.key.id < rhs.key.id
    }
}
