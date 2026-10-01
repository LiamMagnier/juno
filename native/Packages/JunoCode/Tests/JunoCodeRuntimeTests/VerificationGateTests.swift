import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// Lane B's recipe and check runner behind Lane A's stop check (the
/// integration seam, `VerificationGate.swift`): the gate runs a project check
/// itself only when nothing would ask, records it once, and never runs a
/// recipe command that is not a recognised check, Full access included.
final class VerificationGateTests: XCTestCase {
    private var base: URL!
    private var root: URL!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-verify-gate-\(UUID().uuidString)")
        root = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Sources"), withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    /// Edits a file and reports the change as the edit tools do.
    private struct EditTool: CodeTool {
        let name = "edit"
        let description = "Edits a file."
        let inputSchema: JSONValue = ["type": "object", "properties": [:]]
        func assessRisk(input _: JSONValue) -> ActionRisk { .read }
        func summary(input _: JSONValue) -> String { "Edit" }
        func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult {
            ToolResult(content: "edited", sideEffects: [.fileChanged(FileChangedEvent(
                path: try WorkspacePath("Sources/App.swift"),
                kind: .modified,
                linesAdded: 1,
                linesRemoved: 1,
                checkpointID: nil
            ))])
        }
    }

    /// Records every command and passes it.
    private final class Executor: CommandExecuting, @unchecked Sendable {
        private let lock = NSLock()
        private var lines: [String] = []
        var commands: [String] { lock.withLock { lines } }

        func stream(_ commandLine: String, timeoutSeconds _: Double, outputLimit _: OutputLimit) -> AsyncThrowingStream<CommandEvent, Error> {
            lock.withLock { lines.append(commandLine) }
            return AsyncThrowingStream { continuation in
                continuation.yield(.stdout("Executed 4 tests, with 0 failures (0 unexpected) in 0.1 (0.1) seconds\n"))
                continuation.yield(.completed(CommandResult(exitCode: 0, wasTimeout: false, wasCancelled: false, wasTruncated: false, durationSeconds: 1)))
                continuation.finish()
            }
        }
    }

    private final class Model: AgentModelClient, @unchecked Sendable {
        private let lock = NSLock()
        private var steps: [[ModelStreamEvent]]
        init(_ steps: [[ModelStreamEvent]]) { self.steps = steps }
        func streamTurn(_: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
            let events = lock.withLock { steps.isEmpty ? [.textDelta("Done."), .turnCompleted(.endTurn)] : steps.removeFirst() }
            return AsyncThrowingStream { continuation in
                for event in events { continuation.yield(event) }
                continuation.finish()
            }
        }
    }

    private struct Run {
        let continued: [GateReason]
        let records: [VerificationRecord]
        let ended: RunEndReason?
        let commands: [String]
    }

