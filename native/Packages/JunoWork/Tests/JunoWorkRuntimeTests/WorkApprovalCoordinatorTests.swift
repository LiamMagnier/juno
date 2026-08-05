import Foundation
import JunoWorkCore
import JunoWorkRuntime
import XCTest

/// A free function rather than a method on the test case, because half of these
/// tests have to leave a question hanging in a detached `Task` while the main
/// body moves the world underneath it — and a closure that captured the test
/// case would be capturing something that is not `Sendable`.
private func requestAuthorization(
    from coordinator: WorkApprovalCoordinator,
    risk: WorkRiskLevel,
    mode: WorkAccessMode = .readWrite,
    digest: String = "digest-1",
    runID: String = "run-1"
) async -> WorkAuthorizationOutcome {
    await coordinator.authorize(
        action: "apply_changes",
        runID: runID,
        actionDigest: digest,
        risk: risk,
        mode: mode,
        summary: "Move 42 items into Reports"
    )
}

final class WorkApprovalCoordinatorTests: XCTestCase {
    // MARK: - The policy ladder

    func testAnEditRunsWithoutAskingUnderTheBalancedPolicy() async {
        let coordinator = makeCoordinator(policy: .balanced, clock: TestClock())
        let outcome = await requestAuthorization(from: coordinator, risk: .edit)
        XCTAssertEqual(outcome, .allowed)
    }

    func testTheSameEditAsksUnderTheConservativePolicy() async throws {
        let coordinator = makeCoordinator(policy: .conservative, clock: TestClock())
        await answerEverything(coordinator, with: .approved)
        let outcome = await requestAuthorization(from: coordinator, risk: .edit)
        guard case .approved(let receipt) = outcome else {
            return XCTFail("the conservative policy asks about anything that changes something")
        }
        XCTAssertEqual(receipt.request.summary, "Move 42 items into Reports")
    }

    /// Trash is `sensitive`, and sensitive is above the policy ladder: there is
    /// no setting anywhere in the app that turns "something is leaving where you
    /// put it" into a silent action.
    func testSomethingSensitiveAsksEvenUnderThePermissivePolicy() async throws {
        let coordinator = makeCoordinator(
            policy: .permissive,
            allowance: WorkAlwaysAllowance(upTo: .command),
            clock: TestClock()
        )
        await answerEverything(coordinator, with: .approved)
        let outcome = await requestAuthorization(from: coordinator, risk: .sensitive)
        guard case .approved = outcome else {
            return XCTFail("a standing allowance must not cover a Trash move")
        }
    }

    /// The rule that has no value to check because there is no value: a standing
    /// allowance cannot be constructed for anything above `command`.
    func testAStandingAllowanceCannotBeMadeForAnythingItMustNotCover() {
        XCTAssertNil(WorkAlwaysAllowance(upTo: .sensitive))
        XCTAssertNil(WorkAlwaysAllowance(upTo: .irreversible))
        XCTAssertNotNil(WorkAlwaysAllowance(upTo: .command))
    }

    func testAnIrreversibleActionAsksUnderEveryPolicy() async throws {
        for policy in WorkPermissionPolicy.allCases {
            let coordinator = makeCoordinator(
                policy: policy,
                allowance: WorkAlwaysAllowance(upTo: .command),
                clock: TestClock()
            )
            await answerEverything(coordinator, with: .denied)
            let outcome = await requestAuthorization(from: coordinator, risk: .irreversible)
            guard case .denied = outcome else {
                return XCTFail("\(policy.rawValue) let something irreversible through")
            }
        }
    }

    /// A refusal beats a prompt. Offering an Allow button for a change to a
    /// folder somebody shared read-only would let one tap undo the choice they
    /// made when they shared it.
    func testAFolderSharedForReadingOnlyIsRefusedRatherThanOffered() async {
        let coordinator = makeCoordinator(policy: .permissive, clock: TestClock())
        let outcome = await requestAuthorization(from: coordinator, risk: .edit, mode: .read)
        guard case .denied(let reason) = outcome else {
            return XCTFail("a read-only grant must refuse rather than ask")
        }
        XCTAssertTrue(reason.contains("reading only"), reason)
        let pending = await coordinator.pendingApprovals
        XCTAssertTrue(pending.isEmpty)
    }

