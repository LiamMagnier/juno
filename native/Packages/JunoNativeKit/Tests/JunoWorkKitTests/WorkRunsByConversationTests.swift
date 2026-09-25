import Foundation
import JunoCore
import JunoDesignSystem
import XCTest

@testable import JunoWorkKit

/// The sidebar's join (Phase 5 brief C1), ported from the web's
/// `tests/conversation-status.test.ts`: every failure here is a row that lies.
final class WorkRunsByConversationTests: XCTestCase {
    // MARK: The two predicates

    func testOnlyARunThatIsStillTheReadersBusinessLightsARow() {
        for status: JunoWorkStatus in [.running, .preparing, .queued, .paused, .waitingInput, .waitingApproval] {
            XCTAssertTrue(WorkRunsByConversation.isOpen(status, needsAttention: false), status.rawValue)
        }
        // Composed and never dispatched: nothing is happening behind that row.
        XCTAssertFalse(WorkRunsByConversation.isOpen(.draft, needsAttention: false))
        // Finished is finished — the conversation is a conversation again.
        for status: JunoWorkStatus in [.completed, .failed, .cancelled, .timedOut, .interrupted, .budgetExceeded] {
            XCTAssertFalse(WorkRunsByConversation.isOpen(status, needsAttention: false), status.rawValue)
        }
    }

    func testATerminalRunThatStillCarriesADecisionKeepsItsMark() {
        XCTAssertTrue(WorkRunsByConversation.isOpen(.hostOffline, needsAttention: false))
        XCTAssertTrue(WorkRunsByConversation.needsYou(.hostOffline, needsAttention: false))
        // The session's own flag wins even where the status does not say so.
        XCTAssertTrue(WorkRunsByConversation.isOpen(.completed, needsAttention: true))
        XCTAssertTrue(WorkRunsByConversation.needsYou(.completed, needsAttention: true))
    }

    func testNeedingYouIsNarrowerThanBeingOpen() {
        XCTAssertTrue(WorkRunsByConversation.isOpen(.running, needsAttention: false))
        XCTAssertFalse(WorkRunsByConversation.needsYou(.running, needsAttention: false))
        XCTAssertFalse(WorkRunsByConversation.needsYou(.paused, needsAttention: false))
        XCTAssertTrue(WorkRunsByConversation.needsYou(.waitingApproval, needsAttention: false))
        XCTAssertTrue(WorkRunsByConversation.needsYou(.waitingInput, needsAttention: false))
    }

    // MARK: The join

    func testTheJoinKeepsTheNewestRunPerConversationWhateverTheOrder() {
        let joined = WorkRunsByConversation.newestPerConversation([
            summary("old", conversation: "c1", active: 100),
            summary("new", conversation: "c1", active: 200),
            summary("other", conversation: "c2", active: 50),
        ])
        XCTAssertEqual(joined["c1"]?.sessionID, "new")
        XCTAssertEqual(joined["c2"]?.sessionID, "other")
        XCTAssertEqual(joined.count, 2)
    }

    func testARunPointingAtNoConversationHasNoRowToLightUp() {
        XCTAssertTrue(WorkRunsByConversation.newestPerConversation([summary("orphan", conversation: nil, active: 1)]).isEmpty)
    }

    func testOnATieTheFirstListedKeepsTheRow() {
        let joined = WorkRunsByConversation.newestPerConversation([
            summary("first", conversation: "c1", active: 100),
            summary("second", conversation: "c1", active: 100),
        ])
        XCTAssertEqual(joined["c1"]?.sessionID, "first")
    }

    /// An older run that is waiting does not light a chat whose newest run
    /// has finished: the reader would open the newer one.
    func testTheSignalComesFromTheNewestRunOnly() {
        let runs = WorkRunsByConversation(sessions: [
            summary("waiting", conversation: "c1", active: 100, status: "waiting_input"),
            summary("done", conversation: "c1", active: 200, status: "completed"),
            summary("asking", conversation: "c2", active: 50, status: "waiting_approval"),
            summary("working", conversation: "c3", active: 60, status: "running"),
            summary("drafted", conversation: "c4", active: 70, status: "draft"),
        ])
        XCTAssertNil(runs.openSignal(for: "c1"))
        XCTAssertEqual(runs.openSignal(for: "c2")?.tone, .attention)
        XCTAssertEqual(runs.openSignal(for: "c3")?.tone, .live)
        XCTAssertNil(runs.openSignal(for: "c4"))
        XCTAssertEqual(runs.needsYou, ["c2"])
    }

    func testAnUnreadableStatusIsTakenAsInterrupted() {
        let runs = WorkRunsByConversation(sessions: [summary("x", conversation: "c1", active: 1, status: "from_the_future")])
        XCTAssertEqual(runs.signals["c1"]?.status, .interrupted)
        XCTAssertNil(runs.openSignal(for: "c1"))
    }

    /// A run on this Mac holding an approval needs the reader before the
    /// server's status says so.
    func testAPendingLocalApprovalNeedsYouAtOnce() {
        let runs = WorkRunsByConversation(
            sessions: [summary("local", conversation: "c1", active: 1, status: "running", run: "run_1")],
            pendingLocalRunIDs: ["run_1"]
        )
        XCTAssertEqual(runs.needsYou, ["c1"])
        XCTAssertEqual(runs.openSignal(for: "c1")?.status, .waitingApproval)
        XCTAssertEqual(runs.openSignal(for: "c1")?.tone, .attention)
    }

    /// The caller's reading of a status wins: the Mac corrects a run whose
    /// Mac has gone to `host_offline`.
    func testTheCallersStatusIsTheOneJudged() {
        let runs = WorkRunsByConversation(
            sessions: [summary("gone", conversation: "c1", active: 1, status: "running")],
            status: { _ in .hostOffline }
        )
        XCTAssertEqual(runs.needsYou, ["c1"])
    }

    // MARK: Tones

    func testEveryStatusHasTheWebsTone() {
        XCTAssertEqual(JunoStatusTone(.running), .live)
        XCTAssertEqual(JunoStatusTone(.preparing), .live)
        XCTAssertEqual(JunoStatusTone(.queued), .neutral)
        XCTAssertEqual(JunoStatusTone(.paused), .neutral)
        XCTAssertEqual(JunoStatusTone(.waitingInput), .attention)
        XCTAssertEqual(JunoStatusTone(.hostOffline), .attention)
        XCTAssertEqual(JunoStatusTone(.timedOut), .attention)
        XCTAssertEqual(JunoStatusTone(.completed), .good)
        XCTAssertEqual(JunoStatusTone(.failed), .bad)
        XCTAssertEqual(JunoStatusTone(.cancelled), .neutral)
    }

    private func summary(
        _ id: String, conversation: String?, active: TimeInterval,
        status: String = "running", run: String? = nil
    ) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: id, title: id, goal: id, status: status, needsAttention: false,
            requestedTarget: "automatic", effectiveTarget: nil, hostID: nil,
            hostDisplayName: nil, pinned: false, archived: false,
            lastActivityAt: Date(timeIntervalSince1970: active), currentRunID: run,
            lastSeq: 0, conversationID: conversation, createdAt: Date(timeIntervalSince1970: active)
        )
    }
}
