import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoWorkKit
import Observation
import UserNotifications

/// What the Mac says when a task stops for the reader (Phase 5 brief C2):
/// a toast in front, a banner behind, the Dock badge and the menu-bar extra.
///
/// **One reader of the account's runs, whatever is on screen.** It watches
/// the task list the sidebar joins (``WorkRunsByConversation``), so a task
/// that stops while the reader is on a page, in Code, or has closed every
/// window is still said — the menu-bar extra and the Dock outlive the window.
///
/// **Only a rise speaks** (`describeNeedsYouRise`): a count that falls is the
/// reader answering something, and the first reading after launch or sign-in
/// has nothing to have risen from — announcing it would greet every launch
/// with tasks that have been waiting since yesterday.
///
/// **Two voices, never both.** With Juno in front the key window's toast host
/// says it ("Open the task to answer it."); behind, and only with the
/// person's "When something needs you" switch on and the system's permission
/// given, one replaceable local notification says it ("Open Juno to answer
/// it."), whose click is main's route to the chat. A rise made only of agents'
/// threads is left to main's agent banner, which already names the agent.
@MainActor
@Observable
final class DesktopNeedsYouSignals {
    static let shared = DesktopNeedsYouSignals()

    /// One chat that needs the reader, as the menu-bar extra lists it.
    struct MenuItem: Identifiable, Equatable {
        let conversationID: String
        /// The chat's title, or the task's when the chat is not in the store.
        let title: String
        /// The run's status label ("Needs approval").
        let status: String
        var id: String { conversationID }
    }

    /// What a rise says, and where a click on it goes.
    struct Rise: Equatable {
        let sentence: String
        /// The newest chat that rose: where the banner opens.
        let conversationID: String?
        /// Every chat that rose is an agent's thread.
        let onlyAgentThreads: Bool
    }

    /// The account's runs, joined per chat. Empty until the first read.
    private(set) var runs = WorkRunsByConversation.empty
    /// The chats waiting on the reader, as the fold, the badge and the menu
    /// count them. Nil until the first read lands.
    private(set) var needsYouIDs: Set<String>?
    /// The fold's chats in the menu's order: most recent activity first.
    private(set) var menuItems: [MenuItem] = []

    /// How many chats need the reader: the Dock badge and the menu's count.
    var count: Int { needsYouIDs?.count ?? 0 }

    /// The notification center a rise's banner goes to. Replaced in tests.
    @ObservationIgnored var postBanner: (@MainActor (Rise) -> Void)?
    /// Whether Juno is the app in front. Replaced in tests.
    @ObservationIgnored var isAppActive: @MainActor () -> Bool = { NSApp?.isActive == true }
    /// Writes the Dock badge. Replaced in tests.
    @ObservationIgnored var setBadge: @MainActor (String?) -> Void = { NSApp?.dockTile.badgeLabel = $0 }

    @ObservationIgnored private weak var workModel: NativeWorkModel?
    @ObservationIgnored private weak var agentsModel: NativeAgentsModel?
    @ObservationIgnored private weak var hostModel: DesktopWorkHostModel?
    @ObservationIgnored private var conversations: (@MainActor () -> [NativeConversation])?
    /// The key main window's toast host, held weakly: the window owns it.
    @ObservationIgnored private weak var toasts: JunoToastCenter?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var hasAskedPermission = false

    init() {}

    // MARK: - Lifecycle

    /// Starts watching at sign-in. The first reading that follows is taken
    /// as the baseline and says nothing.
    func start(
        workModel: NativeWorkModel?,
        agentsModel: NativeAgentsModel?,
        hostModel: DesktopWorkHostModel?,
        conversations: (@MainActor () -> [NativeConversation])?
    ) {
        stop()
        self.workModel = workModel
        self.agentsModel = agentsModel
        self.hostModel = hostModel
        self.conversations = conversations
        if postBanner == nil { postBanner = Self.postLocalNotification }
        observe(generation)
    }

    /// Sign-out: forgets the account and clears the Dock.
    func stop() {
        generation += 1
        workModel = nil
        agentsModel = nil
        hostModel = nil
        conversations = nil
        runs = .empty
        needsYouIDs = nil
        menuItems = []
        setBadge(nil)
    }

    /// The window that just became key hands over its toast host.
    func adoptToastHost(_ center: JunoToastCenter) {
        toasts = center
    }

    /// Posts to the key window's toast host, for account-level models (the
    /// inbox) that have no window of their own.
    func toast(_ toast: JunoToast) {
        toasts?.post(toast)
    }

    /// A task started in this Mac's chat: the moment the notification
    /// question has an obvious answer (spec §7.11). The system asks once,
    /// whichever comes first — this or main's first agent. The list is read
    /// again too, the web's `juno:work-sync`.
    func noteTaskStarted() {
        if !hasAskedPermission {
            hasAskedPermission = true
            Task { await NativePushRegistrar.shared.requestFullAuthorization() }
        }
        if let workModel {
            Task { await workModel.refresh() }
        }
    }

    // MARK: - Watching

