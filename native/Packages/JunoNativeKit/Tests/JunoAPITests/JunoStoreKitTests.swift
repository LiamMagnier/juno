import Foundation
import XCTest
@testable import JunoAPI

final class JunoStoreKitTests: XCTestCase {
    func testStoreKitProductIDsAreComplete() {
        XCTAssertTrue(JunoStoreKitProductIDs.all.contains("com.liammagnier.juno.pro.monthly"))
        XCTAssertTrue(JunoStoreKitProductIDs.all.contains("com.liammagnier.juno.pro.yearly"))
        XCTAssertTrue(JunoStoreKitProductIDs.all.contains("com.liammagnier.juno.max.monthly"))
        XCTAssertTrue(JunoStoreKitProductIDs.all.contains("com.liammagnier.juno.max.yearly"))
        XCTAssertTrue(JunoStoreKitProductIDs.all.contains("com.liammagnier.juno.max20.monthly"))
        XCTAssertTrue(JunoStoreKitProductIDs.all.contains("com.liammagnier.juno.max20.yearly"))
        XCTAssertEqual(JunoStoreKitProductIDs.all.count, 6)
    }

    func testSubscriptionTierCodableRoundtrip() throws {
        for tier in [JunoSubscriptionTier.free, .pro, .max, .max20] {
            let data = try JSONEncoder().encode(tier)
            let decoded = try JSONDecoder().decode(JunoSubscriptionTier.self, from: data)
            XCTAssertEqual(decoded, tier)
        }
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

