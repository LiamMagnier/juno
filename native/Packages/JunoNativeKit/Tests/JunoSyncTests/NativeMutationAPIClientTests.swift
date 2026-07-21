import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import XCTest
@testable import JunoSync

final class NativeMutationAPIClientTests: XCTestCase {
    private let account = StorageAccountID("account-a")
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func testSubmissionUsesIdempotentMutationEnvelope() async throws {
        let sender = MutationQueueSender(responses: [response(
            #"{"entity":{"id":"c1","revision":4},"entityMappings":{}}"#
        )])
        let draft = mutation()

        let result = try await NativeMutationAPIClient(sender: sender).submit(
            draft,
            baseRevision: 3,
            for: AccountID("account-a")
        )

        XCTAssertEqual(result.revision, 4)
        let requests = await sender.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/v1/mutations")
        XCTAssertEqual(request.method, .post)
        let body = try XCTUnwrap(request.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["clientMutationId"] as? String, draft.idempotencyKey.rawValue)
        XCTAssertEqual(object["baseRevision"] as? Int, 3)
        XCTAssertEqual((object["operation"] as? [String: Any])?["type"] as? String, "conversation.rename")
    }

    func testRevisionConflictIsTyped() async throws {
        let sender = MutationQueueSender(responses: [response(
            #"{"error":{"code":"revision_conflict","message":"Changed","requestId":"r1","retryable":false,"retryAfterMs":null,"details":{"currentRevision":5}}}"#,
            status: 409
        )])
        do {
            _ = try await NativeMutationAPIClient(sender: sender).submit(
                mutation(), baseRevision: 3, for: AccountID("account-a")
            )
            XCTFail("Revision conflicts must be surfaced")
        } catch {
            XCTAssertEqual(
                error as? NativeMutationAPIError,
                .revisionConflict(currentRevision: 5, deleted: false)
            )
        }
    }

    func testDrainerAcknowledgesSuccessAndPersistsOfflineRetry() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = PersistentMutationOutbox(repository: repository)
        let success = mutation(id: "mutation-success", key: "550e8400-e29b-41d4-a716-446655440000")
        let offline = mutation(id: "mutation-offline", key: "6ba7b810-9dad-41d1-80b4-00c04fd430c8", createdAt: now.addingTimeInterval(1))
        _ = try await outbox.enqueue(success)
        _ = try await outbox.enqueue(offline)
        let sender = MutationQueueSender(responses: [
            response(#"{"entity":{"id":"c1","revision":1}}"#),
            response(#"{"error":{"code":"server_unavailable","message":"Later","requestId":"r2","retryable":true,"retryAfterMs":null}}"#, status: 503),
        ])
        let drainer = NativeMutationDrainer(
            repository: repository,
            outbox: outbox,
            sender: sender,
            policy: NativeSyncBackoffPolicy(initialDelay: 2, maximumDelay: 2, jitterRatio: 0)
        )

        let result = try await drainer.drain(
            for: AccountID("account-a"),
            owner: "test-worker",
            now: now,
            jitter: FixedJitter()
        )

        XCTAssertEqual(result.acknowledged, 1)
        XCTAssertEqual(result.retryScheduled, 1)
        let entries = try await outbox.mutations(accountID: account)
        XCTAssertTrue(entries.contains { if case .acknowledged = $0.state { true } else { false } })
        XCTAssertTrue(entries.contains {
            if case .retryScheduled(let retry) = $0.state {
                return retry.eligibleAt == now.addingTimeInterval(2)
            }
            return false
        })
    }

    private func mutation(
        id: String = "mutation-1",
        key: String = "550e8400-e29b-41d4-a716-446655440000",
        createdAt: Date? = nil
    ) -> MutationDraft {
        MutationDraft(
            id: OutboxMutationID(id),
            accountID: account,
            idempotencyKey: IdempotencyKey(key),
            entity: RecordKey(namespace: "conversation", id: "c1"),
            operation: "conversation.rename",
            payload: Data(#"{"type":"conversation.rename","entityId":"c1","title":"Renamed"}"#.utf8),
            createdAt: createdAt ?? now
        )
    }

    private func response(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

private actor MutationQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []
    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        return responses.removeFirst()
    }
}

private actor FixedJitter: NativeSyncJitterSource {
    func nextUnit() -> Double { 0.5 }
}
