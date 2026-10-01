import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Asks to run a command that writes a file, then answers whatever comes
/// next.
private final class WriteThenAnswerClient: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        count += 1
        let isFirst = count == 1
        lock.unlock()
        return AsyncThrowingStream { continuation in
            if isFirst {
                continuation.yield(.toolCallRequested(
                    id: "touch",
                    name: "run_command",
                    input: ["command": "touch made.txt"]
                ))
                continuation.yield(.turnCompleted(.toolUse))
            } else {
                continuation.yield(.textDelta("Installed."))
                continuation.yield(.turnCompleted(.endTurn))
            }
            continuation.finish()
        }
    }
}

/// The Runs list: grouping in words, and the answers a row gives
/// (CODE_AGENT_SPEC §5.1).
@MainActor
final class RunIndexTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func session(
        _ status: SessionStatus,
        title: String = "Fix the settings menu",
        updated: TimeInterval = -60,
        pendingApproval: Bool = false,
        error: String? = nil
    ) -> CodeSession {
        CodeSession(
            workspaceID: WorkspaceID(value: "w"),
            title: title,
            status: status,
            configuration: AgentConfiguration(modelID: "m"),
            hasPendingApproval: pendingApproval,
            lastErrorSummary: error,
            createdAt: now.addingTimeInterval(-3_600),
            updatedAt: now.addingTimeInterval(updated)
        )
    }

    private func outcome(_ reason: RunEndReason, files: Int = 3) -> RecordedRunOutcome {
        RecordedRunOutcome(
            outcome: RunOutcomeEvent(
                endReason: reason,
                summary: reason == .blocked ? "needs a decision about the migration" : "Done: the menu opens.",
                verification: nil,
                checks: [
                    RunOutcomeCheck(label: "swift test", passed: reason != .checksFailing),
                ],
                filesChanged: files
            ),
            recordedAt: now.addingTimeInterval(-30)
        )
    }

    // MARK: - Grouping

    func testEveryEndReasonLandsInTheGroupThatSaysWhatItNeeds() {
        let expected: [RunEndReason: RunGroup] = [
            .doneChecked: .readyForReview,
            .doneUnchecked: .readyForReview,
            .checksFailing: .needsYou,
            .blocked: .needsYou,
            .needsYou: .needsYou,
            .stepLimit: .needsYou,
            .budget: .needsYou,
            .stalled: .needsYou,
            .waitingOnBackground: .working,
            .stopped: .done,
            .interrupted: .interrupted,
            .error: .failed,
        ]
        XCTAssertEqual(Set(expected.keys), Set(RunEndReason.allCases), "every end reason is covered")
        for (reason, group) in expected {
            let facts = RunFacts(session: session(.completed), project: "juno", outcome: outcome(reason))
            let entry = RunIndex.entry(for: facts, now: now)
            XCTAssertEqual(entry?.group, group, "\(reason) belongs in \(group.title)")
            XCTAssertEqual(entry?.endReason, reason)
            XCTAssertEqual(
                entry?.actions.contains(.keepGoing),
                reason.offersKeepGoing,
                "Keep going only for step limit, budget and stall"
            )
        }
    }

    func testAFinishedRunTheReaderOpenedMovesFromReadyForReviewToDone() {
        let unread = RunFacts(session: session(.completed), project: "juno", outcome: outcome(.doneChecked))
        XCTAssertEqual(RunIndex.entry(for: unread, now: now)?.group, .readyForReview)
        let read = RunFacts(
            session: session(.completed),
            project: "juno",
            outcome: outcome(.doneChecked),
            viewedAt: now
        )
        XCTAssertEqual(RunIndex.entry(for: read, now: now)?.group, .done)
        let nothingChanged = RunFacts(session: session(.completed), project: "juno", outcome: outcome(.doneChecked, files: 0))
        XCTAssertEqual(RunIndex.entry(for: nothingChanged, now: now)?.group, .done)
    }

    func testSentencesAreWordsFromTheEndReason() {
        let done = RunIndex.entry(
            for: RunFacts(session: session(.completed), project: "juno", outcome: outcome(.doneChecked)),
            now: now
        )
        XCTAssertEqual(done?.sentence, "Done · checked with `swift test` · 3 files")
        let failing = RunIndex.entry(
            for: RunFacts(session: session(.completed), project: "juno", outcome: outcome(.checksFailing)),
            now: now
        )
        XCTAssertEqual(failing?.sentence, "`swift test` still fails")
        let blocked = RunIndex.entry(
            for: RunFacts(session: session(.completed), project: "juno", outcome: outcome(.blocked)),
            now: now
        )
        XCTAssertEqual(blocked?.sentence, "Blocked: needs a decision about the migration")
    }

    func testLiveStateComesFirstAndSaysWhatItIsDoing() {
        let approval = ApprovalRequest(
            sessionID: CodeSessionID(),
            actionDigest: "d1",
            toolName: "run_command",
            summary: "Run: npm install",
            risk: .critical,
            requestedAt: now,
            expiresAt: now.addingTimeInterval(900)
        )
        let waiting = RunIndex.entry(
            for: RunFacts(session: session(.waitingForApproval, pendingApproval: true), project: "juno", approval: approval),
            now: now
        )
        XCTAssertEqual(waiting?.group, .needsYou)
        XCTAssertEqual(waiting?.sentence, "Waiting for you to allow `npm install`")
        XCTAssertEqual(waiting?.actions, [.allowOnce, .decline], "never Always allow from a row")
        XCTAssertEqual(waiting?.approval?.actionDigest, "d1")

        let checking = RunIndex.entry(
            for: RunFacts(session: session(.running), project: "juno", activity: "Checking: `swift test`"),
            now: now
        )
        XCTAssertEqual(checking?.group, .working)
        XCTAssertEqual(checking?.sentence, "Checking: `swift test`")
    }

    func testAnInterruptedRunOffersResume() {
        let interrupted = session(.failed, error: CodeSessionStore.interruptionMessage)
        let entry = RunIndex.entry(for: RunFacts(session: interrupted, project: "juno"), now: now)
        XCTAssertEqual(entry?.group, .interrupted)
        XCTAssertEqual(entry?.sentence, "Juno quit while this was running")
        XCTAssertEqual(entry?.actions, [.resume])
    }

    func testABlockedGoalNeedsTheReaderAndANewSessionIsNotListed() {
        let goal = GoalStatusEvent(goalID: "g1", status: .needsYou, reason: "Blocked: the migration needs a decision")
        let entry = RunIndex.entry(
            for: RunFacts(session: session(.cancelled), project: "juno", goalStatus: goal),
            now: now
        )
        XCTAssertEqual(entry?.group, .needsYou, "a blocked goal is not silent")
        XCTAssertEqual(entry?.sentence, "Blocked: the migration needs a decision")
        XCTAssertNil(RunIndex.entry(for: RunFacts(session: session(.idle), project: "juno"), now: now))
    }

    func testOldFinishedRunsLeaveTheListButWaitingOnesNeverDo() {
        let old = RunFacts(session: session(.completed, updated: -3 * 86_400), project: "juno", outcome: outcome(.stopped))
        XCTAssertNil(RunIndex.entry(for: old, now: now))
        let oldWaiting = RunFacts(
            session: session(.completed, updated: -3 * 86_400),
            project: "juno",
            outcome: outcome(.stepLimit)
        )
        XCTAssertEqual(RunIndex.entry(for: oldWaiting, now: now)?.group, .needsYou)
    }

    func testHeadingsCarryTheCountInWords() {
        let sections = RunIndex.sections(from: [
            RunFacts(session: session(.running, title: "A"), project: "juno"),
            RunFacts(session: session(.completed, title: "B"), project: "juno", outcome: outcome(.stepLimit)),
            RunFacts(session: session(.completed, title: "C"), project: "juno", outcome: outcome(.budget)),
        ], now: now)
        XCTAssertEqual(sections.map(\.heading), ["Needs you (2)", "Working (1)"])
        XCTAssertEqual(RunIndex.summaryLine(sections), "1 working, 2 waiting for you")
    }

    // MARK: - Answering from a row

    func testInlineAllowOnceResolvesWithThePendingDigestAndAStaleOneIsRefused() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-run-index-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let workspace = root.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        let client = WriteThenAnswerClient()
        let workbench = WorkbenchModel(dependencies: WorkbenchModel.Dependencies(
            storageRootURL: root.appendingPathComponent("storage"),
            modelClient: client,
            availableModels: [ModelOption(modelID: "test-model", displayName: "Test")]
        ))
        workbench.resumesInterruptedRunsOnLaunch = { false }
        await workbench.bootstrap()
        let added = await workbench.addWorkspace(grantedURL: workspace)
        let record = try XCTUnwrap(added)
        let made = await workbench.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model", permissionMode: .askBeforeChanges)
        )
        let created = try XCTUnwrap(made)
        let loaded = await workbench.controller(for: created.id)
        let controller = try XCTUnwrap(loaded)
        // Another session is in view, so the row is what the reader answers.
        workbench.selectedSessionID = nil

        controller.composerText = "Make the file"
        await controller.send()
        var entry: RunIndexEntry?
        for _ in 0..<400 {
            entry = workbench.runEntries.first { $0.sessionID == created.id && $0.approval != nil }
            if entry != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let row = try XCTUnwrap(entry, "the pending approval never reached the Runs list")
        XCTAssertEqual(row.group, .needsYou)
        let approval = try XCTUnwrap(row.approval)

        // A row that showed some other approval (answered elsewhere, this
        // one arriving since) answers that one or nothing: never the action
        // waiting now, which the reader did not read.
        let otherRow = RunIndexEntry(
            sessionID: created.id,
            title: row.title,
            project: row.project,
            group: .needsYou,
            sentence: "Waiting for you to allow `ls`",
            approval: ApprovalRequest(
                id: "answered-elsewhere",
                sessionID: created.id,
                actionDigest: "digest-of-ls",
                toolName: "run_command",
                summary: "Run: ls",
                risk: .execute,
                requestedAt: Date(),
                expiresAt: Date().addingTimeInterval(900)
            ),
            actions: [.allowOnce, .decline],
            updatedAt: Date()
        )
        let fromOtherRow = await workbench.answer(.allowOnce, shown: otherRow)
        guard case .refused = fromOtherRow else { return XCTFail("a row's answer is bound to what it showed") }
        let declinedFromOtherRow = await workbench.answer(.decline, shown: otherRow)
        guard case .refused = declinedFromOtherRow else { return XCTFail("Decline is bound the same way") }
        XCTAssertEqual(controller.pendingApprovals.map(\.id), [approval.id], "the waiting approval is untouched")

        let stale = await workbench.allowOnce(sessionID: created.id, approvalID: approval.id, digest: "not-the-digest")
        guard case .refused = stale else { return XCTFail("a stale digest must be refused") }
        let stillPending = controller.pendingApprovals.map(\.id)
        XCTAssertEqual(stillPending, [approval.id], "a refused answer changes nothing")

        let allowed = await workbench.allowOnce(
            sessionID: created.id,
            approvalID: approval.id,
            digest: approval.actionDigest
        )
        XCTAssertEqual(allowed, .done)
        for _ in 0..<400 where controller.session.status.isActive || client.requestCount < 2 {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertGreaterThanOrEqual(client.requestCount, 2, "the run carried on after Allow once")
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: workspace.appendingPathComponent("made.txt").path),
            "the allowed command ran"
        )
        XCTAssertFalse(controller.events.contains {
            if case let .approvalResolved(resolved) = $0.payload { return resolved.decision == .denied }
            return false
        }, "the answer was an approval, never a denial")
        let answeredAgain = await workbench.allowOnce(
            sessionID: created.id,
            approvalID: approval.id,
            digest: approval.actionDigest
        )
        guard case .refused = answeredAgain else { return XCTFail("an answered approval cannot be answered twice") }
        let rowAgain = await workbench.answer(.allowOnce, shown: row)
        guard case .refused = rowAgain else { return XCTFail("nor from the row that showed it") }

        // A Keep going or Retry banner left behind starts nothing once the
        // run no longer needs it: the run finished.
        let requestsBefore = client.requestCount
        let keptGoing = await workbench.keepGoing(sessionID: created.id)
        guard case .refused = keptGoing else { return XCTFail("a stale Keep going is refused") }
        let retried = await workbench.retry(sessionID: created.id)
        guard case .refused = retried else { return XCTFail("a stale Retry is refused") }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(client.requestCount, requestsBefore, "no run started")
    }
}
