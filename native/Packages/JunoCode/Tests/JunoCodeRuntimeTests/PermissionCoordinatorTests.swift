import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

final class PermissionCoordinatorTests: XCTestCase {
    private let sessionID = CodeSessionID()

    private nonisolated static func digest(_ seed: String) -> String {
        Digests.sha256Hex(seed)
    }

    func testAllowedActionsPassWithoutSuspension() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .workspaceWrite)
        let outcome = await coordinator.authorize(
            toolName: "write_file",
            actionDigest: Self.digest("a"),
            risk: .write,
            summary: "Write a file"
        )
        XCTAssertEqual(outcome, .allowed)
    }

    func testReadOnlyModeDeniesWrites() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .readOnly)
        let outcome = await coordinator.authorize(
            toolName: "write_file",
            actionDigest: Self.digest("a"),
            risk: .write,
            summary: "Write a file"
        )
        guard case .denied = outcome else {
            return XCTFail("expected denial, got \(outcome)")
        }
    }

    func testApprovalSuspendsUntilApproved() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        let requested = expectation(description: "approval requested")
        nonisolated(unsafe) var requestID: String?
        await coordinator.addObserver { update in
            if case let .requested(request) = update {
                requestID = request.id
                requested.fulfill()
            }
        }
        let actionDigest = Self.digest("write")
        let authorization = Task {
            await coordinator.authorize(
                toolName: "write_file",
                actionDigest: actionDigest,
                risk: .write,
                summary: "Write src/main.swift"
            )
        }
        await fulfillment(of: [requested], timeout: 5)
        // The tool must still be suspended.
        let pendingCount = await coordinator.pendingApprovals.count
        XCTAssertEqual(pendingCount, 1)
        await coordinator.resolve(approvalID: requestID!, decision: .approved)
        let outcome = await authorization.value
        guard case let .approved(request) = outcome else {
            return XCTFail("expected approval, got \(outcome)")
        }
        XCTAssertTrue(request.authorizes(digest: actionDigest, at: Date()))
        let remaining = await coordinator.pendingApprovals.count
        XCTAssertEqual(remaining, 0)
    }

    /// Resolving one of several approvals must leave the rest pending.
    ///
    /// The orchestrator's observer used to clear `hasPendingApproval` and flip the
    /// session's status from `.waitingForApproval` back to `.running` on the *first*
    /// resolution, so a turn that gated two tool calls reported itself as working
    /// while it was still blocked on the reader — the remaining card was still
    /// drawn, but the sidebar's waiting marker was gone. This pins the fact the
    /// orchestrator now reads: the coordinator still holds the others.
    func testResolvingOneApprovalLeavesTheOthersPending() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        let bothRequested = expectation(description: "both approvals requested")
        bothRequested.expectedFulfillmentCount = 2
        // Two separate optionals rather than an array, keyed off the summary: a
        // subscript read of a `nonisolated(unsafe)` array across an await is a
        // pattern Swift 6's region-based isolation checker rejects outright.
        nonisolated(unsafe) var firstID: String?
        nonisolated(unsafe) var secondID: String?
        await coordinator.addObserver { update in
            if case let .requested(request) = update {
                if request.summary.contains("a.swift") {
                    firstID = request.id
                } else {
                    secondID = request.id
                }
                bothRequested.fulfill()
            }
        }
        // Hoisted, as the other tests in this file do: computing the digest inside
        // the `Task` closure is what the isolation checker cannot reason about.
        let firstDigest = Self.digest("one")
        let secondDigest = Self.digest("two")
        let first = Task {
            await coordinator.authorize(
                toolName: "write_file",
                actionDigest: firstDigest,
                risk: .write,
                summary: "Write a.swift"
            )
        }
        let second = Task {
            await coordinator.authorize(
                toolName: "write_file",
                actionDigest: secondDigest,
                risk: .write,
                summary: "Write b.swift"
            )
        }
        await fulfillment(of: [bothRequested], timeout: 5)

        let pendingBefore = await coordinator.pendingApprovals.count
        XCTAssertEqual(pendingBefore, 2)

        await coordinator.resolve(approvalID: firstID!, decision: .approved)
        let pendingAfterOne = await coordinator.pendingApprovals.count
        XCTAssertEqual(
            pendingAfterOne, 1,
            "one resolution must not clear the other — the run is still blocked"
        )

        await coordinator.resolve(approvalID: secondID!, decision: .approved)
        let pendingAtEnd = await coordinator.pendingApprovals.count
        XCTAssertEqual(pendingAtEnd, 0)
        _ = await first.value
        _ = await second.value
    }

    func testDenialResumesCleanly() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        let requested = expectation(description: "approval requested")
        nonisolated(unsafe) var requestID: String?
        await coordinator.addObserver { update in
            if case let .requested(request) = update {
                requestID = request.id
                requested.fulfill()
            }
        }
        let commandDigest = Self.digest("cmd")
        let authorization = Task {
            await coordinator.authorize(
                toolName: "run_command",
                actionDigest: commandDigest,
                risk: .execute,
                summary: "Run tests"
            )
        }
        await fulfillment(of: [requested], timeout: 5)
        await coordinator.resolve(approvalID: requestID!, decision: .denied)
        let outcome = await authorization.value
        guard case .denied = outcome else {
            return XCTFail("expected denial, got \(outcome)")
        }
    }

    /// The one rule that sits above the mode ladder.
    ///
    /// This used to assert the same thing about `critical`, which was the bug the
    /// tier split fixed: `critical` had to cover both "installs a dependency" and
    /// "reconfigures the machine", so gating it everywhere meant full access
    /// stopped for ordinary work. `destructive` is now the tier no mode waives,
    /// and this test guards that — nothing in the app may grant silent permission
    /// to step outside the granted workspace.
    func testDestructiveRequiresApprovalEvenInFullAccess() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let requested = expectation(description: "approval requested")
        nonisolated(unsafe) var requestID: String?
        await coordinator.addObserver { update in
            if case let .requested(request) = update {
                requestID = request.id
                requested.fulfill()
            }
        }
        let escapingDigest = Self.digest("rm")
        let authorization = Task {
            await coordinator.authorize(
                toolName: "run_command",
                actionDigest: escapingDigest,
                risk: .destructive,
                summary: "Change ownership of a file"
            )
        }
        await fulfillment(of: [requested], timeout: 5)
        await coordinator.resolve(approvalID: requestID!, decision: .approved)
        let outcome = await authorization.value
        guard case .approved = outcome else {
            return XCTFail("expected approval flow, got \(outcome)")
        }
    }

    func testDenyAllFailsClosed() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        let requested = expectation(description: "two approvals requested")
        requested.expectedFulfillmentCount = 2
        await coordinator.addObserver { update in
            if case .requested = update {
                requested.fulfill()
            }
        }
        let firstDigest = Self.digest("1")
        let secondDigest = Self.digest("2")
        let first = Task {
            await coordinator.authorize(
                toolName: "write_file",
                actionDigest: firstDigest,
                risk: .write,
                summary: "One"
            )
        }
        let second = Task {
            await coordinator.authorize(
                toolName: "write_file",
                actionDigest: secondDigest,
                risk: .write,
                summary: "Two"
            )
        }
        await fulfillment(of: [requested], timeout: 5)
        await coordinator.denyAll()
        for outcome in [await first.value, await second.value] {
            guard case .denied = outcome else {
                return XCTFail("expected denial, got \(outcome)")
            }
        }
    }

    func testExpirySweepDeniesStaleApprovals() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        let requested = expectation(description: "approval requested")
        await coordinator.addObserver { update in
            if case .requested = update {
                requested.fulfill()
            }
        }
        let staleDigest = Self.digest("stale")
        let authorization = Task {
            await coordinator.authorize(
                toolName: "write_file",
                actionDigest: staleDigest,
                risk: .write,
                summary: "Stale"
            )
        }
        await fulfillment(of: [requested], timeout: 5)
        // Far-future sweep: everything pending is expired.
        await coordinator.sweepExpired(now: Date().addingTimeInterval(24 * 3_600))
        let outcome = await authorization.value
        guard case .denied = outcome else {
            return XCTFail("expected denial, got \(outcome)")
        }
    }

    func testModeChangeTakesEffect() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .readOnly)
        await coordinator.setMode(.fullAccess)
        let outcome = await coordinator.authorize(
            toolName: "run_command",
            actionDigest: Self.digest("x"),
            risk: .execute,
            summary: "Run"
        )
        XCTAssertEqual(outcome, .allowed)
    }

    func testAuthorityReductionRevokesPendingApproval() async {
        let coordinator = PermissionCoordinator(
            sessionID: sessionID,
            mode: .askBeforeChanges
        )
        let requested = expectation(description: "approval requested")
        await coordinator.addObserver { update in
            if case .requested = update {
                requested.fulfill()
            }
        }
        async let authorization = coordinator.authorize(
            toolName: "write_file",
            actionDigest: Self.digest("mode-reduction"),
            risk: .write,
            summary: "Write a file"
        )
        await fulfillment(of: [requested], timeout: 5)

        await coordinator.setMode(.readOnly)

        let outcome = await authorization
        XCTAssertEqual(
            outcome,
            .denied(reason: "The permission mode changed before the action ran.")
        )
        let pendingCount = await coordinator.pendingApprovals.count
        XCTAssertEqual(pendingCount, 0)
    }

    func testAuthorityReductionRevokesDestructiveApprovalStillGatedInNewMode() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let requested = expectation(description: "destructive approval requested")
        await coordinator.addObserver { update in
            if case .requested = update {
                requested.fulfill()
            }
        }
        async let authorization = coordinator.authorize(
            toolName: "run_command",
            actionDigest: Self.digest("destructive-mode-reduction"),
            risk: .destructive,
            summary: "Kill a process"
        )
        await fulfillment(of: [requested], timeout: 5)

        // Destructive actions require approval in both modes, but the old request
        // was made inside a broader authority envelope and must not survive it.
        await coordinator.setMode(.workspaceWrite)

        let outcome = await authorization
        XCTAssertEqual(
            outcome,
            .denied(reason: "The permission mode changed before the action ran.")
        )
        let pendingCount = await coordinator.pendingApprovals.count
        XCTAssertEqual(pendingCount, 0)
    }
}
