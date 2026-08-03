import XCTest
@testable import JunoDesignSystem

/// Pins the aura's two pure inputs to the website's own functions.
///
/// The values here were produced by running `asAmbientLight` and `reasoningGlow`
/// from `src/lib/provider-colors.ts` and `src/lib/model-metrics.ts` over the same
/// brand hexes, so a drift in either transform shows up as a failing number
/// rather than as a bloom that is subtly the wrong colour on one platform.
final class JunoProviderGlowTests: XCTestCase {

    private let accuracy = 1e-6

    private func assertHSL(
        _ actual: (h: Double, s: Double, l: Double),
        _ expected: (h: Double, s: Double, l: Double),
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(actual.h, expected.h, accuracy: accuracy, "hue", file: file, line: line)
        XCTAssertEqual(
            actual.s, expected.s, accuracy: accuracy, "saturation", file: file, line: line
        )
        XCTAssertEqual(
            actual.l, expected.l, accuracy: accuracy, "lightness", file: file, line: line
        )
    }

    // MARK: - Hex to HSL

    func testHexToHSLMatchesTheWebsConversion() {
        assertHSL(
            JunoProviderGlow.hsl(hex: 0xd9_78_59),
            (h: 14.531250, s: 0.627451, l: 0.600000)
        )
        // Blue-dominant, and past the l > .5 branch of the saturation formula.
        assertHSL(
            JunoProviderGlow.hsl(hex: 0x42_85_f4),
            (h: 217.415730, s: 0.890000, l: 0.607843)
        )
        // Green-dominant and dark, so the other branch.
        //
        // Saturation is exactly 147/179: delta is (163−16)/255 and, below the
        // l > .5 branch, the divisor is (163+16)/255. The literal here read
        // 0.821256, which is not that ratio — a transcription slip that had
        // never been caught because this file did not compile, so the suite
        // had never run.
        assertHSL(
            JunoProviderGlow.hsl(hex: 0x10_a3_7f),
            (h: 165.306122, s: 0.821229, l: 0.350980)
        )
    }

    /// A grey has no hue to report, and the formula divides by a delta of zero
    /// if that is not caught first.
    func testAGreyHasNoHueRatherThanANaN() {
        let grey = JunoProviderGlow.hsl(hex: 0x80_80_80)
        XCTAssertEqual(grey.h, 0)
        XCTAssertEqual(grey.s, 0)
        XCTAssertEqual(grey.l, 128.0 / 255, accuracy: accuracy)
    }

    // MARK: - Ambient light

    /// Hue is kept exactly, saturation is more than halved, and lightness is
    /// pulled two thirds of the way to the common mid.
    func testAmbientLightKeepsHueAndSoftensTheRest() {
        assertHSL(
            JunoProviderGlow.asAmbientLight((h: 14.531250, s: 0.627451, l: 0.600000)),
            (h: 14.531250, s: 0.351373, l: 0.545600)
        )
    }

    /// The cap is what stops the fully-saturated brands — five of the fourteen
    /// sit at s = 1 — arriving as warning lights.
    func testAmbientLightCapsSaturationAtAHalf() {
        let pure = JunoProviderGlow.asAmbientLight((h: 212.941176, s: 1, l: 0.5))
        XCTAssertEqual(pure.s, 0.5, accuracy: accuracy)
        XCTAssertEqual(pure.l, 0.5136, accuracy: accuracy)
    }

    /// The point of the lightness pull: fourteen brands spread from near-black to
    /// near-white have to land close enough together that the same effort setting
    /// means the same thing whichever model you are talking to.
    func testEveryBrandLandsInOneNarrowLightnessBand() {
        let lightnesses = ["anthropic", "openai", "google", "meta", "zhipu", "moonshot",
                           "deepseek", "mistral", "xai", "seedance", "minimax", "mimo",
                           "qwen", "longcat"]
            .compactMap { JunoProviderGlow.brandGlow(providerID: $0) }
            .map { JunoProviderGlow.hsl(red: $0.red, green: $0.green, blue: $0.blue).l }

        XCTAssertEqual(lightnesses.count, 14)
        for lightness in lightnesses {
            XCTAssertGreaterThan(lightness, 0.46)
            XCTAssertLessThan(lightness, 0.58)
        }
    }

    // MARK: - Provider lookup

    /// Components compared with the same tolerance the HSL helper above uses,
    /// not with `==`. The two sides reach the same colour by different routes —
    /// one hex → HSL → ambient light → token, the other straight from HSL
    /// literals — and they land about 2e-7 apart. Exact `Double` equality
    /// across those paths asserts the arithmetic's rounding, not the colour.
    private func assertToken(
        _ actual: JunoColorToken?,
        _ expected: JunoColorToken,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let actual = try XCTUnwrap(actual, file: file, line: line)
        XCTAssertEqual(actual.red, expected.red, accuracy: accuracy, "red", file: file, line: line)
        XCTAssertEqual(
            actual.green, expected.green, accuracy: accuracy, "green", file: file, line: line
        )
        XCTAssertEqual(
            actual.blue, expected.blue, accuracy: accuracy, "blue", file: file, line: line
        )
        XCTAssertEqual(
            actual.opacity, expected.opacity, accuracy: accuracy, "opacity", file: file, line: line
        )
    }

