import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import XCTest
@testable import JunoSync

final class NativeSyncCoordinatorTests: XCTestCase {
    func testFreshAccountBootstrapsHydratesAndAtomicallyCatchesUp() async throws {
        let repository = InMemoryTransactionalStore()
        let sender = CoordinatorQueueSender(responses: [
            response(bootstrap(cursor: "42")),
            response(#"{"items":[{"type":"conversation","id":"c1","revision":0}],"nextAfter":null,"hasMore":false}"#),
            response(entity(title: "Original", revision: 0)),
            response(#"{"after":"42","changes":[{"cursor":"43","entityType":"conversation","entityId":"c1","parentEntityId":null,"revision":1,"operation":"upsert","changedAt":"2026-07-21T12:01:00.000Z"}],"nextCursor":"43","compactionFloorCursor":"10","hasMore":false}"#),
            response(entity(title: "Updated", revision: 1)),
        ])
        let coordinator = NativeSyncCoordinator(repository: repository, sender: sender)

        let result = try await coordinator.synchronize(for: AccountID("account-a"))

        XCTAssertEqual(result.cursor, "43")
        XCTAssertTrue(result.rebuiltBaseline)
        XCTAssertEqual(result.changedRecordCount, 1)
        let snapshot = try await repository.snapshot(for: StorageAccountID("account-a"))
        XCTAssertEqual(snapshot.metadata[CursorPageApplier<InMemoryTransactionalStore>.cursorMetadataKey], Data("43".utf8))
        let record = try XCTUnwrap(snapshot.records[RecordKey(namespace: "conversation", id: "c1")])
        XCTAssertEqual(record.revision, 1)
        XCTAssertTrue(String(decoding: try XCTUnwrap(record.payload), as: UTF8.self).contains("Updated"))
    }

    func testCompactedCursorRebuildsOnlySyncEntitiesAndPreservesLocalNamespace() async throws {
        let repository = InMemoryTransactionalStore()
        let account = StorageAccountID("account-a")
        _ = try await repository.apply(StorageTransaction(accountID: account, operations: [
            .upsert(StoredRecord(
                accountID: account,
                key: RecordKey(namespace: "conversation", id: "stale"),
                revision: 3,
                updatedAt: Date(timeIntervalSince1970: 1),
                payload: Data("stale".utf8)
            )),
            .upsert(StoredRecord(
                accountID: account,
                key: RecordKey(namespace: "_juno.outbox", id: "pending"),
                revision: 1,
                updatedAt: Date(timeIntervalSince1970: 1),
                payload: Data("pending".utf8)
            )),
            .setMetadata(key: CursorPageApplier<InMemoryTransactionalStore>.cursorMetadataKey, value: Data("5".utf8)),
        ]))
        let sender = CoordinatorQueueSender(responses: [
            response(#"{"error":{"code":"cursor_compacted","message":"Rebuild","requestId":"r1","retryable":false,"retryAfterMs":null,"details":{"compactionFloorCursor":"10"}}}"#, status: 410),
            response(bootstrap(cursor: "12")),
            response(#"{"items":[],"nextAfter":null,"hasMore":false}"#),
            response(#"{"after":"12","changes":[],"nextCursor":"12","compactionFloorCursor":"10","hasMore":false}"#),
        ])
        let coordinator = NativeSyncCoordinator(repository: repository, sender: sender)

        let result = try await coordinator.synchronize(for: AccountID("account-a"))

        XCTAssertTrue(result.rebuiltBaseline)
        let snapshot = try await repository.snapshot(for: account)
        XCTAssertNil(snapshot.records[RecordKey(namespace: "conversation", id: "stale")])
        XCTAssertNotNil(snapshot.records[RecordKey(namespace: "_juno.outbox", id: "pending")])
        XCTAssertEqual(snapshot.metadata[CursorPageApplier<InMemoryTransactionalStore>.cursorMetadataKey], Data("12".utf8))
    }

    func testBackoffIsBoundedAndJittered() {
        let policy = NativeSyncBackoffPolicy(
            initialDelay: 1,
            maximumDelay: 8,
            multiplier: 2,
            jitterRatio: 0.25
        )
        XCTAssertEqual(policy.delay(attempt: 0, randomUnit: 0), 0.75)
        XCTAssertEqual(policy.delay(attempt: 2, randomUnit: 0.5), 4)
        XCTAssertEqual(policy.delay(attempt: 20, randomUnit: 1), 10)
    }

    private func bootstrap(cursor: String) -> String {
        """
        {"profile":{"id":"account-a","name":"Tester","email":"test@juno.test","image":null},"subscription":{"plan":"free","status":"active"},"usage":{"period":"2026-07","messageCount":0,"promptTokens":"0","completionTokens":"0"},"settings":null,"featureFlags":{},"currentChangeCursor":"\(cursor)","compactionFloorCursor":"10","modelManifestVersion":"models-1","contractVersion":"\(JunoNativeContract.version)","minimumClientVersions":{},"announcements":[]}
        """
    }

    private func entity(title: String, revision: UInt64) -> String {
        #"{"entities":[{"type":"conversation","id":"c1","revision":\#(revision),"deletedAt":null,"data":{"id":"c1","title":"\#(title)","updatedAt":"2026-07-21T12:00:00.000Z"}}]}"#
    }

    private func response(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

private actor CoordinatorQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) throws -> HTTPResponse {
        guard !responses.isEmpty else { throw URLError(.badServerResponse) }
        return responses.removeFirst()
    }
}
