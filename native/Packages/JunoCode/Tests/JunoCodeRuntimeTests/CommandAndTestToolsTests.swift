import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// PV-11 and the `run_tests` pin (CODE_AGENT_SPEC §1.8, §4.8).
final class CommandAndTestToolsTests: XCTestCase {
    private let tool = RunCommandTool(executor: ScriptedCommandExecutor())

    private func refusal(_ command: String) -> String? {
        if case let .denied(reason)? = tool.precheck(input: ["command": .string(command)]) { return reason }
        return nil
    }

    // MARK: - PV-11

    func testChainsTestRunnersAndBuildsRun() {
        for command in [
            "cd web && npm test",
            "npm ci && npm run build",
            "vitest run",
            "npx vitest run src/menu.test.tsx",
            "vite build",
            "pnpm vite build",
            "npm test 2>&1",
            "grep -rn http.server docs",
            "echo 'serve the files'",
            "next build",
            "npm run lint && npm test",
        ] {
            XCTAssertNil(refusal(command), "\(command) was refused: \(refusal(command) ?? "")")
        }
    }

    func testServersAndWatchersAreStillRefusedWhereverTheySit() {
        for command in [
            "vite", "vite dev", "npx vite preview", "cd web && npm run dev", "npm start", "pnpm dev",
            "yarn dev", "bun run dev", "next dev", "npx next start", "python3 -m http.server 8000",
            "PORT=3000 npm run dev", "env PORT=3000 npm run dev", "npm run dev:web", "astro dev",
            "rails server", "flask run", "php -S localhost:8000", "npx serve -l 3000 .",
        ] {
            let reason = refusal(command)
            XCTAssertNotNil(reason, "\(command) was allowed")
            XCTAssertTrue(reason?.contains("open_preview") ?? false, command)
        }
    }

    func testATrailingAmpersandIsRefusedAndPointsAtTheDurableShells() {
        let reason = refusal("npm test &")
        XCTAssertNotNil(reason)
        XCTAssertTrue(reason?.contains("shell_start") ?? false)
        XCTAssertNil(refusal("npm test && echo ok"), "&& is not a background job")
    }

    // MARK: - run_tests

    private func recipe() -> VerifyRecipe {
        VerifyRecipe(checks: [VerifyCheck(id: "swift-test", kind: .test, run: .shell("swift test"))])
    }

    private func runTests(accepted: VerifyRecipe?) -> RunTestsTool {
        RunTestsTool(
            tests: ScriptedTests(output: ""),
            evidence: CheckEvidenceRecorder(recipes: FixedRecipes(status: accepted.map { .accepted($0) } ?? .discovered(VerifyRecipe(checks: []))))
        )
    }

    private func ruling(_ tool: RunTestsTool, _ command: String, mode: PermissionMode, rules: PermissionRuleSet = .empty) -> PermissionRuling {
        let input: JSONValue = ["command": .string(command)]
        return PermissionCoordinator.ruling(
            mode: mode,
            risk: tool.assessRisk(input: input),
            approvalPolicy: tool.approvalPolicy(input: input),
            rule: rules.evaluate(toolName: "run_tests", subject: .command(command))
        )
    }

    func testAnAcceptedRecipeCheckFollowsTheRulesLikeRunCommand() {
        let tool = runTests(accepted: recipe())
        XCTAssertEqual(tool.approvalPolicy(input: ["command": "swift test"]), .byRisk)
        XCTAssertEqual(tool.assessRisk(input: ["command": "swift test"]), .execute, "the classifier's risk, as run_command")
        XCTAssertEqual(ruling(tool, "swift test", mode: .fullAccess), .allow)
        XCTAssertEqual(ruling(tool, "swift test", mode: .workspaceWrite), .requireApproval)
        XCTAssertEqual(
            ruling(tool, "swift test", mode: .workspaceWrite, rules: PermissionRuleSet(allow: recipe().permissionRules)),
            .allow,
            "\"always allow swift test in this repo\" is simply a rule"
        )
    }

    func testItStillAsksUnderAsk() {
        let tool = runTests(accepted: recipe())
        XCTAssertEqual(ruling(tool, "swift test", mode: .askBeforeChanges), .requireApproval)
        XCTAssertEqual(ruling(tool, "swift test", mode: .readOnly), .deny(reason: "The session is read-only."))
    }

    func testAnyOtherCommandStaysPinned() {
        let tool = runTests(accepted: recipe())
        XCTAssertEqual(tool.approvalPolicy(input: ["command": "swift test --filter X"]), .alwaysRequiresApproval)
        XCTAssertEqual(tool.assessRisk(input: ["command": "swift test --filter X"]), .critical)
        XCTAssertEqual(ruling(tool, "swift test --filter X", mode: .fullAccess), .requireApproval, "Full access does not silence the pin")
        // A recipe entry that is not a check keeps the pin, whatever the file
        // calls it.
        let pushing = runTests(accepted: VerifyRecipe(checks: [VerifyCheck(id: "t", kind: .test, run: .shell("git push"))]))
        XCTAssertEqual(pushing.approvalPolicy(input: ["command": "git push"]), .alwaysRequiresApproval)
        XCTAssertEqual(ruling(pushing, "git push", mode: .fullAccess), .requireApproval)
        let noRecipe = runTests(accepted: nil)
        XCTAssertEqual(noRecipe.approvalPolicy(input: ["command": "swift test"]), .alwaysRequiresApproval,
                       "a discovered, unaccepted recipe unpins nothing")
    }

    func testTheRegistryAuthorizesWithThePerInputPolicy() async throws {
        let session = CodeSessionID()
        let permissions = PermissionCoordinator(sessionID: session, mode: .fullAccess)
        let registry = ToolRegistry(tools: [runTests(accepted: recipe())])
        // Accepted check: Full access runs it without asking.
        try await registry.authorizeInvocation(toolName: "run_tests", input: ["command": "swift test"], permissions: permissions)
        // Anything else asks; with nobody to answer, Stop denies it.
        let pending = Task {
            try await registry.authorizeInvocation(toolName: "run_tests", input: ["command": "make test"], permissions: permissions)
        }
        while await permissions.pendingApprovals.isEmpty { await Task.yield() }
        let first = await permissions.pendingApprovals.first
        let request = try XCTUnwrap(first)
        XCTAssertEqual(request.approvalPolicy, .alwaysRequiresApproval)
        await permissions.denyAll()
        do {
            try await pending.value
            XCTFail("expected a denial")
        } catch {}
    }
}
