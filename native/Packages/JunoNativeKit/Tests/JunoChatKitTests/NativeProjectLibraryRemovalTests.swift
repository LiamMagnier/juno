import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest

@testable import JunoChatKit

/// Deleting a file from the Library must not delete it from a chat.
///
/// The phone's Library is a view over every synced `attachment`, the files
/// sent in chats included. Its Delete used to call `DELETE /api/attachments/{id}`,
/// which tombstones the row, so the file vanished from the chat it was sent
/// in. These drive the real model: the Library removes through its own route,
/// only the Library stops showing the file, and a later sync, whichever way it
/// went, is what the Library shows next.
@MainActor
final class NativeProjectLibraryRemovalTests: XCTestCase {
    private let account = "account-a"

    func testRemovingAChatsFileTakesItOutOfTheLibraryOnly() async throws {
        let (model, repository, sender) = try await makeModel(routes: [
            "/api/library/sent": ok(#"{"ok":true,"mode":"hidden","keptIn":"chat"}"#),
        ])
        try await put(repository, id: "sent", messageID: "m1", revision: 4)
        try await put(repository, id: "loose", messageID: nil, revision: 4)
        await model.start(for: try AccountID(account))

        let removal = await model.removeFromLibrary(id: "sent")

        XCTAssertEqual(removal, .hidden(keptIn: .chat))
        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.path), ["/api/library/sent"])
        XCTAssertEqual(requests.map(\.method), [.delete])
        XCTAssertEqual(model.libraryFiles.map(\.id), ["loose"])
        // Still synced: the chat that uses it keeps showing it.
        XCTAssertEqual(Set(model.files.map(\.id)), ["sent", "loose"])
        XCTAssertNil(model.lastErrorDescription)
    }

    /// Until sync brings the next revision, the cache still says the file is
    /// in the Library. The model hides it meanwhile, then follows the synced
    /// record, including a restore made on the web.
    func testTheLibraryFollowsSyncOnceItCatchesUp() async throws {
        let (model, repository, _) = try await makeModel(routes: [
            "/api/library/sent": ok(#"{"ok":true,"mode":"hidden","keptIn":"chat"}"#),
        ])
        try await put(repository, id: "sent", messageID: "m1", revision: 4)
        await model.start(for: try AccountID(account))
        await model.removeFromLibrary(id: "sent")
        XCTAssertTrue(model.libraryFiles.isEmpty, "Hidden before sync has caught up")

        try await put(
            repository, id: "sent", messageID: "m1", revision: 5,
            libraryRemovedAt: "2026-09-23T12:00:00.000Z"
        )
        await model.reload()
        XCTAssertTrue(model.libraryFiles.isEmpty, "Hidden by the synced field")
        XCTAssertEqual(model.files.map(\.id), ["sent"])

        // Restore on the web clears the field and bumps the revision again.
        try await put(repository, id: "sent", messageID: "m1", revision: 6)
        await model.reload()
        XCTAssertEqual(model.libraryFiles.map(\.id), ["sent"])
    }

    /// The request succeeded but the body did not say how. The file is out of
    /// the Library all the same, so the Library lets go of it and shows no
    /// error.
    func testAnUnreadableSuccessStillTakesTheFileOut() async throws {
        let (model, repository, _) = try await makeModel(routes: [
            "/api/library/sent": ok("{}"),
        ])
        try await put(repository, id: "sent", messageID: "m1", revision: 4)
        await model.start(for: try AccountID(account))

        let removal = await model.removeFromLibrary(id: "sent")

        XCTAssertNil(removal)
        XCTAssertTrue(model.libraryFiles.isEmpty)
        XCTAssertNil(model.lastErrorDescription)
    }

    /// A refused removal changes nothing on screen and says why.
    func testARefusedRemovalHidesNothing() async throws {
        let (model, repository, _) = try await makeModel(routes: [
            "/api/library/sent": HTTPResponse(
                statusCode: 404, headers: HTTPHeaders(),
                body: Data(#"{"error":"File not found."}"#.utf8)
            ),
        ])
        try await put(repository, id: "sent", messageID: "m1", revision: 4)
        await model.start(for: try AccountID(account))

        let removal = await model.removeFromLibrary(id: "sent")

        XCTAssertNil(removal)
        XCTAssertEqual(model.libraryFiles.map(\.id), ["sent"])
        XCTAssertEqual(model.lastErrorDescription, "File not found.")
        XCTAssertEqual(model.phase, .failed)
    }

    /// The project screen's Delete is still a real delete, through the
    /// attachment route.
    func testDeleteFileStaysOnTheAttachmentRoute() async throws {
        let (model, repository, sender) = try await makeModel(routes: [
            "/api/attachments/brief": ok(#"{"ok":true}"#),
        ])
        try await put(repository, id: "brief", messageID: nil, projectID: "p1", revision: 4)
        await model.start(for: try AccountID(account))

        await model.deleteFile(id: "brief")

        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.path), ["/api/attachments/brief"])
        XCTAssertEqual(requests.map(\.method), [.delete])
    }

    // MARK: - Helpers

    private func makeModel(
        routes: [String: HTTPResponse]
    ) async throws -> (
        NativeProjectModel<InMemoryTransactionalStore>,
        InMemoryTransactionalStore,
        LibraryRouteSender
    ) {
        let repository = InMemoryTransactionalStore()
        let sender = LibraryRouteSender(routes: routes)
        let outbox = InMemoryMutationOutbox()
        let coordinator = NativeSyncCoordinator(repository: repository, sender: sender)
        // Never started, so `refresh()` is a no-op and each test says what sync
        // delivered by writing the repository itself.
        let syncModel = NativeSyncModel(
            coordinator: coordinator,
            monitor: NativeSyncMonitor(coordinator: coordinator, streamer: sender)
        )
        let model = NativeProjectModel(
            repository: repository,
            outbox: outbox,
            drainer: NativeMutationDrainer(repository: repository, outbox: outbox, sender: sender),
            syncModel: syncModel,
            sender: sender
        )
        return (model, repository, sender)
    }

    /// Writes one synced attachment record, as sync would after hydrating it.
    private func put(
        _ repository: InMemoryTransactionalStore,
        id: String,
        messageID: String?,
        projectID: String? = nil,
        revision: UInt64,
        libraryRemovedAt: String? = nil
    ) async throws {
        func json(_ value: String?) -> String { value.map { "\"\($0)\"" } ?? "null" }
        let payload = """
        {"id":"\(id)","conversationId":\(json(messageID == nil ? nil : "c1")),\
        "messageId":\(json(messageID)),"projectId":\(json(projectID)),"kind":"IMAGE",\
        "fileName":"\(id).png","mimeType":"image/png","size":10,"width":1,"height":1,\
        "createdAt":"2026-09-20T09:30:00.000Z","libraryRemovedAt":\(json(libraryRemovedAt))}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: StorageAccountID(account),
            operations: [.upsert(StoredRecord(
                accountID: StorageAccountID(account),
                key: RecordKey(namespace: "attachment", id: id),
                revision: revision,
                updatedAt: Date(),
                payload: Data(payload.utf8)
            ))]
        ))
    }

    private func ok(_ body: String) -> HTTPResponse {
        HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

/// Answers the paths it was given and fails everything else as an outage, so
/// a request a test did not expect cannot quietly succeed.
private actor LibraryRouteSender: NativeAuthenticatedRequestSending,
    NativeAuthenticatedByteStreaming
{
    private let routes: [String: HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(routes: [String: HTTPResponse]) { self.routes = routes }

    func send(_ request: NativeBearerRequest, for _: AccountID) throws -> HTTPResponse {
        requests.append(request)
        guard let response = routes[request.path] else {
            throw URLError(.notConnectedToInternet)
        }
        return response
    }

    func stream(
        _ request: NativeBearerRequest,
        for _: AccountID
    ) throws -> HTTPByteStreamResponse {
        throw URLError(.notConnectedToInternet)
    }
}
