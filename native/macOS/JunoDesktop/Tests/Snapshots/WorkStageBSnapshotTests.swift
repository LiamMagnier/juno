import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// Phase 5 Stage B, light and dark: the finished card, local blockers, the
/// Task panel's three views, "Save this as a skill", the approvals and their
/// queue, question cards and the handoff card —
/// `$JUNO_SNAPSHOT_DIR/<name>-<light|dark>.png`.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Phase 5 Stage B snapshots."
    ),
    .serialized
)
struct WorkStageBSnapshotTests {
    private typealias F = WorkStageBFixtures

    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
    }

    @Test(arguments: ["work-done", "work-failed", "work-local-blockers", "approval-single"])
    func cardDrawsInBothAppearances(_ name: String) async throws {
        let state = try #require(F.state(name))
        try await render(F.column { ChatWorkRunCard(state: state, actions: F.actions) }, name: name)
    }

    @Test(arguments: ["task-panel-activity", "task-panel-files", "task-panel-details", "task-panel-empty"])
    func taskPanelDrawsEachView(_ name: String) async throws {
        try await render(F.panel(name).frame(height: 620), name: name, width: 440)
    }

    @Test
    func skillSheetDraws() async throws {
        try await render(F.skillSheet, name: "skill-sheet", width: 640)
    }

    @Test(arguments: ["approval-change-it", "approval-queue", "approval-settled", "question-cards", "handoff-card"])
    func tilesDraw(_ name: String) async throws {
        try await render(F.column { F.tiles(name) }, name: name)
    }

    private func render<V: View>(_ view: V, name: String, width: CGFloat = TranscriptSnapshotRenderer.columnWidth) async throws {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                view, name: name, width: width, appearance: appearance, into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

/// The window with the Task panel open in the dock beside a finished task —
/// `$JUNO_FINAL_SNAPSHOT_DIR/window-task-panel-*.png`.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"] != nil,
        "Set JUNO_FINAL_SNAPSHOT_DIR to render the Phase 5 Stage B window."
    ),
    .serialized
)
struct WorkStageBWindowSnapshotTests {
    @Test
    func theTaskPanelSitsInTheDock() async throws {
        let world = try await SnapshotPreviewWorld.shared()
        world.showConversation()
        let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"]!)
        let done = try #require(WorkStageBFixtures.state("work-done"))
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                FinalSnapshotFixtures.window(
                    world: world, fixedHeight: FinalSnapshotFixtures.windowHeight, selection: .conversation("conv-1")
                ) {
                    HStack(spacing: 0) {
                        TranscriptSnapshotFixtures.column(media: WorkStageBFixtures.media) {
                            TranscriptSnapshotFixtures.row(WorkCardFixtures.quotesQuestion)
                            TranscriptSnapshotFixtures.row(WorkCardFixtures.startedReply, newest: true)
                            ChatWorkRunCard(state: done, actions: WorkStageBFixtures.actions)
                        }
                        .environment(\.junoWorkFiles, WorkStageBFixtures.media)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .clipped()
                        Rectangle().fill(Color.junoHairline).frame(width: 1)
                        ChatWorkPanel(
                            title: "Compare the three vendor quotes",
                            source: .live(done),
                            close: {},
                            details: WorkStageBFixtures.details,
                            initialTab: .files
                        )
                        .environment(\.junoWorkFiles, WorkStageBFixtures.media)
                        .frame(width: 400)
                        .background(Color.junoCard)
                    }
                },
                name: "window-task-panel",
                width: FinalSnapshotFixtures.windowWidth,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

@MainActor
enum WorkStageBFixtures {
    private typealias W = WorkCardFixtures
    static let start = W.start

    static var actions: ChatWorkRunActions {
        ChatWorkRunActions(
            saveSkill: {}, stop: { true }, pause: {}, resume: {}, tryAgain: {}, showDetails: {}
        )
    }

    /// The transcript's column with the task files' pages standing in.
    static func column<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        TranscriptSnapshotFixtures.column { content() }
            .environment(\.junoWorkFiles, media)
    }

    // MARK: Files

    static func artifact(
        _ id: String, _ title: String, _ kind: JunoWorkArtifactKind, _ mime: String,
        version: Int = 1, updated: TimeInterval
    ) -> WorkArtifactSummary {
        WorkArtifactSummary(
            artifactID: id, sessionID: "wsi_current", identifier: id, title: title, kind: kind,
            mimeType: mime, currentVersion: version, validatedAt: start,
            createdAt: start.addingTimeInterval(updated - 60), updatedAt: start.addingTimeInterval(updated)
        )
    }

    static var files: [ChatWorkFile] {
        [
            ChatWorkFile(
                artifact: artifact(
                    "art_cmp", "Vendor comparison", .spreadsheet,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", version: 2, updated: 402
                ),
                size: 88_412
            ),
            ChatWorkFile(
                artifact: artifact(
                    "art_memo", "Recommendation memo", .document,
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", updated: 410
                ),
                size: 24_310
            ),
            ChatWorkFile(
                artifact: artifact("art_quotes", "Quotes side by side", .pdf, "application/pdf", updated: 380),
                size: 211_804
            ),
        ]
    }

    /// The pages on the tiles: a workbook's grid, a memo's opening lines, a
    /// PDF's first page.
    static var media: SnapshotMediaProvider {
        let ids = files.map(\.attachment.id)
        return SnapshotMediaProvider(previews: [
            ids[0]: .ready(NativeTranscriptFilePreview(
                thumbnail: SnapshotStills.cgImage(SnapshotStills.spreadsheetThumbnail())
            )),
            ids[1]: .ready(NativeTranscriptFilePreview(excerpt: """
                Recommendation

                Go with Corvid Supply. Lowest total over a year at 1,140 units, a 9-day lead time, and next-day support replies.
                """)),
            ids[2]: .ready(NativeTranscriptFilePreview(
                thumbnail: SnapshotStills.cgImage(SnapshotStills.pdfPageThumbnail(size: CGSize(width: 240, height: 310)))
            )),
        ])
    }

    // MARK: Cards

    static func state(_ name: String) -> ChatWorkRunState? {
        switch name {
        case "work-done": return done
        case "work-failed": return failed
        case "work-local-blockers":
            guard var live = W.state("work-live") else { return nil }
            live.blockers = [ChatWorkLocalBlocker(kind: .accessibility), ChatWorkLocalBlocker(kind: .screenRecording)]
            return live
        case "approval-single":
            return ChatWorkRunState(
                session: W.session(status: "waiting_approval"), status: .waitingApproval,
                run: W.run(status: "waiting_approval"),
                events: W.planEvents(done: 6) + [
                    W.event(50, .stepStarted, ["stepId": .string("s7"), "title": .string("Write the recommendation")]),
                    W.event(51, .assistantMessage, ["text": .string("The memo is ready. I’d like to send it to Priya at Corvid.")]),
                    W.event(52, .approvalRequested, [
                        "approvalId": .string("ap_send"), "action": .string("work.connector.send_message"),
                        "summary": .string("Send the recommendation memo to Priya Raman at Corvid Supply"),
                    ]),
                ],
                questions: [],
                approvals: [ChatWorkApproval(request: sendApproval, isLocal: false)],
                now: start.addingTimeInterval(500)
            )
        default: return nil
        }
    }

    static var done: ChatWorkRunState {
        ChatWorkRunState(
            session: W.session(status: "completed"), status: .completed,
            run: W.run(status: "completed", finished: 418),
            events: W.planEvents(done: 7) + [
                W.event(60, .assistantMessage, [
                    "text": .string("Done. **Corvid Supply** is the best fit: the lowest total over a year and a 9-day lead time."),
                ]),
            ],
            questions: [], approvals: [],
            now: start.addingTimeInterval(700),
            files: files
        )
    }

    static var failed: ChatWorkRunState {
        let events = W.planEvents(done: 2) + [
            W.event(30, .stepStarted, ["stepId": .string("s3")]),
            W.event(31, .toolStarted, [
                "callId": .string("c1"), "risk": .string("edit"), "summary": .string("Saving the partial comparison"),
            ]),
            W.event(32, .toolFinished, ["callId": .string("c1"), "summary": .string("Saved the partial comparison")]),
            W.event(33, .assistantMessage, [
                "text": .string("I read the Brightline and Corvid quotes. The Hale portal stopped answering before I could open theirs."),
            ]),
            W.event(34, .stepFinished, ["stepId": .string("s3"), "state": .string("failed")]),
            W.event(35, .runFinished, ["reason": .string("error")]),
        ]
        return ChatWorkRunState(
            session: W.session(status: "failed"), status: .failed,
            run: W.run(
                status: "failed", finished: 131, reason: "error",
                detail: "The Hale supplier portal stopped answering after three tries, so its quote was never read.",
                degradation: [WorkDegradation(
                    kind: "connector_missing",
                    explanation: "Gmail isn’t connected, so the quotes that arrived by email were not read.",
                    subject: "gmail"
                )],
                cost: 96_120
            ),
            events: events, questions: [], approvals: [],
            now: start.addingTimeInterval(300)
        )
    }

    // MARK: Approvals

    static var sendApproval: WorkApprovalRequest {
        WorkApprovalRequest(
            approvalID: "ap_send", runID: "run_1", action: "work.connector.send_message", risk: "irreversible",
            summary: "Send the recommendation memo to Priya Raman at Corvid Supply",
            detail: [
                "to": .string("priya.raman@corvidsupply.example"),
                "subject": .string("Our Q4 order"),
                "body": .string("Hi Priya,\n\nWe’d like to go ahead with Corvid for the Q4 order of 1,140 units. The memo attached sets out the terms we compared.\n\nThanks,\nLiam"),
                "attachments": .number(1),
            ],
            actionDigest: "d_send", expiresAt: start.addingTimeInterval(500 + 14 * 60),
            decision: "pending", createdAt: start.addingTimeInterval(262)
        )
    }

    static func edit(_ id: String, _ file: String, asked: TimeInterval) -> WorkApprovalRequest {
        WorkApprovalRequest(
            approvalID: id, runID: "run_1", action: "apply_changes", risk: "edit",
            summary: "Rename \(file) to match the vendor",
            detail: ["paths": .array([.string("Vendors/Quotes/\(file)")]), "operation": .string("rename")],
            actionDigest: "d_\(id)", expiresAt: start.addingTimeInterval(asked + 20 * 60),
            decision: "pending", createdAt: start.addingTimeInterval(asked)
        )
    }

    static func settled(_ decision: String, _ summary: String, action: String, risk: String, decided: TimeInterval?) -> WorkApprovalRequest {
        WorkApprovalRequest(
            approvalID: "ap_\(decision)", runID: "run_1", action: action, risk: risk, summary: summary,
            detail: [:], actionDigest: "d", expiresAt: start.addingTimeInterval(decision == "expired" ? 100 : 5_000),
            decision: decision, createdAt: start.addingTimeInterval(60),
            decidedAt: decided.map { start.addingTimeInterval($0) }
        )
    }

    @ViewBuilder
    static func tiles(_ name: String) -> some View {
        let now = start.addingTimeInterval(500)
        switch name {
        case "approval-change-it":
            ChatWorkApprovalCard(
                approval: sendApproval, now: now,
                amendment: "Send it to orders@corvidsupply.example instead, and copy me.",
                decide: { _, _ in }
            )
        case "approval-queue":
            ChatWorkApprovalQueue(
                approvals: [
                    edit("ap_1", "brightline-q3.pdf", asked: 431),
                    edit("ap_2", "corvid-quote-final.pdf", asked: 433),
                    edit("ap_3", "hale_quote (2).pdf", asked: 436),
                ].map { ChatWorkApproval(request: $0, isLocal: false) },
                now: now, decide: { _, _, _ in }, decideAll: { _ in }
            )
        case "approval-settled":
            VStack(alignment: .leading, spacing: JunoSpace.close) {
                ChatWorkApprovalCard(
                    approval: settled("allowed", "Rename 3 quote files to match the vendor", action: "apply_changes", risk: "edit", decided: 262),
                    now: now, decide: { _, _ in }
                )
                ChatWorkApprovalCard(
                    approval: settled("denied", "Send the comparison to the whole purchasing list", action: "work.connector.send_message", risk: "irreversible", decided: 391),
                    now: now, decide: { _, _ in }
                )
                ChatWorkApprovalCard(
                    approval: settled("expired", "Run the price export script", action: "run_command", risk: "command", decided: nil),
                    now: now, decide: { _, _ in }
                )
            }
        case "question-cards":
            VStack(alignment: .leading, spacing: JunoSpace.close) {
                ChatWorkQuestionCard(
                    question: WorkQuestionPrompt(
                        questionID: "q_1", text: "Should I compare everything in euros?",
                        options: ["Yes, use euros", "Keep each currency"],
                        why: "Brightline quotes in dollars, and the rate moved 2% this month.",
                        askedAt: start.addingTimeInterval(380)
                    ),
                    isCurrent: true, now: now, answer: { _ in }, replyBelow: {}
                )
                ChatWorkQuestionCard(
                    question: WorkQuestionPrompt(
                        questionID: "q_2", text: "Is next-day support a must, or a nice-to-have?",
                        options: [], why: nil, askedAt: start.addingTimeInterval(391)
                    ),
                    isCurrent: false, now: now, answer: { _ in }, replyBelow: {}
                )
            }
        case "handoff-card":
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                DesktopApprovalCard(
                    approval: handoff(status: .pending, untrusted: true), isBusy: false, errorMessage: nil,
                    canAllowScope: false, decide: { _ in }
                )
                DesktopApprovalCard(
                    approval: handoff(status: .executed, untrusted: false), isBusy: false, errorMessage: nil,
                    canAllowScope: false, decide: { _ in }
                )
            }
        default:
            EmptyView()
        }
    }

