import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeUI

/// The UI seams of the autonomous loop (CODE_AGENT_SPEC §6.0): one model per
/// lane on every session, a thread row per loop record drawn by its lane's
/// placeholder, and the lanes' tool providers listed in one place.
@MainActor
final class AutonomousLoopSurfaceTests: XCTestCase {
    private let session = CodeSessionID(value: "s-ui")
    private let at = Date(timeIntervalSince1970: 1_790_000_000)

    private func event(_ id: String, _ payload: SessionEventPayload) -> SessionEvent {
        SessionEvent(id: id, sessionID: session, sequence: 0, timestamp: at, payload: payload)
    }

    func testEverySessionHasItsOwnLaneModels() {
        let first = SessionController(previewFixture: CodePreviewData.fixture(for: .transcript))
        let second = SessionController(previewFixture: CodePreviewData.fixture(for: .transcript))
        XCTAssertFalse(first.goal === second.goal)
        XCTAssertFalse(first.verification === second.verification)
        XCTAssertFalse(first.screen === second.screen)
        XCTAssertFalse(first.previewLease === second.previewLease)
        XCTAssertFalse(first.reviewQueue === second.reviewQueue)
        XCTAssertFalse(first.commands === second.commands)
    }

    func testEachLoopRecordBecomesItsRow() {
        let verification = VerificationRecord(command: "swift test", kind: .test, exitCode: 0, passed: true, workspaceRevision: 2, durationMs: 9_000)
        let ui = UIVerificationRecord(surface: .web, target: "/settings", viewport: "desktop", checks: [], passed: true, workspaceRevision: 2)
        let review = ReviewRecord(round: 1, findings: [], overall: .correct, workspaceRevision: 2)
        let outcome = RunOutcomeEvent(
            endReason: .doneChecked,
            summary: "Done.",
            verification: "Checked with `swift test`",
            checks: [RunOutcomeCheck(label: "swift test", passed: true, recordID: verification.id)]
        )
        let events = [
            event("continued", .runContinued(RunContinuedEvent(reason: .gate(.todosOpen), detail: "2 todos were open", origin: .gate))),
            event("goal-set", .goalSet(GoalSetEvent(goalID: "g1", objective: "x", criteria: [], origin: .reader))),
            event("verdict", .goalVerdict(GoalVerdictEvent(goalID: "g1", verdict: .notMet, reason: "c2 has no evidence", revision: 2))),
            event("check", .verificationRecorded(verification)),
            event("ui", .uiVerificationRecorded(ui)),
            event("review", .reviewCompleted(review)),
            event("ci-1", .ciStatus(CIStatusEvent(checks: [CICheck(name: "lint", state: .running)]))),
            event("status", .goalStatus(GoalStatusEvent(goalID: "g1", status: .active))),
            event("checkin", .checkInDue(CheckInDueEvent(running: ["build"], waitedSeconds: 60, idleCheckIns: 1))),
            event("budget", .budgetReached(BudgetReachedEvent(scope: .run, limit: .minutes, budget: Budget(minutes: 60), usage: BudgetUsage(minutes: 60)))),
            event("ci-2", .ciStatus(CIStatusEvent(checks: [CICheck(name: "lint", state: .passed)]))),
            event("edited", .goalEdited(GoalEditedEvent(goalID: "g1", objective: "y", criteria: []))),
            event("outcome", .runOutcome(outcome)),
        ]

        let items = StudioThreadItems.build(events: events, groups: [], pendingApprovalIDs: [], showReasoning: false)

        XCTAssertEqual(items.map(\.id), ["continued", "verdict", "check", "ui", "review", "ci-2", "outcome"],
                       "goal changes, spend, check-ins and budgets show above the composer, and CI once, where it last moved")
        guard case let .continued(_, continued) = items[0] else { return XCTFail() }
        XCTAssertEqual(continued.detail, "2 todos were open")
        guard case .goalVerdict = items[1], case .verification = items[2], case .uiCheck = items[3],
              case .reviewFindings = items[4], case .ciStatus = items[5], case .runReport = items[6]
        else { return XCTFail("each record maps to its own row: \(items)") }
    }

