import UserNotifications
import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime
@testable import JunoCodeUI

// The cross-lane acceptance scenarios (CODE_AGENT_SPEC §6.7), run on the
// integrated lanes: Lane A's loop, stop check and goal runtime; Lane B's
// recipe, `run_checks`, check runner and report; Lane D's Preview tools and
// verify advice; Lane E's run monitor, notification answers and Resume.
// Scripted models, temporary repositories and stand-in surfaces (a test
// runner that reads the package's source instead of compiling it, Juno's
// in-process static server behind an offscreen page); no network and no
// real screen.

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

/// `swift test` for the scenario's package, standing in for the compiler:
/// it reads `Sources/Parser/Parser.swift` and passes only once the bug is
/// fixed, answering in XCTest's own words. Every other command (`git`) runs
/// for real.
private struct PackageTestRunner: CommandExecuting {
    let root: URL
    let real: any CommandExecuting

    func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        guard commandLine.trimmingCharacters(in: .whitespaces).hasPrefix("swift test") else {
            return real.stream(commandLine, timeoutSeconds: timeoutSeconds, outputLimit: outputLimit)
        }
        let source = (try? String(contentsOf: root.appendingPathComponent("Sources/Parser/Parser.swift"), encoding: .utf8)) ?? ""
        let fixed = !source.contains("deepest - 1")
        let output = fixed
            ? """
            Test Suite 'All tests' started.
            Test Case '-[ParserTests.ParserTests testNestedBlocks]' passed (0.001 seconds).
            Test Suite 'All tests' passed.
            \t Executed 1 test, with 0 failures (0 unexpected) in 0.001 (0.002) seconds

            """
            : """
            Test Suite 'All tests' started.
            Tests/ParserTests/ParserTests.swift:6: error: -[ParserTests.ParserTests testNestedBlocks] : XCTAssertEqual failed: ("2") is not equal to ("3")
            Test Case '-[ParserTests.ParserTests testNestedBlocks]' failed (0.001 seconds).
            Test Suite 'All tests' failed.
            \t Executed 1 test, with 1 failure (0 unexpected) in 0.001 (0.002) seconds

            """
        return AsyncThrowingStream { continuation in
            continuation.yield(.stdout(output))
            continuation.yield(.completed(CommandResult(
                exitCode: fixed ? 0 : 1,
                wasTimeout: false,
                wasCancelled: false,
                wasTruncated: false,
                durationSeconds: 4
            )))
            continuation.finish()
        }
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

/// The run monitor's notification centre, recorded: nothing is posted.
@MainActor
private final class RecordingNotificationSink: CodeNotificationSink {
    var posted: [CodeNotification] = []
    func register(_: [CodeNotificationCategory]) {}
    func adopt(delegate _: any UNUserNotificationCenterDelegate) {}
    func clearStaleReminders() {}
    func post(_ notification: CodeNotification, sound _: Bool) { posted.append(notification) }
    func remove(identifiers _: [String]) {}
}

@MainActor
final class AutonomousAgentScenarioTests: XCTestCase {
    private var base: URL!
    private var previewKeys: [PreviewKey] = []

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-scenarios-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        for key in previewKeys {
            await PreviewRegistry.shared.remove(key)
            PreviewPageRegistry.shared.remove(key)
        }
        try? FileManager.default.removeItem(at: base)
    }

    private func newSession(
        _ store: CodeSessionStore,
        workspaceID: WorkspaceID? = WorkspaceID(),
        mode: PermissionMode = .askBeforeChanges
    ) async throws -> CodeSession {
        try await store.createSession(
            workspaceID: workspaceID,
            workspaceName: "Scenario",
            title: "Scenario",
            configuration: AgentConfiguration(modelID: "test-model", reasoningEffort: nil, permissionMode: mode),
            gitBranch: nil
        )
    }

