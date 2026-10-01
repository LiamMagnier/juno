import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime
@testable import JunoCodeUI

// The cross-lane acceptance scenarios (CODE_AGENT_SPEC §6.7), owned by Lane A
// and run when lanes A, B and D have landed. Scripted models, temp folders and
// stand-in surfaces; no network and no real screen.
//
// Until Lane B's `run_checks` and recipe and Lane D's Preview recorder land,
// scenarios 1 and 2 use stand-in tools that return exactly the side effects
// those recorders will (`verificationRecorded`, `uiVerificationRecorded`).
// When they land, swap the stand-ins for the real tools against a temp SwiftPM
// package and the fixture Preview page; the assertions stay as they are.

/// Answers from a script and records every request; the goal judge's calls
/// (`haiku`) are answered from their own script.
private final class ScenarioModel: AgentModelClient, @unchecked Sendable {
    enum Step {
        case text(String)
        case calls([(name: String, input: JSONValue)])
        case hang
    }

    private let lock = NSLock()
    private var steps: [Step]
    private var verdicts: [String]
    private var agent: [ModelTurnRequest] = []
    private var judged: [ModelTurnRequest] = []

    init(_ steps: [Step], verdicts: [String] = []) {
        self.steps = steps
        self.verdicts = verdicts
    }

    var requests: [ModelTurnRequest] {
        lock.lock()
        defer { lock.unlock() }
        return agent
    }

    var judgeRequests: [ModelTurnRequest] {
        lock.lock()
        defer { lock.unlock() }
        return judged
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        let step: Step
        if request.modelID == "haiku" {
            judged.append(request)
            let verdict = verdicts.isEmpty ? "not_met" : verdicts.removeFirst()
            step = .text(#"{"verdict": "\#(verdict)", "reason": "scripted \#(verdict)", "unmet_criteria": []}"#)
        } else {
            agent.append(request)
            step = steps.isEmpty ? .text("Done.") : steps.removeFirst()
        }
        lock.unlock()
        return AsyncThrowingStream { continuation in
            switch step {
            case let .text(text):
                continuation.yield(.textDelta(text))
                continuation.yield(.turnCompleted(.endTurn))
                continuation.finish()
            case let .calls(calls):
                for call in calls {
                    continuation.yield(.toolCallRequested(id: UUID().uuidString, name: call.name, input: call.input))
                }
                continuation.yield(.turnCompleted(.toolUse))
                continuation.finish()
            case .hang:
                continuation.onTermination = { _ in }
            }
        }
    }
}

/// Stand-ins for the recorders the other lanes build.
private struct ScenarioEditTool: CodeTool {
    let name = "scenario_edit"
    let description = "Edits a file."
    let inputSchema: JSONValue = ["type": "object", "properties": ["path": ["type": "string"]]]
    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input _: JSONValue) -> String { "Edit" }
    func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
        ToolResult(content: "edited", sideEffects: [.fileChanged(FileChangedEvent(
            path: try WorkspacePath(input["path"]?.stringValue ?? "Sources/Parser.swift"),
            kind: .modified,
            linesAdded: 2,
            linesRemoved: 1,
            checkpointID: nil
        ))])
    }
}

/// Lane B's `run_checks`, standing in: records the check as evidence.
private struct ScenarioCheckTool: CodeTool {
    let name = "run_checks"
    let description = "Runs the project's checks."
    let inputSchema: JSONValue = ["type": "object", "properties": ["passed": ["type": "boolean"], "excerpt": ["type": "string"]]]
    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input _: JSONValue) -> String { "Run the checks" }
    func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
        let passed = input["passed"]?.boolValue ?? true
        return ToolResult(
            content: passed ? "swift test passed" : "swift test failed",
            isError: !passed,
            sideEffects: [.verificationRecorded(VerificationRecord(
                checkID: "code-test",
                command: "swift test",
                kind: .test,
                exitCode: passed ? 0 : 1,
                passed: passed,
                workspaceRevision: -1,
                durationMs: 4_000,
                excerpt: input["excerpt"]?.stringValue ?? (passed ? "12 tests passed" : "1 failure")
            ))]
        )
    }
}

/// Lane D's Preview check, standing in: mints a UI record for a route.
private struct ScenarioPreviewTool: CodeTool {
    let name = "preview_browser"
    let description = "Checks a route in the Preview."
    let inputSchema: JSONValue = ["type": "object", "properties": ["route": ["type": "string"]]]
    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input _: JSONValue) -> String { "Check the Preview" }
    func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
        let route = input["route"]?.stringValue ?? "/settings"
        return ToolResult(content: "checked \(route)", sideEffects: [.uiVerificationRecorded(UIVerificationRecord(
            surface: .web,
            target: route,
            viewport: "desktop and phone",
            checks: [UICheckResult(name: "HTTP 200", passed: true), UICheckResult(name: "no new console errors", passed: true)],
            passed: true,
            workspaceRevision: -1
        ))])
    }
}

