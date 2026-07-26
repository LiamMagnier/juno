import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

@MainActor
final class WorkbenchModelTests: XCTestCase {
    private var baseURL: URL!
    private var workspaceURL: URL!
    private var model: WorkbenchModel!

    override func setUp() async throws {
        let testRootURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-ui-\(UUID().uuidString)")
        baseURL = testRootURL
        addTeardownBlock {
            try? FileManager.default.removeItem(at: testRootURL)
        }
        workspaceURL = baseURL.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("src"),
            withIntermediateDirectories: true
        )
        try "let x = 1\n".write(
            to: workspaceURL.appendingPathComponent("src/main.swift"),
            atomically: true,
            encoding: .utf8
        )
        model = WorkbenchModel(
            dependencies: WorkbenchModel.Dependencies(
                storageRootURL: baseURL.appendingPathComponent("storage"),
                modelClient: UnconfiguredModelClient(),
                availableModels: [ModelOption(modelID: "test-model", displayName: "Test Model")]
            )
        )
        await model.bootstrap()
    }

    func testWorkspaceRegistrationPersistsAcrossRelaunch() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)
        XCTAssertNotNil(record)
        XCTAssertEqual(model.workspaces.count, 1)
        XCTAssertEqual(model.workspaces.first?.descriptor.displayName, "workspace")

        // Fresh model over the same storage: the grant must survive.
        let relaunched = WorkbenchModel(dependencies: model.dependencies)
        await relaunched.bootstrap()
        XCTAssertEqual(relaunched.workspaces.count, 1)
        let context = await relaunched.context(for: record!.id)
        XCTAssertNotNil(context, "bookmark must reopen the workspace")
    }

    func testSessionCreationAndSelection() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        let session = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )
        XCTAssertNotNil(session)
        XCTAssertEqual(model.selectedSessionID, session?.id)
        XCTAssertEqual(model.sessions.count, 1)

        let controller = await model.controller(for: session!.id)
        XCTAssertNotNil(controller)
        // The transcript starts with the sessionCreated event.
        XCTAssertTrue(controller!.events.contains {
            if case .sessionCreated = $0.payload { return true }
            return false
        })
    }

    func testRenameFavoriteDeleteSession() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        let session = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )!
        await model.renameSession(id: session.id, title: "Parser fix")
        await model.toggleFavorite(id: session.id)
        XCTAssertEqual(model.sessions.first?.title, "Parser fix")
        XCTAssertEqual(model.sessions.first?.isFavorite, true)
        XCTAssertEqual(model.favoriteSessions.count, 1)

        await model.deleteSession(id: session.id)
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertNil(model.selectedSessionID)
    }

    func testSessionSearchFilters() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        let first = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )!
        _ = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )!
        await model.renameSession(id: first.id, title: "Fix parser crash")
        model.sessionSearchText = "parser"
        XCTAssertEqual(model.filteredSessions.count, 1)
        XCTAssertEqual(model.filteredSessions.first?.title, "Fix parser crash")
        model.sessionSearchText = ""
        XCTAssertEqual(model.filteredSessions.count, 2)
    }

    func testUnconfiguredModelClientFailsSessionHonestly() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        let session = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )!
        let controller = await model.controller(for: session.id)!
        controller.composerText = "Do something"
        await controller.send()
        // The orchestrator retries once then fails the session.
        for _ in 0..<100 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if controller.session.status == .failed { break }
        }
        XCTAssertEqual(controller.session.status, .failed)
        XCTAssertTrue(controller.events.contains {
            if case let .errorOccurred(error) = $0.payload {
                return error.message.contains("No model transport")
            }
            return false
        })
    }

    func testTrackedChangesAggregationAndReject() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        let session = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )!
        let controller = await model.controller(for: session.id)!
        // A live controller always has its workspace; only preview omits it.
        let context = try XCTUnwrap(controller.context)

        // Two mutations to the same file through the file service, recorded
        // as transcript events the way the orchestrator does it.
        let write1 = try await context.files.write(
            try WorkspacePath("src/main.swift"),
            content: "let x = 2\n",
            expectedBase: nil,
            sessionID: session.id
        )
        try await model.sessionStore.appendEvent(
            sessionID: session.id,
            payload: .fileChanged(
                FileChangedEvent(
                    path: write1.path,
                    kind: write1.kind,
                    linesAdded: write1.diff?.linesAdded ?? 0,
                    linesRemoved: write1.diff?.linesRemoved ?? 0,
                    checkpointID: write1.checkpointID
                )
            )
        )
        let write2 = try await context.files.write(
            try WorkspacePath("src/main.swift"),
            content: "let x = 3\n",
            expectedBase: nil,
            sessionID: session.id
        )
        try await model.sessionStore.appendEvent(
            sessionID: session.id,
            payload: .fileChanged(
                FileChangedEvent(
                    path: write2.path,
                    kind: write2.kind,
                    linesAdded: write2.diff?.linesAdded ?? 0,
                    linesRemoved: write2.diff?.linesRemoved ?? 0,
                    checkpointID: write2.checkpointID
                )
            )
        )
        // Let the observer deliver.
        for _ in 0..<50 {
            try await Task.sleep(nanoseconds: 50_000_000)
            if controller.changes.count == 1,
               controller.changes.first?.checkpointIDs.count == 2 { break }
        }
        XCTAssertEqual(controller.changes.count, 1)
        let change = controller.changes[0]
        XCTAssertEqual(change.path, "src/main.swift")
        XCTAssertEqual(change.checkpointIDs.count, 2)

        // The diff spans from the original content to the current state.
        let diff = await controller.diff(for: "src/main.swift")
        XCTAssertNotNil(diff)
        XCTAssertEqual(diff?.linesAdded, 1)
        XCTAssertEqual(diff?.linesRemoved, 1)

        // Reject restores the original content.
        await controller.rejectChange(path: "src/main.swift")
        let content = try String(
            contentsOf: workspaceURL.appendingPathComponent("src/main.swift"),
            encoding: .utf8
        )
        XCTAssertEqual(content, "let x = 1\n")
        XCTAssertEqual(controller.changes.first?.reviewState, .rejected)
    }

    func testHunkReviewKeepsOneAndCheckpointRevertsAnother() async throws {
        let path = try WorkspacePath("src/main.swift")
        let original = (1...40).map(String.init).joined(separator: "\n") + "\n"
        try original.write(
            to: workspaceURL.appendingPathComponent(path.value),
            atomically: true,
            encoding: .utf8
        )
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        let session = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )!
        let controller = await model.controller(for: session.id)!
        let context = try XCTUnwrap(controller.context)

        var changedLines = (1...40).map(String.init)
        changedLines[0] = "one"
        changedLines[39] = "forty"
        let changed = changedLines.joined(separator: "\n") + "\n"
        let mutation = try await context.files.write(
            path,
            content: changed,
            expectedBase: FileFingerprint(of: original),
            sessionID: session.id
        )
        try await model.sessionStore.appendEvent(
            sessionID: session.id,
            payload: .fileChanged(
                FileChangedEvent(
                    path: mutation.path,
                    kind: mutation.kind,
                    linesAdded: mutation.diff?.linesAdded ?? 0,
                    linesRemoved: mutation.diff?.linesRemoved ?? 0,
                    checkpointID: mutation.checkpointID
                )
            )
        )
        for _ in 0..<30 {
            if controller.changes.first?.checkpointIDs.isEmpty == false { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        let loadedInitialDiff = await controller.diff(for: path.value)
        let initialDiff = try XCTUnwrap(loadedInitialDiff)
        XCTAssertEqual(initialDiff.hunks.count, 2)
        controller.acceptHunk(path: path.value, hunk: initialDiff.hunks[1])
        XCTAssertTrue(
            controller.isHunkAccepted(
                path: path.value,
                hunk: initialDiff.hunks[1]
            )
        )

        let reverted = await controller.rejectHunk(path: path.value, index: 0)
        XCTAssertTrue(reverted)
        let loadedRemainingDiff = await controller.diff(for: path.value)
        let remainingDiff = try XCTUnwrap(loadedRemainingDiff)
        XCTAssertEqual(remainingDiff.hunks.count, 1)
        XCTAssertEqual(remainingDiff.linesAdded, 1)
        XCTAssertEqual(remainingDiff.linesRemoved, 1)
        XCTAssertEqual(controller.changes.first?.linesAdded, 1)
        XCTAssertEqual(controller.changes.first?.linesRemoved, 1)
        XCTAssertFalse(
            controller.isHunkAccepted(
                path: path.value,
                hunk: initialDiff.hunks[1]
            ),
            "a changed diff invalidates hunk review badges"
        )

        var expectedLines = (1...40).map(String.init)
        expectedLines[39] = "forty"
        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent(path.value),
                encoding: .utf8
            ),
            expectedLines.joined(separator: "\n") + "\n"
        )
    }

    func testManualEditorUsesCheckpointedConflictSafeWrites() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        let session = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )!
        let controller = await model.controller(for: session.id)!
        let path = try WorkspacePath("src/main.swift")
        let loaded = await controller.openWorkspaceFile(path)
        let opened = try XCTUnwrap(loaded)

        let saved = await controller.saveWorkspaceFile(
            opened,
            content: "let x = 9\n"
        )
        XCTAssertEqual(saved?.content, "let x = 9\n")
        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent("src/main.swift"),
                encoding: .utf8
            ),
            "let x = 9\n"
        )
        for _ in 0..<30 {
            if !controller.changes.isEmpty { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(controller.changes.first?.path, "src/main.swift")

        let stale = try XCTUnwrap(saved)
        try "let x = 10\n".write(
            to: workspaceURL.appendingPathComponent("src/main.swift"),
            atomically: true,
            encoding: .utf8
        )
        let conflicted = await controller.saveWorkspaceFile(
            stale,
            content: "let x = 11\n"
        )
        XCTAssertNil(conflicted)
        XCTAssertTrue(
            controller.transientError?.contains("changed on disk") == true
        )
        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent("src/main.swift"),
                encoding: .utf8
            ),
            "let x = 10\n",
            "a stale editor must never overwrite newer disk content"
        )
    }

    func testAskSessionManualEditorIsReadOnly() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        let session = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(
                modelID: "test-model",
                behavior: .ask
            )
        )!
        let controller = await model.controller(for: session.id)!
        let loaded = await controller.openWorkspaceFile(
            try WorkspacePath("src/main.swift")
        )
        let opened = try XCTUnwrap(loaded)

        let saved = await controller.saveWorkspaceFile(
            opened,
            content: "let x = 2\n"
        )
        XCTAssertNil(saved)
        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent("src/main.swift"),
                encoding: .utf8
            ),
            "let x = 1\n"
        )
    }

    func testGroupedSessionsByRecency() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        _ = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )!
        let groups = model.groupedSessions
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.title, "Today")
        XCTAssertEqual(groups.first?.sessions.count, 1)
    }
}
