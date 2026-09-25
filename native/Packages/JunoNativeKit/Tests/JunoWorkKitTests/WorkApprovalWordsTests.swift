import Foundation
import JunoCore
import XCTest

@testable import JunoWorkKit

/// The task approval's words (Phase 5 B5): the verb table, what may be
/// answered for good or in a batch, and the settled lines — the web's
/// `action-verbs.ts`, `approval-card.tsx` and `approval-queue.tsx`.
final class WorkApprovalWordsTests: XCTestCase {
    func testTheButtonCarriesTheVerbNeverApprove() {
        XCTAssertEqual(WorkApprovalWords.verb(for: "work.connector.send_message").verb, "Send")
        XCTAssertEqual(WorkApprovalWords.verb(for: "send_email").verb, "Send")
        XCTAssertEqual(WorkApprovalWords.verb(for: "work.file.permanent_delete").verb, "Delete for good")
        XCTAssertEqual(WorkApprovalWords.verb(for: "permanently_delete").verb, "Delete for good")
        XCTAssertEqual(WorkApprovalWords.verb(for: "apply_changes").verb, "Make the changes")
        XCTAssertEqual(WorkApprovalWords.verb(for: "run_command").verb, "Run it")
        XCTAssertEqual(WorkApprovalWords.verb(for: "work.browser.submit").verb, "Send the form")
        XCTAssertEqual(WorkApprovalWords.verb(for: "something_new").verb, "Go ahead")
        for action in WorkApprovalWords.verbs.keys {
            XCTAssertFalse(WorkApprovalWords.verb(for: action).verb.lowercased().contains("approve"))
        }
    }

    func testThePreviewReadsTheNamedKeysOnly() {
        let verb = WorkApprovalWords.verb(for: "send_email")
        let detail: [String: JunoJSONValue] = [
            "to": .array([.string("priya@corvid.example"), .string("ops@corvid.example")]),
            "body": .string("Hi Priya,\n\nThe comparison is attached."),
            "threadId": .string("t_81"),
        ]
        XCTAssertEqual(WorkApprovalWords.previewBody(detail, verb: verb), "Hi Priya,\n\nThe comparison is attached.")
        XCTAssertEqual(
            WorkApprovalWords.previewTarget(detail, verb: verb), "priya@corvid.example, ops@corvid.example"
        )
        // No body key for the fallback: the card shows the parameters instead.
        XCTAssertNil(WorkApprovalWords.previewBody(detail, verb: WorkApprovalWords.verb(for: "mystery")))
        let paths = WorkApprovalWords.previewBody(
            ["paths": .array([.string("Q3/one.xlsx"), .string("Q3/two.xlsx")])],
            verb: WorkApprovalWords.verb(for: "apply_changes")
        )
        XCTAssertEqual(paths, "Q3/one.xlsx\nQ3/two.xlsx")
    }

    func testParametersAreTheScalarsInKeyOrderWithASingularToggle() {
        let rows = WorkApprovalWords.parameters([
            "b": .number(3), "a": .string("x"), "c": .bool(true), "d": .array([]),
        ])
        XCTAssertEqual(rows.map(\.key), ["a", "b", "c"])
        XCTAssertEqual(rows.map(\.value), ["x", "3", "true"])
        XCTAssertEqual(WorkApprovalWords.parametersToggle(count: 1, open: false), "Show 1 parameter")
        XCTAssertEqual(WorkApprovalWords.parametersToggle(count: 4, open: true), "Hide 4 parameters")
    }

    /// "and Stop Asking" only below the floor, and never for an always-confirm
    /// action however it is graded.
    func testStopAskingIsOfferedOnlyWhereAllowed() {
        XCTAssertTrue(WorkApprovalWords.mayStopAsking(action: "apply_changes", risk: "edit"))
        XCTAssertTrue(WorkApprovalWords.mayStopAsking(action: "run_command", risk: "command"))
        XCTAssertFalse(WorkApprovalWords.mayStopAsking(action: "send_email", risk: "sensitive"))
        XCTAssertFalse(WorkApprovalWords.mayStopAsking(action: "permanently_delete", risk: "irreversible"))
        XCTAssertFalse(WorkApprovalWords.mayStopAsking(action: "work.connector.send_message", risk: "safe"))
    }

