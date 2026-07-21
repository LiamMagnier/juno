import Foundation
import XCTest
@testable import JunoStorage
@testable import JunoSync

final class MutationOutboxTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func testEnqueueIsIdempotentAndRejectsKeyCollision() async throws {
        let outbox = InMemoryMutationOutbox()
        let original = draft(id: "mutation-1", key: "key-1", payload: "first")
        let duplicate = draft(id: "mutation-2", key: "key-1", payload: "first")
        let collision = draft(id: "mutation-3", key: "key-1", payload: "different")

        let inserted = try await outbox.enqueue(original)
        let replayed = try await outbox.enqueue(duplicate)
        XCTAssertTrue(inserted.inserted)
        XCTAssertFalse(replayed.inserted)
        XCTAssertEqual(replayed.mutation.draft.id, original.id)

        do {
            _ = try await outbox.enqueue(collision)
            XCTFail("Expected an idempotency collision")
        } catch {
            XCTAssertEqual(
                error as? MutationOutboxError,
                .idempotencyCollision(IdempotencyKey("key-1"))
            )
        }
    }

    func testRetryWaitsUntilEligibleAndIncrementsAttempt() async throws {
        let outbox = InMemoryMutationOutbox()
        let mutation = draft(id: "mutation-1", key: "key-1")
        _ = try await outbox.enqueue(mutation)

        let firstLease = try await outbox.lease(
            accountID: accountA,
            owner: "worker-a",
            token: "lease-a",
            now: now,
            duration: 30,
            limit: 1
        )
        XCTAssertEqual(firstLease.single?.attemptCount, 1)

        try await outbox.scheduleRetry(
            id: mutation.id,
            owner: "worker-a",
            token: "lease-a",
            now: now.addingTimeInterval(1),
            eligibleAt: now.addingTimeInterval(11),
            errorCode: "offline"
        )

        let early = try await outbox.lease(
            accountID: accountA,
            owner: "worker-b",
            token: "lease-b",
            now: now.addingTimeInterval(10),
            duration: 30,
            limit: 1
        )
        XCTAssertTrue(early.isEmpty)

        let retried = try await outbox.lease(
            accountID: accountA,
            owner: "worker-b",
            token: "lease-b",
            now: now.addingTimeInterval(11),
            duration: 30,
            limit: 1
        )
        XCTAssertEqual(retried.single?.attemptCount, 2)
    }

    func testExpiredLeaseCanBeReclaimedAndOldOwnerFailsClosed() async throws {
        let outbox = InMemoryMutationOutbox()
        let mutation = draft(id: "mutation-1", key: "key-1")
        _ = try await outbox.enqueue(mutation)
        _ = try await outbox.lease(
            accountID: accountA,
            owner: "worker-a",
            token: "lease-a",
            now: now,
            duration: 5,
            limit: 1
        )

        let reclaimed = try await outbox.lease(
            accountID: accountA,
            owner: "worker-b",
            token: "lease-b",
            now: now.addingTimeInterval(5),
            duration: 10,
            limit: 1
        )
        XCTAssertEqual(reclaimed.single?.attemptCount, 2)

        do {
            try await outbox.acknowledge(
                id: mutation.id,
                owner: "worker-a",
                token: "lease-a",
                now: now.addingTimeInterval(6)
            )
            XCTFail("Expected the stale lease to fail")
        } catch {
            XCTAssertEqual(error as? MutationOutboxError, .leaseMismatch(mutation.id))
        }

        try await outbox.acknowledge(
            id: mutation.id,
            owner: "worker-b",
            token: "lease-b",
            now: now.addingTimeInterval(6)
        )
        let entries = await outbox.mutations(accountID: accountA)
        XCTAssertEqual(entries.single?.state, .acknowledged(at: now.addingTimeInterval(6)))
    }

    func testConflictRequiresExplicitResolutionAndWipeIsAccountScoped() async throws {
        let outbox = InMemoryMutationOutbox()
        let conflicted = draft(id: "mutation-a", key: "key-a")
        let otherAccount = draft(
            id: "mutation-b",
            key: "key-b",
            accountID: accountB
        )
        _ = try await outbox.enqueue(conflicted)
        _ = try await outbox.enqueue(otherAccount)
        _ = try await outbox.lease(
            accountID: accountA,
            owner: "worker",
            token: "lease",
            now: now,
            duration: 30,
            limit: 1
        )
        try await outbox.markConflict(
            id: conflicted.id,
            owner: "worker",
            token: "lease",
            now: now.addingTimeInterval(1),
            localRevision: 3,
            serverRevision: 4,
            reason: "revision-mismatch"
        )

        let blocked = try await outbox.lease(
            accountID: accountA,
            owner: "worker",
            token: "next",
            now: now.addingTimeInterval(2),
            duration: 30,
            limit: 1
        )
        XCTAssertTrue(blocked.isEmpty)

        try await outbox.resolveConflict(
            id: conflicted.id,
            resolution: .retry,
            now: now.addingTimeInterval(3)
        )
        let retry = try await outbox.lease(
            accountID: accountA,
            owner: "worker",
            token: "retry",
            now: now.addingTimeInterval(3),
            duration: 30,
            limit: 1
        )
        XCTAssertEqual(retry.single?.draft.id, conflicted.id)

        await outbox.wipe(accountID: accountA)
        let wiped = await outbox.mutations(accountID: accountA)
        let preserved = await outbox.mutations(accountID: accountB)
        XCTAssertTrue(wiped.isEmpty)
        XCTAssertEqual(preserved.single?.draft.id, otherAccount.id)
    }

    private func draft(
        id: String,
        key: String,
        payload: String = "payload",
        accountID: StorageAccountID? = nil
    ) -> MutationDraft {
        MutationDraft(
            id: OutboxMutationID(id),
            accountID: accountID ?? accountA,
            idempotencyKey: IdempotencyKey(key),
            entity: RecordKey(namespace: "messages", id: "message-1"),
            operation: "upsert",
            payload: Data(payload.utf8),
            createdAt: now
        )
    }
}

private extension Array {
    var single: Element? { count == 1 ? self[0] : nil }
}
