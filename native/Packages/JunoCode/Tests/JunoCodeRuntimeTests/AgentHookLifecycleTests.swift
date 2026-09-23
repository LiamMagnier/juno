import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// Keeps a hook "running" until it is released, or until its task is
/// cancelled — the way Stop kills a hook's process, which then answers as a
/// non-blocking failure.
private actor HookGate {
    private var held = false
    private var released = false

    func hold() async {
        held = true
        while !released, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    func waitUntilHeld() async {
        while !held {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    func release() {
        released = true
    }
}

/// Hooks that answer from a script and remember what they were asked.
private actor ScriptedHooks: AgentLifecycleHooks {
    var startResponse = AgentHookResponse.empty
    var promptResponse = AgentHookResponse.empty
    var beforeResponse = AgentHookResponse.empty
    var afterResponse = AgentHookResponse.empty
    /// Answers for successive stop attempts; the last one repeats.
    var stopResponses: [AgentHookResponse] = [.empty]
    /// Hold the hooks of one event until released or cancelled.
    var startGate: HookGate?
    var promptGate: HookGate?
    var beforeGate: HookGate?
    /// Something a prompt hook does while it runs, such as ask for approval.
    var promptAction: (@Sendable () async -> Void)?

    private(set) var starts: [AgentSessionStartSource] = []
    private(set) var prompts: [String] = []
    private(set) var stopHookActiveValues: [Bool] = []
    private(set) var notifications: [AgentHookNotificationKind] = []
    private(set) var beforeCalls: [String] = []

    func set(
        start: AgentHookResponse? = nil,
        prompt: AgentHookResponse? = nil,
        before: AgentHookResponse? = nil,
        after: AgentHookResponse? = nil,
        stops: [AgentHookResponse]? = nil
    ) {
        if let start { startResponse = start }
        if let prompt { promptResponse = prompt }
        if let before { beforeResponse = before }
        if let after { afterResponse = after }
        if let stops { stopResponses = stops }
    }

    func gate(start: HookGate? = nil, prompt: HookGate? = nil, before: HookGate? = nil) {
        startGate = start
        promptGate = prompt
        beforeGate = before
    }

    func setPromptAction(_ action: @escaping @Sendable () async -> Void) {
        promptAction = action
    }

    func sessionStarted(
        sessionID _: CodeSessionID,
        source: AgentSessionStartSource
    ) async -> AgentHookResponse {
        starts.append(source)
        await startGate?.hold()
        return startResponse
    }

    func promptSubmitted(sessionID _: CodeSessionID, prompt: String) async -> AgentHookResponse {
        prompts.append(prompt)
        await promptAction?()
        await promptGate?.hold()
        return promptResponse
    }

    func beforeTool(_ invocation: AgentToolHookInvocation) async -> AgentHookResponse {
        beforeCalls.append(invocation.toolName)
        await beforeGate?.hold()
        return beforeResponse
    }

    func afterTool(
        _: AgentToolHookInvocation,
        succeeded _: Bool,
        content _: String
    ) async -> AgentHookResponse {
        afterResponse
    }

    func agentStopping(
        sessionID _: CodeSessionID,
        stopHookActive: Bool,
        lastMessage _: String
    ) async -> AgentHookResponse {
        stopHookActiveValues.append(stopHookActive)
        let index = min(stopHookActiveValues.count - 1, stopResponses.count - 1)
        return stopResponses[index]
    }

    func notify(
        sessionID _: CodeSessionID,
        kind: AgentHookNotificationKind,
        message _: String
    ) async -> AgentHookResponse {
        notifications.append(kind)
        return .empty
    }
}

final class AgentHookLifecycleTests: XCTestCase {
    private var workspaceURL: URL!
    private var store: CodeSessionStore!
    private var registry: ToolRegistry!
    private var session: CodeSession!

    override func setUp() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-hooks-\(UUID().uuidString)")
        workspaceURL = base.appendingPathComponent("workspace")
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
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: access.workspaceID,
            workspaceName: "Demo",
            title: "Hooks",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: workspaceURL.deletingLastPathComponent())
    }

    private func orchestrator(
        _ model: ScriptedModelClient,
        hooks: ScriptedHooks,
        mode: PermissionMode = .fullAccess
    ) -> (AgentOrchestrator, PermissionCoordinator) {
        let permissions = PermissionCoordinator(sessionID: session.id, mode: mode)
        return (
            AgentOrchestrator(
                sessionID: session.id,
                model: model,
                registry: registry,
                permissions: permissions,
                store: store,
                configuration: AgentOrchestrator.Configuration(systemPrompt: "You are Juno Code."),
                modelID: "test-model",
                reasoningEffort: .medium,
                lifecycleHooks: hooks
            ),
            permissions
        )
    }

    private func payloads() async -> [SessionEventPayload] {
        await store.events(for: session.id).map(\.payload)
    }

    private func hookEvents() async -> [HookActivityEvent] {
        await payloads().compactMap {
            if case let .hookActivity(activity) = $0 { return activity }
            return nil
        }
    }

    private func notice(_ event: String, _ outcome: HookActivityEvent.Outcome, _ message: String) -> HookActivityEvent {
        HookActivityEvent(hookEvent: event, hookName: "guard.sh", outcome: outcome, message: message)
    }

    // MARK: - UserPromptSubmit and SessionStart

    func testABlockedPromptIsNeverSentOrRecordedAsATurn() async throws {
        let hooks = ScriptedHooks()
        await hooks.set(prompt: AgentHookResponse(
            blockReason: "Name the ticket this is for.",
            notices: [notice("UserPromptSubmit", .blocked, "Name the ticket this is for.")]
        ))
        let model = ScriptedModelClient(steps: [.text("Should never be asked.")])
        let (runtime, _) = orchestrator(model, hooks: hooks)

        do {
            try await runtime.submit(prompt: "Refactor everything")
            XCTFail("a blocked prompt must throw")
        } catch let OrchestratorError.promptBlocked(reason) {
            XCTAssertEqual(reason, "Name the ticket this is for.")
        }

        XCTAssertTrue(model.receivedRequests.isEmpty, "the model must never see a blocked prompt")
        let events = await payloads()
        XCTAssertFalse(events.contains { if case .userPrompt = $0 { return true }; return false })
        let recorded = await hookEvents().map(\.outcome)
        XCTAssertEqual(recorded, [.blocked])
        let stored = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(stored.isEmpty)
        let status = try await store.session(id: session.id).status
        XCTAssertNotEqual(status, .running)
        let isRunning = await runtime.isRunning
        XCTAssertFalse(isRunning)
    }

    func testStartAndPromptContextTravelWithThePromptButNotIntoTheTranscript() async throws {
        let hooks = ScriptedHooks()
        await hooks.set(
            start: AgentHookResponse(context: ["Branch: main"]),
            prompt: AgentHookResponse(context: ["Ticket JUNO-12 is open."])
        )
        let model = ScriptedModelClient(steps: [.text("First."), .text("Second.")])
        let (runtime, _) = orchestrator(model, hooks: hooks)

        try await runtime.submit(prompt: "Tidy the tokens")
        await runtime.awaitCompletion()
        try await runtime.submit(prompt: "And the spacing")
        await runtime.awaitCompletion()

        let firstRequest = try XCTUnwrap(model.receivedRequests.first)
        guard case let .user(text)? = firstRequest.messages.last else {
            return XCTFail("expected the prompt last")
        }
        XCTAssertTrue(text.hasPrefix("Tidy the tokens"))
        XCTAssertTrue(text.contains("<hook_context>"))
        XCTAssertTrue(text.contains("Branch: main"))
        XCTAssertTrue(text.contains("Ticket JUNO-12 is open."))

        // The reader's own words are what the transcript keeps.
        let prompts = await payloads().compactMap { payload -> String? in
            if case let .userPrompt(prompt) = payload { return prompt.text }
            return nil
        }
        XCTAssertEqual(prompts, ["Tidy the tokens", "And the spacing"])

        // SessionStart once; UserPromptSubmit every time.
        let starts = await hooks.starts
        let seen = await hooks.prompts
        XCTAssertEqual(starts, [.startup])
        XCTAssertEqual(seen, ["Tidy the tokens", "And the spacing"])
        guard case let .user(second)? = model.receivedRequests.last?.messages.last else {
            return XCTFail("expected the second prompt last")
        }
        XCTAssertFalse(second.contains("Branch: main"), "session context arrives once")
    }

    // MARK: - A prompt whose hooks are still running

    func testASecondSubmitWhileThePromptsHooksRunIsRefused() async throws {
        let hooks = ScriptedHooks()
        let gate = HookGate()
        await hooks.gate(start: gate)
        let model = ScriptedModelClient(steps: [.text("Done.")])
        let (runtime, _) = orchestrator(model, hooks: hooks)

        let first = Task { try await runtime.submit(prompt: "First") }
        await gate.waitUntilHeld()
        let taken = await runtime.isRunning
        XCTAssertTrue(taken, "the session is taken while the prompt's hooks decide")
        do {
            try await runtime.submit(prompt: "Second")
            XCTFail("a second prompt must not start a second run")
        } catch OrchestratorError.sessionAlreadyRunning {}

        await gate.release()
        try await first.value
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 1, "one run, one conversation")
        let prompts = await payloads().compactMap { payload -> String? in
            if case let .userPrompt(prompt) = payload { return prompt.text }
            return nil
        }
        XCTAssertEqual(prompts, ["First"])
        let vetted = await hooks.prompts
        XCTAssertEqual(vetted, ["First"])
    }

    func testStopWhileThePromptsHooksRunSendsNothingAndKeepsTheSessionsContext() async throws {
        let hooks = ScriptedHooks()
        let gate = HookGate()
        await hooks.set(start: AgentHookResponse(context: ["Branch: main"]))
        await hooks.gate(prompt: gate)
        let model = ScriptedModelClient(steps: [.text("Done.")])
        let (runtime, _) = orchestrator(model, hooks: hooks)

        let first = Task { try await runtime.submit(prompt: "First") }
        await gate.waitUntilHeld()
        await runtime.stop()
        do {
            try await first.value
            XCTFail("a prompt stopped before it was sent must say so")
        } catch OrchestratorError.stoppedBeforeSending {}

        let running = await runtime.isRunning
        XCTAssertFalse(running)
        XCTAssertTrue(model.receivedRequests.isEmpty, "nothing reached the model")
        let events = await payloads()
        XCTAssertFalse(events.contains { if case .userPrompt = $0 { return true }; return false })
        let notices = await hookEvents()
        XCTAssertTrue(notices.isEmpty, "a hook killed by Stop is not a failure worth a row")

        // The session did start; what its start hooks said goes with the next
        // prompt that is sent.
        await hooks.gate()
        try await runtime.submit(prompt: "Again")
        await runtime.awaitCompletion()
        guard case let .user(text)? = model.receivedRequests.first?.messages.last else {
            return XCTFail("expected the prompt last")
        }
        XCTAssertTrue(text.hasPrefix("Again"))
        XCTAssertTrue(text.contains("Branch: main"))
    }

    func testASteerWhoseRunEndsWhileItsHooksRunIsNotRecorded() async throws {
        let hooks = ScriptedHooks()
        let turn = ScriptedModelGate()
        let model = ScriptedModelClient(steps: [
            .gatedEvents([.textDelta("Done."), .turnCompleted(.endTurn)], gate: turn),
        ])
        let (runtime, _) = orchestrator(model, hooks: hooks)
        try await runtime.submit(prompt: "Start")
        await turn.waitUntilArrived()

        let vetting = HookGate()
        await hooks.gate(prompt: vetting)
        let steer = Task { try await runtime.steer(prompt: "Also fix the tests") }
        await vetting.waitUntilHeld()
        // The run finishes while the steer's hook is still deciding.
        await turn.release()
        await runtime.awaitCompletion()
        await vetting.release()

        do {
            _ = try await steer.value
            XCTFail("a steer for a finished run must not be reported as delivered")
        } catch OrchestratorError.sessionNotRunning {}
        let events = await payloads()
        XCTAssertFalse(
            events.contains { if case .userInstruction = $0 { return true }; return false },
            "an instruction no run will apply is not recorded"
        )
    }

    func testABlockedPromptWhoseHookWaitedForApprovalLeavesTheSessionAsItWas() async throws {
        let hooks = ScriptedHooks()
        let (runtime, permissions) = orchestrator(
            ScriptedModelClient(steps: []),
            hooks: hooks,
            mode: .askBeforeChanges
        )
        await permissions.addObserver { update in
            if case let .requested(request) = update {
                Task { await permissions.resolve(approvalID: request.id, decision: .approved) }
            }
        }
        let store = self.store!
        let sessionID = session.id
        await hooks.setPromptAction {
            // A repository hook asks before it runs in this mode. The session
            // shows it waiting, then running, while no run exists yet.
            _ = await permissions.authorize(
                toolName: "hook",
                actionDigest: "vet",
                risk: .execute,
                summary: "echo vet"
            )
            for _ in 0..<200 {
                if (try? await store.session(id: sessionID).status) == .running { return }
                try? await Task.sleep(for: .milliseconds(10))
            }
        }
        await hooks.set(prompt: AgentHookResponse(blockReason: "Name the ticket."))

        do {
            try await runtime.submit(prompt: "Go")
            XCTFail("the prompt is blocked")
        } catch OrchestratorError.promptBlocked {}

        let status = try await store.session(id: session.id).status
        XCTAssertFalse(status.isActive, "no run follows a blocked prompt, so none may be shown")
    }

    // MARK: - Stop

    func testAStopHookKeepsTheAgentWorkingAndIsToldWhenItAlreadyHas() async throws {
        let hooks = ScriptedHooks()
        await hooks.set(stops: [
            AgentHookResponse(
                blockReason: "Run the tests before you finish.",
                notices: [notice("Stop", .continued, "Run the tests before you finish.")]
            ),
            .empty,
        ])
        let model = ScriptedModelClient(steps: [.text("Done."), .text("Tests pass. Done.")])
        let (runtime, _) = orchestrator(model, hooks: hooks)

        try await runtime.submit(prompt: "Fix the bug")
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 2)
        guard case let .user(feedback)? = model.receivedRequests.last?.messages.last else {
            return XCTFail("expected the stop feedback as the next instruction")
        }
        XCTAssertEqual(feedback, "Stop hook feedback:\nRun the tests before you finish.")
        let active = await hooks.stopHookActiveValues
        XCTAssertEqual(active, [false, true])
        let recorded = await hookEvents().map(\.outcome)
        XCTAssertEqual(recorded, [.continued])
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
    }

    func testAStopHookThatNeverLetsGoIsBounded() async throws {
        let hooks = ScriptedHooks()
        await hooks.set(stops: [AgentHookResponse(blockReason: "Keep going.")])
        let model = ScriptedModelClient(steps: [])
        let (runtime, _) = orchestrator(model, hooks: hooks)

        try await runtime.submit(prompt: "Loop")
        await runtime.awaitCompletion()

        XCTAssertEqual(
            model.receivedRequests.count,
            AgentOrchestrator.maximumStopHookContinuations + 1
        )
        let recorded = await hookEvents()
        let last = try XCTUnwrap(recorded.last)
        XCTAssertEqual(last.outcome, .stopped)
        XCTAssertTrue(last.hookName.isEmpty, "the runtime, not a hook, is speaking")
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
    }

    func testContinueFalseFromAStopHookEndsTheRunEvenWithABlock() async throws {
        let hooks = ScriptedHooks()
        await hooks.set(stops: [AgentHookResponse(blockReason: "More.", haltReason: "Freeze")])
        let model = ScriptedModelClient(steps: [.text("Done.")])
        let (runtime, _) = orchestrator(model, hooks: hooks)

        try await runtime.submit(prompt: "Go")
        await runtime.awaitCompletion()
        XCTAssertEqual(model.receivedRequests.count, 1)
    }

    // MARK: - Tool hooks

    func testPreToolUseBlockReturnsTheReasonToTheModelAndTheToolNeverRuns() async throws {
        let hooks = ScriptedHooks()
        await hooks.set(before: AgentHookResponse(
            blockReason: "Edits under src/ need a ticket.",
            notices: [notice("PreToolUse", .blocked, "Edits under src/ need a ticket.")]
        ))
        let model = ScriptedModelClient(steps: [
            .toolCalls([("w1", "write_file", ["path": "src/main.swift", "content": "x\n"])], text: ""),
            .text("Understood."),
        ])
        let (runtime, _) = orchestrator(model, hooks: hooks)

        try await runtime.submit(prompt: "Rewrite main")
        await runtime.awaitCompletion()

        let content = try String(contentsOf: workspaceURL.appendingPathComponent("src/main.swift"), encoding: .utf8)
        XCTAssertEqual(content, "let value = 1\n")
        guard case let .toolResult(_, text, isError)? = model.receivedRequests.last?.messages.last else {
            return XCTFail("expected the tool result")
        }
        XCTAssertTrue(isError)
        XCTAssertEqual(text, "Action blocked by hook: Edits under src/ need a ticket.")

        // Recorded where it happened: after the proposal, before the denial.
        let events = await payloads()
        let hookIndex = try XCTUnwrap(events.firstIndex { if case .hookActivity = $0 { return true }; return false })
        let completedIndex = try XCTUnwrap(events.firstIndex { if case .toolCompleted = $0 { return true }; return false })
        XCTAssertLessThan(hookIndex, completedIndex)
    }

    func testStopDuringAPreToolUseHookNeitherAsksNorRunsTheTool() async throws {
        // In a mode that asks, the call used to go on to a new prompt that
        // `stop()` then waited on; in Full access, to the tool itself.
        for mode in [PermissionMode.askBeforeChanges, .fullAccess] {
            let hooks = ScriptedHooks()
            let gate = HookGate()
            await hooks.gate(before: gate)
            let model = ScriptedModelClient(steps: [
                .toolCalls([("w1", "write_file", ["path": "src/main.swift", "content": "changed\n"])], text: ""),
            ])
            let (runtime, permissions) = orchestrator(model, hooks: hooks, mode: mode)
            nonisolated(unsafe) var requests = 0
            await permissions.addObserver { update in
                if case .requested = update { requests += 1 }
            }

            try await runtime.submit(prompt: "Rewrite main")
            await gate.waitUntilHeld()
            let stopped = expectation(description: "stop returns in \(mode)")
            Task {
                await runtime.stop()
                stopped.fulfill()
            }
            await fulfillment(of: [stopped], timeout: 5)
            // Releases a prompt a regression would have left `stop()` waiting
            // on, so the failure is reported instead of hanging the suite.
            await permissions.denyAll()

            XCTAssertEqual(requests, 0, "nothing is asked for a stopped run (\(mode))")
            let content = try String(
                contentsOf: workspaceURL.appendingPathComponent("src/main.swift"),
                encoding: .utf8
            )
            XCTAssertEqual(content, "let value = 1\n", "the tool never ran (\(mode))")
            let completion = await payloads().compactMap { payload -> ToolCompletedEvent? in
                if case let .toolCompleted(event) = payload, event.toolCallID == "w1" { return event }
                return nil
            }.last
            XCTAssertEqual(completion?.status, .cancelled)
        }
    }

    func testPostToolUseFeedbackAndContextReachTheModelWithTheResult() async throws {
        let hooks = ScriptedHooks()
        await hooks.set(after: AgentHookResponse(
            blockReason: "Lint failed on line 1.",
            context: ["Formatter ran."],
            notices: [notice("PostToolUse", .feedback, "Lint failed on line 1.")]
        ))
        let model = ScriptedModelClient(steps: [
            .toolCalls([("r1", "read_file", ["path": "src/main.swift"])], text: ""),
            .text("Noted."),
        ])
        let (runtime, _) = orchestrator(model, hooks: hooks)

        try await runtime.submit(prompt: "Read main")
        await runtime.awaitCompletion()

        guard case let .toolResult(_, text, _)? = model.receivedRequests.last?.messages.last else {
            return XCTFail("expected the tool result")
        }
        XCTAssertTrue(text.contains("let value = 1"), "the real result comes first")
        XCTAssertTrue(text.contains("PostToolUse hook feedback:\nLint failed on line 1."))
        XCTAssertTrue(text.contains("<hook_context>\nFormatter ran.\n</hook_context>"))
        let recorded = await hookEvents().map(\.outcome)
        XCTAssertEqual(recorded, [.feedback])
    }

    func testContinueFalseFromAToolHookEndsTheRunOnceTheBatchIsAnswered() async throws {
        let hooks = ScriptedHooks()
        await hooks.set(before: AgentHookResponse(haltReason: "Deploy freeze until Monday."))
        let model = ScriptedModelClient(steps: [
            .toolCalls([("c1", "run_command", ["command": "echo hi"])], text: ""),
            .text("Should never be asked."),
        ])
        let (runtime, _) = orchestrator(model, hooks: hooks)

        try await runtime.submit(prompt: "Deploy")
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 1)
        let events = await payloads()
        XCTAssertFalse(events.contains { if case .toolStarted = $0 { return true }; return false })
        guard case let .runCompleted(run)? = events.last(where: {
            if case .runCompleted = $0 { return true }; return false
        }) else {
            return XCTFail("missing run completion")
        }
        XCTAssertEqual(run.summary, "Stopped by a hook: Deploy freeze until Monday.")
        // Every call still has an answer in the history.
        let conversation = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(conversation.contains {
            if case let .toolResult(id, _, _) = $0 { return id == "c1" }
            return false
        })
    }

    func testAHookAllowSkipsThePromptAndAHookAskForcesIt() async throws {
        // Ask before changes would prompt for this write; the hook vouches.
        let allowing = ScriptedHooks()
        await allowing.set(before: AgentHookResponse(permission: .allow))
        let model = ScriptedModelClient(steps: [
            .toolCalls([("w1", "write_file", ["path": "src/new.swift", "content": "// new\n"])], text: ""),
            .text("Written."),
        ])
        let (runtime, permissions) = orchestrator(model, hooks: allowing, mode: .askBeforeChanges)
        try await runtime.submit(prompt: "Create a file")
        await runtime.awaitCompletion()
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: workspaceURL.appendingPathComponent("src/new.swift").path
        ))
        let pending = await permissions.pendingApprovals
        XCTAssertTrue(pending.isEmpty)

        // Full access would let this read through; the hook asks.
        let asking = ScriptedHooks()
        await asking.set(before: AgentHookResponse(permission: .ask))
        let second = ScriptedModelClient(steps: [
            .toolCalls([("r1", "read_file", ["path": "src/main.swift"])], text: ""),
            .text("Read."),
        ])
        let (askingRuntime, askingPermissions) = orchestrator(second, hooks: asking, mode: .fullAccess)
        let requested = expectation(description: "approval requested")
        await askingPermissions.addObserver { update in
            if case let .requested(request) = update {
                requested.fulfill()
                Task { await askingPermissions.resolve(approvalID: request.id, decision: .approved) }
            }
        }
        try await askingRuntime.submit(prompt: "Read main")
        await fulfillment(of: [requested], timeout: 5)
        await askingRuntime.awaitCompletion()
        let notified = await asking.notifications
        XCTAssertEqual(notified, [.permissionPrompt], "Notification hooks hear that Juno is waiting")
    }

    // MARK: - The permission ruling

    func testAHooksAllowNeverBeatsTheReadersRulesOrTheModesCeiling() {
        func ruling(
            _ mode: PermissionMode,
            _ risk: ActionRisk,
            policy: ApprovalPolicy = .byRisk,
            rule: PermissionRuleDecision? = nil,
            hook: AgentHookPermission?,
            tool: String? = nil
        ) -> PermissionRuling {
            PermissionCoordinator.ruling(
                mode: mode, risk: risk, approvalPolicy: policy, rule: rule, hook: hook, toolName: tool
            )
        }
        let rule = PermissionRule(tool: "Edit")

        // Within the mode, allow removes the prompt the mode would have shown.
        XCTAssertEqual(ruling(.askBeforeChanges, .write, hook: .allow), .allow)
        XCTAssertEqual(ruling(.workspaceWrite, .critical, hook: .allow), .allow)
        // Except for screen input: only the reader's own settings file may
        // let a click or a keystroke run unasked, and a hook is so often the
        // repository's that its allow does not count there. It still asks
        // and blocks like any other.
        for tool in ComputerUseToolName.input {
            XCTAssertEqual(ruling(.workspaceWrite, .critical, hook: .allow, tool: tool), .requireApproval, tool)
            XCTAssertEqual(ruling(.askBeforeChanges, .critical, hook: .allow, tool: tool), .requireApproval, tool)
            XCTAssertEqual(ruling(.fullAccess, .critical, hook: .ask, tool: tool), .requireApproval, tool)
        }
        XCTAssertEqual(
            ruling(.workspaceWrite, .critical, hook: .allow, tool: ComputerUseToolName.click),
            .requireApproval
        )
        XCTAssertEqual(ruling(.workspaceWrite, .critical, hook: .allow, tool: "run_command"), .allow)
        // It cannot lift a read-only session, beat a deny or ask rule, silence
        // a destructive action, or pass a tool pinned to always asking.
        guard case .deny = ruling(.readOnly, .write, hook: .allow) else {
            return XCTFail("read-only must still refuse")
        }
        guard case .deny = ruling(.fullAccess, .write, rule: .deny(rule), hook: .allow) else {
            return XCTFail("a deny rule must win")
        }
        XCTAssertEqual(ruling(.fullAccess, .write, rule: .ask(rule), hook: .allow), .requireApproval)
        XCTAssertEqual(ruling(.fullAccess, .destructive, hook: .allow), .requireApproval)
        XCTAssertEqual(
            ruling(.fullAccess, .critical, policy: .alwaysRequiresApproval, hook: .allow),
            .requireApproval
        )

        // Ask adds a prompt, but never turns a refusal into one.
        XCTAssertEqual(ruling(.fullAccess, .read, hook: .ask), .requireApproval)
        XCTAssertEqual(ruling(.fullAccess, .write, rule: .allow(rule), hook: .ask), .requireApproval)
        guard case .deny = ruling(.readOnly, .write, hook: .ask) else {
            return XCTFail("ask must not offer what read-only refuses")
        }
        // No opinion leaves the reader's own ruling alone.
        XCTAssertEqual(ruling(.askBeforeChanges, .write, hook: nil), .requireApproval)
    }
}