    func testBatchingNeverSweepsUpTheFloor() {
        XCTAssertTrue(WorkApprovalWords.mayBatch(action: "apply_changes", risk: "edit"))
        XCTAssertTrue(WorkApprovalWords.mayBatch(action: "read_file", risk: "safe"))
        XCTAssertFalse(WorkApprovalWords.mayBatch(action: "run_command", risk: "command"))
        XCTAssertFalse(WorkApprovalWords.mayBatch(action: "work.file.empty_trash", risk: "edit"))
        XCTAssertFalse(WorkApprovalWords.mayBatch(action: "send_email", risk: "sensitive"))
        XCTAssertEqual(
            WorkApprovalWords.batchLabel(actions: ["apply_changes", "apply_changes", "apply_changes"]),
            "Make the changes — all 3"
        )
        XCTAssertEqual(WorkApprovalWords.batchLabel(actions: ["apply_changes", "read_file"]), "Allow all 2")
        XCTAssertEqual(
            WorkApprovalWords.batchSentence(batchable: 3, live: 3),
            "3 decisions are waiting, and they are all the same kind."
        )
        XCTAssertEqual(
            WorkApprovalWords.batchSentence(batchable: 2, live: 5),
            "2 of these 5 can be answered together. The rest ask on their own."
        )
    }

    func testRiskWordsAndActionLabels() {
        XCTAssertEqual(WorkApprovalWords.riskLabel("edit"), "Edits a file")
        XCTAssertEqual(WorkApprovalWords.riskLabel("nonsense"), "Cannot be undone")
        XCTAssertTrue(WorkApprovalWords.riskIsSevere("sensitive"))
        XCTAssertFalse(WorkApprovalWords.riskIsSevere("command"))
        XCTAssertEqual(
            WorkApprovalWords.riskConsequence("command"), "This runs a command on the machine this task is on."
        )
        XCTAssertEqual(WorkApprovalWords.actionLabel("apply_changes"), "Change files")
        XCTAssertEqual(WorkApprovalWords.actionLabel("email.search"), "Email search")
        XCTAssertEqual(WorkApprovalWords.actionLabel(nil), "An action")
        XCTAssertEqual(
            WorkApprovalWords.standingScope(action: "apply_changes"),
            "Covers “Change files” for the rest of this task only. It lapses when the task ends."
        )
    }

    func testSettledLines() {
        let ago: (Date) -> String = { _ in "4m ago" }
        func approval(_ decision: String) -> WorkApprovalRequest {
            WorkApprovalRequest(
                approvalID: "a", runID: "r", action: "apply_changes", risk: "edit", summary: "s",
                detail: [:], actionDigest: "d", expiresAt: .distantFuture, decision: decision,
                createdAt: Date(timeIntervalSince1970: 0), decidedAt: Date(timeIntervalSince1970: 60)
            )
        }
        XCTAssertEqual(WorkApprovalWords.settledLine(approval("allowed"), expired: false, ago: ago), "Allowed 4m ago")
        XCTAssertEqual(
            WorkApprovalWords.settledLine(approval("allowed_always"), expired: false, ago: ago),
            "Allowed for the rest of this task 4m ago"
        )
        XCTAssertEqual(WorkApprovalWords.settledLine(approval("denied"), expired: false, ago: ago), "Refused 4m ago")
        XCTAssertEqual(
            WorkApprovalWords.settledLine(approval("expired"), expired: false, ago: ago),
            "Expired unanswered — Juno stopped rather than acting on a stale approval"
        )
        XCTAssertEqual(
            WorkApprovalWords.settledLine(approval("superseded"), expired: false, ago: ago),
            "Replaced by a later request"
        )
    }
}

/// Save this as a skill (Phase 5 B3): the web's drafting rules and slug.
final class WorkSkillDraftTests: XCTestCase {
    private func step(_ id: String, _ title: String, _ state: WorkEventLog.StepState) -> WorkEventLog.PlanStep {
        WorkEventLog.PlanStep(id: id, title: title, state: state)
    }

    /// `tests/work-skills.test.ts`'s own examples.
    func testTheSlugMatchesTheWebsExamples() {
        XCTAssertEqual(WorkSkillDraft.slug(fromName: "Tidy my Downloads!"), "tidy-my-downloads")
        XCTAssertEqual(WorkSkillDraft.slug(fromName: "  Q3   Report  "), "q3-report")
        let long = WorkSkillDraft.slug(fromName: String(repeating: "ab ", count: 40))
        XCTAssertNotNil(long)
        XCTAssertLessThanOrEqual(long?.count ?? 99, 64)
        XCTAssertFalse(long?.hasSuffix("-") ?? true)
        XCTAssertNil(WorkSkillDraft.slug(fromName: "！！！"))
        XCTAssertEqual(WorkSkillDraft.slugHint("q3-report"), "You will type /q3-report to use it.")
        XCTAssertEqual(WorkSkillDraft.slugHint(nil), "Give it a name with at least one letter or number in it.")
    }

    func testCaptureNeedsACompletedRunWithTwoStepsDone() {
        let two = [step("1", "a", .done), step("2", "b", .done)]
        XCTAssertTrue(WorkSkillDraft.canCapture(status: .completed, plan: two))
        XCTAssertFalse(WorkSkillDraft.canCapture(status: .failed, plan: two))
        XCTAssertFalse(WorkSkillDraft.canCapture(status: .completed, plan: [step("1", "a", .done), step("2", "b", .skipped)]))
    }