    /// A report with nothing beyond the divider's words earns no row of its
    /// own: the divider after it already says how the run ended.
    func testAReportWithNothingToShowAddsNoRow() {
        let bare = RunOutcomeEvent(endReason: .doneUnchecked, summary: "Done.")
        let items = StudioThreadItems.build(
            events: [event("outcome", .runOutcome(bare))],
            groups: [],
            pendingApprovalIDs: [],
            showReasoning: false
        )
        XCTAssertTrue(items.isEmpty)
    }

    func testTheThreadIsUnchangedForATranscriptWithoutLoopRecords() {
        let events = CodePreviewData.fixture(for: .transcript).events
        let items = StudioThreadItems.build(events: events, groups: [], pendingApprovalIDs: [], showReasoning: false)
        for item in items {
            switch item {
            case .continued, .goalVerdict, .verification, .uiCheck, .reviewFindings, .screenStep, .ciStatus, .runReport:
                XCTFail("no loop row without a loop record: \(item.id)")
            default:
                break
            }
        }
        XCTAssertTrue(StudioScreenStep.steps(in: events).isEmpty, "Lane C claims no events yet")
    }

    func testThePlaceholdersSayTheStateInWords() {
        XCTAssertEqual(
            StudioContinuedRow.caption(for: RunContinuedEvent(reason: .gate(.unverified), detail: "`swift test` had not run since the last edit", origin: .gate)),
            "Kept going: `swift test` had not run since the last edit"
        )
        XCTAssertEqual(StudioContinuedRow.caption(for: RunContinuedEvent(reason: .afterQuit, detail: "x", origin: .user)), "Resumed after Juno quit")
        XCTAssertEqual(
            StudioGoalVerdictRow.caption(for: GoalVerdictEvent(goalID: "g", verdict: .notMet, reason: "c2 has no Preview evidence", revision: 1)),
            "Checked the goal: not yet — c2 has no Preview evidence"
        )
        XCTAssertEqual(
            StudioReviewFindingsRow.caption(for: ReviewRecord(round: 1, findings: [], overall: .correct, workspaceRevision: 1)),
            "Reviewed the diff: no correctness findings"
        )
        XCTAssertEqual(
            StudioReviewFindingsRow.line(for: ReviewFinding(priority: .p1, confidence: 0.9, path: "src/a.ts", line: 41, title: "Closes on open")),
            "P1 at src/a.ts:41: Closes on open"
        )
        XCTAssertEqual(
            PreviewCheckRow.caption(for: UIVerificationRecord(surface: .web, target: "/settings", viewport: "phone", checks: [], passed: true, workspaceRevision: 1)),
            "Checked /settings at phone: no errors"
        )
        XCTAssertEqual(
            PreviewCheckRow.caption(for: UIVerificationRecord(
                surface: .web, target: "/settings", checks: [UICheckResult(name: "1 new console error", passed: false, detail: "TypeError: menu is undefined")],
                passed: false, workspaceRevision: 1
            )),
            "/settings: 1 new console error — TypeError: menu is undefined"
        )
        XCTAssertEqual(
            StudioCIStatusRow.caption(for: CIStatusEvent(checks: [
                CICheck(name: "lint", state: .passed), CICheck(name: "build", state: .passed),
                CICheck(name: "e2e", state: .passed), CICheck(name: "test (ubuntu)", state: .failed),
            ])),
            "CI: 3 of 4 checks passed; test (ubuntu) failed"
        )
        XCTAssertEqual(
            StudioScreenStepRow.caption(for: StudioScreenStep(eventID: "e", verb: "Clicked", app: "TextEdit", element: "Save button", succeeded: true)),
            "Clicked Save button in TextEdit"
        )
    }

    func testEveryLaneHasAToolProvider() {
        XCTAssertEqual(CodeToolProviders.all.count, 6)
    }
}
