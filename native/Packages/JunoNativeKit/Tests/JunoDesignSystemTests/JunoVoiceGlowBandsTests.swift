import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// With real bands, the glow's lobes move independently: a vowel swells the
/// centre, a sibilant the edges. Without them, the old synthesised shape.
final class JunoVoiceGlowBandsTests: XCTestCase {
    private let palette = JunoVoiceGlowPalette.palette(for: .juno, dark: true)

    /// Runs the engine for half a second at 60 fps on steady input.
    private func settle(level: Double, bands: JunoVoiceGlowBands?) -> JunoVoiceGlowFrame {
        let engine = JunoVoiceGlowEngine()
        let start = Date(timeIntervalSinceReferenceDate: 0)
        var frame = engine.step(to: start, level: level, bands: bands, processing: false, still: false, palette: palette)
        for tick in 1...30 {
            frame = engine.step(
                to: start.addingTimeInterval(Double(tick) / 60),
                level: level, bands: bands, processing: false, still: false, palette: palette
            )
        }
        return frame
    }

    func testVowelSwellsTheCentreMoreThanTheEdges() {
        let frame = settle(level: 0.7, bands: JunoVoiceGlowBands(low: 0.9, mid: 0.5, high: 0.05))
        XCTAssertGreaterThan(frame.lobes[0], frame.lobes[5] + 0.3)
        XCTAssertLessThan(frame.lean, 0, "the crest leans back toward the lows")
    }

    func testSibilantLiftsTheEdgesAboveASilentCentre() {
        let vowel = settle(level: 0.6, bands: JunoVoiceGlowBands(low: 0.9, mid: 0.4, high: 0.05))
        let sibilant = settle(level: 0.6, bands: JunoVoiceGlowBands(low: 0.05, mid: 0.2, high: 0.95))
        XCTAssertGreaterThan(sibilant.lobes[5], vowel.lobes[5] + 0.3, "an 's' flicks the outer lobes")
        XCTAssertLessThan(sibilant.lobes[0], vowel.lobes[0], "and the centre drops back")
        XCTAssertGreaterThan(sibilant.lean, 0)
    }

    func testWithoutBandsTheShapeIsTheLevelTimesTheFixedGain() {
        let frame = settle(level: 0.8, bands: nil)
        XCTAssertEqual(frame.articulated, 0, accuracy: 0.001)
        for (index, gain) in JunoVoiceGlowEngine.lobeGain.enumerated() {
            XCTAssertEqual(frame.lobes[index], frame.lit * gain, accuracy: 0.001)
        }
    }

    func testThinkingGathersBackToTheSynthesisedShape() {
        let engine = JunoVoiceGlowEngine()
        let start = Date(timeIntervalSinceReferenceDate: 0)
        let bands = JunoVoiceGlowBands(low: 0, mid: 0, high: 1)
        var frame = engine.step(to: start, level: 0.5, bands: bands, processing: true, still: false, palette: palette)
        for tick in 1...120 {
            frame = engine.step(to: start.addingTimeInterval(Double(tick) / 60), level: 0.5, bands: bands, processing: true, still: false, palette: palette)
        }
        XCTAssertLessThan(frame.articulated, 0.01, "the travelling beam is not level-driven")
    }
}
