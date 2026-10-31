import XCTest
@testable import JunoScreenControl

/// Which floor reasons Full access in Code waives (2026-10-31): sending and
/// deleting go ahead, money, signing in, granting, System Settings and
/// credentials still ask in every mode.
final class FloorFullAccessWaiverTests: XCTestCase {
    func testSendingAndDeletingAreWaived() {
        XCTAssertTrue(FloorReason.consequentialControl("send").waivedByFullAccess)
        XCTAssertTrue(FloorReason.consequentialControl("delete").waivedByFullAccess)
        XCTAssertTrue(FloorReason.consequentialControl("supprimer").waivedByFullAccess)
        XCTAssertTrue(FloorReason.sendsMessage.waivedByFullAccess)
    }

    func testMoneyConsentAndTheSystemAreNot() {
        for word in ["pay", "buy", "transfer", "checkout", "sign in", "allow", "install", "accept", "empty trash", "virement"] {
            XCTAssertFalse(FloorReason.consequentialControl(word).waivedByFullAccess, word)
        }
        XCTAssertFalse(FloorReason.financeApp.waivedByFullAccess)
        XCTAssertFalse(FloorReason.credentialText.waivedByFullAccess)
        XCTAssertFalse(FloorReason.systemSettings.waivedByFullAccess)
        XCTAssertFalse(FloorReason.pressAfterTab.waivedByFullAccess)
    }

    func testEveryWaivableWordIsAFloorWord() {
        XCTAssertTrue(ConsequentialActionFloor.waivableWords.isSubset(of: Set(ConsequentialActionFloor.words)))
    }

    /// "Send payment" must be read as paying, not as sending, or Full access
    /// would go ahead on it.
    func testAControlThatAlsoPaysIsReportedByTheWordThatStillAsks() {
        XCTAssertEqual(ConsequentialActionFloor.matchingWord(in: ["Send payment"]), "payment")
        XCTAssertEqual(ConsequentialActionFloor.matchingWord(in: ["Envoyer le paiement"]), "paiement")
        XCTAssertEqual(ConsequentialActionFloor.matchingWord(in: ["Send and pay"]), "pay")
        XCTAssertEqual(ConsequentialActionFloor.matchingWord(in: ["Send", "Pay now"]), "pay")
        XCTAssertEqual(ConsequentialActionFloor.matchingWord(in: ["Empty Trash"]), "empty trash")
        XCTAssertEqual(ConsequentialActionFloor.matchingWord(in: ["Send"]), "send")
        XCTAssertNil(ConsequentialActionFloor.matchingWord(in: ["Open"]))
    }

    func testTheCardOnlyPromisesWhatHolds() {
        XCTAssertFalse(FloorReason.consequentialControl("send").explanation.contains("Full access"))
        XCTAssertFalse(FloorReason.sendsMessage.explanation.contains("Full access"))
        XCTAssertTrue(FloorReason.consequentialControl("pay").explanation.contains("even in Full access"))
    }
}
