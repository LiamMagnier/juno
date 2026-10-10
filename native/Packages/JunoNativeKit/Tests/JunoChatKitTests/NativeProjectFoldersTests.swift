import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest

@testable import JunoChatKit

/// Project folders: the tree rules, the REST shapes of
/// `src/app/api/projects/route.ts` and `src/app/api/projects/[id]/route.ts`,
/// and the model that draws the index and a project page from them.
final class NativeProjectTreeTests: XCTestCase {
    /// atlas ─ research ─ notes ─ deep
    ///       └ drafts
    /// solo
    private let tree = NativeProjectTree(nodes: [
        .init(id: "atlas", parentID: nil),
        .init(id: "research", parentID: "atlas"),
        .init(id: "notes", parentID: "research"),
        .init(id: "deep", parentID: "notes"),
        .init(id: "drafts", parentID: "atlas"),
        .init(id: "solo", parentID: nil),
    ])

    func testAncestorsDescendantsAndDepth() {
        XCTAssertEqual(tree.ancestorIDs(of: "notes"), ["research", "atlas"])
        XCTAssertEqual(Set(tree.descendantIDs(of: "atlas")), ["research", "drafts", "notes", "deep"])
        XCTAssertEqual(tree.depth(of: "atlas"), 1)
        XCTAssertEqual(tree.depth(of: "deep"), 4)
        XCTAssertEqual(tree.subtreeHeight(of: "atlas"), 4)
        XCTAssertEqual(tree.subtreeHeight(of: "drafts"), 1)
        XCTAssertTrue(tree.isTopLevel("solo"))
        XCTAssertFalse(tree.isTopLevel("drafts"))
    }

    func testMovesFollowTheServersRules() {
        XCTAssertNil(tree.validateMove("drafts", to: nil))
        XCTAssertNil(tree.validateMove("drafts", to: "solo"))
        XCTAssertEqual(tree.validateMove("atlas", to: "atlas"), .isSelf)
        XCTAssertEqual(tree.validateMove("atlas", to: "notes"), .cycle)
        XCTAssertEqual(tree.validateMove("atlas", to: "missing"), .parentNotFound)
        XCTAssertEqual(tree.validateMove("missing", to: nil), .notFound)
        // atlas holds four levels; under solo it would reach depth 5.
        XCTAssertEqual(tree.validateMove("atlas", to: "solo"), .depth)
        XCTAssertNil(tree.validateMove("research", to: "solo"))
        XCTAssertEqual(tree.validateMove("research", to: "drafts"), .depth)
        XCTAssertEqual(tree.validateNewChild(under: "deep"), .depth)
        XCTAssertNil(tree.validateNewChild(under: "notes"))
    }

    func testDeletePlansMatchLiftAndCascade() {
        let lift = tree.planDelete("atlas", mode: .lift)
        XCTAssertEqual(lift.deleteIDs, ["atlas"])
        XCTAssertEqual(Set(lift.liftedIDs), ["research", "drafts"])
        let cascade = tree.planDelete("research", mode: .cascade)
        XCTAssertEqual(cascade.deleteIDs, ["deep", "notes", "research"])
        XCTAssertTrue(cascade.liftedIDs.isEmpty)
    }

    /// A loop already in the data, or a parent that is gone, is drawn at the
    /// top level rather than hidden.
    func testCorruptRowsStayVisible() {
        let corrupt = NativeProjectTree(nodes: [
            .init(id: "a", parentID: "b"),
            .init(id: "b", parentID: "a"),
            .init(id: "orphan", parentID: "gone"),
        ])
        XCTAssertTrue(corrupt.isTopLevel("orphan"))
        XCTAssertTrue(corrupt.isTopLevel("a"))
        XCTAssertTrue(corrupt.isTopLevel("b"))
        XCTAssertEqual(corrupt.ancestorIDs(of: "a"), ["b"])
    }

    func testRefusalReasonsDecodeFromTheServersStrings() {
        XCTAssertEqual(NativeProjectMoveRefusal(rawValue: "self"), .isSelf)
        XCTAssertEqual(NativeProjectMoveRefusal(rawValue: "parent_not_found"), .parentNotFound)
        XCTAssertEqual(NativeProjectMoveRefusal.depth.message, "Folders nest at most 4 levels deep.")
    }
}

