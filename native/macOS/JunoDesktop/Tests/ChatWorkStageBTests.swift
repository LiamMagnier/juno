import Foundation
import JunoChatKit
import JunoCore
import JunoWorkKit
import Testing

@testable import JunoDesktop

/// The rest of the task card (Phase 5 Stage B): the finished digest, the
/// approval queue's one prominent verb and its batch, the menu's Title Case,
/// and the task and handoff approval words.
@MainActor
struct ChatWorkStageBTests {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    private func step(_ id: String, _ title: String, _ state: WorkEventLog.StepState) -> WorkEventLog.PlanStep {
        WorkEventLog.PlanStep(id: id, title: title, state: state)
    }

    private func run(cost: Int, ran: TimeInterval?) -> WorkRunSummary {
        WorkRunSummary(
            runID: "r", sessionID: "s", attempt: 1, status: "failed", terminalReason: "error",
            requestedTarget: "automatic", effectiveTarget: "cloud", hostID: nil, effectiveModel: nil,
            degradation: [], costMicroUsd: cost, maxCostMicroUsd: 0, lastSeq: 0,
            startedAt: ran == nil ? nil : t0, finishedAt: ran.map { t0.addingTimeInterval($0) }
        )
    }

    // MARK: The digest

    @Test
    func theDigestSaysHowFarWhatChangedAndWhatItCost() {
        let plan = [step("1", "Find the quotes", .done), step("2", "Normalise prices", .failed), step("3", "Rank", .pending)]
        let performed = WorkEventLog.PerformedActions(
            actions: [.init(id: 1, summary: "Saved the sheet", at: t0, approved: false)], unclassified: 0
        )
        let lines = ChatWorkOutcome.lines(run: run(cost: 96_120, ran: 131), plan: plan, performed: performed).map(\.text)
        #expect(lines == [
            "Finished 1 of 3 planned steps, and stopped on “Normalise prices”.",
            "One action changed something outside Alevr. It is listed in Details.",
            "Ran for 2m 11s and spent $0.10.",
        ])
    }

    @Test
    func theDigestWithNoPlanNothingChangedAndNoClock() {
        let lines = ChatWorkOutcome.lines(run: run(cost: 42_000, ran: nil), plan: [], performed: .none).map(\.text)
        #expect(lines == [
            "No plan was written, so there are no steps to measure it against.",
            "Nothing was recorded as changed, so starting it again is safe.",
            "Spent $0.04.",
        ])
        let unclassified = ChatWorkOutcome.lines(
            run: run(cost: 0, ran: 9), plan: [],
            performed: WorkEventLog.PerformedActions(actions: [], unclassified: 3)
        ).map(\.text)
        #expect(unclassified[1] == "3 actions ran without saying whether anything was changed, so whether this left a mark is not recorded.")
        #expect(unclassified[2] == "Ran for 9s.")
    }

    // MARK: The queue

    private func approval(_ id: String, action: String = "apply_changes", risk: String = "edit", expires: TimeInterval = 600, digest: String = "d") -> ChatWorkApproval {
        ChatWorkApproval(
            request: WorkApprovalRequest(
                approvalID: id, runID: "r", action: action, risk: risk, summary: id, detail: [:],
                actionDigest: digest, expiresAt: t0.addingTimeInterval(expires), decision: "pending"
            ),
            isLocal: false
        )
    }

    /// Register #60: only the first card that can be answered wears the
    /// accent; an expired or unsigned card ahead of it does not take it.
    @Test
    func onlyTheFirstAnswerableCardIsProminent() {
        let queue = [
            approval("stale", expires: -5), approval("unsigned", digest: ""),
            approval("first"), approval("second"),
        ]
        #expect(ChatWorkApprovalQueue.primaryID(queue, at: t0) == "first")
        #expect(ChatWorkApprovalQueue.primaryID([approval("stale", expires: -5)], at: t0) == nil)
    }

    @Test
    func theBatchNeedsTwoAndNeverTakesTheFloor() {
        let mixed = [approval("a"), approval("b"), approval("send", action: "send_email", risk: "sensitive")]
        #expect(ChatWorkApprovalQueue.batchable(mixed, at: t0).map(\.id) == ["a", "b"])
        #expect(ChatWorkApprovalQueue.batchable([approval("a"), approval("send", action: "send_email", risk: "sensitive")], at: t0).isEmpty)
    }

    @Test
    func menuVerbsAreInTitleCase() {
        #expect(ChatWorkApprovalCard.menuTitle("Make the changes") == "Make the Changes")
        #expect(ChatWorkApprovalCard.menuTitle("Delete for good") == "Delete for Good")
        #expect(ChatWorkApprovalCard.menuTitle("Run it") == "Run It")
        #expect(ChatWorkApprovalCard.menuTitle("Go ahead") == "Go Ahead")
    }

    // MARK: Task and handoff approvals

    @Test
    func theHandoffAndTaskStatusWordsAreTheWebs() {
        #expect(DesktopApprovalCard.handoffStatus(.executed, expired: false) == "Handed off. It reports back in their thread.")
        #expect(DesktopApprovalCard.handoffStatus(.denied, expired: false) == "Not handed off.")
        #expect(DesktopApprovalCard.handoffStatus(.pending, expired: true) == "This expired before it was answered, so nothing was handed off.")
        #expect(DesktopApprovalCard.handoffStatus(.pending, expired: false) == nil)
        #expect(DesktopApprovalCard.taskStatus(.superseded, expired: false) == "This was cancelled before it was answered, so the task did not start.")
        #expect(DesktopApprovalCard.taskStatus(.blocked, expired: false) == "Your permissions blocked this, so the task did not start.")
        #expect(DesktopApprovalCard.taskStatus(.pending, expired: true) == "This expired before it was answered, so the task did not start.")
    }

    @Test
    func bothTaskToolsReadAsATaskApproval() {
        func chat(_ tool: String) -> NativeChatApproval {
            NativeChatApproval(
                id: "a", surface: "chat", sessionID: "s", conversationID: "c", connectorID: "juno_work",
                connectorLabel: "Juno", toolName: tool, action: tool, riskClass: .externalWrite, preview: "p",
                detail: [:], receiptDigest: "d", status: .pending, decision: nil, canAllowScope: false,
                derivedFromUntrusted: false, expiresAt: t0, decidedAt: nil, completedAt: nil, createdAt: t0
            )
        }
        #expect(DesktopApprovalCard.isTaskApproval(chat("start_task")))
        #expect(DesktopApprovalCard.isTaskApproval(chat("hand_off_to_teammate")))
        #expect(!DesktopApprovalCard.isTaskApproval(chat("linear__create_issue")))
    }

    // MARK: Files

    @Test
    func aTaskFileRoundTripsItsTileID() {
        let artifact = WorkArtifactSummary(
            artifactID: "art_7f3", sessionID: "s", identifier: "vendor-comparison", title: "Vendor comparison",
            kind: .spreadsheet, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            currentVersion: 2, validatedAt: nil, createdAt: t0, updatedAt: t0
        )
        let file = ChatWorkFile(artifact: artifact, size: 88_412)
        #expect(file.attachment.id == "work-art_7f3-v2")
        #expect(file.attachment.fileName == "Vendor comparison.xlsx")
        #expect(ChatWorkFiles.parse(file.attachment.id)?.artifactID == "art_7f3")
        #expect(ChatWorkFiles.parse(file.attachment.id)?.version == 2)
        #expect(ChatWorkFiles.parse("attachment-9") == nil)
        #expect(ChatWorkFile.lead(of: [file])?.id == "art_7f3")
    }

    @Test
    func localBlockersOnlyForARunOnThisMac() {
        let none = DesktopWorkSystemPermissions.none
        #expect(ChatWorkLocalBlocker.of(none, runsHere: false).isEmpty)
        #expect(ChatWorkLocalBlocker.of(none, runsHere: true).map(\.kind) == [.accessibility, .screenRecording])
        let granted = DesktopWorkSystemPermissions(accessibility: true, screenRecording: true)
        #expect(ChatWorkLocalBlocker.of(granted, runsHere: true).isEmpty)
    }
}
