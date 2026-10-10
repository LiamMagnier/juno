import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// Team lane, Mac engine: a Plan → Build → Verify routing runs the Architect,
/// then the Builders, then the Verifier, each on its own model and provider,
/// strictly in that order, before the lead; and the run budget stops it.

/// The order every model was first asked, across the whole run.
private final class CallLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _entries: [String] = []
    var entries: [String] { lock.withLock { _entries } }
    func add(_ name: String) { lock.withLock { _entries.append(name) } }
}

/// Answers with a fixed text, recording its name in the shared log on every
/// request and the model and effort it was asked for.
private final class NamedModel: AgentModelClient, @unchecked Sendable {
    let name: String
    let answer: String
    let usage: (Int, Int)
    let log: CallLog
    private let lock = NSLock()
    private var _models: [String] = []
    private var _efforts: [ReasoningEffort?] = []
    private var _lastPrompt = ""

    init(_ name: String, answer: String, usage: (Int, Int) = (100, 10), log: CallLog) {
        self.name = name
        self.answer = answer
        self.usage = usage
        self.log = log
    }

    var models: [String] { lock.withLock { _models } }
    var efforts: [ReasoningEffort?] { lock.withLock { _efforts } }
    var lastPrompt: String { lock.withLock { _lastPrompt } }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        let text = request.messages.compactMap { message -> String? in
            switch message {
            case let .user(text), let .userWithImages(text, _): text
            default: nil
            }
        }.joined(separator: "\n")
        lock.withLock {
            _models.append(request.modelID)
            _efforts.append(request.reasoningEffort)
            _lastPrompt = text
        }
        log.add(name)
        let answer = answer, usage = usage
        return AsyncThrowingStream { continuation in
            continuation.yield(.usage(inputTokens: usage.0, outputTokens: usage.1))
            continuation.yield(.textDelta(answer))
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}

final class TeamPipelineTests: XCTestCase {
    private var store: CodeSessionStore!
    private let log = CallLog()

    override func setUp() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("alevr-team-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        store = CodeSessionStore(directoryURL: root)
    }

    private static let plan = #"{"plan": "Split the change in two.", "tasks": [{"title": "Update a", "prompt": "Change a.txt"}, {"title": "Update b", "prompt": "Change b.txt"}]}"#

    private func routing(budget: CodeV2.RunBudget? = nil) -> CodeV2.RoleRouting {
        CodeV2.RoleRouting(
            orchestrator: .init(instanceId: "alevr", model: "lead-model"),
            workers: [.init(instanceId: "b1", model: "build-1"), .init(instanceId: "b2", model: "build-2", effort: .low)],
            reviewer: .init(instanceId: "ver", model: "verify-model", effort: .xhigh),
            preset: .planBuildVerify,
            budget: budget,
            architect: .init(instanceId: "arch", model: "arch-model", effort: .high)
        )
    }

    private struct Team {
        let lead: NamedModel
        let architect: NamedModel
        let builder1: NamedModel
        let builder2: NamedModel
        let verifier: NamedModel
        let orchestrator: AgentOrchestrator
        let session: CodeSession
    }

