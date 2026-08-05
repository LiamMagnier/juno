import Foundation
import JunoAuth
import JunoCore
import JunoStorage
import XCTest
@testable import JunoSync

final class NativeLocalAccountStoreFactoryTests: XCTestCase {
    func testKeychainKeySurvivesRepositoryReopen() async throws {
        let location = try FactoryDatabaseLocation()
        defer { location.remove() }
        let keychain = AtomicKeychainClient()
        let accountID = StorageAccountID("account-a")
        let recordKey = RecordKey(namespace: "conversation", id: "conversation-1")
        let record = StoredRecord(
            accountID: accountID,
            key: recordKey,
            revision: 1,
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
            payload: Data("encrypted-record".utf8)
        )

        let first = try NativeLocalAccountStoreFactory(
            databaseURL: location.databaseURL,
            securityClient: keychain,
            randomGenerator: FixedSecureRandom(byte: 0x51)
        ).openRepository()
        _ = try await first.apply(
            StorageTransaction(accountID: accountID, operations: [.upsert(record)])
        )
        try await first.close()

        let second = try NativeLocalAccountStoreFactory(
            databaseURL: location.databaseURL,
            securityClient: keychain,
            randomGenerator: FixedSecureRandom(byte: 0x99)
        ).openRepository()
        let snapshot = try await second.snapshot(for: accountID)
        XCTAssertEqual(snapshot.records[recordKey], record)
        XCTAssertEqual(keychain.insertCount, 1)
        XCTAssertEqual(
            keychain.data(for: NativeLocalAccountStoreFactory.encryptionKeyItem),
            Data(repeating: 0x51, count: 32)
        )
        try await second.close()
    }

    func testMalformedStoredKeyFailsWithoutReplacingIt() throws {
        let location = try FactoryDatabaseLocation()
        defer { location.remove() }
        let keychain = AtomicKeychainClient()
        let malformed = Data(repeating: 0x01, count: 12)
        keychain.seed(
            malformed,
            for: NativeLocalAccountStoreFactory.encryptionKeyItem
        )

        XCTAssertThrowsError(
            try NativeLocalAccountStoreFactory(
                databaseURL: location.databaseURL,
                securityClient: keychain,
                randomGenerator: FixedSecureRandom(byte: 0x52)
            ).openRepository()
        ) { error in
            XCTAssertEqual(
                error as? NativeLocalAccountStoreFactoryError,
                .malformedEncryptionKey
            )
        }
        XCTAssertEqual(
            keychain.data(for: NativeLocalAccountStoreFactory.encryptionKeyItem),
            malformed
        )
        XCTAssertEqual(keychain.insertCount, 0)
    }

