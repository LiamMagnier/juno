import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// Custom and built-in agents as `delegate_task` targets (CODE_AGENT_SPEC
/// §5.2), on Lane B's sub-agent runtime: an agent narrows its child and never
/// widens it, `SubagentStart` hooks reach the child's task, and a narrowed
/// registry keeps the nested instructions its results carry.
///
/// Written by Lane F against its own copy of the runtime; ported at
/// integration onto Lane B's `DelegateTaskTool`, `SubagentDefinition` and
/// `BackgroundSubagents` (background children are covered by
/// `DelegateTaskAgentsTests`).
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
        agents: [SubagentDefinition] = [],
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
            agents: SubagentDefinitions(custom: Targets(definitions: agents)),
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
            prompt: "You are working as the auditor agent (.juno/agents/auditor.md). Its instructions:\nAudit only.",
            mode: .readOnly,
            tools: ["read_file"],
            model: "small-model",
            maxSteps: 4,
            source: .custom(path: ".juno/agents/auditor.md")
        )
        let delegate = tool(
            model: model,
            tools: [NamedTool(name: "read_file"), NamedTool(name: "grep"), NamedTool(name: "write_file", risk: .write)],
            agents: [auditor]
        )
        let input: JSONValue = ["task": "Audit the auth module", "agent": "auditor", "mode": "workspace_write"]
        let session = try await parent()
        let result = try await delegate.execute(input: input, context: context(session))
        XCTAssertFalse(result.isError, result.content)

        let request = try XCTUnwrap(model.requests.first)
        XCTAssertEqual(request.modelID, "small-model")
        XCTAssertEqual(request.tools.map(\.name), ["read_file"], "the agent's tools and nothing else")
        XCTAssertTrue(request.systemPrompt.contains("Audit only."))
        XCTAssertTrue(request.systemPrompt.contains("read-only Juno Code sub-agent"), "the read-only agent made the write request read-only")
        XCTAssertTrue(request.systemPrompt.contains(".juno/agents/auditor.md"))
    }

    func testAnAgentCannotMakeAReadOnlyTaskWrite() {
        let writer = SubagentDefinition(name: "writer", description: "", prompt: "Write.", mode: .workspaceWrite)
        XCTAssertEqual(writer.effectiveMode(requested: .readOnly), .readOnly)
        XCTAssertEqual(writer.effectiveMode(requested: .workspaceWrite), .workspaceWrite)
        let reader = SubagentDefinition(name: "reader", description: "", prompt: "Read.", mode: .readOnly)
        XCTAssertEqual(reader.effectiveMode(requested: .workspaceWrite), .readOnly)
        XCTAssertEqual(DelegateTaskTool.stepCap(mode: .readOnly, parentStepLimit: 200, agentMaximum: 400), DelegateTaskTool.maximumReadOnlySteps)
    }

    func testAnUnknownAgentIsAnswered() async throws {
        let delegate = tool(model: RequestRecorder())
        let session = try await parent()
        do {
            _ = try await delegate.execute(input: ["task": "x", "agent": "ghost"], context: context(session))
            XCTFail("an unknown agent must be refused")
        } catch let ToolError.invalidInput(message) {
            XCTAssertTrue(message.contains("ghost"), message)
            XCTAssertTrue(message.contains("explorer"), message)
        }
    }

    func testSubagentStartHooksAddContextToTheChildsTask() async throws {
        let model = RequestRecorder()
        let hooks = StartHooks()
        let delegate = tool(model: model, hooks: hooks)
        let session = try await parent()
        _ = try await delegate.execute(input: ["task": "Find the callers", "agent": "explorer"], context: context(session))
        let started = await hooks.started
        XCTAssertEqual(started.first?.agentType, "explorer")
        let prompt = try XCTUnwrap(model.requests.first?.messages.first)
        guard case let .user(text) = prompt else { return XCTFail("\(prompt)") }
        XCTAssertTrue(text.contains("Find the callers"))
        XCTAssertTrue(text.contains("<hook_context>\nThe fixtures live in tests/data.\n</hook_context>"))
    }

    /// An agent's `tools:` list narrows the child's registry without losing
    /// the nested `AGENTS.md` context the registry's results carry.
    func testAnAgentsToolListKeepsTheNestedInstructions() async throws {
        let registry = ToolRegistry(
            tools: [NamedTool(name: "read_file"), NamedTool(name: "grep")],
            contextProvider: FixedContext()
        )
        let agent = SubagentDefinition(name: "reader", description: "", prompt: "Read.", tools: ["read_file"])
        let narrowed = agent.narrowing(registry)
        XCTAssertEqual(narrowed.allTools.map(\.name), ["read_file"])
        let result = try await narrowed.executeAuthorized(
            toolName: "read_file",
            input: ["path": "src/a.swift"],
            context: ToolContext(sessionID: CodeSessionID(), toolCallID: "t", emitOutput: { _, _ in })
        )
        XCTAssertEqual(result.appendedContext, "Nested AGENTS.md says hello.")
    }
}

private struct Targets: SubagentDefinitionResolving {
    let definitions: [SubagentDefinition]
    func definition(named name: String) async -> SubagentDefinition? {
        definitions.first { $0.name == name.lowercased() }
    }
    func all() async -> [SubagentDefinition] { definitions }
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
