import Foundation
import XCTest
@testable import JunoAPI
import JunoCore

final class JunoStoreKitTests: XCTestCase {
    func testStoreKitProductIDsAreComplete() {
        let expected: Set<String> = [
            "com.liammagnier.juno.lite.monthly", "com.liammagnier.juno.lite.yearly",
            "com.liammagnier.juno.pro.monthly", "com.liammagnier.juno.pro.yearly",
            "com.liammagnier.juno.plus.monthly", "com.liammagnier.juno.plus.yearly",
            "com.liammagnier.juno.max.monthly", "com.liammagnier.juno.max.yearly",
            "com.liammagnier.juno.max20.monthly", "com.liammagnier.juno.max20.yearly",
            "com.liammagnier.juno.ultra.monthly", "com.liammagnier.juno.ultra.yearly",
        ]
        XCTAssertEqual(JunoStoreKitProductIDs.all, expected)
    }

    func testEveryPlanForSaleHasAMonthlyAndAYearlyProduct() {
        for planTier in JunoPlanTier.forSale {
            let tier = try! XCTUnwrap(JunoSubscriptionTier(planTier: planTier))
            for interval in JunoBillingInterval.allCases {
                let id = try! XCTUnwrap(JunoStoreKitProductIDs.productID(for: tier, interval: interval), "\(tier) \(interval)")
                XCTAssertEqual(JunoStoreKitProductIDs.tier(for: id), tier)
                XCTAssertTrue(id.hasSuffix(interval == .month ? ".monthly" : ".yearly"))
            }
        }
        XCTAssertNil(JunoStoreKitProductIDs.productID(for: .free, interval: .month))
    }

    func testProductIDsMapToTheirOwnPlanNotASubstring() {
        // "max20" contains "max", and "plus" sits next to "pro" — an exact map, not `contains`.
        XCTAssertEqual(JunoStoreKitProductIDs.tier(for: "com.liammagnier.juno.max20.yearly"), .max20)
        XCTAssertEqual(JunoStoreKitProductIDs.tier(for: "com.liammagnier.juno.max.yearly"), .max)
        XCTAssertEqual(JunoStoreKitProductIDs.tier(for: "com.liammagnier.juno.plus.monthly"), .plus)
        XCTAssertEqual(JunoStoreKitProductIDs.tier(for: "com.liammagnier.juno.ultra.monthly"), .ultra)
        XCTAssertEqual(JunoStoreKitProductIDs.tier(for: "com.example.unknown"), .free)
    }

    func testTiersRankAsPlansDo() {
        XCTAssertEqual(JunoSubscriptionTier.allCases.map(\.rank), [0, 1, 2, 3, 4, 5, 6])
    }

    func testSubscriptionTierCodableRoundtrip() throws {
        for tier in JunoSubscriptionTier.allCases {
            let data = try JSONEncoder().encode(tier)
            let decoded = try JSONDecoder().decode(JunoSubscriptionTier.self, from: data)
            XCTAssertEqual(decoded, tier)
        }
    }

    func testStateCarriesThePlanItWasGiven() {
        XCTAssertEqual(JunoSubscriptionState(tier: .plus).plan, JunoAccountPlan(tier: .plus))
        let unknown = JunoSubscriptionState(tier: .free, isActive: true, plan: JunoAccountPlan(serverID: "TEAM"))
        XCTAssertTrue(unknown.plan.isPaid)
        XCTAssertEqual(unknown.plan.displayName, "Team")
    }

    func testInitialStateIsFreeAndInactive() async {
        let manager = JunoStoreKitManager()
        let state = await manager.currentSubscriptionState()
        XCTAssertEqual(state.tier, .free)
        XCTAssertFalse(state.isActive)
        XCTAssertNil(state.productID)
        XCTAssertNil(state.expirationDate)
    }

    func testVerifyAndSyncWithCustomBackendHandler() async throws {
        let expectedState = JunoSubscriptionState(
            tier: .pro,
            isActive: true,
            productID: JunoStoreKitProductIDs.proMonthly,
            expirationDate: Date(timeIntervalSinceNow: 3600 * 24 * 30),
            willAutoRenew: true
        )

        let manager = JunoStoreKitManager { payload in
            XCTAssertEqual(payload, "mock_jws_payload")
            return expectedState
        }

        let updated = try await manager.verifyAndSync(signedTransactionInfo: "mock_jws_payload")
        XCTAssertEqual(updated, expectedState)

        let current = await manager.currentSubscriptionState()
        XCTAssertEqual(current, expectedState)
    }

    func testConfigureServerSyncSetsProperties() async {
        let manager = JunoStoreKitManager()
        let url = URL(string: "https://api.juno.build")!
        await manager.configureServerSync(baseURL: url) {
            "test_bearer_token"
        }
        let state = await manager.currentSubscriptionState()
        XCTAssertEqual(state.tier, .free)
    }
}

