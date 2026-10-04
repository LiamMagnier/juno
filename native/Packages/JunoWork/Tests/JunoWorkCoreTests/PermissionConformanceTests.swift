import Foundation
import XCTest

@testable import JunoWorkCore

/// The shared permission contract (BRIEF §6), read by the Mac's Work runtime:
/// contracts/permissions/permission-taxonomy.v1.json. The web/server side runs
/// the same cases in tests/permission-conformance.test.ts and the cloud runner
/// in runner/agent-core/src/test/permission-conformance.test.ts.
final class PermissionConformanceTests: XCTestCase {
    private struct Expect: Decodable {
        var tier: String
        var asksUnderEveryMode: Bool
        var standing: Bool
    }

    private struct Case: Decodable {
        var runtime: String
        var action: String?
        var risk: String?
        var expect: Expect
    }

    private struct Contract: Decodable {
        var hardFloorTokens: [String: [String]]
        var runtimeRiskTiers: [String: [String: String]]
        var modes: [String: [String]]
        var cases: [Case]
    }

    private func loadContract() throws -> Contract {
        var root = URL(fileURLWithPath: #filePath)
        // Tests/JunoWorkCoreTests/<file> → Tests → JunoWork → Packages → native → repository.
        for _ in 0..<6 { root.deleteLastPathComponent() }
        let url = root.appendingPathComponent("contracts/permissions/permission-taxonomy.v1.json")
        return try JSONDecoder().decode(Contract.self, from: Data(contentsOf: url))
    }

    func testTokensAndVocabularyMatchTheContract() throws {
        let contract = try loadContract()
        XCTAssertEqual(WorkRisk.hardFloorTokens, contract.hardFloorTokens)
        XCTAssertEqual(Set(WorkRiskLevel.allCases.map(\.rawValue)), Set((contract.runtimeRiskTiers["work"] ?? [:]).keys))
        XCTAssertEqual(WorkPermissionPolicy.allCases.map(\.rawValue), contract.modes["work"])
    }

    func testEveryWorkCase() throws {
        let contract = try loadContract()
        let cases = contract.cases.filter { $0.runtime == "work" }
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let action = try XCTUnwrap(c.action)
            let risk = try XCTUnwrap(WorkRiskLevel(rawValue: c.risk ?? ""))
            XCTAssertEqual(contract.runtimeRiskTiers["work"]?[risk.rawValue], c.expect.tier, action)
            let asks = WorkPermissionPolicy.allCases.allSatisfy { policy in
                // The strongest standing answer that could exist must not silence it either.
                let allowance = WorkAlwaysAllowance(upTo: .command)
                if let irreversible = WorkIrreversibleAction(rawValue: action) {
                    return WorkRisk.ruling(policy: policy, mode: .readWrite, irreversible: irreversible, allowance: allowance) != .allow
                }
                return WorkRisk.ruling(policy: policy, risk: risk, allowance: allowance) != .allow
            }
            XCTAssertEqual(asks, c.expect.asksUnderEveryMode, "\(action): asks under every mode")
            XCTAssertEqual(WorkRisk.mayHoldStandingAllowance(action: action, risk: risk), c.expect.standing, "\(action): standing")
        }
    }
}
