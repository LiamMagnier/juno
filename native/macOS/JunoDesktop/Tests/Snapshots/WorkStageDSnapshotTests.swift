import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// Phase 5 Stage D, light and dark: the sheet for a task with no conversation
/// (register #63) — live and asking, waiting on an approval, done, still
/// reading and unreachable — and Search › Tasks with its loading, empty and
/// error states. `$JUNO_SNAPSHOT_DIR/<name>-<light|dark>.png`.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Phase 5 Stage D snapshots."
    ),
    .serialized
)
struct WorkStageDSnapshotTests {
    private typealias F = WorkStageDFixtures

    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
    }

    @Test(arguments: [
        "task-record-sheet-live", "task-record-sheet-approval", "task-record-sheet-done",
        "task-record-sheet-loading", "task-record-sheet-error",
    ])
    func sheetDrawsInBothAppearances(_ name: String) async throws {
        let sheet = F.sheet(name)
            .environment(\.junoWorkFiles, F.media)
            .junoAccentTint()
        try await render(sheet, name: name, width: DesktopTaskRecordView.size.width)
    }

    private func render<V: View>(_ view: V, name: String, width: CGFloat) async throws {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                view, name: name, width: width, appearance: appearance, into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

@MainActor
enum WorkStageDFixtures {
    static let start = WorkCardFixtures.start
    static let now = start.addingTimeInterval(1_140)
    private typealias W = WorkCardFixtures

    // MARK: The task

    static let title = "Reconcile the Q3 vendor invoices"

    /// A task the old Work window started: no conversation, run on this Mac.
    static func session(status: String, archived: Bool = false) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: "wsi_invoices", title: title,
            goal: "Match every Q3 vendor invoice in Finance/Invoices to its purchase order and list the ones that do not match.",
            status: status, needsAttention: status.hasPrefix("waiting"),
            requestedTarget: "local", effectiveTarget: "local", hostID: "host_mac",
            hostDisplayName: "Liam’s MacBook Pro", pinned: false, archived: archived,
            lastActivityAt: start.addingTimeInterval(1_020), currentRunID: "run_1", lastSeq: 58,
            conversationID: nil, createdAt: start.addingTimeInterval(-86_400 * 6)
        )
    }

    static let steps = [
        "Collect the Q3 invoices",
        "Match each invoice to a purchase order",
        "Check the amounts against the orders",
        "Flag the mismatches",
        "Write the summary",
    ]

    static func plan(done: Int) -> [WorkEvent] {
        var events = [
            W.event(4, .planCreated, [
                "steps": .array(steps.enumerated().map { index, title in
                    .object(["id": .string("s\(index + 1)"), "title": .string(title)])
                }),
            ]),
        ]
        for index in 0..<done {
            events.append(W.event(5 + index * 2, .stepStarted, ["stepId": .string("s\(index + 1)")]))
            events.append(W.event(6 + index * 2, .stepFinished, ["stepId": .string("s\(index + 1)")]))
        }
        return events
    }

    static func run(status: String, finished: TimeInterval? = nil) -> WorkRunSummary {
        W.run(status: status, finished: finished, cost: finished == nil ? 231_780 : 486_310, hostID: "host_mac", target: "local")
    }

    static let question = WorkQuestionPrompt(
        questionID: "q_hale", text: "Two Hale Freight invoices have no purchase order. Flag them, or leave them out?",
        options: ["Flag them", "Leave them out"],
        why: "Without an order there is nothing to check their amounts against.",
        askedAt: start.addingTimeInterval(1_020)
    )

    static var liveEvents: [WorkEvent] {
        plan(done: 2) + [
            W.event(30, .stepStarted, ["stepId": .string("s3")]),
            W.event(31, .assistantMessage, ["text": .string("Found 212 invoices for July to September in Finance/Invoices.")]),
            W.event(32, .assistantMessage, ["text": .string("209 match an order. Checking their amounts now.")]),
            W.event(33, .questionAsked, [
                "questionId": .string("q_hale"),
                "question": .string(question.text),
                "why": .string(question.why ?? ""),
                "options": .array(question.options.map(JunoJSONValue.string)),
            ]),
        ]
    }

    static var rename: WorkApprovalRequest {
        WorkApprovalRequest(
            approvalID: "ap_rename", runID: "run_1", action: "apply_changes", risk: "edit",
            summary: "Rename 14 invoice PDFs to vendor and date",
            detail: [
                "paths": .array([.string("Finance/Invoices/Q3/scan_0412.pdf"), .string("Finance/Invoices/Q3/scan_0413.pdf")]),
                "operation": .string("rename"),
            ],
            actionDigest: "d_rename", expiresAt: now.addingTimeInterval(17 * 60),
            decision: "pending", createdAt: start.addingTimeInterval(1_090)
        )
    }

    static var actions: ChatWorkRunActions {
        ChatWorkRunActions(reply: { _, _ in true }, stop: { true }, pause: {}, resume: {}, tryAgain: {})
    }

    // MARK: Files

    static var files: [ChatWorkFile] {
        [
            ChatWorkFile(
                artifact: WorkStageBFixtures.artifact(
                    "art_recon", "Q3 reconciliation", .spreadsheet,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", version: 3, updated: 1_380
                ),
                size: 142_907
            ),
            ChatWorkFile(
                artifact: WorkStageBFixtures.artifact(
                    "art_mismatch", "Mismatch summary", .document,
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", updated: 1_395
                ),
                size: 19_624
            ),
        ]
    }

    static var media: SnapshotMediaProvider {
        let ids = files.map(\.attachment.id)
        return SnapshotMediaProvider(previews: [
            ids[0]: .ready(NativeTranscriptFilePreview(
                thumbnail: SnapshotStills.cgImage(SnapshotStills.spreadsheetThumbnail())
            )),
            ids[1]: .ready(NativeTranscriptFilePreview(excerpt: """
                Q3 invoice mismatches

                Three invoices do not match their orders. Two Hale Freight invoices have no order at all and are flagged for Accounts.
                """)),
        ])
    }

    // MARK: The sheet

    @ViewBuilder
    static func sheet(_ name: String) -> some View {
        switch name {
        case "task-record-sheet-live":
            DesktopTaskRecordView(
                content: .ready(ChatWorkRunState(
                    session: session(status: "waiting_input"), status: .waitingInput,
                    run: run(status: "waiting_input"), events: liveEvents,
                    questions: [question], approvals: [], now: now
                )),
                actions: actions, close: {}
            )
        case "task-record-sheet-approval":
            DesktopTaskRecordView(
                content: .ready(ChatWorkRunState(
                    session: session(status: "waiting_approval"), status: .waitingApproval,
                    run: run(status: "waiting_approval"),
                    events: liveEvents + [
                        W.event(40, .approvalRequested, [
                            "approvalId": .string("ap_rename"), "action": .string("apply_changes"),
                            "summary": .string("Rename 14 invoice PDFs to vendor and date"),
                        ]),
                    ],
                    questions: [question],
                    approvals: [ChatWorkApproval(request: rename, isLocal: true)],
                    now: now
                )),
                actions: actions,
                failure: "Couldn’t send that answer, so Alevr hasn’t seen it. Try again.",
                close: {}
            )
        case "task-record-sheet-done":
            DesktopTaskRecordView(
                content: .ready(ChatWorkRunState(
                    session: session(status: "completed", archived: true), status: .completed,
                    run: run(status: "completed", finished: 1_402),
                    events: plan(done: 5) + [
                        W.event(60, .assistantMessage, [
                            "text": .string("Done. **209 of 212** invoices match their orders. The three that do not are in the summary, with the two Hale Freight invoices flagged."),
                        ]),
                    ],
                    questions: [], approvals: [], now: start.addingTimeInterval(1_600),
                    files: files
                )),
                actions: actions, close: {}
            )
        case "task-record-sheet-loading":
            DesktopTaskRecordView(content: .loading(session(status: "running")), close: {})
        default:
            DesktopTaskRecordView(content: .failed(nil), retry: {}, close: {})
        }
    }

    // MARK: Search › Tasks

    /// The account's tasks: three with chats, two from the old window (no
    /// chat), one archived; newest first once sorted.
    static var tasks: [WorkSessionSummary] {
        func task(
            _ id: String, _ title: String, _ status: String, ago: TimeInterval,
            chat: String?, archived: Bool = false
        ) -> WorkSessionSummary {
            WorkSessionSummary(
                sessionID: id, title: title, goal: title, status: status,
                needsAttention: status.hasPrefix("waiting"), requestedTarget: "automatic",
                effectiveTarget: "cloud", hostID: nil, hostDisplayName: nil, pinned: false,
                archived: archived, lastActivityAt: now.addingTimeInterval(-ago), currentRunID: "run_\(id)",
                lastSeq: 12, conversationID: chat, createdAt: now.addingTimeInterval(-ago - 3_600)
            )
        }
        return [
            task("wsi_quotes", "Compare the three vendor quotes", "running", ago: 20, chat: "conv-1"),
            task("wsi_invoices", title, "waiting_input", ago: 140, chat: nil),
            task("wsi_digest", "Draft Friday’s team digest", "completed", ago: 3 * 3_600 + 740, chat: "conv-2"),
            task("wsi_contract", "Chase the Corvid contract", "waiting_approval", ago: 5 * 3_600 + 90, chat: "conv-3"),
            task("wsi_travel", "Book the Lisbon offsite hotel", "failed", ago: 26 * 3_600, chat: "conv-4"),
            task("wsi_archive", "Tidy the Receipts folder", "completed", ago: 9 * 86_400 + 4_000, chat: nil, archived: true),
            task("wsi_budget", "Summarise the Q2 budget variance", "cancelled", ago: 17 * 86_400, chat: "conv-5"),
        ]
    }
}
