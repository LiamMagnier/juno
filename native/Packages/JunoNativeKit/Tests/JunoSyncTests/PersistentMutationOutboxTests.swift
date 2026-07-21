import Foundation
import JunoStorage
import XCTest
@testable import JunoSync

final class PersistentMutationOutboxTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func testStateSurvivesAdapterRecreationAndLeaseExpiry() async throws {
        let repository = InMemoryTransactionalStore()
        var outbox: PersistentMutationOutbox? = PersistentMutationOutbox(repository: repository)
        let draft = mutation(id: "mutation-1", accountID: accountA)
        _ = try await outbox!.enqueue(draft)
        _ = try await outbox!.lease(
            accountID: accountA,
            owner: "worker-a",
            token: "lease-a",
            now: now,
            duration: 5,
            limit: 1
        )

        outbox = PersistentMutationOutbox(repository: repository)
        let beforeExpiry = try await outbox!.lease(
            accountID: accountA,
            owner: "worker-b",
            token: "lease-b",
            now: now.addingTimeInterval(4),
            duration: 5,
            limit: 1
        )
        XCTAssertTrue(beforeExpiry.isEmpty)
        let reclaimed = try await outbox!.lease(
            accountID: accountA,
            owner: "worker-b",
            token: "lease-b",
            now: now.addingTimeInterval(5),
            duration: 10,
            limit: 1
        )
        XCTAssertEqual(reclaimed.first?.attemptCount, 2)
        try await outbox!.acknowledge(
            id: draft.id,
            accountID: accountA,
            owner: "worker-b",
            token: "lease-b",
            now: now.addingTimeInterval(6)
        )

        let reopened = PersistentMutationOutbox(repository: repository)
        let entries = try await reopened.mutations(accountID: accountA)
        XCTAssertEqual(entries.first?.state, .acknowledged(at: now.addingTimeInterval(6)))
    }

    func testAccountIsolationAndScopedWipe() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = PersistentMutationOutbox(repository: repository)
        _ = try await outbox.enqueue(mutation(id: "same-id", accountID: accountA))
        _ = try await outbox.enqueue(mutation(id: "same-id", accountID: accountB))

        try await outbox.wipe(accountID: accountA)

        let wiped = try await outbox.mutations(accountID: accountA)
        let preserved = try await outbox.mutations(accountID: accountB)
        XCTAssertTrue(wiped.isEmpty)
        XCTAssertEqual(preserved.first?.draft.id, OutboxMutationID("same-id"))
    }

    func testOutboxPayloadUsesRepositoryRecordNamespace() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = PersistentMutationOutbox(repository: repository)
        _ = try await outbox.enqueue(mutation(id: "mutation-1", accountID: accountA))

        let snapshot = try await repository.snapshot(for: accountA)
        let key = RecordKey(namespace: PersistentMutationOutbox<InMemoryTransactionalStore>.namespace, id: "mutation-1")
        let record = try XCTUnwrap(snapshot.records[key])
        XCTAssertFalse(record.isTombstone)
        XCTAssertNotNil(record.payload)
    }

    private func mutation(id: String, accountID: StorageAccountID) -> MutationDraft {
        MutationDraft(
            id: OutboxMutationID(id),
            accountID: accountID,
            idempotencyKey: IdempotencyKey("550e8400-e29b-41d4-a716-446655440000"),
            entity: RecordKey(namespace: "conversation", id: "c1"),
            operation: "conversation.rename",
            payload: Data(#"{"type":"conversation.rename","entityId":"c1","title":"Renamed"}"#.utf8),
            createdAt: now
        )
    }
}
