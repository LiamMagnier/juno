import UserNotifications
import XCTest
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeUI

/// What the run monitor says and when (CODE_AGENT_SPEC §1.11). A recording
/// sink stands in for the notification centre: nothing is ever posted.
@MainActor
final class StudioRunMonitorTests: XCTestCase {
    private final class RecordingSink: CodeNotificationSink {
        var registered: [CodeNotificationCategory] = []
        var posted: [CodeNotification] = []
        var removed: [String] = []

        func register(_ categories: [CodeNotificationCategory]) { registered = categories }
        func adopt(delegate: any UNUserNotificationCenterDelegate) {}
        func clearStaleReminders() {}
        func post(_ notification: CodeNotification, sound: Bool) { posted.append(notification) }
        func remove(identifiers: [String]) { removed += identifiers }
    }

    private var sink: RecordingSink!
    private var monitor: StudioRunMonitor!
    private var defaults: UserDefaults!
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let sessionID = CodeSessionID(value: "s1")

    override func setUp() async throws {
        let suite = "juno.run-monitor.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: suite) }
        let preferences = StudioPreferences(store: defaults)
        sink = RecordingSink()
        monitor = StudioRunMonitor(sink: sink, preferences: { preferences })
        monitor.isAppActive = { false }
        monitor.sessionInView = { nil }
        let fixed = now
        monitor.now = { fixed }
    }

    private func entry(
        _ group: RunGroup,
        reason: RunEndReason? = nil,
        sentence: String = "Working",
        approval: ApprovalRequest? = nil,
        question: QuestionRequest? = nil
    ) -> RunIndexEntry {
        RunIndexEntry(
            sessionID: sessionID,
            title: "Fix the settings menu",
            project: "juno",
            group: group,
            sentence: sentence,
            endReason: reason,
            approval: approval,
            question: question,
            updatedAt: now
        )
    }

    private func approval(_ id: String = "a1", command: String = "npm install") -> ApprovalRequest {
        ApprovalRequest(
            id: id,
            sessionID: sessionID,
            actionDigest: "digest-\(id)",
            toolName: "run_command",
            summary: "Run: \(command)",
            risk: .critical,
            requestedAt: now,
            expiresAt: now.addingTimeInterval(900)
        )
    }

    // MARK: - Categories and actions

    func testEachCategoryOffersTheActionsTheSpecLists() {
        XCTAssertEqual(CodeNotificationCategory.done.actions, [.open, .reviewChanges])
        XCTAssertEqual(CodeNotificationCategory.needsApproval.actions, [.allowOnce, .decline, .open])
        XCTAssertEqual(CodeNotificationCategory.needsScreenApproval.actions, [.decline, .open],
                       "a screen card is allowed on its card, never from a banner")
        XCTAssertEqual(CodeNotificationCategory.question.actions, [.reply, .open])
        XCTAssertEqual(CodeNotificationCategory.needsYou.actions, [.open])
        XCTAssertEqual(CodeNotificationCategory.needsYouKeepGoing.actions, [.keepGoing, .open])
        XCTAssertEqual(CodeNotificationCategory.ci.actions, [.fixIt, .open])
        XCTAssertEqual(CodeNotificationCategory.failed.actions, [.retry, .open])
        XCTAssertFalse(
            CodeNotificationCategory.allCases.flatMap(\.actions).map(\.title).contains("Always allow"),
            "Always allow stays in the app, where its rule can be read"
        )
        monitor.install(responder: CodeNotificationResponder(open: { _ in }))
        XCTAssertEqual(Set(sink.registered), Set(CodeNotificationCategory.allCases))
    }

    func testTheCategoryFollowsTheEndReason() {
        let cases: [(RunEndReason, RunGroup, CodeNotificationCategory?)] = [
            (.doneChecked, .readyForReview, .done),
            (.doneUnchecked, .done, .done),
            (.checksFailing, .needsYou, .needsYou),
            (.blocked, .needsYou, .needsYou),
            (.needsYou, .needsYou, .needsYou),
            (.stepLimit, .needsYou, .needsYouKeepGoing),
            (.budget, .needsYou, .needsYouKeepGoing),
            (.stalled, .needsYou, .needsYouKeepGoing),
            (.error, .failed, .failed),
            (.stopped, .done, nil),
            (.interrupted, .interrupted, nil),
            (.waitingOnBackground, .working, nil),
        ]
        for (reason, group, category) in cases {
            let planned = RunNotificationPlanner.notification(
                previous: entry(.working),
                current: entry(group, reason: reason, sentence: "said in words"),
                inView: false,
                appActive: false,
                preferences: CodeNotificationPreferences()
            )
            XCTAssertEqual(planned?.category, category, "\(reason)")
            if planned != nil {
                XCTAssertEqual(planned?.body, "said in words")
                XCTAssertEqual(planned?.userInfo[CodeNotificationKey.sessionID], sessionID.value)
            }
        }
    }

