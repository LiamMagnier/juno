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

/// Phase 5 Stage A, light and dark: the chat's task card, its place in the
/// transcript, the steering composer and the Task panel's first cut —
/// `$JUNO_SNAPSHOT_DIR/<name>-<light|dark>.png`.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Phase 5 snapshots."
    ),
    .serialized
)
struct WorkCardSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
    }

    @Test(arguments: ["work-live", "work-live-agent", "work-waiting-question", "work-finished"])
    func cardDrawsInBothAppearances(_ name: String) async throws {
        let state = try #require(WorkCardFixtures.state(name))
        try await render(
            WorkCardFixtures.column { ChatWorkRunCard(state: state, actions: WorkCardFixtures.actions) },
            name: name
        )
    }

    @Test
    func placementDrawsEarlierTasksAsRowsAndTheCurrentAsACard() async throws {
        try await render(WorkCardFixtures.placement, name: "work-placement")
    }

    @Test(arguments: ["composer-steer-empty", "composer-steer-draft", "composer-steer-queue", "composer-steer-answer", "composer-steer-research"])
    func steeringComposerDrawsInBothAppearances(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.shared()
        world.showConversation()
        try await render(WorkCardFixtures.composer(name, world: world), name: name)
    }

    @Test
    func taskPanelDrawsAnEarlierTaskReadOnce() async throws {
        try await render(
            ChatWorkPanel(
                title: "Draft the vendor shortlist",
                source: .snapshot(WorkCardFixtures.panelSnapshot),
                close: {}
            )
            .frame(height: 560),
            name: "task-panel-activity",
            width: 480
        )
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

/// The window composition: the task card beside the sidebar, the steering
/// composer docked under it — `$JUNO_FINAL_SNAPSHOT_DIR/window-task-live-*.png`.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"] != nil,
        "Set JUNO_FINAL_SNAPSHOT_DIR to render the Phase 5 window."
    ),
    .serialized
)
struct WorkWindowSnapshotTests {
    @Test
    func theTaskLivesInItsChat() async throws {
        let world = try await SnapshotPreviewWorld.shared()
        world.showConversation()
        let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"]!)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                FinalSnapshotFixtures.window(world: world, fixedHeight: nil, selection: .conversation("conv-1")) {
                    VStack(spacing: 0) {
                        TranscriptSnapshotFixtures.column {
                            TranscriptSnapshotFixtures.row(WorkCardFixtures.quotesQuestion)
                            TranscriptSnapshotFixtures.row(WorkCardFixtures.startedReply, newest: true)
                            ChatWorkRunCard(state: WorkCardFixtures.state("work-live")!, actions: WorkCardFixtures.actions)
                        }
                        WorkCardFixtures.dockedComposer(
                            world: world, steering: WorkCardFixtures.taskSteering(pending: 1), prompt: nil
                        )
                    }
                },
                name: "window-task-live",
                width: FinalSnapshotFixtures.windowWidth,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

@MainActor
enum WorkCardFixtures {
    static let start = Date(timeIntervalSince1970: 1_790_000_000)
    private typealias T = TranscriptSnapshotFixtures

    static var actions: ChatWorkRunActions {
        ChatWorkRunActions(
            stop: { true }, pause: {}, resume: {}, tryAgain: {}, showDetails: {}
        )
    }

    /// The transcript's column, holding a card as a turn would.
    static func column<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        T.column { content() }
    }

    // MARK: The card