    /// Nobody is at the Mac, so there is no third option that quietly says yes:
    /// all three unattended policies are ways of not acting.
    func testAnUnattendedRunTurnsAQuestionIntoARefusalRatherThanAYes() async {
        let coordinator = makeCoordinator(
            policy: .permissive,
            unattended: .skipIrreversible,
            clock: TestClock()
        )
        let outcome = await requestAuthorization(from: coordinator, risk: .sensitive)
        guard case .denied(let reason) = outcome else {
            return XCTFail("a scheduled run must not answer its own question")
        }
        XCTAssertTrue(reason.contains("nobody was there"), reason)
    }

    // MARK: - The authority can only shrink underneath a pending question

    /// Somebody narrows Juno's permissions while the approval sheet is on their
    /// screen. What they have narrowed is narrowed: an approval that lands
    /// afterwards authorises nothing, even though this action would still be
    /// merely approval-gated under the new policy.
    func testAnApprovalThatArrivesAfterThePermissionsNarrowedAuthorisesNothing() async throws {
        let coordinator = makeCoordinator(policy: .permissive, clock: TestClock())
        let pending = Task { await requestAuthorization(from: coordinator, risk: .sensitive) }
        let request = try await awaitPendingApproval(coordinator)

        await coordinator.setPolicy(.conservative)
        // Arrives late, naming the right action, and still buys nothing.
        await coordinator.resolve(
            approvalID: request.id,
            decision: .approved,
            actionDigest: request.actionDigest
        )

        guard case .denied(let reason) = await pending.value else {
            return XCTFail("a narrowed policy must invalidate the question it was asked under")
        }
        XCTAssertTrue(reason.contains("permissions"), reason)
    }

    /// Removing a standing allowance narrows the authority in exactly the same
    /// way as lowering the policy, so it has to have exactly the same effect.
    func testRemovingAStandingAllowanceAlsoInvalidatesPendingQuestions() async throws {
        let coordinator = makeCoordinator(
            policy: .conservative,
            allowance: WorkAlwaysAllowance(upTo: .command),
            clock: TestClock()
        )
        let pending = Task { await requestAuthorization(from: coordinator, risk: .sensitive) }
        _ = try await awaitPendingApproval(coordinator)

        await coordinator.setAllowance(nil)

        guard case .denied = await pending.value else {
            return XCTFail("a withdrawn allowance must invalidate what it was asked under")
        }
    }

    /// The person walks away. A question they could have answered a moment ago
    /// is now one nobody can answer, so it must not stay open waiting for a yes
    /// that can no longer be given — while `pauseForApproval`, which still lets
    /// them answer, changes nothing.
    func testAQuestionNobodyCanAnswerAnyMoreIsClosedRatherThanLeftOpen() async throws {
        let coordinator = makeCoordinator(policy: .conservative, clock: TestClock())
        let pending = Task { await requestAuthorization(from: coordinator, risk: .sensitive) }
        let request = try await awaitPendingApproval(coordinator)

        await coordinator.setUnattendedPolicy(.pauseForApproval)
        let stillPending = await coordinator.pendingApprovals
        XCTAssertEqual(stillPending.map(\.id), [request.id])

        await coordinator.setUnattendedPolicy(.disallowIrreversible)

        guard case .denied(let reason) = await pending.value else {
            return XCTFail("a question nobody can answer any more must not stay open")
        }
        XCTAssertTrue(reason.contains("Nobody is at this Mac"), reason)
    }

    // MARK: - Answers are about actions, not about sentences

    /// A stale sheet on a phone that reconnected, or a replayed relay message.
    /// Either way the answer names a different action than the one waiting, and
    /// applying it would authorise something nobody read.
    func testAnAnswerThatEchoesADifferentDigestIsRefused() async throws {
        let coordinator = makeCoordinator(policy: .conservative, clock: TestClock())
        let pending = Task { await requestAuthorization(from: coordinator, risk: .sensitive) }
        let request = try await awaitPendingApproval(coordinator)

        await coordinator.resolve(
            approvalID: request.id,
            decision: .approved,
            actionDigest: "the digest of some other batch entirely"
        )

        guard case .denied(let reason) = await pending.value else {
            return XCTFail("a yes about a different action is not a yes about this one")
        }
        XCTAssertTrue(reason.contains("different action"), reason)
    }