    func testABlockedGoalNotifies() throws {
        let blocked = RunIndex.entry(
            for: RunFacts(
                session: CodeSession(
                    id: sessionID,
                    workspaceID: nil,
                    title: "Migrate",
                    status: .cancelled,
                    configuration: AgentConfiguration(modelID: "m"),
                    createdAt: now,
                    updatedAt: now
                ),
                project: "juno",
                goalStatus: GoalStatusEvent(goalID: "g", status: .needsYou, reason: "Blocked: needs a decision")
            ),
            now: now
        )
        let planned = RunNotificationPlanner.notification(
            previous: entry(.working),
            current: try XCTUnwrap(blocked),
            inView: false,
            appActive: false,
            preferences: CodeNotificationPreferences()
        )
        XCTAssertEqual(planned?.category, .needsYou, "a blocked goal is no longer silent")
        XCTAssertEqual(planned?.body, "Blocked: needs a decision")
    }

    func testNothingFiresForTheSessionInView() {
        monitor.observeRuns([entry(.working)])
        monitor.sessionInView = { [sessionID] in sessionID }
        monitor.observeRuns([entry(.needsYou, reason: .needsYou, approval: approval())])
        monitor.observeRuns([entry(.readyForReview, reason: .doneChecked, sentence: "Done")])
        XCTAssertTrue(sink.posted.filter { $0.delay == nil }.isEmpty, "the reader is looking at it")
    }

    func testTheApprovalBannerCarriesTheExactCommandAndTheDigest() throws {
        monitor.observeRuns([entry(.working)])
        monitor.observeRuns([entry(.needsYou, reason: .needsYou, approval: approval(command: "rm -rf build && npm ci"))])
        let banner = try XCTUnwrap(sink.posted.first { $0.delay == nil })
        XCTAssertEqual(banner.category, .needsApproval)
        XCTAssertTrue(banner.body.contains("Run: rm -rf build && npm ci"), banner.body)
        XCTAssertTrue(banner.body.contains("juno"), "and the project")
        XCTAssertEqual(banner.title, "Allow `rm -rf build && npm ci`?")
        XCTAssertEqual(banner.userInfo[CodeNotificationKey.approvalID], "a1")
        XCTAssertEqual(banner.userInfo[CodeNotificationKey.digest], "digest-a1")
    }

    func testAnApprovalNotifiesWhileJunoIsInFrontButAFinishedRunWaitsForTheBackground() {
        monitor.isAppActive = { true }
        monitor.observeRuns([entry(.working)])
        monitor.observeRuns([entry(.needsYou, reason: .needsYou, approval: approval())])
        XCTAssertEqual(sink.posted.filter { $0.delay == nil }.map(\.category), [.needsApproval],
                       "a different session waiting on the reader speaks even with Alevr in front")
        monitor.observeRuns([entry(.working)])
        monitor.observeRuns([entry(.readyForReview, reason: .doneChecked)])
        XCTAssertEqual(sink.posted.filter { $0.delay == nil }.map(\.category), [.needsApproval],
                       "Done stays quiet in front while “only in the background” is on")
    }

    func testTheFirstReadingAfterLaunchSaysNothing() {
        monitor.observeRuns([entry(.needsYou, reason: .stepLimit)])
        XCTAssertTrue(sink.posted.isEmpty)
    }

    // MARK: - Parked approvals

