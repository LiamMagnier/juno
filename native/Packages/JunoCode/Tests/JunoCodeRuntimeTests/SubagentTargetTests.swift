import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// Custom and built-in agents as `delegate_task` targets, and background
/// children (CODE_AGENT_SPEC §5.2): an agent narrows its child and never
/// widens it, and background ids can be awaited, read and stopped.
final class SubagentTargetTests: XCTestCase {
    private var store: CodeSessionStore!

    override func setUp() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-targets-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        store = CodeSessionStore(directoryURL: root)
    }

    private func parent() async throws -> CodeSession {
        try await store.createSession(
            workspaceID: WorkspaceID(value: "ws"),
            workspaceName: "ws",
            title: "Parent",
            configuration: AgentConfiguration(modelID: "parent-model"),
            gitBranch: nil
        )
    }

    private func tool(
        model: any AgentModelClient,
        tools: [any CodeTool] = [],
        agents: [SubagentDefinition],
        background: BackgroundSubagentRegistry? = nil,
        hooks: (any AgentLifecycleHooks)? = nil
    ) -> DelegateTaskTool {
        DelegateTaskTool(
            model: model,
            registry: ToolRegistry(tools: tools),
            store: store,
            workspaceID: WorkspaceID(value: "ws"),
            workspaceName: "ws",
            modelID: "parent-model",
            reasoningEffort: nil,
            parentSystemPrompt: "You are Juno Code.",
            lifecycleHooks: hooks,
            agents: agents,
            background: background,
            parentStepLimit: 200
        )
    }

    private func context(_ session: CodeSession, id: String = "call") -> ToolContext {
        ToolContext(sessionID: session.id, toolCallID: id, emitOutput: { _, _ in })
    }

    // MARK: - Narrowing

    func testAnAgentNarrowsToolsModeAndModelAndCannotWidenThem() async throws {
        let model = RequestRecorder()
        let auditor = SubagentDefinition(
            name: "auditor",
            description: "Audits",
            instructions: "Audit only.",
            model: "small-model",
            tools: ["Read"],
            mode: .readOnly,
            maxSteps: 4,
            origin: ".juno/agents/auditor.md"
        )
        let delegate = tool(
            model: model,
            tools: [NamedTool(name: "read_file"), NamedTool(name: "grep"), NamedTool(name: "write_file", risk: .write)],
            agents: [auditor]
        )
        // The task asks for writes; the agent is read-only, so the call is a read.
        let input: JSONValue = ["task": "Audit the auth module", "agent": "Auditor", "mode": "workspace_write"]
        XCTAssertEqual(delegate.assessRisk(input: input), .read)
        let session = try await parent()
        let result = try await delegate.execute(input: input, context: context(session))
        XCTAssertFalse(result.isError, result.content)

        let request = try XCTUnwrap(model.requests.first)
        XCTAssertEqual(request.modelID, "small-model")
        XCTAssertEqual(request.tools.map(\.name), ["read_file"], "Read maps to read_file and nothing else")
        XCTAssertTrue(request.systemPrompt.contains("Audit only."))
        XCTAssertTrue(request.systemPrompt.contains("read-only Juno Code sub-agent"))
        XCTAssertTrue(request.systemPrompt.contains(".juno/agents/auditor.md"))

        // A task's explicit model still wins over the agent's.
        XCTAssertEqual(
            try DelegateTaskTool.specs(from: ["task": "x", "agent": "auditor", "model_id": "other"], toolCallID: "c", agents: [auditor]).first?.modelID,
            "other"
        )
    }

    func testAnAgentAskingToWriteCannotMakeAReadOnlyTaskWrite() throws {
        let writer = SubagentDefinition(name: "writer", description: "", instructions: "Write.", mode: .workspaceWrite, origin: "x")
        let spec = try XCTUnwrap(DelegateTaskTool.specs(from: ["task": "x", "agent": "writer", "mode": "read_only"], toolCallID: "c", agents: [writer]).first)
        XCTAssertEqual(spec.mode, .readOnly)
        // With no mode given the agent's write mode is the request, which
        // the parent's own mode still rules (a write asks where writes ask).
        let open = try XCTUnwrap(DelegateTaskTool.specs(from: ["task": "x", "agent": "writer"], toolCallID: "c", agents: [writer]).first)
        XCTAssertEqual(open.mode, .workspaceWrite)
        XCTAssertEqual(writer.effectiveSteps(default: 50), 50)
        XCTAssertEqual(SubagentDefinition(name: "s", description: "", instructions: "x", maxSteps: 400, origin: "x").effectiveSteps(default: 50), 50)
    }

    func testAnUnknownAgentIsAnswered() throws {
        XCTAssertThrowsError(try DelegateTaskTool.specs(from: ["task": "x", "agent": "ghost"], toolCallID: "c", agents: SubagentDefinition.builtIns)) { error in
            guard case let ToolError.invalidInput(message) = error else { return XCTFail("\(error)") }
            XCTAssertTrue(message.contains("No agent named ghost"))
            XCTAssertTrue(message.contains("explorer, reviewer, verifier"))
        }
    }

    func testSubagentStartHooksAddContextToTheChildsTask() async throws {
        let model = RequestRecorder()
        let hooks = StartHooks()
        let delegate = tool(model: model, agents: SubagentDefinition.builtIns, hooks: hooks)
        let session = try await parent()
        _ = try await delegate.execute(input: ["task": "Find the callers", "agent": "explorer"], context: context(session))
        let started = await hooks.started
        XCTAssertEqual(started.first?.agentType, "explorer")
        let prompt = try XCTUnwrap(model.requests.first?.messages.first)
        guard case let .user(text) = prompt else { return XCTFail("\(prompt)") }
        XCTAssertTrue(text.contains("Find the callers"))
        XCTAssertTrue(text.contains("<hook_context>\nThe fixtures live in tests/data.\n</hook_context>"))
    }

    // MARK: - Background

    func testBackgroundTasksReturnIdsAtOnceAndCanBeAwaited() async throws {
        let gate = ReleaseGate()
        let registry = BackgroundSubagentRegistry()
        let delegate = tool(model: GatedModel(gate: gate), agents: [], background: registry)
        let session = try await parent()
        let started = try await delegate.execute(
            input: ["task": "Run the long survey", "title": "Survey", "background": true],
            context: context(session, id: "bg")
        )
        XCTAssertTrue(started.content.contains("Started 1 background sub-agent"))
        XCTAssertTrue(started.content.contains("bg#0"))
        var running = await registry.hasRunning
        XCTAssertTrue(running, "still working after the call returned")

        let await1 = AwaitSubagentsTool(registry: registry)
        let early = try await await1.execute(input: ["ids": ["bg#0"], "timeout_s": 1], context: context(session))
        XCTAssertTrue(early.content.contains("1 still running"))

        await gate.release()
        let done = try await await1.execute(input: ["ids": ["bg#0"], "timeout_s": 30], context: context(session))
        XCTAssertTrue(done.content.contains("1 background sub-agent finished."), done.content)
        XCTAssertTrue(done.content.contains("Released."), done.content)
        running = await registry.hasRunning
        XCTAssertFalse(running)

        let inspect = try await InspectSubagentTool(registry: registry).execute(input: ["id": "bg#0"], context: context(session))
        XCTAssertTrue(inspect.content.contains("completed"))
        let unknown = try await InspectSubagentTool(registry: registry).execute(input: ["id": "nope"], context: context(session))
        XCTAssertTrue(unknown.isError)
    }

    func testABackgroundTaskCanBeCancelledAndStopEndsThemAll() async throws {
        let registry = BackgroundSubagentRegistry()
        let delegate = tool(model: GatedModel(gate: ReleaseGate()), agents: [], background: registry)
        let session = try await parent()
        _ = try await delegate.execute(
            input: ["tasks": [["task": "One", "background": true], ["task": "Two", "background": true]]],
            context: context(session, id: "bg")
        )
        let cancelled = try await CancelSubagentTool(registry: registry).execute(input: ["id": "bg#0"], context: context(session))
        XCTAssertEqual(cancelled.content, "Stopped bg#0.")
        let again = try await CancelSubagentTool(registry: registry).execute(input: ["id": "bg#0"], context: context(session))
        XCTAssertEqual(again.content, "bg#0 had already finished.")
        await registry.cancelAll()
        let entries = await registry.all()
        XCTAssertEqual(entries.map(\.status), [.cancelled, .cancelled])
        let running = await registry.hasRunning
        XCTAssertFalse(running)
    }

    /// A model that kept delegating in the background could otherwise start
    /// children without end, each a model loop with its own spend.
    func testBackgroundChildrenAreBoundedAtOnceAndPerSession() async throws {
        let registry = BackgroundSubagentRegistry()
        let delegate = tool(model: GatedModel(gate: ReleaseGate()), agents: [], background: registry)
        let session = try await parent()
        let four: JSONValue = ["tasks": .array((0..<4).map { .object(["task": .string("Survey \($0)"), "background": true]) })]
        let first = try await delegate.execute(input: four, context: context(session, id: "a"))
        XCTAssertFalse(first.isError, first.content)
        XCTAssertTrue(first.content.contains("Started 4 background sub-agents"))

        let fifth = try await delegate.execute(input: ["task": "One more", "background": true], context: context(session, id: "b"))
        XCTAssertTrue(fifth.isError)
        XCTAssertTrue(fifth.content.contains("At most \(BackgroundSubagentRegistry.maximumRunning)"), fifth.content)
        var entries = await registry.all()
        XCTAssertEqual(entries.count, 4, "a refused call starts nothing")

        // Stopping them frees the places, up to the session's own ceiling.
        var call = 0
        while true {
            await registry.cancelAll()
            call += 1
            let more = try await delegate.execute(input: four, context: context(session, id: "c\(call)"))
            if more.isError {
                XCTAssertTrue(more.content.contains("may start at most \(BackgroundSubagentRegistry.maximumPerSession)"), more.content)
                break
            }
            XCTAssertLessThan(call, 10, "the per-session ceiling never answered")
        }
        entries = await registry.all()
        XCTAssertEqual(entries.count, BackgroundSubagentRegistry.maximumPerSession)
        await registry.cancelAll()
    }

    /// Two reservations racing on the actor cannot both take the last places.
    func testReservationsAreAllOrNothing() async {
        let registry = BackgroundSubagentRegistry()
        let three = (0..<3).map { BackgroundSubagentRegistry.Reservation(id: "x\($0)", title: "x", agent: nil) }
        let two = (0..<2).map { BackgroundSubagentRegistry.Reservation(id: "y\($0)", title: "y", agent: nil) }
        let refusedThree = await registry.reserve(three)
        let refusedTwo = await registry.reserve(two)
        XCTAssertNil(refusedThree)
        XCTAssertNotNil(refusedTwo, "three running plus two is over four")
        let ids = await registry.all().map(\.id)
        XCTAssertEqual(ids, ["x0", "x1", "x2"])
        // A reserved child cancelled before it started never starts.
        await registry.cancel("x0")
        await registry.start(id: "x0") { (.completed, "should not run") }
        let entry = await registry.entry("x0")
        XCTAssertEqual(entry?.status, .cancelled)
        XCTAssertNil(entry?.answer)
        await registry.cancelAll()
    }

    /// An agent's `tools:` list narrows the child's registry without losing
    /// the nested `AGENTS.md` context the registry's results carry.
    func testAnAgentsToolListKeepsTheNestedInstructions() async throws {
        let registry = ToolRegistry(
            tools: [NamedTool(name: "read_file"), NamedTool(name: "grep")],
            contextProvider: FixedContext()
        )
        let narrowed = registry.restricted(to: ["read_file"])
        XCTAssertEqual(narrowed.allTools.map(\.name), ["read_file"])
        let result = try await narrowed.executeAuthorized(
            toolName: "read_file",
            input: ["path": "src/a.swift"],
            context: ToolContext(sessionID: CodeSessionID(), toolCallID: "t", emitOutput: { _, _ in })
        )
        XCTAssertEqual(result.appendedContext, "Nested AGENTS.md says hello.")
    }

    func testBackgroundIsRefusedWhereNoRegistryRuns() throws {
        let delegate = tool(model: RequestRecorder(), agents: [])
        let refusal = delegate.precheck(input: ["task": "x", "background": true])
        guard case let .invalidInput(message)? = refusal else { return XCTFail("\(String(describing: refusal))") }
        XCTAssertTrue(message.contains("not available"))
    }

    func testTheProviderOffersTheFollowUpToolsOnlyWithARegistry() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-provider-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let workspace = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspace)
        let executor = CommandExecutionService(workspaceRootURL: workspace)
        let session = CodeSessionID()
        func context(_ registry: BackgroundSubagentRegistry?) -> CodeToolProviderContext {
            CodeToolProviderContext(
                sessionID: session,
                workspaceID: access.workspaceID,
                workspaceRoot: workspace,
                behavior: .code,
                supportsVision: false,
                computerUseActive: false,
                store: store,
                permissions: PermissionCoordinator(sessionID: session, mode: .askBeforeChanges),
                files: FileOperationService(
                    access: access,
                    checkpoints: CheckpointStore(directoryURL: base.appendingPathComponent("checkpoints"), access: access)
                ),
                executor: executor,
                git: GitService(executor: executor),
                tests: TestRunnerService(access: access, executor: executor),
                backgroundSubagents: registry
            )
        }
        let without = await ExtensionToolProvider().tools(for: context(nil))
        XCTAssertTrue(without.isEmpty)
        let with = await ExtensionToolProvider().tools(for: context(BackgroundSubagentRegistry()))
        XCTAssertEqual(with.map(\.name), ["await_subagents", "inspect_subagent", "cancel_subagent"])
        XCTAssertTrue(with.allSatisfy { $0.assessRisk(input: [:]) == .read })
    }
}

