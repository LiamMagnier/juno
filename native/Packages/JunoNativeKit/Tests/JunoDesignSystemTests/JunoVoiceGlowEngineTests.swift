import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// The web's `tests/voice-glow-engine.test.ts`, ported: the native light is
/// the same state model, so it answers the same questions the same way.
final class JunoVoiceGlowEngineTests: XCTestCase {
    private let dt = 1.0 / 60

    private func run(
        _ seconds: Double,
        _ mode: JunoVoiceGlowMode,
        you: Double = 0,
        alevr: Double = 0,
        reduced: Bool = false,
        from state: JunoVoiceGlowState = JunoVoiceGlowState()
    ) -> JunoVoiceGlowState {
        var state = state
        let input = JunoVoiceGlowInput(mode: mode, you: you, alevr: alevr, reduced: reduced)
        var t = 0.0
        while t < seconds {
            state.step(input, dt: dt)
            t += dt
        }
        return state
    }

    func testSilenceIsPerfectlyStill() {
        var state = run(1.5, .you, you: 0.07)
        let before = state.frame(reduced: false)
        state.step(JunoVoiceGlowInput(mode: .you, you: 0.09, alevr: 0, reduced: false), dt: dt)
        XCTAssertEqual(before, state.frame(reduced: false), "a silent frame equals the next one")
        XCTAssertEqual(state.envYou, 0)
        XCTAssertEqual(before.you.amp, JunoVoiceGlowState.restAmp, accuracy: 1e-6)
        XCTAssertEqual(before.alevr.amp, 0)
    }

    func testARoomIsNotAVoice() {
        XCTAssertEqual(JunoVoiceGlowState.gate(0), 0)
        XCTAssertEqual(JunoVoiceGlowState.gate(0.16), 0)
        XCTAssertGreaterThan(JunoVoiceGlowState.gate(0.3), 0)
        XCTAssertLessThan(JunoVoiceGlowState.gate(0.3), JunoVoiceGlowState.gate(0.6))
        XCTAssertEqual(JunoVoiceGlowState.gate(1), 1)
        XCTAssertEqual(JunoVoiceGlowState.gate(.nan), 0)
    }

    func testTalkingOverAlevrLightsBoth() {
        let frame = run(0.6, .alevr, you: 0.75, alevr: 0.7).frame(reduced: false)
        XCTAssertGreaterThan(frame.alevr.amp, 0.7)
        XCTAssertGreaterThan(frame.you.amp, 0.6)
        XCTAssertGreaterThan(frame.you.lift, 0.5)
        XCTAssertGreaterThan(frame.alevr.lift, 0.5)
    }

    func testMutedHearsNothingAndHoldsStill() {
        var state = run(1, .muted, you: 0.9)
        let frame = state.frame(reduced: false)
        XCTAssertEqual(frame.you.amp, 0)
        XCTAssertGreaterThan(frame.muted, 0.5)
        state.step(JunoVoiceGlowInput(mode: .muted, you: 0.4, alevr: 0, reduced: false), dt: dt)
        XCTAssertEqual(frame, state.frame(reduced: false))
    }

    func testOffDrawsNothing() {
        let state = run(0.3, .off, you: 0.8, from: run(1, .you, you: 0.8))
        XCTAssertTrue(state.frame(reduced: false).isDark)
    }

    func testToneStatesCrossOnTheBaseRung() {
        let state = run(JunoVoiceGlowState.Timing.base, .alevr, from: run(1, .you))
        XCTAssertGreaterThanOrEqual(state.wAlevr, 0.94)
        XCTAssertLessThanOrEqual(state.wYou, 0.06)
    }

    func testTheLightArrivesOnTheSlowRung() {
        let state = run(JunoVoiceGlowState.Timing.slow, .you)
        XCTAssertGreaterThanOrEqual(state.on, 0.94)
    }

    func testThinkingIsTheContinuumHandoff() {
        typealias T = JunoVoiceGlowState.Timing
        XCTAssertEqual(T.handoffPass, 0.57, accuracy: 1e-9)
        let start = JunoVoiceGlowState.handoffBeams(0)[0]
        XCTAssertEqual(start.pos, 0)
        XCTAssertEqual(start.mix, 0)
        let arrived = JunoVoiceGlowState.handoffBeams(T.handoffPass)[0]
        XCTAssertEqual(arrived.pos, 1)
        XCTAssertGreaterThan(arrived.mix, 0.999)
        XCTAssertEqual(JunoVoiceGlowState.handoffBeams(1.0)[0].pos, 1, "rests at Alevr's end")
        let again = JunoVoiceGlowState.handoffBeams(T.repass)
        XCTAssertEqual(again[0].pos, 0, "the next pass leaves from your end")
        XCTAssertGreaterThan(again[1].amp, 0.4)
        XCTAssertLessThan(JunoVoiceGlowState.handoffBeams(T.repass + T.handoffTone)[1].amp, 1e-6)
    }

    func testReducedMotionIgnoresTheAudioAndNeverTravels() {
        let loud = run(1, .you, you: 0.9, reduced: true).frame(reduced: true)
        let quiet = run(1, .you, you: 0, reduced: true).frame(reduced: true)
        XCTAssertEqual(loud, quiet)
        let thinking = run(2, .thinking, reduced: true).frame(reduced: true)
        XCTAssertEqual(thinking.beams.map(\.pos), [0, 1])
        XCTAssertEqual(thinking, run(2.5, .thinking, reduced: true).frame(reduced: true))
    }

    func testASimulatedMomentIsTheSamePictureEveryTime() {
        let at: (Double) -> JunoVoiceGlowInput = { t in
            JunoVoiceGlowInput(mode: t < 0.8 ? .you : .thinking, you: t < 0.8 ? 0.6 : 0, alevr: 0, reduced: false)
        }
        XCTAssertEqual(
            JunoVoiceGlowState.simulated(seconds: 1.3, at).frame(reduced: false),
            JunoVoiceGlowState.simulated(seconds: 1.3, at).frame(reduced: false)
        )
    }

    func testThePaletteIsTheWebsites() {
        XCTAssertEqual(JunoVoiceGlowPalette.light.alevr.line, "#2d49c9", "Alevr is presence ink")
        XCTAssertEqual(JunoVoiceGlowPalette.dark.alevr.line, "#97a6e6")
        XCTAssertEqual(JunoVoiceGlowPalette.light.you.line, "#bc5806")
        XCTAssertEqual(JunoVoiceGlowPalette.dark.you.line, "#f3a26b")
    }

    func testTheOutlineIsWalkedFromTheBottomCentre() {
        let outline = JunoVoiceGlowOutline(rect: CGRect(x: 0, y: 0, width: 300, height: 100), radius: 24)
        let segments = outline.segments()
        XCTAssertFalse(segments.isEmpty)
        // Right positive, left negative, and symmetric.
        XCTAssertEqual(segments.filter { $0.arc > 0 }.count, segments.filter { $0.arc < 0 }.count)
        XCTAssertEqual(outline.halfLength, 2 * 126 + 2 * 26 + .pi * 24, accuracy: 1e-9)
        // The first piece on the right sits on the bottom edge, near the centre.
        let first = segments[0].path.boundingRect
        XCTAssertEqual(first.midY, 100, accuracy: 0.5)
        XCTAssertGreaterThan(first.midX, 150)
    }
}
