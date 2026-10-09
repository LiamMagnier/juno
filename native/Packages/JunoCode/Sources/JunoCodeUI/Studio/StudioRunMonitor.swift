import AppKit
import Foundation
import JunoCodeCore
import UserNotifications

// MARK: - What a notification says (pure)

/// Juno Code's notification categories (CODE_AGENT_SPEC §1.11). Each is
/// registered with the system with its actions, so a reader can answer from
/// the banner.
public enum CodeNotificationCategory: String, CaseIterable, Sendable {
    /// `doneChecked`, `doneUnchecked`.
    case done = "code.done"
    /// An approval is pending and the session is not in view.
    case needsApproval = "code.needs-approval"
    /// A screen action's card is pending. It is allowed only on the card in
    /// the session, which shows the frame with the target marked and keeps
    /// the grant sheet's choices (CU-07, Lane C), so the banner offers
    /// Decline and Open, never Allow once.
    case needsScreenApproval = "code.needs-approval.screen"
    /// `ask_user` is pending.
    case question = "code.question"
    /// `checksFailing`, `blocked`, or a goal that needs the reader.
    case needsYou = "code.needs-you"
    /// `stepLimit`, `budget`, `stalled`: the same as ``needsYou`` with
    /// Keep going. A category's actions are fixed, hence two ids.
    case needsYouKeepGoing = "code.needs-you.keep-going"
    /// CI finished for a pull request Juno opened.
    case ci = "code.ci"
    /// `error`.
    case failed = "code.failed"

    /// The buttons the banner offers, in order. Open is also the click.
    public var actions: [CodeNotificationAction] {
        switch self {
        case .done: [.open, .reviewChanges]
        case .needsApproval: [.allowOnce, .decline, .open]
        case .needsScreenApproval: [.decline, .open]
        case .question: [.reply, .open]
        case .needsYou: [.open]
        case .needsYouKeepGoing: [.keepGoing, .open]
        case .ci: [.fixIt, .open]
        case .failed: [.retry, .open]
        }
    }

    /// The banner for a pending approval: a screen card's has no Allow once.
    public static func forApproval(_ approval: ApprovalRequest) -> CodeNotificationCategory {
        ComputerUseToolName.allowedOnlyAtTheMac.contains(approval.toolName) ? .needsScreenApproval : .needsApproval
    }
}

/// One button on a Juno Code notification.
public enum CodeNotificationAction: String, CaseIterable, Sendable {
    case open = "code.open"
    case reviewChanges = "code.review-changes"
    /// Resolves the approval it carries, bound to its digest. "Always allow"
    /// is deliberately absent: the rule it writes is read in the app.
    case allowOnce = "code.allow-once"
    case decline = "code.decline"
    /// A text field: the answer to the question.
    case reply = "code.reply"
    case keepGoing = "code.keep-going"
    case fixIt = "code.fix-it"
    case retry = "code.retry"

    public var title: String {
        switch self {
        case .open: "Open"
        case .reviewChanges: "Review changes"
        case .allowOnce: "Allow once"
        case .decline: "Decline"
        case .reply: "Reply"
        case .keepGoing: "Keep going"
        case .fixIt: "Fix it"
        case .retry: "Retry"
        }
    }

    /// Whether answering brings Juno forward. Allow once, Decline, Reply,
    /// Keep going and Retry are answered where the reader is.
    public var opensApp: Bool {
        switch self {
        case .open, .reviewChanges, .fixIt: true
        case .allowOnce, .decline, .reply, .keepGoing, .retry: false
        }
    }
}

/// The keys a Juno Code notification carries.
public enum CodeNotificationKey {
    public static let sessionID = "sessionID"
    public static let approvalID = "approvalID"
    public static let digest = "actionDigest"
    public static let questionID = "questionID"
    public static let category = "category"
}

/// One notification, ready to post.
public struct CodeNotification: Equatable, Sendable {
    public let identifier: String
    public let category: CodeNotificationCategory
    public let title: String
    public let body: String
    public let userInfo: [String: String]
    /// Seconds from now; nil posts at once.
    public let delay: TimeInterval?