    static func handoff(status: NativeChatApprovalStatus, untrusted: Bool) -> NativeChatApproval {
        NativeChatApproval(
            id: "appr-handoff-\(status.rawValue)", surface: "chat", sessionID: "juno-native-1",
            conversationID: "conv-1", connectorID: "juno_work", connectorLabel: "Juno",
            toolName: "hand_off_to_teammate", action: "hand_off_to_teammate", riskClass: .externalWrite,
            preview: "Hand “Chase the Corvid contract” to Ada",
            detail: [
                "title": .string("Chase the Corvid contract"),
                "teammate": .string("Ada"),
                "estimate": .string("about $0.64"),
                "goal": .string("Get the signed Corvid Supply contract back before Friday. Priya Raman is the contact; the memo in this chat has the agreed terms."),
            ],
            receiptDigest: "digest", status: status, decision: status == .pending ? nil : "allow_once",
            canAllowScope: false, derivedFromUntrusted: untrusted,
            expiresAt: Date().addingTimeInterval(status == .pending ? 9 * 60 + 40 : -60),
            decidedAt: nil, completedAt: nil, createdAt: Date()
        )
    }

    // MARK: The Task panel

    static let details = ChatWorkPanelDetails(connectedApps: "Gmail, Google Drive", now: start.addingTimeInterval(700))

