import XCTest
@testable import JunoCodeCore

/// Autonomy settings (CODE_AGENT_SPEC §1.6, D-018) and goals (§2.1–§2.2):
/// the defaults, how settings files layer — an unapproved project file may
/// lower the bounds and never raise them — the goal state machine, budgets,
/// verdict retention, and migrating the step-based goal.
final class AutonomySettingsTests: XCTestCase {
    func testTheDefaultsAreTheSpecsBounds() {
        let settings = AutonomySettings.standard
        XCTAssertEqual(settings.level, .standard, "D-018: on by default")
        XCTAssertEqual(settings.maxAutoContinues, 3)
        XCTAssertTrue(settings.runChecksAutomatically)
        XCTAssertEqual(settings.reviewBeforeFinish, .auto)
        XCTAssertEqual(settings.reviewThresholdLines, 40)
        XCTAssertEqual(settings.stepLimit, 200)
        XCTAssertEqual(settings.runBudget, Budget(minutes: 60))
        XCTAssertEqual(settings.goalBudget, Budget(minutes: 240, turns: 60, costUSD: 20))
        XCTAssertEqual(settings.checkInMinutes, 30)
        XCTAssertEqual(settings.autoVerify, AutoVerify(web: true, mac: false, ios: false))
        XCTAssertFalse(settings.resumeInterruptedGoalsOnLaunch, "D-025: resume on launch is off")
    }

    func testTheSettingsFileShapeDecodesWithEveryKeyOptional() throws {
        let json = """
            {"autonomy": {"level": "standard", "maxAutoContinues": 5, "reviewBeforeFinish": "always",
              "runBudget": {"minutes": 90}, "goalBudget": {"minutes": 240, "turns": 60, "costUSD": 20},
              "autoVerify": {"web": true, "mac": true}, "notAKey": 1, "stepLimit": "many"}}
            """
        let file = try JSONDecoder().decode(CodeSettingsFile.self, from: Data(json.utf8))
        let overrides = try XCTUnwrap(file.autonomy)
        XCTAssertEqual(overrides.maxAutoContinues, 5)
        XCTAssertEqual(overrides.reviewBeforeFinish, .always)
        XCTAssertNil(overrides.stepLimit, "a malformed value is ignored on its own")
        XCTAssertEqual(overrides.autoVerify, AutoVerify(web: true, mac: true, ios: false))
    }

    func testTheReadersOwnFileMayRaiseTheBounds() {
        let user = CodeSettingsLayer(
            CodeSettingsFile(autonomy: AutonomySettings.Overrides(maxAutoContinues: 8, stepLimit: 400, runBudget: Budget(minutes: 120))),
            origin: .user
        )
        let resolved = ResolvedCodeSettings.resolve([user]).autonomy
        XCTAssertEqual(resolved.maxAutoContinues, 8)
        XCTAssertEqual(resolved.stepLimit, 400)
        XCTAssertEqual(resolved.runBudget, Budget(minutes: 120))
    }

    func testAnUnapprovedProjectFileMayOnlyLowerTheBounds() {
        let project = CodeSettingsLayer(
            CodeSettingsFile(autonomy: AutonomySettings.Overrides(
                maxAutoContinues: 12,
                runChecksAutomatically: true,
                stepLimit: 1_000,
                runBudget: Budget(minutes: 600, costUSD: 1),
                goalBudget: Budget(),
                autoVerify: AutoVerify(web: false, mac: true, ios: true),
                resumeInterruptedGoalsOnLaunch: true
            )),
            origin: .project
        )
        let resolved = ResolvedCodeSettings.resolve([project]).autonomy
        XCTAssertEqual(resolved.maxAutoContinues, 3, "never more continuations")
        XCTAssertEqual(resolved.stepLimit, 200, "never more steps")
        XCTAssertEqual(resolved.runBudget, Budget(minutes: 60, costUSD: 1), "each ceiling the lower of the two")
        XCTAssertEqual(resolved.goalBudget, AutonomySettings.standard.goalBudget, "an unlimited budget is not lower")
        XCTAssertEqual(resolved.autoVerify, AutoVerify(web: false, mac: false, ios: false), "surfaces only turned off")
        XCTAssertFalse(resolved.resumeInterruptedGoalsOnLaunch)
        XCTAssertTrue(project.file.loosensAnything, "raising a bound needs the reader's approval")

        let lowering = CodeSettingsLayer(
            CodeSettingsFile(autonomy: AutonomySettings.Overrides(level: .off, maxAutoContinues: 1, stepLimit: 50)),
            origin: .project
        )
        let lowered = ResolvedCodeSettings.resolve([lowering]).autonomy
        XCTAssertEqual(lowered.level, .off)
        XCTAssertEqual(lowered.maxAutoContinues, 1)
        XCTAssertEqual(lowered.stepLimit, 50)
        XCTAssertFalse(lowering.file.loosensAnything, "lowering needs no approval")

        let approved = CodeSettingsLayer(project.file, origin: .project, isApproved: true)
        XCTAssertEqual(ResolvedCodeSettings.resolve([approved]).autonomy.maxAutoContinues, 12)
    }

