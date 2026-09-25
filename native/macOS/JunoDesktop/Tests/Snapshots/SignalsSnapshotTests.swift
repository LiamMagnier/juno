import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoWorkKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// Phase 5 Stage C, light and dark: the status dots, the sidebar's Needs-you
/// fold (off and filtering), the Agents fold, the Notifications row and its
/// popover in every state, and an agent's thread —
/// `$JUNO_SNAPSHOT_DIR/<name>-<light|dark>.png`.
///
/// The menu-bar extra and the Dock badge cannot be drawn offscreen; their
/// rules are asserted in ``DesktopNeedsYouSignalsTests``.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Phase 5 Stage C snapshots."
    ),
    .serialized
)
struct SignalsSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
    }

    @Test
    func statusDots() async throws {
        try await render(SignalsFixtures.statusDots, name: "status-dots", width: 520)
    }

    @Test
    func needsYouFoldOffAndFiltering() async throws {
        let world = try await SnapshotPreviewWorld.shared()
        world.showDraft()
        let sidebar = FinalSnapshotFixtures.sidebarWidth
        try await render(
            HStack(spacing: 0) {
                SignalsFixtures.sidebar(world: world, filtering: false)
                    .frame(width: sidebar)
                Rectangle().fill(Color.junoBorder).frame(width: 1)
                SignalsFixtures.sidebar(world: world, filtering: true)
                    .frame(width: sidebar)
            }
            .frame(height: 760),
            name: "sidebar-needs-you",
            width: sidebar * 2 + 1
        )
    }

    @Test
    func agentsFoldLeadsWithTheWaitingAgent() async throws {
        let world = try await SnapshotPreviewWorld.shared()
        world.showDraft()
        let agents = try await SignalsFixtures.agents(world: world)
        try await render(
            SignalsFixtures.sidebar(world: world, filtering: false, agents: agents)
                .frame(height: 880),
            name: "sidebar-agents",
            width: FinalSnapshotFixtures.sidebarWidth
        )
    }

    @Test
    func notificationsRowInItsThreeStates() async throws {
        try await render(SignalsFixtures.notificationRows, name: "sidebar-notifications-row", width: FinalSnapshotFixtures.sidebarWidth)
    }

    @Test(arguments: ["notifications-popover", "notifications-empty", "notifications-error", "notifications-loading"])
    func notificationsPopover(_ name: String) async throws {
        try await render(
            SignalsFixtures.popover(name),
            name: name,
            width: DesktopNotificationsPopover.width + 48
        )
    }

    @Test
    func agentThreadHeader() async throws {
        try await render(SignalsFixtures.threadHeaders, name: "agent-thread-header")
    }

    @Test
    func agentThreadEmpty() async throws {
        let world = try await SnapshotPreviewWorld.shared()
        let agents = try await SignalsFixtures.agents(world: world)
        var configuration = world.configuration
        configuration.agentsModel = agents
        world.world.conversationModel.isDraftingNewConversation = false
        world.world.conversationModel.selectedConversationID = SignalsFixtures.irisThread
        try await render(
            FinalSnapshotFixtures.window(
                world: world, fixedHeight: FinalSnapshotFixtures.windowHeight,
                selection: .conversation(SignalsFixtures.irisThread)
            ) {
                DesktopConversationView(
                    model: world.world.conversationModel,
                    attachmentModel: world.world.attachmentModel,
                    profileName: "Liam",
                    configuration: configuration,
                    session: world.world.session,
                    draftProjectID: .constant(nil),
                    draftPrompt: .constant(nil),
                    composerRequest: .constant(nil),
                    findCommand: .constant(nil),
                    openDestination: { _ in }
                )
                .frame(height: FinalSnapshotFixtures.windowHeight - FinalSnapshotFixtures.toolbarHeight)
            },
            name: "agent-thread-empty",
            width: FinalSnapshotFixtures.windowWidth
        )
        world.showDraft()
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

/// The window composition: the whole column — the inbox's dot, the Needs-you
/// fold, the Agents fold — beside a chat whose task is waiting on the reader.
/// `$JUNO_FINAL_SNAPSHOT_DIR/window-sidebar-signals-*.png`.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"] != nil,
        "Set JUNO_FINAL_SNAPSHOT_DIR to render the Phase 5 Stage C window."
    ),
    .serialized
)
struct SignalsWindowSnapshotTests {
    @Test
    func theColumnSaysWhatIsWaiting() async throws {
        let world = try await SnapshotPreviewWorld.shared()
        world.showConversation()
        let agents = try await SignalsFixtures.agents(world: world)
        let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"]!)
        let selection = DesktopSidebarItem.conversation(SignalsFixtures.waitingChat)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let window = FinalSnapshotFixtures.window(world: world, fixedHeight: nil, selection: nil) {
                VStack(spacing: 0) {
                    TranscriptSnapshotFixtures.column {
                        TranscriptSnapshotFixtures.row(WorkCardFixtures.quotesQuestion)
                        TranscriptSnapshotFixtures.row(WorkCardFixtures.startedReply, newest: true)
                        ChatWorkRunCard(state: WorkCardFixtures.state("work-waiting-question")!, actions: WorkCardFixtures.actions)
                    }
                    WorkCardFixtures.dockedComposer(
                        world: world, steering: WorkCardFixtures.taskSteering(pending: 0, answering: true), prompt: nil
                    )
                }
            }
            // The window's own column is Phase 1's; this one carries the
            // signals, drawn over it at the same place.
            .overlay(alignment: .topLeading) {
                SignalsFixtures.sidebar(world: world, filtering: false, agents: agents, selection: selection)
                    .frame(width: FinalSnapshotFixtures.sidebarWidth)
                    .frame(maxHeight: .infinity, alignment: .top)
            }
            let url = try await TranscriptSnapshotRenderer.render(
                window,
                name: "window-sidebar-signals",
                width: FinalSnapshotFixtures.windowWidth,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

// MARK: - Fixtures

@MainActor
enum SignalsFixtures {
    static let now = Date(timeIntervalSince1970: 1_790_000_000)
    /// The preview world's chats: "Astro report draft" is waiting on an
    /// approval, "Weekend trip planning" is Iris's thread and waiting on an
    /// answer, "Designing the native sidebar" (pinned) is running.
    static let waitingChat = "conv-proj"
    static let irisThread = "conv-2"
    static let runningChat = "conv-1"

    static var runs: WorkRunsByConversation {
        WorkRunsByConversation(sessions: [
            session("wsi_astro", title: "Check the report’s figures", conversation: waitingChat, status: "waiting_approval", minutesAgo: 3),
            session("wsi_trip", title: "Book the cabin", conversation: irisThread, status: "waiting_input", minutesAgo: 9),
            session("wsi_sidebar", title: "Audit the sidebar", conversation: runningChat, status: "running", minutesAgo: 1),
        ])
    }

    static func session(
        _ id: String, title: String, conversation: String, status: String, minutesAgo: Double
    ) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: id, title: title, goal: title, status: status,
            needsAttention: status.hasPrefix("waiting"),
            requestedTarget: "automatic", effectiveTarget: "cloud", hostID: nil,
            hostDisplayName: nil, pinned: false, archived: false,
            lastActivityAt: now.addingTimeInterval(-minutesAgo * 60), currentRunID: "run_\(id)",
            lastSeq: 12, conversationID: conversation, createdAt: now.addingTimeInterval(-minutesAgo * 60 - 300)
        )
    }

    /// The column over the preview world, with the fixture's runs, an inbox
    /// holding a pressing unread row, and — when given — the agents.
    static func sidebar(
        world: SnapshotPreviewWorld,
        filtering: Bool,
        agents: NativeAgentsModel? = nil,
        selection: DesktopSidebarItem? = nil
    ) -> some View {
        DesktopChatSidebar(
            model: world.world.conversationModel,
            projectModel: world.world.projectModel,
            configuration: world.configuration,
            session: world.world.session,
            product: .constant(.chat),
            destination: .constant(.chat),
            selection: .constant(selection),
            renamingConversationID: .constant(nil),
            openProjectID: nil,
            actions: DesktopConversationActions(
                rename: { _ in }, commitRename: { _, _ in }, togglePin: { _ in },
                move: { _, _ in }, newProject: { _ in }, openProject: { _ in },
                share: { _ in }, canShare: { _ in true }, archive: { _, _ in }, delete: { _ in }
            ),
            newChat: {},
            newChatInProject: { _ in },
            openSearch: {},
            agentsModel: agents,
            messageAgent: { _ in },
            hireAgent: {},
            runs: runs,
            notificationsModel: inbox(count: .init(unreadCount: 3, urgent: true)),
            startsFilteringNeedsYou: filtering
        )
        .scrollContentBackground(.hidden)
        .padding(.top, FinalSnapshotFixtures.toolbarHeight)
        .background(Color.junoSidebar)
        .environment(\.junoSnapshotOpaqueGlass, true)
    }

    // MARK: Agents

    static func agents(world: SnapshotPreviewWorld) async throws -> NativeAgentsModel {
        let model = NativeAgentsModel(client: NativeAgentsClient(sender: SignalsAgentsSender()))
        await model.start(for: world.world.accountID)
        return model
    }

    static func agent(
        id: String, name: String, role: String, state: JunoAgentState, sentence: String,
        status: NativeAgentStatus = .active, avatar: JunoAgentAvatar? = nil, thread: String? = nil
    ) -> NativeAgent {
        SnapshotAgents.agent(
            id: id, name: name, role: role, state: state, sentence: sentence,
            status: status, avatar: avatar, thread: thread
        )
    }

    // MARK: Dots

    static var statusDots: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            dotRow(title: "Status dots", glyphs: false)
            dotRow(title: "Differentiate Without Color", glyphs: true)
        }
        .padding(JunoSpace.section)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private static func dotRow(title: String, glyphs: Bool) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(title)
                .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                .foregroundStyle(Color.junoForeground)
            HStack(spacing: JunoSpace.section) {
                ForEach(JunoStatusTone.allCases, id: \.self) { tone in
                    HStack(spacing: JunoSpace.tight) {
                        JunoStatusDot(tone, label: label(tone), breathes: false, differentiatesWithoutColor: glyphs)
                        Text(label(tone))
                            .junoFont(size: 12, relativeTo: .footnote)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                }
            }
        }
    }

    private static func label(_ tone: JunoStatusTone) -> String {
        switch tone {
        case .neutral: "Queued"
        case .live: "Running"
        case .attention: "Needs approval"
        case .good: "Done"
        case .bad: "Failed"
        }
    }

    // MARK: Notifications

    static func inbox(
        count: NativeNotificationsCount?,
        items: [NativeNotification]? = nil,
        state: NativeNotificationsModel.ListState = .idle,
        nextBefore: String? = nil
    ) -> NativeNotificationsModel {
        let model = NativeNotificationsModel(client: NativeNotificationsClient(sender: SignalsNoNetwork()))
        model.preview(count: count, items: items, state: state, nextBefore: nextBefore)
        return model
    }

    static var notificationRows: some View {
        VStack(spacing: 0) {
            ForEach(
                Array(
                    [
                        NativeNotificationsCount(unreadCount: 2, urgent: true),
                        NativeNotificationsCount(unreadCount: 5, urgent: false),
                        NativeNotificationsCount(unreadCount: 0, urgent: false),
                    ].enumerated()
                ),
                id: \.offset
            ) { _, count in
                List {
                    DesktopNotificationsRow(model: inbox(count: count))
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
                .scrollDisabled(true)
                .frame(height: 44)
            }
        }
        .padding(.vertical, JunoSpace.snug)
        .background(Color.junoSidebar)
    }

    static let rows: [NativeNotification] = [
        NativeNotification(
            id: "n1", type: "work_needs_you", title: "Iris needs your approval",
            body: "Send the vendor shortlist to finance", priority: .urgent, actionable: true,
            href: "/chat/conv-2",
            agent: .init(id: "agent-iris", name: "Iris", avatarShape: "orb", avatarTone: "violet", avatarEyes: "soft", avatarMark: "spark"),
            createdAt: now.addingTimeInterval(-4 * 60)
        ),
        NativeNotification(
            id: "n2", type: "work_completed", title: "Task finished",
            body: "Check the report’s figures: 3 corrections, all in the appendix", priority: .normal,
            href: "/chat/conv-proj", createdAt: now.addingTimeInterval(-38 * 60)
        ),
        NativeNotification(
            id: "n3", type: "agent_ideas", title: "Otto has 2 ideas",
            body: "Unsubscribe from four newsletters you never open", priority: .low,
            href: "/agents/agent-otto",
            agent: .init(id: "agent-otto", name: "Otto", avatarShape: "pebble", avatarTone: "juniper", avatarEyes: "round"),
            readAt: now.addingTimeInterval(-3_000), createdAt: now.addingTimeInterval(-3 * 3_600)
        ),
        NativeNotification(
            id: "n4", type: "work_failed", title: "Task stopped",
            body: "Book the cabin: the booking site asked for a sign-in", priority: .normal,
            href: "/chat/conv-2",
            readAt: now.addingTimeInterval(-60_000), createdAt: now.addingTimeInterval(-20 * 3_600)
        ),
    ]

    static func popover(_ name: String) -> some View {
        let model: NativeNotificationsModel
        switch name {
        case "notifications-popover":
            model = inbox(count: .init(unreadCount: 2, urgent: true), items: rows, state: .ready, nextBefore: "cur_1")
        case "notifications-empty":
            model = inbox(count: .init(unreadCount: 0, urgent: false), items: [], state: .ready)
        case "notifications-error":
            model = inbox(count: nil, items: nil, state: .failed)
        default:
            model = inbox(count: nil, items: nil, state: .loading)
        }
        return DesktopNotificationsPopover(model: model, open: { _ in }, now: now, loadsOnAppear: false)
            .frame(width: DesktopNotificationsPopover.width, height: DesktopNotificationsPopover.height(for: model))
            // The popover's system material cannot be drawn offscreen; its
            // rows sit on the popover's own opaque tone instead.
            .background(Color.junoPopover, in: RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .padding(JunoSpace.section)
    }

    // MARK: An agent's thread

    static var threadHeaders: some View {
        let iris = agent(id: "agent-iris", name: "Iris", role: "Research lead", state: .waiting,
                         sentence: "Needs your call on the vendor shortlist", thread: irisThread)
        let otto = agent(id: "agent-otto", name: "Otto", role: "Inbox triage", state: .working,
                         sentence: "Sorting this morning’s mail",
                         avatar: JunoAgentAvatar(shape: .pebble, tone: .juniper, eyes: .round))
        return VStack(spacing: 0) {
            header(iris, state: nil)
            header(otto, state: nil)
            header(otto, state: .thinking)
        }
        .padding(.vertical, JunoSpace.regular)
    }

    private static func header(_ agent: NativeAgent, state: JunoAgentState?) -> some View {
        VStack(spacing: 0) {
            DesktopAgentThreadHeader(agent: agent, state: state, openAgent: {})
                .frame(maxWidth: DesktopChatMeasure.reading)
                .padding(.horizontal, JunoSpace.section)
                .padding(.vertical, JunoSpace.hairline)
            Rectangle().fill(Color.junoHairline).frame(height: 1)
        }
    }
}

/// Builds agents for fixtures and tests without the network.
enum SnapshotAgents {
    static func agent(
        id: String, name: String, role: String, state: JunoAgentState, sentence: String,
        status: NativeAgentStatus = .active, avatar: JunoAgentAvatar? = nil, thread: String? = nil
    ) -> NativeAgent {
        let date = Date(timeIntervalSince1970: 1_789_000_000)
        return NativeAgent(
            id: id, name: name, role: role,
            avatar: avatar ?? JunoAgentAvatar(shape: .orb, tone: .violet, eyes: .soft, mark: .spark),
            style: .warm, instructions: "", model: nil, reasoningEffort: nil,
            approvalMode: .balanced, connectorIDs: [], projectID: nil, conversationID: thread,
            status: status, proactive: false, template: nil, lastReflectedAt: nil, sortOrder: 0,
            createdAt: date, updatedAt: date, state: state, stateSentence: sentence, task: nil,
            needsYou: state == .waiting ? 1 : 0, nextRoutine: nil, newIdeas: 0
        )
    }
}

/// `/api/agents` for the Stage C pictures: Iris waiting on the reader (her
/// thread is the preview world's "Weekend trip planning"), Otto at work, Wren
/// idle — listed hired-first, so the fold's waiting-first order is visible.
private struct SignalsAgentsSender: NativeAuthenticatedRequestSending {
    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        let headers = try HTTPHeaders(["content-type": "application/json"])
        guard request.path == "/api/agents" else {
            return HTTPResponse(statusCode: 404, headers: headers, body: Data("{}".utf8))
        }
        return HTTPResponse(statusCode: 200, headers: headers, body: Data(Self.roster.utf8))
    }

    private static let roster = """
    {"agents": [
      {"id": "agent-wren", "name": "Wren", "role": "Weekly digest",
       "avatar": {"shape": "capsule", "tone": "amber", "eyes": "tall", "mark": "leaf"},
       "style": "warm", "createdAt": "2026-09-18T09:00:00Z", "updatedAt": "2026-09-23T18:00:00Z",
       "state": "idle", "stateSentence": "Next digest on Friday", "sortOrder": 0},
      {"id": "agent-otto", "name": "Otto", "role": "Inbox triage",
       "avatar": {"shape": "pebble", "tone": "juniper", "eyes": "round", "mark": "none"},
       "style": "warm", "createdAt": "2026-09-19T09:00:00Z", "updatedAt": "2026-09-24T08:30:00Z",
       "state": "working", "stateSentence": "Sorting this morning’s mail", "sortOrder": 1},
      {"id": "agent-iris", "name": "Iris", "role": "Research lead", "conversationId": "conv-2",
       "avatar": {"shape": "orb", "tone": "violet", "eyes": "soft", "mark": "spark"},
       "style": "warm", "createdAt": "2026-09-20T09:00:00Z", "updatedAt": "2026-09-24T08:00:00Z",
       "state": "waiting", "stateSentence": "Has a question about Book the cabin", "needsYou": 1, "sortOrder": 2}
    ]}
    """
}

/// A sender for fixtures that must never read: every request is refused.
private struct SignalsNoNetwork: NativeAuthenticatedRequestSending {
    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        HTTPResponse(statusCode: 503, headers: HTTPHeaders(), body: Data("{}".utf8))
    }
}
