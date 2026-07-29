import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// A deterministic model: each submitted turn pops the next scripted step.
final class ScriptedModelClient: AgentModelClient, @unchecked Sendable {
    enum Step {
        case text(String)
        case toolCalls([(id: String, name: String, input: JSONValue)], text: String)
        case events([ModelStreamEvent])
        case failure(Error)
        case neverFinishes
    }

    private let lock = NSLock()
    private var steps: [Step]
    private(set) var receivedRequests: [ModelTurnRequest] = []

    init(steps: [Step]) {
        self.steps = steps
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        receivedRequests.append(request)
        let step = steps.isEmpty ? Step.text("Done.") : steps.removeFirst()
        lock.unlock()
        return AsyncThrowingStream { continuation in
            switch step {
            case let .text(text):
                continuation.yield(.textDelta(text))
                continuation.yield(.turnCompleted(.endTurn))
                continuation.finish()
            case let .toolCalls(calls, text):
                if !text.isEmpty {
                    continuation.yield(.reasoningSummary("Planning the next steps."))
                    continuation.yield(.textDelta(text))
                }
                for call in calls {
                    continuation.yield(
                        .toolCallRequested(id: call.id, name: call.name, input: call.input)
                    )
                }
                continuation.yield(.turnCompleted(.toolUse))
                continuation.finish()
            case let .events(events):
                for event in events {
                    continuation.yield(event)
                }
                continuation.finish()
            case let .failure(error):
                continuation.finish(throwing: error)
            case .neverFinishes:
                // Simulates a hung transport; only cancellation ends it.
                continuation.onTermination = { _ in }
            }
        }
    }
}

private struct EphemeralImageTool: CodeTool {
    let name = "capture_test_image"
    let description = "Capture a deterministic test image."
    let inputSchema: JSONValue = [
        "type": "object",
        "properties": [:],
        "additionalProperties": false,
    ]

    func assessRisk(input: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Capture test image" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        ToolResult(
            content: "Screenshot captured.",
            images: [
                ModelImage(
                    mediaType: "image/jpeg",
                    data: Data([0xDE, 0xAD, 0xBE, 0xEF]),
                    detail: .high
                ),
            ]
        )
    }
}

final class AgentOrchestratorTests: XCTestCase {
    private var workspaceURL: URL!
    private var storeURL: URL!
    private var store: CodeSessionStore!
    private var registry: ToolRegistry!
    private var session: CodeSession!

