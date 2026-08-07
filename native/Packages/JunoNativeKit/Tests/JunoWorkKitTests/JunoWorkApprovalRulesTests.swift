import JunoCore
import XCTest

@testable import JunoWorkKit

final class JunoWorkApprovalRulesTests: XCTestCase {
    func testLowRiskOrdinaryActionsMayOfferAStandingGrant() {
        for risk in [JunoWorkRiskLevel.safe, .edit, .command] {
            XCTAssertTrue(
                JunoWorkApprovalRules.allowsStandingGrant(
                    action: "apply_changes",
                    risk: risk.rawValue
                ),
                risk.rawValue
            )
        }
    }

    func testSensitiveAndIrreversibleRisksNeverOfferAStandingGrant() {
        for risk in [JunoWorkRiskLevel.sensitive, .irreversible] {
            XCTAssertFalse(
                JunoWorkApprovalRules.allowsStandingGrant(
                    action: "apply_changes",
                    risk: risk.rawValue
                ),
                risk.rawValue
            )
        }
    }

    func testEveryAlwaysConfirmActionRefusesAStandingGrantWhenMisgradedSafe() {
        for action in JunoWorkAlwaysConfirmAction.allCases {
            XCTAssertFalse(
                JunoWorkApprovalRules.allowsStandingGrant(
                    action: action.rawValue,
                    risk: JunoWorkRiskLevel.safe.rawValue
                ),
                action.rawValue
            )
        }
    }

    func testUnknownRiskFailsClosed() {
        XCTAssertFalse(
            JunoWorkApprovalRules.allowsStandingGrant(
                action: "apply_changes",
                risk: "new-risk-from-a-newer-executor"
            )
        )
    }
}
