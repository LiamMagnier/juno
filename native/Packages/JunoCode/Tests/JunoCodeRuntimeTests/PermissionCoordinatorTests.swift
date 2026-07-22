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

    func testCriticalRequiresApprovalEvenInFullAccess() async {
        let coordinator = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let requested = expectation(description: "approval requested")
        nonisolated(unsafe) var requestID: String?
        await coordinator.addObserver { update in
            if case let .requested(request) = update {
                requestID = request.id
                requested.fulfill()
            }
        }
        let deleteDigest = Self.digest("rm")
        let authorization = Task {
            await coordinator.authorize(
                toolName: "delete_file",
                actionDigest: deleteDigest,
                risk: .critical,
                summary: "Delete a file"
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
}
