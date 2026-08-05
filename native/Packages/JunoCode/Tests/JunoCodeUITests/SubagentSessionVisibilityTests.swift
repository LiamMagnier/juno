import XCTest
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeUI

/// A delegated sub-agent must never surface as a conversation.
///
/// Every one of these lists is what the Mac sidebar renders — Active, Favorites,
/// the project outlines and Recents all read `filteredSessions` or
/// `favoriteSessions`. A child leaking into any of them is the "it just opened
/// another chat" this whole surface exists to remove.
final class SubagentSessionVisibilityTests: XCTestCase {
    private var storageRoot: URL!
    private var model: WorkbenchModel!

    private let configuration = AgentConfiguration(
        modelID: "test-model",
        reasoningEffort: .medium,
        role: .engineer,
        permissionMode: .readOnly,
        location: .local,
        computerUseEnabled: false
    )

    @MainActor
    override func setUp() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-subagent-visibility-\(UUID().uuidString)")
        storageRoot = root
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        model = WorkbenchModel(
            dependencies: WorkbenchModel.Dependencies(
                storageRootURL: root,
                modelClient: UnconfiguredModelClient(),
                availableModels: [ModelOption(modelID: "test-model", displayName: "Test Model")]
            )
        )
        await model.bootstrap()
    }

    @MainActor
    func testAChildSessionIsHiddenFromEveryListButStaysAddressable() async throws {
        let parent = try await makeSession(title: "Refactor the sync coordinator")
        let child = try await makeSession(title: "Map the reconnect callers", parent: parent.id)

        XCTAssertEqual(
            model.sessions.count, 2,
            "the child is a real session and stays in the store's list"
        )
        XCTAssertEqual(model.visibleSessions.map(\.id), [parent.id])
        XCTAssertEqual(model.filteredSessions.map(\.id), [parent.id])
        XCTAssertEqual(
            model.groupedSessions.flatMap { $0.sessions }.map(\.id), [parent.id],
            "a delegated session must not appear under Today, Yesterday or Earlier"
        )
        XCTAssertTrue(
            model.sessions.contains { $0.id == child.id },
            "the panel opens the child by id, so hiding it from lists must not unindex it"
        )
        XCTAssertTrue(child.isSubagent)
        XCTAssertFalse(parent.isSubagent)
    }

    @MainActor
    func testSearchNeverSurfacesAChild() async throws {
        let parent = try await makeSession(title: "Reconnect backoff")
        _ = try await makeSession(title: "Reconnect callers", parent: parent.id)

        model.sessionSearchText = "reconnect"
        XCTAssertEqual(
            model.filteredSessions.map(\.id), [parent.id],
            "a query that matches a child's title must still not offer it as a conversation"
        )
    }

    @MainActor
    func testAFavouritedChildStaysOutOfFavorites() async throws {
        let parent = try await makeSession(title: "Parent")
        let child = try await makeSession(title: "Child", parent: parent.id)
        _ = try await model.sessionStore.updateSession(id: child.id) { $0.isFavorite = true }
        await model.bootstrap()

        XCTAssertTrue(
            model.favoriteSessions.isEmpty,
            "favouriting is a list surface too; a child cannot enter through it"
        )
    }

    @MainActor
    func testSessionsRecordedBeforeParentLinksExistedAreStillListed() async throws {
        // A record written by an older build has no `parentSessionID` key at all.
        // It must decode as a top-level conversation, not vanish from the sidebar.
        let sessionsDirectory = storageRoot
            .appendingPathComponent("sessions-store")
            .appendingPathComponent("sessions")
            .appendingPathComponent("legacy-session")
        try FileManager.default.createDirectory(
            at: sessionsDirectory,
            withIntermediateDirectories: true
        )
        let legacy = """
        {"configuration":{"behavior":"code","computerUseEnabled":false,"location":"local",\
        "modelID":"test-model","permissionMode":"readOnly","reasoningEffort":"medium",\
        "role":"engineer"},"createdAt":"2026-01-01T00:00:00Z","hasPendingApproval":false,\
        "id":{"value":"legacy-session"},"isFavorite":false,"status":"completed",\
        "title":"Written by an older build","updatedAt":"2026-01-01T00:00:00Z"}
        """
        try Data(legacy.utf8).write(
            to: sessionsDirectory.appendingPathComponent("session.json")
        )
        try Data().write(to: sessionsDirectory.appendingPathComponent("events.jsonl"))

        let relaunched = WorkbenchModel(dependencies: model.dependencies)
        await relaunched.bootstrap()

        let restored = try XCTUnwrap(
            relaunched.sessions.first { $0.id == CodeSessionID(value: "legacy-session") }
        )
        XCTAssertNil(restored.parentSessionID)
        XCTAssertFalse(restored.isSubagent)
        XCTAssertTrue(relaunched.visibleSessions.contains { $0.id == restored.id })
    }

    @MainActor
    func testDeletingAParentTakesItsSubagentsWithIt() async throws {
        let parent = try await makeSession(title: "Parent")
        let child = try await makeSession(title: "Child", parent: parent.id)

        await model.deleteSession(id: parent.id)

        XCTAssertNil(model.lastError)
        XCTAssertTrue(model.sessions.isEmpty)
        let remaining = await model.sessionStore.allSessions()
        XCTAssertTrue(
            remaining.isEmpty,
            "a hidden child that outlives its parent is a transcript no surface can ever remove"
        )
        let orphans = await model.sessionStore.childSessions(of: parent.id)
        XCTAssertTrue(orphans.isEmpty)
        do {
            _ = try await model.sessionStore.session(id: child.id)
            XCTFail("the child's record must be gone, not merely unlisted")
        } catch let error as SessionStoreError {
            XCTAssertEqual(error, .sessionNotFound(id: child.id.value))
        }
    }

    @MainActor
    private func makeSession(
        title: String,
        parent: CodeSessionID? = nil
    ) async throws -> CodeSession {
        let session = try await model.sessionStore.createSession(
            workspaceID: nil,
            workspaceName: nil,
            title: title,
            configuration: configuration,
            gitBranch: nil,
            parentSessionID: parent
        )
        await model.bootstrap()
        return session
    }
}
