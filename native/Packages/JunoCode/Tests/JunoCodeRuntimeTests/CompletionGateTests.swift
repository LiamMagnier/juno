import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// The stop check's rules in order (CODE_AGENT_SPEC §1.4): each one alone,
/// once per revision, the stall and continuation bounds, level `off`, waiting
/// on background work, and never continuing while the reader holds the next
/// move or in a mode that promises nothing runs.
final class CompletionGateTests: XCTestCase {
    private let gate = CompletionGate(settings: .standard)

    private func edited(_ paths: [String] = ["src/menu.ts"], lines: Int = 10) -> RunLedger {
        var ledger = RunLedger(stepAllowance: 200)
        for path in paths {
            ledger.absorb(.fileChanged(FileChangedEvent(
                path: try! WorkspacePath(path),
                kind: .modified,
                linesAdded: lines,
                linesRemoved: 0,
                checkpointID: nil
            )))
        }
        return ledger
    }

    private func check(_ command: String = "npm test", passed: Bool, excerpt: String = "") -> SessionEventPayload {
        .verificationRecorded(VerificationRecord(
            command: command,
            kind: .test,
            exitCode: passed ? 0 : 1,
            passed: passed,
            workspaceRevision: 0,
            durationMs: 1_200,
            excerpt: excerpt
        ))
    }

    private let recipe = GateRecipe(checks: [
        GateRecipeCheck(id: "web-test", kind: .test, command: "npm test", paths: ["src/**"]),
    ])

    private func decision(_ step: GateStep) -> GateDecision? {
        if case let .decided(decision) = step { return decision }
        return nil
    }

    private func reason(_ step: GateStep) -> GateReason? {
        switch step {
        case let .decided(.continueWith(reason, _)), let .goalBlocked(.continueWith(reason, _), _, _):
            return reason
        default:
            return nil
        }
    }

    // MARK: - Rule 1: off

    func testLevelOffOnlyReports() {
        var ledger = edited()
        ledger.absorb(.todosUpdated(TodoListEvent(items: [TodoItem(id: "1", content: "Write it", status: .pending)])))
        let off = CompletionGate(settings: AutonomySettings(level: .off))
        XCTAssertEqual(decision(off.evaluate(ledger, recipe: recipe, goal: nil)), .finish(.doneUnchecked))
    }

    // MARK: - Rule 2: background work

    func testBackgroundWorkMakesTheRunWait() {
        let step = gate.evaluate(edited(), recipe: recipe, goal: nil, situation: GateSituation(backgroundWork: ["xcodebuild test"]))
        XCTAssertEqual(decision(step), .wait)
    }

    // MARK: - Rule 3: stall

