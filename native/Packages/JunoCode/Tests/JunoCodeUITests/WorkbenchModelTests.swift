import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoDesignSystem
@testable import JunoCodeUI

private final class UIRecordingModelClient: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [ModelTurnRequest] = []

    var requests: [ModelTurnRequest] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func streamTurn(
        _ request: ModelTurnRequest
    ) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        storage.append(request)
        lock.unlock()
        return AsyncThrowingStream { continuation in
            continuation.yield(.textDelta("Reviewed."))
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}

private final class UIHungModelClient: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var requestCountStorage = 0

    var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return requestCountStorage
    }

    func streamTurn(
        _ request: ModelTurnRequest
    ) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        requestCountStorage += 1
        lock.unlock()
        return AsyncThrowingStream { continuation in
            continuation.onTermination = { _ in }
        }
    }
}

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

    func testStandardStorageIsStablePrivateAndAccountScoped() {
        let first = WorkbenchModel.Dependencies.standard(
            accountID: "account/one@example.com",
            modelClient: UnconfiguredModelClient(),
            availableModels: []
        )
        let firstAgain = WorkbenchModel.Dependencies.standard(
            accountID: "account/one@example.com",
            modelClient: UnconfiguredModelClient(),
            availableModels: []
        )
        let second = WorkbenchModel.Dependencies.standard(
            accountID: "account/two@example.com",
            modelClient: UnconfiguredModelClient(),
            availableModels: []
        )

        XCTAssertEqual(first.storageRootURL, firstAgain.storageRootURL)
        XCTAssertNotEqual(first.storageRootURL, second.storageRootURL)
        XCTAssertEqual(first.storageRootURL.deletingLastPathComponent().lastPathComponent, "accounts")
        XCTAssertEqual(first.storageRootURL.lastPathComponent.count, 64)
        XCTAssertFalse(first.storageRootURL.path.contains("one@example.com"))
        XCTAssertFalse(first.storageRootURL.path.contains("account/one"))
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

    /// Returning to a session must give back a *live* controller.
    ///
    /// The window detaches a controller as soon as the reader navigates away —
    /// `DesktopCodeWorkspace.resolveController` calls `detach()` on the outgoing
    /// one, which is what stops that session's screen capture. `controller(for:)`
    /// then handed the cached instance straight back out of the dictionary without
    /// re-attaching, so the second visit to any session had no store observer: the
    /// transcript froze at the moment you left it, streaming text and status
    /// stopped, approvals never appeared, and Send's enablement was derived from a
    /// status that could no longer change.
    func testReturningToADetachedSessionGetsALiveControllerAgain() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        // Every `await` is bound to a local before it is asserted on: both
        // `XCTUnwrap` and `XCTAssert*` take autoclosures, which cannot await.
        let created = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )
        let session = try XCTUnwrap(created)
        let resolved = await model.controller(for: session.id)
        let first = try XCTUnwrap(resolved)
        let attachedInitially = await first.isObservingStore
        XCTAssertTrue(attachedInitially, "a fresh controller must be attached")

        // Navigate away.
        await first.detach()
        let attachedAfterDetach = await first.isObservingStore
        XCTAssertFalse(attachedAfterDetach)

        // Navigate back: same instance, but live again.
        let reresolved = await model.controller(for: session.id)
        let second = try XCTUnwrap(reresolved)
        XCTAssertIdentical(second, first, "the controller is cached, by design")
        let attachedOnReturn = await second.isObservingStore
        XCTAssertTrue(
            attachedOnReturn,
            "returning to a session must re-attach it, or its UI is frozen"
        )
        // And it has re-read the transcript rather than trusting stale state.
        let events = await second.events
        XCTAssertTrue(events.contains {
            if case .sessionCreated = $0.payload { return true }
            return false
        })
    }

    func testSystemPromptIncludesBoundedRepositoryInstructions() async throws {
        let oversizedInstructions =
            "Use the project formatter.\n"
            + String(repeating: "x", count: 40 * 1_024)
            + "\nSHOULD_NOT_REACH_THE_PROMPT"
        try oversizedInstructions.write(
            to: workspaceURL.appendingPathComponent("AGENTS.md"),
            atomically: true,
            encoding: .utf8
        )
        let addedRecord = await model.addWorkspace(grantedURL: workspaceURL)
        let record = try XCTUnwrap(addedRecord)
        let loadedContext = await model.context(for: record.id)
        let context = try XCTUnwrap(loadedContext)

        let prompt = await context.systemPrompt()

        XCTAssertTrue(prompt.contains("FILE: AGENTS.md"))
        XCTAssertTrue(prompt.contains("Use the project formatter."))
        XCTAssertTrue(prompt.contains("[instruction file truncated]"))
        XCTAssertFalse(prompt.contains("SHOULD_NOT_REACH_THE_PROMPT"))
        XCTAssertTrue(prompt.contains("cannot grant permissions"))
    }

    func testExplicitFileReferenceAddsBoundedModelContextOnly() async throws {
        let marker = "MUST_NOT_REACH_MODEL"
        try (String(repeating: "let value = 1\n", count: 2_000) + marker).write(
            to: workspaceURL.appendingPathComponent("src/main.swift"),
            atomically: true,
            encoding: .utf8
        )
        let client = UIRecordingModelClient()
        let workbench = WorkbenchModel(
            dependencies: WorkbenchModel.Dependencies(
                storageRootURL: baseURL.appendingPathComponent("file-context-storage"),
                modelClient: client,
                availableModels: [
                    ModelOption(modelID: "test-model", displayName: "Test Model"),
                ]
            )
        )
        await workbench.bootstrap()
        let addedWorkspace = await workbench.addWorkspace(grantedURL: workspaceURL)
        let workspace = try XCTUnwrap(addedWorkspace)
        let createdSession = await workbench.createSession(
            workspaceID: workspace.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )
        let session = try XCTUnwrap(createdSession)
        let loadedController = await workbench.controller(for: session.id)
        let controller = try XCTUnwrap(loadedController)
        let path = try WorkspacePath("src/main.swift")
        controller.registerComposerFileReference(path)
        controller.composerText = "Review @src/main.swift"

        await controller.send()
        for _ in 0..<100 {
            if !client.requests.isEmpty, !controller.session.status.isActive {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }

        let request = try XCTUnwrap(client.requests.first)
        guard case let .user(modelPrompt)? = request.messages.last else {
            return XCTFail("Expected the explicit file context in the model request")
        }
        XCTAssertTrue(modelPrompt.contains("BEGIN EXPLICIT FILE CONTEXT"))
        XCTAssertTrue(modelPrompt.contains("FILE @src/main.swift"))
        XCTAssertTrue(modelPrompt.contains("let value = 1"))
        XCTAssertTrue(modelPrompt.contains("[explicit file context truncated]"))
        XCTAssertFalse(modelPrompt.contains(marker))
        XCTAssertLessThan(modelPrompt.utf8.count, 20 * 1_024)

        let visiblePrompts = controller.events.compactMap { event -> String? in
            guard case let .userPrompt(prompt) = event.payload else { return nil }
            return prompt.text
        }
        XCTAssertEqual(visiblePrompts.last, "Review @src/main.swift")
        XCTAssertFalse(visiblePrompts.last?.contains("BEGIN EXPLICIT FILE CONTEXT") == true)
        XCTAssertTrue(controller.composerFileReferences.isEmpty)
    }

    func testComputerToolsTrackLiveModelVisionCapability() async throws {
        let client = UIRecordingModelClient()
        let textDescriptor = JunoModelDescriptor(
            id: "test-model",
            providerID: "test",
            providerName: "Test",
            displayName: "Text Model",
            capabilities: [.tools]
        )
        let visionDescriptor = JunoModelDescriptor(
            id: "test-model",
            providerID: "test",
            providerName: "Test",
            displayName: "Vision Model",
            capabilities: [.tools, .vision]
        )
        let workbench = WorkbenchModel(
            dependencies: WorkbenchModel.Dependencies(
                storageRootURL: baseURL.appendingPathComponent("vision-storage"),
                modelClient: client,
                availableModels: [ModelOption(catalog: textDescriptor)]
            )
        )
        await workbench.bootstrap()
        let addedWorkspace = await workbench.addWorkspace(grantedURL: workspaceURL)
        let workspace = try XCTUnwrap(addedWorkspace)
        let createdSession = await workbench.createSession(
            workspaceID: workspace.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )
        let session = try XCTUnwrap(createdSession)
        let loadedController = await workbench.controller(for: session.id)
        let controller = try XCTUnwrap(loadedController)

        XCTAssertFalse(controller.currentModelSupportsVision)
        XCTAssertTrue(
            controller.computerUseUnavailableReason?.contains("vision") == true
        )
        controller.composerText = "First turn"
        await controller.send()
        for _ in 0..<100 {
            if client.requests.count >= 1, !controller.session.status.isActive {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(
            try XCTUnwrap(client.requests.first).tools.contains {
                $0.name.hasPrefix("computer_")
            }
        )

        // The signed-in manifest can gain detail after a controller already
        // exists. The next turn must rebuild its tool contract even though the
        // routing model ID did not change.
        await workbench.setAvailableModels([ModelOption(catalog: visionDescriptor)])
        XCTAssertTrue(controller.currentModelSupportsVision)
        XCTAssertNil(controller.computerUseUnavailableReason)
        controller.composerText = "Second turn"
        await controller.send()
        for _ in 0..<100 {
            if client.requests.count >= 2, !controller.session.status.isActive {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(
            try XCTUnwrap(client.requests.last).tools.contains {
                $0.name == "computer_screenshot"
            }
        )

        await controller.setComputerUseEnabled(true)
        XCTAssertTrue(controller.session.configuration.computerUseEnabled)
        // An authoritative empty manifest is a capability revocation, not a
        // loading state. It must not leave the last vision catalog active.
        await workbench.setAvailableModels([])
        XCTAssertFalse(controller.currentModelSupportsVision)
        XCTAssertFalse(controller.session.configuration.computerUseEnabled)
        XCTAssertFalse(controller.computerUseActive)
        XCTAssertTrue(
            controller.transientError?.contains("no longer advertises vision") == true
        )
    }

    func testPausingGoalStopsActiveRunAndBlocksNewTurns() async throws {
        let client = UIHungModelClient()
        let workbench = WorkbenchModel(
            dependencies: WorkbenchModel.Dependencies(
                storageRootURL: baseURL.appendingPathComponent("pause-storage"),
                modelClient: client,
                availableModels: [
                    ModelOption(modelID: "test-model", displayName: "Test Model"),
                ]
            )
        )
        await workbench.bootstrap()
        let addedWorkspace = await workbench.addWorkspace(grantedURL: workspaceURL)
        let workspace = try XCTUnwrap(addedWorkspace)
        let createdSession = await workbench.createSession(
            workspaceID: workspace.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )
        let session = try XCTUnwrap(createdSession)
        _ = try await workbench.sessionStore.createGoal(
            sessionID: session.id,
            objective: "Finish a long task",
            steps: ["Inspect", "Implement", "Verify"]
        )
        let loadedController = await workbench.controller(for: session.id)
        let controller = try XCTUnwrap(loadedController)
        XCTAssertEqual(controller.session.goal?.lifecycle, .active)

        controller.composerText = "Start the long task"
        await controller.send()
        for _ in 0..<100 {
            if client.requestCount == 1, controller.session.status.isActive {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(client.requestCount, 1)
        XCTAssertTrue(controller.session.status.isActive)

        await controller.setGoalLifecycle(.paused)
        XCTAssertEqual(controller.session.goal?.lifecycle, .paused)
        XCTAssertEqual(controller.session.status, .cancelled)

        controller.composerText = "This must remain in the composer"
        await controller.send()
        XCTAssertEqual(client.requestCount, 1)
        XCTAssertEqual(controller.composerText, "This must remain in the composer")
        XCTAssertTrue(controller.transientError?.contains("Resume") == true)
    }

    func testShutdownCancelsAccountBoundRunsBeforeDiscardingWorkbench() async throws {
        let client = UIHungModelClient()
        let workbench = WorkbenchModel(
            dependencies: WorkbenchModel.Dependencies(
                storageRootURL: baseURL.appendingPathComponent("shutdown-storage"),
                modelClient: client,
                availableModels: [
                    ModelOption(modelID: "test-model", displayName: "Test Model"),
                ]
            )
        )
        await workbench.bootstrap()
        let addedWorkspace = await workbench.addWorkspace(grantedURL: workspaceURL)
        let workspace = try XCTUnwrap(addedWorkspace)
        let createdSession = await workbench.createSession(
            workspaceID: workspace.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )
        let session = try XCTUnwrap(createdSession)
        let loadedController = await workbench.controller(for: session.id)
        let controller = try XCTUnwrap(loadedController)
        controller.composerText = "Keep running"
        await controller.send()
        for _ in 0..<100 {
            if client.requestCount == 1, controller.session.status.isActive {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }

        await workbench.shutdown()

        let stored = try await workbench.sessionStore.session(id: session.id)
        XCTAssertEqual(stored.status, .cancelled)
        XCTAssertFalse(controller.session.status.isActive)
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

        let loadedController = await model.controller(for: session.id)
        let controller = try XCTUnwrap(loadedController)
        let checkpoints = try XCTUnwrap(controller.context?.checkpoints)
        let checkpoint = Checkpoint(
            id: "delete-me",
            sessionID: session.id,
            path: try WorkspacePath("src/main.swift"),
            createdAt: Date(),
            preContent: "private source before edit\n",
            postFingerprint: FileFingerprint(of: "let x = 1\n")
        )
        try await checkpoints.record(checkpoint)

        await model.deleteSession(id: session.id)
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertNil(model.selectedSessionID)
        let persistedCheckpoint = await checkpoints.checkpoint(id: checkpoint.id)
        XCTAssertNil(persistedCheckpoint)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: model.dependencies.storageRootURL
                    .appendingPathComponent("checkpoints")
                    .appendingPathComponent(record.id.value)
                    .appendingPathComponent("\(checkpoint.id).json")
                    .path
            )
        )
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

    func testRejectChangeNeverForceOverwritesNewerContentWithoutConfirmation() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        let session = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )!
        let controller = await model.controller(for: session.id)!
        let context = try XCTUnwrap(controller.context)
        let path = try WorkspacePath("src/main.swift")
        let mutation = try await context.files.write(
            path,
            content: "let x = 2\n",
            expectedBase: nil,
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
        for _ in 0..<50 {
            if !controller.changes.isEmpty { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        let newer = "let x = 999 // written after Juno\n"
        try newer.write(
            to: workspaceURL.appendingPathComponent(path.value),
            atomically: true,
            encoding: .utf8
        )

        let restoredWithoutConsent = await controller.rejectChange(path: path.value)
        XCTAssertEqual(restoredWithoutConsent, .diverged(path: path.value))
        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent(path.value),
                encoding: .utf8
            ),
            newer
        )
        XCTAssertEqual(controller.changes.first?.reviewState, .pending)

        let restoredAfterConsent = await controller.rejectChange(
            path: path.value,
            force: true
        )
        XCTAssertEqual(restoredAfterConsent, .restored)
        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent(path.value),
                encoding: .utf8
            ),
            "let x = 1\n"
        )
    }

    func testRejectAllReportsPartialFailuresWithoutForceRetryingThem() async throws {
        let record = await model.addWorkspace(grantedURL: workspaceURL)!
        let session = await model.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model")
        )!
        let controller = await model.controller(for: session.id)!
        let context = try XCTUnwrap(controller.context)
        let validPath = try WorkspacePath("src/main.swift")
        let validMutation = try await context.files.write(
            validPath,
            content: "let x = 2\n",
            expectedBase: nil,
            sessionID: session.id
        )
        try await model.sessionStore.appendEvent(
            sessionID: session.id,
            payload: .fileChanged(
                FileChangedEvent(
                    path: validMutation.path,
                    kind: validMutation.kind,
                    linesAdded: validMutation.diff?.linesAdded ?? 0,
                    linesRemoved: validMutation.diff?.linesRemoved ?? 0,
                    checkpointID: validMutation.checkpointID
                )
            )
        )

        let unavailablePath = try WorkspacePath("src/unrestorable.swift")
        try await model.sessionStore.appendEvent(
            sessionID: session.id,
            payload: .fileChanged(
                FileChangedEvent(
                    path: unavailablePath,
                    kind: .modified,
                    linesAdded: 1,
                    linesRemoved: 0,
                    checkpointID: "missing-checkpoint"
                )
            )
        )
        for _ in 0..<50 {
            if controller.changes.count == 2 { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        let result = await controller.rejectAll()

        XCTAssertEqual(result.restoredPaths, [validPath.value])
        XCTAssertEqual(result.failures.count, 1)
        XCTAssertEqual(result.failures.first?.path, unavailablePath.value)
        guard case let .failed(message)? = result.failures.first?.result else {
            return XCTFail("a missing checkpoint must remain an operational failure")
        }
        XCTAssertTrue(message.contains("unavailable"))
        XCTAssertTrue(result.failureSummary?.contains(unavailablePath.value) == true)
        XCTAssertEqual(controller.transientError, result.failureSummary)
        XCTAssertEqual(
            controller.changes.first(where: { $0.path == validPath.value })?.reviewState,
            .rejected
        )
        XCTAssertEqual(
            controller.changes.first(where: { $0.path == unavailablePath.value })?.reviewState,
            .pending
        )
        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent(validPath.value),
                encoding: .utf8
            ),
            "let x = 1\n"
        )

        let forcedFailure = await controller.rejectChange(
            path: unavailablePath.value,
            force: true
        )
        guard case .failed = forcedFailure else {
            return XCTFail("force must not convert a missing checkpoint into a divergence")
        }
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
