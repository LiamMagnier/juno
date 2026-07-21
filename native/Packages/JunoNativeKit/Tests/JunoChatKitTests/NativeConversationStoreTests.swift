import Foundation
import JunoStorage
import JunoSync
import XCTest
@testable import JunoChatKit

final class NativeConversationStoreTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")

    func testProjectsAccountScopedConversationsAndRealMessages() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(
            repository,
            accountID: accountA,
            conversationID: "conversation-a",
            title: "Real account conversation",
            messageID: "message-a"
        )
        try await seed(
            repository,
            accountID: accountB,
            conversationID: "conversation-b",
            title: "Another account",
            messageID: "message-b"
        )
        let store = NativeConversationStore(repository: repository, outbox: outbox)

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(snapshot.conversations.map(\.id), ["conversation-a"])
        XCTAssertEqual(snapshot.conversations.first?.title, "Real account conversation")
        XCTAssertEqual(snapshot.messagesByConversation["conversation-a"]?.map(\.id), ["message-a"])
        XCTAssertEqual(snapshot.messagesByConversation["conversation-a"]?.first?.role, .user)
        XCTAssertNil(snapshot.messagesByConversation["conversation-b"])
    }

    func testPendingOutboxMutationsOverlayWithoutChangingServerRevision() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(
            repository,
            accountID: accountA,
            conversationID: "conversation-a",
            title: "Before",
            messageID: "message-a"
        )
        _ = try await outbox.enqueue(mutation(
            id: "pin",
            key: "550e8400-e29b-41d4-a716-446655440000",
            entityID: "conversation-a",
            operation: "conversation.update",
            body: #"{"type":"conversation.update","entityId":"conversation-a","patch":{"pinned":true,"model":"openai:gpt-5"}}"#
        ))
        _ = try await outbox.enqueue(mutation(
            id: "create",
            key: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
            entityID: "550e8400-e29b-41d4-a716-446655440001",
            operation: "conversation.create",
            body: #"{"type":"conversation.create","clientEntityId":"550e8400-e29b-41d4-a716-446655440001","title":"Offline draft","kind":"chat","model":"openai:gpt-5"}"#
        ))
        let store = NativeConversationStore(repository: repository, outbox: outbox)

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(snapshot.pendingMutationCount, 2)
        XCTAssertEqual(snapshot.conversations.first?.title, "Before")
        XCTAssertTrue(snapshot.conversations.first?.pinned == true)
        XCTAssertEqual(snapshot.conversations.first?.model, "openai:gpt-5")
        XCTAssertEqual(snapshot.conversations.first?.revision, 7)
        XCTAssertTrue(snapshot.conversations.allSatisfy(\.isPending))
        XCTAssertTrue(snapshot.conversations.contains { $0.title == "Offline draft" })
    }

    func testCorruptPayloadFailsClosed() async throws {
        let repository = InMemoryTransactionalStore()
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [.upsert(StoredRecord(
                accountID: accountA,
                key: RecordKey(namespace: "conversation", id: "conversation-a"),
                revision: 1,
                updatedAt: Date(),
                payload: Data(#"{"id":"another-id"}"#.utf8)
            ))]
        ))
        let store = NativeConversationStore(
            repository: repository,
            outbox: InMemoryMutationOutbox()
        )

        do {
            _ = try await store.load(accountID: accountA)
            XCTFail("Corrupt synchronized records must not be partially projected")
        } catch {
            XCTAssertEqual(
                error as? NativeConversationStoreError,
                .corruptRecord(RecordKey(namespace: "conversation", id: "conversation-a"))
            )
        }
    }

    private func seed(
        _ repository: InMemoryTransactionalStore,
        accountID: StorageAccountID,
        conversationID: String,
        title: String,
        messageID: String
    ) async throws {
        let conversation = """
        {"id":"\(conversationID)","title":"\(title)","model":"openai:gpt-5","kind":"chat","pinned":false,"archivedAt":null,"createdAt":"2026-07-21T12:00:00.000Z","updatedAt":"2026-07-21T12:01:00.000Z","lastMessageAt":"2026-07-21T12:02:00.000Z"}
        """
        let message = """
        {"id":"\(messageID)","conversationId":"\(conversationID)","clientId":"client-1","role":"USER","content":"Hello Juno","reasoning":null,"model":null,"createdAt":"2026-07-21T12:02:00.000Z"}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: accountID,
            operations: [
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "conversation", id: conversationID),
                    revision: 7,
                    updatedAt: Date(timeIntervalSince1970: 10),
                    payload: Data(conversation.utf8)
                )),
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "message", id: messageID),
                    revision: 3,
                    updatedAt: Date(timeIntervalSince1970: 11),
                    payload: Data(message.utf8)
                )),
            ]
        ))
    }

    private func mutation(
        id: String,
        key: String,
        entityID: String,
        operation: String,
        body: String
    ) -> MutationDraft {
        MutationDraft(
            id: OutboxMutationID(id),
            accountID: accountA,
            idempotencyKey: IdempotencyKey(key),
            entity: RecordKey(namespace: "conversation", id: entityID),
            operation: operation,
            payload: Data(body.utf8),
            createdAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
    }
}
