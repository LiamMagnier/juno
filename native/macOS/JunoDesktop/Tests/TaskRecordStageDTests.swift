import Foundation
import JunoChatKit
import JunoCore
import JunoWorkKit
import Testing

@testable import JunoDesktop

/// Phase 5 Stage D: Search › Tasks and the sheet for a task with no
/// conversation (register #63).
@MainActor
struct TaskRecordStageDTests {
    private let start = Date(timeIntervalSince1970: 1_790_000_000)

    private func task(
        _ id: String, _ title: String, goal: String? = nil, active: TimeInterval,
        status: String = "running", chat: String? = nil
    ) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: id, title: title, goal: goal ?? title, status: status, needsAttention: false,
            requestedTarget: "automatic", effectiveTarget: nil, hostID: nil, hostDisplayName: nil,
            pinned: false, archived: false, lastActivityAt: start.addingTimeInterval(active),
            currentRunID: nil, lastSeq: 0, conversationID: chat, createdAt: start
        )
    }

    // MARK: Search › Tasks

    @Test
    func theTasksScopeListsNewestActivityFirst() {
        let tasks = [
            task("a", "Book the hotel", active: 10),
            task("b", "Reconcile the invoices", active: 300),
            task("c", "Draft the digest", active: 120),
        ]
        #expect(DesktopSearchTaskList.matching(tasks, query: "").map(\.sessionID) == ["b", "c", "a"])
        #expect(DesktopSearchTaskList.matching(tasks, query: "   ").map(\.sessionID) == ["b", "c", "a"])
    }

    /// Every word must be found, in the title or the goal, ignoring case and
    /// accents.
    @Test
    func theTasksScopeMatchesEveryWordInTheTitleOrGoal() {
        let tasks = [
            task("a", "Book the Lisbon hotel", goal: "Find a café-friendly hotel near the office", active: 10),
            task("b", "Reconcile the invoices", goal: "Match Q3 invoices to orders", active: 20),
        ]
        #expect(DesktopSearchTaskList.matching(tasks, query: "lisbon CAFE").map(\.sessionID) == ["a"])
        #expect(DesktopSearchTaskList.matching(tasks, query: "invoices orders").map(\.sessionID) == ["b"])
        #expect(DesktopSearchTaskList.matching(tasks, query: "invoices hotel").isEmpty)
    }

    @Test
    func theTasksScopeIsReadFromTheServerNotTheStore() {
        #expect(DesktopSearchScope.tasks.title == "Tasks")
        for kind in [NativeSearchResultKind.conversation, .message, .project, .file, .artifact, .memory] {
            #expect(!DesktopSearchScope.tasks.includes(kind))
        }
        #expect(DesktopSearchScope.allCases.last == .tasks)
    }

    @Test
    func aTaskFallsBackToItsGoalWhenItHasNoTitle() {
        #expect(DesktopSearchScreen.title(of: task("a", "  ", goal: "Tidy the Receipts folder", active: 0)) == "Tidy the Receipts folder")
        #expect(DesktopSearchScreen.title(of: task("b", "Draft the digest", active: 0)) == "Draft the digest")
    }

    // MARK: The sheet

    @Test
    func theSheetReadsItsTitleAndStatusFromWhateverItHas() {
        let known = task("a", "Reconcile the invoices", active: 0, status: "waiting_input")
        #expect(DesktopTaskRecordContent.loading(known).status == .waitingInput)
        #expect(DesktopTaskRecordContent.loading(known).session?.sessionID == "a")
        #expect(DesktopTaskRecordContent.failed(nil).status == nil)
        #expect(DesktopTaskRecordContent.failed(nil).session == nil)
    }

    /// One prominent button per surface: an approval that can still be
    /// answered holds it, so the question's "Reply" steps down; an expired
    /// one does not.
    @Test
    func anAnswerableApprovalHoldsTheProminentButton() {
        let now = start.addingTimeInterval(600)
        func approval(expires: TimeInterval, decision: String = "pending") -> ChatWorkApproval {
            ChatWorkApproval(
                request: WorkApprovalRequest(
                    approvalID: "ap_\(expires)", runID: "run_1", action: "apply_changes", risk: "edit",
                    summary: "Rename the files", detail: [:], actionDigest: "d",
                    expiresAt: start.addingTimeInterval(expires), decision: decision
                ),
                isLocal: true
            )
        }
        func state(_ approvals: [ChatWorkApproval]) -> ChatWorkRunState {
            ChatWorkRunState(
                session: task("a", "Reconcile", active: 0, status: "waiting_approval"),
                status: .waitingApproval, run: nil, events: [], questions: [], approvals: approvals, now: now
            )
        }
        #expect(state([approval(expires: 1_200)]).hasAnswerableApproval)
        #expect(!state([approval(expires: 300)]).hasAnswerableApproval)
        #expect(!state([]).hasAnswerableApproval)
    }

    @Test
    func theSheetsLedeIsThePlainNewCopy() {
        #expect(
            DesktopTaskRecordView.lede
                == "This task was started before tasks lived in chats, so it has no conversation to report in."
        )
        #expect(!DesktopTaskRecordView.lede.contains("\u{2014}"))
        #expect(DesktopTaskRecordView.size == CGSize(width: 640, height: 600))
    }
}