    private func observe(_ watching: Int) {
        guard watching == generation else { return }
        withObservationTracking {
            recompute()
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.observe(watching) }
        }
    }

    /// Reads the inputs (which is what the tracking above watches) and says
    /// whatever rose.
    private func recompute() {
        guard let workModel else { return }
        let loaded = workModel.phase == .ready
        let pendingRuns = Set(
            (hostModel?.localApprovals ?? []).filter(\.isPending).map(\.runID)
        )
        let joined = WorkRunsByConversation(
            sessions: workModel.sessions,
            status: { workModel.displayStatus(of: $0) },
            pendingLocalRunIDs: pendingRuns
        )
        let chats = conversations?() ?? []
        let agentThreads = Set((agentsModel?.agents ?? []).compactMap(\.conversationID))
        // A read that reached nothing keeps the last good answer: a dropped
        // request is not evidence that nothing is waiting.
        guard loaded else { return }
        runs = joined
        let next = Self.needsYou(in: joined, chats: chats)
        menuItems = Self.menuItems(next, runs: joined, chats: chats)
        let previous = needsYouIDs
        needsYouIDs = next
        setBadge(Self.badgeLabel(next.count))
        if let rise = Self.rise(from: previous, to: next, runs: joined, agentThreads: agentThreads) {
            announce(rise)
        }
    }

    private func announce(_ rise: Rise) {
        if isAppActive() {
            toasts?.post(
                JunoToast(
                    id: "juno-work-needs-you",
                    tone: .warning,
                    title: rise.sentence,
                    detail: "Open the task to answer it."
                )
            )
            // VoiceOver hears the fold's own sentence from the sidebar.
            return
        }
        guard !rise.onlyAgentThreads, NativePushRegistrar.shared.preferences.needsYou else { return }
        postBanner?(rise)
    }

    // MARK: - Rules (pure, for tests)

    /// The chats that count: every chat whose newest run needs the reader,
    /// less those the store knows are archived or not chats (Code's). A chat
    /// the store has not synced yet still counts — the run is real.
    nonisolated static func needsYou(
        in runs: WorkRunsByConversation,
        chats: [NativeConversation]
    ) -> Set<String> {
        let known = Dictionary(chats.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return runs.needsYou.filter { id in
            guard let chat = known[id] else { return true }
            return chat.kind == "chat" && !chat.isArchived
        }
    }

    /// `describeNeedsYouRise`, with the Mac's two additions: which chat the
    /// banner opens (the newest that rose) and whether every chat that rose is
    /// an agent's thread.
    nonisolated static func rise(
        from previous: Set<String>?,
        to next: Set<String>,
        runs: WorkRunsByConversation,
        agentThreads: Set<String>
    ) -> Rise? {
        guard let previous, next.count > previous.count else { return nil }
        let added = next.count - previous.count
        let what = added == 1 ? "A task needs you" : "\(added) tasks need you"
        let sentence = next.count == added ? what : "\(what) — \(next.count) in total"
        let rose = next.subtracting(previous)
        let newest = rose.max { lhs, rhs in
            (runs.signals[lhs]?.session.lastActivityAt ?? .distantPast)
                < (runs.signals[rhs]?.session.lastActivityAt ?? .distantPast)
        }
        return Rise(
            sentence: sentence,
            conversationID: newest,
            onlyAgentThreads: !rose.isEmpty && rose.isSubset(of: agentThreads)
        )
    }

    /// The Dock's badge: the count, and nothing at zero.
    nonisolated static func badgeLabel(_ count: Int) -> String? {
        count > 0 ? String(count) : nil
    }

    nonisolated static func menuItems(
        _ ids: Set<String>,
        runs: WorkRunsByConversation,
        chats: [NativeConversation]
    ) -> [MenuItem] {
        let titles = Dictionary(chats.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
        return ids.compactMap { id -> (MenuItem, Date)? in
            guard let signal = runs.signals[id] else { return nil }
            let title = titles[id].flatMap { $0.isEmpty ? nil : $0 } ?? signal.session.title
            return (
                MenuItem(conversationID: id, title: title, status: ChatWorkVocabulary.label(signal.status)),
                signal.session.lastActivityAt
            )
        }
        .sorted { $0.1 > $1.1 }
        .map(\.0)
    }

    // MARK: - The banner

    /// One replaceable notification: the web's tag, as a request id, so a
    /// second rise replaces the first rather than stacking.
    private static func postLocalNotification(_ rise: Rise) {
        let sentence = rise.sentence
        let conversationID = rise.conversationID
        Task {
            let center = UNUserNotificationCenter.current()
            let status = await center.notificationSettings().authorizationStatus
            guard status == .authorized || status == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = sentence
            content.body = "Open Juno to answer it."
            content.sound = .default
            content.threadIdentifier = "juno-needs-you"
            if let conversationID {
                // The keys a push carries, so a click takes main's road.
                content.userInfo = [
                    "path": JunoNotificationRoute.conversation(id: conversationID).path,
                    "conversationId": conversationID,
                ]
            }
            let request = UNNotificationRequest(identifier: "juno-work-needs-you", content: content, trigger: nil)
            try? await center.add(request)
        }
    }
}
