import JunoCore
import XCTest

@testable import JunoWorkKit

final class NativeAgentComputerAccessTests: XCTestCase {
    func testAccessDenialKeepsTheServersExplanationAndUpgradePlan() {
        let access = NativeAgentsClient.decodeComputerAccess(.object([
            "ok": .bool(false), "reason": .string("plan"),
            "message": .string("Computers come with Pro and above."), "upgradePlan": .string("PRO"),
        ]))
        XCTAssertEqual(access, NativeAgentComputerAccess(ok: false, reason: "plan", message: "Computers come with Pro and above.", upgradePlan: "PRO"))
    }

    func testOlderServersAndMalformedVerdictsDoNotInventAnAccessDecision() {
        XCTAssertNil(NativeAgentsClient.decodeComputerAccess(nil))
        XCTAssertNil(NativeAgentsClient.decodeComputerAccess(.null))
        XCTAssertNil(NativeAgentsClient.decodeComputerAccess(.object(["ok": .string("true")])))
        XCTAssertNil(NativeAgentComputerReading().access)
    }

    func testPositiveAccessNeedsNoRefusalFields() {
        XCTAssertEqual(NativeAgentsClient.decodeComputerAccess(.object(["ok": .bool(true)])), NativeAgentComputerAccess(ok: true))
    }
}