    private func write(_ text: String, to path: String, in root: URL) throws {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func waitUntil(_ condition: @MainActor () async -> Bool) async throws {
        for _ in 0..<800 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    // MARK: 1. Fix a failing test

    /// A temp SwiftPM package with one failing test. The model writes a todo
    /// list, makes a wrong edit, runs `run_checks` (it fails), is sent back
    /// with `checks_failing`, fixes the bug, passes, reads the diff and
    /// reports. Lane B's recipe, `run_checks`, check runner and report sit
    /// behind Lane A's stop check, as the app wires them.
    func testScenario1FixAFailingTest() async throws {
        let root = base.appendingPathComponent("parser")
        try write("""
            // swift-tools-version:5.9
            import PackageDescription

            let package = Package(
                name: "Parser",
                targets: [
                    .target(name: "Parser"),
                    .testTarget(name: "ParserTests", dependencies: ["Parser"]),
                ]
            )

            """, to: "Package.swift", in: root)
        try write("""
            /// How deeply `{` blocks nest in `text`.
            public func nestedDepth(_ text: String) -> Int {
                var depth = 0
                var deepest = 0
                for character in text {
                    if character == "{" { depth += 1; deepest = max(deepest, depth) }
                    if character == "}" { depth -= 1 }
                }
                return deepest - 1
            }

            """, to: "Sources/Parser/Parser.swift", in: root)
        try write("""
            import XCTest
            @testable import Parser

            final class ParserTests: XCTestCase {
                func testNestedBlocks() {
                    XCTAssertEqual(nestedDepth("{{{}}}"), 3)
                }
            }

            """, to: "Tests/ParserTests/ParserTests.swift", in: root)
        // The project's checks, accepted by the reader (Lane B's recipe).
        let approvals = VerifyRecipeApprovalStore(directory: base.appendingPathComponent("verify-approvals"))
        let recipes = VerifyRecipeStore(workspaceRoot: root, approvals: approvals)
        try recipes.accept(
            VerifyRecipe(checks: [
                VerifyCheck(id: "swift-test", kind: .test, run: .shell("swift test"), paths: ["Sources/**", "Tests/**"]),
            ]),
            runWithoutAsking: false
        )
        try ShipFixture.shell(
            "git init -q -b main && git config user.email t@t.local && git config user.name T && git add -A && git commit -qm initial",
            in: root
        )

        let store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        let session = try await newSession(store, mode: .fullAccess)
        let access = try WorkspaceAccess(workspaceID: try XCTUnwrap(session.workspaceID), grantedURL: root)
        let real = CommandExecutionService(workspaceRootURL: root)
        let executor = PackageTestRunner(root: root, real: real)
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let evidence = await VerificationLedgers.shared.ledger(for: session.id, store: store)
        let files = FileOperationService(
            access: access,
            checkpoints: CheckpointStore(directoryURL: base.appendingPathComponent("checkpoints"), access: access)
        )
        let checks = CheckRunner(executor: executor, permissions: permissions, ledger: evidence)
        let settings = AutonomySettings(reviewBeforeFinish: .diff)
        let recipe: @Sendable () async -> GateRecipe? = {
            await VerifyGateRecipe.make(status: await recipes.status()) { check in
                await checks.allowedWithoutPrompt([PlannedCheck(check: check, commandLine: check.commandLine, isTargeted: false)])
            }
        }
        let madeRecipe = await recipe()
        let gateRecipe = try XCTUnwrap(madeRecipe)
        XCTAssertEqual(gateRecipe.checks.map(\.id), ["swift-test"])
        XCTAssertEqual(gateRecipe.source, ".juno/verify.json")

        let bug = "    return deepest - 1"
        let model = ScenarioModel([
            .calls([("todo_write", ["todos": [
                ["id": "1", "content": "Reproduce the failure", "status": "in_progress"],
                ["id": "2", "content": "Fix the parser", "status": "pending"],
            ]])]),
            // The wrong edit: it changes the closing count, not the result.
            .calls([("multi_edit", [
                "path": "Sources/Parser/Parser.swift",
                "edits": [["old_string": "if character == \"}\" { depth -= 1 }", "new_string": "if character == \"}\" { depth = max(0, depth - 1) }"]],
            ])]),
            .calls([("todo_write", ["todos": [
                ["id": "1", "content": "Reproduce the failure", "status": "completed"],
                ["id": "2", "content": "Fix the parser", "status": "completed"],
            ]])]),
            .calls([("run_checks", ["scope": "targeted"])]),
            .text("I think that fixes it."),                                      // checks_failing sends it back
            .calls([("multi_edit", [
                "path": "Sources/Parser/Parser.swift",
                "edits": [["old_string": .string(bug), "new_string": "    return deepest"]],
            ])]),
            .calls([("run_checks", ["scope": "targeted"])]),
            .calls([("git_diff", [:])]),
            .text("Fixed: nestedDepth no longer subtracts one from the deepest level. Sources/Parser/Parser.swift:9."),
        ])
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: [
                MultiEditTool(files: files),
                GitDiffTool(git: GitService(executor: real)),
                RunChecksTool(
                    recipes: recipes,
                    executor: executor,
                    permissions: permissions,
                    ledger: evidence,
                    changes: nil,
                    workspaceRoot: root
                ),
                TodoWriteTool(),
            ]),
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(
                compactionSummary: nil,
                systemPrompt: "You are Alevr Code.",
                autonomy: AutonomyConfiguration(
                    settings: settings,
                    ledger: RunLedgerRecorder(sessionID: session.id, store: store),
                    recipe: recipe,
                    checkRunner: VerifyGateCheckRunner(recipes: recipes, runner: checks),
                    reportBuilder: VerifyRunReportBuilder()
                )
            ),
            modelID: "test-model",
            reasoningEffort: nil,
            completionGate: AutonomyGate(settings: settings, recipe: recipe)
        )

        try await orchestrator.submit(prompt: "Fix the failing parser test")
        await orchestrator.awaitCompletion()

        let fixedSource = try String(contentsOf: root.appendingPathComponent("Sources/Parser/Parser.swift"), encoding: .utf8)
        XCTAssertFalse(fixedSource.contains("deepest - 1"), fixedSource)
        let events = await store.events(for: session.id).map(\.payload)
        let continued = events.compactMap { payload -> RunContinuedEvent? in
            if case let .runContinued(event) = payload { return event }
            return nil
        }
        XCTAssertEqual(continued.map(\.reason), [.gate(.checksFailing)])
        XCTAssertTrue(continued.first?.detail.contains("swift test") == true, continued.first?.detail ?? "")
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
        let records = events.compactMap { payload -> VerificationRecord? in
            if case let .verificationRecorded(record) = payload { return record }
            return nil
        }
        XCTAssertEqual(records.map(\.checkID), ["swift-test", "swift-test"], "minted by run_checks from the recipe")
        XCTAssertEqual(records.map(\.exitCode), [1, 0])
        let outcome = try XCTUnwrap(events.compactMap { payload -> RunOutcomeEvent? in
            if case let .runOutcome(event) = payload { return event }
            return nil
        }.last)
        XCTAssertEqual(outcome.endReason, .doneChecked)
        XCTAssertEqual(outcome.checks.map(\.label), ["swift test"], "Checked rows come from the ledger alone")
        XCTAssertEqual(outcome.checks.first?.passed, true)
        XCTAssertEqual(outcome.verification, "Checked with `swift test`")
        XCTAssertTrue(outcome.notChecked.isEmpty, "\(outcome.notChecked)")
        let ended = events.compactMap { payload -> RunEndReason? in
            if case let .runCompleted(run) = payload { return run.endReason }
            return nil
        }
        XCTAssertEqual(ended, [.doneChecked])
        // The runtime added only fenced notes, never a reader message.
        let prompts = events.filter { if case .userPrompt = $0 { return true } else { return false } }
        XCTAssertEqual(prompts.count, 1)
        let added = try XCTUnwrap(model.requests.last).messages.compactMap { message -> String? in
            guard case let .user(text) = message, !message.isReaderMessage, !message.isSessionState else { return nil }
            return text
        }
        XCTAssertFalse(added.isEmpty)
        XCTAssertTrue(added.allSatisfy(RuntimeNote.isRuntimeNote), "\(added)")
        XCTAssertEqual(model.requests.count, 9)
    }