    public init(
        identifier: String,
        category: CodeNotificationCategory,
        title: String,
        body: String,
        userInfo: [String: String],
        delay: TimeInterval? = nil
    ) {
        self.identifier = identifier
        self.category = category
        self.title = title
        self.body = body
        self.userInfo = userInfo
        self.delay = delay
    }
}

/// The reader's notification switches, as the planner reads them.
public struct CodeNotificationPreferences: Equatable, Sendable {
    public var whenDone: Bool
    public var whenNeedsYou: Bool
    /// "Only while Juno is in the background": keeps a finished run quiet
    /// while Juno is in front. What blocks a run — an approval, a question —
    /// still speaks for a session that is not in view.
    public var doneOnlyInBackground: Bool

    public init(whenDone: Bool = true, whenNeedsYou: Bool = true, doneOnlyInBackground: Bool = true) {
        self.whenDone = whenDone
        self.whenNeedsYou = whenNeedsYou
        self.doneOnlyInBackground = doneOnlyInBackground
    }
}

/// Decides what a change in the Runs list says, if anything.
public enum RunNotificationPlanner {
    /// The notification for one session's row moving from `previous` to
    /// `current`, or nil.
    ///
    /// - Parameters:
    ///   - inView: the reader is looking at this session. Nothing fires for
    ///     it: the card is on screen.
    ///   - appActive: Juno is the frontmost app.
    public static func notification(
        previous: RunIndexEntry?,
        current: RunIndexEntry,
        inView: Bool,
        appActive: Bool,
        preferences: CodeNotificationPreferences
    ) -> CodeNotification? {
        guard !inView else { return nil }
        var info = [CodeNotificationKey.sessionID: current.sessionID.value]

        if let approval = current.approval {
            guard previous?.approval?.id != approval.id, preferences.whenNeedsYou else { return nil }
            info[CodeNotificationKey.approvalID] = approval.id
            info[CodeNotificationKey.digest] = approval.actionDigest
            let category = CodeNotificationCategory.forApproval(approval)
            info[CodeNotificationKey.category] = category.rawValue
            return CodeNotification(
                identifier: "juno.code.approval.\(approval.id)",
                category: category,
                title: "Allow \(RunIndex.approvalSubject(approval))?",
                body: approvalBody(approval, entry: current),
                userInfo: info
            )
        }
        if let question = current.question {
            guard previous?.question?.id != question.id, preferences.whenNeedsYou else { return nil }
            info[CodeNotificationKey.questionID] = question.id
            info[CodeNotificationKey.category] = CodeNotificationCategory.question.rawValue
            return CodeNotification(
                identifier: "juno.code.question.\(question.id)",
                category: .question,
                title: current.title,
                body: question.questions.first?.question ?? "Alevr has a question.",
                userInfo: info
            )
        }

        // An ending speaks once, when it changes: a run that was working or
        // waiting on the reader and is now done or failed, or a run that now
        // needs the reader for a new reason (an outcome can land after the
        // status that first said "done").
        guard let reason = current.endReason, let previous else { return nil }
        if current.group == .needsYou {
            guard previous.group != .needsYou || previous.endReason != reason else { return nil }
        } else {
            guard previous.group == .working || previous.group == .needsYou,
                  previous.endReason != reason || previous.group != current.group
            else { return nil }
        }
        let category: CodeNotificationCategory
        switch reason.notification {
        case .done:
            guard preferences.whenDone, !(preferences.doneOnlyInBackground && appActive) else { return nil }
            category = .done
        case .needsYou:
            guard preferences.whenNeedsYou else { return nil }
            category = reason.offersKeepGoing ? .needsYouKeepGoing : .needsYou
        case .failed:
            guard preferences.whenDone else { return nil }
            category = .failed
        case .none:
            return nil
        }
        info[CodeNotificationKey.category] = category.rawValue
        return CodeNotification(
            identifier: "juno.code.\(current.sessionID.value).\(reason.rawValue)",
            category: category,
            title: title(for: category, entry: current),
            body: current.sentence,
            userInfo: info
        )
    }

    /// The approval banner's body: the exact command or action, then where.
    static func approvalBody(_ approval: ApprovalRequest, entry: RunIndexEntry) -> String {
        let place = entry.project.isEmpty ? entry.title : "\(entry.title) · \(entry.project)"
        guard CodeNotificationCategory.forApproval(approval) == .needsScreenApproval else {
            return "\(approval.summary)\n\(place)"
        }
        return "\(approval.summary)\n\(place)\n\(screenApprovalNote)"
    }

