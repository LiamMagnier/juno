import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest
@testable import JunoChatKit

final class NativeMemorySettingsStoreTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")

    func testMemoriesSettingsAndSummaryRemainAccountScopedOffline() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(repository, accountID: accountA, suffix: "a")
        try await seed(repository, accountID: accountB, suffix: "b")
        let store = NativeMemorySettingsStore(repository: repository, outbox: outbox)

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(snapshot.memories.map(\.id), ["memory-new-a", "memory-a"])
        let memory = try XCTUnwrap(snapshot.memories.last)
        XCTAssertEqual(memory.content, "Prefers dark roast coffee a")
        XCTAssertEqual(memory.source, .automatic)
        XCTAssertEqual(memory.kind, .fact)
        XCTAssertEqual(memory.sourceReference, "conversation-a")
        XCTAssertEqual(memory.revision, 6)
        XCTAssertFalse(memory.isPending)
        let settings = try XCTUnwrap(snapshot.settings)
        XCTAssertEqual(settings.id, "settings-a")
        XCTAssertEqual(settings.theme, .dark)
        XCTAssertEqual(settings.accent, "coral")
        XCTAssertEqual(settings.defaultModel, "anthropic:claude-sonnet-4-6")
        XCTAssertEqual(settings.customInstructions, "Answer briefly.")
        XCTAssertEqual(settings.responseLanguage, "French")
        XCTAssertEqual(settings.interfaceLocale, "fr-FR")
        XCTAssertEqual(settings.personality, "concise")
        XCTAssertTrue(settings.memoryEnabled)
        XCTAssertNil(settings.voiceID)
        XCTAssertEqual(settings.favoriteModels, ["openai:gpt-5"])
        XCTAssertTrue(settings.emailBudgetAlerts)
        XCTAssertFalse(settings.emailWeeklyDigest)
        XCTAssertEqual(settings.revision, 9)
        let summary = try XCTUnwrap(snapshot.summary)
        XCTAssertEqual(summary.content, "Account a summary")
        XCTAssertEqual(summary.entryCount, 2)
        XCTAssertEqual(snapshot.pendingMutationCount, 0)
        XCTAssertEqual(snapshot.conflictedMutationCount, 0)
    }

    func testUnknownSettingsFieldsAreToleratedButUnknownThemeFailsClosed() async throws {
        let repository = InMemoryTransactionalStore()
        let tolerated = """
        {"id":"settings-a","theme":"SYSTEM","accent":"sky","defaultModel":"m","customInstructions":"","responseLanguage":"auto","uiLocale":"auto","personality":"default","memoryEnabled":false,"voiceId":"voice-1","favoriteModels":[],"emailBudgetAlerts":false,"emailWeeklyDigest":true,"updatedAt":"2026-07-21T10:00:00.000Z","futurePreference":"ignored"}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [.upsert(StoredRecord(
                accountID: accountA,
                key: RecordKey(namespace: "settings", id: "settings-a"),
                revision: 2,
                updatedAt: Date(),
                payload: Data(tolerated.utf8)
            ))]
        ))
        let store = NativeMemorySettingsStore(
            repository: repository,
            outbox: InMemoryMutationOutbox()
        )

        let snapshot = try await store.load(accountID: accountA)
        let settings = try XCTUnwrap(snapshot.settings)
        XCTAssertEqual(settings.theme, .system)
        XCTAssertEqual(settings.voiceID, "voice-1")
        XCTAssertFalse(settings.memoryEnabled)

        let unknownTheme = tolerated.replacingOccurrences(of: "SYSTEM", with: "PURPLE")
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [.upsert(StoredRecord(
                accountID: accountA,
                key: RecordKey(namespace: "settings", id: "settings-a"),
                revision: 3,
                updatedAt: Date(),
                payload: Data(unknownTheme.utf8)
            ))]
        ))
        do {
            _ = try await store.load(accountID: accountA)
            XCTFail("An unrecognized theme value must not be partially projected")
        } catch {
            XCTAssertEqual(
                error as? NativeMemorySettingsError,
                .corruptRecord(RecordKey(namespace: "settings", id: "settings-a"))
            )
        }
    }

    func testCorruptMemoryRecordFailsClosed() async throws {
        let repository = InMemoryTransactionalStore()
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [.upsert(StoredRecord(
                accountID: accountA,
                key: RecordKey(namespace: "memory", id: "memory-a"),
                revision: 1,
                updatedAt: Date(),
                payload: Data(#"{"id":"another-memory"}"#.utf8)
            ))]
        ))
        let store = NativeMemorySettingsStore(
            repository: repository,
            outbox: InMemoryMutationOutbox()
        )

        do {
            _ = try await store.load(accountID: accountA)
            XCTFail("Corrupt memory state must not be partially projected")
        } catch {
            XCTAssertEqual(
                error as? NativeMemorySettingsError,
                .corruptRecord(RecordKey(namespace: "memory", id: "memory-a"))
            )
        }
    }

    func testPendingMutationsOverlayOptimisticallyWithoutChangingRevisions() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(repository, accountID: accountA, suffix: "a")
        _ = try await outbox.enqueue(mutation(
            id: "create",
            key: "550e8400-e29b-41d4-a716-446655440000",
            namespace: "memory",
            entityID: "550e8400-e29b-41d4-a716-446655440009",
            operation: "memory.create",
            body: #"{"type":"memory.create","clientEntityId":"550e8400-e29b-41d4-a716-446655440009","content":"Wrote a native app"}"#,
            at: 1_700_000_000
        ))
        _ = try await outbox.enqueue(mutation(
            id: "update",
            key: "550e8400-e29b-41d4-a716-446655440001",
            namespace: "memory",
            entityID: "memory-a",
            operation: "memory.update",
            body: #"{"type":"memory.update","entityId":"memory-a","content":"Prefers tea now"}"#,
            at: 1_700_000_001
        ))
        _ = try await outbox.enqueue(mutation(
            id: "delete",
            key: "550e8400-e29b-41d4-a716-446655440002",
            namespace: "memory",
            entityID: "memory-new-a",
            operation: "memory.delete",
            body: #"{"type":"memory.delete","entityId":"memory-new-a"}"#,
            at: 1_700_000_002
        ))
        _ = try await outbox.enqueue(mutation(
            id: "settings",
            key: "550e8400-e29b-41d4-a716-446655440003",
            namespace: "settings",
            entityID: "settings-a",
            operation: "settings.update",
            body: #"{"type":"settings.update","patch":{"theme":"LIGHT","uiLocale":"en-US","favoriteModels":["anthropic:claude-sonnet-4-6"],"memoryEnabled":false}}"#,
            at: 1_700_000_003
        ))
        let store = NativeMemorySettingsStore(repository: repository, outbox: outbox)

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(snapshot.pendingMutationCount, 4)
        XCTAssertEqual(snapshot.conflictedMutationCount, 0)
        let created = try XCTUnwrap(snapshot.memories.first {
            $0.id == "550e8400-e29b-41d4-a716-446655440009"
        })
        XCTAssertEqual(created.content, "Wrote a native app")
        XCTAssertEqual(created.source, .manual)
        XCTAssertTrue(created.isPending)
        XCTAssertEqual(created.revision, 0)
        let updated = try XCTUnwrap(snapshot.memories.first { $0.id == "memory-a" })
        XCTAssertEqual(updated.content, "Prefers tea now")
        XCTAssertTrue(updated.isPending)
        XCTAssertEqual(updated.revision, 6)
        XCTAssertFalse(snapshot.memories.contains { $0.id == "memory-new-a" })
        let settings = try XCTUnwrap(snapshot.settings)
        XCTAssertEqual(settings.theme, .light)
        XCTAssertEqual(settings.interfaceLocale, "en-US")
        XCTAssertEqual(settings.favoriteModels, ["anthropic:claude-sonnet-4-6"])
        XCTAssertFalse(settings.memoryEnabled)
        XCTAssertEqual(settings.accent, "coral")
        XCTAssertTrue(settings.isPending)
        XCTAssertEqual(settings.revision, 9)
    }

    func testPendingUpdateForVanishedTargetIsSkippedNotFatal() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        _ = try await outbox.enqueue(mutation(
            id: "orphan-update",
            key: "550e8400-e29b-41d4-a716-446655440004",
            namespace: "memory",
            entityID: "memory-vanished",
            operation: "memory.update",
            body: #"{"type":"memory.update","entityId":"memory-vanished","content":"Still valid text"}"#,
            at: 1_700_000_000
        ))
        _ = try await outbox.enqueue(mutation(
            id: "orphan-settings",
            key: "550e8400-e29b-41d4-a716-446655440005",
            namespace: "settings",
            entityID: "settings-unsynced",
            operation: "settings.update",
            body: #"{"type":"settings.update","patch":{"theme":"DARK"}}"#,
            at: 1_700_000_001
        ))
        let store = NativeMemorySettingsStore(repository: repository, outbox: outbox)

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertTrue(snapshot.memories.isEmpty)
        XCTAssertNil(snapshot.settings)
        XCTAssertEqual(snapshot.pendingMutationCount, 2)
    }

    func testConflictedMutationIsCountedAndDiscardRollsBackToServerState() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(repository, accountID: accountA, suffix: "a")
        let draft = mutation(
            id: "conflicted",
            key: "550e8400-e29b-41d4-a716-446655440006",
            namespace: "memory",
            entityID: "memory-a",
            operation: "memory.update",
            body: #"{"type":"memory.update","entityId":"memory-a","content":"Local divergent edit"}"#,
            at: 1_700_000_000
        )
        _ = try await outbox.enqueue(draft)
        let now = Date(timeIntervalSince1970: 1_700_000_100)
        _ = try await outbox.lease(
            accountID: accountA, owner: "test", token: "token",
            now: now, duration: 60, limit: 10
        )
        try await outbox.markConflict(
            id: draft.id, accountID: accountA, owner: "test", token: "token",
            now: now, localRevision: 6, serverRevision: 7, reason: "revision_conflict"
        )
        let store = NativeMemorySettingsStore(repository: repository, outbox: outbox)

        let conflicted = try await store.load(accountID: accountA)
        XCTAssertEqual(conflicted.pendingMutationCount, 0)
        XCTAssertEqual(conflicted.conflictedMutationCount, 1)
        XCTAssertEqual(
            conflicted.memories.first { $0.id == "memory-a" }?.content,
            "Prefers dark roast coffee a"
        )

        try await outbox.resolveConflict(
            id: draft.id,
            accountID: accountA,
            resolution: .discard(reason: "use_server_version"),
            now: now
        )
        let rolledBack = try await store.load(accountID: accountA)
        XCTAssertEqual(rolledBack.conflictedMutationCount, 0)
        XCTAssertEqual(rolledBack.pendingMutationCount, 0)
        XCTAssertEqual(
            rolledBack.memories.first { $0.id == "memory-a" }?.content,
            "Prefers dark roast coffee a"
        )
    }

    func testServerRevisionConflictMarksMutationConflictedThroughDrainer() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(repository, accountID: accountA, suffix: "a")
        _ = try await outbox.enqueue(mutation(
            id: "stale",
            key: "550e8400-e29b-41d4-a716-446655440007",
            namespace: "memory",
            entityID: "memory-a",
            operation: "memory.update",
            body: #"{"type":"memory.update","entityId":"memory-a","content":"Stale local edit"}"#,
            at: 1_700_000_000
        ))
        let sender = MemoryQueueSender(responses: [HTTPResponse(
            statusCode: 409,
            headers: HTTPHeaders(),
            body: Data(#"{"error":{"code":"revision_conflict","message":"Changed elsewhere.","requestId":"r1","retryable":false,"details":{"currentRevision":7}}}"#.utf8)
        )])
        let drainer = NativeMutationDrainer(
            repository: repository,
            outbox: outbox,
            sender: sender
        )

        let result = try await drainer.drain(
            for: try AccountID("account-a"),
            owner: "memory-settings-tests"
        )

        XCTAssertEqual(result.conflicted, 1)
        XCTAssertEqual(result.acknowledged, 0)
        let store = NativeMemorySettingsStore(repository: repository, outbox: outbox)
        let snapshot = try await store.load(accountID: accountA)
        XCTAssertEqual(snapshot.conflictedMutationCount, 1)
        XCTAssertEqual(
            snapshot.memories.first { $0.id == "memory-a" }?.content,
            "Prefers dark roast coffee a"
        )
    }

    func testNetworkLossSchedulesRetryAndKeepsOptimisticOverlay() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(repository, accountID: accountA, suffix: "a")
        _ = try await outbox.enqueue(mutation(
            id: "offline",
            key: "550e8400-e29b-41d4-a716-446655440008",
            namespace: "memory",
            entityID: "memory-a",
            operation: "memory.update",
            body: #"{"type":"memory.update","entityId":"memory-a","content":"Edited while offline"}"#,
            at: 1_700_000_000
        ))
        let sender = MemoryQueueSender(responses: [])
        let drainer = NativeMutationDrainer(
            repository: repository,
            outbox: outbox,
            sender: sender
        )

        let result = try await drainer.drain(
            for: try AccountID("account-a"),
            owner: "memory-settings-tests"
        )

        XCTAssertEqual(result.retryScheduled, 1)
        XCTAssertEqual(result.acknowledged, 0)
        XCTAssertEqual(result.conflicted, 0)
        let store = NativeMemorySettingsStore(repository: repository, outbox: outbox)
        let snapshot = try await store.load(accountID: accountA)
        XCTAssertEqual(snapshot.pendingMutationCount, 1)
        XCTAssertEqual(
            snapshot.memories.first { $0.id == "memory-a" }?.content,
            "Edited while offline"
        )
    }

    func testSummaryPersistenceRoundTripsAndClearRemovesRecord() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        let store = NativeMemorySettingsStore(repository: repository, outbox: outbox)
        let summary = NativeMemorySummary(
            content: "Likes concise answers.",
            updatedAt: Date(timeIntervalSince1970: 1_753_142_400),
            entryCount: 3
        )

        try await store.persistSummary(summary, accountID: accountA)
        let persisted = try await store.load(accountID: accountA)
        XCTAssertEqual(persisted.summary, summary)

        try await store.persistSummary(nil, accountID: accountA)
        let cleared = try await store.load(accountID: accountA)
        XCTAssertNil(cleared.summary)
    }

    private func seed(
        _ repository: InMemoryTransactionalStore,
        accountID: StorageAccountID,
        suffix: String
    ) async throws {
        let memory = """
        {"id":"memory-\(suffix)","content":"Prefers dark roast coffee \(suffix)","source":"AUTO","kind":"FACT","sourceRef":"conversation-\(suffix)","createdAt":"2026-07-20T09:00:00.000Z","updatedAt":"2026-07-20T09:00:00.000Z"}
        """
        let newer = """
        {"id":"memory-new-\(suffix)","content":"Ships native apps \(suffix)","source":"MANUAL","kind":"FACT","sourceRef":"manual","createdAt":"2026-07-21T09:00:00.000Z","updatedAt":"2026-07-21T09:00:00.000Z"}
        """
        let settings = """
        {"id":"settings-\(suffix)","theme":"DARK","accent":"coral","defaultModel":"anthropic:claude-sonnet-4-6","customInstructions":"Answer briefly.","responseLanguage":"French","uiLocale":"fr-FR","personality":"concise","memoryEnabled":true,"voiceId":null,"favoriteModels":["openai:gpt-5"],"emailBudgetAlerts":true,"emailWeeklyDigest":false,"updatedAt":"2026-07-21T10:00:00.000Z"}
        """
        let summary = """
        {"content":"Account \(suffix) summary","updatedAt":"2026-07-21T11:00:00.000Z","entryCount":2}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: accountID,
            operations: [
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "memory", id: "memory-\(suffix)"),
                    revision: 6,
                    updatedAt: Date(),
                    payload: Data(memory.utf8)
                )),
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "memory", id: "memory-new-\(suffix)"),
                    revision: 2,
                    updatedAt: Date(),
                    payload: Data(newer.utf8)
                )),
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "settings", id: "settings-\(suffix)"),
                    revision: 9,
                    updatedAt: Date(),
                    payload: Data(settings.utf8)
                )),
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: NativeMemorySettingsStore<InMemoryTransactionalStore>.summaryKey,
                    revision: 1,
                    updatedAt: Date(),
                    payload: Data(summary.utf8)
                )),
            ]
        ))
    }

    private func mutation(
        id: String,
        key: String,
        namespace: String,
        entityID: String,
        operation: String,
        body: String,
        at seconds: TimeInterval
    ) -> MutationDraft {
        MutationDraft(
            id: OutboxMutationID(id),
            accountID: accountA,
            idempotencyKey: IdempotencyKey(key),
            entity: RecordKey(namespace: namespace, id: entityID),
            operation: operation,
            payload: Data(body.utf8),
            createdAt: Date(timeIntervalSince1970: seconds)
        )
    }
}

final class NativeMemoryAPIClientTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    func testSummaryUsesExistingMemoryRouteAndDecodesSummary() async throws {
        let sender = MemoryQueueSender(responses: [response(
            #"{"memories":[{"id":"m1","content":"Fact","source":"AUTO","kind":"FACT","sourceRef":null,"createdAt":"2026-07-21T09:00:00.000Z"}],"summary":{"content":"Consolidated","updatedAt":"2026-07-21T11:00:00.000Z","entryCount":1}}"#
        )])
        let client = NativeMemoryAPIClient(sender: sender)

        let summary = try await client.summary(for: accountID)

        XCTAssertEqual(summary?.content, "Consolidated")
        XCTAssertEqual(summary?.entryCount, 1)
        let requests = await sender.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/memory")
        XCTAssertEqual(request.method, .get)
    }

    func testSummaryReturnsNilWhenServerHasNoSummary() async throws {
        let sender = MemoryQueueSender(responses: [response(
            #"{"memories":[],"summary":null}"#
        )])

        let summary = try await NativeMemoryAPIClient(sender: sender)
            .summary(for: accountID)

        XCTAssertNil(summary)
    }

    func testSummaryMalformedResponseFailsClosed() async throws {
        let sender = MemoryQueueSender(responses: [response("not json")])

        do {
            _ = try await NativeMemoryAPIClient(sender: sender).summary(for: accountID)
            XCTFail("Malformed memory payloads must not decode")
        } catch {
            XCTAssertEqual(error as? NativeMemoryAPIError, .malformedResponse)
        }
    }

    func testSummaryServerErrorSurfacesMessageAndRetryability() async throws {
        let sender = MemoryQueueSender(responses: [response(
            #"{"error":"Unauthorized"}"#,
            status: 401
        )])

        do {
            _ = try await NativeMemoryAPIClient(sender: sender).summary(for: accountID)
            XCTFail("Non-2xx memory responses must throw")
        } catch {
            XCTAssertEqual(
                error as? NativeMemoryAPIError,
                .server(statusCode: 401, message: "Unauthorized", retryable: false)
            )
        }
    }

    func testEraseAllUsesDeleteAndRequiresExplicitAcknowledgement() async throws {
        let sender = MemoryQueueSender(responses: [response(#"{"ok":true}"#)])
        let client = NativeMemoryAPIClient(sender: sender)

        try await client.eraseAll(for: accountID)

        let requests = await sender.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/memory")
        XCTAssertEqual(request.method, .delete)
    }

    func testEraseAllWithoutExplicitOKIsNotASuccess() async throws {
        let sender = MemoryQueueSender(responses: [response(#"{"deleted":12}"#)])

        do {
            try await NativeMemoryAPIClient(sender: sender).eraseAll(for: accountID)
            XCTFail("An erase without ok:true must not report success")
        } catch {
            XCTAssertEqual(error as? NativeMemoryAPIError, .malformedResponse)
        }
    }

    private func response(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

private actor MemoryQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        return responses.removeFirst()
    }
}
