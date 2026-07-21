import XCTest
@testable import JunoCodeCore

final class PermissionModelTests: XCTestCase {
    func testCriticalActionsAlwaysRequireApproval() {
        for mode in PermissionMode.allCases {
            XCTAssertEqual(
                PermissionPolicy.ruling(mode: mode, risk: .critical),
                .requireApproval,
                "mode \(mode) must gate critical actions"
            )
        }
    }

    func testReadOnlyModeDeniesMutations() {
        XCTAssertEqual(PermissionPolicy.ruling(mode: .readOnly, risk: .read), .allow)
        XCTAssertEqual(
            PermissionPolicy.ruling(mode: .readOnly, risk: .write),
            .deny(reason: "The session is read-only.")
        )
        XCTAssertEqual(
            PermissionPolicy.ruling(mode: .readOnly, risk: .execute),
            .deny(reason: "The session is read-only.")
        )
    }

    func testAskModeRequiresApprovalForWritesAndCommands() {
        XCTAssertEqual(PermissionPolicy.ruling(mode: .askBeforeChanges, risk: .read), .allow)
        XCTAssertEqual(PermissionPolicy.ruling(mode: .askBeforeChanges, risk: .write), .requireApproval)
        XCTAssertEqual(PermissionPolicy.ruling(mode: .askBeforeChanges, risk: .execute), .requireApproval)
    }

    func testWorkspaceWriteAllowsEditsButGatesCommands() {
        XCTAssertEqual(PermissionPolicy.ruling(mode: .workspaceWrite, risk: .write), .allow)
        XCTAssertEqual(PermissionPolicy.ruling(mode: .workspaceWrite, risk: .execute), .requireApproval)
    }

    func testFullAccessAllowsNonCriticalActions() {
        XCTAssertEqual(PermissionPolicy.ruling(mode: .fullAccess, risk: .read), .allow)
        XCTAssertEqual(PermissionPolicy.ruling(mode: .fullAccess, risk: .write), .allow)
        XCTAssertEqual(PermissionPolicy.ruling(mode: .fullAccess, risk: .execute), .allow)
    }

    func testRiskOrdering() {
        XCTAssertLessThan(ActionRisk.read, .write)
        XCTAssertLessThan(ActionRisk.write, .execute)
        XCTAssertLessThan(ActionRisk.execute, .critical)
    }

    func testApprovalBindsDigestAndExpiry() {
        let now = Date(timeIntervalSince1970: 1_000)
        let request = ApprovalRequest(
            sessionID: CodeSessionID(),
            actionDigest: String(repeating: "a", count: 64),
            toolName: "write_file",
            summary: "Write README.md",
            risk: .write,
            requestedAt: now,
            expiresAt: now.addingTimeInterval(300)
        )
        XCTAssertTrue(request.authorizes(digest: String(repeating: "a", count: 64), at: now))
        XCTAssertFalse(request.authorizes(digest: String(repeating: "b", count: 64), at: now))
        XCTAssertFalse(
            request.authorizes(
                digest: String(repeating: "a", count: 64),
                at: now.addingTimeInterval(301)
            )
        )
    }
}