    /// Why a screen card's banner has no Allow once.
    static let screenApprovalNote = "Open the session to allow it: its card shows what Alevr will click."

    static func title(for category: CodeNotificationCategory, entry: RunIndexEntry) -> String {
        switch category {
        case .done: "Finished: \(entry.title)"
        case .failed: "Stopped with an error: \(entry.title)"
        case .needsYou, .needsYouKeepGoing: "Needs you: \(entry.title)"
        case .needsApproval, .needsScreenApproval, .question, .ci: entry.title
        }
    }

    /// The `code.ci` banner for a pull request whose checks settled.
    public static func ciNotification(
        sessionID: CodeSessionID,
        sessionTitle: String,
        status: CIStatusEvent
    ) -> CodeNotification {
        CodeNotification(
            identifier: "juno.code.ci.\(sessionID.value).\(status.pullRequestNumber ?? 0)",
            category: .ci,
            title: status.pullRequestNumber.map { "CI for pull request #\($0)" } ?? "CI finished",
            body: CIStatusWords.summary(status.checks) + " · " + sessionTitle,
            userInfo: [
                CodeNotificationKey.sessionID: sessionID.value,
                CodeNotificationKey.category: CodeNotificationCategory.ci.rawValue,
            ]
        )
    }
}

/// When a parked approval reminds the reader again: 15, 60 and 240 minutes
/// after it was asked (§1.11). The call waits the whole time.
public enum ApprovalReminderSchedule {
    public static let offsets: [TimeInterval] = [15 * 60, 60 * 60, 240 * 60]

    /// The reminders still to come for an approval asked at `requestedAt`,
    /// each with the seconds from `now` until it is due.
    public static func reminders(
        for approval: ApprovalRequest,
        entry: RunIndexEntry,
        now: Date
    ) -> [CodeNotification] {
        let category = CodeNotificationCategory.forApproval(approval)
        return offsets.enumerated().compactMap { index, offset in
            let delay = approval.requestedAt.addingTimeInterval(offset).timeIntervalSince(now)
            guard delay > 0 else { return nil }
            let minutes = Int(offset / 60)
            let waited = minutes >= 60
                ? (minutes == 60 ? "an hour" : "\(minutes / 60) hours")
                : "\(minutes) minutes"
            return CodeNotification(
                identifier: reminderIdentifier(approvalID: approval.id, index: index),
                category: category,
                title: "Still waiting: allow \(RunIndex.approvalSubject(approval))?",
                body: "Waiting for \(waited). " + RunNotificationPlanner.approvalBody(approval, entry: entry),
                userInfo: [
                    CodeNotificationKey.sessionID: entry.sessionID.value,
                    CodeNotificationKey.approvalID: approval.id,
                    CodeNotificationKey.digest: approval.actionDigest,
                    CodeNotificationKey.category: category.rawValue,
                ],
                delay: delay
            )
        }
    }

    public static func reminderIdentifier(approvalID: String, index: Int) -> String {
        "juno.code.approval.\(approvalID).reminder.\(index)"
    }

    /// Every identifier an approval's notifications use, to take them down
    /// once it is answered.
    public static func identifiers(approvalID: String) -> [String] {
        ["juno.code.approval.\(approvalID)"]
            + offsets.indices.map { reminderIdentifier(approvalID: approvalID, index: $0) }
    }
}

// MARK: - The monitor

/// Where notifications go: the system's notification centre in the app, a
/// recorder in tests, which never post a real notification.
@MainActor
public protocol CodeNotificationSink: AnyObject {
    func register(_ categories: [CodeNotificationCategory])
    /// Makes `delegate` the notification centre's delegate, so answers reach
    /// the app. A recorder ignores it.
    func adopt(delegate: any UNUserNotificationCenterDelegate)
    /// Takes down reminders left scheduled by an earlier launch: the
    /// approvals they were about ended with it.
    func clearStaleReminders()
    func post(_ notification: CodeNotification, sound: Bool)
    func remove(identifiers: [String])
}

