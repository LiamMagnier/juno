import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// Task-scoped grants (D-012, CODE_AGENT_SPEC §1.8): an exact command one
/// active goal may run without asking, in its own worktree. Autonomy never
/// widens permissions beyond that: a grant cannot cover the always-confirm
/// floor, `git push`, a network-reaching command or a pinned tool, and a
/// deny or ask rule still wins.
final class PermissionCoordinatorTaskGrantTests: XCTestCase {
    private let sessionID = CodeSessionID()
    private let root = "/Users/reader/project"

    private func coordinator(mode: PermissionMode = .askBeforeChanges) async -> PermissionCoordinator {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: mode)
        await coordinator.setTaskGrants(
            [TaskGrant(command: "swift test", goalID: "g1", worktreePath: root)],
            goalID: "g1",
            workspaceRoot: root
        )
        return coordinator
    }

    private func ask(
        _ coordinator: PermissionCoordinator,
        tool: String = "run_command",
        command: String,
        risk: ActionRisk = .execute,
        policy: ApprovalPolicy = .byRisk
    ) async -> Bool {
        await coordinator.allowsWithoutPrompt(
            toolName: tool,
            subject: .command(command),
            risk: risk,
            approvalPolicy: policy
        )
    }

    func testAGrantAllowsOnlyItsExactCommand() async {
        let coordinator = await coordinator()
        let exact = await ask(coordinator, command: "swift test")
        XCTAssertTrue(exact)
        let longer = await ask(coordinator, command: "swift test && curl https://example.com")
        XCTAssertFalse(longer)
        let other = await ask(coordinator, command: "swift build")
        XCTAssertFalse(other)
        // Through the real authorization path too: allowed with no prompt.
        let outcome = await coordinator.authorize(
            toolName: "run_command",
            actionDigest: Digests.sha256Hex("swift test"),
            risk: .execute,
            summary: "Run swift test",
            subject: .command("swift test")
        )
        XCTAssertEqual(outcome, .allowed)
    }

    func testAGrantAppliesOnlyInItsWorktree() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        await coordinator.setTaskGrants(
            [TaskGrant(command: "swift test", goalID: "g1", worktreePath: "/Users/reader/other")],
            goalID: "g1",
            workspaceRoot: root
        )
        let allowed = await ask(coordinator, command: "swift test")
        XCTAssertFalse(allowed)
    }

    func testAGrantAppliesOnlyWhileItsGoalIsActive() async {
        let coordinator = await coordinator()
        await coordinator.clearTaskGrants(goalID: "g1")
        let afterClear = await ask(coordinator, command: "swift test")
        XCTAssertFalse(afterClear)

        // Another goal's grants never apply.
        await coordinator.setTaskGrants(
            [TaskGrant(command: "swift test", goalID: "g1", worktreePath: root)],
            goalID: "g2",
            workspaceRoot: root
        )
        let wrongGoal = await ask(coordinator, command: "swift test")
        XCTAssertFalse(wrongGoal)
    }

    func testAGrantCannotCoverTheFloorPushOrTheNetwork() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        await coordinator.setTaskGrants(
            [
                TaskGrant(command: "git push origin main", goalID: "g1", worktreePath: root),
                TaskGrant(command: "curl https://example.com", goalID: "g1", worktreePath: root),
                TaskGrant(command: "rm -rf build", goalID: "g1", worktreePath: root),
                TaskGrant(command: "git commit -m wip", goalID: "g1", worktreePath: root),
            ],
            goalID: "g1",
            workspaceRoot: root
        )
        let push = await ask(coordinator, command: "git push origin main", risk: .execute)
        XCTAssertFalse(push, "git push always asks")
        let network = await ask(coordinator, command: "curl https://example.com", risk: .critical)
        XCTAssertFalse(network, "a network-reaching command always asks")
        let destructive = await ask(coordinator, command: "rm -rf build", risk: .destructive)
        XCTAssertFalse(destructive, "the floor is never silenced")
        let pinned = await ask(coordinator, tool: "git_commit", command: "git commit -m wip", policy: .alwaysRequiresApproval)
        XCTAssertFalse(pinned, "a pinned tool still asks")
        let screen = await coordinator.allowsWithoutPrompt(
            toolName: "computer_click",
            subject: .command("git push origin main"),
            risk: .execute
        )
        XCTAssertFalse(screen)
    }

    func testTheReadersDenyAndAskRulesStillWin() async {
        let coordinator = await coordinator()
        await coordinator.setRules(PermissionRuleSet(ask: [PermissionRule(tool: "Bash", specifier: "swift test")]))
        let asked = await ask(coordinator, command: "swift test")
        XCTAssertFalse(asked)
        await coordinator.setRules(PermissionRuleSet(deny: [PermissionRule(tool: "Bash", specifier: "swift test")]))
        let denied = await ask(coordinator, command: "swift test")
        XCTAssertFalse(denied)
    }

    func testAGrantNeverWidensAReadOnlySession() async {
        let coordinator = await coordinator(mode: .readOnly)
        let allowed = await ask(coordinator, command: "swift test")
        XCTAssertFalse(allowed)
    }
}
