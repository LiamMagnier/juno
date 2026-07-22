import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import XCTest
@testable import JunoSync

final class NativeSyncAPIClientTests: XCTestCase {
    func testIndexHydrationAndChangeRequestsUseBearerV1Routes() async throws {
        let sender = SyncQueueSender(responses: [
            response(#"{"items":[{"type":"conversation","id":"c1","revision":0}],"nextAfter":null,"hasMore":false}"#),
            response(#"{"entities":[{"type":"conversation","id":"c1","revision":0,"deletedAt":null,"data":{"id":"c1","title":"Hello","updatedAt":"2026-07-21T12:00:00.000Z"}}]}"#),
            response(#"{"after":"42","changes":[{"cursor":"43","entityType":"conversation","entityId":"c1","parentEntityId":null,"revision":1,"operation":"upsert","changedAt":"2026-07-21T12:01:00.000Z"}],"nextCursor":"43","compactionFloorCursor":"10","hasMore":false}"#),
        ])
        let accountID = try AccountID("account-a")
        let client = NativeSyncAPIClient(sender: sender)

        let index = try await client.entityIndex(for: accountID)
        XCTAssertEqual(index.items.first?.id, "c1")
        let entities = try await client.entities(type: "conversation", ids: ["c1"], for: accountID)
        XCTAssertEqual(entities.first?.revision, 0)
        XCTAssertNotNil(entities.first?.data)
        let changes = try await client.changes(after: "42", for: accountID)
        XCTAssertEqual(changes.nextCursor, "43")
        XCTAssertEqual(changes.changes.first?.operation, .upsert)

        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.0.path), [
            "/api/v1/entities/index", "/api/v1/entities", "/api/v1/changes",
        ])
        XCTAssertTrue(requests.allSatisfy { $0.1 == accountID })
    }

    func testHydrationRejectsMissingEntityBeforeCursorCanAdvance() async throws {
        let sender = SyncQueueSender(responses: [response(#"{"entities":[]}"#)])
        do {
            _ = try await NativeSyncAPIClient(sender: sender).entities(
                type: "message",
                ids: ["m1"],
                for: AccountID("account-a")
            )
            XCTFail("Missing authoritative entities must fail closed")
        } catch {
            XCTAssertEqual(error as? NativeSyncAPIError, .missingEntity(type: "message", id: "m1"))
        }
    }

    func testCursorCompactionPreservesFloorDetails() async throws {
        let sender = SyncQueueSender(responses: [response(
            #"{"error":{"code":"cursor_compacted","message":"Rebuild","requestId":"r1","retryable":false,"retryAfterMs":null,"details":{"compactionFloorCursor":"90"}}}"#,
            status: 410
        )])
        do {
            _ = try await NativeSyncAPIClient(sender: sender).changes(
                after: "42",
                for: AccountID("account-a")
            )
            XCTFail("Compaction must be typed")
        } catch {
            XCTAssertEqual(error as? NativeSyncAPIError, .cursorCompacted(floor: "90"))
        }
    }

    func testAttachmentRecordDoesNotPersistExpiringSignedURL() throws {
        let entity = NativeHydratedEntity(
            type: "attachment",
            id: "a1",
            revision: 2,
            deletedAt: nil,
            data: .object([
                "id": .string("a1"),
                "fileName": .string("report.pdf"),
                "url": .string("https://signed.example/report?expires=soon"),
            ])
        )
        let record = try entity.storedRecord(accountID: StorageAccountID("account-a"))
        let payload = try XCTUnwrap(record.payload)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        XCTAssertEqual(object["fileName"] as? String, "report.pdf")
        XCTAssertNil(object["url"])
    }

    // MARK: - Real-device regression: the tombstone/live invariant
    //
    // The physical iPhone stalled its initial sync on "Juno returned malformed
    // synchronization data". Production was emitting `data: null` together with
    // `deletedAt: null` for artifacts whose rows had cascade-deleted while their
    // EntityRevision stayed live. The client was right to refuse that; these
    // tests pin both halves so neither side drifts.

    func testRejectsEntityWithNullDataAndNullDeletedAt() async throws {
        // The exact production payload shape, sanitized.
        let sender = SyncQueueSender(responses: [response(
            #"{"entities":[{"type":"artifact","id":"a1","revision":1,"deletedAt":null,"data":null}]}"#
        )])
        let client = NativeSyncAPIClient(sender: sender)

        do {
            _ = try await client.entities(type: "artifact", ids: ["a1"], for: try AccountID("account-a"))
            XCTFail("an envelope that is neither live nor tombstoned must be refused")
        } catch let error as NativeSyncAPIError {
            XCTAssertEqual(error, .malformedResponse)
        }
    }

    func testAcceptsProperTombstone() async throws {
        // What the corrected server now sends for the same entity.
        let sender = SyncQueueSender(responses: [response(
            #"{"entities":[{"type":"artifact","id":"a1","revision":1,"deletedAt":"2026-07-19T09:14:22.000Z","data":null}]}"#
        )])
        let client = NativeSyncAPIClient(sender: sender)

        let entities = try await client.entities(
            type: "artifact", ids: ["a1"], for: try AccountID("account-a")
        )

        XCTAssertEqual(entities.count, 1)
        XCTAssertNil(entities[0].data, "a tombstone carries no data")
        XCTAssertNotNil(entities[0].deletedAt)
    }

    func testRejectsLiveEntityCarryingBothDataAndDeletedAt() async throws {
        // The opposite malformation must stay rejected too — the guard is an
        // equivalence, not a one-way check.
        let sender = SyncQueueSender(responses: [response(
            #"{"entities":[{"type":"artifact","id":"a1","revision":1,"deletedAt":"2026-07-19T09:14:22.000Z","data":{"id":"a1"}}]}"#
        )])
        let client = NativeSyncAPIClient(sender: sender)

        do {
            _ = try await client.entities(type: "artifact", ids: ["a1"], for: try AccountID("account-a"))
            XCTFail("an envelope claiming to be both live and deleted must be refused")
        } catch let error as NativeSyncAPIError {
            XCTAssertEqual(error, .malformedResponse)
        }
    }

    private func response(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

private actor SyncQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [(NativeBearerRequest, AccountID)] = []

    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) throws -> HTTPResponse {
        requests.append((request, accountID))
        guard !responses.isEmpty else { throw URLError(.badServerResponse) }
        return responses.removeFirst()
    }
}