/// What answering a notification does, set by the host. Each answer goes
/// through the same path as the in-app control, with the same digest check.
public struct CodeNotificationResponder {
    public var open: @MainActor (CodeSessionID) -> Void
    public var reviewChanges: @MainActor (CodeSessionID) -> Void
    public var allowOnce: @MainActor (CodeSessionID, _ approvalID: String, _ digest: String) async -> Void
    public var decline: @MainActor (CodeSessionID, _ approvalID: String, _ digest: String) async -> Void
    public var reply: @MainActor (CodeSessionID, _ questionID: String, _ text: String) async -> Void
    public var keepGoing: @MainActor (CodeSessionID) async -> Void
    public var retry: @MainActor (CodeSessionID) async -> Void
    public var fixIt: @MainActor (CodeSessionID) async -> Void

    public init(
        open: @escaping @MainActor (CodeSessionID) -> Void,
        reviewChanges: @escaping @MainActor (CodeSessionID) -> Void = { _ in },
        allowOnce: @escaping @MainActor (CodeSessionID, String, String) async -> Void = { _, _, _ in },
        decline: @escaping @MainActor (CodeSessionID, String, String) async -> Void = { _, _, _ in },
        reply: @escaping @MainActor (CodeSessionID, String, String) async -> Void = { _, _, _ in },
        keepGoing: @escaping @MainActor (CodeSessionID) async -> Void = { _ in },
        retry: @escaping @MainActor (CodeSessionID) async -> Void = { _ in },
        fixIt: @escaping @MainActor (CodeSessionID) async -> Void = { _ in }
    ) {
        self.open = open
        self.reviewChanges = reviewChanges
        self.allowOnce = allowOnce
        self.decline = decline
        self.reply = reply
        self.keepGoing = keepGoing
        self.retry = retry
        self.fixIt = fixIt
    }
}

/// Watches every session and does what a reader who has looked away needs:
/// says when a run finished or is waiting on them, in words, with the answer
/// on the banner; reminds them of a parked approval; and keeps the Mac awake
/// while anything is working.
///
/// Fed by the workbench (`WorkbenchModel.sessionsObserver` and
/// `runIndexObserver`), not by a window, so it hears runs with Chat showing or
/// every window closed. It used to be fed by the Code window's `onChange`, so
/// closing the window stopped it hearing anything.
@MainActor
public final class StudioRunMonitor: NSObject, UNUserNotificationCenterDelegate {
    public static let shared = StudioRunMonitor(sink: SystemCodeNotificationSink())

    /// The session the reader is looking at, set by the host. Nothing fires
    /// for it.
    public var sessionInView: @MainActor () -> CodeSessionID? = { nil }
    /// Whether Juno is the frontmost app.
    public var isAppActive: @MainActor () -> Bool = { NSApp?.isActive == true }
    /// The clock reminders are scheduled from.
    var now: @MainActor () -> Date = { Date() }

    private let sink: any CodeNotificationSink
    private var responder: CodeNotificationResponder?
    private var previousRuns: [CodeSessionID: RunIndexEntry] = [:]
    private var scheduledReminders: [String: [String]] = [:]
    private var activity: NSObjectProtocol?
    private var hasRunBaseline = false
    private let preferencesSource: @MainActor () -> StudioPreferences

    init(
        sink: any CodeNotificationSink,
        preferences: @escaping @MainActor () -> StudioPreferences = { .shared }
    ) {
        self.sink = sink
        self.preferencesSource = preferences
        super.init()
    }

    private var preferences: StudioPreferences { preferencesSource() }

    /// Call once at launch, so answers to Juno's notifications reach the app.
    public func install(responder: CodeNotificationResponder) {
        self.responder = responder
        sink.register(CodeNotificationCategory.allCases)
        sink.adopt(delegate: self)
        sink.clearStaleReminders()
    }

    /// A click opens the session it is about, and nothing else answers.
    public func install(openSession: @escaping @MainActor (CodeSessionID) -> Void) {
        install(responder: CodeNotificationResponder(open: openSession))
    }

    /// The session list: keeps the Mac awake while anything works.
    public func observe(_ sessions: [CodeSession]) {
        let working = sessions.contains {
            StudioStatus($0.status, hasPendingApproval: $0.hasPendingApproval) == .working
        }
        holdAwake(working)
    }

