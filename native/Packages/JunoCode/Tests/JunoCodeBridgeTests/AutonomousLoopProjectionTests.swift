import Foundation
import XCTest
import JunoAgentProtocol
import JunoCodeCore
@testable import JunoCodeBridge

/// The autonomous loop's journal entries, as protocol v1.1 events: each one
/// projects to exactly its protocol event, which the generated decoder reads
/// back as known and unchanged. Once a lane records an entry, the phone and
/// the web receive it with no further wiring.
final class AutonomousLoopProjectionTests: XCTestCase {
    private let session = CodeSessionID(value: "s-loop")
    private let at = Date(timeIntervalSince1970: 1_790_000_000)

    private func event(_ sequence: Int, _ payload: SessionEventPayload) -> SessionEvent {
        SessionEvent(id: "e\(sequence)", sessionID: session, sequence: sequence, timestamp: at, payload: payload)
    }

    private let budget = Budget(minutes: 240, turns: 60, tokens: nil, costUSD: 20)
    private let usage = BudgetUsage(minutes: 38.5, turns: 7, tokens: 240_000, costUSD: 1.12)

    private var cases: [(SessionEventPayload, String)] {
        let criteria = [
            GoalCriterionSnapshot(id: "c1", text: "Tests pass", check: .command(checkID: "web-test"), met: true),
            GoalCriterionSnapshot(id: "c2", text: "Opens on phone", check: .ui(surface: .web, target: "/settings")),
            GoalCriterionSnapshot(id: "c3", text: "Nothing else changes", check: .judged),
        ]
        return [
            (.runContinued(RunContinuedEvent(reason: .gate(.todosOpen), detail: "2 todos were open", revision: 3, origin: .gate)), "run.continued"),
            (.runOutcome(RunOutcomeEvent(
                endReason: .doneChecked,
                summary: "The menu opens.",
                verification: "Checked with `npm test`",
                checks: [RunOutcomeCheck(label: "npm test", passed: true, detail: "9 s")],
                notChecked: ["Safari"],
                left: [],
                filesChanged: 2,
                durationSeconds: 12.5
            )), "run.outcome"),
            (.verificationRecorded(VerificationRecord(
                checkID: "web-test", command: "npm test", kind: .test, exitCode: 1, passed: false,
                workspaceRevision: 3, durationMs: 9_000, excerpt: "expected menu to be open"
            )), "verify.result"),
            (.uiVerificationRecorded(UIVerificationRecord(
                surface: .web, target: "/settings", viewport: "phone",
                checks: [UICheckResult(name: "HTTP 200", passed: true)], passed: true,
                screenshotHash: "abc", workspaceRevision: 4
            )), "verify.ui"),
            (.reviewCompleted(ReviewRecord(
                round: 1,
                findings: [ReviewFinding(priority: .p1, confidence: 0.8, path: "src/a.ts", line: 4, title: "Closes on open", criterion: "c2")],
                overall: .incorrect,
                summary: "One issue.",
                workspaceRevision: 4
            )), "review.findings"),
            (.goalSet(GoalSetEvent(goalID: "g1", objective: "Fix the menu", criteria: criteria, constraints: ["x"], budget: budget, origin: .plan)), "goal.set"),
            (.goalEdited(GoalEditedEvent(goalID: "g1", objective: "Fix it", criteria: criteria, budget: Budget())), "goal.updated"),
            (.goalVerdict(GoalVerdictEvent(goalID: "g1", verdict: .gateBlocked, reason: "c2 has no evidence", unmetCriteria: ["c2"], revision: 4)), "goal.verdict"),
            (.goalStatus(GoalStatusEvent(goalID: "g1", status: .budgetReached, reason: "Used the budget", usage: usage, budget: budget)), "goal.status"),
            (.checkInDue(CheckInDueEvent(running: ["xcodebuild test"], waitedSeconds: 1_800, idleCheckIns: 1)), "checkin.due"),
            (.ciStatus(CIStatusEvent(pullRequestNumber: 42, pullRequestURL: "https://example.test/pr/42", checks: [CICheck(name: "lint", state: .passed)])), "ci.status"),
            (.budgetReached(BudgetReachedEvent(scope: .goal, limit: .cost, budget: budget, usage: usage, goalID: "g1")), "budget.reached"),
        ]
    }