    /// The turn limit is the soft step limit. A project file the reader has
    /// not approved may lower it, never raise it — neither through
    /// `agent.maxTurns` nor by naming `autonomy.stepLimit`, which must not
    /// set aside the reader's own lower turn limit.
    func testAnUnapprovedProjectFileCannotRaiseTheStepLimit() {
        let raiseTurns = CodeSettingsLayer(CodeSettingsFile(agent: CodeSettingsFile.Agent(maxTurns: 1_000)), origin: .project)
        let raised = ResolvedCodeSettings.resolve([raiseTurns])
        XCTAssertEqual(raised.maxTurns, 200)
        XCTAssertEqual(raised.autonomy.stepLimit, 200, "agent.maxTurns cannot raise the step limit")
        XCTAssertTrue(raiseTurns.file.loosensAnything, "raising the turn limit needs the reader's approval")

        let reader = CodeSettingsLayer(CodeSettingsFile(agent: CodeSettingsFile.Agent(maxTurns: 50)), origin: .user)
        let names = CodeSettingsLayer(
            CodeSettingsFile(autonomy: AutonomySettings.Overrides(stepLimit: 1_000)),
            origin: .project
        )
        XCTAssertEqual(
            ResolvedCodeSettings.resolve([reader, names]).autonomy.stepLimit, 50,
            "naming a step limit does not set aside the reader's 50 turns"
        )
        let lowers = CodeSettingsLayer(
            CodeSettingsFile(agent: CodeSettingsFile.Agent(maxTurns: 30), autonomy: AutonomySettings.Overrides(stepLimit: 40)),
            origin: .project
        )
        XCTAssertEqual(ResolvedCodeSettings.resolve([reader, lowers]).autonomy.stepLimit, 30, "lowering still works")

        let approved = CodeSettingsLayer(raiseTurns.file, origin: .project, isApproved: true)
        XCTAssertEqual(ResolvedCodeSettings.resolve([approved]).autonomy.stepLimit, 1_000)
    }

    func testTheStepLimitIsTheTurnLimitUnlessAFileNamesIt() {
        let turns = CodeSettingsLayer(CodeSettingsFile(agent: CodeSettingsFile.Agent(maxTurns: 120)), origin: .user)
        XCTAssertEqual(ResolvedCodeSettings.resolve([turns]).autonomy.stepLimit, 120)
        let both = CodeSettingsLayer(
            CodeSettingsFile(agent: CodeSettingsFile.Agent(maxTurns: 120), autonomy: AutonomySettings.Overrides(stepLimit: 300)),
            origin: .user
        )
        XCTAssertEqual(ResolvedCodeSettings.resolve([both]).autonomy.stepLimit, 300)
    }

    func testValuesAreClampedToSaneRanges() {
        let settings = AutonomySettings(maxAutoContinues: 99, stepLimit: 1, runBudget: Budget(minutes: 0))
        XCTAssertEqual(settings.maxAutoContinues, 12)
        XCTAssertEqual(settings.stepLimit, 10)
        XCTAssertEqual(settings.runBudget.minutes, 1)
    }

    // MARK: - Budgets

    func testKeepGoingAddsTheSameBudgetAgainAndUnlimitedStaysUnlimited() {
        XCTAssertEqual(Budget(minutes: 60, turns: nil).adding(Budget(minutes: 60)), Budget(minutes: 120))
        XCTAssertEqual(Budget(minutes: 240, turns: 60, costUSD: 20).sentence, "240 minutes, 60 turns and $20")
        XCTAssertNil(Budget().sentence)
        let usage = BudgetUsage(minutes: 30, turns: 61)
        XCTAssertEqual(usage.reached(Budget(minutes: 240, turns: 60)), .turns)
    }

    // MARK: - Goals