    func testAParkedApprovalRemindsAtFifteenSixtyAndTwoHundredFortyMinutesThenIsTakenDown() {
        monitor.observeRuns([entry(.working)])
        monitor.observeRuns([entry(.needsYou, reason: .needsYou, approval: approval())])
        let reminders = sink.posted.filter { $0.delay != nil }
        XCTAssertEqual(reminders.map(\.delay), [15 * 60, 60 * 60, 240 * 60])
        XCTAssertTrue(reminders.allSatisfy { $0.category == .needsApproval && $0.userInfo[CodeNotificationKey.digest] == "digest-a1" })
        XCTAssertTrue(reminders[1].body.hasPrefix("Waiting for an hour."), reminders[1].body)

        monitor.observeRuns([entry(.working)])
        XCTAssertEqual(Set(sink.removed), Set(ApprovalReminderSchedule.identifiers(approvalID: "a1")),
                       "an answered approval takes its banner and reminders down")
    }

    // MARK: - Answers

    @MainActor
    private final class Calls {
        var list: [String] = []
    }

    func testAnswersReachTheResponderWithTheDigest() async {
        let calls = Calls()
        monitor.install(responder: CodeNotificationResponder(
            open: { calls.list.append("open \($0.value)") },
            allowOnce: { session, id, digest in calls.list.append("allow \(session.value) \(id) \(digest)") },
            decline: { session, id, digest in calls.list.append("decline \(session.value) \(id) \(digest)") },
            reply: { session, id, text in calls.list.append("reply \(session.value) \(id) \(text)") },
            keepGoing: { calls.list.append("keep \($0.value)") },
            retry: { calls.list.append("retry \($0.value)") }
        ))
        // The approval the banner is about, as the monitor announced it.
        monitor.observeRuns([entry(.working)])
        monitor.observeRuns([entry(.needsYou, reason: .needsYou, approval: approval())])
        let info = [
            CodeNotificationKey.sessionID: "s1",
            CodeNotificationKey.approvalID: "a1",
            CodeNotificationKey.digest: "d1",
            CodeNotificationKey.questionID: "q1",
        ]
        await monitor.handle(actionIdentifier: CodeNotificationAction.allowOnce.rawValue, userInfo: info, text: nil)
        await monitor.handle(actionIdentifier: CodeNotificationAction.decline.rawValue, userInfo: info, text: nil)
        await monitor.handle(actionIdentifier: CodeNotificationAction.reply.rawValue, userInfo: info, text: "Use pnpm")
        await monitor.handle(actionIdentifier: CodeNotificationAction.reply.rawValue, userInfo: info, text: "   ")
        await monitor.handle(actionIdentifier: CodeNotificationAction.keepGoing.rawValue, userInfo: info, text: nil)
        await monitor.handle(actionIdentifier: CodeNotificationAction.retry.rawValue, userInfo: info, text: nil)
        var withoutDigest = info
        withoutDigest[CodeNotificationKey.digest] = nil
        await monitor.handle(actionIdentifier: CodeNotificationAction.allowOnce.rawValue, userInfo: withoutDigest, text: nil)
        XCTAssertEqual(calls.list, [
            "allow s1 a1 d1",
            "decline s1 a1 d1",
            "reply s1 q1 Use pnpm",
            "keep s1",
            "retry s1",
        ], "an empty reply and an answer without its digest do nothing")
    }

    func testOnlyABannerThisMonitorPostedCanAnswerAnApproval() async {
        let calls = Calls()
        monitor.install(responder: CodeNotificationResponder(
            open: { calls.list.append("open \($0.value)") },
            allowOnce: { session, id, _ in calls.list.append("allow \(session.value) \(id)") },
            decline: { session, id, _ in calls.list.append("decline \(session.value) \(id)") },
            keepGoing: { calls.list.append("keep \($0.value)") }
        ))
        // a2 was never announced in this launch: a banner left from an
        // earlier one, or someone else's notification carrying the words.
        let stranger = [
            CodeNotificationKey.sessionID: "s1",
            CodeNotificationKey.approvalID: "a2",
            CodeNotificationKey.digest: "digest-a2",
        ]
        await monitor.handle(actionIdentifier: CodeNotificationAction.allowOnce.rawValue, userInfo: stranger, text: nil)
        await monitor.handle(actionIdentifier: CodeNotificationAction.decline.rawValue, userInfo: stranger, text: nil)
        XCTAssertEqual(calls.list, ["open s1", "open s1"], "an approval nobody here announced only opens the session")

        // Announced, then answered elsewhere: the banner left behind is stale.
        calls.list = []
        monitor.observeRuns([entry(.working)])
        monitor.observeRuns([entry(.needsYou, reason: .needsYou, approval: approval("a2"))])
        monitor.observeRuns([entry(.working)])
        await monitor.handle(actionIdentifier: CodeNotificationAction.allowOnce.rawValue, userInfo: stranger, text: nil)
        XCTAssertEqual(calls.list, ["open s1"])

        // A remote push never answers, even naming a live approval.
        calls.list = []
        monitor.observeRuns([entry(.needsYou, reason: .needsYou, approval: approval("a2"))])
        await monitor.handle(
            actionIdentifier: CodeNotificationAction.allowOnce.rawValue,
            userInfo: stranger,
            text: nil,
            fromPush: true
        )
        await monitor.handle(
            actionIdentifier: CodeNotificationAction.keepGoing.rawValue,
            userInfo: stranger,
            text: nil,
            fromPush: true
        )
        XCTAssertEqual(calls.list, ["open s1", "open s1"])
        await monitor.handle(actionIdentifier: CodeNotificationAction.allowOnce.rawValue, userInfo: stranger, text: nil)
        XCTAssertEqual(calls.list, ["open s1", "open s1", "allow s1 a2"], "the banner Alevr posted for it does")
    }

