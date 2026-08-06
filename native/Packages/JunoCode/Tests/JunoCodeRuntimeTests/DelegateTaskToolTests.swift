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
