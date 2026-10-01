import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// A stop check that answers from a script and remembers what it was shown.
private actor ScriptedGate: CompletionGating {
    private var decisions: [GateDecision]
    private let repeating: GateDecision?
    private(set) var contexts: [CompletionGateContext] = []

    init(_ decisions: [GateDecision] = [], repeating: GateDecision? = nil) {
        self.decisions = decisions
        self.repeating = repeating
    }

    func evaluate(_ context: CompletionGateContext) async -> GateDecision {
        contexts.append(context)
        if !decisions.isEmpty { return decisions.removeFirst() }
        return repeating ?? .finish(context.reportedVerdict)
    }
}

/// Hooks that record the four seam points and answer from a script.
private actor SeamHooks: AgentLifecycleHooks {
    private(set) var compactionCalls: [String] = []
    private(set) var batches: [[AgentToolBatchResult]] = []
    private(set) var failures: [String] = []
    var batchResponse = AgentHookResponse.empty
    var failureResponse = AgentHookResponse.empty

    func respond(batch: AgentHookResponse? = nil, failure: AgentHookResponse? = nil) {
        if let batch { batchResponse = batch }
        if let failure { failureResponse = failure }
    }

    func compactionStarting(
        sessionID _: CodeSessionID,
        trigger: AgentCompactionTrigger,
        focus: String?
    ) async -> AgentHookResponse {
        compactionCalls.append("starting:\(trigger.rawValue):\(focus ?? "")")
        return AgentHookResponse(notices: [
            HookActivityEvent(hookEvent: "PreCompact", hookName: "note.sh", outcome: .message, message: "Folding"),
        ])
    }

    func compactionFinished(
        sessionID _: CodeSessionID,
        trigger: AgentCompactionTrigger,
        event: CompactionEvent
    ) async -> AgentHookResponse {
        compactionCalls.append("finished:\(trigger.rawValue):\(event.afterMessageCount)")
        return .empty
    }

    func toolBatchFinished(
        sessionID _: CodeSessionID,
        results: [AgentToolBatchResult]
    ) async -> AgentHookResponse {
        batches.append(results)
        return batchResponse
    }

    func toolFailed(_ invocation: AgentToolHookInvocation, error: String) async -> AgentHookResponse {
        failures.append("\(invocation.toolName): \(error)")
        return failureResponse
    }
}

/// A tool that runs and reports failure, or throws.
private struct FailingTool: CodeTool {
    let name: String
    var throwsInstead = false
    var risk: ActionRisk = .read
    let description = "Fails on purpose."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input _: JSONValue) -> ActionRisk { risk }
    func summary(input _: JSONValue) -> String { name }

    func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult {
        if throwsInstead { throw ToolError.invalidInput(message: "thrown on purpose") }
        return ToolResult(content: "exit 1: boom", isError: true)
    }
}

private struct PassingTool: CodeTool {
    let name = "passing_step"
    let description = "Succeeds."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input _: JSONValue) -> String { "Passing step" }

    func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult {
        ToolResult(content: "ok")
    }
}

