import Foundation
import JunoCore
import JunoStorage
import JunoSync
import XCTest
@testable import JunoChatKit

final class NativeSearchStoreTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")

    func testSearchSpansEntitiesAndRemainsAccountScoped() async throws {
        let repository = InMemoryTransactionalStore()
        try await seed(repository, accountID: accountA, marker: "quasar")
        try await seed(repository, accountID: accountB, marker: "pulsar")
        let store = NativeSearchStore(repository: repository)

        let results = try await store.search(accountID: accountA, query: "quasar")

        XCTAssertEqual(
            Set(results.map(\.kind)),
            [.conversation, .message, .project, .file, .artifact, .memory]
        )
        XCTAssertFalse(results.contains { $0.title.contains("pulsar") })
        XCTAssertFalse(results.contains { $0.snippet.contains("pulsar") })
        let message = try XCTUnwrap(results.first { $0.kind == .message })
        XCTAssertEqual(message.conversationID, "conversation-1")
        XCTAssertEqual(message.title, "Planning the quasar report")
        XCTAssertTrue(message.snippet.contains("quasar"))
    }

    func testTitleMatchOutranksBodyMatch() async throws {
        let repository = InMemoryTransactionalStore()
        try await seed(repository, accountID: accountA, marker: "quasar")
        let store = NativeSearchStore(repository: repository)

        let results = try await store.search(accountID: accountA, query: "quasar report")

        let first = try XCTUnwrap(results.first)
        XCTAssertEqual(first.kind, .conversation)
        XCTAssertEqual(first.title, "Planning the quasar report")
    }

    func testDiacriticsAndCaseAreInsensitive() async throws {
        let repository = InMemoryTransactionalStore()
        try await upsert(
            repository,
            accountID: accountA,
            namespace: "memory",
            id: "memory-1",
            payload: #"{"id":"memory-1","content":"Préfère les cafés serrés","createdAt":"2026-07-20T09:00:00.000Z","updatedAt":"2026-07-20T09:00:00.000Z"}"#
        )
        let store = NativeSearchStore(repository: repository)

        let results = try await store.search(accountID: accountA, query: "CAFES")

        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.kind, .memory)
    }

    func testTombstonedCodeAndCorruptRecordsAreNotSearchable() async throws {
        let repository = InMemoryTransactionalStore()
        try await seed(repository, accountID: accountA, marker: "quasar")
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [
                .upsert(StoredRecord(
                    accountID: accountA,
                    key: RecordKey(namespace: "conversation", id: "conversation-gone"),
                    revision: 4,
                    updatedAt: Date(),
                    isTombstone: true
                )),
                .upsert(StoredRecord(
                    accountID: accountA,
                    key: RecordKey(namespace: "conversation", id: "conversation-code"),
                    revision: 2,
                    updatedAt: Date(),
                    payload: Data(#"{"id":"conversation-code","title":"quasar code session","kind":"code","updatedAt":"2026-07-21T12:00:00.000Z"}"#.utf8)
                )),
                .upsert(StoredRecord(
                    accountID: accountA,
                    key: RecordKey(namespace: "project", id: "project-corrupt"),
                    revision: 2,
                    updatedAt: Date(),
                    payload: Data("not json".utf8)
                )),
            ]
        ))
        let store = NativeSearchStore(repository: repository)

        let results = try await store.search(accountID: accountA, query: "quasar")

        XCTAssertFalse(results.contains { $0.entityID == "conversation-gone" })
        XCTAssertFalse(results.contains { $0.entityID == "conversation-code" })
        XCTAssertFalse(results.contains { $0.entityID == "project-corrupt" })
        XCTAssertFalse(results.isEmpty)
    }

    func testBlankQueryAndLimitBehave() async throws {
        let repository = InMemoryTransactionalStore()
        try await seed(repository, accountID: accountA, marker: "quasar")
        let store = NativeSearchStore(repository: repository)

        let blank = try await store.search(accountID: accountA, query: "   ")
        XCTAssertTrue(blank.isEmpty)

        let limited = try await store.search(
            accountID: accountA, query: "quasar", limit: 2
        )
        XCTAssertEqual(limited.count, 2)

        let none = try await store.search(accountID: accountA, query: "nonexistent")
        XCTAssertTrue(none.isEmpty)
    }

    private func seed(
        _ repository: InMemoryTransactionalStore,
        accountID: StorageAccountID,
        marker: String
    ) async throws {
        try await upsert(
            repository, accountID: accountID,
            namespace: "conversation", id: "conversation-1",
            payload: #"{"id":"conversation-1","title":"Planning the \#(marker) report","kind":"chat","pinned":true,"updatedAt":"2026-07-21T12:00:00.000Z","lastMessageAt":"2026-07-21T12:05:00.000Z"}"#
        )
        try await upsert(
            repository, accountID: accountID,
            namespace: "message", id: "message-1",
            payload: #"{"id":"message-1","conversationId":"conversation-1","role":"assistant","content":"The \#(marker) emits X-rays.","createdAt":"2026-07-21T12:05:00.000Z"}"#
        )
        try await upsert(
            repository, accountID: accountID,
            namespace: "project", id: "project-1",
            payload: #"{"id":"project-1","name":"Astro","instructions":"Track every \#(marker) observation.","createdAt":"2026-07-20T12:00:00.000Z","updatedAt":"2026-07-20T12:00:00.000Z"}"#
        )
        try await upsert(
            repository, accountID: accountID,
            namespace: "attachment", id: "file-1",
            payload: #"{"id":"file-1","conversationId":null,"projectId":"project-1","kind":"FILE","fileName":"\#(marker)-notes.pdf","mimeType":"application/pdf","size":10,"createdAt":"2026-07-20T12:00:00.000Z"}"#
        )
        try await upsert(
            repository, accountID: accountID,
            namespace: "artifact", id: "artifact-1",
            payload: #"{"id":"artifact-1","conversationId":"conversation-1","identifier":"chart","title":"\#(marker) brightness chart","type":"HTML","currentVersion":1,"createdAt":"2026-07-21T12:00:00.000Z","updatedAt":"2026-07-21T12:00:00.000Z"}"#
        )
        try await upsert(
            repository, accountID: accountID,
            namespace: "memory", id: "memory-1",
            payload: #"{"id":"memory-1","content":"Studies \#(marker) activity at night.","createdAt":"2026-07-19T09:00:00.000Z","updatedAt":"2026-07-19T09:00:00.000Z"}"#
        )
    }

    private func upsert(
        _ repository: InMemoryTransactionalStore,
        accountID: StorageAccountID,
        namespace: String,
        id: String,
        payload: String
    ) async throws {
        _ = try await repository.apply(StorageTransaction(
            accountID: accountID,
            operations: [.upsert(StoredRecord(
                accountID: accountID,
                key: RecordKey(namespace: namespace, id: id),
                revision: 1,
                updatedAt: Date(),
                payload: Data(payload.utf8)
            ))]
        ))
    }
}