    func testExistingDatabaseWithoutKeyFailsClosed() throws {
        let location = try FactoryDatabaseLocation()
        defer { location.remove() }
        XCTAssertTrue(
            FileManager.default.createFile(
                atPath: location.databaseURL.path,
                contents: Data("existing".utf8)
            )
        )
        let keychain = AtomicKeychainClient()

        XCTAssertThrowsError(
            try NativeLocalAccountStoreFactory(
                databaseURL: location.databaseURL,
                securityClient: keychain,
                randomGenerator: FixedSecureRandom(byte: 0x53)
            ).openRepository()
        ) { error in
            XCTAssertEqual(
                error as? NativeLocalAccountStoreFactoryError,
                .missingEncryptionKey
            )
        }
        XCTAssertEqual(keychain.insertCount, 0)
        // The archive-and-recreate path is reachable ONLY through
        // `recoverAndOpenRepository`. The launch path still refuses, because a
        // Keychain read that fails for a reason nobody has diagnosed yet must
        // not cost the user their database.
        XCTAssertEqual(
            FileManager.default.contents(atPath: location.databaseURL.path),
            Data("existing".utf8)
        )
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(
                atPath: location.directoryURL.path
            ),
            ["accounts.sqlite3"]
        )
    }

    func testRecoveryArchivesTheUnreadableDatabaseAndOpensAFreshOne() async throws {
        let location = try FactoryDatabaseLocation()
        defer { location.remove() }
        let manager = FileManager.default
        let stranded = Data("stranded".utf8)
        XCTAssertTrue(
            manager.createFile(atPath: location.databaseURL.path, contents: stranded)
        )
        // SQLite leaves both of these beside the database in WAL mode, and a
        // replay of either into the new store would be a decryption failure.
        for suffix in ["-wal", "-shm"] {
            XCTAssertTrue(
                manager.createFile(
                    atPath: location.databaseURL.path + suffix,
                    contents: Data(suffix.utf8)
                )
            )
        }
        let keychain = AtomicKeychainClient()

        let recovery = try NativeLocalAccountStoreFactory(
            databaseURL: location.databaseURL,
            securityClient: keychain,
            randomGenerator: FixedSecureRandom(byte: 0x54)
        ).recoverAndOpenRepository()

        let archived = try XCTUnwrap(recovery.archivedDatabaseURL)
        XCTAssertEqual(
            archived.deletingLastPathComponent().path,
            location.directoryURL.path
        )
        XCTAssertNotEqual(archived.path, location.databaseURL.path)
        XCTAssertEqual(manager.contents(atPath: archived.path), stranded)
        for suffix in ["-wal", "-shm"] {
            XCTAssertFalse(
                manager.fileExists(atPath: location.databaseURL.path + suffix)
            )
            XCTAssertEqual(
                manager.contents(atPath: archived.path + suffix),
                Data(suffix.utf8)
            )
        }

        XCTAssertEqual(keychain.insertCount, 1)
        XCTAssertEqual(
            keychain.data(for: NativeLocalAccountStoreFactory.encryptionKeyItem),
            Data(repeating: 0x54, count: 32)
        )
        let accountID = StorageAccountID("account-a")
        let snapshot = try await recovery.repository.snapshot(for: accountID)
        XCTAssertTrue(snapshot.records.isEmpty)
        try await recovery.repository.close()
    }

    func testRecoveryMovesNothingWhenThereIsNoDatabase() async throws {
        let location = try FactoryDatabaseLocation()
        defer { location.remove() }
        let keychain = AtomicKeychainClient()

        let recovery = try NativeLocalAccountStoreFactory(
            databaseURL: location.databaseURL,
            securityClient: keychain,
            randomGenerator: FixedSecureRandom(byte: 0x55)
        ).recoverAndOpenRepository()

        XCTAssertNil(recovery.archivedDatabaseURL)
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(
                atPath: location.directoryURL.path
            ).filter { $0.contains("unreadable") },
            []
        )
        XCTAssertEqual(keychain.insertCount, 1)
        try await recovery.repository.close()
    }

    /// The recovery is destructive enough that a stale button press must not be
    /// able to trigger it: the keychain client falls back to the legacy macOS
    /// keychain on `errSecMissingEntitlement`, so the key can come back between
    /// the failed launch and the user clicking.
    func testRecoveryLeavesAReadableDatabaseAloneWhenTheKeyIsPresent() async throws {
        let location = try FactoryDatabaseLocation()
        defer { location.remove() }
        let keychain = AtomicKeychainClient()
        let accountID = StorageAccountID("account-a")
        let recordKey = RecordKey(namespace: "conversation", id: "conversation-1")
        let record = StoredRecord(
            accountID: accountID,
            key: recordKey,
            revision: 1,
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
            payload: Data("encrypted-record".utf8)
        )
        let original = try NativeLocalAccountStoreFactory(
            databaseURL: location.databaseURL,
            securityClient: keychain,
            randomGenerator: FixedSecureRandom(byte: 0x56)
        ).openRepository()
        _ = try await original.apply(
            StorageTransaction(accountID: accountID, operations: [.upsert(record)])
        )
        try await original.close()

        let recovery = try NativeLocalAccountStoreFactory(
            databaseURL: location.databaseURL,
            securityClient: keychain,
            randomGenerator: FixedSecureRandom(byte: 0x57)
        ).recoverAndOpenRepository()

        XCTAssertNil(recovery.archivedDatabaseURL)
        let snapshot = try await recovery.repository.snapshot(for: accountID)
        XCTAssertEqual(snapshot.records[recordKey], record)
        XCTAssertEqual(keychain.insertCount, 1)
        try await recovery.repository.close()
    }

    func testRepositoryPurgerUsesOnlyTheRequestedAccountPartition() async throws {
        let repository = InMemoryTransactionalStore()
        let accountA = StorageAccountID("account-a")
        let accountB = StorageAccountID("account-b")
        _ = try await repository.apply(
            StorageTransaction(
                accountID: accountA,
                operations: [.setMetadata(key: "value", value: Data("a".utf8))]
            )
        )
        _ = try await repository.apply(
            StorageTransaction(
                accountID: accountB,
                operations: [.setMetadata(key: "value", value: Data("b".utf8))]
            )
        )

        try await RepositoryAccountDataPurger(repository: repository).wipe(
            accountID: JunoCore.AccountID("account-a")
        )

        let wiped = try await repository.snapshot(for: accountA)
        let preserved = try await repository.snapshot(for: accountB)
        XCTAssertTrue(wiped.metadata.isEmpty)
        XCTAssertEqual(
            preserved.metadata["value"],
            Data("b".utf8)
        )
    }
}

private struct FixedSecureRandom: SecureRandomDataGenerating {
    let byte: UInt8

    func generate(count: Int) throws -> Data {
        Data(repeating: byte, count: count)
    }
}

private final class AtomicKeychainClient: SecurityKeychainClient,
    @unchecked Sendable
{
    private let lock = NSLock()
    private var items: [SecurityKeychainItem: Data] = [:]
    private var storedInsertCount = 0

    var insertCount: Int {
        lock.withLock { storedInsertCount }
    }

    func read(_ item: SecurityKeychainItem) throws -> Data? {
        lock.withLock { items[item] }
    }

    func insertIfAbsent(
        _ data: Data,
        for item: SecurityKeychainItem
    ) throws -> Bool {
        lock.withLock {
            guard items[item] == nil else { return false }
            items[item] = data
            storedInsertCount += 1
            return true
        }
    }

    func upsert(_ data: Data, for item: SecurityKeychainItem) throws {
        lock.withLock { items[item] = data }
    }

    func delete(_ item: SecurityKeychainItem) throws -> Bool {
        lock.withLock { items.removeValue(forKey: item) != nil }
    }

    func seed(_ data: Data, for item: SecurityKeychainItem) {
        lock.withLock { items[item] = data }
    }

    func data(for item: SecurityKeychainItem) -> Data? {
        lock.withLock { items[item] }
    }
}

private final class FactoryDatabaseLocation: @unchecked Sendable {
    let directoryURL: URL
    let databaseURL: URL

    init() throws {
        directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-store-factory-tests-\(UUID().uuidString)")
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