    /// The Runs list: says what changed, in words.
    ///
    /// The first reading only records where things stand: relaunching must
    /// not announce every run that finished while Juno was closed.
    public func observeRuns(_ entries: [RunIndexEntry]) {
        let viewing = sessionInView()
        let active = isAppActive()
        let prefs = CodeNotificationPreferences(
            whenDone: preferences.notifyWhenDone,
            whenNeedsYou: preferences.notifyWhenNeedsYou,
            doneOnlyInBackground: preferences.notifyOnlyInBackground
        )
        var next: [CodeSessionID: RunIndexEntry] = [:]
        for entry in entries {
            next[entry.sessionID] = entry
            guard hasRunBaseline else { continue }
            if let notification = RunNotificationPlanner.notification(
                previous: previousRuns[entry.sessionID],
                current: entry,
                inView: viewing == entry.sessionID,
                appActive: active,
                preferences: prefs
            ) {
                sink.post(notification, sound: preferences.notificationSound)
            }
        }
        updateReminders(next)
        previousRuns = next
        hasRunBaseline = true
    }

    /// A pull request's checks settled: `code.ci`.
    public func ciSettled(sessionID: CodeSessionID, sessionTitle: String, status: CIStatusEvent) {
        guard sessionInView() != sessionID, preferences.notifyWhenNeedsYou || preferences.notifyWhenDone else {
            return
        }
        sink.post(
            RunNotificationPlanner.ciNotification(sessionID: sessionID, sessionTitle: sessionTitle, status: status),
            sound: preferences.notificationSound
        )
    }

    /// Schedules the 15, 60 and 240 minute reminders for each new pending
    /// approval, and takes them and the first banner down once it is
    /// answered.
    private func updateReminders(_ entries: [CodeSessionID: RunIndexEntry]) {
        var live: Set<String> = []
        for entry in entries.values {
            guard let approval = entry.approval else { continue }
            live.insert(approval.id)
            guard scheduledReminders[approval.id] == nil else { continue }
            let reminders = ApprovalReminderSchedule.reminders(for: approval, entry: entry, now: now())
            scheduledReminders[approval.id] = reminders.map(\.identifier)
            guard preferences.notifyWhenNeedsYou, hasRunBaseline else { continue }
            for reminder in reminders {
                sink.post(reminder, sound: preferences.notificationSound)
            }
        }
        for approvalID in scheduledReminders.keys where !live.contains(approvalID) {
            sink.remove(identifiers: ApprovalReminderSchedule.identifiers(approvalID: approvalID))
            scheduledReminders.removeValue(forKey: approvalID)
        }
    }

    // MARK: Answers

    /// Whether Allow once and Decline may answer this approval from a
    /// banner: only one this monitor announced in this launch, and still
    /// waiting. Anything else — a push from elsewhere carrying the right
    /// words, a banner left from an earlier launch — opens the session, where
    /// the real card is.
    func answersFromBanner(approvalID: String) -> Bool {
        scheduledReminders[approvalID] != nil
    }