    func testTwoContinuationTurnsWithoutAToolCallStall() {
        var ledger = edited()
        ledger.continuations = [ContinuationRecord(reason: .todosOpen, detail: "x", revision: 0, turnIndex: 1)]
        ledger.turnsSinceToolCall = 2
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: recipe, goal: nil)), .finish(.stalled))
    }

    func testOneTurnWithoutAToolCallIsNotYetAStall() {
        var ledger = edited()
        ledger.absorb(.todosUpdated(TodoListEvent(items: [TodoItem(id: "1", content: "Write it", status: .pending)])))
        ledger.continuations = [ContinuationRecord(reason: .unverified, detail: "x", revision: 0, turnIndex: 1)]
        ledger.turnsSinceToolCall = 1
        XCTAssertEqual(reason(gate.evaluate(ledger, recipe: recipe, goal: nil)), .todosOpen)
    }

    // MARK: - Rule 4: continuation budget

    func testMaxAutoContinuesEndsTheRunWithTheVerdict() {
        var ledger = edited()
        ledger.absorb(.todosUpdated(TodoListEvent(items: [TodoItem(id: "1", content: "Write it", status: .pending)])))
        ledger.continuations = (0..<3).map {
            ContinuationRecord(reason: .unverified, detail: "x", revision: $0, turnIndex: $0)
        }
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: recipe, goal: nil)), .finish(.doneUnchecked))
    }

    func testAnActiveGoalLiftsTheContinuationLimit() {
        var ledger = edited()
        ledger.absorb(.todosUpdated(TodoListEvent(items: [TodoItem(id: "1", content: "Write it", status: .pending)])))
        ledger.continuations = (0..<5).map {
            ContinuationRecord(reason: .goalNotMet, detail: "x", revision: $0 + 10, turnIndex: $0)
        }
        let goal = GoalRun(objective: "Ship the menu")
        XCTAssertEqual(reason(gate.evaluate(ledger, recipe: recipe, goal: goal)), .todosOpen)
    }

    // MARK: - Rule 5: todos

    func testOpenTodosSendTheAgentBackNamingThem() {
        var ledger = RunLedger()
        ledger.absorb(.todosUpdated(TodoListEvent(items: [
            TodoItem(id: "1", content: "Add the migration", status: .completed),
            TodoItem(id: "2", content: "Update the docs", status: .inProgress),
            TodoItem(id: "3", content: "Ask about the API", status: .blocked, reason: "needs a decision"),
        ])))
        guard case let .decided(.continueWith(reason, detail)) = gate.evaluate(ledger, recipe: nil, goal: nil) else {
            return XCTFail("expected a continuation")
        }
        XCTAssertEqual(reason, .todosOpen)
        XCTAssertTrue(detail.contains("1 todo was still open"))
        XCTAssertTrue(detail.contains("Update the docs"))
        XCTAssertFalse(detail.contains("Ask about the API"), "a blocked item with a reason is not open")
    }

    func testBlockedTodosClearTheRuleAndEndBlocked() {
        var ledger = RunLedger()
        ledger.absorb(.todosUpdated(TodoListEvent(items: [
            TodoItem(id: "1", content: "Ask about the API", status: .blocked, reason: "needs a decision"),
        ])))
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: nil, goal: nil)), .finish(.blocked))
    }

    func testAReasonFiresOncePerRevision() {
        var ledger = RunLedger()
        ledger.absorb(.todosUpdated(TodoListEvent(items: [TodoItem(id: "1", content: "Write it", status: .pending)])))
        ledger.continuations = [ContinuationRecord(reason: .todosOpen, detail: "x", revision: ledger.workspaceRevision, turnIndex: 1)]
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: nil, goal: nil)), .finish(.doneUnchecked))
        // A later edit is a new state: the same reason may fire again.
        ledger.absorb(.fileChanged(FileChangedEvent(path: try! WorkspacePath("a.txt"), kind: .modified, linesAdded: 1, linesRemoved: 0, checkpointID: nil)))
        XCTAssertEqual(reason(gate.evaluate(ledger, recipe: nil, goal: nil)), .todosOpen)
    }

    // MARK: - Rule 6: unverified

    func testChangedFilesWithoutAFreshCheckAskTheModelToRunIt() {
        guard case let .decided(.continueWith(reason, detail)) = gate.evaluate(edited(), recipe: recipe, goal: nil) else {
            return XCTFail("expected a continuation")
        }
        XCTAssertEqual(reason, .unverified)
        XCTAssertTrue(detail.contains("`npm test`"))
    }

    func testAPassBeforeTheLastEditDoesNotCount() {
        var ledger = RunLedger()
        ledger.absorb(check(passed: true))
        ledger.absorb(.fileChanged(FileChangedEvent(path: try! WorkspacePath("src/menu.ts"), kind: .modified, linesAdded: 3, linesRemoved: 1, checkpointID: nil)))
        XCTAssertNil(ledger.latestFreshVerification)
        XCTAssertEqual(reason(gate.evaluate(ledger, recipe: recipe, goal: nil)), .unverified)
    }

    func testAChecksTheRuntimeMayRunWithoutAPromptIsRunByTheRuntime() {
        let allowed = GateRecipe(checks: [
            GateRecipeCheck(id: "web-test", kind: .test, command: "npm test", paths: ["src/**"], runsWithoutPrompt: true),
        ])
        let step = gate.evaluate(edited(), recipe: allowed, goal: nil, situation: GateSituation(checkRunnerAvailable: true))
        XCTAssertEqual(decision(step), .runCheck(checkIDs: ["web-test"]))
        // Not twice for the same state.
        var ran = edited()
        ran.autoCheckRevisions = [ran.workspaceRevision]
        XCTAssertEqual(reason(gate.evaluate(ran, recipe: allowed, goal: nil, situation: GateSituation(checkRunnerAvailable: true))), .unverified)
    }

    func testAPromptedCheckIsNeverRunByTheRuntime() {
        let step = gate.evaluate(edited(), recipe: recipe, goal: nil, situation: GateSituation(checkRunnerAvailable: true))
        XCTAssertEqual(reason(step), .unverified, "a check that would prompt is the model's to run, with its approval")
    }

    func testNoKnownCheckMeansNoLoopAndAnUncheckedVerdict() {
        var settings = AutonomySettings.standard
        settings.reviewBeforeFinish = .off
        let step = CompletionGate(settings: settings).evaluate(edited(), recipe: nil, goal: nil)
        XCTAssertEqual(decision(step), .finish(.doneUnchecked))
    }

    func testAFileNoCheckCoversDoesNotLoop() {
        var settings = AutonomySettings.standard
        settings.reviewBeforeFinish = .off
        let step = CompletionGate(settings: settings).evaluate(edited(["docs/readme.md"]), recipe: recipe, goal: nil)
        XCTAssertEqual(decision(step), .finish(.doneUnchecked))
    }

    // MARK: - Rule 7: checks failing

    func testAFailingFreshCheckSendsTheAgentBackOnce() {
        var ledger = edited()
        ledger.absorb(check(passed: false, excerpt: "FAIL SettingsMenu.test.tsx:41 expected menu to be open"))
        guard case let .decided(.continueWith(reason, detail)) = gate.evaluate(ledger, recipe: recipe, goal: nil) else {
            return XCTFail("expected a continuation")
        }
        XCTAssertEqual(reason, .checksFailing)
        XCTAssertTrue(detail.contains("SettingsMenu.test.tsx:41"))
        ledger.continuations.append(ContinuationRecord(
            reason: .checksFailing,
            detail: detail,
            revision: ledger.workspaceRevision,
            turnIndex: 2,
            signature: CompletionGate.signature(of: ledger.verifications.last!)
        ))
        var noReview = AutonomySettings.standard
        noReview.reviewBeforeFinish = .off
        XCTAssertEqual(decision(CompletionGate(settings: noReview).evaluate(ledger, recipe: recipe, goal: nil)), .finish(.checksFailing))
    }

    func testTheSameFailureTwiceInARowDoesNotFireAgain() {
        var ledger = edited()
        ledger.absorb(check(passed: false, excerpt: "error: expected 2, got 3"))
        let signature = CompletionGate.signature(of: ledger.verifications.last!)
        ledger.continuations.append(ContinuationRecord(reason: .checksFailing, detail: "x", revision: ledger.workspaceRevision, turnIndex: 1, signature: signature))
        // A later edit, the same check failing the same way.
        ledger.absorb(.fileChanged(FileChangedEvent(path: try! WorkspacePath("src/menu.ts"), kind: .modified, linesAdded: 1, linesRemoved: 1, checkpointID: nil)))
        ledger.absorb(check(passed: false, excerpt: "error: expected 2, got 3"))
        var noReview = AutonomySettings.standard
        noReview.reviewBeforeFinish = .off
        let step = CompletionGate(settings: noReview).evaluate(ledger, recipe: recipe, goal: nil)
        XCTAssertEqual(decision(step), .finish(.checksFailing))
        // A different failure at a later revision fires again.
        ledger.absorb(.fileChanged(FileChangedEvent(path: try! WorkspacePath("src/menu.ts"), kind: .modified, linesAdded: 1, linesRemoved: 1, checkpointID: nil)))
        ledger.absorb(check(passed: false, excerpt: "error: menu is undefined"))
        XCTAssertEqual(reason(CompletionGate(settings: noReview).evaluate(ledger, recipe: recipe, goal: nil)), .checksFailing)
    }

    func testAFreshPassEndsChecked() {
        var ledger = edited()
        ledger.absorb(check(passed: true))
        ledger.recordDiffRead()
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: recipe, goal: nil)), .finish(.doneChecked))
    }

    // MARK: - Rule 8: UI unchecked

    func testAUIChangeWithAutoVerifyAndNoFreshUICheckAsksForOne() {
        let ui = GateRecipe(checks: [], ui: [GateUITarget(surface: .web, target: "/settings")])
        let step = gate.evaluate(edited(["src/components/SettingsMenu.tsx"]), recipe: ui, goal: nil)
        guard case let .decided(.continueWith(reason, detail)) = step else { return XCTFail("expected a continuation") }
        XCTAssertEqual(reason, .uiUnchecked)
        XCTAssertTrue(detail.contains("/settings"))
    }

    func testAFreshUICheckSatisfiesIt() {
        let ui = GateRecipe(checks: [], ui: [GateUITarget(surface: .web, target: "/settings")])
        var ledger = edited(["src/components/SettingsMenu.tsx"])
        ledger.absorb(.uiVerificationRecorded(UIVerificationRecord(surface: .web, target: "/settings", checks: [], passed: true, workspaceRevision: 0)))
        ledger.recordDiffRead()
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: ui, goal: nil)), .finish(.doneUnchecked))
    }

    func testAutoVerifyOffForASurfaceSkipsIt() {
        let ui = GateRecipe(checks: [], ui: [GateUITarget(surface: .mac, target: "Juno")])
        var ledger = edited(["Sources/App/View.swift"])
        ledger.recordDiffRead()
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: ui, goal: nil)), .finish(.doneUnchecked))
    }

    func testUIChangeTriggerRules() {
        let web = GateUITarget(surface: .web, target: "/", root: "web")
        XCTAssertTrue(UIChangeTrigger.isUIChange("web/src/App.tsx", for: web))
        XCTAssertTrue(UIChangeTrigger.isUIChange("web/public/logo.svg", for: web))
        XCTAssertFalse(UIChangeTrigger.isUIChange("server/index.ts", for: web))
        XCTAssertFalse(UIChangeTrigger.isUIChange("web/README.md", for: web))
    }

    // MARK: - Rule 9: diff unreviewed

    func testASmallUnreadDiffAsksForADiffRead() {
        var ledger = edited(lines: 5)
        ledger.absorb(check(passed: true))
        XCTAssertEqual(reason(gate.evaluate(ledger, recipe: recipe, goal: nil)), .diffUnreviewed)
    }

    func testALargeDiffRunsTheReviewerWhenThereIsOne() {
        var ledger = edited(lines: 41)
        ledger.absorb(check(passed: true))
        let step = gate.evaluate(ledger, recipe: recipe, goal: nil, situation: GateSituation(reviewerAvailable: true))
        XCTAssertEqual(decision(step), .runReview)
        // 40 lines and two files is below the threshold.
        var small = edited(["src/a.ts", "src/b.ts"], lines: 20)
        small.absorb(check(passed: true))
        XCTAssertEqual(reason(gate.evaluate(small, recipe: recipe, goal: nil, situation: GateSituation(reviewerAvailable: true))), .diffUnreviewed)
        // Three files is over it.
        var three = edited(["src/a.ts", "src/b.ts", "src/c.ts"], lines: 1)
        three.absorb(check(passed: true))
        XCTAssertEqual(decision(gate.evaluate(three, recipe: recipe, goal: nil, situation: GateSituation(reviewerAvailable: true))), .runReview)
    }

    func testNoDiffReadIsAskedForWhereThereIsNoRepository() {
        var ledger = edited()
        ledger.absorb(check(passed: true))
        let step = gate.evaluate(ledger, recipe: recipe, goal: nil, situation: GateSituation(diffReadable: false))
        XCTAssertEqual(decision(step), .finish(.doneChecked), "git_diff cannot run outside a repository")
    }

    func testAFreshDiffReadSatisfiesIt() {
        var ledger = edited()
        ledger.absorb(check(passed: true))
        ledger.recordToolCall(named: "git_diff", succeeded: true)
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: recipe, goal: nil)), .finish(.doneChecked))
    }

    // MARK: - Rule 10: review findings

    func testBlockingFindingsSendTheAgentBack() {
        var ledger = edited()
        ledger.absorb(check(passed: true))
        ledger.absorb(.reviewCompleted(ReviewRecord(
            round: 1,
            findings: [ReviewFinding(priority: .p1, confidence: 0.8, path: "src/menu.ts", line: 41, title: "Menu closes on the same pointerdown")],
            overall: .incorrect,
            workspaceRevision: 0
        )))
        guard case let .decided(.continueWith(reason, detail)) = gate.evaluate(ledger, recipe: recipe, goal: nil) else {
            return XCTFail("expected a continuation")
        }
        XCTAssertEqual(reason, .reviewFindings)
        XCTAssertTrue(detail.contains("src/menu.ts:41"))
    }

    func testStyleNotesAloneDoNotSendTheAgentBack() {
        var ledger = edited()
        ledger.absorb(check(passed: true))
        ledger.absorb(.reviewCompleted(ReviewRecord(
            round: 1,
            findings: [ReviewFinding(priority: .p3, confidence: 0.9, title: "Unused prop")],
            overall: .correct,
            workspaceRevision: 0
        )))
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: recipe, goal: nil)), .finish(.doneChecked))
    }

    // MARK: - Rule 11: goal

    func testAGoalWithEveryRulePassedAsksTheJudge() {
        var ledger = edited()
        ledger.absorb(check(passed: true))
        ledger.recordDiffRead()
        XCTAssertEqual(gate.evaluate(ledger, recipe: recipe, goal: GoalRun(objective: "Ship")), .judge)
    }

    func testAPausedGoalIsNotEvaluated() {
        var ledger = edited()
        ledger.absorb(check(passed: true))
        ledger.recordDiffRead()
        let paused = GoalRun(objective: "Ship", status: .paused)
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: recipe, goal: paused)), .finish(.doneChecked))
    }

    // MARK: - Never continue

    func testNeverContinuesWhileTheReaderHoldsTheNextMove() {
        var ledger = RunLedger()
        ledger.absorb(.todosUpdated(TodoListEvent(items: [TodoItem(id: "1", content: "Write it", status: .pending)])))
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: nil, goal: nil, situation: GateSituation(pendingApproval: true))), .finish(.needsYou))
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: nil, goal: nil, situation: GateSituation(pendingQuestion: true))), .finish(.needsYou))
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: nil, goal: nil, situation: GateSituation(pendingSteer: true))), .finish(.doneUnchecked))
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: nil, goal: nil, situation: GateSituation(stoppedByReader: true))), .finish(.stopped))
        XCTAssertEqual(decision(gate.evaluate(ledger, recipe: nil, goal: nil, situation: GateSituation(planLimitReached: true))), .finish(.doneUnchecked))
    }

    func testNeverContinuesInPlanOrAsk() {
        var ledger = RunLedger()
        ledger.absorb(.todosUpdated(TodoListEvent(items: [TodoItem(id: "1", content: "Write it", status: .pending)])))
        for behavior in [AgentBehavior.plan, .ask, .survey] {
            let step = gate.evaluate(ledger, recipe: nil, goal: GoalRun(objective: "Ship"), situation: GateSituation(behavior: behavior))
            XCTAssertEqual(decision(step), .finish(.doneUnchecked), "\(behavior)")
        }
    }

    // MARK: - The continuation text

    func testEveryContinuationIsFencedImperativeAndShort() {
        for reason in GateReason.allCases {
            let note = RuntimeContinuation.note(for: reason, detail: String(repeating: "a long fact ", count: 80), revision: 14)
            XCTAssertLessThanOrEqual(note.text.count, RuntimeContinuation.maximumCharacters, "\(reason)")
            XCTAssertTrue(RuntimeNote.isRuntimeNote(note.rendered))
            XCTAssertTrue(note.rendered.hasPrefix("<juno_runtime reason=\"\(reason.rawValue)\" revision=\"14\">"))
        }
        let goal = GoalRun(id: "g3", objective: "Ship")
        let goalNote = RuntimeContinuation.goalContinuation(goal: goal, reason: "c2 has no Preview evidence", turn: 8, revision: 14)
        XCTAssertTrue(goalNote.rendered.hasPrefix("<juno_runtime reason=\"goal_not_met\" revision=\"14\" goal=\"g3\" turn=\"8\">"))
        XCTAssertTrue(goalNote.text.contains("Effort, intent and a plausible summary are not evidence."))
        XCTAssertLessThanOrEqual(goalNote.text.count, RuntimeContinuation.maximumCharacters)
    }

    // MARK: - The ledger

    func testTheLedgerStampsEvidenceWithTheRevisionItWasTakenInAt() {
        var ledger = RunLedger()
        ledger.absorb(check(passed: true))
        XCTAssertEqual(ledger.verifications.last?.workspaceRevision, 0)
        ledger.absorb(.fileChanged(FileChangedEvent(path: try! WorkspacePath("a.swift"), kind: .modified, linesAdded: 2, linesRemoved: 1, checkpointID: nil)))
        ledger.absorb(.testRunCompleted(TestRunCompletedEvent(command: "swift test", passed: false, testsRun: 4, failures: 1, durationSeconds: 3)))
        XCTAssertEqual(ledger.workspaceRevision, 1)
        XCTAssertEqual(ledger.verifications.last?.workspaceRevision, 1)
        XCTAssertEqual(ledger.verifications.last?.excerpt, "1 failure")
        XCTAssertEqual(ledger.linesChanged, 3)
        XCTAssertEqual(ledger.verdict, .checksFailing)
    }

    func testARunBudgetIsReachedByMinutesAndRaisedByKeepGoing() {
        let start = Date(timeIntervalSince1970: 1_000)
        var ledger = RunLedger(startedAt: start)
        let budget = Budget(minutes: 60)
        XCTAssertNil(ledger.budgetReached(budget, at: start.addingTimeInterval(59 * 60)))
        XCTAssertEqual(ledger.budgetReached(budget, at: start.addingTimeInterval(61 * 60)), .minutes)
        ledger.budgetGrants = 1
        XCTAssertNil(ledger.budgetReached(budget, at: start.addingTimeInterval(61 * 60)))
    }
}
