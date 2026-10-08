import BackgroundTasks
import Foundation
import JunoChatKit
import JunoStorage
import JunoSync
import UIKit
import UserNotifications

/// "Your research is ready" on the phone (SPEC §9.8).
///
/// A research run is a background job: the chat hands it off and ends, and
/// the run goes on on the server whether or not the phone is looking. The
/// server pushes when one finishes (`announceFinish`), but a remote push only
/// reaches a build signed with the push entitlement and a deployment holding
/// the APNs key. This is the half that works without either, the way Code's
/// approvals do (``JunoMobileCodeNotifications``):
///
/// - in front, the account's live runs are read every 20 seconds while a run
///   the phone saw is working (``NativeConversationModel/checkResearchCompletions(defaults:)``),
///   and a finished one raises a notification unless its chat is the one on
///   screen — its report card is appearing there;
/// - behind, a `BGAppRefreshTask` makes the same read whenever iOS grants
///   one (a few times an hour for an app in use), so the notification reaches
///   a pocket;
/// - after a relaunch the runs seen working are remembered, so one that
///   finished meanwhile is still announced.
///
/// One notification per run, whose identifier is the push's collapse id: a
/// local and a remote notification for one run replace each other. A tap
/// opens the report.
@MainActor
final class JunoMobileResearchNotifications {
  static let shared = JunoMobileResearchNotifications()
  static let refreshTaskIdentifier = "com.liammagnier.JunoMobile.research-refresh"

  private weak var model: NativeConversationModel<SQLiteAccountRepository>?
  private var registered = false
  private var loop: Task<Void, Never>?
  private var wake = false

  private init() {}

  /// The signed-in account's conversation store, or nil at sign-out.
  func attach(_ model: NativeConversationModel<SQLiteAccountRepository>?) {
    self.model = model
    model?.onResearchHandoff = { [weak self] _ in self?.noteResearchStarted() }
    loop?.cancel()
    loop = nil
    guard model != nil else { return }
    loop = Task { [weak self] in
      // Give the store a moment to take the account before the launch read.
      try? await Task.sleep(for: .seconds(3))
      while !Task.isCancelled {
        guard let self else { return }
        let watching = UIApplication.shared.applicationState == .active ? await self.check() : (self.model?.researchRunsWatched ?? false)
        await self.sleep(seconds: watching ? 20 : 120)
      }
    }
  }

  /// A chat handed a turn off to a run: read closely from now, and ask for
  /// banners at the moment the reason is obvious.
  func noteResearchStarted() {
    wake = true
    Task { await NativePushRegistrar.shared.requestFullAuthorization() }
  }

  // MARK: - Background refresh

  /// Called once at launch, before the app finishes launching.
  func registerBackgroundTask() {
    guard !registered else { return }
    registered = true
    BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTaskIdentifier, using: nil) { [weak self] task in
      guard let refresh = task as? BGAppRefreshTask else {
        task.setTaskCompleted(success: false)
        return
      }
      Task { @MainActor [weak self] in
        await self?.handleRefresh(refresh)
      }
    }
  }

  /// Asks for the next refresh while a run this phone saw is working.
  /// Called when the app goes to the background.
  func scheduleRefresh() {
    guard model?.researchRunsWatched == true else { return }
    let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskIdentifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: 5 * 60)
    try? BGTaskScheduler.shared.submit(request)
  }

  private func handleRefresh(_ task: BGAppRefreshTask) async {
    let work = Task { @MainActor in
      _ = await self.check()
    }
    task.expirationHandler = { work.cancel() }
    await work.value
    scheduleRefresh()
    task.setTaskCompleted(success: !work.isCancelled)
  }

  // MARK: - One read

  /// True while some run this phone saw is still working.
  @discardableResult
  func check() async -> Bool {
    guard let model else { return false }
    let finished = await model.checkResearchCompletions()
    let active = UIApplication.shared.applicationState == .active
    for completion in finished {
      if active, let conversationID = completion.conversationID, model.selectedConversationID == conversationID {
        continue
      }
      await Self.post(completion)
    }
    return model.researchRunsWatched
  }

  private func sleep(seconds: Int) async {
    for _ in 0..<seconds {
      if wake || Task.isCancelled { break }
      try? await Task.sleep(for: .seconds(1))
    }
    wake = false
  }

  private static func post(_ completion: NativeResearchCompletion) async {
    let center = UNUserNotificationCenter.current()
    let status = await center.notificationSettings().authorizationStatus
    guard status == .authorized || status == .provisional || status == .ephemeral else { return }
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