private struct ScenarioDiffTool: CodeTool {
    let name = "git_diff"
    let description = "Shows the diff."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]
    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input _: JSONValue) -> String { "Read the diff" }
    func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult {
        ToolResult(content: "diff --git a/Sources/Parser.swift b/Sources/Parser.swift")
    }
}

/// A call that never returns: the app quits while it runs.
private struct ScenarioHangingTool: CodeTool {
    let name = "scenario_migrate"
    let description = "Applies a migration."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]
    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input _: JSONValue) -> String { "Apply the database migration" }
    func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult {
        try await Task.sleep(for: .seconds(3_600))
        return ToolResult(content: "applied")
    }
}

@MainActor
final class AutonomousAgentScenarioTests: XCTestCase {
    private var base: URL!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-scenarios-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    private func newSession(_ store: CodeSessionStore, workspaceID: WorkspaceID? = WorkspaceID()) async throws -> CodeSession {
        try await store.createSession(
            workspaceID: workspaceID,
            workspaceName: "Scenario",
            title: "Scenario",
            configuration: AgentConfiguration(modelID: "test-model", reasoningEffort: nil, permissionMode: .askBeforeChanges),
            gitBranch: nil
        )
    }

    private func runtime(
        _ model: ScenarioModel,
        store: CodeSessionStore,
        session: CodeSession,
        tools: [any CodeTool],
        recipe: GateRecipe,
        goals: GoalRuntime? = nil,
        settings: AutonomySettings = .standard
    ) -> AgentOrchestrator {
        let autonomy = AutonomyConfiguration(
            settings: settings,
            ledger: RunLedgerRecorder(sessionID: session.id, store: store),
            goals: goals,
            recipe: { recipe }
        )
        return AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: tools + [TodoWriteTool()]),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: AgentOrchestrator.Configuration(
                compactionSummary: nil,
                systemPrompt: "You are Juno Code.",
                autonomy: autonomy
            ),
            modelID: "test-model",
            reasoningEffort: nil,
            completionGate: AutonomyGate(settings: settings, recipe: { recipe }, goals: goals)
        )
    }

    // MARK: 1. Fix a failing test

    func testScenario1FixAFailingTest() async throws {
        let store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        let session = try await newSession(store)
        let recipe = GateRecipe(checks: [
            GateRecipeCheck(id: "code-test", kind: .test, command: "swift test", paths: ["Sources/**", "Tests/**"]),
        ])
        let model = ScenarioModel([
            // The model ticks the fix off as soon as it has made it.
            .calls([("todo_write", ["todos": [
                ["id": "1", "content": "Reproduce the failure", "status": "completed"],
                ["id": "2", "content": "Fix the parser", "status": "completed"],
            ]])]),
            .calls([("scenario_edit", ["path": "Sources/Parser.swift"])]),       // the wrong edit
            .calls([("run_checks", ["passed": false, "excerpt": "error: testNestedBlocks: expected 3, got 2"])]),
            .text("I think that fixes it."),                                      // checks_failing sends it back
            .calls([("scenario_edit", ["path": "Sources/Parser.swift"])]),
            .calls([("run_checks", ["passed": true])]),
            .calls([("git_diff", [:])]),
            .calls([("todo_write", ["todos": [
                ["id": "1", "content": "Reproduce the failure", "status": "completed"],
                ["id": "2", "content": "Fix the parser", "status": "completed"],
            ]])]),
            .text("Fixed: the parser counts nested blocks again. Sources/Parser.swift:41."),
        ])
        let orchestrator = runtime(
            model,
            store: store,
            session: session,
            tools: [ScenarioEditTool(), ScenarioCheckTool(), ScenarioDiffTool()],
            recipe: recipe,
            settings: AutonomySettings(reviewBeforeFinish: .diff)
        )

        try await orchestrator.submit(prompt: "Fix the failing parser test")
        await orchestrator.awaitCompletion()

        let events = await store.events(for: session.id).map(\.payload)
        let continued = events.compactMap { payload -> RunContinuedEvent? in
            if case let .runContinued(event) = payload { return event }
            return nil
        }
        XCTAssertEqual(continued.map(\.reason), [.gate(.checksFailing)])
        // The order: the failing check, the continuation, the passing check,
        // then the report and the divider.
        let order = events.compactMap { payload -> String? in
            switch payload {
            case let .verificationRecorded(record): return record.passed ? "pass" : "fail"
            case .runContinued: return "continued"
            case .runOutcome: return "report"
            case .runCompleted: return "done"
            default: return nil
            }
        }
        XCTAssertEqual(order, ["fail", "continued", "pass", "report", "done"])
        let outcome = try XCTUnwrap(events.compactMap { payload -> RunOutcomeEvent? in
            if case let .runOutcome(event) = payload { return event }
            return nil
        }.last)
        XCTAssertEqual(outcome.endReason, .doneChecked)
        XCTAssertEqual(outcome.checks.map(\.label), ["swift test"], "Checked rows come from the ledger alone")
        XCTAssertEqual(outcome.checks.first?.passed, true)
        XCTAssertEqual(outcome.verification, "Checked with `swift test`")
        // The runtime added only fenced notes, never a reader message.
        let prompts = events.filter { if case .userPrompt = $0 { return true } else { return false } }
        XCTAssertEqual(prompts.count, 1)
        let added = try XCTUnwrap(model.requests.last).messages.compactMap { message -> String? in
            guard case let .user(text) = message, !message.isReaderMessage, !message.isSessionState else { return nil }
            return text
        }
        XCTAssertTrue(added.allSatisfy(RuntimeNote.isRuntimeNote))
    }

    // MARK: 2. A goal with a UI criterion

    func testScenario2AGoalWithAUICriterion() async throws {
        let store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        let session = try await newSession(store)
        let recipe = GateRecipe(checks: [], ui: [GateUITarget(surface: .web, target: "/settings")])
        try await store.setGoal(GoalRun(
            objective: "Make the settings menu open on click",
            criteria: [
                GoalCriterion(id: "c1", text: "The click handler opens the menu"),
                GoalCriterion(id: "c2", text: "The menu opens at /settings", check: .ui(surface: .web, target: "/settings")),
            ]
        ), for: session.id)
        let model = ScenarioModel(
            [
                .calls([("scenario_edit", ["path": "src/components/SettingsMenu.tsx"])]),
                .calls([("git_diff", [:])]),
                .text("Done: the menu opens on pointerdown."),       // the gate blocks: no Preview evidence
                .calls([("preview_browser", ["route": "/settings"])]),
                .text("Checked /settings at desktop and phone."),
            ],
            verdicts: ["met", "met"]
        )
        let goals = GoalRuntime(
            sessionID: session.id,
            store: store,
            judge: ModelCompletionJudge(model: model, modelID: "haiku", sessionID: session.id)
        )
        let orchestrator = runtime(
            model,
            store: store,
            session: session,
            tools: [ScenarioEditTool(), ScenarioPreviewTool(), ScenarioDiffTool()],
            recipe: recipe,
            goals: goals,
            settings: AutonomySettings(reviewBeforeFinish: .diff, autoVerify: AutoVerify(web: false))
        )

        try await orchestrator.submit(prompt: "Make the settings menu open on click")
        await orchestrator.awaitCompletion()

        let verdicts = await store.events(for: session.id).compactMap { event -> GoalVerdictEvent? in
            if case let .goalVerdict(verdict) = event.payload { return verdict }
            return nil
        }
        XCTAssertEqual(verdicts.map(\.verdict), [.gateBlocked, .met])
        XCTAssertEqual(verdicts.first?.unmetCriteria, ["c2"])
        XCTAssertEqual(model.judgeRequests.count, 1, "the judge was asked only once the Preview evidence existed")
        let goal = await store.currentGoalRun(for: session.id)
        XCTAssertEqual(goal?.status, .achieved)
    }

    // MARK: 3. Away

    func testScenario3AnApprovalPendingForTwentyMinutesParksAndIsApprovedLater() async throws {
        let workspace = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspace.appendingPathComponent(".juno"), withIntermediateDirectories: true)
        try #"{"autonomy": {"reviewBeforeFinish": "off"}}"#.write(
            to: workspace.appendingPathComponent(".juno/settings.json"), atomically: true, encoding: .utf8
        )
        let workspaceID = WorkspaceID()
        let access = try WorkspaceAccess(workspaceID: workspaceID, grantedURL: workspace)
        let context = WorkspaceContext(
            record: WorkspaceRecord(
                descriptor: WorkspaceDescriptor(
                    id: workspaceID, displayName: "Away", localPathHint: workspace.path,
                    isGitRepository: false, lastOpenedAt: Date()
                ),
                bookmarkData: Data()
            ),
            access: access,
            storageRoot: base.appendingPathComponent("storage")
        )
        let store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        let session = try await newSession(store, workspaceID: workspaceID)
        let model = ScenarioModel([
            .calls([("write_file", ["path": "notes.txt", "content": "Away from the keyboard\n"])]),
            .text("Wrote notes.txt."),
        ])
        let controller = SessionController(session: session, context: context, store: store, modelClient: model)
        await controller.attach()

        controller.composerText = "Write the notes file"
        await controller.send()
        var pending: ApprovalRequest?
        for _ in 0..<400 {
            pending = await controller.live?.permissions.pendingApprovals.first
            if pending != nil { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let request = try XCTUnwrap(pending)

        // Twenty minutes later nobody has answered: parked, not denied.
        await controller.live?.permissions.sweepExpired(now: request.requestedAt.addingTimeInterval(20 * 60))
        let stillPending = await controller.live?.permissions.pendingApprovals.map(\.id)
        XCTAssertEqual(stillPending, [request.id])
        XCTAssertTrue(controller.session.status.isActive, "the run waits; it did not end")

        // The notification's Allow once answers through the same digest-bound
        // path as the in-app card.
        await controller.approve(request.id)
        await controller.awaitCurrentRun()
        for _ in 0..<400 where controller.session.status.isActive {
            try await Task.sleep(for: .milliseconds(5))
        }

        let written = try String(contentsOf: workspace.appendingPathComponent("notes.txt"), encoding: .utf8)
        XCTAssertEqual(written, "Away from the keyboard\n")
        let ended = await store.events(for: session.id).compactMap { event -> RunEndReason? in
            if case let .runCompleted(run) = event.payload { return run.endReason }
            return nil
        }
        XCTAssertEqual(ended, [.doneUnchecked])
        let denied = await store.events(for: session.id).contains {
            if case let .approvalResolved(resolved) = $0.payload { return resolved.decision == .denied }
            return false
        }
        XCTAssertFalse(denied, "an unanswered approval is never turned into a no")
    }

    // MARK: 4. Quit mid-run

    func testScenario4QuitMidRunThenResume() async throws {
        let live = base.appendingPathComponent("store")
        let store = CodeSessionStore(directoryURL: live)
        let session = try await newSession(store, workspaceID: nil)
        let model = ScenarioModel([
            .calls([("scenario_migrate", [:])]),
        ])
        let orchestrator = runtime(
            model,
            store: store,
            session: session,
            tools: [ScenarioHangingTool()],
            recipe: GateRecipe(checks: [])
        )
        try await orchestrator.submit(prompt: "Apply the migration")
        for _ in 0..<400 {
            let started = await store.events(for: session.id).contains {
                if case .toolStarted = $0.payload { return true } else { return false }
            }
            if started { break }
            try await Task.sleep(for: .milliseconds(5))
        }

        // Juno quits mid-batch: what is on disk at this moment is all a
        // relaunch has.
        let relaunched = base.appendingPathComponent("relaunched")
        try FileManager.default.copyItem(at: live, to: relaunched)
        await orchestrator.stop()

        let reopened = CodeSessionStore(directoryURL: relaunched)
        let restored = try await reopened.session(id: session.id)
        XCTAssertEqual(restored.status, .failed, "a run Juno quit in the middle of reads as interrupted")
        let resumeModel = ScenarioModel([.text("The migration's state is unknown; checking it first.")])
        let controller = SessionController(session: restored, context: nil, store: reopened, modelClient: resumeModel)
        await controller.attach()

        await controller.resumeInterruptedRun()
        await controller.awaitCurrentRun()
        for _ in 0..<400 where controller.session.status.isActive {
            try await Task.sleep(for: .milliseconds(5))
        }

        let request = try XCTUnwrap(resumeModel.requests.first)
        let unknown = request.messages.contains { message in
            guard case let .toolResult(_, content, _) = message else { return false }
            return content == ConversationIntegrity.outcomeUnknownMessage
        }
        XCTAssertTrue(unknown, "the call that was running is reported as outcome unknown")
        let note = request.messages.compactMap { message -> String? in
            guard case let .user(text) = message, RuntimeNote.isRuntimeNote(text) else { return nil }
            return text
        }.last
        XCTAssertTrue(note?.contains("reason=\"after_quit\"") == true)
        XCTAssertTrue(note?.contains("Apply the database migration") == true)
        XCTAssertEqual(request.messages.filter(\.isReaderMessage).count, 1, "no reader message is added")
    }
}
