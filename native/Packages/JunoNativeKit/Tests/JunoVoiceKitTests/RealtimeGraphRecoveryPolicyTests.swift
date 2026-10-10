#if canImport(AVFoundation) && canImport(Speech)
import XCTest
@testable import JunoVoiceKit

/// The iPhone call went deaf because the engine stopped itself while the call
/// was still connecting and recovery only ran once it was live.
@MainActor
final class RealtimeGraphRecoveryPolicyTests: XCTestCase {
    func testAudioIsWantedWhileConnecting() {
        XCTAssertTrue(RealtimeGraphRecoveryPolicy.wantsAudio(phase: .connecting, closedByUser: false))
        XCTAssertTrue(RealtimeGraphRecoveryPolicy.wantsAudio(phase: .live, closedByUser: false))
        XCTAssertTrue(RealtimeGraphRecoveryPolicy.wantsAudio(phase: .reconnecting, closedByUser: false))
    }

    func testNoAudioAfterTheCallOrAHangUp() {
        XCTAssertFalse(RealtimeGraphRecoveryPolicy.wantsAudio(phase: .idle, closedByUser: false))
        XCTAssertFalse(RealtimeGraphRecoveryPolicy.wantsAudio(phase: .ended(.client), closedByUser: false))
        XCTAssertFalse(RealtimeGraphRecoveryPolicy.wantsAudio(phase: .live, closedByUser: true))
    }

    func testAStoppedEngineIsRebuiltWithVoiceProcessing() {
        var policy = RealtimeGraphRecoveryPolicy()
        XCTAssertEqual(policy.decide(wantsAudio: true, engineRunning: false, now: 10), .rebuild(rawOnly: false))
    }

    func testARunningEngineIsLeftAlone() {
        var policy = RealtimeGraphRecoveryPolicy()
        XCTAssertEqual(policy.decide(wantsAudio: true, engineRunning: true, now: 10), .skip)
        XCTAssertEqual(policy.decide(wantsAudio: false, engineRunning: false, now: 10), .skip)
    }

    func testRepeatedStopsFallBackToThePlainInput() {
        var policy = RealtimeGraphRecoveryPolicy()
        XCTAssertEqual(policy.decide(wantsAudio: true, engineRunning: false, now: 10), .rebuild(rawOnly: false))
        XCTAssertEqual(policy.decide(wantsAudio: true, engineRunning: false, now: 10.5), .rebuild(rawOnly: false))
        XCTAssertEqual(policy.decide(wantsAudio: true, engineRunning: false, now: 11), .rebuild(rawOnly: true))
        // Long after, a route change gets voice processing again.
        XCTAssertEqual(policy.decide(wantsAudio: true, engineRunning: false, now: 30), .rebuild(rawOnly: false))
    }
}
#endif
