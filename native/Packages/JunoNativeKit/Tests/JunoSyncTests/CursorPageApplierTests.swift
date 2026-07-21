import Foundation
import XCTest
@testable import JunoStorage
@testable import JunoSync

final class CursorPageApplierTests: XCTestCase {
    private let accountID = StorageAccountID("account-a")
    private let key = RecordKey(namespace: "messages", id: "message-1")
    private let timestamp = Date(timeIntervalSince1970: 1_700_000_000)

    func testApplyReplayAndTombstoneAreAtomicAndIdempotent() async throws {
        let store = InMemoryTransactionalStore()
        let applier = CursorPageApplier(repository: store)
        let firstPage = SyncChangePage(
            accountID: accountID,
            previousCursor: nil,
            nextCursor: "cursor-1",
            changes: [record(revision: 1, payload: "hello")]
        )

        let first = try await applier.apply(firstPage)
        let replay = try await applier.apply(firstPage)
        XCTAssertEqual(first.disposition, .applied)
        XCTAssertEqual(first.appliedRecordCount, 1)
        XCTAssertEqual(replay.disposition, .alreadyApplied)

        let tombstone = StoredRecord(
            accountID: accountID,
            key: key,
            revision: 2,
            updatedAt: timestamp.addingTimeInterval(1),
            isTombstone: true
        )
        let second = try await applier.apply(
            SyncChangePage(
                accountID: accountID,
                previousCursor: "cursor-1",
                nextCursor: "cursor-2",
                changes: [tombstone, record(revision: 1, payload: "hello")]
            )
        )

        let snapshot = try await store.snapshot(for: accountID)
        XCTAssertEqual(second.appliedRecordCount, 1)
        XCTAssertEqual(second.ignoredRecordCount, 1)
        XCTAssertEqual(snapshot.records[key], tombstone)
        XCTAssertEqual(
            String(data: try XCTUnwrap(snapshot.metadata["sync.changeCursor"]), encoding: .utf8),
            "cursor-2"
        )
    }

    func testCursorGapLeavesRecordsAndCursorUntouched() async throws {
        let store = InMemoryTransactionalStore()
        let applier = CursorPageApplier(repository: store)

        do {
            _ = try await applier.apply(
                SyncChangePage(
                    accountID: accountID,
                    previousCursor: "missing-cursor",
                    nextCursor: "cursor-2",
                    changes: [record(revision: 1, payload: "must-not-apply")]
                )
            )
            XCTFail("Expected a cursor gap")
        } catch {
            XCTAssertEqual(
                error as? CursorPageError,
                .cursorGap(expected: nil, received: "missing-cursor")
            )
        }

        let snapshot = try await store.snapshot(for: accountID)
        XCTAssertTrue(snapshot.records.isEmpty)
        XCTAssertNil(snapshot.metadata["sync.changeCursor"])
    }

    func testConflictingDuplicateRevisionRejectsWholePage() async throws {
        let store = InMemoryTransactionalStore()
        let applier = CursorPageApplier(repository: store)
        let first = record(revision: 3, payload: "one")
        let conflict = record(revision: 3, payload: "two")

        do {
            _ = try await applier.apply(
                SyncChangePage(
                    accountID: accountID,
                    previousCursor: nil,
                    nextCursor: "cursor-1",
                    changes: [first, conflict]
                )
            )
            XCTFail("Expected conflicting duplicate revisions")
        } catch {
            XCTAssertEqual(
                error as? CursorPageError,
                .conflictingPageRevision(key: key, revision: 3)
            )
        }

        let snapshot = try await store.snapshot(for: accountID)
        XCTAssertEqual(snapshot.version, 0)
        XCTAssertTrue(snapshot.records.isEmpty)
    }

    func testSameStoredRevisionWithDifferentValueFailsClosed() async throws {
        let store = InMemoryTransactionalStore()
        try await store.apply(
            StorageTransaction(
                accountID: accountID,
                operations: [.upsert(record(revision: 7, payload: "local"))]
            )
        )
        let applier = CursorPageApplier(repository: store)

        do {
            _ = try await applier.apply(
                SyncChangePage(
                    accountID: accountID,
                    previousCursor: nil,
                    nextCursor: "cursor-1",
                    changes: [record(revision: 7, payload: "server")]
                )
            )
            XCTFail("Expected a revision conflict")
        } catch {
            XCTAssertEqual(
                error as? CursorPageError,
                .conflictingStoredRevision(key: key, revision: 7)
            )
        }

        let snapshot = try await store.snapshot(for: accountID)
        XCTAssertNil(snapshot.metadata["sync.changeCursor"])
        XCTAssertEqual(snapshot.records[key]?.payload, Data("local".utf8))
    }

    private func record(revision: UInt64, payload: String) -> StoredRecord {
        StoredRecord(
            accountID: accountID,
            key: key,
            revision: revision,
            updatedAt: timestamp,
            payload: Data(payload.utf8)
        )
    }
}
