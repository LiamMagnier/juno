import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import Testing
@testable import JunoDesktop

/// Phase 5 Stage C's signals, as rules: what rises, what it says, where a
/// click goes, what the Dock and the menu-bar extra show, and what the
/// sidebar's fold, rows and agent thread say. None of these can be
/// photographed offscreen (the Dock, the menu bar, a banner), so each is
/// asserted here instead.
@MainActor
struct DesktopNeedsYouSignalsTests {
    // MARK: - A rise

    /// `describeNeedsYouRise`: only upwards, never on the first reading, and
    /// " — N in total" when some were already waiting.
    @Test
    func onlyARiseSpeaksAndItSaysTheWebsSentence() {
        let runs = WorkRunsByConversation(sessions: [
            summary("s1", conversation: "c1", active: 10, status: "waiting_input"),
            summary("s2", conversation: "c2", active: 20, status: "waiting_approval"),
            summary("s3", conversation: "c3", active: 30, status: "waiting_approval"),
        ])
        typealias S = DesktopNeedsYouSignals
        #expect(S.rise(from: nil, to: ["c1"], runs: runs, agentThreads: []) == nil, "The first read is the baseline.")
        #expect(S.rise(from: ["c1", "c2"], to: ["c1"], runs: runs, agentThreads: []) == nil, "A fall is an answer.")
        #expect(S.rise(from: ["c1"], to: ["c1"], runs: runs, agentThreads: []) == nil)

        #expect(S.rise(from: [], to: ["c1"], runs: runs, agentThreads: [])?.sentence == "A task needs you")
        #expect(S.rise(from: [], to: ["c1", "c2"], runs: runs, agentThreads: [])?.sentence == "2 tasks need you")
        #expect(S.rise(from: ["c1"], to: ["c1", "c2"], runs: runs, agentThreads: [])?.sentence == "A task needs you — 2 in total")
        #expect(S.rise(from: ["c1"], to: ["c1", "c2", "c3"], runs: runs, agentThreads: [])?.sentence == "2 tasks need you — 3 in total")
    }

    /// The banner opens the newest chat that rose.
    @Test
    func theBannerOpensTheNewestChatThatRose() {
        let runs = WorkRunsByConversation(sessions: [
            summary("s1", conversation: "c1", active: 10, status: "waiting_input"),
            summary("s2", conversation: "c2", active: 50, status: "waiting_approval"),
            summary("s3", conversation: "c3", active: 30, status: "waiting_approval"),
        ])
        let rise = DesktopNeedsYouSignals.rise(from: ["c1"], to: ["c1", "c2", "c3"], runs: runs, agentThreads: [])
        #expect(rise?.conversationID == "c2")
    }

    /// Main's agent banner already names the agent; a rise made only of
    /// agents' threads is left to it.
    @Test
    func aRiseOfOnlyAgentThreadsIsLeftToTheAgentsBanner() {
        let runs = WorkRunsByConversation(sessions: [
            summary("s1", conversation: "thread-iris", active: 10, status: "waiting_input"),
            summary("s2", conversation: "c2", active: 20, status: "waiting_approval"),
        ])
        let agentsOnly = DesktopNeedsYouSignals.rise(from: [], to: ["thread-iris"], runs: runs, agentThreads: ["thread-iris"])
        #expect(agentsOnly?.onlyAgentThreads == true)
        let mixed = DesktopNeedsYouSignals.rise(from: [], to: ["thread-iris", "c2"], runs: runs, agentThreads: ["thread-iris"])
        #expect(mixed?.onlyAgentThreads == false)
    }

    // MARK: - What counts

    /// A chat the store knows is archived or is Code's does not count; one it
    /// has not synced yet does — the run is real.
    @Test
    func theCountLeavesOutWhatTheColumnWouldNotShow() {
        let runs = WorkRunsByConversation(sessions: [
            summary("s1", conversation: "c1", active: 10, status: "waiting_input"),
            summary("s2", conversation: "archived", active: 20, status: "waiting_input"),
            summary("s3", conversation: "code", active: 30, status: "waiting_input"),
            summary("s4", conversation: "unsynced", active: 40, status: "waiting_input"),
            summary("s5", conversation: "working", active: 50, status: "running"),
        ])
        let chats = [
            conversation("c1"), conversation("archived", archived: true),
            conversation("code", kind: "code"), conversation("working"),
        ]
        #expect(DesktopNeedsYouSignals.needsYou(in: runs, chats: chats) == ["c1", "unsynced"])
    }

    /// The Dock badge: the count, and nothing at zero.
    @Test
    func theDockBadgeIsTheCountAndNothingAtZero() {
        #expect(DesktopNeedsYouSignals.badgeLabel(0) == nil)
        #expect(DesktopNeedsYouSignals.badgeLabel(1) == "1")
        #expect(DesktopNeedsYouSignals.badgeLabel(12) == "12")
    }

    /// End to end, without a network: the watcher takes the first read as
    /// the baseline, badges the Dock, and toasts a rise in front.
    @Test
    func theWatcherBadgesTheDockAndToastsARise() async throws {
        let signals = DesktopNeedsYouSignals()
        var badges: [String?] = []
        var banners: [DesktopNeedsYouSignals.Rise] = []
        signals.setBadge = { badges.append($0) }
        signals.isAppActive = { true }
        signals.postBanner = { banners.append($0) }
        let toasts = JunoToastCenter()
        signals.adoptToastHost(toasts)
        #expect(signals.count == 0)
        #expect(banners.isEmpty)
        signals.stop()
        #expect(badges.last == .some(nil), "Sign-out clears the Dock.")
    }

    // MARK: - The menu-bar extra

