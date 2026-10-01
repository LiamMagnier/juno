import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// An approval nobody answers parks instead of decaying into a denial
/// (CODE_AGENT_SPEC §1.11): the call waits, bound to its digest, however long
/// the reader takes, and still fails closed on Stop and on a lowered mode.
final class ApprovalParkingTests: XCTestCase {
    private let sessionID = CodeSessionID(value: "parking")

    /// A clock the test moves forward.
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var current = Date(timeIntervalSince1970: 1_800_000_000)

        var now: Date {
            lock.lock()
            defer { lock.unlock() }
            return current
        }

        func advance(minutes: Double) {
            lock.lock()
            current = current.addingTimeInterval(minutes * 60)
            lock.unlock()
        }
    }

    private func pendingApproval(
        _ coordinator: PermissionCoordinator,
        digest: String,
        risk: ActionRisk = .write
    ) async -> (Task<AuthorizationOutcome, Never>, ApprovalRequest) {
        let task = Task {
            await coordinator.authorize(toolName: "write_file", actionDigest: digest, risk: risk, summary: "Write notes.txt")
        }
        for _ in 0..<500 {
            if let request = await coordinator.pendingApprovals.first { return (task, request) }
            try? await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("the approval never became pending")
        fatalError("unreachable")
    }

    func testAnApprovalAnsweredAfterTwentyMinutesIsStillGood() async {
        let clock = Clock()
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges, now: { clock.now })
        let digest = Digests.sha256Hex("write notes")
        let (task, request) = await pendingApproval(coordinator, digest: digest)

        clock.advance(minutes: 20)
        let parked = await coordinator.sweepExpired()
        XCTAssertEqual(parked.map(\.id), [request.id], "past its first reminder, the request is reported as parked")
        let stillPending = await coordinator.pendingApprovals
        XCTAssertEqual(stillPending.map(\.id), [request.id], "and it is still waiting, not denied")

        await coordinator.resolve(approvalID: request.id, decision: .approved)
        let outcome = await task.value
        guard case let .approved(approved) = outcome else {
            return XCTFail("a parked approval answered later must carry the action out, got \(outcome)")
        }
        XCTAssertEqual(approved.actionDigest, digest, "bound to the digest it was asked about")
        XCTAssertEqual(approved.id, request.id)
        XCTAssertTrue(
            approved.authorizes(digest: digest, at: clock.now),
            "the approval is good from the moment it was given"
        )
        XCTAssertFalse(approved.authorizes(digest: Digests.sha256Hex("something else"), at: clock.now))
    }

    func testRemindersDueAtFifteenSixtyAndTwoHundredFortyMinutesNeverDeny() async {
        let clock = Clock()
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges, now: { clock.now })
        let (task, request) = await pendingApproval(coordinator, digest: Digests.sha256Hex("x"))
        for minutes in [15.0, 45, 180, 600] {
            clock.advance(minutes: minutes)
            _ = await coordinator.sweepExpired()
            let pending = await coordinator.pendingApprovals
            XCTAssertEqual(pending.map(\.id), [request.id])
        }
        await coordinator.resolve(approvalID: request.id, decision: .denied)
        let outcome = await task.value
        XCTAssertEqual(outcome, .denied(reason: "The user declined this action."))
    }

    func testAParkedApprovalStillFailsClosedWhenTheRunStops() async {
        let clock = Clock()
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges, now: { clock.now })
        let (task, _) = await pendingApproval(coordinator, digest: Digests.sha256Hex("y"))
        clock.advance(minutes: 90)
        await coordinator.denyAll(reason: "The run was stopped.")
        let outcome = await task.value
        XCTAssertEqual(outcome, .denied(reason: "The run was stopped."))
    }

    func testLoweringTheModeRevokesAParkedApproval() async {
        let clock = Clock()
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .workspaceWrite, now: { clock.now })
        let (task, request) = await pendingApproval(coordinator, digest: Digests.sha256Hex("z"), risk: .execute)
        clock.advance(minutes: 30)
        await coordinator.setMode(.readOnly)
        await coordinator.resolve(approvalID: request.id, decision: .approved)
        let outcome = await task.value
        guard case .denied = outcome else {
            return XCTFail("autonomy never widens: a lowered mode revokes even a parked approval, got \(outcome)")
        }
    }
}