    private func run(check command: String, mode: PermissionMode) async throws -> Run {
        let recipes = VerifyRecipeStore(
            workspaceRoot: root,
            approvals: VerifyRecipeApprovalStore(directory: base.appendingPathComponent("approvals"))
        )
        try recipes.accept(
            VerifyRecipe(checks: [VerifyCheck(id: "check", kind: .test, run: .shell(command), paths: ["Sources/**"])]),
            runWithoutAsking: false
        )
        let store = CodeSessionStore(directoryURL: base.appendingPathComponent("store-\(UUID().uuidString)"))
        let session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "w",
            title: "t",
            configuration: AgentConfiguration(modelID: "m", permissionMode: mode),
            gitBranch: nil
        )
        let executor = Executor()
        let permissions = PermissionCoordinator(sessionID: session.id, mode: mode)
        let evidence = await VerificationLedgers.shared.ledger(for: session.id, store: store)
        let checks = CheckRunner(executor: executor, permissions: permissions, ledger: evidence)
        let settings = AutonomySettings(reviewBeforeFinish: .off)
        let recipe: @Sendable () async -> GateRecipe? = {
            await VerifyGateRecipe.make(status: await recipes.status()) { check in
                await checks.allowedWithoutPrompt([PlannedCheck(check: check, commandLine: check.commandLine, isTargeted: false)])
            }
        }
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: Model([
                [.toolCallRequested(id: "e1", name: "edit", input: [:]), .turnCompleted(.toolUse)],
                [.textDelta("Changed it."), .turnCompleted(.endTurn)],
                [.textDelta("Done."), .turnCompleted(.endTurn)],
            ]),
            registry: ToolRegistry(tools: [EditTool()]),
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(
                compactionSummary: nil,
                systemPrompt: "You are Juno Code.",
                autonomy: AutonomyConfiguration(
                    settings: settings,
                    ledger: RunLedgerRecorder(sessionID: session.id, store: store),
                    recipe: recipe,
                    checkRunner: VerifyGateCheckRunner(recipes: recipes, runner: checks),
                    reportBuilder: VerifyRunReportBuilder(),
                    diffAvailable: false
                )
            ),
            modelID: "m",
            reasoningEffort: nil,
            completionGate: AutonomyGate(settings: settings, recipe: recipe)
        )
        try await orchestrator.submit(prompt: "Change it")
        await orchestrator.awaitCompletion()
        let events = await store.events(for: session.id).map(\.payload)
        await VerificationLedgers.shared.release(session.id)
        return Run(
            continued: events.compactMap {
                if case let .runContinued(event) = $0, case let .gate(reason) = event.reason { return reason }
                return nil
            },
            records: events.compactMap { if case let .verificationRecorded(record) = $0 { return record } else { return nil } },
            ended: events.compactMap { if case let .runCompleted(run) = $0 { return run.endReason } else { return nil } }.last,
            commands: executor.commands
        )
    }

    func testTheGateRunsAnAllowedCheckItselfAndRecordsItOnce() async throws {
        let run = try await run(check: "swift test", mode: .fullAccess)
        XCTAssertEqual(run.commands, ["swift test"], "the stop check ran the project's check itself")
        XCTAssertEqual(run.records.count, 1, "recorded once, by the check runner, not again by the loop")
        XCTAssertEqual(run.records.first?.checkID, "check")
        XCTAssertTrue(run.continued.isEmpty, "\(run.continued)")
        XCTAssertEqual(run.ended, .doneChecked)
    }

    func testACheckThatWouldAskIsLeftToTheModel() async throws {
        let run = try await run(check: "swift test", mode: .askBeforeChanges)
        XCTAssertTrue(run.commands.isEmpty, "nothing ran without the reader")
        XCTAssertEqual(run.continued, [.unverified])
        XCTAssertEqual(run.ended, .doneUnchecked)
    }

    /// A recipe can name anything; only a recognised check may run unasked.
    /// `git push` in `verify.json` is never run by the stop check, even under
    /// Full access (the always-confirm floor).
    func testARecipeCommandThatIsNotACheckIsNeverRunByTheGate() async throws {
        let run = try await run(check: "git push origin main", mode: .fullAccess)
        XCTAssertTrue(run.commands.isEmpty, "\(run.commands)")
        XCTAssertTrue(run.records.isEmpty)
        XCTAssertEqual(run.continued, [.unverified])
    }

    /// The recipe maps onto the gate's: checks by id with their paths, web
    /// routes as UI targets, a native target only with the app it names.
    func testTheVerifyRecipeMapsOntoTheGateRecipe() async throws {
        let recipe = VerifyRecipe(
            checks: [VerifyCheck(id: "web-test", kind: .test, run: .shell("npm test"), paths: ["web/**"], cwd: "web")],
            ui: [
                VerifyUITarget(kind: .web, routes: ["/settings", "/"]),
                VerifyUITarget(kind: .ios),
                VerifyUITarget(kind: .ios, app: "com.example.app"),
            ]
        )
        let made = await VerifyGateRecipe.make(status: .accepted(recipe), runsWithoutPrompt: { _ in true })
        let gate = try XCTUnwrap(made)
        XCTAssertEqual(gate.checks.map(\.id), ["web-test"])
        XCTAssertEqual(gate.checks.first?.paths, ["web/**"])
        XCTAssertEqual(gate.checks.first?.runsWithoutPrompt, true)
        XCTAssertEqual(gate.ui.map(\.target), ["/settings", "/", "com.example.app"])
        XCTAssertEqual(gate.source, ".juno/verify.json")
        let discovered = await VerifyGateRecipe.make(status: .discovered(recipe), runsWithoutPrompt: { _ in false })
        XCTAssertEqual(discovered?.source, "what Juno found in this project, not saved yet")
        let awaiting = await VerifyGateRecipe.make(status: .awaitingAcceptance(recipe), runsWithoutPrompt: { _ in true })
        XCTAssertNil(awaiting, "a recipe edited since it was accepted offers nothing")
    }
}