    func testTheGoalStateMachine() throws {
        var goal = GoalRun(objective: "Ship the importer", createdAt: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(goal.criteria.map(\.text), ["Ship the importer"], "the objective is the criterion when none was drafted")
        XCTAssertEqual(goal.criteria.first?.check, .judged)
        try goal.transition(to: .paused, reason: "Paused by you", at: Date(timeIntervalSince1970: 600))
        XCTAssertEqual(goal.usage.minutes, 10, accuracy: 0.001, "minutes count only while active")
        try goal.transition(to: .active, at: Date(timeIntervalSince1970: 3_600))
        try goal.transition(to: .needsYou, reason: "Waiting for you to allow `npm install`", at: Date(timeIntervalSince1970: 3_660))
        XCTAssertEqual(goal.usage.minutes, 11, accuracy: 0.001)
        try goal.transition(to: .active, at: Date(timeIntervalSince1970: 3_700))
        try goal.transition(to: .achieved, at: Date(timeIntervalSince1970: 3_760))
        XCTAssertThrowsError(try goal.transition(to: .active)) { error in
            XCTAssertEqual(error as? GoalTransitionError, .invalidTransition(from: .achieved, to: .active))
        }
        try goal.transition(to: .cleared)
        XCTAssertThrowsError(try goal.transition(to: .active))
    }

    func testABudgetReachedGoalKeepsGoingWithItsOriginalBudgetAdded() throws {
        var goal = GoalRun(objective: "Ship", budget: Budget(minutes: 30, turns: 10))
        try goal.transition(to: .budgetReached, reason: "Used the goal's 30-minute budget")
        try goal.keepGoing()
        XCTAssertEqual(goal.status, .active)
        XCTAssertEqual(goal.budget, Budget(minutes: 60, turns: 20))
        try goal.transition(to: .budgetReached)
        try goal.keepGoing()
        XCTAssertEqual(goal.budget, Budget(minutes: 90, turns: 30), "the original budget each time, not the raised one")
    }

    func testOnlyTheNewestTwentyVerdictsAreKept() {
        var goal = GoalRun(objective: "Ship")
        for index in 0..<25 {
            goal.record(GoalVerdict(kind: .notMet, reason: "try \(index)", revision: index))
        }
        XCTAssertEqual(goal.verdicts.count, 20)
        XCTAssertEqual(goal.olderVerdictCount, 5)
        XCTAssertEqual(goal.lastVerdict?.reason, "try 24")
        XCTAssertLessThanOrEqual(GoalVerdict(kind: .met, reason: String(repeating: "x", count: 500), revision: 0).reason.count, 300)
    }

    func testAStartCardDraftBindsItsTickedGrantsToTheGoalAndItsWorktree() {
        var draft = GoalDraft(objective: "Ship", criteria: [GoalCriterion(id: "c1", text: " ")], offeredGrants: ["swift test", "swift build"])
        draft.selectedGrants = ["swift test"]
        let goal = draft.goal(worktreePath: "/work/tree")
        XCTAssertEqual(goal.grants.map(\.command), ["swift test"], "unticked offers grant nothing")
        XCTAssertEqual(goal.grants.first?.goalID, goal.id)
        XCTAssertEqual(goal.grants.first?.worktreePath, "/work/tree")
        XCTAssertEqual(goal.criteria.map(\.text), ["Ship"], "an empty criterion is dropped")
    }

    func testAStepBasedGoalMigratesToAPausedOrAchievedGoal() throws {
        let now = Date(timeIntervalSince1970: 100)
        var legacy = SessionGoal(objective: "Ship the release", steps: [GoalStep(title: "Build", createdAt: now), GoalStep(title: "Test", createdAt: now)], createdAt: now)
        let open = GoalRun.migrated(from: legacy)
        XCTAssertEqual(open.id, legacy.id)
        XCTAssertEqual(open.status, .paused)
        XCTAssertEqual(GoalRun.todos(from: legacy).map(\.content), ["Build", "Test"])

        try legacy.apply(.setStepStatus(id: legacy.steps[0].id, status: .completed), at: now)
        try legacy.apply(.setStepStatus(id: legacy.steps[1].id, status: .completed), at: now)
        try legacy.apply(.addVerificationEvidence(summary: "12 tests passed", source: "swift test"), at: now)
        try legacy.apply(.setLifecycle(.completed), at: now)
        let done = GoalRun.migrated(from: legacy)
        XCTAssertEqual(done.status, .achieved)
        XCTAssertEqual(done.criteria.first?.evidence, ["12 tests passed"])
    }
}
