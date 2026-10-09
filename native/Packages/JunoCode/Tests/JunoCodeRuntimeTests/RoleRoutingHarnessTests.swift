import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

// Alevr Code v2 orchestrator lane, Mac engine half: role routing, the shared
// run budget, configurable concurrency, steering a background child, the
// repeat-call guard and the `auto` mode's reviewer.

/// Answers every turn with a fixed text and usage, recording what it was asked.
private final class RecordingModel: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _models: [String] = []
    private var _efforts: [ReasoningEffort?] = []
    let answer: String
    let usage: (Int, Int)
    let hold: Duration

    init(answer: String = "Done.", usage: (Int, Int) = (100, 10), hold: Duration = .zero) {
        self.answer = answer
        self.usage = usage
        self.hold = hold
    }

    var models: [String] { lock.withLock { _models } }
    var efforts: [ReasoningEffort?] { lock.withLock { _efforts } }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.withLock {
            _models.append(request.modelID)
            _efforts.append(request.reasoningEffort)
        }
        let answer = answer, usage = usage, hold = hold
        return AsyncThrowingStream { continuation in
            let task = Task {
                if hold > .zero { try? await Task.sleep(for: hold) }
                continuation.yield(.usage(inputTokens: usage.0, outputTokens: usage.1))
                continuation.yield(.textDelta(answer))
                continuation.yield(.turnCompleted(.endTurn))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private actor Peak {
    private(set) var peak = 0
    private var current = 0
    func enter() { current += 1; peak = max(peak, current) }
    func leave() { current -= 1 }
}

private final class OverlapModel: AgentModelClient, @unchecked Sendable {
    let peak = Peak()
    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        let peak = self.peak
        return AsyncThrowingStream { continuation in
            Task {
                await peak.enter()
                try? await Task.sleep(for: .milliseconds(150))
                continuation.yield(.textDelta("ok"))
                continuation.yield(.turnCompleted(.endTurn))
                await peak.leave()
                continuation.finish()
            }
        }
    }
}

private struct EchoReadTool: CodeTool {
    let name = "read_file"
    let description = "Read a file."
    let inputSchema: JSONValue = ["type": "object", "properties": ["path": ["type": "string"]]]
    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Read \(input["path"]?.stringValue ?? "")" }
    func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult {
        ToolResult(content: "contents")
    }
}

private struct FixedReviewer: ToolCallReviewing {
    let outcome: AutoReviewOutcome
    func review(_: AutoReviewRequest) async -> AutoReviewOutcome { outcome }
}

private struct FailingModel: AgentModelClient {
    func streamTurn(_: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        AsyncThrowingStream { $0.finish(throwing: AgentModelClientError.transport(message: "offline")) }
    }
}

final class RoleRoutingHarnessTests: XCTestCase {
    private var store: CodeSessionStore!

    override func setUp() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("alevr-routing-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        store = CodeSessionStore(directoryURL: root)
    }

    // MARK: - Routing rules

    private func routing(budget: CodeV2.RunBudget? = nil) -> CodeV2.RoleRouting {
        CodeV2.RoleRouting(
            orchestrator: .init(instanceId: "alevr", model: "anthropic:claude-opus-5-5", effort: .high),
            workers: [
                .init(instanceId: "codex", model: "gpt-6-codex", effort: .low, contextTokens: 200_000),
                .init(instanceId: "alevr", model: "anthropic:claude-sonnet-5-5", effort: .none),
            ],
            reviewer: .init(instanceId: "claude", model: "claude-opus-5-5", effort: .xhigh),
            explorer: nil,
            preset: .leadWorkers,
            budget: budget
        )
    }

    func testRoleSelectionsRoundRobinWorkersAndFallBack() {
        let r = routing()
        XCTAssertEqual(SubagentRouting.selection(in: r, for: .worker, ordinal: 0)?.instanceId, "codex")
        XCTAssertEqual(SubagentRouting.selection(in: r, for: .worker, ordinal: 1)?.instanceId, "alevr")
        XCTAssertEqual(SubagentRouting.selection(in: r, for: .worker, ordinal: 2)?.instanceId, "codex")
        XCTAssertEqual(SubagentRouting.selection(in: r, for: .explorer, ordinal: 1)?.model,
                       "anthropic:claude-sonnet-5-5", "no explorer entry: the workers explore")
        XCTAssertEqual(SubagentRouting.selection(in: r, for: .reviewer)?.instanceId, "claude")
        XCTAssertNil(SubagentRouting.selection(in: nil, for: .worker))
        XCTAssertEqual(SubagentRouting.contractRole(agentName: "verifier", role: .engineer), .reviewer)
        XCTAssertEqual(SubagentRouting.contractRole(agentName: "explorer", role: .engineer), .explorer)
        XCTAssertEqual(SubagentRouting.contractRole(agentName: nil, role: .engineer), .worker)
        XCTAssertNil(SubagentRouting.reasoningEffort(CodeV2.EffortLevel.none))
        XCTAssertEqual(SubagentRouting.reasoningEffort(.xhigh), .xhigh)
    }

    func testRouteResolvesProviderAndModelAndSaysWhenItCannot() {
        let parent = RecordingModel()
        let codex = RecordingModel()
        let withResolver = SubagentRouting(routing: routing()) { selection in
            selection.instanceId == "codex" ? ResolvedSubagentProvider(client: codex, modelID: selection.model, billable: false) : nil
        }
        let worker = withResolver.route(
            requestedModelID: nil, requestedEffort: nil, role: .worker, ordinal: 0,
            parentClient: parent, parentModelID: "anthropic:claude-opus-5-5", parentEffort: .high
        )
        XCTAssertTrue(worker.client as AnyObject === codex)
        XCTAssertEqual(worker.modelID, "gpt-6-codex")
        XCTAssertEqual(worker.reasoningEffort, .low)
        XCTAssertEqual(worker.contextTokens, 200_000)
        XCTAssertFalse(worker.billable)

        // The second worker is on the parent's own instance: its client runs it.
        let second = withResolver.route(
            requestedModelID: nil, requestedEffort: nil, role: .worker, ordinal: 1,
            parentClient: parent, parentModelID: "anthropic:claude-opus-5-5", parentEffort: .high
        )
        XCTAssertTrue(second.client as AnyObject === parent)
        XCTAssertEqual(second.modelID, "anthropic:claude-sonnet-5-5")
        XCTAssertEqual(second.reasoningEffort, .high, "Instant (none) on the entry inherits nothing explicit")

        // The reviewer's instance is not connected here: the parent runs it, and says so.
        let reviewer = withResolver.route(
            requestedModelID: nil, requestedEffort: nil, role: .reviewer, ordinal: 0,
            parentClient: parent, parentModelID: "anthropic:claude-opus-5-5", parentEffort: .high
        )
        XCTAssertTrue(reviewer.client as AnyObject === parent)
        XCTAssertEqual(reviewer.modelID, "anthropic:claude-opus-5-5")
        XCTAssertNotNil(reviewer.note)

        // An explicit model from the call wins over the routing.
        let explicit = withResolver.route(
            requestedModelID: "haiku-x", requestedEffort: .minimal, role: .worker, ordinal: 0,
            parentClient: parent, parentModelID: "m", parentEffort: .high
        )
        XCTAssertEqual(explicit.modelID, "haiku-x")
        XCTAssertEqual(explicit.reasoningEffort, .minimal)
        XCTAssertTrue(explicit.client as AnyObject === parent)

        // No routing at all: exactly the old behaviour.
        let plain = SubagentRouting(routing: nil).route(
            requestedModelID: nil, requestedEffort: nil, role: .worker, ordinal: 0,
            parentClient: parent, parentModelID: "m", parentEffort: .medium
        )
        XCTAssertEqual(plain.modelID, "m")
        XCTAssertEqual(plain.reasoningEffort, .medium)
    }

    func testDelegatedWorkersRunOnTheRoutedProvider() async throws {
        let parentModel = RecordingModel(answer: "parent")
        let codex = RecordingModel(answer: "from codex")
        let parent = try await makeParent()
        let tool = makeTool(
            model: parentModel,
            routing: SubagentRouting(routing: routing()) { selection in
                selection.instanceId == "codex" ? ResolvedSubagentProvider(client: codex, modelID: selection.model) : nil
            },
            concurrency: 1
        )
        let result = try await tool.execute(
            input: ["tasks": [["task": "Implement A"], ["task": "Implement B"]]],
            context: ToolContext(sessionID: parent.id, toolCallID: "c1", emitOutput: { _, _ in })
        )
        XCTAssertFalse(result.isError)
        XCTAssertEqual(codex.models, ["gpt-6-codex"], "the first worker ran on the routed instance's client")
        XCTAssertEqual(codex.efforts, [.low])
        XCTAssertEqual(parentModel.models, ["anthropic:claude-sonnet-5-5"], "the second went round to the next worker")
        XCTAssertTrue(result.content.contains("from codex"))
        let children = await store.childSessions(of: parent.id)
        XCTAssertEqual(Set(children.map(\.configuration.modelID)), ["gpt-6-codex", "anthropic:claude-sonnet-5-5"])
    }

    // MARK: - Budget

    func testBudgetLedgerChargesTokensAndPricedCost() async {
        let ledger = RunBudgetLedger(limits: .init(maxTokens: nil, maxUsd: 1.0))
        let tier = CodeV2.ContextTier(tokens: 200_000, label: "200K", inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3)
        XCTAssertEqual(
            RunBudgetLedger.cost(inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 500_000, tier: tier),
            1.65, accuracy: 0.0001
        )
        var exhausted = await ledger.charge(inputTokens: 100_000, outputTokens: 10_000, tier: tier)
        XCTAssertFalse(exhausted)
        exhausted = await ledger.charge(inputTokens: 100_000, outputTokens: 10_000, tier: tier, billable: false)
        XCTAssertFalse(exhausted, "the user's own subscription is not priced")
        exhausted = await ledger.charge(inputTokens: 200_000, outputTokens: 30_000, tier: tier)
        XCTAssertTrue(exhausted)
        let snapshot = await ledger.snapshot()
        XCTAssertEqual(snapshot.tokens, 450_000)
        XCTAssertTrue(snapshot.exhaustedReason?.contains("$1.00") ?? false)
        XCTAssertNil(RunBudgetLedger.make(for: nil))
        XCTAssertNil(RunBudgetLedger.make(for: routing(budget: .init())))
    }

    func testTheRunBudgetStopsLaterChildrenFromStarting() async throws {
        let parentModel = RecordingModel(answer: "spent", usage: (900, 200))
        let parent = try await makeParent()
        let tool = makeTool(
            model: parentModel,
            routing: SubagentRouting(routing: routing(budget: .init(maxTokens: 1_000))),
            concurrency: 1
        )
        let result = try await tool.execute(
            input: ["tasks": [["task": "First", "model_id": "m"], ["task": "Second", "model_id": "m"]]],
            context: ToolContext(sessionID: parent.id, toolCallID: "c2", emitOutput: { _, _ in })
        )
        XCTAssertEqual(parentModel.models.count, 1, "the second child was never sent a request")
        XCTAssertTrue(result.content.contains("Not started: the run's token budget (1,000 tokens) was reached"))
        let children = await store.childSessions(of: parent.id)
        XCTAssertEqual(children.count, 1, "a child the budget cannot pay for gets no session")
    }

    // MARK: - Concurrency

    func testConcurrencyIsConfigurableUpToSix() async throws {
        let model = OverlapModel()
        let parent = try await makeParent()
        let tool = makeTool(model: model, concurrency: 10)
        XCTAssertEqual(tool.concurrency, DelegateTaskTool.maximumConfigurableConcurrent)
        XCTAssertEqual(tool.perCallLimit, 6)
        let tasks: [JSONValue] = (1...6).map { ["task": .string("Investigate \($0)")] }
        _ = try await tool.execute(
            input: ["tasks": .array(tasks)],
            context: ToolContext(sessionID: parent.id, toolCallID: "c3", emitOutput: { _, _ in })
        )
        let peak = await model.peak.peak
        XCTAssertEqual(peak, 6)
        XCTAssertEqual(makeTool(model: model).concurrency, 3, "the default is unchanged")
        XCTAssertThrowsError(
            try DelegateTaskTool.specs(from: ["tasks": .array(tasks)], toolCallID: "x"),
            "the default per-call cap is still four"
        )
    }

    // MARK: - Steering a background child

    func testMessagesReachOnlyARunningChildOfTheSameParent() async throws {
        let background = BackgroundSubagents()
        let parentID = CodeSessionID(value: "parent")
        let delivered = ReceivedMessages()
        let gate = ScriptedModelGate()
        await background.start(id: "agent-1", parentSessionID: parentID, title: "Child") {
            await gate.arriveAndWait()
            return (.completed, "done")
        }
        let tool = MessageSubagentTool(background: background)
        let context = ToolContext(sessionID: parentID, toolCallID: "m", emitOutput: { _, _ in })

        var result = try await tool.execute(input: ["id": "agent-1", "message": "Narrow it to src/"], context: context)
        XCTAssertTrue(result.isError, "no run yet to steer")
        await background.attachMessenger(id: "agent-1", parentSessionID: parentID) { text in
            await delivered.add(text)
            return true
        }
        result = try await tool.execute(input: ["id": "agent-1", "message": "Narrow it to src/"], context: context)
        XCTAssertFalse(result.isError)
        let texts = await delivered.texts
        XCTAssertEqual(texts.count, 1)
        XCTAssertTrue(texts[0].hasSuffix("Narrow it to src/"))

        let stranger = ToolContext(sessionID: CodeSessionID(value: "other"), toolCallID: "m", emitOutput: { _, _ in })
        result = try await tool.execute(input: ["id": "agent-1", "message": "hi"], context: stranger)
        XCTAssertTrue(result.isError, "another session cannot message this child")

        await gate.release()
        _ = await background.wait(ids: ["agent-1"], parentSessionID: parentID, timeout: .seconds(5))
        result = try await tool.execute(input: ["id": "agent-1", "message": "more"], context: context)
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.contains("already finished"))
    }

    // MARK: - Repeat-call guard

    func testRepeatGuardRemindsAtThreeFiveAndEight() {
        var guardrail = RepeatCallGuard()
        var reminders: [Int] = []
        for call in 1...9 {
            let input: JSONValue = call % 2 == 0
                ? ["b": 2, "a": 1, "justification": .string("try \(call)")]
                : ["a": 1, "b": 2]
            if guardrail.observe(toolName: "read_file", input: input) != nil { reminders.append(call) }
        }
        XCTAssertEqual(reminders, [3, 5, 8], "key order and the justification do not make a call different")
        XCTAssertNil(guardrail.observe(toolName: "grep", input: ["a": 1]))
        XCTAssertNil(guardrail.observe(toolName: "read_file", input: ["a": 1, "b": 2]), "a different call resets the streak")
    }

    func testTheOrchestratorAppendsTheReminderToTheThirdIdenticalResult() async throws {
        let call: [(id: String, name: String, input: JSONValue)] = [("t", "read_file", ["path": "README.md"])]
        let model = ScriptedModelClient(steps: [
            .toolCalls([("t1", "read_file", ["path": "README.md"])], text: ""),
            .toolCalls([("t2", "read_file", ["path": "README.md"])], text: ""),
            .toolCalls([("t3", "read_file", ["path": "README.md"])], text: ""),
            .text("Done."),
        ])
        _ = call
        let session = try await makeParent()
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: [EchoReadTool()]),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .workspaceWrite),
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "You are Alevr Code.", retrySleep: { _ in }),
            modelID: "test-model",
            reasoningEffort: nil
        )
        try await orchestrator.submit(prompt: "Read the README")
        await orchestrator.awaitCompletion()
        let last = try XCTUnwrap(model.receivedRequests.last)
        let results: [String] = last.messages.compactMap {
            if case let .toolResult(_, content, _) = $0 { return content }
            return nil
        }
        XCTAssertEqual(results.count, 3)
        XCTAssertFalse(results[0].contains("Reminder:"))
        XCTAssertFalse(results[1].contains("Reminder:"))
        XCTAssertTrue(results[2].contains("Reminder: you are repeating the exact same tool call"))
    }

    // MARK: - Auto review

    func testReviewProtocolAcceptsOnlyItsSixShapes() throws {
        XCTAssertTrue(try AutoReviewProtocol.parse(#"{"risk":"low","decision":"allow"}"#).allows)
        XCTAssertTrue(try AutoReviewProtocol.parse(#" {"decision":"allow","risk":"medium"} "#).allows)
        let deny = try AutoReviewProtocol.parse(#"{"risk":"high","decision":"deny","reason":"exfiltration"}"#)
        XCTAssertFalse(deny.allows)
        XCTAssertEqual(deny.reason, "exfiltration")
        for bad in [
            #"{"risk":"high","decision":"allow"}"#,
            #"{"risk":"low","decision":"deny"}"#,
            #"{"risk":"low","decision":"allow","reason":"x"}"#,
            #"{"risk":"low","decision":"deny","decision":"allow"}"#,
            #"Sure! {"risk":"low","decision":"allow"}"#,
            #"["allow"]"#,
            "",
        ] {
            XCTAssertThrowsError(try AutoReviewProtocol.parse(bad), bad)
        }
    }

    func testTheReviewerDecidesWhatWouldAskAndFailsClosed() async {
        let session = CodeSessionID(value: "s")
        let permissions = PermissionCoordinator(sessionID: session, mode: .askBeforeChanges)
        await permissions.setRuntimeMode(
            .auto,
            reviewer: FixedReviewer(outcome: AutoReviewOutcome(decision: .init(risk: .low, allows: true, reason: nil)))
        )
        let mode = await permissions.permissionMode
        XCTAssertEqual(mode, .workspaceWrite)
        var outcome = await permissions.authorize(toolName: "run_command", actionDigest: "d", risk: .critical, summary: "npm install")
        XCTAssertEqual(outcome, .allowed)

        await permissions.setAutoReviewer(
            FixedReviewer(outcome: AutoReviewOutcome(decision: .init(risk: .medium, allows: false, reason: "deploys")))
        )
        outcome = await permissions.authorize(toolName: "run_command", actionDigest: "d", risk: .critical, summary: "deploy")
        XCTAssertEqual(outcome, .denied(reason: "The auto reviewer declined this action (deploys)."))

        // A reviewer that cannot be reached is a no.
        await permissions.setAutoReviewer(AutoReviewer(model: FailingModel(), modelID: "r") { _ in ["Ship it"] })
        outcome = await permissions.authorize(toolName: "run_command", actionDigest: "d", risk: .critical, summary: "x")
        guard case let .denied(reason) = outcome else { return XCTFail("expected a denial") }
        XCTAssertTrue(reason.contains("could not decide"))

        // A garbled reply is a no.
        await permissions.setAutoReviewer(AutoReviewer(model: RecordingModel(answer: "yes, go ahead"), modelID: "r") { _ in [] })
        outcome = await permissions.authorize(toolName: "run_command", actionDigest: "d", risk: .critical, summary: "x")
        guard case .denied = outcome else { return XCTFail("expected a denial") }

        // A real allow through the model protocol.
        await permissions.setAutoReviewer(
            AutoReviewer(model: RecordingModel(answer: #"{"risk":"low","decision":"allow"}"#), modelID: "r") { _ in [] }
        )
        outcome = await permissions.authorize(toolName: "run_command", actionDigest: "d", risk: .critical, summary: "npm test")
        XCTAssertEqual(outcome, .allowed)
    }

    func testDestructiveCallsStillGoToThePerson() async throws {
        let session = CodeSessionID(value: "s")
        let permissions = PermissionCoordinator(sessionID: session, mode: .workspaceWrite)
        await permissions.setAutoReviewer(
            FixedReviewer(outcome: AutoReviewOutcome(decision: .init(risk: .low, allows: true, reason: nil)))
        )
        let pending = Task {
            await permissions.authorize(toolName: "run_command", actionDigest: "d", risk: .destructive, summary: "rm -rf build")
        }
        var waited = 0
        while await permissions.pendingApprovals.isEmpty, waited < 200 {
            try await Task.sleep(for: .milliseconds(10))
            waited += 1
        }
        let requests = await permissions.pendingApprovals
        XCTAssertEqual(requests.count, 1, "the reviewer never decides a destructive call")
        await permissions.resolve(approvalID: requests[0].id, decision: .denied)
        _ = await pending.value

        XCTAssertFalse(PermissionCoordinator.reviewerMayDecide(
            risk: .critical, approvalPolicy: .alwaysRequiresApproval, rule: nil, hook: nil, toolName: "x"))
        XCTAssertFalse(PermissionCoordinator.reviewerMayDecide(
            risk: .critical, approvalPolicy: .byRisk, rule: nil, hook: .ask, toolName: "x"))
        XCTAssertFalse(PermissionCoordinator.reviewerMayDecide(
            risk: .execute, approvalPolicy: .byRisk, rule: nil, hook: nil, toolName: ComputerUseToolName.computer))
        XCTAssertTrue(PermissionCoordinator.reviewerMayDecide(
            risk: .critical, approvalPolicy: .byRisk, rule: nil, hook: nil, toolName: "run_command"))
    }

    func testRuntimeModesMapToTheLadder() async {
        XCTAssertEqual(CodeV2.RuntimeMode.readOnly.permissionMode, .readOnly)
        XCTAssertEqual(CodeV2.RuntimeMode.ask.permissionMode, .askBeforeChanges)
        XCTAssertEqual(CodeV2.RuntimeMode.autoEdit.permissionMode, .workspaceWrite)
        XCTAssertEqual(CodeV2.RuntimeMode.auto.permissionMode, .workspaceWrite)
        XCTAssertEqual(CodeV2.RuntimeMode.full.permissionMode, .fullAccess)
        let permissions = PermissionCoordinator(sessionID: CodeSessionID(value: "s"), mode: .workspaceWrite)
        let reviewer = FixedReviewer(outcome: AutoReviewOutcome(decision: .init(risk: .low, allows: true, reason: nil)))
        await permissions.setRuntimeMode(.autoEdit, reviewer: reviewer)
        var reviewing = await permissions.isAutoReviewing
        XCTAssertFalse(reviewing, "only auto uses the reviewer")
        await permissions.setRuntimeMode(.auto, reviewer: reviewer)
        reviewing = await permissions.isAutoReviewing
        XCTAssertTrue(reviewing)
    }

    // MARK: - Helpers

    private func makeParent() async throws -> CodeSession {
        try await store.createSession(
            workspaceID: WorkspaceID(value: "workspace"),
            workspaceName: "workspace",
            title: "Parent",
            configuration: AgentConfiguration(modelID: "anthropic:claude-opus-5-5"),
            gitBranch: nil
        )
    }

    private func makeTool(
        model: any AgentModelClient,
        routing: SubagentRouting? = nil,
        concurrency: Int = DelegateTaskTool.maximumConcurrent
    ) -> DelegateTaskTool {
        DelegateTaskTool(
            model: model,
            registry: ToolRegistry(tools: []),
            store: store,
            workspaceID: WorkspaceID(value: "workspace"),
            workspaceName: "workspace",
            modelID: "anthropic:claude-opus-5-5",
            reasoningEffort: .high,
            parentSystemPrompt: "You are Alevr Code.",
            background: BackgroundSubagents(),
            routing: routing,
            concurrency: concurrency
        )
    }
}

private actor ReceivedMessages {
    private(set) var texts: [String] = []
    func add(_ text: String) { texts.append(text) }
}