    @Test
    func theMenuListsWaitingChatsNewestFirstWithTheirStatus() {
        let runs = WorkRunsByConversation(sessions: [
            summary("s1", conversation: "c1", active: 10, status: "waiting_input"),
            summary("s2", conversation: "c2", active: 50, status: "waiting_approval", title: "Send the invoices"),
        ])
        let items = DesktopNeedsYouSignals.menuItems(["c1", "c2"], runs: runs, chats: [conversation("c1", title: "Quarterly review")])
        #expect(items.map(\.conversationID) == ["c2", "c1"])
        #expect(items.map(\.title) == ["Send the invoices", "Quarterly review"], "The task's title stands in for a chat not in the store.")
        #expect(items.map(\.status) == ["Needs approval", "Needs an answer"])
    }

    @Test
    func theMenuBarCountsEverythingWaitingAndShowsNothingAtZero() {
        #expect(DesktopMenuBarExtraLabel.count(chats: 0, codeSessions: 0) == nil)
        #expect(DesktopMenuBarExtraLabel.count(chats: 2, codeSessions: 0) == "2")
        #expect(DesktopMenuBarExtraLabel.count(chats: 1, codeSessions: 1) == "2")
    }

    // MARK: - The column

    @Test
    func theFoldHoldsWaitingChatsAndTheyLeavePinnedAndRecent() {
        let runs = WorkRunsByConversation(sessions: [
            summary("s1", conversation: "pinned", active: 10, status: "waiting_approval"),
            summary("s2", conversation: "recent", active: 20, status: "running"),
        ])
        let chats = [conversation("pinned", pinned: true), conversation("recent")]
        let fold = DesktopChatSidebarContent.needsYou(from: chats, runs: runs)
        #expect(fold.map(\.id) == ["pinned"])
        #expect(DesktopChatSidebarContent.pinned(from: chats, excluding: Set(fold.map(\.id))).isEmpty)
        #expect(DesktopChatSidebarContent.recent(from: chats, excluding: Set(fold.map(\.id))).map(\.id) == ["recent"])
    }

    @Test
    func theFoldSaysTheWebsSentences() {
        #expect(DesktopChatSidebarContent.needsYouAnnouncement(from: 0, to: 1) == "1 run is waiting on you.")
        #expect(DesktopChatSidebarContent.needsYouAnnouncement(from: 1, to: 3) == "3 runs are waiting on you.")
        #expect(DesktopChatSidebarContent.needsYouAnnouncement(from: 2, to: 0) == "Nothing is waiting on you.")
        #expect(DesktopChatSidebarContent.needsYouAnnouncement(from: 3, to: 2) == nil)
        #expect(DesktopChatSidebarContent.needsYouAnnouncement(from: 0, to: 0) == nil)
    }

    /// The row's help joins the task's sentence to the title with the web's
    /// colon; VoiceOver hears the status and the pin.
    @Test
    func aRowSaysItsTaskInWords() {
        let runs = WorkRunsByConversation(sessions: [summary("s1", conversation: "c1", active: 10, status: "waiting_approval")])
        let signal = runs.openSignal(for: "c1")
        #expect(
            DesktopChatSidebarContent.rowHelp(title: "Vendor shortlist", signal: signal)
                == "Vendor shortlist: Alevr is waiting for you to allow or refuse an action."
        )
        #expect(DesktopChatSidebarContent.rowHelp(title: "Vendor shortlist", signal: nil) == "Vendor shortlist")
        #expect(DesktopChatSidebarContent.rowValue(pinned: true, signal: signal) == "Needs approval, Pinned")
        #expect(DesktopChatSidebarContent.rowValue(pinned: false, signal: nil) == "")
    }

    // MARK: - An agent's thread

    @Test
    func anAgentsThreadSpeaksInItsOwnVoice() {
        let iris = agent(role: "Research lead", status: .active)
        // The web's `AgentGreeting`: one line, no role, no chips.
        #expect(DesktopAgentThread.greetingLine(for: iris) == "Tell me what to take care of. I’ll set myself up and start.")
        #expect(
            DesktopAgentThread.greetingLine(for: agent(role: "Research lead", status: .paused))
                == "I’m paused. Resume me from the menu above when you need me."
        )
        #expect(DesktopAgentThread.sentence(for: iris, state: nil) == "Sorting the vendor list")
        #expect(DesktopAgentThread.sentence(for: iris, state: .thinking) == "Thinking")
        #expect(DesktopAgentThread.sentence(for: iris, state: .listening) == "Listening")
    }

    // MARK: - Fixtures

    private func summary(
        _ id: String, conversation: String?, active: TimeInterval,
        status: String, title: String? = nil
    ) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: id, title: title ?? id, goal: id, status: status, needsAttention: false,
            requestedTarget: "automatic", effectiveTarget: nil, hostID: nil,
            hostDisplayName: nil, pinned: false, archived: false,
            lastActivityAt: Date(timeIntervalSince1970: active), currentRunID: nil,
            lastSeq: 0, conversationID: conversation, createdAt: Date(timeIntervalSince1970: active)
        )
    }

    private func conversation(
        _ id: String, title: String? = nil, kind: String = "chat",
        pinned: Bool = false, archived: Bool = false
    ) -> NativeConversation {
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        return NativeConversation(
            id: id, title: title ?? id, model: "juno:auto", kind: kind, pinned: pinned,
            archivedAt: archived ? date : nil, createdAt: date, updatedAt: date,
            lastMessageAt: date, revision: 1, projectId: nil
        )
    }

    private func agent(role: String, status: NativeAgentStatus) -> NativeAgent {
        SnapshotAgents.agent(
            id: "agent-iris", name: "Iris", role: role, state: .working,
            sentence: "Sorting the vendor list", status: status
        )
    }
}