final class NativeProjectFolderDetailTests: XCTestCase {
    /// The route's real response, trimmed of nothing the decoder needs.
    static let detailJSON = #"""
    {"project":{"id":"notes","name":"Notes","parentId":"research","instructions":"","starred":false,
      "updatedAt":"2026-10-01T10:00:00.000Z","workDefaults":{}},
     "conversations":[],"files":[],"workspace":null,
     "breadcrumbs":[{"id":"atlas","name":"Atlas launch"},{"id":"research","name":"Research"}],
     "children":[{"id":"deep","name":"Deep dives","instructions":"Cite sources.","starred":true,
       "updatedAt":"2026-10-02T08:30:00Z","conversationCount":3,"fileCount":2,"childCount":0}],
     "inherited":[{"id":"atlas","name":"Atlas launch","instructions":"Write in British English.","fileCount":4}]}
    """#

    func testDecodesBreadcrumbsChildrenAndInherited() throws {
        let detail = try NativeProjectFolderDetail.decode(Data(Self.detailJSON.utf8))
        XCTAssertEqual(detail.projectID, "notes")
        XCTAssertEqual(detail.parentID, "research")
        XCTAssertEqual(detail.breadcrumbs.map(\.name), ["Atlas launch", "Research"])
        XCTAssertEqual(detail.children.count, 1)
        let child = try XCTUnwrap(detail.children.first)
        XCTAssertEqual(child.name, "Deep dives")
        XCTAssertEqual(child.conversationCount, 3)
        XCTAssertEqual(child.fileCount, 2)
        XCTAssertTrue(child.starred)
        XCTAssertNotNil(child.updatedAt)
        XCTAssertEqual(detail.inherited, [
            NativeProjectInheritance(
                id: "atlas", name: "Atlas launch",
                instructions: "Write in British English.", fileCount: 4
            ),
        ])
    }

    /// A collaborator's view: no parent, empty lists.
    func testDecodesACollaboratorsEmptyFolderView() throws {
        let json = #"{"project":{"id":"p","name":"P","parentId":null},"breadcrumbs":[],"children":[],"inherited":[]}"#
        let detail = try NativeProjectFolderDetail.decode(Data(json.utf8))
        XCTAssertNil(detail.parentID)
        XCTAssertTrue(detail.breadcrumbs.isEmpty && detail.children.isEmpty && detail.inherited.isEmpty)
    }

    func testRejectsAResponseWithoutAProject() {
        XCTAssertThrowsError(try NativeProjectFolderDetail.decode(Data(#"{"children":[]}"#.utf8)))
    }
}

final class NativeProjectFoldersClientTests: XCTestCase {
    private let account = try! AccountID("account-a")

    func testCreateFolderPostsParentID() async throws {
        let sender = FolderRouteSender(routes: ["POST /api/projects": (201, #"{"id":"new-folder"}"#)])
        let client = NativeProjectFoldersClient(sender: sender)
        let id = try await client.createFolder(name: "  Drafts ", parentID: "atlas", for: account)
        XCTAssertEqual(id, "new-folder")
        let request = try await XCTUnwrapAsync(sender.requests.first)
        XCTAssertEqual(request.method, .post)
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.body)) as? [String: Any]
        XCTAssertEqual(body?["name"] as? String, "Drafts")
        XCTAssertEqual(body?["parentId"] as? String, "atlas")
    }

    func testMoveToTheTopLevelSendsAnExplicitNull() async throws {
        let sender = FolderRouteSender(routes: ["PATCH /api/projects/research": (200, #"{"ok":true}"#)])
        let client = NativeProjectFoldersClient(sender: sender)
        try await client.move(id: "research", to: nil, for: account)
        let request = try await XCTUnwrapAsync(sender.requests.first)
        XCTAssertEqual(String(decoding: try XCTUnwrap(request.body), as: UTF8.self), #"{"parentId":null}"#)
    }

    func testARefusedMoveCarriesTheServersReason() async throws {
        let sender = FolderRouteSender(routes: [
            "PATCH /api/projects/atlas": (409, #"{"error":"A project can’t go inside one of its own folders.","reason":"cycle"}"#),
        ])
        let client = NativeProjectFoldersClient(sender: sender)
        do {
            try await client.move(id: "atlas", to: "notes", for: account)
            XCTFail("Expected a refusal")
        } catch let refusal as NativeProjectMoveRefusal {
            XCTAssertEqual(refusal, .cycle)
        }
    }

    func testDeleteSendsTheChildrenModeAndReadsTheCounts() async throws {
        let sender = FolderRouteSender(routes: [
            "DELETE /api/projects/atlas": (200, #"{"ok":true,"deleted":4,"moved":0}"#),
        ])
        let client = NativeProjectFoldersClient(sender: sender)
        let result = try await client.delete(id: "atlas", children: .cascade, for: account)
        XCTAssertEqual(result, NativeProjectDeleteResult(deleted: 4, moved: 0))
        let request = try await XCTUnwrapAsync(sender.requests.first)
        XCTAssertEqual(request.queryItems, [URLQueryItem(name: "children", value: "cascade")])
    }

    func testParentIndexReadsTheFlatList() async throws {
        let sender = FolderRouteSender(routes: [
            "GET /api/projects": (200, #"{"projects":[{"id":"atlas","name":"A","parentId":null},{"id":"research","name":"R","parentId":"atlas"}]}"#),
        ])
        let index = try await NativeProjectFoldersClient(sender: sender).parentIndex(for: account)
        XCTAssertEqual(index["research"], .some("atlas"))
        XCTAssertEqual(index["atlas"], .some(nil))
    }

    func testAnIDThatIsNotOnePathSegmentIsRefused() async {
        let client = NativeProjectFoldersClient(sender: FolderRouteSender(routes: [:]))
        do {
            try await client.move(id: "a/b", to: nil, for: account)
            XCTFail("Expected a refusal")
        } catch {
            XCTAssertEqual(error as? NativeProjectAPIError, .invalidIdentifier)
        }
    }
}

@MainActor
final class NativeProjectFolderModelTests: XCTestCase {
    private let account = "account-a"

    func testTheIndexListsTopLevelProjectsAndThePageItsFolders() async throws {
        let (model, repository, _) = try makeModel(routes: [:])
        try await put(repository, "atlas", parent: .some(nil), instructions: "Write in British English.")
        try await put(repository, "research", parent: .some("atlas"))
        try await put(repository, "notes", parent: .some("research"))
        try await put(repository, "solo", parent: .some(nil))
        await model.start(for: try AccountID(account))

        XCTAssertEqual(Set(model.topLevelProjects.map(\.id)), ["atlas", "solo"])
        XCTAssertEqual(model.children(of: "atlas").map(\.id), ["research"])
        XCTAssertEqual(model.breadcrumbs(for: "notes").map(\.id), ["atlas", "research"])
        XCTAssertEqual(model.inherited(for: "notes").map(\.id), ["atlas"])
        let destinations = model.moveDestinations(for: "atlas")
        XCTAssertEqual(destinations.first?.projectID, nil)
        XCTAssertEqual(destinations.first(where: { $0.projectID == "notes" })?.refusal, .cycle)
        XCTAssertEqual(destinations.first(where: { $0.projectID == "atlas" })?.refusal, .isSelf)
        XCTAssertNil(destinations.first(where: { $0.projectID == "solo" })?.refusal)
        XCTAssertTrue(destinations.first?.isCurrent ?? false)
    }

    /// A cache written before the sync projection carried `parentId` is
    /// filled in from `GET /api/projects`, once.
    func testRecordsWithoutAParentAreFilledInFromTheList() async throws {
        let (model, repository, sender) = try makeModel(routes: [
            "GET /api/projects": (200, #"{"projects":[{"id":"atlas","parentId":null},{"id":"research","parentId":"atlas"}]}"#),
        ])
        try await put(repository, "atlas", parent: nil)
        try await put(repository, "research", parent: nil)
        await model.start(for: try AccountID(account))

        XCTAssertEqual(model.topLevelProjects.map(\.id), ["atlas"])
        XCTAssertEqual(model.projects.first { $0.id == "research" }?.parentID, "atlas")
        await model.reload()
        XCTAssertEqual(model.topLevelProjects.map(\.id), ["atlas"], "The index survives a reload")
        let paths = await sender.requests.map(\.path)
        XCTAssertEqual(paths, ["/api/projects"])
    }

    func testAMoveTheTreeRefusesIsNeverSent() async throws {
        let (model, repository, sender) = try makeModel(routes: [:])
        try await put(repository, "atlas", parent: .some(nil))
        try await put(repository, "research", parent: .some("atlas"))
        await model.start(for: try AccountID(account))

        let moved = await model.moveProject(id: "atlas", to: "research")

        XCTAssertFalse(moved)
        XCTAssertEqual(model.lastErrorDescription, NativeProjectMoveRefusal.cycle.message)
        let requests = await sender.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testAMovePatchesAndUpdatesTheTree() async throws {
        let (model, repository, sender) = try makeModel(routes: [
            "PATCH /api/projects/research": (200, #"{"ok":true}"#),
        ])
        try await put(repository, "atlas", parent: .some(nil))
        try await put(repository, "research", parent: .some("atlas"))
        await model.start(for: try AccountID(account))

        // Sync would bring the moved record; the test writes it as sync would.
        let moved = await model.moveProject(id: "research", to: nil)
        try await put(repository, "research", parent: .some(nil), revision: 2)
        await model.reload()

        XCTAssertTrue(moved)
        XCTAssertNil(model.lastErrorDescription)
        XCTAssertEqual(Set(model.topLevelProjects.map(\.id)), ["atlas", "research"])
        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.method), [.patch])
    }

    func testDeletingAFolderWithLiftSendsTheMode() async throws {
        let (model, repository, sender) = try makeModel(routes: [
            "DELETE /api/projects/atlas": (200, #"{"ok":true,"deleted":1,"moved":1}"#),
        ])
        try await put(repository, "atlas", parent: .some(nil))
        try await put(repository, "research", parent: .some("atlas"))
        await model.start(for: try AccountID(account))

        let result = await model.deleteProject(id: "atlas", children: .lift)

        XCTAssertEqual(result, NativeProjectDeleteResult(deleted: 1, moved: 1))
        let requests = await sender.requests
        XCTAssertEqual(requests.first?.queryItems, [URLQueryItem(name: "children", value: "lift")])
    }

    func testTheServersFolderViewIsUsedWhileItMatchesTheCache() async throws {
        let (model, repository, _) = try makeModel(routes: [
            "GET /api/projects/notes": (200, NativeProjectFolderDetailTests.detailJSON),
        ])
        try await put(repository, "atlas", parent: .some(nil))
        try await put(repository, "research", parent: .some("atlas"))
        try await put(repository, "notes", parent: .some("research"))
        await model.start(for: try AccountID(account))

        await model.loadFolderDetail(id: "notes")

        XCTAssertEqual(model.breadcrumbs(for: "notes").map(\.name), ["Atlas launch", "Research"])
        XCTAssertEqual(model.inherited(for: "notes").first?.fileCount, 4)
    }

    // MARK: - Helpers

    private func makeModel(
        routes: [String: (Int, String)]
    ) throws -> (NativeProjectModel<InMemoryTransactionalStore>, InMemoryTransactionalStore, FolderRouteSender) {
        let repository = InMemoryTransactionalStore()
        let sender = FolderRouteSender(routes: routes)
        let outbox = InMemoryMutationOutbox()
        let coordinator = NativeSyncCoordinator(repository: repository, sender: sender)
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

    /// One synced project record. `parent == nil` writes a record without the
    /// field, as a cache filled before the server sent it holds.
    private func put(
        _ repository: InMemoryTransactionalStore,
        _ id: String,
        parent: String??,
        instructions: String = "",
        revision: UInt64 = 1
    ) async throws {
        var parentField = ""
        if let parent { parentField = ",\"parentId\":" + (parent.map { "\"\($0)\"" } ?? "null") }
        let payload = """
        {"id":"\(id)","name":"\(id.capitalized)","instructions":"\(instructions)","starred":false,\
        "createdAt":"2026-09-20T09:30:00.000Z","updatedAt":"2026-09-21T09:30:00.000Z"\(parentField)}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: StorageAccountID(account),
            operations: [.upsert(StoredRecord(
                accountID: StorageAccountID(account),
                key: RecordKey(namespace: "project", id: id),
                revision: revision,
                updatedAt: Date(),
                payload: Data(payload.utf8)
            ))]
        ))
    }
}

/// Answers "METHOD /path" routes and fails everything else as an outage.
private actor FolderRouteSender: NativeAuthenticatedRequestSending, NativeAuthenticatedByteStreaming {
    private let routes: [String: (Int, String)]
    private(set) var requests: [NativeBearerRequest] = []

    init(routes: [String: (Int, String)]) { self.routes = routes }

    func send(_ request: NativeBearerRequest, for _: AccountID) throws -> HTTPResponse {
        requests.append(request)
        guard let (status, body) = routes["\(request.method.rawValue.uppercased()) \(request.path)"] else {
            throw URLError(.notConnectedToInternet)
        }
        return HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }

    func stream(_ request: NativeBearerRequest, for _: AccountID) throws -> HTTPByteStreamResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private func XCTUnwrapAsync<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    try XCTUnwrap(value, file: file, line: line)
}
