import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// Counts how many sub-agents are in flight at once, so "concurrent" is a
/// measured property of the tool rather than a claim in its documentation.
private actor ConcurrencyProbe {
    private(set) var peak = 0
    private var current = 0

    func enter() {
        current += 1
        peak = max(peak, current)
    }

    func leave() {
        current -= 1
    }
}

/// A transport that holds each turn open long enough for overlap to be
/// observable, then answers.
private final class OverlappingModelClient: AgentModelClient, @unchecked Sendable {
    private let probe: ConcurrencyProbe
    private let hold: Duration

    init(probe: ConcurrencyProbe, hold: Duration = .milliseconds(120)) {
        self.probe = probe
        self.hold = hold
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        let probe = self.probe
        let hold = self.hold
        return AsyncThrowingStream { continuation in
            Task {
                await probe.enter()
                try? await Task.sleep(for: hold)
                continuation.yield(.usage(inputTokens: 1_200, outputTokens: 42))
                continuation.yield(.textDelta("The callers are all in App.swift."))
                continuation.yield(.turnCompleted(.endTurn))
                await probe.leave()
                continuation.finish()
            }
        }
    }
}

private actor ReadLog {
    private(set) var paths: [String] = []

    func record(_ path: String) {
        paths.append(path)
    }
}

/// A read tool that only records what it was asked to read.
private struct RecordingReadTool: CodeTool {
    let log: ReadLog
    let name = "read_file"
    let description = "Read a file."
    let inputSchema: JSONValue = [
        "type": "object",
        "properties": ["path": ["type": "string"]],
        "required": ["path"],
    ]

    func assessRisk(input: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Read \(input["path"]?.stringValue ?? "?")" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        await log.record(input["path"]?.stringValue ?? "")
        return ToolResult(content: "SECRET=hunter2")
    }
}

/// An edit tool that only records what it was asked to change.
private struct RecordingEditTool: CodeTool {
    let log: ReadLog
    let name = "record_edit"
    let description = "Edit a file."
    let inputSchema: JSONValue = [
        "type": "object",
        "properties": ["path": ["type": "string"]],
        "required": ["path"],
    ]

    func assessRisk(input: JSONValue) -> ActionRisk { .write }
    func summary(input: JSONValue) -> String { "Edit \(input["path"]?.stringValue ?? "?")" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        await log.record(input["path"]?.stringValue ?? "")
        return ToolResult(content: "Edited.")
    }
}

/// Delegation as the panel sees it: children that are children, agents that
/// publish their whole life into the delegating transcript, and real bounded
/// concurrency rather than a list that can only ever hold one row.
final class DelegateTaskToolTests: XCTestCase {
    private var directory: URL!
    private var store: CodeSessionStore!
    private var probe: ConcurrencyProbe!