/// The seams the autonomous loop's lanes build on (CODE_AGENT_SPEC §6.0):
/// the injected stop check, `resume(note:origin:)`, and the four hook points.
/// With the defaults, every run behaves exactly as before.
final class AgentLoopSeamTests: XCTestCase {
    private var base: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-seams-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Seams",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    private func orchestrator(
        _ model: ScriptedModelClient,
        gate: (any CompletionGating)? = nil,
        hooks: (any AgentLifecycleHooks)? = nil,
        tools: [any CodeTool] = [],
        mode: PermissionMode = .fullAccess,
        compactionSummary: CompactionSummarizer.Limits? = .standard
    ) -> AgentOrchestrator {
        let permissions = PermissionCoordinator(sessionID: session.id, mode: mode)
        if let gate {
            return AgentOrchestrator(
                sessionID: session.id,
                model: model,
                registry: ToolRegistry(tools: tools),
                permissions: permissions,
                store: store,
                configuration: AgentOrchestrator.Configuration(
                    compactionSummary: compactionSummary,
                    systemPrompt: "You are Juno Code."
                ),
                modelID: "test-model",
                reasoningEffort: nil,
                lifecycleHooks: hooks,
                completionGate: gate
            )
        }
        return AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: tools),
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(
                compactionSummary: compactionSummary,
                systemPrompt: "You are Juno Code."
            ),
            modelID: "test-model",
            reasoningEffort: nil,
            lifecycleHooks: hooks
        )
    }

    private func payloads() async -> [SessionEventPayload] {
        await store.events(for: session.id).map(\.payload)
    }

    private func continuations() async -> [RunContinuedEvent] {
        await payloads().compactMap {
            if case let .runContinued(event) = $0 { return event }
            return nil
        }
    }

    private func userPrompts() async -> Int {
        await payloads().filter { if case .userPrompt = $0 { return true } else { return false } }.count
    }

    // MARK: - The stop check

    func testWithTheDefaultGateEveryRunEndsAsToday() async throws {
        let model = ScriptedModelClient(steps: [.text("Done.")])
        let runtime = orchestrator(model)

        try await runtime.submit(prompt: "Fix the bug")
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 1)
        let none = await continuations()
        XCTAssertTrue(none.isEmpty)
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
    }

    func testTheReportOnlyGateFinishesWithWhatTheRunKnows() async {
        let gate = ReportOnlyCompletionGate()
        func context(_ passed: Bool?) -> CompletionGateContext {
            CompletionGateContext(
                sessionID: CodeSessionID(), steps: 1, filesChanged: ["a"], testsPassed: passed,
                lastAssistantText: "", continuations: [], turnsSinceToolCall: 0
            )
        }
        let passed = await gate.evaluate(context(true))
        let failed = await gate.evaluate(context(false))
        let unknown = await gate.evaluate(context(nil))
        XCTAssertEqual(passed, .finish(.doneChecked))
        XCTAssertEqual(failed, .finish(.checksFailing))
        XCTAssertEqual(unknown, .finish(.doneUnchecked))
    }

    func testAContinueDecisionSendsTheModelBackWithAFencedNoteAndNoReaderMessage() async throws {
        let gate = ScriptedGate([.continueWith(.todosOpen, detail: "2 todos were open: c1, c2.")])
        let model = ScriptedModelClient(steps: [.text("Done."), .text("Both finished.")])
        let runtime = orchestrator(model, gate: gate)

        try await runtime.submit(prompt: "Fix the bug")
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 2)
        guard case let .user(note)? = model.receivedRequests[1].messages.last else {
            return XCTFail("the second request should end in the runtime note")
        }
        XCTAssertEqual(note, "<juno_runtime reason=\"todos_open\">\n2 todos were open: c1, c2.\n</juno_runtime>")
        XCTAssertFalse(ModelMessage.user(note).isReaderMessage, "Juno wrote it, not the reader")
        XCTAssertNil(ModelMessage.user(note).userText, "a rewind never counts it as the reader's")

        let recorded = await continuations()
        XCTAssertEqual(recorded, [RunContinuedEvent(reason: .gate(.todosOpen), detail: "2 todos were open: c1, c2.", origin: .gate)])
        let prompts = await userPrompts()
        XCTAssertEqual(prompts, 1, "a continuation adds no reader message")

        let contexts = await gate.contexts
        XCTAssertEqual(contexts.map(\.continuations), [[], [.todosOpen]])
        XCTAssertEqual(contexts.map(\.turnsSinceToolCall), [0, 1], "the continued turn made no tool call")
        XCTAssertEqual(contexts.last?.lastAssistantText, "Both finished.")
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
    }

    func testAToolCallResetsTheTurnsWithoutProgress() async throws {
        let gate = ScriptedGate([.continueWith(.unverified, detail: "Run the tests.")])
        let model = ScriptedModelClient(steps: [
            .text("Done."),
            .toolCalls([("p1", "passing_step", [:])], text: ""),
            .text("Checked."),
        ])
        let runtime = orchestrator(model, gate: gate, tools: [PassingTool()])

        try await runtime.submit(prompt: "Fix it")
        await runtime.awaitCompletion()

        let contexts = await gate.contexts
        XCTAssertEqual(contexts.map(\.turnsSinceToolCall), [0, 0])
        XCTAssertEqual(contexts.map(\.steps), [1, 3])
    }

    func testAGateThatNeverLetsGoIsBounded() async throws {
        let gate = ScriptedGate(repeating: .continueWith(.goalNotMet, detail: "Not yet."))
        let model = ScriptedModelClient(steps: [])
        let runtime = orchestrator(model, gate: gate)

        try await runtime.submit(prompt: "Loop")
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, AgentOrchestrator.maximumGateContinuations + 1)
        let recorded = await continuations()
        XCTAssertEqual(recorded.count, AgentOrchestrator.maximumGateContinuations)
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
    }

    func testDecisionsTheSeamCannotRunYetFinishTheRun() async throws {
        for decision in [GateDecision.runCheck(checkIDs: ["web-test"]), .runReview, .wait, .finish(.blocked)] {
            session = try await store.createSession(
                workspaceID: WorkspaceID(),
                workspaceName: "Demo",
                title: "\(decision)",
                configuration: AgentConfiguration(modelID: "test-model"),
                gitBranch: nil
            )
            let model = ScriptedModelClient(steps: [.text("Done.")])
            let runtime = orchestrator(model, gate: ScriptedGate([decision]))
            try await runtime.submit(prompt: "Go")
            await runtime.awaitCompletion()
            XCTAssertEqual(model.receivedRequests.count, 1, "\(decision)")
            let status = try await store.session(id: session.id).status
            XCTAssertEqual(status, .completed, "\(decision)")
        }
    }

    // MARK: - resume(note:origin:)

    func testResumeCarriesOnWithNoNewReaderMessage() async throws {
        let model = ScriptedModelClient(steps: [.text("First."), .text("Picked up where I stopped.")])
        let runtime = orchestrator(model)
        try await runtime.submit(prompt: "Start the work")
        await runtime.awaitCompletion()

        try await runtime.resume(note: .retry)
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 2)
        guard case let .user(note)? = model.receivedRequests[1].messages.last else {
            return XCTFail("the resumed request should end in the runtime note")
        }
        XCTAssertTrue(note.hasPrefix("<juno_runtime reason=\"retry\">"))
        let prompts = await userPrompts()
        XCTAssertEqual(prompts, 1)
        let recorded = await continuations()
        XCTAssertEqual(recorded.map(\.reason), [.retry])
        XCTAssertEqual(recorded.map(\.origin), [.user])
        let persisted = await store.loadConversation(sessionID: session.id)
        XCTAssertEqual(persisted.filter(\.isReaderMessage).count, 1, "the note is not the reader's")
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
    }

    func testResumeAfterQuitOnAFreshOrchestratorReadsThePersistedConversation() async throws {
        let first = orchestrator(ScriptedModelClient(steps: [.text("Working on it.")]))
        try await first.submit(prompt: "Do the thing")
        await first.awaitCompletion()
        await first.release()

        let model = ScriptedModelClient(steps: [.text("Resumed.")])
        let second = orchestrator(model)
        try await second.resume(note: .afterQuit(unknownOutcomes: ["npm install"]), origin: .user)
        await second.awaitCompletion()

        let request = try XCTUnwrap(model.receivedRequests.first)
        XCTAssertTrue(request.messages.contains { $0.isReaderMessage }, "the earlier prompt is still there")
        guard case let .user(note)? = request.messages.last else { return XCTFail("expected the note last") }
        XCTAssertTrue(note.contains("npm install"))
        XCTAssertTrue(note.hasPrefix("<juno_runtime reason=\"after_quit\">"))
    }

    func testResumeWithNothingToResumeIsRefused() async throws {
        let model = ScriptedModelClient(steps: [])
        let runtime = orchestrator(model)
        do {
            try await runtime.resume(note: .keepGoing)
            XCTFail("a session with no conversation has nothing to resume")
        } catch OrchestratorError.nothingToResume {
            XCTAssertTrue(model.receivedRequests.isEmpty)
        }
    }

    func testResumeWhileARunIsInFlightIsRefused() async throws {
        let gate = ScriptedModelGate()
        let model = ScriptedModelClient(steps: [.gatedEvents([.textDelta("Done."), .turnCompleted(.endTurn)], gate: gate)])
        let runtime = orchestrator(model)
        try await runtime.submit(prompt: "Long one")
        await gate.waitUntilArrived()
        do {
            try await runtime.resume(note: .retry)
            XCTFail("resume must not start a second loop")
        } catch OrchestratorError.sessionAlreadyRunning {}
        await gate.release()
        await runtime.awaitCompletion()
        let recorded = await continuations()
        XCTAssertTrue(recorded.isEmpty)
    }

    // MARK: - Hook points

    func testCompactionHooksRunAroundAFoldAndTheirNoticesAreRecorded() async throws {
        var messages: [ModelMessage] = [.user("Add line numbers to parser errors")]
        for step in 0..<6 {
            messages.append(.assistant("Step \(step)."))
            messages.append(.toolCall(id: "c\(step)", name: "read_file", input: ["path": .string("P\(step).swift")]))
            messages.append(.toolResult(id: "c\(step)", content: "contents \(step)", isError: false))
        }
        messages.append(.user("Keep the old error type public"))
        messages.append(.assistant("Done."))
        try await store.saveConversation(sessionID: session.id, messages: messages)
        let hooks = SeamHooks()
        let runtime = orchestrator(ScriptedModelClient(steps: []), hooks: hooks, compactionSummary: nil)

        let compacted = await runtime.compactNow(focus: "the API")
        let event = try XCTUnwrap(compacted)

        let calls = await hooks.compactionCalls
        XCTAssertEqual(calls, ["starting:manual:the API", "finished:manual:\(event.afterMessageCount)"])
        let notices = await payloads().compactMap { payload -> HookActivityEvent? in
            if case let .hookActivity(activity) = payload { return activity }
            return nil
        }
        XCTAssertEqual(notices.map(\.hookEvent), ["PreCompact"])
    }

    func testPostToolBatchSeesEveryCallAndCanEndTheRun() async throws {
        let hooks = SeamHooks()
        await hooks.respond(batch: AgentHookResponse(haltReason: "Enough for now."))
        let model = ScriptedModelClient(steps: [
            .toolCalls([("p1", "passing_step", [:]), ("f1", "failing_step", [:])], text: ""),
            .text("Never asked."),
        ])
        let runtime = orchestrator(model, hooks: hooks, tools: [PassingTool(), FailingTool(name: "failing_step")])

        try await runtime.submit(prompt: "Two steps")
        await runtime.awaitCompletion()

        let batches = await hooks.batches
        XCTAssertEqual(batches, [[
            AgentToolBatchResult(toolCallID: "p1", toolName: "passing_step", succeeded: true),
            AgentToolBatchResult(toolCallID: "f1", toolName: "failing_step", succeeded: false),
        ]])
        XCTAssertEqual(model.receivedRequests.count, 1, "the hook's continue: false ended the run")
        let summary = await payloads().compactMap { payload -> String? in
            if case let .runCompleted(run) = payload { return run.summary }
            return nil
        }.last
        XCTAssertEqual(summary, "Stopped by a hook: Enough for now.")
    }

    func testPostToolUseFailureRunsForAFailedCallAndItsContextReachesTheModel() async throws {
        let hooks = SeamHooks()
        await hooks.respond(failure: AgentHookResponse(context: ["The test database is down; skip integration tests."]))
        let model = ScriptedModelClient(steps: [
            .toolCalls([("f1", "failing_step", [:]), ("t1", "throwing_step", [:]), ("p1", "passing_step", [:])], text: ""),
            .text("Understood."),
        ])
        let runtime = orchestrator(
            model,
            hooks: hooks,
            tools: [FailingTool(name: "failing_step"), FailingTool(name: "throwing_step", throwsInstead: true), PassingTool()]
        )

        try await runtime.submit(prompt: "Run them")
        await runtime.awaitCompletion()

        let failures = await hooks.failures
        XCTAssertEqual(failures.count, 2, "the error result and the throw; never the passing call")
        XCTAssertTrue(failures.contains("failing_step: exit 1: boom"))
        XCTAssertTrue(failures.contains { $0.hasPrefix("throwing_step:") })
        let results = model.receivedRequests[1].messages.compactMap { message -> String? in
            if case let .toolResult(id, content, _) = message, id == "f1" { return content }
            return nil
        }
        XCTAssertEqual(results.count, 1)
        XCTAssertTrue(results[0].hasPrefix("exit 1: boom"))
        XCTAssertTrue(results[0].contains("<hook_context>\nThe test database is down; skip integration tests.\n</hook_context>"))
    }

    func testARefusedCallIsNotAFailure() async throws {
        let hooks = SeamHooks()
        let model = ScriptedModelClient(steps: [
            .toolCalls([("w1", "write_step", [:])], text: ""),
            .text("Fine."),
        ])
        let runtime = orchestrator(
            model,
            hooks: hooks,
            tools: [FailingTool(name: "write_step", risk: .write)],
            mode: .readOnly
        )

        try await runtime.submit(prompt: "Write")
        await runtime.awaitCompletion()

        let failures = await hooks.failures
        XCTAssertTrue(failures.isEmpty, "a denial is a refusal, not a tool failure")
        let batches = await hooks.batches
        XCTAssertEqual(batches.first?.first?.succeeded, false)
    }

    func testWithoutHooksTheSeamPointsChangeNothing() async throws {
        let model = ScriptedModelClient(steps: [
            .toolCalls([("f1", "failing_step", [:])], text: ""),
            .text("Done."),
        ])
        let runtime = orchestrator(model, tools: [FailingTool(name: "failing_step")])

        try await runtime.submit(prompt: "Go")
        await runtime.awaitCompletion()

        let result = model.receivedRequests[1].messages.compactMap { message -> String? in
            if case let .toolResult(_, content, _) = message { return content }
            return nil
        }
        XCTAssertEqual(result, ["exit 1: boom"])
        let hookRows = await payloads().filter { if case .hookActivity = $0 { return true } else { return false } }
        XCTAssertTrue(hookRows.isEmpty)
    }
}