    /// Routes an answer from a banner. Public so the app's own delegate,
    /// which owns the notification centre, can hand Code's answers on.
    ///
    /// - Parameter fromPush: the notification came from a remote push, not
    ///   from this monitor. A push only ever opens: it is another process's
    ///   data, and an approval is answered from a banner Juno posted itself.
    public func handle(
        actionIdentifier: String,
        userInfo: [String: String],
        text: String?,
        fromPush: Bool = false
    ) async {
        guard let responder, let raw = userInfo[CodeNotificationKey.sessionID] else { return }
        let session = CodeSessionID(value: raw)
        let action = CodeNotificationAction(rawValue: actionIdentifier)
        if fromPush, action != .open, action != nil {
            NSApp?.activate()
            responder.open(session)
            return
        }
        switch action {
        case .allowOnce:
            guard let id = userInfo[CodeNotificationKey.approvalID],
                  let digest = userInfo[CodeNotificationKey.digest]
            else { return }
            // A screen card is allowed on its card (the session's controller
            // refuses it from here too): open the session instead.
            guard answersFromBanner(approvalID: id),
                  userInfo[CodeNotificationKey.category] != CodeNotificationCategory.needsScreenApproval.rawValue
            else {
                NSApp?.activate()
                responder.open(session)
                return
            }
            await responder.allowOnce(session, id, digest)
        case .decline:
            guard let id = userInfo[CodeNotificationKey.approvalID],
                  let digest = userInfo[CodeNotificationKey.digest]
            else { return }
            guard answersFromBanner(approvalID: id) else {
                NSApp?.activate()
                responder.open(session)
                return
            }
            await responder.decline(session, id, digest)
        case .reply:
            guard let id = userInfo[CodeNotificationKey.questionID],
                  let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return }
            await responder.reply(session, id, text)
        case .keepGoing:
            await responder.keepGoing(session)
        case .retry:
            await responder.retry(session)
        case .fixIt:
            NSApp?.activate()
            responder.open(session)
            await responder.fixIt(session)
        case .reviewChanges:
            NSApp?.activate()
            responder.reviewChanges(session)
        case .open, nil:
            // The banner's own click arrives as the default action.
            NSApp?.activate()
            responder.open(session)
        }
    }

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        var info: [String: String] = [:]
        for (key, value) in response.notification.request.content.userInfo {
            if let key = key as? String, let value = value as? String { info[key] = value }
        }
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        // Juno Code's own notifications are local; one that arrived as a
        // push can only open the session it names.
        let fromPush = response.notification.request.trigger is UNPushNotificationTrigger
        // Acknowledged at once; the answer is given on the main actor.
        completionHandler()
        Task { @MainActor in
            await StudioRunMonitor.shared.handle(
                actionIdentifier: action,
                userInfo: info,
                text: text,
                fromPush: fromPush
            )
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
                reason: "Alevr Code is running a task"
            )
        } else if !wanted, let current = activity {
            ProcessInfo.processInfo.endActivity(current)
            activity = nil
        }
    }
}

/// The system notification centre, as a sink.
@MainActor
final class SystemCodeNotificationSink: CodeNotificationSink {
    private var didRequestAuthorization = false

    func register(_ categories: [CodeNotificationCategory]) {
        let registered = Set(categories.map { category in
            UNNotificationCategory(
                identifier: category.rawValue,
                actions: category.actions.map(Self.action),
                intentIdentifiers: [],
                options: []
            )
        })
        // Juno Code's are the app's only categories; the rest of the app
        // posts plain notifications.
        UNUserNotificationCenter.current().setNotificationCategories(registered)
    }

    func adopt(delegate: any UNUserNotificationCenterDelegate) {
        UNUserNotificationCenter.current().delegate = delegate
    }

    func post(_ notification: CodeNotification, sound: Bool) {
        let center = UNUserNotificationCenter.current()
        if !didRequestAuthorization {
            didRequestAuthorization = true
            center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.threadIdentifier = "juno.code"
        content.categoryIdentifier = notification.category.rawValue
        content.userInfo = notification.userInfo
        if sound { content.sound = .default }
        let trigger = notification.delay.map {
            UNTimeIntervalNotificationTrigger(timeInterval: max(1, $0), repeats: false)
        }
        center.add(UNNotificationRequest(identifier: notification.identifier, content: content, trigger: trigger))
    }

    func clearStaleReminders() {
        Task {
            let stale = await Self.pendingReminderIdentifiers()
            guard !stale.isEmpty else { return }
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: stale)
        }
    }

    nonisolated private static func pendingReminderIdentifiers() async -> [String] {
        await UNUserNotificationCenter.current().pendingNotificationRequests()
            .map(\.identifier)
            .filter { $0.hasPrefix("juno.code.approval.") }
    }

    func remove(identifiers: [String]) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    private static func action(_ action: CodeNotificationAction) -> UNNotificationAction {
        let options: UNNotificationActionOptions = action.opensApp ? [.foreground] : []
        if action == .reply {
            return UNTextInputNotificationAction(
                identifier: action.rawValue,
                title: action.title,
                options: options,
                textInputButtonTitle: "Send",
                textInputPlaceholder: "Your answer"
            )
        }
        return UNNotificationAction(identifier: action.rawValue, title: action.title, options: options)
    }
}
