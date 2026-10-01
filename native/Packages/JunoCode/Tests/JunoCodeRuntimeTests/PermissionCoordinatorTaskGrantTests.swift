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

    /// The goal runtime moves a goal out of `active` on its own — met,
    /// judged impossible, out of budget, blocked by the agent, paused by
    /// Stop — without telling the coordinator. A grant is honoured only while
    /// the stored goal still says it applies, asked at the moment of the call.
    func testAGrantStopsTheMomentItsGoalLeavesActiveOnItsOwn() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-grant-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let store = CodeSessionStore(directoryURL: base)
        let session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Grants",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
        let coordinator = PermissionCoordinator(sessionID: session.id, mode: .askBeforeChanges)
        let sessionID = session.id
        await coordinator.setTaskGrantCheck { goalID in
            guard let goal = await store.currentGoalRun(for: sessionID), goal.id == goalID else { return false }
            return goal.grantsApply
        }
        let endings: [(GoalStatus, String?)] = [
            (.achieved, nil),
            (.impossible, "The component was removed"),
            (.budgetReached, "Used the budget"),
            (.needsYou, "Blocked: needs a decision"),
            (.paused, "Stopped by you"),
        ]
        for (ending, reason) in endings {
            var goal = GoalRun(objective: "Ship it")
            goal.grants = [TaskGrant(command: "swift test", goalID: goal.id, worktreePath: root)]
            try await store.setGoal(goal, for: session.id)
            await coordinator.setTaskGrants(goal.grants, goalID: goal.id, workspaceRoot: root)
            let whileActive = await ask(coordinator, command: "swift test")
            XCTAssertTrue(whileActive, "the grant applies while its goal is active")

            // The runtime, not the reader, ends it; the coordinator is not told.
            try await store.updateCurrentGoal(for: session.id, record: .status) { current in
                try current.transition(to: ending, reason: reason)
            }
            let after = await ask(coordinator, command: "swift test")
            XCTAssertFalse(after, "a \(ending.rawValue) goal grants nothing")
            let outcome = await withTaskGroup(of: AuthorizationOutcome?.self) { group in
                group.addTask {
                    await coordinator.authorize(
                        toolName: "run_command",
                        actionDigest: Digests.sha256Hex("swift test"),
                        risk: .execute,
                        summary: "Run swift test",
                        subject: .command("swift test")
                    )
                }
                group.addTask {
                    // The real path asks the reader again; answer no.
                    for _ in 0..<400 {
                        if let pending = await coordinator.pendingApprovals.first {
                            await coordinator.resolve(approvalID: pending.id, decision: .denied)
                            return nil
                        }
                        try? await Task.sleep(for: .milliseconds(5))
                    }
                    return nil
                }
                var result: AuthorizationOutcome?
                for await value in group where value != nil { result = value }
                return result
            }
            XCTAssertEqual(outcome, .denied(reason: "The user declined this action."), "the call asked the reader")
        }
    }

    /// A goal that waits only on one of its own run's approvals is still
    /// working toward its end: its grants keep applying.
    func testAGoalWaitingOnItsOwnApprovalKeepsItsGrants() {
        var goal = GoalRun(objective: "Ship it")
        XCTAssertTrue(goal.grantsApply)
        try? goal.transition(to: .needsYou, reason: GoalRun.approvalWaitPrefix + "Edit src/menu.ts")
        XCTAssertTrue(goal.grantsApply)
        try? goal.transition(to: .needsYou, reason: "Stopped after two turns without progress")
        XCTAssertFalse(goal.grantsApply)
        try? goal.transition(to: .paused, reason: "Paused by you")
        XCTAssertFalse(goal.grantsApply)
    }

    func testAGrantNeverWidensAReadOnlySession() async {
        let coordinator = await coordinator(mode: .readOnly)
        let allowed = await ask(coordinator, command: "swift test")
        XCTAssertFalse(allowed)
    }
}
