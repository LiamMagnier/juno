import BackgroundTasks
import Foundation
import JunoCodeKit
import Observation
import UIKit
import UserNotifications

/// Local notifications for Juno Code: an approval arriving while the app is in
/// the background, and a session finishing.
///
/// Push would be better and needs a server the relay does not have yet, so
/// this is the honest version: the app registers a `BGAppRefreshTask` that
/// asks the relay for every host's sessions and raises a notification for
/// each session that is newly waiting on a yes. iOS schedules refresh on its
/// own terms — a few times an hour for an app the reader opens often — which
/// is enough for "your Mac is waiting" to reach a pocket.
///
/// Permission is asked for on first use of Code, not at launch: a notification
/// prompt before the reader has seen what would notify them is the prompt that
/// gets refused.
@MainActor
@Observable
final class JunoMobileCodeNotifications {
  static let shared = JunoMobileCodeNotifications()
  static let refreshTaskIdentifier = "com.liammagnier.JunoMobile.code-refresh"
  private static let approvalCategory = "juno.code.approval"

  private(set) var authorization: UNAuthorizationStatus?
  private var remoteModel: CodeRemoteBrowserModel?
  private var registered = false

  private init() {}

  func attach(_ model: CodeRemoteBrowserModel?) {
    remoteModel = model
  }

  /// Asks once. Safe to call every time Code opens: a decided status returns
  /// without prompting.
  func requestPermissionIfNeeded() async {
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    authorization = settings.authorizationStatus
    guard settings.authorizationStatus == .notDetermined else { return }
    _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    authorization = await center.notificationSettings().authorizationStatus
  }

  // MARK: - Background refresh

  /// Called once at launch. Registration has to happen before the app
  /// finishes launching, which is why it is not tied to Code opening.
  func registerBackgroundTask() {
    guard !registered else { return }
    registered = true
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: Self.refreshTaskIdentifier, using: nil
    ) { [weak self] task in
      guard let refresh = task as? BGAppRefreshTask else {
        task.setTaskCompleted(success: false)
        return
      }
      Task { @MainActor [weak self] in
        await self?.handleRefresh(refresh)
      }
    }
  }

  /// Asks for the next refresh. Called when the app goes to the background.
  func scheduleRefresh() {
    guard UserDefaults.standard.object(forKey: JunoMobilePreferences.codeApprovalNotifications) as? Bool ?? true
    else { return }
    let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskIdentifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: 5 * 60)
    try? BGTaskScheduler.shared.submit(request)
  }

  private func handleRefresh(_ task: BGAppRefreshTask) async {
    scheduleRefresh()
    let work = Task { @MainActor in
      await self.checkForApprovals()
    }
    task.expirationHandler = { work.cancel() }
    await work.value
    task.setTaskCompleted(success: !work.isCancelled)
  }

  /// One pass: reload every host's sessions and notify for each that became
  /// waiting since the last pass.
  func checkForApprovals() async {
    guard let remoteModel else { return }
    let before = remoteModel.knownAwaitingSessionIDs
    await remoteModel.refreshAllSessions()
    let fresh = remoteModel.newlyAwaitingSessions(before: before)
    for session in fresh {
      await notifyApproval(session)
    }
  }

  private func notifyApproval(_ session: CodeRemoteSessionSummary) async {
    let content = UNMutableNotificationContent()
    content.title = "Juno Code is waiting on you"
    content.body = session.title
    content.sound = .default
    content.categoryIdentifier = Self.approvalCategory
    content.userInfo = ["deviceID": session.deviceID, "sessionID": session.sessionID]
    content.threadIdentifier = session.deviceID
    let request = UNNotificationRequest(
      identifier: "approval-\(session.sessionID)",
      content: content,
      trigger: nil
    )
    try? await UNUserNotificationCenter.current().add(request)
  }

  /// A session this phone started has finished.
  func notifyCompletion(_ session: CodeRemoteSessionSummary) async {
    guard UserDefaults.standard.object(forKey: JunoMobilePreferences.codeCompletionNotifications) as? Bool ?? true
    else { return }
    let content = UNMutableNotificationContent()
    content.title = session.currentStatus == "failed" ? "Session failed" : "Session finished"
    content.body = session.title
    content.sound = .default
    content.userInfo = ["deviceID": session.deviceID, "sessionID": session.sessionID]
    try? await UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: "done-\(session.sessionID)", content: content, trigger: nil)
    )
  }
}