    /// A screen card shows the frame with the target marked and keeps the
    /// grant sheet's choices; a banner shows a sentence (CU-07, Lane C). Its
    /// banner and reminders offer Decline and Open, and an Allow once that
    /// arrives anyway opens the session.
    func testAScreenCardsBannerNeverAllowsAndOpensTheSessionInstead() async throws {
        let screen = ApprovalRequest(
            id: "c1",
            sessionID: sessionID,
            actionDigest: "digest-c1",
            toolName: ComputerUseToolName.computer,
            summary: "Click “Send” in Mail",
            risk: .destructive,
            approvalPolicy: .alwaysRequiresApproval,
            requestedAt: now,
            expiresAt: now.addingTimeInterval(900)
        )
        XCTAssertEqual(CodeNotificationCategory.forApproval(screen), .needsScreenApproval)
        XCTAssertEqual(CodeNotificationCategory.forApproval(approval()), .needsApproval)

        let calls = Calls()
        monitor.install(responder: CodeNotificationResponder(
            open: { calls.list.append("open \($0.value)") },
            allowOnce: { session, id, _ in calls.list.append("allow \(session.value) \(id)") },
            decline: { session, id, _ in calls.list.append("decline \(session.value) \(id)") }
        ))
        monitor.observeRuns([entry(.working)])
        monitor.observeRuns([entry(.needsYou, reason: .needsYou, approval: screen)])
        let banner = try XCTUnwrap(sink.posted.first { $0.delay == nil })
        XCTAssertEqual(banner.category, .needsScreenApproval)
        XCTAssertFalse(banner.category.actions.contains(.allowOnce))
        XCTAssertEqual(banner.userInfo[CodeNotificationKey.category], CodeNotificationCategory.needsScreenApproval.rawValue)
        XCTAssertTrue(banner.body.contains("Open the session to allow it"), banner.body)
        let reminders = sink.posted.filter { $0.delay != nil }
        XCTAssertEqual(reminders.count, 3)
        XCTAssertTrue(reminders.allSatisfy { $0.category == .needsScreenApproval }, "and so do its reminders")

        await monitor.handle(actionIdentifier: CodeNotificationAction.allowOnce.rawValue, userInfo: banner.userInfo, text: nil)
        await monitor.handle(actionIdentifier: CodeNotificationAction.decline.rawValue, userInfo: banner.userInfo, text: nil)
        XCTAssertEqual(calls.list, ["open s1", "decline s1 c1"], "Allow once opens the session; Decline still answers")
    }

    func testCISettledSaysHowManyPassed() throws {
        monitor.ciSettled(
            sessionID: sessionID,
            sessionTitle: "Fix the settings menu",
            status: CIStatusEvent(
                pullRequestNumber: 42,
                checks: [
                    CICheck(name: "lint", state: .passed),
                    CICheck(name: "build", state: .passed),
                    CICheck(name: "typecheck", state: .passed),
                    CICheck(name: "test (ubuntu)", state: .failed),
                ]
            )
        )
        let banner = try XCTUnwrap(sink.posted.first)
        XCTAssertEqual(banner.category, .ci)
        XCTAssertEqual(banner.title, "CI for pull request #42")
        XCTAssertEqual(banner.body, "3 of 4 checks passed; `test (ubuntu)` failed · Fix the settings menu")
    }
}