    override func setUp() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-orch-\(UUID().uuidString)")
        workspaceURL = base.appendingPathComponent("workspace")
        storeURL = base.appendingPathComponent("store")
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("src"),
            withIntermediateDirectories: true
        )
        try "let value = 1\n".write(
            to: workspaceURL.appendingPathComponent("src/main.swift"),
            atomically: true,
            encoding: .utf8
        )
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        let checkpoints = CheckpointStore(
            directoryURL: base.appendingPathComponent("checkpoints"),
            access: access
        )
        let executor = CommandExecutionService(workspaceRootURL: workspaceURL)
        registry = ToolRegistry.standard(
            files: FileOperationService(access: access, checkpoints: checkpoints),
            index: WorkspaceIndexService(access: access),
            executor: executor,
            git: GitService(executor: executor),
            tests: TestRunnerService(access: access, executor: executor)
        )
        store = CodeSessionStore(directoryURL: storeURL)
        session = try await store.createSession(
            workspaceID: access.workspaceID,
            workspaceName: "Demo",
            title: "Test session",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(
            at: workspaceURL.deletingLastPathComponent()
        )
    }

    private func makeOrchestrator(
        model: ScriptedModelClient,
        mode: PermissionMode = .fullAccess
    ) -> (AgentOrchestrator, PermissionCoordinator) {
        let permissions = PermissionCoordinator(sessionID: session.id, mode: mode)
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: registry,
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "You are Juno Code."),
            modelID: "test-model",
            reasoningEffort: .medium
        )
        return (orchestrator, permissions)
    }

    private func payloads() async -> [SessionEventPayload] {
        await store.events(for: session.id).map(\.payload)
    }

    func testVerticalSliceReadPatchTestComplete() async throws {
        let model = ScriptedModelClient(steps: [
            .toolCalls(
                [("c1", "read_file", ["path": "src/main.swift"])],
                text: "Let me read the file first."
            ),
            .toolCalls(
                [(
                    "c2",
                    "apply_patch",
                    [
                        "path": "src/main.swift",
                        "target": "let value = 1",
                        "replacement": "let value = 2",
                    ]
                )],
                text: ""
            ),
            .toolCalls([("c3", "run_command", ["command": "echo checks-pass"])], text: ""),
            .text("I bumped the value and verified the change."),
        ])
        let (orchestrator, _) = makeOrchestrator(model: model)
        try await orchestrator.submit(prompt: "Change value to 2")
        await orchestrator.awaitCompletion()

        // The file actually changed.
        let content = try String(
            contentsOf: workspaceURL.appendingPathComponent("src/main.swift"),
            encoding: .utf8
        )
        XCTAssertEqual(content, "let value = 2\n")

        // Session ended completed with a final summary event.
        let finalSession = try await store.session(id: session.id)
        XCTAssertEqual(finalSession.status, .completed)

        let events = await payloads()
        // Transcript order sanity: prompt, tool proposals/starts/completions,
        // file change, final assistant message, runCompleted.
        func count(_ predicate: (SessionEventPayload) -> Bool) -> Int {
            events.filter(predicate).count
        }
        XCTAssertEqual(count { if case .userPrompt = $0 { return true }; return false }, 1)
        XCTAssertEqual(count { if case .toolProposed = $0 { return true }; return false }, 3)
        XCTAssertEqual(count { if case .toolStarted = $0 { return true }; return false }, 3)
        XCTAssertEqual(count { if case .toolCompleted = $0 { return true }; return false }, 3)
        XCTAssertEqual(count { if case .fileChanged = $0 { return true }; return false }, 1)
        XCTAssertEqual(count { if case .runCompleted = $0 { return true }; return false }, 1)

        guard case let .fileChanged(change)? = events.first(where: {
            if case .fileChanged = $0 { return true }
            return false
        }) else {
            return XCTFail("missing fileChanged")
        }
        XCTAssertEqual(change.path.value, "src/main.swift")
        XCTAssertNotNil(change.checkpointID)

        guard case let .runCompleted(completed)? = events.last(where: {
            if case .runCompleted = $0 { return true }
            return false
        }) else {
            return XCTFail("missing runCompleted")
        }
        XCTAssertEqual(completed.filesChanged, 1)

        // Command output was streamed into the transcript.
        XCTAssertTrue(events.contains {
            if case let .toolOutput(output) = $0 {
                return output.text.contains("checks-pass")
            }
            return false
        })
    }

    func testApprovalFlowSuspendsAndResumesLoop() async throws {
        let model = ScriptedModelClient(steps: [
            .toolCalls(
                [(
                    "c1",
                    "write_file",
                    ["path": "src/new.swift", "content": "// new\n"]
                )],
                text: ""
            ),
            .text("Created the file."),
        ])
        let (orchestrator, permissions) = makeOrchestrator(model: model, mode: .askBeforeChanges)
        let requested = expectation(description: "approval requested")
        nonisolated(unsafe) var approvalID: String?
        await permissions.addObserver { update in
            if case let .requested(request) = update {
                approvalID = request.id
                requested.fulfill()
            }
        }
        try await orchestrator.submit(prompt: "Create a file")
        await fulfillment(of: [requested], timeout: 5)

        // Suspended: the file must not exist and the session is waiting.
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("src/new.swift").path
            )
        )
        try await Task.sleep(nanoseconds: 200_000_000)
        let waiting = try await store.session(id: session.id)
        XCTAssertEqual(waiting.status, .waitingForApproval)
        XCTAssertTrue(waiting.hasPendingApproval)

        await permissions.resolve(approvalID: approvalID!, decision: .approved)
        await orchestrator.awaitCompletion()

        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("src/new.swift").path
            )
        )
        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed)
        XCTAssertFalse(final.hasPendingApproval)

        let events = await payloads()
        XCTAssertTrue(events.contains {
            if case .approvalRequested = $0 { return true }
            return false
        })
        XCTAssertTrue(events.contains {
            if case let .approvalResolved(resolved) = $0 {
                return resolved.decision == .approved
            }
            return false
        })
    }

    func testDenialContinuesLoopWithoutExecuting() async throws {
        let model = ScriptedModelClient(steps: [
            .toolCalls(
                [("c1", "delete_file", ["path": "src/main.swift"])],
                text: ""
            ),
            .text("Understood, I left the file alone."),
        ])
        let (orchestrator, permissions) = makeOrchestrator(model: model, mode: .fullAccess)
        let requested = expectation(description: "approval requested")
        nonisolated(unsafe) var approvalID: String?
        await permissions.addObserver { update in
            if case let .requested(request) = update {
                approvalID = request.id
                requested.fulfill()
            }
        }
        try await orchestrator.submit(prompt: "Delete main.swift")
        await fulfillment(of: [requested], timeout: 5)
        await permissions.resolve(approvalID: approvalID!, decision: .denied)
        await orchestrator.awaitCompletion()

        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("src/main.swift").path
            ),
            "denied deletion must not run"
        )
        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed, "the loop must continue after a denial")

        // The model received the denial as a tool result.
        let conversation = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(conversation.contains {
            if case let .toolResult(_, content, isError) = $0 {
                return isError && content.contains("not permitted")
            }
            return false
        })
    }

    func testStopCancelsPromptlyEvenWithHungModel() async throws {
        let model = ScriptedModelClient(steps: [.neverFinishes])
        let (orchestrator, _) = makeOrchestrator(model: model)
        try await orchestrator.submit(prompt: "Hang forever")
        try await Task.sleep(nanoseconds: 300_000_000)
        await orchestrator.stop()
        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .cancelled)
    }

    func testStopDuringPendingApprovalDeniesAndCancels() async throws {
        let model = ScriptedModelClient(steps: [
            .toolCalls(
                [("c1", "write_file", ["path": "src/x.swift", "content": "x"])],
                text: ""
            ),
            .text("done"),
        ])
        let (orchestrator, permissions) = makeOrchestrator(model: model, mode: .askBeforeChanges)
        let requested = expectation(description: "approval requested")
        await permissions.addObserver { update in
            if case .requested = update { requested.fulfill() }
        }
        try await orchestrator.submit(prompt: "Write a file")
        await fulfillment(of: [requested], timeout: 5)
        await orchestrator.stop()
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("src/x.swift").path
            )
        )
        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .cancelled)
    }

    func testModelGoalPauseStopsLaterToolCallsInTheSameTurn() async throws {
        _ = try await store.createGoal(
            sessionID: session.id,
            objective: "Pause safely",
            steps: ["Wait for direction"]
        )
        let model = ScriptedModelClient(steps: [
            .toolCalls(
                [
                    (
                        "pause",
                        "update_goal",
                        ["action": "set_lifecycle", "lifecycle": "paused"]
                    ),
                    (
                        "write-after-pause",
                        "write_file",
                        ["path": "src/after.swift", "content": "// must not exist\n"]
                    ),
                ],
                text: ""
            ),
        ])
        let permissions = PermissionCoordinator(
            sessionID: session.id,
            mode: .fullAccess
        )
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(
                tools: registry.allTools + [UpdateGoalTool(store: store)]
            ),
            permissions: permissions,
            store: store,
            configuration: .init(systemPrompt: "sys"),
            modelID: "test-model",
            reasoningEffort: .medium
        )

        try await orchestrator.submit(prompt: "Pause before writing")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.goal?.lifecycle, .paused)
        XCTAssertEqual(final.status, .cancelled)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("src/after.swift").path
            )
        )
        XCTAssertEqual(model.receivedRequests.count, 1)
    }

    func testModelFailureRetriesOnceThenFails() async throws {
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.transport(message: "boom")),
            .failure(AgentModelClientError.transport(message: "boom again")),
        ])
        let (orchestrator, _) = makeOrchestrator(model: model)
        try await orchestrator.submit(prompt: "Fail twice")
        await orchestrator.awaitCompletion()
        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .failed)
        let events = await payloads()
        let errors = events.filter {
            if case .errorOccurred = $0 { return true }
            return false
        }
        XCTAssertEqual(errors.count, 2)
    }

    func testTransientFailureRecovers() async throws {
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.transport(message: "hiccup")),
            .text("Recovered fine."),
        ])
        let (orchestrator, _) = makeOrchestrator(model: model)
        try await orchestrator.submit(prompt: "Recover")
        await orchestrator.awaitCompletion()
        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed)
    }

    func testSubmittedPromptIsDurableBeforeModelFinishes() async throws {
        let model = ScriptedModelClient(steps: [.neverFinishes])
        let (orchestrator, _) = makeOrchestrator(model: model)

        try await orchestrator.submit(prompt: "Keep this prompt")

        let persisted = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(persisted.contains {
            if case .user("Keep this prompt") = $0 { return true }
            return false
        })

        await orchestrator.stop()
    }

    func testModelOnlyPromptContextDoesNotPolluteVisibleTranscript() async throws {
        let model = ScriptedModelClient(steps: [.text("Reviewed.")])
        let (orchestrator, _) = makeOrchestrator(model: model)
        let visible = "Review @src/main.swift"
        let enriched = """
        \(visible)

        BEGIN EXPLICIT FILE CONTEXT
        FILE @src/main.swift
        let value = 1
        END FILE @src/main.swift
        END EXPLICIT FILE CONTEXT
        """

        try await orchestrator.submit(prompt: visible, modelPrompt: enriched)
        await orchestrator.awaitCompletion()

        let promptEvents = await payloads().compactMap { payload -> String? in
            guard case let .userPrompt(event) = payload else { return nil }
            return event.text
        }
        XCTAssertEqual(promptEvents.last, visible)
        guard case let .user(modelPrompt)? = model.receivedRequests.first?.messages.last else {
            return XCTFail("Expected a model-only user prompt")
        }
        XCTAssertEqual(modelPrompt, enriched)
        XCTAssertTrue(modelPrompt.contains("let value = 1"))
    }

    func testTerminalFailureRedactsScreenshotBeforeNextRun() async throws {
        let model = ScriptedModelClient(steps: [
            .toolCalls([("screen-1", "capture_test_image", [:])], text: ""),
            .failure(AgentModelClientError.transport(message: "offline")),
            .failure(AgentModelClientError.transport(message: "still offline")),
            .text("Recovered."),
        ])
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: [EphemeralImageTool()]),
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "sys"),
            modelID: "vision-model",
            reasoningEffort: .medium
        )

        try await orchestrator.submit(prompt: "Inspect the screen")
        await orchestrator.awaitCompletion()
        let failedSession = try await store.session(id: session.id)
        XCTAssertEqual(failedSession.status, .failed)

        try await orchestrator.submit(prompt: "Try again")
        await orchestrator.awaitCompletion()

        let followUp = try XCTUnwrap(model.receivedRequests.last)
        XCTAssertFalse(followUp.messages.contains {
            if case .toolResultWithImages = $0 { return true }
            return false
        })
        XCTAssertTrue(followUp.messages.contains {
            guard case let .toolResult(id, content, isError) = $0 else { return false }
            return id == "screen-1"
                && !isError
                && content.contains("Ephemeral image omitted")
        })
    }

    func testMaximumTokenStopIsRecoverableFailure() async throws {
        let model = ScriptedModelClient(steps: [
            .events([
                .textDelta("I started but"),
                .turnCompleted(.maxTokens),
            ]),
        ])
        let (orchestrator, _) = makeOrchestrator(model: model)

        try await orchestrator.submit(prompt: "Do a long task")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .failed)
        let events = await payloads()
        XCTAssertTrue(events.contains {
            guard case let .errorOccurred(event) = $0 else { return false }
            return event.isRecoverable && event.message.contains("output limit")
        })
    }

    func testReasoningDeltasBecomeOneTranscriptSummary() async throws {
        let model = ScriptedModelClient(steps: [
            .events([
                .reasoningSummary("Inspect "),
                .reasoningSummary("the files."),
                .textDelta("Done."),
                .turnCompleted(.endTurn),
            ]),
        ])
        let (orchestrator, _) = makeOrchestrator(model: model)

        try await orchestrator.submit(prompt: "Inspect")
        await orchestrator.awaitCompletion()

        let summaries = await payloads().compactMap { payload -> String? in
            guard case let .reasoningSummary(event) = payload else { return nil }
            return event.summary
        }
        XCTAssertEqual(summaries, ["Inspect the files."])
    }

    func testMissingCompletionReasonFailsInsteadOfCompleting() async throws {
        let model = ScriptedModelClient(steps: [
            .events([.textDelta("Partial response")]),
        ])
        let (orchestrator, _) = makeOrchestrator(model: model)

        try await orchestrator.submit(prompt: "Answer")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .failed)
    }

    func testIterationLimitStopsRunawayLoops() async throws {
        var steps: [ScriptedModelClient.Step] = []
        for index in 0..<50 {
            steps.append(
                .toolCalls([("c\(index)", "git_status", [:])], text: "")
            )
        }
        let model = ScriptedModelClient(steps: steps)
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: registry,
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(
                maximumIterations: 3,
                systemPrompt: "sys"
            ),
            modelID: "test-model",
            reasoningEffort: .low
        )
        try await orchestrator.submit(prompt: "Loop forever")
        await orchestrator.awaitCompletion()
        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .failed)
        XCTAssertLessThanOrEqual(model.receivedRequests.count, 3)
    }

    func testSubmitWhileRunningThrows() async throws {
        let model = ScriptedModelClient(steps: [.neverFinishes])
        let (orchestrator, _) = makeOrchestrator(model: model)
        try await orchestrator.submit(prompt: "First")
        do {
            try await orchestrator.submit(prompt: "Second")
            XCTFail("expected rejection")
        } catch let error as OrchestratorError {
            XCTAssertEqual(error, .sessionAlreadyRunning)
        }
        await orchestrator.stop()
    }

    func testSessionRestoreAfterRelaunch() async throws {
        let model = ScriptedModelClient(steps: [
            .toolCalls([("c1", "read_file", ["path": "src/main.swift"])], text: ""),
            .text("All done."),
        ])
        let (orchestrator, _) = makeOrchestrator(model: model)
        try await orchestrator.submit(prompt: "Read the file")
        await orchestrator.awaitCompletion()

        // Simulate an app relaunch: a fresh store over the same directory.
        let reloaded = CodeSessionStore(directoryURL: storeURL)
        let sessions = await reloaded.allSessions()
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions.first?.id, session.id)
        XCTAssertEqual(sessions.first?.status, .completed)

        let events = await reloaded.events(for: session.id)
        XCTAssertFalse(events.isEmpty)
        XCTAssertEqual(events.map(\.sequence), Array(0..<events.count))

        let conversation = await reloaded.loadConversation(sessionID: session.id)
        XCTAssertTrue(conversation.contains {
            if case .user("Read the file") = $0 { return true }
            return false
        })

        // A new run on the restored session continues the transcript.
        let model2 = ScriptedModelClient(steps: [.text("Follow-up answered.")])
        let permissions2 = PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let orchestrator2 = AgentOrchestrator(
            sessionID: session.id,
            model: model2,
            registry: registry,
            permissions: permissions2,
            store: reloaded,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "sys"),
            modelID: "test-model",
            reasoningEffort: .medium
        )
        try await orchestrator2.submit(prompt: "Follow up")
        await orchestrator2.awaitCompletion()
        // The resumed conversation retains the earlier exchange.
        let request = model2.receivedRequests.first
        XCTAssertNotNil(request)
        XCTAssertTrue(request!.messages.contains {
            if case .user("Read the file") = $0 { return true }
            return false
        })
    }

    func testInterruptedSessionMarkedFailedOnRestore() async throws {
        _ = try await store.updateSession(id: session.id) { session in
            session.status = .waitingForApproval
            session.hasPendingApproval = true
        }
        let eventCountBeforeRestore = await store.events(for: session.id).count

        let reloaded = CodeSessionStore(directoryURL: storeURL)
        let restored = await reloaded.allSessions().first
        XCTAssertEqual(restored?.status, .failed)
        XCTAssertEqual(restored?.hasPendingApproval, false)
        XCTAssertEqual(restored?.lastErrorSummary, "Interrupted by app termination.")

        let repairedEvents = await reloaded.events(for: session.id)
        XCTAssertEqual(repairedEvents.count, eventCountBeforeRestore + 2)
        XCTAssertEqual(repairedEvents.map(\.sequence), Array(0..<repairedEvents.count))
        guard repairedEvents.count >= 2 else {
            return XCTFail("Expected interruption status and error events")
        }
        if case let .statusChanged(event) = repairedEvents[repairedEvents.count - 2].payload {
            XCTAssertEqual(event.status, .failed)
        } else {
            XCTFail("Expected failed status event")
        }
        if case let .errorOccurred(event) = repairedEvents.last?.payload {
            XCTAssertEqual(event.message, "Interrupted by app termination.")
            XCTAssertTrue(event.isRecoverable)
        } else {
            XCTFail("Expected recoverable interruption error event")
        }

        // A second process load proves the repair reached disk and is
        // idempotent: it remains failed and does not append duplicate events.
        let reloadedAgain = CodeSessionStore(directoryURL: storeURL)
        let restoredAgain = await reloadedAgain.allSessions().first
        XCTAssertEqual(restoredAgain?.status, .failed)
        XCTAssertEqual(restoredAgain?.hasPendingApproval, false)
        XCTAssertEqual(restoredAgain?.lastErrorSummary, "Interrupted by app termination.")
        let eventsAfterSecondReload = await reloadedAgain.events(for: session.id)
        XCTAssertEqual(eventsAfterSecondReload, repairedEvents)
    }
}
