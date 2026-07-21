import Foundation
import XCTest
@testable import JunoStorage

final class InMemoryTransactionalStoreTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")
    private let key = RecordKey(namespace: "chat", id: "message-1")
    private let timestamp = Date(timeIntervalSince1970: 1_700_000_000)

    func testTransactionIsAtomicWhenLaterOperationIsInvalid() async throws {
        let store = InMemoryTransactionalStore()
        let validRecord = record(accountID: accountA, revision: 1)
        let invalidRecord = record(accountID: accountB, revision: 2)

        do {
            _ = try await store.apply(
                StorageTransaction(
                    accountID: accountA,
                    operations: [.upsert(validRecord), .upsert(invalidRecord)]
                )
            )
            XCTFail("Expected the account mismatch to reject the transaction")
        } catch {
            XCTAssertEqual(
                error as? AccountStorageError,
                .recordAccountMismatch(expected: accountA, actual: accountB)
            )
        }

        let snapshot = try await store.snapshot(for: accountA)
        XCTAssertEqual(snapshot.version, 0)
        XCTAssertTrue(snapshot.records.isEmpty)
    }

    func testOptimisticVersionPreventsLostUpdate() async throws {
        let store = InMemoryTransactionalStore()
        let initial = try await store.snapshot(for: accountA)

        let commit = try await store.apply(
            StorageTransaction(
                accountID: accountA,
                expectedStoreVersion: initial.version,
                operations: [.upsert(record(accountID: accountA, revision: 1))]
            )
        )
        XCTAssertEqual(commit.version, 1)

        do {
            _ = try await store.apply(
                StorageTransaction(
                    accountID: accountA,
                    expectedStoreVersion: initial.version,
                    operations: [.setMetadata(key: "cursor", value: Data("2".utf8))]
                )
            )
            XCTFail("Expected a version conflict")
        } catch {
            XCTAssertEqual(
                error as? AccountStorageError,
                .versionConflict(expected: 0, actual: 1)
            )
        }
    }

    func testPartitionsAndWipeAreAccountScoped() async throws {
        let store = InMemoryTransactionalStore()
        try await store.apply(
            StorageTransaction(
                accountID: accountA,
                operations: [.upsert(record(accountID: accountA, revision: 1))]
            )
        )
        try await store.apply(
            StorageTransaction(
                accountID: accountB,
                operations: [.upsert(record(accountID: accountB, revision: 8))]
            )
        )

        try await store.wipe(accountID: accountA)

        let wiped = try await store.snapshot(for: accountA)
        let preserved = try await store.snapshot(for: accountB)
        XCTAssertTrue(wiped.records.isEmpty)
        XCTAssertEqual(preserved.records[key]?.revision, 8)
    }

    func testNoOpDoesNotAdvanceVersionAndTombstoneDropsPayload() async throws {
        let store = InMemoryTransactionalStore()
        let tombstone = StoredRecord(
            accountID: accountA,
            key: key,
            revision: 4,
            updatedAt: timestamp,
            isTombstone: true,
            payload: Data("must-not-survive".utf8)
        )
        XCTAssertNil(tombstone.payload)

        let first = try await store.apply(
            StorageTransaction(accountID: accountA, operations: [.upsert(tombstone)])
        )
        let second = try await store.apply(
            StorageTransaction(accountID: accountA, operations: [.upsert(tombstone)])
        )

        XCTAssertEqual(first.version, 1)
        XCTAssertEqual(second.version, 1)
        XCTAssertTrue(second.changedRecords.isEmpty)
    }

    private func record(accountID: StorageAccountID, revision: UInt64) -> StoredRecord {
        StoredRecord(
            accountID: accountID,
            key: key,
            revision: revision,
            updatedAt: timestamp,
            payload: Data("revision-\(revision)".utf8)
        )
    }
}
