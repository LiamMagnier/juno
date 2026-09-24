import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest
@testable import JunoChatKit

final class NativeProjectStoreTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")

    func testProjectsFilesAndConversationsRemainAccountScoped() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(repository, accountID: accountA, suffix: "a")
        try await seed(repository, accountID: accountB, suffix: "b")
        let store = NativeProjectStore(repository: repository, outbox: outbox)

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(snapshot.projects.map(\.id), ["project-a"])
        XCTAssertEqual(snapshot.files.map(\.id), ["file-a"])
        XCTAssertEqual(snapshot.filesByProject["project-a"]?.map(\.id), ["file-a"])
        XCTAssertEqual(
            snapshot.conversationsByProject["project-a"]?.map(\.id),
            ["conversation-a"]
        )
        XCTAssertNil(snapshot.filesByProject["project-b"])
        XCTAssertNil(snapshot.conversationsByProject["project-b"])
    }

    func testPendingProjectMutationsOverlayWithoutChangingRevision() async throws {
        let repository = InMemoryTransactionalStore()
        let outbox = InMemoryMutationOutbox()
        try await seed(repository, accountID: accountA, suffix: "a")
        _ = try await outbox.enqueue(mutation(
            id: "update",
            key: "550e8400-e29b-41d4-a716-446655440000",
            entityID: "project-a",
            operation: "project.update",
            body: #"{"type":"project.update","entityId":"project-a","name":"After","instructions":"Updated","starred":true}"#
        ))
        _ = try await outbox.enqueue(mutation(
            id: "create",
            key: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
            entityID: "550e8400-e29b-41d4-a716-446655440001",
            operation: "project.create",
            body: #"{"type":"project.create","clientEntityId":"550e8400-e29b-41d4-a716-446655440001","name":"Offline","instructions":"Saved locally"}"#
        ))
        let store = NativeProjectStore(repository: repository, outbox: outbox)

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(snapshot.pendingMutationCount, 2)
        let updated = try XCTUnwrap(snapshot.projects.first { $0.id == "project-a" })
        XCTAssertEqual(updated.name, "After")
        XCTAssertEqual(updated.instructions, "Updated")
        XCTAssertTrue(updated.starred)
        XCTAssertEqual(updated.revision, 8)
        XCTAssertTrue(updated.isPending)
        XCTAssertTrue(snapshot.projects.contains {
            $0.id == "550e8400-e29b-41d4-a716-446655440001" && $0.isPending
        })
    }

    func testTombstonedProjectIsNotProjected() async throws {
        let repository = InMemoryTransactionalStore()
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [.upsert(StoredRecord(
                accountID: accountA,
                key: RecordKey(namespace: "project", id: "deleted"),
                revision: 3,
                updatedAt: Date(),
                isTombstone: true
            ))]
        ))
        let store = NativeProjectStore(
            repository: repository,
            outbox: InMemoryMutationOutbox()
        )

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertTrue(snapshot.projects.isEmpty)
    }

    /// A file taken out of the Library is still synced and still in its
    /// project: only the Library reads the field.
    func testLibraryRemovedFileStaysInItsProjectAndSaysItLeftTheLibrary() async throws {
        let repository = InMemoryTransactionalStore()
        try await seed(repository, accountID: accountA, suffix: "a")
        try await putFile(
            repository,
            id: "removed",
            projectID: "project-a",
            libraryRemovedAt: #""2026-09-23T12:00:00.000Z""#
        )
        let store = NativeProjectStore(repository: repository, outbox: InMemoryMutationOutbox())

        let snapshot = try await store.load(accountID: accountA)

        let removed = try XCTUnwrap(snapshot.files.first { $0.id == "removed" })
        XCTAssertFalse(removed.isInLibrary)
        XCTAssertEqual(
            removed.libraryRemovedAt,
            ISO8601DateFormatter().date(from: "2026-09-23T12:00:00Z")
        )
        XCTAssertEqual(
            Set(snapshot.filesByProject["project-a"]?.map(\.id) ?? []), ["file-a", "removed"]
        )
        // `seed` writes no `libraryRemovedAt` at all, as a server that predates
        // the field did: that file is in the Library.
        XCTAssertTrue(try XCTUnwrap(snapshot.files.first { $0.id == "file-a" }).isInLibrary)
    }

    func testExplicitNullLibraryRemovalMeansInTheLibrary() async throws {
        let repository = InMemoryTransactionalStore()
        try await putFile(repository, id: "kept", libraryRemovedAt: "null")
        let store = NativeProjectStore(repository: repository, outbox: InMemoryMutationOutbox())

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(snapshot.files.map(\.isInLibrary), [true])
    }

    /// Present means removed, even when the date cannot be read, and one odd
    /// field does not fail the load that every project screen depends on.
    func testAnUnreadableRemovalDateStillMeansRemoved() async throws {
        let repository = InMemoryTransactionalStore()
        try await putFile(repository, id: "odd", libraryRemovedAt: #""yesterday""#)
        let store = NativeProjectStore(repository: repository, outbox: InMemoryMutationOutbox())

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(snapshot.files.map(\.isInLibrary), [false])
    }

    /// The server's `libraryUse`: the message wins over the project, because
    /// the chat is where the file is seen.
    func testLibraryUseFollowsTheServersRule() {
        func file(messageID: String?, projectID: String?) -> NativeProjectFile {
            NativeProjectFile(
                id: "f", projectID: projectID, conversationID: nil, messageID: messageID,
                fileName: "f.png", kind: "IMAGE", mimeType: "image/png", size: 1,
                width: nil, height: nil, createdAt: Date(), revision: 1
            )
        }
        XCTAssertEqual(file(messageID: "m1", projectID: nil).libraryUse, .chat)
        XCTAssertEqual(file(messageID: nil, projectID: "p1").libraryUse, .project)
        XCTAssertEqual(file(messageID: "m1", projectID: "p1").libraryUse, .chat)
        XCTAssertNil(file(messageID: nil, projectID: nil).libraryUse)
    }

    func testCorruptProjectFailsClosed() async throws {
        let repository = InMemoryTransactionalStore()
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [.upsert(StoredRecord(
                accountID: accountA,
                key: RecordKey(namespace: "project", id: "project-a"),
                revision: 1,
                updatedAt: Date(),
                payload: Data(#"{"id":"another-project"}"#.utf8)
            ))]
        ))
        let store = NativeProjectStore(
            repository: repository,
            outbox: InMemoryMutationOutbox()
        )

        do {
            _ = try await store.load(accountID: accountA)
            XCTFail("Corrupt project state must not be partially projected")
        } catch {
            XCTAssertEqual(
                error as? NativeProjectStoreError,
                .corruptRecord(RecordKey(namespace: "project", id: "project-a"))
            )
        }
    }

    private func seed(
        _ repository: InMemoryTransactionalStore,
        accountID: StorageAccountID,
        suffix: String
    ) async throws {
        let projectID = "project-\(suffix)"
        let project = """
        {"id":"\(projectID)","name":"Project \(suffix)","nameSource":"user","instructions":"Ship it","starred":false,"createdAt":"2026-07-21T12:00:00.000Z","updatedAt":"2026-07-21T12:01:00.000Z"}
        """
        let file = """
        {"id":"file-\(suffix)","conversationId":null,"messageId":null,"projectId":"\(projectID)","kind":"FILE","fileName":"brief.pdf","mimeType":"application/pdf","size":1234,"width":null,"height":null,"createdAt":"2026-07-21T12:02:00.000Z"}
        """
        let conversation = """
        {"id":"conversation-\(suffix)","title":"Project chat","model":"openai:gpt-5","kind":"chat","pinned":true,"projectId":"\(projectID)","createdAt":"2026-07-21T12:00:00.000Z","updatedAt":"2026-07-21T12:03:00.000Z","lastMessageAt":"2026-07-21T12:03:00.000Z"}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: accountID,
            operations: [
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "project", id: projectID),
                    revision: 8,
                    updatedAt: Date(),
                    payload: Data(project.utf8)
                )),
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "attachment", id: "file-\(suffix)"),
                    revision: 4,
                    updatedAt: Date(),
                    payload: Data(file.utf8)
                )),
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "conversation", id: "conversation-\(suffix)"),
                    revision: 5,
                    updatedAt: Date(),
                    payload: Data(conversation.utf8)
                )),
            ]
        ))
    }

    /// One attachment record in account A. `libraryRemovedAt` is the raw JSON
    /// value of that field.
    private func putFile(
        _ repository: InMemoryTransactionalStore,
        id: String,
        projectID: String? = nil,
        libraryRemovedAt: String
    ) async throws {
        let project = projectID.map { "\"\($0)\"" } ?? "null"
        let payload = """
        {"id":"\(id)","conversationId":null,"messageId":null,"projectId":\(project),"kind":"FILE","fileName":"\(id).pdf","mimeType":"application/pdf","size":10,"width":null,"height":null,"createdAt":"2026-07-21T12:02:00.000Z","libraryRemovedAt":\(libraryRemovedAt)}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [.upsert(StoredRecord(
                accountID: accountA,
                key: RecordKey(namespace: "attachment", id: id),
                revision: 2,
                updatedAt: Date(),
                payload: Data(payload.utf8)
            ))]
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
            entity: RecordKey(namespace: "project", id: entityID),
            operation: operation,
            payload: Data(body.utf8),
            createdAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
    }
}

