import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import XCTest
@testable import JunoSync

/// End-to-end proof that a durable mutation written while offline survives an
/// app relaunch and reaches the server exactly once after reconnection, with
/// the same idempotency key it was originally enqueued with.
final class NativeOfflineReconnectProofTests: XCTestCase {
    private let storageAccount = StorageAccountID("account-a")
    private let account = try! AccountID("account-a")
    private let enqueueTime = Date(timeIntervalSince1970: 1_700_000_000)

    func testOfflineMutationSurvivesRelaunchAndSubmitsOnceOnReconnect() async throws {
        let repository = InMemoryTransactionalStore()
        let draft = renameDraft()

        // Offline session: the enqueue succeeds locally, the drain fails with
        // a connectivity error and schedules a retry.
        let offlineOutbox = PersistentMutationOutbox(repository: repository)
        _ = try await offlineOutbox.enqueue(draft)
        let offlineSender = RecordingSender(script: [.fail(URLError(.notConnectedToInternet))])
        let offlineDrainer = NativeMutationDrainer(
            repository: repository,
            outbox: offlineOutbox,
            sender: offlineSender
        )
        let offlineResult = try await offlineDrainer.drain(
            for: account,
            owner: "offline-session",
            now: enqueueTime
        )
        XCTAssertEqual(offlineResult.leased, 1)
        XCTAssertEqual(offlineResult.retryScheduled, 1)
        XCTAssertEqual(offlineResult.acknowledged, 0)

        // Relaunch: brand-new outbox and drainer instances over the same
        // repository — nothing is shared in memory.
        let relaunchOutbox = PersistentMutationOutbox(repository: repository)
        let persisted = try await relaunchOutbox.mutations(accountID: storageAccount)
        XCTAssertEqual(persisted.count, 1)
        guard case .retryScheduled = persisted[0].state else {
            return XCTFail("The offline mutation must persist as retry-scheduled")
        }
        XCTAssertEqual(persisted[0].draft.idempotencyKey, draft.idempotencyKey)

        // Reconnect: the retry becomes eligible and the drain acknowledges.
        let onlineSender = RecordingSender(script: [.succeed])
        let onlineDrainer = NativeMutationDrainer(
            repository: repository,
            outbox: relaunchOutbox,
            sender: onlineSender
        )
        let reconnectResult = try await onlineDrainer.drain(
            for: account,
            owner: "relaunched-session",
            now: enqueueTime.addingTimeInterval(3_600)
        )
        XCTAssertEqual(reconnectResult.acknowledged, 1)
        XCTAssertEqual(reconnectResult.retryScheduled, 0)
        XCTAssertEqual(reconnectResult.conflicted, 0)

        // Exactly one wire submission carrying the original idempotency key.
        let requests = await onlineSender.requests
        XCTAssertEqual(requests.count, 1)
        let body = try JSONSerialization.jsonObject(
            with: try XCTUnwrap(requests.first?.body)
        ) as? [String: Any]
        XCTAssertEqual(
            body?["clientMutationId"] as? String,
            draft.idempotencyKey.rawValue
        )

        // A further drain has nothing left to send.
        let idleResult = try await onlineDrainer.drain(
            for: account,
            owner: "relaunched-session",
            now: enqueueTime.addingTimeInterval(7_200)
        )
        XCTAssertEqual(idleResult.leased, 0)
        let finalRequestCount = await onlineSender.requests.count
        XCTAssertEqual(finalRequestCount, 1)
    }

    func testAmbiguousLossReplaysWithTheSameIdempotencyKey() async throws {
        let repository = InMemoryTransactionalStore()
        let draft = renameDraft()
        let outbox = PersistentMutationOutbox(repository: repository)
        _ = try await outbox.enqueue(draft)

        // First attempt reaches the wire but the response is lost, so the
        // client cannot know whether the server applied it.
        let sender = RecordingSender(script: [
            .fail(URLError(.networkConnectionLost)),
            .succeed,
        ])
        let drainer = NativeMutationDrainer(
            repository: repository,
            outbox: outbox,
            sender: sender
        )
        let firstResult = try await drainer.drain(
            for: account,
            owner: "session",
            now: enqueueTime
        )
        XCTAssertEqual(firstResult.retryScheduled, 1)

        let retryResult = try await drainer.drain(
            for: account,
            owner: "session",
            now: enqueueTime.addingTimeInterval(3_600)
        )
        XCTAssertEqual(retryResult.acknowledged, 1)

        // Both attempts carried the identical clientMutationId, so the
        // server-side receipt makes the replay a no-op instead of a duplicate.
        let requests = await sender.requests
        XCTAssertEqual(requests.count, 2)
        let identifiers = try requests.map { request -> String in
            let object = try JSONSerialization.jsonObject(
                with: try XCTUnwrap(request.body)
            ) as? [String: Any]
            return try XCTUnwrap(object?["clientMutationId"] as? String)
        }
        XCTAssertEqual(Set(identifiers).count, 1)
        XCTAssertEqual(identifiers.first, draft.idempotencyKey.rawValue)
    }

    private func renameDraft() -> MutationDraft {
        MutationDraft(
            id: OutboxMutationID("mutation-offline-1"),
            accountID: storageAccount,
            idempotencyKey: IdempotencyKey("550e8400-e29b-41d4-a716-446655440042"),
            entity: RecordKey(namespace: "conversation", id: "conversation-1"),
            operation: "conversation.rename",
            payload: Data(#"{"type":"conversation.rename","entityId":"conversation-1","title":"Offline rename"}"#.utf8),
            createdAt: enqueueTime
        )
    }
}

private actor RecordingSender: NativeAuthenticatedRequestSending {
    enum Step {
        case succeed
        case fail(URLError)
    }

    private var script: [Step]
    private(set) var requests: [NativeBearerRequest] = []

    init(script: [Step]) { self.script = script }

    func send(_ request: NativeBearerRequest, for _: AccountID) throws -> HTTPResponse {
        requests.append(request)
        guard !script.isEmpty else { throw URLError(.notConnectedToInternet) }
        switch script.removeFirst() {
        case .succeed:
            return HTTPResponse(
                statusCode: 200,
                headers: HTTPHeaders(),
                body: Data(#"{"entity":{"id":"conversation-1","revision":4}}"#.utf8)
            )
        case .fail(let error):
            throw error
        }
    }
}