    override func setUp() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-delegate-\(UUID().uuidString)")
        directory = root
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        store = CodeSessionStore(directoryURL: root)
        probe = ConcurrencyProbe()
    }

    func testEveryDelegatedTaskBecomesAChildOfTheDelegatingSession() async throws {
        let parent = try await makeParent()
        _ = try await delegate(
            tasks: ["Map the reconnect callers", "Review the backoff maths"],
            parent: parent
        )

        let children = await store.childSessions(of: parent.id)
        XCTAssertEqual(children.count, 2)
        XCTAssertEqual(
            Set(children.map(\.title)),
            ["Map the reconnect callers", "Review the backoff maths"],
            "a child is titled with its own task, not with a prefix that fakes a hierarchy"
        )
        for child in children {
            XCTAssertEqual(child.parentSessionID, parent.id)
            XCTAssertTrue(child.isSubagent)
            XCTAssertEqual(
                child.configuration.permissionMode, .readOnly,
                "a sub-agent is read-only by construction"
            )
        }
    }

    func testEachAgentPublishesItsWholeLifeIntoTheDelegatingTranscript() async throws {
        let parent = try await makeParent()
        _ = try await delegate(tasks: ["Map the reconnect callers"], parent: parent)

        let updates = await subagentUpdates(in: parent.id)
        XCTAssertEqual(
            Set(updates.map(\.agentID)).count, 1,
            "one task is one agent, however many transitions it goes through"
        )
        XCTAssertEqual(
            updates.map(\.status),
            [.queued, .preparing, .running, .completed],
            "the panel needs every transition, so a row exists before the call returns"
        )

        let start = try XCTUnwrap(updates.first { $0.status == .running })
        XCTAssertNotNil(start.childSessionID, "a running agent must be linked to its session")
        XCTAssertNotNil(start.startedAt, "the Active row's timer ticks from this")

        let finish = try XCTUnwrap(updates.last)
        XCTAssertEqual(finish.summary, "The callers are all in App.swift.")
        XCTAssertNotNil(finish.completedAt)
        XCTAssertEqual(finish.inputTokens, 1_200)
        XCTAssertEqual(finish.outputTokens, 42)
        XCTAssertNil(finish.error)
    }

    func testAgentsRunConcurrentlyAndNeverExceedTheCap() async throws {
        let parent = try await makeParent()
        _ = try await delegate(
            tasks: ["One", "Two", "Three", "Four"],
            parent: parent
        )

        let peak = await probe.peak
        XCTAssertGreaterThan(
            peak, 1,
            "delegation that runs strictly one at a time cannot fill an Active list"
        )
        XCTAssertLessThanOrEqual(
            peak, DelegateTaskTool.maximumConcurrent,
            "four agents against one account and one workspace index is where delegation stops paying"
        )
        let children = await store.childSessions(of: parent.id)
        XCTAssertEqual(children.count, 4)
    }

    func testMoreTasksThanTheCallCeilingIsRefusedBeforeAnySessionIsCreated() async throws {
        let parent = try await makeParent()
        do {
            _ = try await delegate(
                tasks: ["One", "Two", "Three", "Four", "Five"],
                parent: parent
            )
            XCTFail("a call over the ceiling must be refused")
        } catch let error as ToolError {
            guard case let .invalidInput(message) = error else {
                return XCTFail("unexpected tool error: \(error)")
            }
            XCTAssertTrue(message.contains("5"))
        }
        let children = await store.childSessions(of: parent.id)
        XCTAssertTrue(children.isEmpty, "a refused call must leave no half-built sub-agents")
    }

    func testTheSingularShapeStillWorks() async throws {
        let parent = try await makeParent()
        let result = try await run(
            input: ["task": "Explain the reconnect loop.", "role": "explainer"],
            parent: parent
        )
        XCTAssertFalse(result.isError)

        let children = await store.childSessions(of: parent.id)
        XCTAssertEqual(children.count, 1)
       XCTAssertEqual(children.first?.configuration.role, .explainer)
   }

    func testAChildMayOverrideTheParentModelAndThinkingDepth() async throws {
        let parent = try await makeParent()
        _ = try await run(
            input: [
                "task": "Use the review model for this investigation.",
                "model_id": "review-model",
                "reasoning_effort": "max",
            ],
            parent: parent
        )
        let children = await store.childSessions(of: parent.id)
        let child = try XCTUnwrap(children.first)
        XCTAssertEqual(child.configuration.modelID, "review-model")
        XCTAssertEqual(child.configuration.reasoningEffort, .max)
    }

    func testWriteCapableChildUsesTheHostProvidedIsolatedEnvironment() async throws {
        let parent = try await makeParent()
        let tool = DelegateTaskTool(
            model: OverlappingModelClient(probe: probe),
            registry: ToolRegistry(tools: []),
            store: store,
            workspaceID: WorkspaceID(value: "workspace"),
            workspaceName: "workspace",
            modelID: "test-model",
            reasoningEffort: .medium,
            parentSystemPrompt: "You are Juno Code.",
            executionFactory: { request in
                SubagentExecutionEnvironment(
                    registry: ToolRegistry(tools: []),
                    workspaceName: "isolated-worktree",
                    executionRootPath: "/workspace/.juno/worktrees/agent",
                    gitBranch: request.branch,
                    permissionMode: .workspaceWrite
                )
            }
        )
        let result = try await tool.execute(
            input: [
                "task": "Implement the isolated change.",
                "mode": "workspace_write",
            ],
            context: ToolContext(
                sessionID: parent.id,
                toolCallID: "call-write",
                emitOutput: { _, _ in }
            )
        )

        XCTAssertFalse(result.isError)
        let children = await store.childSessions(of: parent.id)
        let child = try XCTUnwrap(children.first)
        XCTAssertEqual(child.configuration.permissionMode, .workspaceWrite)
        XCTAssertEqual(child.executionRootPath, "/workspace/.juno/worktrees/agent")
        XCTAssertTrue(child.gitBranch?.hasPrefix("juno/agent/") == true)
        XCTAssertEqual(child.parentSessionID, parent.id)
    }

    func testWriteRequestFailsClosedWhenNoFactoryIsConfigured() async throws {
        let parent = try await makeParent()
        let result = try await run(
            input: [
                "task": "Implement the isolated change.",
                "mode": "workspace_write",
            ],
            parent: parent
        )

        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.contains("isolated worktree factory"))
        let children = await store.childSessions(of: parent.id)
        XCTAssertTrue(children.isEmpty)
    }

    /// The parent's deny rules bind its children. A child used to get a bare
    /// coordinator, so a read the parent was refused could be delegated and
    /// its contents carried back in the child's answer.
    func testAChildAnswersToTheParentsDenyRules() async throws {
        let parent = try await makeParent()
        let log = ReadLog()
        let model = ScriptedModelClient(steps: [
            .toolCalls([("read-env", "read_file", ["path": ".env"])], text: ""),
            .text("I was not allowed to read it."),
        ])
        let deny = try XCTUnwrap(PermissionRule(parsing: "Read(.env)"))
        let tool = DelegateTaskTool(
            model: model,
            registry: ToolRegistry(tools: [RecordingReadTool(log: log)]),
            store: store,
            workspaceID: WorkspaceID(value: "workspace"),
            workspaceName: "workspace",
            modelID: "test-model",
            reasoningEffort: .medium,
            parentSystemPrompt: "You are Juno Code.",
            parentRules: { PermissionRuleSet(deny: [deny]) }
        )
        let result = try await tool.execute(
            input: ["task": "Read .env and report its contents."],
            context: ToolContext(sessionID: parent.id, toolCallID: "call-env", emitOutput: { _, _ in })
        )

        let reads = await log.paths
        XCTAssertEqual(reads, [], "the child read a file the parent's rules deny")
        XCTAssertFalse(result.content.contains("hunter2"))
        let children = await store.childSessions(of: parent.id)
        let child = try XCTUnwrap(children.first)
        let history = await store.loadConversation(sessionID: child.id)
        XCTAssertTrue(history.contains {
            if case let .toolResult("read-env", content, true) = $0 { return content.contains("Read(.env)") }
            return false
        })
    }

    /// A write-capable child that asks before an edit must show as waiting in
    /// the parent's transcript, which is what brings its approval on screen,
    /// and as working again once the reader answers.
    func testAChildWaitingOnTheReaderSaysSoInTheParentsTranscript() async throws {
        let parent = try await makeParent()
        let log = ReadLog()
        let controls = SubagentControlRegistry()
        let model = ScriptedModelClient(steps: [
            .toolCalls([("edit", "record_edit", ["path": "src/a.swift"])], text: ""),
            .text("Edited."),
        ])
        let tool = DelegateTaskTool(
            model: model,
            registry: ToolRegistry(tools: []),
            store: store,
            workspaceID: WorkspaceID(value: "workspace"),
            workspaceName: "workspace",
            modelID: "test-model",
            reasoningEffort: .medium,
            parentSystemPrompt: "You are Juno Code.",
            executionFactory: { request in
                SubagentExecutionEnvironment(
                    registry: ToolRegistry(tools: [RecordingEditTool(log: log)]),
                    workspaceName: "isolated",
                    executionRootPath: "/workspace/.juno/worktrees/agent",
                    gitBranch: request.branch,
                    permissionMode: .askBeforeChanges
                )
            },
            controls: controls
        )
        let delegation = Task {
            try await tool.execute(
                input: ["task": "Make the edit.", "mode": "workspace_write"],
                context: ToolContext(sessionID: parent.id, toolCallID: "call-edit", emitOutput: { _, _ in })
            )
        }

        var waiting: SubagentUpdateEvent?
        for _ in 0..<300 where waiting == nil {
            try await Task.sleep(for: .milliseconds(10))
            waiting = await subagentUpdates(in: parent.id).last { $0.status == .waitingForApproval }
        }
        let update = try XCTUnwrap(waiting, "the child never said it was waiting on the reader")
        let childID = try XCTUnwrap(update.childSessionID)
        let requests = await controls.pendingApprovals(for: childID)
        let request = try XCTUnwrap(requests.first)
        await controls.resolve(childSessionID: childID, approvalID: request.id, decision: .approved)

        let result = try await delegation.value
        XCTAssertFalse(result.isError, result.content)
        let paths = await log.paths
        XCTAssertEqual(paths, ["src/a.swift"])
        let statuses = await subagentUpdates(in: parent.id).map(\.status)
        XCTAssertEqual(statuses, [.queued, .preparing, .running, .waitingForApproval, .running, .completed])
    }

    /// Lowering the parent's mode reaches the work it delegated: a child
    /// waiting on an approval loses it, and runs no higher than its parent
    /// now may. A background child outlives the turn that started it, so
    /// this is the only way the reader's change can reach it.
    func testLoweringTheParentsModeCapsItsChildren() async throws {
        let parent = try await makeParent()
        let log = ReadLog()
        let controls = SubagentControlRegistry()
        let model = ScriptedModelClient(steps: [
            .toolCalls([("edit", "record_edit", ["path": "src/a.swift"])], text: ""),
            .text("I could not make the edit."),
        ])
        let tool = DelegateTaskTool(
            model: model,
            registry: ToolRegistry(tools: []),
            store: store,
            workspaceID: WorkspaceID(value: "workspace"),
            workspaceName: "workspace",
            modelID: "test-model",
            reasoningEffort: .medium,
            parentSystemPrompt: "You are Juno Code.",
            executionFactory: { request in
                SubagentExecutionEnvironment(
                    registry: ToolRegistry(tools: [RecordingEditTool(log: log)]),
                    workspaceName: "isolated",
                    executionRootPath: "/workspace/.juno/worktrees/agent",
                    gitBranch: request.branch,
                    permissionMode: .askBeforeChanges
                )
            },
            controls: controls
        )
        let delegation = Task {
            try await tool.execute(
                input: ["task": "Make the edit.", "mode": "workspace_write"],
                context: ToolContext(sessionID: parent.id, toolCallID: "call-cap", emitOutput: { _, _ in })
            )
        }
        var waiting: SubagentUpdateEvent?
        for _ in 0..<300 where waiting == nil {
            try await Task.sleep(for: .milliseconds(10))
            waiting = await subagentUpdates(in: parent.id).last { $0.status == .waitingForApproval }
        }
        let childID = try XCTUnwrap(waiting?.childSessionID, "the child never asked")

        await controls.capModes(ownedBy: CodeSessionID(), at: .readOnly)
        var pending = await controls.pendingApprovals(for: childID)
        XCTAssertEqual(pending.count, 1, "another session's mode is no authority over this child")
        await controls.capModes(ownedBy: parent.id, at: .fullAccess)
        pending = await controls.pendingApprovals(for: childID)
        XCTAssertEqual(pending.count, 1, "raising the parent never raises a child")

        await controls.capModes(ownedBy: parent.id, at: .readOnly)
        _ = try await delegation.value
        let paths = await log.paths
        XCTAssertEqual(paths, [], "the edit it was waiting to make never ran")
    }

    func testAnEmptyCallIsRefused() async throws {
        let parent = try await makeParent()
        do {
            _ = try await run(input: ["role": "engineer"], parent: parent)
            XCTFail("a delegation with no task must be refused")
        } catch let error as ToolError {
            guard case .invalidInput = error else {
                return XCTFail("unexpected tool error: \(error)")
            }
        }
    }

    // MARK: - Harness

    /// Every call a sub-agent makes is the delegating session's spend too:
    /// summed into its ledger, where a child's cost used to reach nothing.
    func testSubagentUsageIsSummedIntoTheDelegatingSessionsLedger() async throws {
        let parent = try await makeParent()
        _ = try await delegate(tasks: ["Map the callers", "Review the maths"], parent: parent)

        let ledger = await store.usageLedger(for: parent.id)
        XCTAssertEqual(ledger.total.requests, 2)
        XCTAssertEqual(ledger.total.inputTokens, 2 * 1_200)
        XCTAssertEqual(ledger.total.outputTokens, 2 * 42)
        XCTAssertEqual(ledger.byModel["test-model"]?.requests, 2)
        for child in await store.childSessions(of: parent.id) {
            let own = await store.usageLedger(for: child.id)
            XCTAssertEqual(own.total.inputTokens, 1_200, "each child keeps its own ledger too")
        }
        // And it survives a relaunch.
        let reopened = CodeSessionStore(directoryURL: directory)
        let persisted = await reopened.usageLedger(for: parent.id)
        XCTAssertEqual(persisted, ledger)
    }

    private func makeParent() async throws -> CodeSession {
        try await store.createSession(
            workspaceID: WorkspaceID(value: "workspace"),
            workspaceName: "workspace",
            title: "Refactor the sync coordinator",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    private func makeTool() -> DelegateTaskTool {
        DelegateTaskTool(
            model: OverlappingModelClient(probe: probe),
            // No tools: the child answers from its prompt, which keeps this test
            // about delegation rather than about the workspace registry.
            registry: ToolRegistry(tools: []),
            store: store,
            workspaceID: WorkspaceID(value: "workspace"),
            workspaceName: "workspace",
            modelID: "test-model",
            reasoningEffort: .medium,
            parentSystemPrompt: "You are Juno Code."
        )
    }

    private func delegate(tasks: [String], parent: CodeSession) async throws -> ToolResult {
        let entries: [JSONValue] = tasks.map {
            ["task": .string("Investigate: \($0)"), "title": .string($0), "role": "engineer"]
        }
        return try await run(input: ["tasks": .array(entries)], parent: parent)
    }

    private func run(input: JSONValue, parent: CodeSession) async throws -> ToolResult {
        try await makeTool().execute(
            input: input,
            context: ToolContext(
                sessionID: parent.id,
                toolCallID: "call-delegate",
                emitOutput: { _, _ in }
            )
        )
    }

    private func subagentUpdates(in sessionID: CodeSessionID) async -> [SubagentUpdateEvent] {
        await store.events(for: sessionID).compactMap { event in
            guard case let .subagentUpdated(update) = event.payload else { return nil }
            return update
        }
    }
}