    func testTheNameIsTheTitleOrAShortenedGoal() {
        XCTAssertEqual(WorkSkillDraft.name(title: "Compare vendor quotes", goal: "x"), "Compare vendor quotes")
        let goal = "Read every supplier invoice from last quarter and put the totals in one sheet by vendor"
        let fromGoal = WorkSkillDraft.name(title: "Untitled task", goal: goal)
        XCTAssertTrue(fromGoal.hasSuffix("…"))
        XCTAssertLessThanOrEqual(fromGoal.count, 58)
    }

    func testTheDescriptionIsTheFirstSentence() {
        XCTAssertEqual(
            WorkSkillDraft.description(goal: "Compare the three quotes.  Use this week’s   prices."),
            "Compare the three quotes."
        )
        let long = String(repeating: "word ", count: 60)
        XCTAssertEqual(WorkSkillDraft.description(goal: long).count, 178)
    }

    func testInstructionsNumberTheFinishedStepsAndCapTheNotes() {
        let plan = [step("1", "Find the quotes", .done), step("2", "Skip this", .skipped), step("3", "Rank them", .done)]
        let performed = WorkEventLog.PerformedActions(
            actions: (0..<8).map { WorkEventLog.PerformedAction(id: $0, summary: "Did \($0)", at: .now, approved: false) },
            unclassified: 0
        )
        let text = WorkSkillDraft.instructions(goal: " Compare the quotes. ", plan: plan, performed: performed)
        let lines = text.components(separatedBy: "\n")
        XCTAssertEqual(Array(lines.prefix(5)), ["Compare the quotes.", "", "Steps:", "1. Find the quotes", "2. Rank them"])
        XCTAssertEqual(lines[6], "Last time this needed to:")
        XCTAssertEqual(lines.filter { $0.hasPrefix("- ") }.count, 6)
    }

    func testTheSaveOutcomeReadsLikeTheWeb() {
        let created = NativeWorkSkillsClient.outcome(
            statusCode: 201, body: Data(#"{"skill":{"id":"sk_1","slug":"compare-quotes"}}"#.utf8)
        )
        XCTAssertEqual(created, .created(.init(id: "sk_1", slug: "compare-quotes")))
        XCTAssertEqual(
            NativeWorkSkillsClient.outcome(statusCode: 409, body: Data(#"{"error":"slug_taken"}"#.utf8)).message,
            WorkSkillDraft.blockedWithoutReason
        )
        XCTAssertEqual(NativeWorkSkillsClient.outcome(statusCode: 400, body: Data()).message, WorkSkillDraft.rejected)
        XCTAssertEqual(NativeWorkSkillsClient.outcome(statusCode: 502, body: Data()).message, WorkSkillDraft.unreachable)
    }
}

/// What a run changed (Phase 5 B1), the web's `derivePerformedActions`.
final class WorkPerformedActionsTests: XCTestCase {
    private func event(_ seq: Int, _ kind: JunoWorkEventKind, _ payload: [String: JunoJSONValue]) -> WorkEvent {
        WorkEvent(seq: seq, kind: kind.rawValue, payload: payload, agentID: nil, createdAt: Date(timeIntervalSince1970: Double(seq)))
    }

    func testMutatingCallsCountAndUnclassifiedAreCountedApart() {
        let events = [
            event(1, .approvalRequested, ["approvalId": .string("ap1"), "action": .string("apply_changes")]),
            event(2, .approvalResolved, ["approvalId": .string("ap1"), "decision": .string("allowed")]),
            event(3, .toolStarted, ["callId": .string("c1"), "risk": .string("edit"), "action": .string("apply_changes"), "summary": .string("Renaming 4 files")]),
            event(4, .toolFinished, ["callId": .string("c1"), "summary": .string("Renamed 4 files")]),
            event(5, .toolStarted, ["callId": .string("c2"), "risk": .string("safe"), "tool": .string("read_file")]),
            event(6, .toolFinished, ["callId": .string("c2")]),
            event(7, .toolStarted, ["callId": .string("c3"), "tool": .string("web_search")]),
            event(8, .toolFinished, ["callId": .string("c3")]),
            event(9, .toolStarted, ["callId": .string("c4"), "mutating": .bool(true)]),
            event(10, .toolFinished, ["callId": .string("c4"), "isError": .bool(true)]),
            event(11, .artifactCreated, ["title": .string("Vendor comparison")]),
        ]
        let performed = WorkEventLog.performedActions(in: events)
        XCTAssertEqual(performed.actions.map(\.summary), ["Renamed 4 files", "Created Vendor comparison"])
        XCTAssertEqual(performed.actions.first?.approved, true)
        XCTAssertEqual(performed.unclassified, 1)
    }
}
