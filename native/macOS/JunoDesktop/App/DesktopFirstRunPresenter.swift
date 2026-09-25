import AppKit
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// Decides when the Chat window shows onboarding and announcements (brief §C6),
/// and holds the sheet that is up.
///
/// - **Onboarding** once per account on this Mac, only when the account has no
///   conversations after the first sync, and only while Chat is showing.
/// - **An announcement** after onboarding, never at the same time, while Chat
///   is showing, unless this Mac already dismissed it.
@MainActor
@Observable
final class DesktopFirstRunPresenter {
    enum Sheet: Identifiable, Equatable {
        case onboarding
        case announcement(NativeAnnouncement)

        var id: String {
            switch self {
            case .onboarding: "onboarding"
            case .announcement(let item): "announcement-\(item.id)"
            }
        }
    }

    var sheet: Sheet?
    /// The announcement fetched for this account, waiting for its turn.
    @ObservationIgnored private(set) var pending: NativeAnnouncement?
    @ObservationIgnored private var fetchedFor: AccountID?

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    static let dismissedKey = "juno.dismissedAnnouncements"

    static func onboardedKey(_ accountID: AccountID) -> String {
        "juno.onboarded.v1.\(accountID.rawValue)"
    }

    // MARK: Rules (pure)

    /// Whether onboarding should open now.
    static func shouldOnboard(
        alreadyOnboarded: Bool,
        hasSynced: Bool,
        conversationCount: Int,
        chatShowing: Bool
    ) -> Bool {
        !alreadyOnboarded && hasSynced && conversationCount == 0 && chatShowing
    }

    /// Whether an announcement should open now.
    static func shouldAnnounce(
        _ announcement: NativeAnnouncement?,
        dismissed: Set<String>,
        onboardingPending: Bool,
        sheetShowing: Bool,
        chatShowing: Bool
    ) -> Bool {
        guard let announcement else { return false }
        return !dismissed.contains(announcement.id) && !onboardingPending && !sheetShowing && chatShowing
    }

    // MARK: State

    func isOnboarded(_ accountID: AccountID) -> Bool {
        defaults.bool(forKey: Self.onboardedKey(accountID))
    }

    func markOnboarded(_ accountID: AccountID) {
        defaults.set(true, forKey: Self.onboardedKey(accountID))
    }

    var dismissedAnnouncements: Set<String> {
        Set(defaults.stringArray(forKey: Self.dismissedKey) ?? [])
    }

    func markDismissed(_ id: String) {
        var list = defaults.stringArray(forKey: Self.dismissedKey) ?? []
        guard !list.contains(id) else { return }
        list.append(id)
        defaults.set(Array(list.suffix(200)), forKey: Self.dismissedKey)
    }

    /// Re-reads the rules and opens whichever sheet is due.
    func evaluate(accountID: AccountID, hasSynced: Bool, conversationCount: Int, chatShowing: Bool) {
        guard sheet == nil else { return }
        if !isOnboarded(accountID), hasSynced, conversationCount > 0 {
            // The web's rule: an account that already has chats needs no tour.
            markOnboarded(accountID)
        }
        if Self.shouldOnboard(
            alreadyOnboarded: isOnboarded(accountID),
            hasSynced: hasSynced,
            conversationCount: conversationCount,
            chatShowing: chatShowing
        ) {
            sheet = .onboarding
            return
        }
        if Self.shouldAnnounce(
            pending,
            dismissed: dismissedAnnouncements,
            onboardingPending: !isOnboarded(accountID) && !hasSynced,
            sheetShowing: sheet != nil,
            chatShowing: chatShowing
        ), let pending {
            sheet = .announcement(pending)
        }
    }

    /// Reads the current announcement once per account and sign-in.
    func fetchAnnouncement(accountID: AccountID, client: NativeAnnouncementsClient) async {
        guard fetchedFor != accountID else { return }
        fetchedFor = accountID
        pending = try? await client.current(for: accountID)
    }

    /// Closing onboarding by any route.
    func finishOnboarding(accountID: AccountID) {
        markOnboarded(accountID)
        sheet = nil
    }

    /// Closing an announcement by any route dismisses it, here and on the server.
    func dismissAnnouncement(_ announcement: NativeAnnouncement, accountID: AccountID, client: NativeAnnouncementsClient?) {
        markDismissed(announcement.id)
        pending = nil
        if case .announcement = sheet { sheet = nil }
        guard let client else { return }
        Task { try? await client.dismiss(id: announcement.id, for: accountID) }
    }
}