    @ViewBuilder
    static func panel(_ name: String) -> some View {
        switch name {
        case "task-panel-activity":
            ChatWorkPanel(
                title: "Draft the vendor shortlist", source: .snapshot(W.panelSnapshot), close: {},
                details: details, initialTab: .activity
            )
        case "task-panel-files":
            ChatWorkPanel(
                title: "Compare the three vendor quotes", source: .live(done), close: {},
                details: details, initialTab: .files
            )
            .environment(\.junoWorkFiles, media)
        case "task-panel-details":
            ChatWorkPanel(
                title: "Compare the three vendor quotes", source: .live(done), close: {},
                details: details, initialTab: .details
            )
        default:
            ChatWorkPanel(
                title: "Draft the vendor shortlist", source: .snapshot(W.panelSnapshot), close: {},
                details: details, initialTab: .files
            )
        }
    }

    // MARK: Save this as a skill

    static var skillSheet: some View {
        let done = done
        let session = W.session(
            status: "completed",
            goal: "Compare the three vendor quotes in Vendors/Quotes on price over a year, lead time and support terms, and recommend one for the Q4 order. Put the numbers side by side in a workbook."
        )
        let performed = WorkEventLog.PerformedActions(
            actions: [
                .init(id: 1, summary: "Created Vendor comparison", at: start, approved: false),
                .init(id: 2, summary: "Created Recommendation memo", at: start, approved: false),
            ],
            unclassified: 0
        )
        return ChatSkillCaptureSheet(
            draft: .from(session: session, plan: done.plan, performed: performed),
            save: { _ in nil }, close: {}
        )
        .junoAccentTint()
    }
}