    private func makeTeam(budget: CodeV2.RunBudget? = nil, architectUsage: (Int, Int) = (100, 10)) async throws -> Team {
        let lead = NamedModel("lead", answer: "The team built and verified it.", log: log)
        let architect = NamedModel("plan", answer: Self.plan, usage: architectUsage, log: log)
        let builder1 = NamedModel("build-1", answer: "Built part 1 on juno/agent/a.", log: log)
        let builder2 = NamedModel("build-2", answer: "Built part 2 on juno/agent/b.", log: log)
        let verifier = NamedModel("verify", answer: "Both parts are in. Verdict: pass", log: log)
        let clients: [String: NamedModel] = ["arch": architect, "b1": builder1, "b2": builder2, "ver": verifier]
        let team = routing(budget: budget)
        let session = try await store.createSession(
            workspaceID: WorkspaceID(value: "workspace"),
            workspaceName: "workspace",
            title: "Team",
            configuration: AgentConfiguration(modelID: "lead-model"),
            gitBranch: nil
        )
        let tool = DelegateTaskTool(
            model: lead,
            registry: ToolRegistry(tools: []),
            store: store,
            workspaceID: WorkspaceID(value: "workspace"),
            workspaceName: "workspace",
            modelID: "lead-model",
            reasoningEffort: nil,
            parentSystemPrompt: "You are Alevr Code.",
            executionFactory: { request in
                SubagentExecutionEnvironment(
                    registry: ToolRegistry(tools: []),
                    workspaceName: "worktree",
                    executionRootPath: "/workspace/.juno/worktrees/\(request.taskID)",
                    gitBranch: request.branch,
                    permissionMode: .workspaceWrite
                )
            },
            background: BackgroundSubagents(),
            routing: SubagentRouting(routing: team) { selection in
                clients[selection.instanceId].map { ResolvedSubagentProvider(client: $0, modelID: selection.model) }
            },
            concurrency: 2
        )
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: lead,
            registry: ToolRegistry(tools: [tool]),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .workspaceWrite),
            store: store,
            configuration: AgentOrchestrator.Configuration(
                systemPrompt: "You are Alevr Code.",
                retrySleep: { _ in },
                team: TeamPipeline(routing: team)
            ),
            modelID: "lead-model",
            reasoningEffort: nil
        )
        return Team(lead: lead, architect: architect, builder1: builder1, builder2: builder2, verifier: verifier,
                    orchestrator: orchestrator, session: session)
    }

    func testEachPhaseRunsOnItsOwnModelInOrderThenTheLead() async throws {
        let team = try await makeTeam()
        try await team.orchestrator.submit(prompt: "Capitalise both files")
        await team.orchestrator.awaitCompletion()

        let order = log.entries
        XCTAssertEqual(order.first, "plan")
        XCTAssertEqual(Set(order[1...2]), ["build-1", "build-2"], "the builders run after the plan, side by side")
        XCTAssertEqual(order[3], "verify")
        XCTAssertEqual(order.last, "lead")
        XCTAssertEqual(order.filter { $0 == "lead" }.count, 1)

        XCTAssertEqual(team.architect.models, ["arch-model"])
        XCTAssertEqual(team.architect.efforts, [.high])
        XCTAssertEqual(team.builder1.models, ["build-1"], "builder 1 on worker 1")
        XCTAssertEqual(team.builder2.models, ["build-2"], "builder 2 on worker 2")
        XCTAssertEqual(team.builder2.efforts, [.low])
        XCTAssertEqual(team.verifier.models, ["verify-model"])
        XCTAssertEqual(team.verifier.efforts, [.xhigh])
        XCTAssertEqual(team.lead.models, ["lead-model"])

        XCTAssertTrue(team.builder1.lastPrompt.contains("Split the change in two."), "builders get the plan")
        XCTAssertTrue(team.builder1.lastPrompt.contains("Change a.txt") != team.builder2.lastPrompt.contains("Change a.txt"),
                      "each builder gets its own part")
        XCTAssertTrue(team.verifier.lastPrompt.contains("Built part 1"), "the verifier reads what the builders did")
        XCTAssertTrue(team.lead.lastPrompt.contains("<team_run preset=\"plan-build-verify\">"))
        XCTAssertTrue(team.lead.lastPrompt.contains("Verdict: pass"))

        // The agent tree names each phase.
        let children = await store.childSessions(of: team.session.id)
        XCTAssertEqual(Set(children.map(\.configuration.modelID)), ["arch-model", "build-1", "build-2", "verify-model"])
        let titles = Set(children.map(\.title))
        XCTAssertTrue(titles.contains("Architect · Plan"), "\(titles)")
        XCTAssertTrue(titles.contains("Builder 1 · Update a"), "\(titles)")
        XCTAssertTrue(titles.contains("Builder 2 · Update b"), "\(titles)")
        XCTAssertTrue(titles.contains("Verifier · Verify"), "\(titles)")
    }

    func testTheBudgetCapStopsTheTeamAfterThePhaseThatSpentIt() async throws {
        let team = try await makeTeam(budget: .init(maxTokens: 1_000), architectUsage: (900, 200))
        try await team.orchestrator.submit(prompt: "Capitalise both files")
        await team.orchestrator.awaitCompletion()

        XCTAssertEqual(team.architect.models.count, 1, "the plan ran")
        XCTAssertTrue(team.builder1.models.isEmpty && team.builder2.models.isEmpty, "no builder started")
        XCTAssertTrue(team.verifier.models.isEmpty, "the verifier never ran")
        XCTAssertTrue(team.lead.lastPrompt.contains("reason=\"budget\""), "the lead is told the budget stopped it")
        XCTAssertTrue(team.lead.lastPrompt.contains("Do not continue the work"))
        let children = await store.childSessions(of: team.session.id)
        XCTAssertEqual(children.map(\.configuration.modelID), ["arch-model"])
    }

    func testNoTeamWithoutAPlanBuildVerifyRouting() {
        XCTAssertNil(TeamPipeline(routing: nil))
        var lead = routing()
        lead.preset = .leadWorkers
        XCTAssertNil(TeamPipeline(routing: lead))
        XCTAssertEqual(TeamPipeline(routing: routing())?.builderCount, 2)
    }

    func testThePlanIsSplitIntoAtMostOnePartPerBuilder() {
        let three = #"{"plan":"p","tasks":[{"title":"T1","prompt":"do 1"},{"title":"T2","prompt":"do 2"},{"title":"T3","prompt":"do 3"}]}"#
        let parsed = TeamPipeline.parsePlan(three, builders: 2)
        XCTAssertEqual(parsed.parts.count, 2)
        XCTAssertTrue(parsed.parts[0].prompt.contains("Also: T3"))
        let prose = TeamPipeline.parsePlan("Just change the file.", builders: 3)
        XCTAssertEqual(prose.parts, [TeamPipeline.Part(title: "Implement the plan", prompt: "Just change the file.")])
        XCTAssertEqual(SubagentRouting.contractRole(agentName: "architect", role: .engineer), .architect)
        XCTAssertEqual(SubagentRouting.selection(in: routing(), for: .architect)?.model, "arch-model")
        var noArchitect = routing()
        noArchitect.architect = nil
        XCTAssertEqual(SubagentRouting.selection(in: noArchitect, for: .architect)?.model, "lead-model", "the lead plans when no architect is set")
    }
}