final class NativeProjectAPIClientTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    func testUploadUsesExistingMultipartRouteWithProjectID() async throws {
        let sender = ProjectQueueSender(responses: [response(
            #"{"attachment":{"id":"file-1","fileName":"brief.pdf"}}"#,
            status: 201
        )])
        let client = NativeProjectAPIClient(sender: sender)

        let uploaded = try await client.upload(
            data: Data("contents".utf8),
            fileName: "brief.pdf",
            mimeType: "application/pdf",
            projectID: "project-1",
            for: accountID
        )

        XCTAssertEqual(uploaded.id, "file-1")
        let requests = await sender.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/upload")
        XCTAssertEqual(request.method, .post)
        let body = String(decoding: try XCTUnwrap(request.body), as: UTF8.self)
        XCTAssertTrue(body.contains("name=\"projectId\"\r\n\r\nproject-1"))
        XCTAssertTrue(body.contains("filename=\"brief.pdf\""))
    }

    func testFileAccessRehydratesSignedURLInsteadOfUsingPersistedState() async throws {
        let sender = ProjectQueueSender(responses: [response(
            #"{"entities":[{"type":"attachment","id":"file-1","revision":2,"deletedAt":null,"data":{"id":"file-1","url":"https://files.example/signed"}}]}"#
        )])

        let access = try await NativeProjectAPIClient(sender: sender).accessFile(
            id: "file-1",
            for: accountID
        )

        XCTAssertEqual(access, .remote(try XCTUnwrap(URL(string: "https://files.example/signed"))))
        let requests = await sender.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/v1/entities")
        XCTAssertEqual(request.queryItems.first { $0.name == "type" }?.value, "attachment")
    }

    func testRelativeFileAccessUsesBearerFileRoute() async throws {
        let sender = ProjectQueueSender(responses: [
            response(#"{"entities":[{"type":"attachment","id":"file-1","revision":2,"deletedAt":null,"data":{"id":"file-1","url":"/api/files/account/file-1"}}]}"#),
            HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data("file".utf8)),
        ])

        let access = try await NativeProjectAPIClient(sender: sender).accessFile(
            id: "file-1",
            for: accountID
        )

        XCTAssertEqual(access, .downloaded(Data("file".utf8)))
        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.path), [
            "/api/v1/entities", "/api/files/account/file-1",
        ])
    }

    /// The Library's delete goes through the Library's route, which keeps a
    /// file a chat or project uses. The attachment route would delete it from
    /// the chat too.
    func testLibraryRemovalUsesTheLibraryRoute() async throws {
        let sender = ProjectQueueSender(responses: [
            response(#"{"ok":true,"mode":"hidden","keptIn":"chat"}"#),
            response(#"{"ok":true,"mode":"hidden","keptIn":"project"}"#),
            response(#"{"ok":true,"mode":"deleted","keptIn":null}"#),
        ])
        let client = NativeProjectAPIClient(sender: sender)

        let chat = try await client.removeFromLibrary(id: "file-1", for: accountID)
        let project = try await client.removeFromLibrary(id: "file-2", for: accountID)
        let loose = try await client.removeFromLibrary(id: "file-3", for: accountID)

        XCTAssertEqual(chat, .hidden(keptIn: .chat))
        XCTAssertEqual(project, .hidden(keptIn: .project))
        XCTAssertEqual(loose, .deleted)
        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.path), [
            "/api/library/file-1", "/api/library/file-2", "/api/library/file-3",
        ])
        XCTAssertEqual(requests.map(\.method), [.delete, .delete, .delete])
    }

    /// A project's own Delete stays a real delete.
    func testProjectFileDeleteStaysOnTheAttachmentRoute() async throws {
        let sender = ProjectQueueSender(responses: [response(#"{"ok":true}"#)])

        try await NativeProjectAPIClient(sender: sender).deleteFile(id: "file-1", for: accountID)

        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.path), ["/api/attachments/file-1"])
        XCTAssertEqual(requests.map(\.method), [.delete])
    }

    func testLibraryRemovalCarriesTheServersNotFound() async throws {
        let sender = ProjectQueueSender(responses: [
            response(#"{"error":"File not found."}"#, status: 404),
        ])

        do {
            _ = try await NativeProjectAPIClient(sender: sender)
                .removeFromLibrary(id: "file-1", for: accountID)
            XCTFail("A 404 must not read as a removal")
        } catch {
            XCTAssertEqual(
                error as? NativeProjectAPIError,
                .server(statusCode: 404, message: "File not found.", retryable: false)
            )
        }
    }

    /// Each mode names exactly one outcome. A hide that names nowhere, or a
    /// delete that names a keeper, says nothing reliable about what happened.
    /// The request still succeeded, so this is "unknown", not an error.
    func testLibraryRemovalReadsAContradictoryAnswerAsUnknown() async throws {
        for body in [
            #"{"ok":true,"mode":"hidden","keptIn":null}"#,
            #"{"ok":true,"mode":"hidden","keptIn":"folder"}"#,
            #"{"ok":true,"mode":"deleted","keptIn":"chat"}"#,
            #"{"ok":true,"mode":"archived","keptIn":null}"#,
            #"{"ok":true}"#,
            "not json",
        ] {
            let sender = ProjectQueueSender(responses: [response(body)])
            let removal = try await NativeProjectAPIClient(sender: sender)
                .removeFromLibrary(id: "file-1", for: accountID)
            XCTAssertNil(removal, body)
        }
    }

    /// The id is one path segment. With a slash in it the request would reach
    /// a different route, so none is sent.
    func testLibraryRemovalRefusesAnIDThatIsNotOnePathSegment() async throws {
        let sender = ProjectQueueSender(responses: [])

        do {
            _ = try await NativeProjectAPIClient(sender: sender)
                .removeFromLibrary(id: "file-1/restore", for: accountID)
            XCTFail("A multi-segment id must be refused")
        } catch {
            XCTAssertEqual(error as? NativeProjectAPIError, .invalidIdentifier)
        }
        let requests = await sender.requests
        XCTAssertTrue(requests.isEmpty)
    }

    private func response(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

private actor ProjectQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.badServerResponse) }
        return responses.removeFirst()
    }
}