    func testEachLoopEntryProjectsToItsProtocolEventAndRoundTrips() throws {
        for (index, (payload, type)) in cases.enumerated() {
            let projected = AgentProtocolProjection.events(for: event(index, payload))
            XCTAssertEqual(projected.map(\.type), [type])
            for item in projected {
                let decoded = try JSONDecoder().decode(AgentEvent.self, from: AgentProtocolProjection.jsonData(item))
                XCTAssertTrue(decoded.isKnown, "\(type) must decode as known")
                XCTAssertEqual(decoded, item, "\(type) did not round-trip")
            }
        }
    }

    func testTheProjectionKeepsTheVocabularyTyped() throws {
        let projected = cases.map { AgentProtocolProjection.events(for: event(0, $0.0))[0].payload }

        guard case let .runContinued(continued) = projected[0] else { return XCTFail() }
        XCTAssertEqual(continued.reason, .todosOpen)
        XCTAssertEqual(continued.revision, 3)

        guard case let .runOutcome(outcome) = projected[1] else { return XCTFail() }
        XCTAssertEqual(outcome.endReason, .doneChecked)
        XCTAssertEqual(outcome.durationMs, 12_500)
        XCTAssertEqual(outcome.checks?.first?.label, "npm test")

        guard case let .verifyResult(result) = projected[2] else { return XCTFail() }
        XCTAssertEqual(result.kind, .test)
        XCTAssertEqual(result.revision, 3)
        XCTAssertEqual(result.check, "web-test")

        guard case let .goalSet(goal) = projected[5] else { return XCTFail() }
        XCTAssertEqual(goal.origin, .plan)
        XCTAssertEqual(goal.budget?.costMicroUsd, 20_000_000, "dollars travel as millionths")
        XCTAssertEqual(goal.criteria?.map(\.check), [.command, .ui, .judged])
        XCTAssertEqual(goal.criteria?[0].checkId, "web-test")
        XCTAssertEqual(goal.criteria?[1].surface, .web)
        XCTAssertEqual(goal.criteria?[1].target, "/settings")

        guard case let .goalUpdated(edited) = projected[6] else { return XCTFail() }
        XCTAssertNil(edited.budget, "an unlimited budget is left off")

        guard case let .goalStatus(status) = projected[8] else { return XCTFail() }
        XCTAssertEqual(status.status, .budgetReached)
        XCTAssertEqual(status.usage?.costMicroUsd, 1_120_000)

        guard case let .checkinDue(checkIn) = projected[9] else { return XCTFail() }
        XCTAssertEqual(checkIn.waitedMs, 1_800_000)

        guard case let .budgetReached(reached) = projected[11] else { return XCTFail() }
        XCTAssertEqual(reached.scope, .goal)
        XCTAssertEqual(reached.limit, .cost)
    }

    func testEvidenceLeavingTheMacIsRedacted() {
        let secret = "ghp_" + String(repeating: "a", count: 36)
        let record = VerificationRecord(
            command: "deploy --token \(secret)", kind: .custom, exitCode: 1, passed: false,
            workspaceRevision: 1, durationMs: 1, excerpt: "auth failed for \(secret)"
        )
        let projected = AgentProtocolProjection.events(for: event(0, .verificationRecorded(record)))
        guard case let .verifyResult(result) = projected.first?.payload else { return XCTFail() }
        XCTAssertFalse(result.command.contains(secret))
        XCTAssertFalse(result.excerpt?.contains(secret) ?? false)
    }

    func testTheRelayAndTaskWireSayNewStatesInWordsTheyKnow() {
        XCTAssertEqual(CodeRelayEventProjection.relayWord(.paused), "idle")
        XCTAssertEqual(CodeRelayEventProjection.relayWord(.waitingBackground), "running")
        XCTAssertEqual(CodeTaskWireProjection.taskWord(.paused), "running")
        XCTAssertEqual(CodeTaskWireProjection.taskWord(.waitingBackground), "running")
    }
}
