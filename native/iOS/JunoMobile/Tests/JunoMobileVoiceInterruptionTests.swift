import XCTest
@testable import JunoMobile

/// The interruption rules that keep an iPhone call hearing and speaking. See
/// ``JunoMobileVoiceInterruptionPolicy``.
final class JunoMobileVoiceInterruptionTests: XCTestCase {
  private func action(
    began: Bool, suspended: Bool = false, interrupted: Bool = false, mutedBefore: Bool = false
  ) -> JunoMobileVoiceInterruptionPolicy.Action {
    JunoMobileVoiceInterruptionPolicy.action(
      began: began, wasSuspended: suspended, interrupted: interrupted, mutedBefore: mutedBefore
    )
  }

  func testARealInterruptionPausesTheCall() {
    XCTAssertEqual(action(began: true), .pause)
  }

  /// The spurious "began" iOS reports for something that happened while the
  /// app was suspended must not mute a live call.
  func testABeganThatWasSuspendedIsIgnored() {
    XCTAssertEqual(action(began: true, suspended: true), .ignore)
  }

  func testASecondBeganIsIgnored() {
    XCTAssertEqual(action(began: true, interrupted: true), .ignore)
  }

  /// The end always brings audio back, whether or not iOS says
  /// `shouldResume`: the engine was stopped and nothing else restarts it.
  func testEndResumesAndUnmutesWhatTheInterruptionMuted() {
    XCTAssertEqual(action(began: false, interrupted: true, mutedBefore: false), .resume(unmute: true))
  }

  func testEndKeepsADeliberateMute() {
    XCTAssertEqual(action(began: false, interrupted: true, mutedBefore: true), .resume(unmute: false))
  }

  /// An end with no begin we acted on (the ignored, suspended one) still
  /// restarts the audio, but leaves the microphone as the reader set it.
  func testAnEndWithoutABeganRestartsAudioOnly() {
    XCTAssertEqual(action(began: false, interrupted: false), .resume(unmute: false))
  }
}
