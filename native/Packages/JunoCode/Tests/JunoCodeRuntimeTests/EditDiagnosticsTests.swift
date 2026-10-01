import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// Diagnostics after an edit (CODE_AGENT_SPEC §5.13): the typecheck runs
/// unasked only when it is accepted, allowed without a prompt, and fast.
final class EditDiagnosticsTests: XCTestCase {
    private var base: URL!
    private var store: CodeSessionStore!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-diagnostics-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    private let recipe = VerifyRecipe(checks: [
        VerifyCheck(id: "web-typecheck", kind: .typecheck, run: .shell("npm run typecheck"), paths: ["src/**"]),
        VerifyCheck(id: "web-test", kind: .test, run: .shell("npm test"), paths: ["src/**"]),
    ])

    private func diagnostics(
        mode: PermissionMode = .workspaceWrite,
        allowed: Bool = true,
        accepted: Bool = true,
        executor: ScriptedCommandExecutor
    ) async throws -> (EditDiagnostics, VerificationLedger) {
        // A session of its own each time, so no earlier run's timing leaks in.
        let session = try await store.createSession(
            workspaceID: WorkspaceID(), workspaceName: "w", title: "Diagnostics",
            configuration: AgentConfiguration(modelID: "m"), gitBranch: nil
        )
        let ledger = await VerificationLedgers().ledger(for: session.id, store: store)
        let permissions = PermissionCoordinator(sessionID: session.id, mode: mode)
        if allowed { await permissions.setRules(PermissionRuleSet(allow: recipe.permissionRules)) }
        let runner = CheckRunner(executor: executor, permissions: permissions, ledger: ledger)
        let recipes = FixedRecipes(status: accepted ? .accepted(recipe) : .discovered(recipe))
        return (EditDiagnostics(recipes: recipes, runner: runner, ledger: ledger), ledger)
    }

    private func previousTypecheck(_ ledger: VerificationLedger, seconds: Double) async {
        await ledger.recordVerification(VerificationRecord(
            checkID: "web-typecheck", command: "npm run typecheck", kind: .typecheck, exitCode: 0, passed: true,
            workspaceRevision: 0, durationMs: Int(seconds * 1_000)
        ))
    }

    func testANewErrorComesBackAsAShortBlockAndIsRecorded() async throws {
        let executor = ScriptedCommandExecutor(["npm run typecheck": .init(exitCode: 2, output: "src/menu.tsx(41,5): error TS2322: Type 'string' is not assignable to type 'number'.\n")])
        let (diagnostics, ledger) = try await diagnostics(executor: executor)
        await previousTypecheck(ledger, seconds: 4)
        let block = await diagnostics.afterEdits(changedFiles: ["src/menu.tsx"])
        XCTAssertEqual(executor.commands, ["npm run typecheck"], "only the typecheck, never the tests")
        XCTAssertTrue(block?.hasPrefix("Diagnostics after your edit") ?? false)
        XCTAssertTrue(block?.contains("error TS2322") ?? false)
        XCTAssertLessThanOrEqual(block?.utf8.count ?? 0, EditDiagnostics.maximumBlockBytes + 40)
        XCTAssertEqual(ledger.verifications.last?.passed, false, "the run counts as a check")
    }

    func testACleanTypecheckSaysNothing() async throws {
        let executor = ScriptedCommandExecutor()
        let (diagnostics, ledger) = try await diagnostics(executor: executor)
        await previousTypecheck(ledger, seconds: 4)
        let block = await diagnostics.afterEdits(changedFiles: ["src/menu.tsx"])
        XCTAssertNil(block)
        XCTAssertEqual(executor.commands.count, 1)
    }

    func testItNeverRunsWhenItWouldAskWasSlowIsUnknownOrNotAccepted() async throws {
        for (allowed, accepted, seconds, files) in [
            (false, true, 4.0, ["src/a.ts"]),     // would prompt
            (true, true, 25.0, ["src/a.ts"]),     // slow last time
            (true, false, 4.0, ["src/a.ts"]),     // discovered, not accepted
            (true, true, 4.0, ["docs/a.md"]),     // no typecheck covers it
        ] {
            let executor = ScriptedCommandExecutor()
            let (diagnostics, ledger) = try await diagnostics(allowed: allowed, accepted: accepted, executor: executor)
            await previousTypecheck(ledger, seconds: seconds)
            let block = await diagnostics.afterEdits(changedFiles: files)
            XCTAssertNil(block)
            XCTAssertTrue(executor.commands.isEmpty, "allowed \(allowed), accepted \(accepted), \(seconds) s, \(files)")
        }
        // Never run before: its speed is unknown, so it waits for the model.
        let executor = ScriptedCommandExecutor()
        let (fresh, _) = try await diagnostics(executor: executor)
        let block = await fresh.afterEdits(changedFiles: ["src/a.ts"])
        XCTAssertNil(block)
        XCTAssertTrue(executor.commands.isEmpty)
    }

    func testFullAccessCountsAsAllowed() async throws {
        let executor = ScriptedCommandExecutor()
        let (diagnostics, ledger) = try await diagnostics(mode: .fullAccess, allowed: false, executor: executor)
        await previousTypecheck(ledger, seconds: 2)
        _ = await diagnostics.afterEdits(changedFiles: ["src/a.ts"])
        XCTAssertEqual(executor.commands, ["npm run typecheck"])
    }
}
