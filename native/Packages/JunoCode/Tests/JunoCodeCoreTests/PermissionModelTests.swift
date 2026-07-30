import XCTest
@testable import JunoCodeCore

final class PermissionModelTests: XCTestCase {
    /// `destructive` sits above the mode ladder: no setting in the app grants
    /// silent permission to leave the granted workspace or to do something a
    /// checkpoint cannot undo.
    ///
    /// This assertion used to be made about `critical`, which is the bug the tier
    /// split fixed — `critical` had to cover both "installs a dependency" and
    /// "reconfigures the machine", so gating the whole bucket everywhere meant a
    /// full-access session stopped to ask before most ordinary work.
    ///
    /// `readOnly` is excluded because it does something stricter than gate: it
    /// refuses outright, which is a stronger guarantee, not a weaker one.
    func testDestructiveActionsAlwaysRequireApproval() {
        for mode in PermissionMode.allCases where mode != .readOnly {
            XCTAssertEqual(
                PermissionPolicy.ruling(mode: mode, risk: .destructive),
                .requireApproval,
                "mode \(mode) must gate destructive actions"
            )
        }
        XCTAssertEqual(
            PermissionPolicy.ruling(mode: .readOnly, risk: .destructive),
            .deny(reason: "The session is read-only.")
        )
    }

    /// `critical` is the tier full access exists to stop asking about, and every
    /// lower mode still gates.
    func testCriticalIsGatedEverywhereExceptFullAccess() {
        XCTAssertEqual(PermissionPolicy.ruling(mode: .fullAccess, risk: .critical), .allow)
        XCTAssertEqual(
            PermissionPolicy.ruling(mode: .workspaceWrite, risk: .critical),
            .requireApproval
        )
        XCTAssertEqual(
            PermissionPolicy.ruling(mode: .askBeforeChanges, risk: .critical),
            .requireApproval
        )
        XCTAssertEqual(
            PermissionPolicy.ruling(mode: .readOnly, risk: .critical),
            .deny(reason: "The session is read-only.")
        )
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

    /// Full access allows every tier except the one above the ladder.
    func testFullAccessAllowsEverythingButDestructiveActions() {
        for risk in ActionRisk.allCases where risk != .destructive {
            XCTAssertEqual(
                PermissionPolicy.ruling(mode: .fullAccess, risk: risk),
                .allow,
                "full access must carry out \(risk) without asking"
            )
        }
        XCTAssertEqual(
            PermissionPolicy.ruling(mode: .fullAccess, risk: .destructive),
            .requireApproval
        )
    }

    /// `ToolRegistry` and `CommandClassifier` both reduce a pipeline to its worst
    /// segment by comparing these, so a mis-ordered rank would silently downgrade
    /// a destructive segment to whatever sat beside it.
    func testRiskOrdering() {
        XCTAssertLessThan(ActionRisk.read, .write)
        XCTAssertLessThan(ActionRisk.write, .execute)
        XCTAssertLessThan(ActionRisk.execute, .critical)
        XCTAssertLessThan(ActionRisk.critical, .destructive)
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
