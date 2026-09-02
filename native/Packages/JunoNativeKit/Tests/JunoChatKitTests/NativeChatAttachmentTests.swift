import Foundation
import JunoStorage
import JunoSync
import XCTest

@testable import JunoChatKit

/// The transcript's pictures, and the archive overlay, both read out of the
/// same snapshot the store already projects.
final class NativeChatAttachmentTests: XCTestCase {
    private let account = StorageAccountID("account-a")

    func testAttachmentsAreJoinedOntoTheirMessage() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(repository, extra: [
            record("attachment", "img-1", """
            {"id":"img-1","conversationId":"conv-a","messageId":"msg-a","projectId":null,"kind":"IMAGE","fileName":"photo.jpg","mimeType":"image/jpeg","size":120,"width":1200,"height":800,"createdAt":"2026-07-21T12:02:00.000Z"}
            """),
            record("attachment", "doc-1", """
            {"id":"doc-1","conversationId":"conv-a","messageId":"msg-a","projectId":null,"kind":"FILE","fileName":"notes.pdf","mimeType":"application/pdf","size":9000,"width":null,"height":null,"createdAt":"2026-07-21T12:02:00.000Z"}
            """),
            // A project file with no message must not land on any row.
            record("attachment", "proj-1", """
            {"id":"proj-1","conversationId":null,"messageId":null,"projectId":"p1","kind":"FILE","fileName":"spec.md","mimeType":"text/markdown","size":10,"width":null,"height":null,"createdAt":"2026-07-21T12:02:00.000Z"}
            """),
        ])
        let store = NativeConversationStore(repository: repository, outbox: outbox)

        let snapshot = try await store.load(accountID: account)
        let message = try XCTUnwrap(snapshot.messagesByConversation["conv-a"]?.first)

        XCTAssertEqual(message.attachments.map(\.id), ["doc-1", "img-1"])
        XCTAssertEqual(message.imageAttachments.map(\.id), ["img-1"])
        XCTAssertEqual(message.imageAttachments.first?.aspectRatio, 1.5)
        XCTAssertTrue(message.attachments.first { $0.id == "img-1" }?.isImage == true)
        XCTAssertFalse(message.attachments.first { $0.id == "doc-1" }?.isImage == true)
    }

    func testAnUnreadableAttachmentDoesNotBreakTheTranscript() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(repository, extra: [
            record("attachment", "bad-1", "{not json"),
        ])
        let store = NativeConversationStore(repository: repository, outbox: outbox)

        let snapshot = try await store.load(accountID: account)
        XCTAssertEqual(snapshot.messagesByConversation["conv-a"]?.count, 1)
        XCTAssertEqual(snapshot.messagesByConversation["conv-a"]?.first?.attachments, [])
    }

    func testPendingArchiveOverlaysTheConversation() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(repository, extra: [])
        _ = try await outbox.enqueue(MutationDraft(
            id: OutboxMutationID("archive"),
            accountID: account,
            idempotencyKey: IdempotencyKey("550e8400-e29b-41d4-a716-446655440010"),
            entity: RecordKey(namespace: "conversation", id: "conv-a"),
            operation: "conversation.archive",
            payload: Data(#"{"type":"conversation.archive","entityId":"conv-a","archived":true}"#.utf8),
            createdAt: Date(timeIntervalSince1970: 1_700_000_000)
        ))
        let store = NativeConversationStore(repository: repository, outbox: outbox)

        let snapshot = try await store.load(accountID: account)
        let conversation = try XCTUnwrap(snapshot.conversations.first)
        XCTAssertTrue(conversation.isArchived, "an archive queued offline shows as archived at once")
        XCTAssertEqual(
            NativeConversationGrouping.groups(for: snapshot.conversations, now: Date()).map(\.bucket),
            [.archived]
        )
    }

    // MARK: - Helpers

    private func record(_ namespace: String, _ id: String, _ json: String) -> StoredRecord {
        StoredRecord(
            accountID: account,
            key: RecordKey(namespace: namespace, id: id),
            revision: 1,
            updatedAt: Date(timeIntervalSince1970: 12),
            payload: Data(json.utf8)
        )
    }

    private func seed(_ repository: InMemoryTransactionalStore, extra: [StoredRecord]) async throws {
        let conversation = """
        {"id":"conv-a","title":"Photos","model":"openai:gpt-5","kind":"chat","pinned":false,"archivedAt":null,"createdAt":"2026-07-21T12:00:00.000Z","updatedAt":"2026-07-21T12:01:00.000Z","lastMessageAt":"2026-07-21T12:02:00.000Z"}
        """
        let message = """
        {"id":"msg-a","conversationId":"conv-a","clientId":null,"role":"USER","content":"What is this?","reasoning":null,"model":null,"createdAt":"2026-07-21T12:02:00.000Z"}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: account,
            operations: [
                .upsert(record("conversation", "conv-a", conversation)),
                .upsert(record("message", "msg-a", message)),
            ] + extra.map { .upsert($0) }
        ))
    }
}
