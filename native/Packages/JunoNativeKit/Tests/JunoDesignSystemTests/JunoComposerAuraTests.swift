import XCTest
@testable import JunoDesignSystem

/// Pins the composer aura's arithmetic to the website's own numbers.
///
/// The bloom is the one piece of Juno's chrome whose whole job is to be *read*
/// rather than clicked, so the two clients disagreeing about it is a difference
/// nobody can report and everybody can feel: the same model at the same effort
/// has to be the same light in the browser and on the phone. These are the
/// values in `src/app/globals.css` (`--aura-lit`, `--aura-reach`, `--aura`, and
/// the seven-stop ramp), `src/lib/provider-colors.ts` (`asAmbientLight`) and
/// `src/lib/model-metrics.ts` (`reasoningGlow`), assertion for assertion.
final class JunoComposerAuraTests: XCTestCase {

    private let accuracy = 1e-9

    // MARK: - Effort curves

    /// `--aura-lit: calc(.62 + .42 * t + .44 * t * t)`.
    func testLitCurveMatchesTheWebAtBothEndsAndTheMiddle() {
        XCTAssertEqual(JunoComposerAuraRamp.lit(think: 0), 0.62, accuracy: accuracy)
        XCTAssertEqual(JunoComposerAuraRamp.lit(think: 0.5), 0.94, accuracy: accuracy)
        XCTAssertEqual(JunoComposerAuraRamp.lit(think: 1), 1.48, accuracy: accuracy)
    }

    /// The curve exists because a straight ramp bunched up at the top. Pin the
    /// property that bought: every tier is about a sixth brighter than the one
    /// below it, rather than the 17%-then-9% collapse a linear ramp gave.
    func testEveryTierIsAnEvenRelativeStepBrighterThanTheLast() {
        let ladder = JunoProviderGlow.reasoningTiers.indices.map { index in
            JunoComposerAuraRamp.lit(
                think: Double(index + 1) / Double(JunoProviderGlow.reasoningTiers.count)
            )
        }
        for (brighter, dimmer) in zip(ladder.dropFirst(), ladder) {
            XCTAssertGreaterThan(brighter / dimmer - 1, 0.14)
            XCTAssertLessThan(brighter / dimmer - 1, 0.18)
        }
    }

    /// `--aura-reach: calc(.74 + .26 * t)`. The top must be exactly 1: the
    /// laid-out box is the envelope measured flush against short windows, and
    /// effort is never allowed to push past it.
    func testReachCurveMatchesTheWebAndTopsOutAtOne() {
        XCTAssertEqual(JunoComposerAuraRamp.reach(think: 0), 0.74, accuracy: accuracy)
        XCTAssertEqual(JunoComposerAuraRamp.reach(think: 0.5), 0.87, accuracy: accuracy)
        XCTAssertEqual(JunoComposerAuraRamp.reach(think: 1), 1, accuracy: accuracy)
    }

    /// A `think` outside 0…1 is a caller bug, not a licence to overrun the
    /// envelope — CSS would happily have scaled the box past its measured cap.
    func testEffortIsClampedBeforeItReachesEitherCurve() {
        XCTAssertEqual(JunoComposerAuraRamp.lit(think: -3), 0.62, accuracy: accuracy)
        XCTAssertEqual(JunoComposerAuraRamp.lit(think: 4), 1.48, accuracy: accuracy)
        XCTAssertEqual(JunoComposerAuraRamp.reach(think: -3), 0.74, accuracy: accuracy)
        XCTAssertEqual(JunoComposerAuraRamp.reach(think: 4), 1, accuracy: accuracy)
    }

    // MARK: - The one knob

    func testAuraScaleMatchesBothVariantsInBothSchemes() {
        XCTAssertEqual(JunoComposerAuraRamp.aura(docked: false, dark: false), 1)
        XCTAssertEqual(JunoComposerAuraRamp.aura(docked: false, dark: true), 1.5)
        XCTAssertEqual(JunoComposerAuraRamp.aura(docked: true, dark: false), 0.38)
        XCTAssertEqual(JunoComposerAuraRamp.aura(docked: true, dark: true), 0.58)
    }

    // MARK: - The ramp

    func testRampIsTheSevenStopsFromTheStylesheet() {
        XCTAssertEqual(
            JunoComposerAuraRamp.stops.map(\.location),
            [0, 0.18, 0.36, 0.54, 0.72, 0.88, 1]
        )
        XCTAssertEqual(
            JunoComposerAuraRamp.stops.map(\.alpha),
            [0.225, 0.195, 0.14, 0.085, 0.042, 0.014, 0]
        )
        XCTAssertEqual(
            JunoComposerAuraRamp.stops.map(\.lightness),
            [1.08, 1, 0.88, 0.72, 0.55, 0.4, 0.3]
        )
        XCTAssertEqual(
            JunoComposerAuraRamp.stops.map(\.saturation),
            [1, 1, 1, 0.96, 0.9, 0.84, 0.8]
        )
    }

    /// The rule that keeps the bloom from greying out at its rim: the last stop
    /// is the tint at zero alpha, so it still has a colour to interpolate
    /// towards. A `.clear` — or a zeroed multiplier here — is transparent black,
    /// and the outer third of the ramp would wash through grey on its way out.
    func testTheFinalStopIsZeroAlphaButKeepsItsOwnColour() throws {
        let last = try XCTUnwrap(JunoComposerAuraRamp.stops.last)
        XCTAssertEqual(last.location, 1)
        XCTAssertEqual(last.alpha, 0)
        XCTAssertGreaterThan(last.lightness, 0)
        XCTAssertGreaterThan(last.saturation, 0)
    }

    /// A Gaussian-ish ramp, not a linear one: alpha falls monotonically and the
    /// colour dims and desaturates outwards, so the bloom reads as one light
    /// with a hot centre rather than as a flat disc fading at the edge.
    func testRampFallsMonotonicallyOutwards() {
        let stops = JunoComposerAuraRamp.stops
        for (outer, inner) in zip(stops.dropFirst(), stops) {
            XCTAssertGreaterThan(outer.location, inner.location)
            XCTAssertLessThan(outer.alpha, inner.alpha)
            XCTAssertLessThan(outer.lightness, inner.lightness)
            XCTAssertLessThanOrEqual(outer.saturation, inner.saturation)
        }
    }

    /// At rest the core is a wash and never a pane, in the loudest combination
    /// the aura has: dark mode, Max effort, the undocked bloom. Half-opaque is
    /// the ceiling the ramp was balanced against, and a change to `--aura` or to
    /// the lit curve that quietly pushed this to 1 would flatten the top of the
    /// ladder into a solid disc with no steps left in it.
    func testTheCoreIsAWashAtRestEvenAtFullEffort() {
        let peak = JunoComposerAuraRamp.stops[0].alpha
            * JunoComposerAuraRamp.aura(docked: false, dark: true)
            * JunoComposerAuraRamp.lit(think: 1)
        XCTAssertEqual(peak, 0.4995, accuracy: 1e-6)
    }
}