    func testAKnownProviderIsItsBrandTurnedIntoLight() throws {
        try assertToken(
            JunoProviderGlow.brandGlow(providerID: "anthropic"),
            JunoColorToken(hsl: (h: 14.531250, s: 0.351373, l: 0.545600))
        )
        // The three labs that brand in near-black carry a luminous stand-in, so
        // their glow must NOT be derived from the mark colour.
        //
        // Unwrapped by `try XCTUnwrap` rather than defaulted to zero: a lookup
        // that started returning nil would otherwise be compared against black
        // and could still pass on a hue that black does not actually have.
        let openai = try XCTUnwrap(JunoProviderGlow.brandGlow(providerID: "openai"))
        let green = JunoProviderGlow.hsl(
            red: openai.red, green: openai.green, blue: openai.blue
        )
        XCTAssertEqual(green.h, 165.306122, accuracy: accuracy)
    }

    /// Provider ids arrive from the server; the asset lookup already lowercases,
    /// and a bloom that silently fell back because a lab shipped as "OpenAI" one
    /// day would be a very hard bug to see.
    func testTheLookupIsCaseInsensitive() {
        XCTAssertEqual(
            JunoProviderGlow.brandGlow(providerID: "Anthropic"),
            JunoProviderGlow.brandGlow(providerID: "anthropic")
        )
    }

    @MainActor
    func testAnUnknownProviderFallsBackToTheAccountsAccent() {
        let selection = JunoAccentSelection.shared
        let original = selection.current
        defer { selection.current = original }

        selection.current = .teal
        XCTAssertEqual(
            JunoProviderGlow.glow(providerID: "a-lab-this-client-has-never-heard-of"),
            JunoColorToken(hsl: JunoAccent.teal.hsl(dark: false))
        )
        XCTAssertEqual(
            JunoProviderGlow.glow(providerID: "not-a-lab", dark: true),
            JunoColorToken(hsl: JunoAccent.teal.hsl(dark: true))
        )
        // A lab Juno does know is one colour in both schemes, exactly as on the
        // web — `dark` only ever picks the accent fallback's half.
        XCTAssertEqual(
            JunoProviderGlow.glow(providerID: "google"),
            JunoProviderGlow.glow(providerID: "google", dark: true)
        )
    }

    // MARK: - The thinking ladder

    func testReasoningGlowIsTheTierIndexOverTheLadder() {
        XCTAssertEqual(JunoProviderGlow.reasoningGlow(effort: "minimal"), 1.0 / 6)
        XCTAssertEqual(JunoProviderGlow.reasoningGlow(effort: "low"), 2.0 / 6)
        XCTAssertEqual(JunoProviderGlow.reasoningGlow(effort: "medium"), 3.0 / 6)
        XCTAssertEqual(JunoProviderGlow.reasoningGlow(effort: "high"), 4.0 / 6)
        XCTAssertEqual(JunoProviderGlow.reasoningGlow(effort: "xhigh"), 5.0 / 6)
        XCTAssertEqual(JunoProviderGlow.reasoningGlow(effort: "max"), 1)
    }

    /// Thinking off is the dimmest bloom Juno draws, not the absence of one.
    func testNoEffortIsTheBottomOfTheRamp() {
        XCTAssertEqual(JunoProviderGlow.reasoningGlow(effort: nil), 0)
        XCTAssertEqual(JunoProviderGlow.reasoningGlow(effort: "ultra"), 0)
    }

    /// The gate the empty state gets wrong if it asks `model.reasoning` instead:
    /// a model with no control on screen is not thinking at zero, it is a
    /// question the slider never asks, so it sits at the middle of the ramp —
    /// the same value `--aura-think`'s own `initial-value` carries.
    func testAModelWithNoControlSitsInTheMiddleRatherThanAtTheBottom() {
        XCTAssertEqual(
            JunoProviderGlow.auraThink(effort: nil, hasEffortControl: false), 0.5
        )
        XCTAssertEqual(
            JunoProviderGlow.auraThink(effort: "max", hasEffortControl: false), 0.5
        )
        XCTAssertEqual(
            JunoProviderGlow.auraThink(effort: nil, hasEffortControl: true), 0
        )
        XCTAssertEqual(
            JunoProviderGlow.auraThink(effort: "max", hasEffortControl: true), 1
        )
    }

    /// The ladder is indexed, never transcribed: a seventh tier landing here has
    /// to re-space the whole ramp rather than quietly sharing Max's value.
    func testTheLadderIsTheWebsSixTiersInOrder() {
        XCTAssertEqual(
            JunoProviderGlow.reasoningTiers,
            ["minimal", "low", "medium", "high", "xhigh", "max"]
        )
    }
}