// MARK: - Doubles

private final class RequestRecorder: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [ModelTurnRequest] = []
    var requests: [ModelTurnRequest] { lock.withLock { storage } }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.withLock { storage.append(request) }
        return AsyncThrowingStream { continuation in
            continuation.yield(.textDelta("Done."))
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}

private actor ReleaseGate {
    private var released = false
    func release() { released = true }
    func wait() async {
        while !released, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }
}

/// Answers only once released, so a background child is still working.
private final class GatedModel: AgentModelClient, @unchecked Sendable {
    let gate: ReleaseGate
    init(gate: ReleaseGate) { self.gate = gate }

    func streamTurn(_: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        let gate = self.gate
        return AsyncThrowingStream { continuation in
            let task = Task {
                await gate.wait()
                guard !Task.isCancelled else { return continuation.finish() }
                continuation.yield(.textDelta("Released."))
                continuation.yield(.turnCompleted(.endTurn))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private struct NamedTool: CodeTool {
    let name: String
    var risk: ActionRisk = .read
    var description: String { name }
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]
    func assessRisk(input _: JSONValue) -> ActionRisk { risk }
    func summary(input _: JSONValue) -> String { name }
    func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult { ToolResult(content: "ok") }
}

private struct FixedContext: ToolResultContextProviding {
    func context(forTouchedPaths _: [WorkspacePath], sessionID _: CodeSessionID) async -> String? {
        "Nested AGENTS.md says hello."
    }
}

private actor StartHooks: AgentLifecycleHooks {
    private(set) var started: [(agentID: String, agentType: String)] = []

    func subagentStarted(sessionID _: CodeSessionID, agentID: String, agentType: String, task _: String) async -> AgentHookResponse {
        started.append((agentID, agentType))
        return AgentHookResponse(context: ["The fixtures live in tests/data."])
    }
}