    // MARK: 2. A goal with a UI criterion

    /// A static site with a launch configuration, served by Juno's in-process
    /// server behind an offscreen page: the Preview surface without a real
    /// dev server or a window.
    private func previewSite() throws -> URL {
        let root = base.appendingPathComponent("site-project", isDirectory: true)
        try write(
            #"{ "version": "0.0.1", "configurations": [ { "name": "site", "runtimeExecutable": "juno:static", "cwd": "site" } ] }"#,
            to: ".juno/launch.json",
            in: root
        )
        try write("<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>", to: "site/index.html", in: root)
        previewKeys.append(PreviewKey(checkoutRoot: root, name: "site"))
        PreviewPage.backgroundHostMode = .offscreen
        return root
    }

    private static let settingsPage = """
        <!doctype html><html><head><title>Settings</title></head><body>
        <button id="menu" onclick="document.getElementById('panel').hidden = false">Open menu</button>
        <div id="panel" hidden>Menu</div></body></html>
        """

    private func goalRuntime(
        root: URL,
        model: ScenarioModel,
        store: CodeSessionStore,
        session: CodeSession,
        settings: AutonomySettings
    ) async throws -> AgentOrchestrator {
        await PreviewSessionHub.shared.observe(store: store, sessionID: session.id, workspaceRoot: root)
        let access = try WorkspaceAccess(workspaceID: try XCTUnwrap(session.workspaceID), grantedURL: root)
        let files = FileOperationService(
            access: access,
            checkpoints: CheckpointStore(directoryURL: base.appendingPathComponent("checkpoints-\(UUID().uuidString)"), access: access)
        )
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let services = PreviewToolServices(
            workspaceRoot: root,
            sessionID: session.id,
            permissions: permissions,
            evidenceDirectory: base.appendingPathComponent("evidence")
        )
        let goals = GoalRuntime(
            sessionID: session.id,
            store: store,
            judge: ModelCompletionJudge(model: model, modelID: "haiku", sessionID: session.id)
        )
        let advisor = PreviewLeaseModel().uiAdvisor(sessionID: session.id, workspaceRoot: root)
        return AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: [
                WriteFileTool(files: files),
                PreviewServerTool(services: services),
                PreviewBrowserTool(services: services),
                TodoWriteTool(),
            ]),
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(
                compactionSummary: nil,
                systemPrompt: "You are Alevr Code.",
                autonomy: AutonomyConfiguration(
                    settings: settings,
                    ledger: RunLedgerRecorder(sessionID: session.id, store: store),
                    goals: goals,
                    reportBuilder: VerifyRunReportBuilder(),
                    diffAvailable: false
                )
            ),
            modelID: "test-model",
            reasoningEffort: nil,
            // As the app builds it: Lane A's gate with the Preview's rule 8.
            completionGate: AutonomyGate(settings: settings, goals: goals, uiAdvisor: advisor)
        )
    }

    private func setUIGoal(_ store: CodeSessionStore, _ session: CodeSession) async throws {
        try await store.setGoal(GoalRun(
            objective: "Give the settings page a menu that opens on click",
            criteria: [
                GoalCriterion(id: "c1", text: "The settings page has a menu button"),
                // A route as the reader writes it; the Preview records the
                // page it navigated to (`/settings.html`).
                GoalCriterion(id: "c2", text: "The menu works at /settings", check: .ui(surface: .web, target: "/settings")),
            ]
        ), for: session.id)
    }

    /// The goal's UI criterion holds the goal open until the Preview has
    /// looked: with web checks on, the Preview's own rule sends the agent to
    /// look before the judge is ever asked; the evidence is minted by the
    /// runtime from the page, and only then does the judge's `met` complete
    /// the goal.
    func testScenario2AGoalWithAUICriterionWaitsForThePreview() async throws {
        let root = try previewSite()
        let store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        let session = try await newSession(store, mode: .fullAccess)
        try await setUIGoal(store, session)
        let model = ScenarioModel(
            [
                .calls([("write_file", ["path": "site/settings.html", "content": .string(Self.settingsPage)])]),
                .text("Done: the settings page has its menu."),          // the Preview has not looked yet
                .calls([("preview_server", ["action": "start"])]),
                .calls([("preview_browser", ["action": "navigate", "path": "/settings.html"])]),
                .calls([("preview_browser", ["action": "screenshot"])]),
                .text("Checked /settings.html in the Preview: the menu opens."),
            ],
            verdicts: ["met"]
        )
        let orchestrator = try await goalRuntime(
            root: root,
            model: model,
            store: store,
            session: session,
            settings: AutonomySettings(reviewBeforeFinish: .off)
        )

        try await orchestrator.submit(prompt: "Give the settings page a menu")
        await orchestrator.awaitCompletion()

        let events = await store.events(for: session.id).map(\.payload)
        let continued = events.compactMap { payload -> RunContinuedEvent? in
            if case let .runContinued(event) = payload { return event }
            return nil
        }
        XCTAssertEqual(continued.map(\.reason), [.gate(.uiUnchecked)])
        XCTAssertTrue(continued.first?.detail.contains("/settings") == true, continued.first?.detail ?? "")
        let records = events.compactMap { payload -> UIVerificationRecord? in
            if case let .uiVerificationRecorded(record) = payload { return record }
            return nil
        }
        let record = try XCTUnwrap(records.last, "the Preview minted the evidence")
        XCTAssertEqual(record.surface, .web)
        XCTAssertEqual(record.target, "/settings.html")
        XCTAssertTrue(record.passed, "\(record.checks)")
        XCTAssertNotNil(record.screenshotHash)
        XCTAssertEqual(model.judgeRequests.count, 1, "the judge was asked only once the Preview evidence existed")
        let verdicts = events.compactMap { payload -> GoalVerdictEvent? in
            if case let .goalVerdict(verdict) = payload { return verdict }
            return nil
        }
        XCTAssertEqual(verdicts.map(\.verdict), [.met])
        let goal = await store.currentGoalRun(for: session.id)
        XCTAssertEqual(goal?.status, .achieved)
        let outcome = try XCTUnwrap(events.compactMap { payload -> RunOutcomeEvent? in
            if case let .runOutcome(event) = payload { return event }
            return nil
        }.last)
        XCTAssertTrue(outcome.checks.contains { $0.label.hasPrefix("Preview /settings.html") && $0.passed }, "\(outcome.checks)")
    }

    /// With web checks off, the goal's own UI criterion is what blocks: the
    /// gate records `gate_blocked` naming c2 without asking the judge, and
    /// the Preview's evidence then lets the judge's `met` complete it.
    func testScenario2bTheGoalsUICriterionBlocksUntilTheEvidenceExists() async throws {
        let root = try previewSite()
        let store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        let session = try await newSession(store, mode: .fullAccess)
        try await setUIGoal(store, session)
        let model = ScenarioModel(
            [
                .calls([("write_file", ["path": "site/settings.html", "content": .string(Self.settingsPage)])]),
                .text("Done: the settings page has its menu."),          // blocked: no Preview evidence
                .calls([("preview_server", ["action": "start"])]),
                .calls([("preview_browser", ["action": "navigate", "path": "/settings.html"])]),
                .calls([("preview_browser", ["action": "screenshot"])]),
                .text("Checked /settings.html in the Preview."),
            ],
            verdicts: ["met"]
        )
        let orchestrator = try await goalRuntime(
            root: root,
            model: model,
            store: store,
            session: session,
            settings: AutonomySettings(reviewBeforeFinish: .off, autoVerify: AutoVerify(web: false))
        )

        try await orchestrator.submit(prompt: "Give the settings page a menu")
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

    /// An approval nobody answers for 20 minutes parks the run instead of
    /// denying it; the run monitor's banner carries the approval's id and
    /// digest; its Allow once answers through the workbench, digest-bound,
    /// as the app wires it; the run carries on and finishes.
    func testScenario3AnApprovalParkedForTwentyMinutesIsApprovedFromTheNotification() async throws {
        let model = ScenarioModel([
            .calls([("write_file", ["path": "notes.txt", "content": "Away from the keyboard\n"])]),
            .text("Wrote notes.txt."),
        ])
        let fixture = try await ShipFixture.make(
            model: model,
            files: [".juno/settings.json": #"{"autonomy": {"reviewBeforeFinish": "off"}}"# + "\n"],
            autonomy: true
        )
        defer { fixture.remove() }
        let (session, controller) = try await fixture.session(.askBeforeChanges)
        let workbench = fixture.workbench

        // The run monitor as the app installs it, over a recording sink.
        let suite = "juno.scenario.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: suite) }
        let preferences = StudioPreferences(store: defaults)
        let sink = RecordingNotificationSink()
        let monitor = StudioRunMonitor(sink: sink, preferences: { preferences })
        monitor.isAppActive = { false }
        monitor.sessionInView = { nil }
        monitor.install(responder: CodeNotificationResponder(
            open: { _ in },
            allowOnce: { id, approvalID, digest in
                _ = await workbench.allowOnce(sessionID: id, approvalID: approvalID, digest: digest)
            },
            decline: { id, approvalID, digest in
                _ = await workbench.decline(sessionID: id, approvalID: approvalID, digest: digest)
            }
        ))
        workbench.runIndexObserver = { entries in monitor.observeRuns(entries) }

        controller.composerText = "Write the notes file"
        await controller.send()
        var pending: ApprovalRequest?
        try await waitUntil {
            pending = await controller.live?.permissions.pendingApprovals.first
            return pending != nil
        }
        let request = try XCTUnwrap(pending)
        try await waitUntil { workbench.runEntries.contains { $0.approval?.id == request.id } }
        monitor.observeRuns(workbench.runEntries)

        // Twenty minutes later nobody has answered: parked, not denied.
        let due = await controller.live?.permissions.sweepExpired(now: request.requestedAt.addingTimeInterval(20 * 60))
        XCTAssertEqual(due?.map(\.id), [request.id])
        let stillPending = await controller.live?.permissions.pendingApprovals.map(\.id)
        XCTAssertEqual(stillPending, [request.id])
        XCTAssertTrue(controller.session.status.isActive, "the run waits; it did not end")

        // The banner the monitor posted carries the exact approval and digest,
        // and reminders at 15, 60 and 240 minutes are scheduled.
        let banner = try XCTUnwrap(sink.posted.first {
            $0.userInfo[CodeNotificationKey.approvalID] == request.id && $0.delay == nil
        }, "\(sink.posted.map(\.identifier))")
        XCTAssertEqual(banner.userInfo[CodeNotificationKey.digest], request.actionDigest)
        XCTAssertEqual(banner.userInfo[CodeNotificationKey.sessionID], session.id.value)
        let reminders = sink.posted.filter { $0.userInfo[CodeNotificationKey.approvalID] == request.id && $0.delay != nil }
        XCTAssertEqual(reminders.count, 3)

        // A banner whose digest is not the pending approval's answers nothing.
        var forged = banner.userInfo
        forged[CodeNotificationKey.digest] = String(repeating: "0", count: 64)
        await monitor.handle(actionIdentifier: CodeNotificationAction.allowOnce.rawValue, userInfo: forged, text: nil)
        let afterForged = await controller.live?.permissions.pendingApprovals.map(\.id)
        XCTAssertEqual(afterForged, [request.id], "a different digest carries nothing out")

        // The notification's Allow once answers the parked approval.
        await monitor.handle(actionIdentifier: CodeNotificationAction.allowOnce.rawValue, userInfo: banner.userInfo, text: nil)
        await controller.awaitCurrentRun()
        try await waitUntil { !controller.session.status.isActive }

        let written = try fixture.read("notes.txt")
        XCTAssertEqual(written, "Away from the keyboard\n")
        let events = await workbench.sessionStore.events(for: session.id)
        let ended = events.compactMap { event -> RunEndReason? in
            if case let .runCompleted(run) = event.payload { return run.endReason }
            return nil
        }
        XCTAssertEqual(ended, [.doneUnchecked])
        let resolutions = events.compactMap { event -> ApprovalResolvedEvent? in
            if case let .approvalResolved(resolved) = event.payload { return resolved }
            return nil
        }
        XCTAssertEqual(resolutions.map(\.decision), [.approved], "an unanswered approval is never turned into a no")
    }

    // MARK: 4. Quit mid-run

    /// Juno quits mid-batch; a relaunch restores the session from disk, the
    /// Runs list offers Resume, and Resume (Lane E's, through Lane A's
    /// `resume(note:)`) tells the model the call's outcome is unknown, adding
    /// no reader message.
    func testScenario4QuitMidBatchRestoreAndResume() async throws {
        let live = base.appendingPathComponent("store")
        let store = CodeSessionStore(directoryURL: live)
        let session = try await newSession(store, workspaceID: nil)
        let model = ScenarioModel([
            .calls([("scenario_migrate", [:])]),
        ])
        let settings = AutonomySettings.standard
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: [ScenarioHangingTool(), TodoWriteTool()]),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: AgentOrchestrator.Configuration(
                compactionSummary: nil,
                systemPrompt: "You are Alevr Code.",
                autonomy: AutonomyConfiguration(
                    settings: settings,
                    ledger: RunLedgerRecorder(sessionID: session.id, store: store)
                )
            ),
            modelID: "test-model",
            reasoningEffort: nil,
            completionGate: AutonomyGate(settings: settings)
        )
        try await orchestrator.submit(prompt: "Apply the migration")
        try await waitUntil {
            await store.events(for: session.id).contains {
                if case .toolStarted = $0.payload { return true } else { return false }
            }
        }

        // Juno quits mid-batch: what is on disk at this moment is all a
        // relaunch has.
        let relaunched = base.appendingPathComponent("relaunched")
        try FileManager.default.copyItem(at: live, to: relaunched)
        await orchestrator.stop()

        let reopened = CodeSessionStore(directoryURL: relaunched)
        let restored = try await reopened.session(id: session.id)
        XCTAssertEqual(restored.status, .failed, "a run Alevr quit in the middle of reads as interrupted")
        XCTAssertTrue(RunIndex.isInterrupted(restored), "the Runs list offers Resume")
        let resumeModel = ScenarioModel([.text("The migration's state is unknown; checking it first.")])
        let controller = SessionController(session: restored, context: nil, store: reopened, modelClient: resumeModel)
        await controller.attach()
        XCTAssertTrue(controller.isInterrupted)
        XCTAssertEqual(controller.interruptedCallSummaries, ["Apply the database migration"])

        let resumed = await controller.resumeInterrupted()
        XCTAssertTrue(resumed)
        await controller.awaitCurrentRun()
        try await waitUntil { !controller.session.status.isActive }

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
        XCTAssertTrue(note?.contains("reason=\"after_quit\"") == true, note ?? "no note")
        XCTAssertTrue(note?.contains("Apply the database migration") == true, note ?? "no note")
        XCTAssertEqual(request.messages.filter(\.isReaderMessage).count, 1, "no reader message is added")
        let prompts = await reopened.events(for: session.id).filter {
            if case .userPrompt = $0.payload { return true } else { return false }
        }
        XCTAssertEqual(prompts.count, 1)
    }
}
