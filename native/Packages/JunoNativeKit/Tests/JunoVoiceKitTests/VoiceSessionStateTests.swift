import XCTest
@testable import JunoVoiceKit

final class VoiceSessionStateTests: XCTestCase {
    func testHappyPathReachesSpeakingAndStops() throws {
        var state = VoiceSessionState()
        try state.apply(.start)
        XCTAssertEqual(state.phase, .requestingPermission)
        try state.apply(.permissionResolved(granted: true))
        try state.apply(.captureReady)
        try state.apply(.userFinishedSpeaking)
        try state.apply(.playbackReady)
        XCTAssertEqual(state.phase, .speaking)
        try state.apply(.stop)
        XCTAssertEqual(state.phase, .idle)
    }

    func testInterruptionCanResumePreviousPhase() throws {
        var state = VoiceSessionState(permission: .granted)
        try state.apply(.start)
        try state.apply(.captureReady)
        try state.apply(.interruptionBegan)
        XCTAssertEqual(state.phase, .interrupted)
        try state.apply(.interruptionEnded(shouldResume: true))
        XCTAssertEqual(state.phase, .listening)
    }

    func testDeniedPermissionFailsClosed() throws {
        var state = VoiceSessionState(permission: .denied)
        XCTAssertThrowsError(try state.apply(.start)) {
            XCTAssertEqual($0 as? VoiceSessionTransitionError, .permissionDenied)
        }
        XCTAssertEqual(state.phase, .idle)
    }
}
