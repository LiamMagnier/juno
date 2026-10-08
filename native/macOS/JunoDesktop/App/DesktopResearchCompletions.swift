import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import UserNotifications

/// "Your research is ready" on the Mac (SPEC §9.8): a research run is a
/// background job now — a chat hands it off and ends — so the Mac has to
/// notice when one finishes, whatever is on screen and even if it was quit
/// while the run worked.
///
/// The server sends the remote push itself when a run finishes
/// (`announceFinish`), but a push only reaches a build signed with the push
/// entitlement and a deployment holding the APNs key. This is the half that
/// works everywhere: while Juno runs it reads the account's live runs
/// (``NativeConversationModel/checkResearchCompletions(defaults:)``) — every
/// 20 seconds while a run it saw is working and Juno is in front, every
/// minute behind, every five minutes when nothing is — and says what
/// finished. In front, a toast with Open (nothing at all when that chat is
/// the one on screen: its report card is appearing); behind, one local
/// notification per run, whose identifier is the push's collapse id so the
/// two never stack, and whose click opens the report.
@MainActor
final class DesktopResearchCompletions {
    static let shared = DesktopResearchCompletions()

    private var loop: Task<Void, Never>?
    private weak var model: NativeConversationModel<SQLiteAccountRepository>?
    private var wake = false

    private init() {}

    /// Starts once the conversation store has the account (sign-in or
    /// launch). The first pass is the launch read: a run this Mac saw working
    /// before it was quit, and that finished meanwhile, is said now.
    func start(model: NativeConversationModel<SQLiteAccountRepository>?) {
        stop()
        guard let model else { return }
        self.model = model
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let watching = await self.pass()
                await self.sleep(seconds: watching ? (NSApp?.isActive == true ? 20 : 60) : 300)
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        model = nil
    }

    /// A chat handed a run off: watch closely from now, and ask for
    /// notification permission at the moment the reason is obvious.
    func noteResearchStarted() {
        wake = true
        Task { await NativePushRegistrar.shared.requestFullAuthorization() }
    }

    /// One read. True while some run this Mac saw is still working.
    private func pass() async -> Bool {
        guard let model else { return false }
        let finished = await model.checkResearchCompletions()
        for completion in finished { announce(completion) }
        return model.researchRunsWatched
    }

    private func sleep(seconds: Int) async {
        for _ in 0..<seconds {
            if wake || Task.isCancelled { break }
            try? await Task.sleep(for: .seconds(1))
        }
        wake = false
    }

    private func announce(_ completion: NativeResearchCompletion) {
        let active = NSApp?.isActive == true
        if active {
            // The transcript is already drawing the report card.
            if let conversationID = completion.conversationID, model?.selectedConversationID == conversationID { return }
            let route = JunoNotificationRoute.research(id: completion.runID)
            let toast: JunoToast = completion.kind == .ready
                ? .success(completion.headline, detail: completion.title, action: .init("Open") { JunoDesktopWindow.follow(route) })
                : .error(completion.headline, detail: completion.title, action: .init("Open") { JunoDesktopWindow.follow(route) })
            DesktopNeedsYouSignals.shared.toast(toast)
            return
        }
        Task { await Self.postLocalNotification(completion) }
    }

    private static func postLocalNotification(_ completion: NativeResearchCompletion) async {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        guard status == .authorized || status == .provisional else { return }
        let content = UNMutableNotificationContent()
        content.title = completion.headline
        content.body = completion.title
        content.sound = .default
        content.threadIdentifier = completion.threadIdentifier
        content.userInfo = completion.userInfo
        try? await center.add(
            UNNotificationRequest(identifier: completion.notificationIdentifier, content: content, trigger: nil)
        )
    }
}
