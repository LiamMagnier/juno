import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// Answers every approval the coordinator raises, and remembers what it was
/// asked: the stand-in for the reader.
private final class Approver: @unchecked Sendable {
    private let lock = NSLock()
    private var asked: [ApprovalRequest] = []
    private let decide: @Sendable (ApprovalRequest) -> ApprovalDecision

    init(_ decide: @escaping @Sendable (ApprovalRequest) -> ApprovalDecision = { _ in .approved }) {
        self.decide = decide
    }

    var requests: [ApprovalRequest] { lock.withLock { asked } }

    func attach(to permissions: PermissionCoordinator) async {
        await permissions.addObserver { [weak self, weak permissions] update in
            guard let self, case let .requested(request) = update else { return }
            self.lock.withLock { self.asked.append(request) }
            let decision = self.decide(request)
            Task { await permissions?.resolve(approvalID: request.id, decision: decision) }
        }
    }
}

/// `run_checks` (CODE_AGENT_SPEC §1.8): targeted and full scopes, each
/// command authorized on its own, evidence minted from what ran.
final class RunChecksToolTests: XCTestCase {
    private var base: URL!
    private var workspace: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!
    private var ledgers: VerificationLedgers!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-run-checks-\(UUID().uuidString)")
        workspace = base.appendingPathComponent("workspace")
        for path in ["apps/web/src/menu.tsx", "apps/web/src/menu.test.tsx", "apps/api/src/a.ts", "README.md"] {
            let url = workspace.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try "x".write(to: url, atomically: true, encoding: .utf8)
        }
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(), workspaceName: "Demo", title: "Checks",
            configuration: AgentConfiguration(modelID: "test-model"), gitBranch: nil
        )
        ledgers = VerificationLedgers()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    private func recipe() -> VerifyRecipe {
        VerifyRecipe(checks: [
            VerifyCheck(id: "web-typecheck", kind: .typecheck, run: .shell("npm run typecheck"), paths: ["apps/web/**"], cwd: "apps/web"),
            VerifyCheck(id: "web-test", kind: .test, run: .shell("npm test"), targeted: "npx vitest run {tests}", paths: ["apps/web/**"], cwd: "apps/web"),
            VerifyCheck(id: "api-test", kind: .test, run: .argv(["go", "test", "./..."]), paths: ["apps/api/**"], cwd: "apps/api"),
            VerifyCheck(id: "api-lint", kind: .lint, run: .argv(["go", "vet", "./..."]), paths: ["apps/api/**"], cwd: "apps/api"),
        ])
    }

    private func tool(
        executor: ScriptedCommandExecutor,
        permissions: PermissionCoordinator,
        status: VerifyRecipeStatus? = nil
    ) async -> (RunChecksTool, VerificationLedger) {
        let ledger = await ledgers.ledger(for: session.id, store: store)
        let tool = RunChecksTool(
            recipes: FixedRecipes(status: status ?? .accepted(recipe())),
            executor: executor,
            permissions: permissions,
            ledger: ledger,
            changes: nil,
            workspaceRoot: workspace
        )
        return (tool, ledger)
    }

    private func change(_ path: String) async throws {
        try await store.appendEvent(
            sessionID: session.id,
            payload: .fileChanged(FileChangedEvent(path: try WorkspacePath(path), kind: .modified, linesAdded: 1, linesRemoved: 0, checkpointID: nil))
        )
    }

    private func context() -> ToolContext {
        ToolContext(sessionID: session.id, toolCallID: "rc", emitOutput: { _, _ in })
    }

    private func records(_ result: ToolResult) -> [VerificationRecord] {
        result.sideEffects.compactMap {
            if case let .verificationRecorded(record) = $0 { return record }
            return nil
        }
    }

    func testTargetedRunsTheChangedPackagesChecksWithTheirTargetedCommand() async throws {
        let executor = ScriptedCommandExecutor()
        let (tool, ledger) = await tool(executor: executor, permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess))
        try await store.appendEvent(sessionID: session.id, payload: .userPrompt(UserPromptEvent(text: "fix the menu")))
        try await change("apps/web/src/menu.tsx")

        let result = try await tool.execute(input: [:], context: context())
        XCTAssertEqual(executor.commands, ["npm run typecheck", "npx vitest run src/menu.test.tsx"])
        XCTAssertEqual(executor.directories, ["apps/web", "apps/web"])
        XCTAssertEqual(records(result).map(\.checkID), ["web-typecheck", "web-test"])
        XCTAssertTrue(records(result).allSatisfy { $0.workspaceRevision == ledger.workspaceRevision && $0.passed })
        XCTAssertFalse(result.isError)
        XCTAssertTrue(result.content.hasPrefix("2 of 2 checks passed"), result.content)
    }

    func testFullRunsEveryCheckOfTheKindsAsked() async throws {
        let executor = ScriptedCommandExecutor(["go test ./...": .init(exitCode: 1, output: "--- FAIL: TestA\nFAIL\n")])
        let (tool, _) = await tool(executor: executor, permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess))
        let result = try await tool.execute(input: ["scope": "full", "kinds": ["test"]], context: context())
        XCTAssertEqual(executor.commands, ["npm test", "go test ./..."])
        XCTAssertTrue(result.isError, "a failing check makes the call an error the model reads")
        XCTAssertTrue(result.content.contains("api-test (test): go test ./... — failed (exit 1)"), result.content)
        XCTAssertTrue(result.content.contains("--- FAIL: TestA"), "the failing excerpt reaches the model")
        let failing = try XCTUnwrap(records(result).last)
        XCTAssertFalse(failing.passed)
        XCTAssertLessThanOrEqual(failing.excerpt.utf8.count, VerificationRecord.maximumExcerptBytes)
    }

    func testIdsPickExactlyThoseChecksAndUnknownIdsAreNamed() async throws {
        let executor = ScriptedCommandExecutor()
        let (tool, _) = await tool(executor: executor, permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess))
        _ = try await tool.execute(input: ["ids": ["api-lint"], "scope": "full"], context: context())
        XCTAssertEqual(executor.commands, ["go vet ./..."])
        do {
            _ = try await tool.execute(input: ["ids": ["nope"]], context: context())
            XCTFail("an unknown id is refused")
        } catch let ToolError.invalidInput(message) {
            XCTAssertTrue(message.contains("web-typecheck, web-test, api-test, api-lint"), message)
        }
    }

    func testEveryCommandIsAuthorizedSeparately() async throws {
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .workspaceWrite)
        let approver = Approver { $0.summary.contains("api-test") ? .denied : .approved }
        await approver.attach(to: permissions)
        let executor = ScriptedCommandExecutor()
        let (tool, _) = await tool(executor: executor, permissions: permissions)
        let result = try await tool.execute(input: ["scope": "full", "kinds": ["test", "lint"]], context: context())

        XCTAssertEqual(approver.requests.map(\.summary), [
            "Run check web-test in apps/web: npm test",
            "Run check api-test in apps/api: go test ./...",
            "Run check api-lint in apps/api: go vet ./...",
        ])
        XCTAssertTrue(approver.requests.allSatisfy { $0.toolName == "run_command" }, "asked as the command it is")
        XCTAssertEqual(executor.commands, ["npm test", "go vet ./..."], "the declined check never ran")
        XCTAssertTrue(result.content.contains("api-test (test): go test ./... — did not run: The user declined this action."))
        XCTAssertEqual(records(result).count, 2, "nothing is recorded for a check that did not run")
    }

    func testTheReadersRulesLetChecksRunWithoutAsking() async throws {
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .workspaceWrite)
        await permissions.setRules(PermissionRuleSet(allow: recipe().permissionRules))
        let approver = Approver()
        await approver.attach(to: permissions)
        let executor = ScriptedCommandExecutor()
        let (tool, ledger) = await tool(executor: executor, permissions: permissions)
        _ = try await tool.execute(input: ["scope": "full"], context: context())
        XCTAssertTrue(approver.requests.isEmpty, "every command was allowed by an exact rule")
        XCTAssertEqual(executor.commands.count, 4)

        // And the stop check may run them itself (§1.4 rule 6) …
        let runner = CheckRunner(executor: executor, permissions: permissions, ledger: ledger)
        let planned = try CheckRunner.plan(recipe: recipe(), scope: .full, changedFiles: [], fileExists: { _ in true })
        let allowed = await runner.allowedWithoutPrompt(planned)
        XCTAssertTrue(allowed)
        // … but not a command no rule covers.
        let other = PlannedCheck(check: VerifyCheck(id: "x", kind: .test, run: .shell("npm test -- --coverage")), commandLine: "npm test -- --coverage", isTargeted: false)
        let otherAllowed = await runner.allowedWithoutPrompt([other])
        XCTAssertFalse(otherAllowed)
    }

    /// As run_command refuses them: a check that never finishes would hold
    /// the run until its timeout, and a check row says where it ran.
    func testAServerIsNeverRunAsACheckAndRecordsSayWhereTheyRan() async throws {
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let executor = ScriptedCommandExecutor()
        let ledger = await ledgers.ledger(for: session.id, store: store)
        let runner = CheckRunner(executor: executor, permissions: permissions, ledger: ledger)
        let servers = [
            PlannedCheck(check: VerifyCheck(id: "dev", kind: .test, run: .shell("npm run dev")), commandLine: "npm run dev", isTargeted: false),
            PlannedCheck(check: VerifyCheck(id: "bg", kind: .test, run: .shell("npm test &")), commandLine: "npm test &", isTargeted: false),
        ]
        let mayRunUnasked = await runner.allowedWithoutPrompt(servers)
        XCTAssertFalse(mayRunUnasked, "the stop check sends the model rather than run what cannot finish, even in Full Access")
        let refused = await runner.runAndRecord(servers)
        XCTAssertTrue(executor.commands.isEmpty, "neither ran")
        XCTAssertTrue(refused.allSatisfy { $0.refusal?.contains("has to finish") ?? false })

        let planned = try CheckRunner.plan(recipe: recipe(), scope: .full, ids: ["api-test"], changedFiles: [], fileExists: { _ in true })
        let outcomes = await runner.runAndRecord(planned)
        XCTAssertEqual(outcomes.first?.record?.command, "cd apps/api && go test ./...")
    }

    /// A recipe can name anything. What does not read as a check is shown
    /// to the reader every time, as `run_tests` pins it, Full Access included,
    /// and the stop check never runs it on its own.
    func testARecipeCommandThatIsNotACheckAlwaysAsks() async throws {
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let approver = Approver { _ in .denied }
        await approver.attach(to: permissions)
        let executor = ScriptedCommandExecutor()
        let ledger = await ledgers.ledger(for: session.id, store: store)
        let runner = CheckRunner(executor: executor, permissions: permissions, ledger: ledger)
        let push = PlannedCheck(
            check: VerifyCheck(id: "ship", kind: .test, run: .shell("git push --force origin main")),
            commandLine: "git push --force origin main",
            isTargeted: false
        )
        let unasked = await runner.allowedWithoutPrompt([push])
        XCTAssertFalse(unasked)
        let outcomes = await runner.runAndRecord([push])
        XCTAssertEqual(approver.requests.map(\.summary), ["Run check ship: git push --force origin main"])
        XCTAssertEqual(approver.requests.first?.approvalPolicy, .alwaysRequiresApproval)
        XCTAssertTrue(executor.commands.isEmpty, "declined, so it never ran")
        XCTAssertNil(outcomes.first?.record)

        // A real check still follows the mode.
        let test = try CheckRunner.plan(recipe: recipe(), scope: .full, ids: ["api-test"], changedFiles: [], fileExists: { _ in true })
        _ = await runner.runAndRecord(test)
        XCTAssertEqual(approver.requests.count, 1, "Full Access runs a check without asking")
        XCTAssertEqual(executor.commands, ["go test ./..."])
    }

    func testTheStopChecksOwnRunsAreRecordedInTheSession() async throws {
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let executor = ScriptedCommandExecutor()
        let ledger = await ledgers.ledger(for: session.id, store: store)
        try await change("apps/api/src/a.ts")
        let runner = CheckRunner(executor: executor, permissions: permissions, ledger: ledger)
        let planned = try CheckRunner.plan(recipe: recipe(), scope: .targeted, ids: ["api-test"], changedFiles: ["apps/api/src/a.ts"], fileExists: { _ in true })
        let outcomes = await runner.runAndRecord(planned)
        XCTAssertEqual(outcomes.map(\.passed), [true])
        XCTAssertEqual(ledger.freshVerifications.map(\.checkID), ["api-test"])
    }

    func testWithoutAFileTheDiscoveredChecksRunAndSaySo() async throws {
        let executor = ScriptedCommandExecutor()
        let (tool, _) = await tool(
            executor: executor,
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            status: .discovered(recipe())
        )
        let result = try await tool.execute(input: ["ids": ["web-test"]], context: context())
        XCTAssertEqual(executor.commands, ["npm test"])
        XCTAssertTrue(result.content.contains("not saved yet"))
    }

    func testAChangedRecipeIsNotRunUntilAccepted() async throws {
        let executor = ScriptedCommandExecutor()
        let (tool, _) = await tool(
            executor: executor,
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            status: .awaitingAcceptance(recipe())
        )
        let result = try await tool.execute(input: ["scope": "full"], context: context())
        XCTAssertTrue(executor.commands.isEmpty)
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.contains("changed since the reader accepted it"))
    }

    func testAReadOnlySessionRunsNothing() async throws {
        let executor = ScriptedCommandExecutor()
        let (tool, _) = await tool(executor: executor, permissions: PermissionCoordinator(sessionID: session.id, mode: .readOnly))
        let result = try await tool.execute(input: ["scope": "full"], context: context())
        XCTAssertTrue(executor.commands.isEmpty, "run_checks never widens what the session may do")
        XCTAssertTrue(result.content.contains("did not run: The session is read-only."), result.content)
    }

    func testTheProviderOffersRunChecksAndTheSubagentControlsToCodeTurns() async throws {
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspace)
        let executor = CommandExecutionService(workspaceRootURL: workspace)
        let provider = VerificationToolProvider(
            recipes: { _ in FixedRecipes(status: .accepted(VerifyRecipe(checks: []))) },
            changes: { _ in nil },
            ledgers: ledgers
        )
        let context = CodeToolProviderContext(
            sessionID: session.id, workspaceID: access.workspaceID, workspaceRoot: workspace, behavior: .code,
            supportsVision: true, computerUseActive: false, store: store,
            permissions: PermissionCoordinator(sessionID: session.id, mode: .workspaceWrite),
            files: FileOperationService(access: access, checkpoints: CheckpointStore(directoryURL: base.appendingPathComponent("cp"), access: access)),
            executor: executor, git: GitService(executor: executor), tests: TestRunnerService(access: access, executor: executor)
        )
        let names = await ToolRegistry.providedTools(by: [provider], for: context).map(\.name)
        XCTAssertEqual(names, ["run_checks", "await_subagents", "inspect_subagent", "cancel_subagent"])
        let opened = await ledgers.existing(for: session.id)
        XCTAssertNotNil(opened, "the session's ledger is open for the command tools")
    }
}
