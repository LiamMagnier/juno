import XCTest
@testable import JunoVoiceKit

/// The mapping from what the microphone measures to what the screen shows.
///
/// This is the whole reason the voice field looked inert while someone was
/// talking. Loudness was `rms * 4`, clamped — and conversational speech lands
/// around 0.02–0.08 RMS, so a normal voice spent its entire range in the bottom
/// third of the scale and every syllable moved the light by a few percent.
/// Hearing is logarithmic; the meter has to be too.
final class JunoVoiceLoudnessTests: XCTestCase {

    private func loudness(_ rms: Double) -> Double {
        JunoRealtimeVoiceController.loudness(rms)
    }

    func testSilenceIsZeroAndNeverNegative() {
        XCTAssertEqual(loudness(0), 0)
        // −60 dBFS: room tone, not speech.
        XCTAssertEqual(loudness(0.001), 0)
    }

    /// The failure this replaced, stated as a number: ordinary speech has to
    /// reach a substantial part of the range, not a sliver of it.
    func testOrdinarySpeechUsesMostOfTheRange() {
        // ≈ −34 dBFS — someone talking normally at a laptop.
        let ordinary = loudness(0.02)
        XCTAssertGreaterThan(ordinary, 0.4, "a normal voice must visibly move the field")
        XCTAssertLessThan(ordinary, 0.8, "and must still leave headroom above it")

        // The old mapping, for contrast: 0.02 * 4 = 0.08.
        XCTAssertGreaterThan(ordinary, 0.08 * 3)
    }

    /// A raised voice and a quiet one have to be visibly different, or the field
    /// is reporting "someone is talking" rather than how loudly.
    func testQuietAndLoudAreFarApart() {
        let quiet = loudness(0.006)   // ≈ −44 dBFS
        let loud = loudness(0.12)     // ≈ −18 dBFS
        XCTAssertGreaterThan(loud - quiet, 0.4)
    }

    func testItIsMonotonicAndClampedAtBothEnds() {
        var previous = -1.0
        for rms in stride(from: 0.0, through: 1.0, by: 0.01) {
            let value = loudness(rms)
            XCTAssertGreaterThanOrEqual(value, previous, "loudness went backwards at \(rms)")
            XCTAssertGreaterThanOrEqual(value, 0)
            XCTAssertLessThanOrEqual(value, 1)
            previous = value
        }
        XCTAssertEqual(loudness(1), 1, "full scale is the top of the range")
    }
}
