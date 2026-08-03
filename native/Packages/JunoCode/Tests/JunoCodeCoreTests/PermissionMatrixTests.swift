import XCTest
@testable import JunoCodeCore

/// The complete mode × risk × approval-policy matrix, written out rather than
/// derived, so a change to the policy has to change a table a reader can check
/// against the modes' own descriptions.
///
/// The defect that motivated the third axis: `run_tests` documented that "the
/// exact command always requires approval" and returned `.critical` to try to
/// get it, but `.critical` is exactly the tier Full Access exists to let
/// through. The promise was false in the one mode where running arbitrary
/// repository-authored code unseen matters most.
final class PermissionMatrixTests: XCTestCase {
    private func assertRuling(
        _ mode: PermissionMode,
        _ risk: ActionRisk,
        _ policy: ApprovalPolicy,
        _ expected: PermissionRuling,
        line: UInt = #line
    ) {
        let actual = PermissionPolicy.ruling(mode: mode, risk: risk, approvalPolicy: policy)
        switch (actual, expected) {
        case (.allow, .allow), (.requireApproval, .requireApproval), (.deny, .deny):
            break
        default:
            XCTFail(
                "\(mode) × \(risk) × \(policy): expected \(expected), got \(actual)",
                line: line
            )
        }
    }

    // MARK: - The risk ladder

    func testReadOnlyAllowsOnlyReadsAndRefusesTheRest() {
        assertRuling(.readOnly, .read, .byRisk, .allow)
        for risk in ActionRisk.allCases where risk != .read {
            assertRuling(.readOnly, risk, .byRisk, .deny(reason: ""))
        }
    }

    func testAskBeforeChangesAllowsReadsAndAsksForEverythingElse() {
        assertRuling(.askBeforeChanges, .read, .byRisk, .allow)
        for risk in ActionRisk.allCases where risk != .read {
            assertRuling(.askBeforeChanges, risk, .byRisk, .requireApproval)
        }
    }

    func testWorkspaceWriteAllowsEditsAndAsksBeforeRunningAnything() {
        assertRuling(.workspaceWrite, .read, .byRisk, .allow)
        assertRuling(.workspaceWrite, .write, .byRisk, .allow)
        assertRuling(.workspaceWrite, .execute, .byRisk, .requireApproval)
        assertRuling(.workspaceWrite, .critical, .byRisk, .requireApproval)
        assertRuling(.workspaceWrite, .destructive, .byRisk, .requireApproval)
    }

    func testFullAccessProceedsUpToTheWorkspaceBoundaryAndStopsAtIt() {
        for risk in ActionRisk.allCases where risk != .destructive {
            assertRuling(.fullAccess, risk, .byRisk, .allow)
        }
        assertRuling(.fullAccess, .destructive, .byRisk, .requireApproval)
    }

    /// The one rule that sits above the ladder: leaving the granted workspace
    /// always asks, so no setting anywhere can grant it silently.
    func testDestructiveNeverProceedsSilentlyInAnyMode() {
        for mode in PermissionMode.allCases {
            let ruling = PermissionPolicy.ruling(mode: mode, risk: .destructive)
            XCTAssertNotEqual(
                ruling,
                .allow,
                "\(mode) allowed a destructive action without asking"
            )
        }
    }

    // MARK: - The approval pin

    /// The fix, stated as the matrix row it changes: pinned tools ask in every
    /// mode that would otherwise have let them through silently.
    func testPinningAlwaysAsksWhereverTheLadderWouldHaveAllowed() {
        for mode in PermissionMode.allCases {
            for risk in ActionRisk.allCases {
                let ladder = PermissionPolicy.ruling(mode: mode, risk: risk)
                let pinned = PermissionPolicy.ruling(
                    mode: mode,
                    risk: risk,
                    approvalPolicy: .alwaysRequiresApproval
                )
                switch ladder {
                case .deny:
                    // A refusal outranks the pin.
                    XCTAssertEqual(pinned, ladder, "\(mode) × \(risk) turned a refusal into a prompt")
                case .allow, .requireApproval:
                    XCTAssertEqual(
                        pinned,
                        .requireApproval,
                        "\(mode) × \(risk) let a pinned action through"
                    )
                }
            }
        }
    }

    /// Full Access is the mode the old encoding got wrong, so it gets its own
    /// named case rather than only being covered by the sweep above.
    func testFullAccessStillAsksForAPinnedCriticalAction() {
        assertRuling(.fullAccess, .critical, .byRisk, .allow)
        assertRuling(.fullAccess, .critical, .alwaysRequiresApproval, .requireApproval)
    }

    /// Read-only must refuse, not offer a prompt whose "approve" button would
    /// carry the action out — the mode's single promise is that nothing runs.
    func testReadOnlyRefusesAPinnedActionRatherThanOfferingABypass() {
        assertRuling(.readOnly, .critical, .alwaysRequiresApproval, .deny(reason: ""))
        assertRuling(.readOnly, .execute, .alwaysRequiresApproval, .deny(reason: ""))
        assertRuling(.readOnly, .destructive, .alwaysRequiresApproval, .deny(reason: ""))
    }

    /// Pinning is about being seen, not about authority: it never turns a read
    /// a mode already permits into something that needs a decision it did not
    /// need before... except that being seen is the whole point, so a pinned
    /// read does ask. Stated explicitly so the choice is deliberate.
    func testAPinnedReadAsksEvenThoughEveryModeAllowsReads() {
        assertRuling(.fullAccess, .read, .byRisk, .allow)
        assertRuling(.fullAccess, .read, .alwaysRequiresApproval, .requireApproval)
        assertRuling(.readOnly, .read, .alwaysRequiresApproval, .requireApproval)
    }

    /// The default must stay `byRisk`, or every tool silently becomes a prompt.
    func testTheDefaultPolicyIsTheLadder() {
        for mode in PermissionMode.allCases {
            for risk in ActionRisk.allCases {
                XCTAssertEqual(
                    PermissionPolicy.ruling(mode: mode, risk: risk),
                    PermissionPolicy.ruling(mode: mode, risk: risk, approvalPolicy: .byRisk)
                )
            }
        }
    }
}