    func testAReceiptDoesNotAuthoriseAnyActionButItsOwn() async throws {
        let coordinator = makeCoordinator(policy: .conservative, clock: TestClock())
        await answerEverything(coordinator, with: .approved)
        let outcome = await requestAuthorization(
            from: coordinator,
            risk: .sensitive,
            digest: "digest-of-the-batch-they-read"
        )
        guard case .approved(let receipt) = outcome else {
            return XCTFail("expected an approval")
        }
        XCTAssertTrue(
            receipt.authorizes(digest: "digest-of-the-batch-they-read", at: receipt.decidedAt)
        )
        XCTAssertFalse(receipt.authorizes(digest: "digest-of-a-rebuilt-batch", at: receipt.decidedAt))
    }

    func testAnAnswerToAQuestionNobodyAskedIsIgnored() async {
        let coordinator = makeCoordinator(policy: .conservative, clock: TestClock())
        // Idempotence, so a re-delivered answer from the relay is harmless
        // rather than a second decision.
        await coordinator.resolve(
            approvalID: "never-asked",
            decision: .approved,
            actionDigest: "digest-1"
        )
        let pending = await coordinator.pendingApprovals
        XCTAssertTrue(pending.isEmpty)
    }

    // MARK: - Expiry and cancellation

    /// An unanswered question resolves itself rather than parking a run for ever
    /// on a phone somebody put down.
    func testAnUnansweredQuestionExpiresClosed() async throws {
        let clock = TestClock()
        let coordinator = makeCoordinator(policy: .conservative, clock: clock)
        let pending = Task { await requestAuthorization(from: coordinator, risk: .sensitive) }
        _ = try await awaitPendingApproval(coordinator)

        clock.advance(by: WorkApprovalCoordinator.approvalTimeToLive + 1)
        await coordinator.sweepExpired()

        guard case .denied(let reason) = await pending.value else {
            return XCTFail("an unanswered approval must expire closed")
        }
        XCTAssertTrue(reason.contains("expired"), reason)
        let stillPending = await coordinator.pendingApprovals
        XCTAssertTrue(stillPending.isEmpty)
    }

    func testASweepBeforeTheExpiryLeavesTheQuestionStanding() async throws {
        let clock = TestClock()
        let coordinator = makeCoordinator(policy: .conservative, clock: clock)
        let pending = Task { await requestAuthorization(from: coordinator, risk: .sensitive) }
        let request = try await awaitPendingApproval(coordinator)

        clock.advance(by: 60)
        await coordinator.sweepExpired()
        let stillPending = await coordinator.pendingApprovals
        XCTAssertEqual(stillPending.map(\.id), [request.id])

        await coordinator.resolve(
            approvalID: request.id,
            decision: .approved,
            actionDigest: request.actionDigest
        )
        guard case .approved = await pending.value else {
            return XCTFail("a question inside its window is still answerable")
        }
    }

    /// Stopping one task must not answer another task's question, and must not
    /// leave its own standing.
    func testStoppingOneRunTakesOnlyItsOwnQuestionsWithIt() async throws {
        let coordinator = makeCoordinator(policy: .conservative, clock: TestClock())
        let stopped = Task {
            await requestAuthorization(from: coordinator, risk: .sensitive, digest: "a", runID: "run-1")
        }
        let untouched = Task {
            await requestAuthorization(from: coordinator, risk: .sensitive, digest: "b", runID: "run-2")
        }
        for _ in 0..<400 {
            if await coordinator.pendingApprovals.count == 2 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let asked = await coordinator.pendingApprovals
        XCTAssertEqual(asked.count, 2)

        await coordinator.denyPending(forRun: "run-1")

        guard case .denied(let reason) = await stopped.value else {
            return XCTFail("a stopped run must not leave an answerable question behind")
        }
        XCTAssertTrue(reason.contains("stopped"), reason)
        let remaining = await coordinator.pendingApprovals
        XCTAssertEqual(remaining.map(\.runID), ["run-2"])

        untouched.cancel()
        await coordinator.denyAll()
        _ = await untouched.value
    }
}
