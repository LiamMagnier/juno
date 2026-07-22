import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest
@testable import JunoChatKit

final class NativeArtifactStoreTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")

    func testArtifactsVersionsAndConversationTitlesRemainAccountScoped() async throws {
        let repository = InMemoryTransactionalStore()
        try await seed(repository, accountID: accountA, suffix: "a")
        try await seed(repository, accountID: accountB, suffix: "b")
        let store = NativeArtifactStore(repository: repository)

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(snapshot.artifacts.map(\.id), ["artifact-a"])
        let artifact = try XCTUnwrap(snapshot.artifacts.first)
        XCTAssertEqual(artifact.conversationTitle, "Conversation a")
        XCTAssertEqual(artifact.currentContent, "<h1>A</h1>")
        XCTAssertEqual(artifact.versions.map(\.version), [1])
    }

    func testTombstonedArtifactAndVersionAreNotProjected() async throws {
        let repository = InMemoryTransactionalStore()
        try await seed(repository, accountID: accountA, suffix: "a")
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [
                .upsert(StoredRecord(
                    accountID: accountA,
                    key: RecordKey(namespace: "artifact", id: "artifact-a"),
                    revision: 8,
                    updatedAt: Date(),
                    isTombstone: true
                )),
                .upsert(StoredRecord(
                    accountID: accountA,
                    key: RecordKey(namespace: "artifact_version", id: "version-a"),
                    revision: 8,
                    updatedAt: Date(),
                    isTombstone: true
                )),
            ]
        ))

        let snapshot = try await NativeArtifactStore(repository: repository)
            .load(accountID: accountA)

        XCTAssertTrue(snapshot.artifacts.isEmpty)
    }

    func testCorruptArtifactFailsClosed() async throws {
        let repository = InMemoryTransactionalStore()
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [.upsert(StoredRecord(
                accountID: accountA,
                key: RecordKey(namespace: "artifact", id: "artifact-a"),
                revision: 1,
                updatedAt: Date(),
                payload: Data(#"{"id":"wrong"}"#.utf8)
            ))]
        ))

        do {
            _ = try await NativeArtifactStore(repository: repository)
                .load(accountID: accountA)
            XCTFail("Corrupt artifact state must fail closed")
        } catch {
            XCTAssertEqual(
                error as? NativeArtifactStoreError,
                .corruptRecord(RecordKey(namespace: "artifact", id: "artifact-a"))
            )
        }
    }

    private func seed(
        _ repository: InMemoryTransactionalStore,
        accountID: StorageAccountID,
        suffix: String
    ) async throws {
        let conversation = """
        {"id":"conversation-\(suffix)","title":"Conversation \(suffix)","lastMessageAt":"2026-07-21T12:00:00.000Z"}
        """
        let artifact = """
        {"id":"artifact-\(suffix)","conversationId":"conversation-\(suffix)","messageId":"message-\(suffix)","identifier":"demo-\(suffix)","title":"Demo \(suffix)","type":"HTML","language":null,"currentVersion":1,"createdAt":"2026-07-21T12:00:00.000Z","updatedAt":"2026-07-21T12:01:00.000Z"}
        """
        let version = """
        {"id":"version-\(suffix)","artifactId":"artifact-\(suffix)","version":1,"content":"<h1>\(suffix.uppercased())</h1>","createdAt":"2026-07-21T12:01:00.000Z"}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: accountID,
            operations: [
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "conversation", id: "conversation-\(suffix)"),
                    revision: 1,
                    updatedAt: Date(),
                    payload: Data(conversation.utf8)
                )),
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "artifact", id: "artifact-\(suffix)"),
                    revision: 2,
                    updatedAt: Date(),
                    payload: Data(artifact.utf8)
                )),
                .upsert(StoredRecord(
                    accountID: accountID,
                    key: RecordKey(namespace: "artifact_version", id: "version-\(suffix)"),
                    revision: 3,
                    updatedAt: Date(),
                    payload: Data(version.utf8)
                )),
            ]
        ))
    }
}

final class NativeArtifactAPIClientTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    func testFetchDecodesFullVersionHistory() async throws {
        let sender = ArtifactQueueSender(responses: [artifactResponse()])

        let artifact = try await NativeArtifactAPIClient(sender: sender).artifact(
            id: "artifact-1",
            for: accountID
        )

        XCTAssertEqual(artifact.currentVersion, 2)
        XCTAssertEqual(artifact.versions.map(\.origin), [.generated, .edit])
        XCTAssertEqual(artifact.versions.last?.content, "second")
        let requests = await sender.requests
        XCTAssertEqual(requests.first?.path, "/api/artifacts/artifact-1")
    }

    func testSaveSurfacesLatestArtifactOnStaleVersion() async throws {
        let sender = ArtifactQueueSender(responses: [artifactResponse(status: 409)])

        do {
            _ = try await NativeArtifactAPIClient(sender: sender).save(
                id: "artifact-1",
                content: "mine",
                baseVersion: 1,
                origin: .edit,
                for: accountID
            )
            XCTFail("A stale edit must not overwrite the latest version")
        } catch NativeArtifactAPIError.stale(let latest) {
            XCTAssertEqual(latest?.currentVersion, 2)
        }
    }

    func testRenameUsesExistingArtifactPatchRoute() async throws {
        let sender = ArtifactQueueSender(responses: [artifactResponse()])

        _ = try await NativeArtifactAPIClient(sender: sender).rename(
            id: "artifact-1",
            title: "Renamed",
            for: accountID
        )

        let requests = await sender.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.method, .patch)
        XCTAssertEqual(request.path, "/api/artifacts/artifact-1")
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: String],
            ["title": "Renamed"]
        )
    }

    func testExportUsesDetectedExistingFormatAndSafeFileName() async throws {
        let sender = ArtifactQueueSender(responses: [HTTPResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "application/vnd.test"]),
            body: Data("office".utf8)
        )])

        let exported = try await NativeArtifactAPIClient(sender: sender).export(
            id: "artifact-1",
            title: "Quarter / Plan",
            format: .docx,
            for: accountID
        )

        XCTAssertEqual(exported.fileName, "Quarter   Plan.docx")
        XCTAssertEqual(exported.contentType, "application/vnd.test")
        let requests = await sender.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.queryItems, [URLQueryItem(name: "format", value: "docx")])
    }

    func testSandboxEscapesSourceAndPreservesHTMLDocument() {
        let escaped = NativeArtifactSandbox.document(kind: .code, content: "<script>&")
        XCTAssertTrue(escaped.contains("&lt;script&gt;&amp;"))
        XCTAssertFalse(escaped.contains("<pre><script>"))

        let full = "<html><body>hello</body></html>"
        XCTAssertEqual(
            NativeArtifactSandbox.document(kind: .html, content: full),
            full
        )
    }

    private func artifactResponse(status: Int = 200) -> HTTPResponse {
        HTTPResponse(
            statusCode: status,
            headers: HTTPHeaders(),
            body: Data(#"{"error":"stale","artifact":{"id":"artifact-1","identifier":"demo","type":"CODE","title":"Demo","language":"swift","currentVersion":2,"messageId":"message-1","content":"second","versions":[{"version":1,"content":"first","origin":"generated","createdAt":"2026-07-21T12:00:00.000Z"},{"version":2,"content":"second","origin":"edit","createdAt":"2026-07-21T12:01:00.000Z"}],"createdAt":"2026-07-21T12:00:00.000Z","updatedAt":"2026-07-21T12:01:00.000Z"}}"#.utf8)
        )
    }
}

private actor ArtifactQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.badServerResponse) }
        return responses.removeFirst()
    }
}
