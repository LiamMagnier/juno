import XCTest
@testable import JunoVoiceKit

/// One microphone, one holder: a call starting must make dictation let go
/// before its graph is built, and a late teardown must not free someone
/// else's claim.
@MainActor
final class JunoMicrophoneArbiterTests: XCTestCase {
    private final class Holder {}

    func testACallMakesDictationLetGoFirst() {
        let arbiter = JunoMicrophoneArbiter()
        let dictation = Holder()
        let call = Holder()
        var dictationYielded = false
        arbiter.claim(.dictation, by: dictation) { dictationYielded = true }
        XCTAssertEqual(arbiter.owner, .dictation)

        arbiter.claim(.voiceCall, by: call) { XCTFail("the new holder must not yield") }
        XCTAssertTrue(dictationYielded)
        XCTAssertEqual(arbiter.owner, .voiceCall)
        XCTAssertTrue(arbiter.isHeld(by: call))
    }

    func testTheYieldSeesTheMicrophoneAlreadyFree() {
        let arbiter = JunoMicrophoneArbiter()
        let dictation = Holder()
        var ownerDuringYield: JunoMicrophoneArbiter.Owner? = .dictation
        arbiter.claim(.dictation, by: dictation) {
            ownerDuringYield = arbiter.owner
            // Teardown releases from inside the yield; that must be harmless.
            arbiter.release(by: dictation)
        }
        arbiter.claim(.voiceCall, by: Holder()) {}
        XCTAssertNil(ownerDuringYield)
        XCTAssertEqual(arbiter.owner, .voiceCall)
    }

    func testReclaimingAsTheSameHolderDoesNotYield() {
        let arbiter = JunoMicrophoneArbiter()
        let call = Holder()
        var yields = 0
        arbiter.claim(.voiceCall, by: call) { yields += 1 }
        // A route-change rebuild claims again.
        arbiter.claim(.voiceCall, by: call) { yields += 1 }
        XCTAssertEqual(yields, 0)
    }

    func testALateReleaseCannotFreeAnotherHoldersClaim() {
        let arbiter = JunoMicrophoneArbiter()
        let dictation = Holder()
        let call = Holder()
        arbiter.claim(.dictation, by: dictation) {}
        arbiter.claim(.voiceCall, by: call) {}
        arbiter.release(by: dictation)
        XCTAssertEqual(arbiter.owner, .voiceCall)
        arbiter.release(by: call)
        XCTAssertNil(arbiter.owner)
    }
}
