import Foundation
import SQLite3
import XCTest
@testable import JunoStorage

final class SQLiteAccountRepositoryTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")
    private let key = RecordKey(namespace: "messages", id: "message-1")
    private let timestamp = Date(timeIntervalSince1970: 1_700_000_000)

    func testEncryptedRoundTripPersistsAcrossReopen() async throws {
        let location = try DatabaseLocation()
        defer { location.remove() }
        let plaintext = Data("private-message-payload".utf8)
        let cipher = try testCipher(byte: 0x41)
        let first = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: cipher
        )
        let expectedRecord = record(accountID: accountA, payload: plaintext)

        let commit = try await first.apply(
            StorageTransaction(
                accountID: accountA,
                operations: [
                    .upsert(expectedRecord),
                    .setMetadata(key: "sync.changeCursor", value: Data("42".utf8)),
                ]
            )
        )
        XCTAssertEqual(commit.version, 1)
        try await first.close()

        let persistedPayload = try rawPayload(at: location.databaseURL)
        XCTAssertNotEqual(persistedPayload, plaintext)
        XCTAssertFalse(persistedPayload.isEmpty)

        let reopened = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: cipher
        )
        let snapshot = try await reopened.snapshot(for: accountA)
        XCTAssertEqual(snapshot.version, 1)
        XCTAssertEqual(snapshot.records[key], expectedRecord)
        XCTAssertEqual(snapshot.metadata["sync.changeCursor"], Data("42".utf8))
        try await reopened.close()

        let attributes = try FileManager.default.attributesOfItem(
            atPath: location.databaseURL.path
        )
        let permissions = attributes[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }

    func testCiphertextCannotMoveAcrossAccountsOrContexts() async throws {
        let location = try DatabaseLocation()
        defer { location.remove() }
        let first = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: testCipher(byte: 0x42)
        )
        _ = try await first.apply(
            StorageTransaction(
                accountID: accountA,
                operations: [.upsert(record(accountID: accountA))]
            )
        )
        try await first.close()

        let wrongKey = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: testCipher(byte: 0x43)
        )
        do {
            _ = try await wrongKey.snapshot(for: accountA)
            XCTFail("A different Keychain key must not decrypt the database")
        } catch {
            XCTAssertEqual(
                error as? SQLiteAccountRepositoryError,
                .decryptionFailed(key)
            )
        }
        try await wrongKey.close()

        try mutateDatabase(
            at: location.databaseURL,
            sql: "UPDATE records SET revision = revision + 1"
        )
        let tampered = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: testCipher(byte: 0x42)
        )
        do {
            _ = try await tampered.snapshot(for: accountA)
            XCTFail("Changing authenticated record context must fail closed")
        } catch {
            XCTAssertEqual(
                error as? SQLiteAccountRepositoryError,
                .decryptionFailed(key)
            )
        }
        try await tampered.close()
    }

    func testTransactionRollsBackAfterCipherFailure() async throws {
        let location = try DatabaseLocation()
        defer { location.remove() }
        let store = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: FailingCipher()
        )

        do {
            _ = try await store.apply(
                StorageTransaction(
                    accountID: accountA,
                    operations: [
                        .setMetadata(key: "before.failure", value: Data("value".utf8)),
                        .upsert(record(accountID: accountA)),
                    ]
                )
            )
            XCTFail("A cipher failure must roll back prior SQL writes")
        } catch {
            XCTAssertEqual(
                error as? SQLiteAccountRepositoryError,
                .encryptionFailed(key)
            )
        }

        let snapshot = try await store.snapshot(for: accountA)
        XCTAssertEqual(snapshot.version, 0)
        XCTAssertTrue(snapshot.records.isEmpty)
        XCTAssertTrue(snapshot.metadata.isEmpty)
        try await store.close()
    }

    func testOptimisticVersionAndNoOpMatchMemoryAdapter() async throws {
        let location = try DatabaseLocation()
        defer { location.remove() }
        let store = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: testCipher(byte: 0x44)
        )
        let storedRecord = record(accountID: accountA)

        let first = try await store.apply(
            StorageTransaction(
                accountID: accountA,
                expectedStoreVersion: 0,
                operations: [.upsert(storedRecord)]
            )
        )
        let replay = try await store.apply(
            StorageTransaction(
                accountID: accountA,
                expectedStoreVersion: 1,
                operations: [.upsert(storedRecord)]
            )
        )
        XCTAssertEqual(first.version, 1)
        XCTAssertEqual(replay.version, 1)
        XCTAssertTrue(replay.changedRecords.isEmpty)

        do {
            _ = try await store.apply(
                StorageTransaction(
                    accountID: accountA,
                    expectedStoreVersion: 0,
                    operations: [.remove(key)]
                )
            )
            XCTFail("A stale store version must fail")
        } catch {
            XCTAssertEqual(
                error as? AccountStorageError,
                .versionConflict(expected: 0, actual: 1)
            )
        }
        let finalSnapshot = try await store.snapshot(for: accountA)
        XCTAssertEqual(finalSnapshot.records[key], storedRecord)
        try await store.close()
    }

    func testAccountWipeCascadesWithoutTouchingAnotherPartition() async throws {
        let location = try DatabaseLocation()
        defer { location.remove() }
        let store = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: testCipher(byte: 0x45)
        )
        _ = try await store.apply(
            StorageTransaction(
                accountID: accountA,
                operations: [
                    .upsert(record(accountID: accountA, revision: 1)),
                    .setMetadata(key: "cursor", value: Data("1".utf8)),
                ]
            )
        )
        _ = try await store.apply(
            StorageTransaction(
                accountID: accountB,
                operations: [
                    .upsert(record(accountID: accountB, revision: 8)),
                    .setMetadata(key: "cursor", value: Data("8".utf8)),
                ]
            )
        )

        try await store.wipe(accountID: accountA)

        let wiped = try await store.snapshot(for: accountA)
        let preserved = try await store.snapshot(for: accountB)
        XCTAssertEqual(wiped.version, 0)
        XCTAssertTrue(wiped.records.isEmpty)
        XCTAssertTrue(wiped.metadata.isEmpty)
        XCTAssertEqual(preserved.records[key]?.revision, 8)
        XCTAssertEqual(preserved.metadata["cursor"], Data("8".utf8))
        try await store.close()
    }

    func testTombstoneNeverPersistsPayload() async throws {
        let location = try DatabaseLocation()
        defer { location.remove() }
        let store = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: testCipher(byte: 0x46)
        )
        let tombstone = StoredRecord(
            accountID: accountA,
            key: key,
            revision: 2,
            updatedAt: timestamp,
            isTombstone: true,
            payload: Data("must-disappear".utf8)
        )

        _ = try await store.apply(
            StorageTransaction(accountID: accountA, operations: [.upsert(tombstone)])
        )
        let snapshot = try await store.snapshot(for: accountA)
        XCTAssertNil(snapshot.records[key]?.payload)
        try await store.close()
        XCTAssertNil(try rawPayloadIfPresent(at: location.databaseURL))
    }

    func testRejectsUnknownAndUnversionedSchemas() throws {
        let future = try DatabaseLocation()
        defer { future.remove() }
        try mutateDatabase(at: future.databaseURL, sql: "PRAGMA user_version = 99")
        XCTAssertThrowsError(
            try SQLiteAccountRepository(
                databaseURL: future.databaseURL,
                cipher: testCipher(byte: 0x47)
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteAccountRepositoryError,
                .unsupportedSchemaVersion(99)
            )
        }

        let unknown = try DatabaseLocation()
        defer { unknown.remove() }
        try mutateDatabase(
            at: unknown.databaseURL,
            sql: "CREATE TABLE legacy(value TEXT)"
        )
        XCTAssertThrowsError(
            try SQLiteAccountRepository(
                databaseURL: unknown.databaseURL,
                cipher: testCipher(byte: 0x48)
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteAccountRepositoryError,
                .unexpectedUnversionedSchema
            )
        }

        let malformed = try DatabaseLocation()
        defer { malformed.remove() }
        try mutateDatabase(
            at: malformed.databaseURL,
            sql: """
            CREATE TABLE accounts (
                account_id TEXT PRIMARY KEY NOT NULL,
                store_version INTEGER NOT NULL
            );
            CREATE TABLE records (
                account_id TEXT NOT NULL,
                namespace TEXT NOT NULL,
                record_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                updated_at REAL NOT NULL,
                is_tombstone INTEGER NOT NULL,
                payload BLOB,
                PRIMARY KEY(account_id, namespace, record_id)
            ) WITHOUT ROWID;
            CREATE TABLE metadata (
                account_id TEXT NOT NULL,
                metadata_key TEXT NOT NULL,
                value BLOB NOT NULL,
                PRIMARY KEY(account_id, metadata_key)
            ) WITHOUT ROWID;
            PRAGMA user_version = 1;
            """
        )
        XCTAssertThrowsError(
            try SQLiteAccountRepository(
                databaseURL: malformed.databaseURL,
                cipher: testCipher(byte: 0x49)
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteAccountRepositoryError,
                .corruptStoredValue(field: "verify records foreign key")
            )
        }
    }

    private func record(
        accountID: StorageAccountID,
        revision: UInt64 = 1,
        payload: Data = Data("payload".utf8)
    ) -> StoredRecord {
        StoredRecord(
            accountID: accountID,
            key: key,
            revision: revision,
            updatedAt: timestamp,
            payload: payload
        )
    }

    private func testCipher(byte: UInt8) throws -> AESGCMAccountDataCipher {
        try AESGCMAccountDataCipher(keyData: Data(repeating: byte, count: 32))
    }

    private func rawPayload(at url: URL) throws -> Data {
        guard let value = try rawPayloadIfPresent(at: url) else {
            XCTFail("Expected an encrypted payload")
            return Data()
        }
        return value
    }

    private func rawPayloadIfPresent(at url: URL) throws -> Data? {
        var database: OpaquePointer?
        guard sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READONLY, nil) == SQLITE_OK,
            let database
        else {
            throw SQLiteTestError.open
        }
        defer { sqlite3_close_v2(database) }

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            database,
            "SELECT payload FROM records LIMIT 1",
            -1,
            &statement,
            nil
        ) == SQLITE_OK, let statement else {
            throw SQLiteTestError.statement
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else {
            throw SQLiteTestError.statement
        }
        guard sqlite3_column_type(statement, 0) != SQLITE_NULL else { return nil }
        let count = Int(sqlite3_column_bytes(statement, 0))
        guard count > 0, let bytes = sqlite3_column_blob(statement, 0) else {
            return Data()
        }
        return Data(bytes: bytes, count: count)
    }

    private func mutateDatabase(at url: URL, sql: String) throws {
        var database: OpaquePointer?
        guard sqlite3_open_v2(
            url.path,
            &database,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
            nil
        ) == SQLITE_OK, let database else {
            throw SQLiteTestError.open
        }
        defer { sqlite3_close_v2(database) }
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
            throw SQLiteTestError.statement
        }
    }
}

private struct FailingCipher: AccountDataCipher {
    func seal(_ plaintext: Data, context: AccountDataCipherContext) throws -> Data {
        throw AccountDataCipherError.encryptionFailed
    }

    func open(_ sealed: Data, context: AccountDataCipherContext) throws -> Data {
        throw AccountDataCipherError.authenticationFailed
    }
}

private final class DatabaseLocation: @unchecked Sendable {
    let directoryURL: URL
    let databaseURL: URL

    init() throws {
        directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-storage-tests-\(UUID().uuidString)")
        databaseURL = directoryURL.appendingPathComponent("accounts.sqlite3")
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: false
        )
    }

    func remove() {
        try? FileManager.default.removeItem(at: directoryURL)
    }
}

private enum SQLiteTestError: Error {
    case open
    case statement
}
