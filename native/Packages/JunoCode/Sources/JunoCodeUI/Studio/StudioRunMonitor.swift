import AppKit
import Foundation
import JunoCodeCore
import UserNotifications

/// Watches every session's status and does the two things a reader who has
/// looked away needs: tells them when a run finished or is waiting on them,
/// and keeps the Mac awake while anything is working.
///
/// Fed by the workbench (`WorkbenchModel.sessionsObserver`), not by a window.
/// It used to be fed by the Code window's `onChange`, so switching to Chat or
/// closing the window — while the app lived on in the menu bar — stopped it
/// hearing anything: the run finished unannounced, exactly when the reader
/// had looked away, and the keep-awake assertion it had taken was never
/// released, so the Mac could not idle-sleep until Code was opened again.
@MainActor
public final class StudioRunMonitor: NSObject, UNUserNotificationCenterDelegate {
    public static let shared = StudioRunMonitor()

    /// What a click on one of Juno's notifications does, set by the host at
    /// launch. A handler rather than a broadcast: every open Code window used
    /// to hear the broadcast and navigate, and a window showing Chat heard
    /// nothing at all.
    private var openSession: (@MainActor (CodeSessionID) -> Void)?

    private var previous: [CodeSessionID: StudioStatus] = [:]
    private var titles: [CodeSessionID: String] = [:]
    private var activity: NSObjectProtocol?
    private var didRequestAuthorization = false
    private var hasBaseline = false

    private var preferences: StudioPreferences { .shared }

    override private init() {
        super.init()
    }

    /// Call once at launch, so clicks on Juno's notifications reach the app
    /// and open the session they are about.
    public func install(openSession: @escaping @MainActor (CodeSessionID) -> Void) {
        self.openSession = openSession
        UNUserNotificationCenter.current().delegate = self
    }

    public func observe(_ sessions: [CodeSession]) {
        var next: [CodeSessionID: StudioStatus] = [:]
        for session in sessions {
            let status = StudioStatus(session.status, hasPendingApproval: session.hasPendingApproval)
            next[session.id] = status
            titles[session.id] = session.title
            // The first pass only records where things stand: relaunching the
            // app must not announce every run that finished while it was closed.
            guard hasBaseline, let before = previous[session.id], before != status else { continue }
            if status == .needsYou, preferences.notifyWhenNeedsYou {
                notify(session, title: "Juno needs your approval", body: session.title)
            } else if before == .working, status == .idle, session.status == .completed, preferences.notifyWhenDone {
                notify(session, title: "Finished", body: session.title)
            } else if before == .working, status == .failed, preferences.notifyWhenDone {
                notify(session, title: "Stopped with an error", body: session.title)
            }
        }
        previous = next
        hasBaseline = true
        holdAwake(next.values.contains(.working))
    }

    // MARK: Notifications

    private func notify(_ session: CodeSession, title: String, body: String) {
        if preferences.notifyOnlyInBackground, NSApp?.isActive == true { return }
        let center = UNUserNotificationCenter.current()
        if !didRequestAuthorization {
            didRequestAuthorization = true
            center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.threadIdentifier = "juno.code"
        content.userInfo = ["sessionID": session.id.value]
        if preferences.notificationSound { content.sound = .default }
        let request = UNNotificationRequest(
            identifier: "juno.code.\(session.id.value).\(title.hashValue)",
            content: content,
            trigger: nil
        )
        center.add(request)
    }

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let id = response.notification.request.content.userInfo["sessionID"] as? String
        // Acknowledged at once: the handler only tells the system the tap was
        // received, and the window does the opening on the main actor.
        completionHandler()
        Task { @MainActor in
            NSApp.activate()
            if let id {
                StudioRunMonitor.shared.openSession?(CodeSessionID(value: id))
            }
        }
    }

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // MARK: Keep awake

    private func holdAwake(_ working: Bool) {
        let wanted = working && preferences.keepAwakeWhileRunning
        if wanted, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(
                options: [.idleSystemSleepDisabled, .userInitiated],
                reason: "Juno Code is running a task"
            )
        } else if !wanted, let current = activity {
            ProcessInfo.processInfo.endActivity(current)
            activity = nil
        }
    }
}