/// Where an announcement's link goes: a screen in this app, the browser, or
/// nowhere.
enum DesktopAnnouncementLink: Equatable {
    case route(JunoNotificationRoute)
    case browser(URL)

    /// An internal href (`/chat/…`, `/agents/…`, `/work/…`) opens in the app
    /// where it maps; any other internal path opens the web; an absolute
    /// `https` link opens the browser.
    static func resolve(_ href: String?, base: String = JunoBackend.productionURLString) -> DesktopAnnouncementLink? {
        guard let href = href?.trimmingCharacters(in: .whitespacesAndNewlines), !href.isEmpty else { return nil }
        if href.hasPrefix("/"), !href.hasPrefix("//") {
            if let route = JunoNotificationRoute(path: href) { return .route(route) }
            return URL(string: base + href).map(DesktopAnnouncementLink.browser)
        }
        guard let url = URL(string: href), url.scheme == "https" else { return nil }
        return .browser(url)
    }
}

// MARK: - Attaching

extension View {
    /// The Chat window's first-run sheets — onboarding and announcements —
    /// and the Upgrade sheet. One line at the window's root.
    func desktopFirstRunSheets(_ configuration: JunoDesktopConfiguration) -> some View {
        modifier(DesktopFirstRunSheets(configuration: configuration))
    }
}

private struct DesktopFirstRunSheets: ViewModifier {
    let configuration: JunoDesktopConfiguration

    @State private var presenter = DesktopFirstRunPresenter()
    @SceneStorage("juno.desktop.product") private var storedProduct = DesktopProductMode.chat.rawValue

    private var session: NativeAuthenticatedSession? {
        if case .signedIn(let session) = configuration.authModel.phase { return session }
        return nil
    }

    private var chatShowing: Bool {
        (DesktopProductMode(rawValue: storedProduct) ?? .chat) == .chat
    }

    private var announcements: NativeAnnouncementsClient? {
        configuration.requestSender.map(NativeAnnouncementsClient.init(sender:))
    }

    private var hasSynced: Bool {
        (configuration.syncModel?.synchronizationGeneration ?? 0) > 0
            && configuration.conversationModel?.phase == .ready
    }

    private var conversationCount: Int {
        configuration.conversationModel?.conversations.count ?? 0
    }

    func body(content: Content) -> some View {
        content
            .desktopUpgradeSheet(host: .chat, sender: configuration.requestSender, accountID: session?.profile.id)
            .sheet(item: $presenter.sheet) { sheet in
                if let session {
                    switch sheet {
                    case .onboarding:
                        DesktopOnboardingSheet(
                            settingsModel: configuration.memorySettingsModel,
                            initialName: configuration.memorySettingsModel?.settings?.name ?? session.profile.name ?? "",
                            finish: { presenter.sheet = nil }
                        )
                    case .announcement(let item):
                        DesktopAnnouncementSheet(announcement: item, close: { presenter.sheet = nil })
                    }
                }
            }
            .task(id: session?.profile.id) {
                guard !JunoTestHost.isActive, let session, let announcements else { return }
                await presenter.fetchAnnouncement(accountID: session.profile.id, client: announcements)
                evaluate()
            }
            .onChange(of: hasSynced) { _, _ in evaluate() }
            .onChange(of: conversationCount) { _, _ in evaluate() }
            .onChange(of: storedProduct) { _, _ in evaluate() }
            .onChange(of: presenter.sheet) { previous, sheet in
                guard sheet == nil, let session else { return }
                // Closing by any route — the buttons, Escape — counts.
                switch previous {
                case .onboarding?:
                    presenter.finishOnboarding(accountID: session.profile.id)
                case .announcement(let item)?:
                    presenter.dismissAnnouncement(item, accountID: session.profile.id, client: announcements)
                case nil:
                    break
                }
                // An announcement waits for onboarding to close, then opens.
                evaluate()
            }
    }

    private func evaluate() {
        guard !JunoTestHost.isActive, let session else { return }
        presenter.evaluate(
            accountID: session.profile.id,
            hasSynced: hasSynced,
            conversationCount: conversationCount,
            chatShowing: chatShowing
        )
    }
}