    static func state(_ name: String) -> ChatWorkRunState? {
        switch name {
        case "work-live", "work-live-agent":
            ChatWorkRunState(
                session: session(status: "running"), status: .running,
                run: run(status: "running"),
                events: planEvents(done: 3) + liveTurns + [
                    event(40, .stepStarted, ["stepId": .string("s4"), "title": .string("Compare lead times")]),
                    event(41, .toolStarted, [
                        "summary": .string("Reading the Brightline quote"),
                        "detail": .string("Brightline-Q3-quote.pdf"),
                    ]),
                ],
                questions: [], approvals: [],
                now: start.addingTimeInterval(263),
                actor: name == "work-live-agent" ? "Ada" : nil
            )
        case "work-waiting-question":
            ChatWorkRunState(
                session: session(status: "waiting_input"), status: .waitingInput,
                run: run(status: "waiting_input"),
                events: planEvents(done: 2) + [
                    event(30, .assistantMessage, [
                        "text": .string("Two of the quotes price in euros and one in dollars."),
                    ]),
                    event(31, .questionAsked, [
                        "questionId": .string("q_1"),
                        "question": .string("Should I compare everything in euros?"),
                        "why": .string("Brightline quotes in dollars, and the rate moved 2% this month."),
                        "options": .array([.string("Yes, use euros"), .string("Keep each currency")]),
                    ]),
                ],
                questions: [
                    WorkQuestionPrompt(
                        questionID: "q_1", text: "Should I compare everything in euros?",
                        options: ["Yes, use euros", "Keep each currency"],
                        why: "Brightline quotes in dollars, and the rate moved 2% this month.",
                        askedAt: start.addingTimeInterval(31)
                    ),
                ],
                approvals: [],
                now: start.addingTimeInterval(151)
            )
        case "work-finished":
            ChatWorkRunState(
                session: session(status: "completed"), status: .completed,
                run: run(status: "completed", finished: 418),
                events: planEvents(done: 7) + liveTurns + [
                    event(60, .assistantMessage, [
                        "text": .string("Done. **Corvid Supply** is the best fit: the lowest total over a year and a 9-day lead time."),
                    ]),
                ],
                questions: [], approvals: [],
                now: start.addingTimeInterval(600)
            )
        default: nil
        }
    }

    private static var liveTurns: [WorkEvent] {
        [
            event(20, .assistantMessage, ["text": .string("Found all three quotes in the Vendors folder.")]),
            event(21, .assistantMessage, ["text": .string("Brightline and Corvid include delivery; Hale does not.")]),
            event(22, .assistantMessage, ["text": .string("Normalising the prices to a year of usage, at 1,140 units.")]),
            event(23, .assistantMessage, [
                "text": .string("**Hale** is cheapest per unit, but its delivery adds about 11% once it is counted."),
            ]),
            event(24, .assistantMessage, ["text": .string("Checking support terms next: two offer next-day replies.")]),
        ]
    }

    private static let stepTitles = [
        "Find the three quotes",
        "Read each quote",
        "Normalise prices to a year",
        "Compare lead times",
        "Compare support terms",
        "Rank the vendors",
        "Write the recommendation",
    ]

    private static func planEvents(done: Int) -> [WorkEvent] {
        var events = [
            event(4, .planCreated, [
                "steps": .array(stepTitles.enumerated().map { index, title in
                    .object(["id": .string("s\(index + 1)"), "title": .string(title)])
                }),
            ]),
        ]
        for index in 0..<done {
            events.append(event(5 + index * 2, .stepStarted, ["stepId": .string("s\(index + 1)")]))
            events.append(event(6 + index * 2, .stepFinished, ["stepId": .string("s\(index + 1)")]))
        }
        return events
    }

