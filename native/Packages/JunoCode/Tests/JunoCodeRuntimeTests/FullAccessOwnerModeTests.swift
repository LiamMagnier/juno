import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// Full access as the owner chose it (2026-10-10): never ask about commands,
/// edits, git, tests, MCP tools or media inside the project folder; still ask,
/// and say why, about sudo, another machine, or a path outside the folder.
final class FullAccessOwnerModeTests: XCTestCase {
    private let sessionID = CodeSessionID()

    private func registry() -> ToolRegistry {
        ToolRegistry(tools: [RunCommandTool(executor: ScriptedCommandExecutor())])
    }

    func testRunCommandInsideTheProjectRunsWithNoApprovalRequest() async throws {
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let requested = LockedFlag()
        await permissions.addObserver { update in
            if case .requested = update { requested.set() }
        }
        let registry = registry()
        for command in ["npm install", "./scripts/test.sh", "swift build", "git commit -am wip", "rm -rf build", "curl -sL https://example.com -o vendor.json"] {
            try await registry.authorizeInvocation(toolName: "run_command", input: ["command": .string(command)], permissions: permissions)
        }
        XCTAssertFalse(requested.value, "Full access asked about a command inside the project")
        let pending = await permissions.pendingApprovals
        XCTAssertTrue(pending.isEmpty)
    }

    func testToolsPinnedBelowFullAccessRunWithoutAskingInFullAccess() {
        for risk in [ActionRisk.read, .write, .execute, .critical] {
            XCTAssertEqual(PermissionPolicy.ruling(mode: .fullAccess, risk: risk, approvalPolicy: .asksUnlessFullAccess), .allow, "\(risk)")
            XCTAssertEqual(PermissionPolicy.ruling(mode: .workspaceWrite, risk: risk, approvalPolicy: .asksUnlessFullAccess), .requireApproval, "\(risk)")
            XCTAssertEqual(PermissionPolicy.ruling(mode: .askBeforeChanges, risk: risk, approvalPolicy: .asksUnlessFullAccess), .requireApproval, "\(risk)")
        }
        XCTAssertEqual(PermissionPolicy.ruling(mode: .fullAccess, risk: .destructive, approvalPolicy: .asksUnlessFullAccess), .requireApproval)
        if case .deny = PermissionPolicy.ruling(mode: .readOnly, risk: .critical, approvalPolicy: .asksUnlessFullAccess) {} else {
            XCTFail("read-only still refuses")
        }
        // Screen control keeps asking in every mode: it acts on the whole Mac.
        XCTAssertEqual(PermissionPolicy.ruling(mode: .fullAccess, risk: .execute, approvalPolicy: .alwaysRequiresApproval), .requireApproval)
        // The owner's list: tests (git_commit and MCP are checked in ToolRegistryTests and MCPFoundationTests).
        XCTAssertEqual(RunTestsTool(tests: ScriptedTests(output: "")).approvalPolicy, .asksUnlessFullAccess)
    }

    func testOutsideTheProjectStillAsksAndSaysWhy() async throws {
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let registry = registry()
        for (command, why) in [
            ("ssh prod ls", "another machine"),
            ("cat ../secrets.env", "parent directory"),
            ("cp build.log ~/Desktop/", "home directory"),
        ] {
            let call = Task {
                try await registry.authorizeInvocation(toolName: "run_command", input: ["command": .string(command)], permissions: permissions)
            }
            var request: ApprovalRequest?
            while request == nil {
                await Task.yield()
                request = await permissions.pendingApprovals.first
            }
            let reason = try XCTUnwrap(request?.reason, command)
            XCTAssertTrue(reason.hasPrefix("Full access still asks: "), reason)
            XCTAssertTrue(reason.contains(why), "\(command): \(reason)")
            XCTAssertNil(request?.suggestedRule, "a destructive action is approved once only")
            await permissions.denyAll()
            _ = try? await call.value
        }
        // sudo is stricter still: the agent never runs it, in any mode.
        do {
            try await registry.authorizeInvocation(toolName: "run_command", input: ["command": "sudo rm -rf /etc/hosts"], permissions: permissions)
            XCTFail("sudo ran")
        } catch let ToolError.denied(reason) {
            XCTAssertTrue(reason.contains("sudo"), reason)
        }
    }

    func testTheGuardReasonReadsPlainly() {
        XCTAssertEqual(
            PermissionPolicy.guardReason(mode: .fullAccess, risk: .destructive, subject: .command("ssh prod ls")),
            "Full access still asks: 'ssh' acts on another machine."
        )
        XCTAssertEqual(
            PermissionPolicy.guardReason(mode: .workspaceWrite, risk: .destructive, subject: .path("/etc/hosts")),
            "Alevr asks in every mode: this touches /etc/hosts, outside the project folder."
        )
        XCTAssertNil(PermissionPolicy.guardReason(mode: .fullAccess, risk: .critical, subject: .command("npm install")))
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    func set() { lock.withLock { flag = true } }
    var value: Bool { lock.withLock { flag } }
}
