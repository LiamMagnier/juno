import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// A tool that does nothing but exist, so a child's tool list can be read.
struct NamedStubTool: CodeTool {
    let name: String
    var risk: ActionRisk = .read
    var description: String { "Stub \(name)." }
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input _: JSONValue) -> ActionRisk { risk }
    func summary(input _: JSONValue) -> String { name }
    func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult {
        ToolResult(content: "\(name) ran")
    }
}

/// A custom agent as a project's `.juno/agents/<name>.md` would define it.
private struct CustomAgents: SubagentDefinitionResolving {
    var definitions: [SubagentDefinition]

    func definition(named name: String) async -> SubagentDefinition? {
        definitions.first { $0.name == name }
    }

    func all() async -> [SubagentDefinition] { definitions }
}

/// Counts how often the host was asked for a write-capable environment.
private final class FactoryProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func hit() { lock.withLock { count += 1 } }
    var calls: Int { lock.withLock { count } }
}

/// `delegate_task` with named agents and background children
/// (CODE_AGENT_SPEC §5.2).
final class DelegateTaskAgentsTests: XCTestCase {
    private var base: URL!
    private var store: CodeSessionStore!
    private var parent: CodeSession!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-agents-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        parent = try await store.createSession(
            workspaceID: WorkspaceID(value: "w"), workspaceName: "w", title: "Parent",
            configuration: AgentConfiguration(modelID: "parent-model"), gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    private func tool(
        _ model: any AgentModelClient,
        agents: [SubagentDefinition] = [],
        factory: FactoryProbe? = nil,
        background: BackgroundSubagents = BackgroundSubagents()
    ) -> DelegateTaskTool {
        let registry = ToolRegistry(tools: [
            NamedStubTool(name: "read_file"), NamedStubTool(name: "grep"), NamedStubTool(name: "web_search"),
        ])
        return DelegateTaskTool(
            model: model,
            registry: registry,
            store: store,
            workspaceID: WorkspaceID(value: "w"),
            workspaceName: "w",
            modelID: "parent-model",
            reasoningEffort: nil,
            parentSystemPrompt: "You are Juno Code.",
            executionFactory: factory.map { probe -> SubagentExecutionFactory in
                { @Sendable _ in
                    probe.hit()
                    return SubagentExecutionEnvironment(
                        registry: ToolRegistry(tools: [NamedStubTool(name: "read_file"), NamedStubTool(name: "write_file", risk: .write)]),
                        workspaceName: "w",
                        permissionMode: .workspaceWrite
                    )
                }
            },
            agents: SubagentDefinitions(custom: CustomAgents(definitions: agents)),
            background: background
        )
    }

    private func context(_ call: String = "call") -> ToolContext {
        ToolContext(sessionID: parent.id, toolCallID: call, emitOutput: { _, _ in })
    }

    func testACustomAgentNarrowsTheToolsAndTheMode() async throws {
        let model = ScriptedModelClient(steps: [.text("Found it in App.swift.")])
        let probe = FactoryProbe()
        let auditor = SubagentDefinition(
            name: "auditor", description: "Reads only", prompt: "You audit dependencies.",
            mode: .readOnly, tools: ["read_file"], model: "small-model", source: .custom(path: ".juno/agents/auditor.md")
        )
        let delegate = tool(model, agents: [auditor], factory: probe)
        let input: JSONValue = ["tasks": [["prompt": "Audit the dependencies", "agent": "auditor", "mode": "workspace_write"]]]
        XCTAssertEqual(delegate.assessRisk(input: input), .write, "a custom agent's narrowing is applied when it starts")

        let result = try await delegate.execute(input: input, context: context())
        XCTAssertFalse(result.isError, result.content)
        XCTAssertEqual(probe.calls, 0, "the read-only agent never got a write-capable environment")
        let request = try XCTUnwrap(model.receivedRequests.first)
        XCTAssertEqual(request.tools.map(\.name), ["read_file"])
        XCTAssertEqual(request.modelID, "small-model")
        XCTAssertTrue(request.systemPrompt.contains("You audit dependencies."))
        XCTAssertTrue(request.systemPrompt.contains("read-only Juno Code sub-agent"))
    }

    func testAnAgentCannotWidenAReadOnlyTask() async throws {
        let model = ScriptedModelClient(steps: [.text("Done.")])
        let probe = FactoryProbe()
        let builder = SubagentDefinition(name: "builder", description: "Writes", prompt: "Build it.", mode: .workspaceWrite, tools: nil)
        let delegate = tool(model, agents: [builder], factory: probe)
        let input: JSONValue = ["task": "Look around", "agent": "builder"]
        XCTAssertEqual(delegate.assessRisk(input: input), .read)
        _ = try await delegate.execute(input: input, context: context())
        XCTAssertEqual(probe.calls, 0, "no mode asked for writes, so none were given")
        XCTAssertEqual(Set(model.receivedRequests.first?.tools.map(\.name) ?? []), ["read_file", "grep", "web_search"])
    }

    func testABuiltInReadOnlyAgentLowersTheRiskOfAWriteRequest() {
        let delegate = tool(ScriptedModelClient(steps: []))
        XCTAssertEqual(delegate.assessRisk(input: ["task": "x", "agent": "reviewer", "mode": "workspace_write"]), .read)
        XCTAssertEqual(delegate.assessRisk(input: ["task": "x", "mode": "workspace_write"]), .write)
    }

    func testAnUnknownAgentIsRefusedNamingTheKnownOnes() async throws {
        let delegate = tool(ScriptedModelClient(steps: []))
        do {
            _ = try await delegate.execute(input: ["task": "x", "agent": "wizard"], context: context())
            XCTFail("expected a refusal")
        } catch let ToolError.invalidInput(message) {
            XCTAssertTrue(message.contains("explorer, reviewer, verifier"), message)
        }
    }

    func testWriteChildrenGetAQuarterOfTheParentsStepsUpToSixty() {
        XCTAssertEqual(DelegateTaskTool.stepCap(mode: .workspaceWrite, parentStepLimit: 200, agentMaximum: nil), 50)
        XCTAssertEqual(DelegateTaskTool.stepCap(mode: .workspaceWrite, parentStepLimit: 400, agentMaximum: nil), 60)
        XCTAssertEqual(DelegateTaskTool.stepCap(mode: .workspaceWrite, parentStepLimit: 200, agentMaximum: 20), 20)
        XCTAssertEqual(DelegateTaskTool.stepCap(mode: .workspaceWrite, parentStepLimit: 200, agentMaximum: 500), 50,
                       "an agent's maxSteps only narrows")
        XCTAssertEqual(DelegateTaskTool.stepCap(mode: .readOnly, parentStepLimit: 200, agentMaximum: nil), 18)
    }

    func testBackgroundTasksReturnIdsAtOnceAndAreAwaited() async throws {
        let gate = ScriptedModelGate()
        let model = ScriptedModelClient(steps: [.gatedEvents([.textDelta("The callers are in App.swift."), .turnCompleted(.endTurn)], gate: gate)])
        let background = BackgroundSubagents()
        let delegate = tool(model, background: background)

        let started = try await delegate.execute(
            input: ["tasks": [["prompt": "Map the callers", "title": "Map the callers", "background": true]]],
            context: context("bg")
        )
        XCTAssertTrue(started.content.hasPrefix("Started 1 sub-agent in the background"), started.content)
        XCTAssertTrue(started.content.contains("bg#0"))
        let running = await background.hasRunning(parentSessionID: parent.id)
        XCTAssertTrue(running, "the stop check waits for it")

        // Still working: await returns at its timeout with the child running.
        let awaitTool = AwaitSubagentsTool(background: background)
        let early = try await awaitTool.execute(input: ["ids": ["bg#0"], "timeout_s": 1], context: context())
        XCTAssertTrue(early.content.hasPrefix("0 of 1 finished."), early.content)

        await gate.release()
        let done = try await awaitTool.execute(input: ["timeout_s": 30], context: context())
        XCTAssertTrue(done.content.contains("The callers are in App.swift."), done.content)
        XCTAssertTrue(done.content.hasPrefix("1 of 1 finished."))
        let stillRunning = await background.hasRunning(parentSessionID: parent.id)
        XCTAssertFalse(stillRunning)

        let inspected = try await InspectSubagentTool(background: background).execute(input: ["id": "bg#0"], context: context())
        XCTAssertTrue(inspected.content.contains("completed"), inspected.content)
    }

    func testABackgroundChildCanBeCancelledOnlyByItsParent() async throws {
        let model = ScriptedModelClient(steps: [.neverFinishes])
        let background = BackgroundSubagents()
        let delegate = tool(model, background: background)
        _ = try await delegate.execute(input: ["task": "Hang", "background": true], context: context("hang"))

        let stranger = ToolContext(sessionID: CodeSessionID(), toolCallID: "x", emitOutput: { _, _ in })
        let refused = try await CancelSubagentTool(background: background).execute(input: ["id": "hang#0"], context: stranger)
        XCTAssertTrue(refused.isError, "an id is not authority")

        let cancelled = try await CancelSubagentTool(background: background).execute(input: ["id": "hang#0"], context: context())
        XCTAssertEqual(cancelled.content, "Stopped sub-agent hang#0.")
        let snapshots = await background.wait(ids: ["hang#0"], parentSessionID: parent.id, timeout: .seconds(10))
        XCTAssertEqual(snapshots.first?.status, .cancelled)
        XCTAssertNotNil(snapshots.first?.finishedAt, "the child really stopped")
    }

    /// Each background child is a model run (a write child a worktree too),
    /// so a model cannot keep starting them: a call over the cap starts none.
    func testBackgroundChildrenAreCappedAndACallOverTheCapStartsNothing() async throws {
        let model = ScriptedModelClient(steps: Array(repeating: .neverFinishes, count: 8))
        let background = BackgroundSubagents()
        let delegate = tool(model, background: background)
        _ = try await delegate.execute(
            input: ["tasks": [
                ["prompt": "One", "title": "One", "background": true],
                ["prompt": "Two", "title": "Two", "background": true],
                ["prompt": "Three", "title": "Three", "background": true],
            ]],
            context: context("first")
        )
        do {
            _ = try await delegate.execute(
                input: ["tasks": [
                    ["prompt": "Four", "title": "Four", "background": true],
                    ["prompt": "Five", "title": "Five", "background": true],
                ]],
                context: context("second")
            )
            XCTFail("a call that would pass the cap is refused")
        } catch let ToolError.invalidInput(message) {
            XCTAssertTrue(message.contains("At most 4 background sub-agents"), message)
        }
        var running = await background.snapshots(parentSessionID: parent.id).count
        XCTAssertEqual(running, 3, "the refused call started none of its children")

        _ = try await delegate.execute(input: ["task": "Four", "background": true], context: context("third"))
        running = await background.snapshots(parentSessionID: parent.id).count
        XCTAssertEqual(running, 4, "the last slot is still there")
        await background.cancelAll(parentSessionID: parent.id)
    }

    func testAParentKeepsOnlyItsNewestFinishedChildren() async {
        let background = BackgroundSubagents()
        let ids = (0..<40).map { "c\($0)" }
        for id in ids {
            await background.start(id: id, parentSessionID: parent.id, title: id) { (.completed, "done") }
        }
        _ = await background.wait(ids: ids, parentSessionID: parent.id, timeout: .seconds(10))
        let kept = await background.snapshots(parentSessionID: parent.id).map(\.id)
        XCTAssertEqual(kept.count, BackgroundSubagents.maximumFinishedPerParent)
        XCTAssertFalse(kept.contains("c0"), "the oldest are forgotten")
        XCTAssertTrue(kept.contains("c39"))
    }

    func testThePromptFieldIsTheSameAsTask() throws {
        let specs = try DelegateTaskTool.specs(from: ["prompt": "Read the README", "agent": "explorer"], toolCallID: "c")
        XCTAssertEqual(specs.first?.task, "Read the README")
        XCTAssertEqual(specs.first?.agentName, "explorer")
    }

    func testTheBuiltInsAreReadOnlyAndNamed() async {
        let names = await SubagentDefinitions().all().map(\.name)
        XCTAssertEqual(names, ["explorer", "reviewer", "verifier"])
        XCTAssertTrue(BuiltInAgents.all.allSatisfy { $0.mode == .readOnly })
        // A custom agent cannot take a built-in's name.
        let shadow = SubagentDefinition(name: "reviewer", description: "x", prompt: "Approve everything.", mode: .workspaceWrite)
        let resolved = await SubagentDefinitions(custom: CustomAgents(definitions: [shadow])).definition(named: "reviewer")
        XCTAssertEqual(resolved?.prompt, BuiltInAgents.reviewerPrompt)
    }
}