    static func session(
        id: String = "wsi_current", title: String = "Compare the three vendor quotes",
        status: String, created: TimeInterval = 0
    ) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: id, title: title,
            goal: title, status: status, needsAttention: status.hasPrefix("waiting"),
            requestedTarget: "automatic", effectiveTarget: "cloud", hostID: nil,
            hostDisplayName: nil, pinned: false, archived: false,
            lastActivityAt: start.addingTimeInterval(created),
            currentRunID: "run_1", lastSeq: 41, conversationID: "conv-1",
            createdAt: start.addingTimeInterval(created)
        )
    }

    private static func run(status: String, finished: TimeInterval? = nil) -> WorkRunSummary {
        WorkRunSummary(
            runID: "run_1", sessionID: "wsi_current", attempt: 1, status: status,
            terminalReason: finished == nil ? nil : "completed", requestedTarget: "automatic",
            effectiveTarget: "cloud", hostID: nil, effectiveModel: nil, degradation: [],
            costMicroUsd: finished == nil ? 187_400 : 412_900, maxCostMicroUsd: 2_000_000,
            lastSeq: 41, startedAt: start, finishedAt: finished.map { start.addingTimeInterval($0) },
            inputTokens: finished == nil ? 38_912 : 81_406, outputTokens: finished == nil ? 4_207 : 9_388
        )
    }

    private static func event(
        _ seq: Int, _ kind: JunoWorkEventKind, _ payload: [String: JunoJSONValue]
    ) -> WorkEvent {
        WorkEvent(
            seq: seq, kind: kind.rawValue, payload: payload, agentID: nil,
            createdAt: start.addingTimeInterval(Double(seq))
        )
    }

    // MARK: Placement

    static let quotesQuestion = T.message(
        "q-3", .user, "Can you compare the three vendor quotes and tell me which to go with?"
    ).with { $0.createdAt = start.addingTimeInterval(-4) }

    static let startedReply = T.message(
        "a-3", .assistant,
        "I’ve started a task to compare them on price, lead time and support. It will ask if it needs you.",
        model: "anthropic:claude-sonnet-4-6"
    ).with { $0.createdAt = start.addingTimeInterval(-2) }

    private static var placementMessages: [NativeChatMessage] {
        [
            T.message("q-1", .user, "Pull last quarter’s supplier invoices into one sheet.")
                .with { $0.createdAt = start.addingTimeInterval(-7_200) },
            T.message("a-1", .assistant, "Started a task to gather them.", model: "anthropic:claude-sonnet-4-6")
                .with { $0.createdAt = start.addingTimeInterval(-7_190) },
            T.message("q-2", .user, "Now draft a shortlist of vendors from that sheet.")
                .with { $0.createdAt = start.addingTimeInterval(-3_600) },
            T.message("a-2", .assistant, "Started a task for the shortlist.", model: "anthropic:claude-sonnet-4-6")
                .with { $0.createdAt = start.addingTimeInterval(-3_590) },
            quotesQuestion,
            startedReply,
        ]
    }

    private static var placementEntries: [ChatWorkRunEntry] {
        [
            ChatWorkRunEntry(
                session: session(id: "wsi_a", title: "Gather last quarter’s supplier invoices", status: "completed", created: -7_195),
                status: .completed, isCurrent: false
            ),
            ChatWorkRunEntry(
                session: session(id: "wsi_b", title: "Draft the vendor shortlist", status: "failed", created: -3_595),
                status: .failed, isCurrent: false
            ),
            ChatWorkRunEntry(session: session(status: "running", created: -1), status: .running, isCurrent: true),
        ]
    }

    /// Three turns, a task after each of the first two (settled) and the
    /// current one after the third reply — placed by ``ChatWorkPlacement``,
    /// the rule the transcript uses.
    static var placement: some View {
        let messages = placementMessages
        let entries = placementEntries
        let turns = messages.map {
            ChatWorkPlacement.Turn(id: $0.id, isUser: $0.role == .user, createdAt: $0.createdAt)
        }
        return T.column {
            ForEach(messages, id: \.id) { message in
                T.row(message, newest: message.id == "a-3")
                ForEach(entries.filter { ChatWorkPlacement.anchor(for: $0.createdAt, in: turns) == message.id }) { entry in
                    placedRow(entry)
                }
            }
        }
    }

    @ViewBuilder
    private static func placedRow(_ entry: ChatWorkRunEntry) -> some View {
        if entry.isCurrent, let live = state("work-live") {
            ChatWorkRunCard(state: live, actions: actions)
        } else {
            ChatWorkSettledRow(session: entry.session, status: entry.status, open: {})
        }
    }

    // MARK: The steering composer

    static let pendingSteers = [
        ChatPendingSteer(id: 90, text: "Leave Hale out if their delivery can’t be under two weeks.", at: start.addingTimeInterval(-160)),
        ChatPendingSteer(id: 91, text: "Use the 2026 price list, not last year’s.", at: start.addingTimeInterval(-70)),
        ChatPendingSteer(id: 92, text: "And put the recommendation first.", at: start.addingTimeInterval(-8)),
    ]

    static func taskSteering(pending: Int, answering: Bool = false) -> ChatComposerSteering {
        var steering = ChatComposerSteering.task(
            answering: answering, isGenerating: false,
            pending: Array(pendingSteers.suffix(pending)),
            steer: { _ in true }, stop: {}
        )
        steering.clock = start
        return steering
    }

    static func composer(_ name: String, world: SnapshotPreviewWorld) -> some View {
        let steering: ChatComposerSteering
        var prompt: String?
        switch name {
        case "composer-steer-draft":
            steering = taskSteering(pending: 1)
            prompt = "Also flag any quote that expires this month."
        case "composer-steer-queue":
            steering = taskSteering(pending: 3)
        case "composer-steer-answer":
            steering = taskSteering(pending: 0, answering: true)
            prompt = "Yes, convert everything to euros at today’s rate."
        case "composer-steer-research":
            // Research steers only while its turn streams; the harness has no
            // stream, so the fixture says standalone to draw that state.
            steering = ChatComposerSteering(
                kind: .research, standalone: true, stopLabel: "Stop the research",
                steer: { _ in true }, stop: {}
            )
        default:
            steering = taskSteering(pending: 0)
        }
        return dockedComposer(world: world, steering: steering, prompt: prompt)
            .padding(.vertical, JunoSpace.section)
            .environment(\.junoSnapshotOpaqueGlass, true)
            .junoAccentTint()
    }

    static func dockedComposer(world: SnapshotPreviewWorld, steering: ChatComposerSteering, prompt: String?) -> some View {
        ChatComposerDock(
            lift: ChatComposerLift.resting,
            gutter: DesktopChatMeasure.gutter(forColumnWidth: TranscriptSnapshotRenderer.columnWidth)
        ) {
            EmptyView()
        } composer: {
            ChatComposer(
                model: world.world.conversationModel,
                attachmentModel: nil,
                libraryModel: nil,
                projectModel: world.world.projectModel,
                workspaceModel: nil,
                documentIndex: nil,
                connectorModel: nil,
                steering: steering,
                memorySettings: nil,
                draftProjectID: .constant(nil),
                draftPrompt: .constant(prompt),
                openVoiceMode: { _ in }
            )
            .environment(\.junoSnapshotOpaqueGlass, true)
        } footer: {
            EmptyView()
        }
        .padding(.top, JunoSpace.cozy)
    }

    // MARK: The Task panel

    static var panelSnapshot: ChatWorkPanelSnapshot {
        let events: [WorkEvent] = [
            event(1, .runStarted, [:]),
            event(2, .toolStarted, ["summary": .string("Reading the invoice sheet"), "tool": .string("read_file")]),
            event(3, .toolFinished, ["summary": .string("Read the invoice sheet"), "tool": .string("read_file")]),
            event(4, .assistantMessage, ["text": .string("Eleven vendors appear more than twice.")]),
            event(5, .toolStarted, ["summary": .string("Searching for vendor reviews"), "tool": .string("web_search")]),
            event(6, .toolFinished, ["summary": .string("Searched for vendor reviews"), "tool": .string("web_search")]),
            event(7, .error, ["message": .string("The review site refused the request.")]),
            event(8, .runFinished, ["status": .string("failed")]),
        ]
        return ChatWorkPanelSnapshot(
            update: WorkStreamUpdate(
                session: session(id: "wsi_b", title: "Draft the vendor shortlist", status: "failed", created: -3_595),
                run: nil, events: events, approvals: []
            ),
            readAt: start,
            isLoading: false
        )
    }
}
