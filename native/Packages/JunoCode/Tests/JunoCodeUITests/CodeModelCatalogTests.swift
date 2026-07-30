import XCTest
import JunoCodeCore
import JunoDesignSystem

@testable import JunoCodeUI

/// The thinking control must offer exactly the depths the chosen model supports.
/// These cover the mapping both ways, because the failure they guard against —
/// a session quietly sending an effort the model cannot honour — is invisible in
/// the UI.
final class CodeModelCatalogTests: XCTestCase {
    private func makeDescriptor(stops: [JunoThinkingStop]) -> JunoModelDescriptor {
        JunoModelDescriptor(
            id: "anthropic:claude-sonnet-5",
            providerID: "anthropic",
            providerName: "Anthropic",
            displayName: "Claude Sonnet 5",
            thinking: JunoThinkingLadder(stops: stops)
        )
    }

    func testCatalogLadderNarrowsTheEffortsCodeOffers() {
        let option = ModelOption(
            catalog: makeDescriptor(
                stops: [ReasoningEffort.low.junoStop, ReasoningEffort.medium.junoStop]
            )
        )
        XCTAssertEqual(option.supportedReasoningEfforts, [.low, .medium])
        XCTAssertEqual(option.thinkingLadder.stops.map(\.id), ["low", "medium"])
    }

    func testStopsOutsideTheRequestContractAreDropped() {
        let option = ModelOption(
            catalog: makeDescriptor(
                stops: [
                    JunoThinkingStop(id: "instant", label: "Off", accessibilityLabel: "Off"),
                    ReasoningEffort.high.junoStop,
                ]
            )
        )
        XCTAssertEqual(option.supportedReasoningEfforts, [.high])
    }

    /// A model that publishes no ladder gets **no ladder** — not a substituted one.
    ///
    /// Empty is a real answer from the manifest: it is what arrives for a model
    /// that does not reason (`gpt-4o`, `qwen-long`, `codestral`), one that always
    /// reasons with no exposed control (`magistral`, Kimi K2.7), and one with a
    /// bare on/off switch. Synthesizing low/medium/high for those drew a depth
    /// slider on a model with no depths *and* put a thinking parameter on the wire
    /// for a model that refuses one — a documented 400, so the session failed every
    /// turn rather than merely thinking at the wrong depth.
    func testModelWithNoPublishedLadderGetsNoLadder() {
        let option = ModelOption(catalog: makeDescriptor(stops: []))
        XCTAssertTrue(option.supportedReasoningEfforts.isEmpty)
        XCTAssertFalse(option.takesThinkingParameter)
        // No control is drawn, because `JunoThinkingButton` renders nothing for an
        // empty ladder.
        XCTAssertFalse(option.thinkingLadder.isPresentable)
    }

    // MARK: - Instant

    /// The website's "Instant" survives into Code as a real stop.
    ///
    /// `JunoChatKit` writes an `instant` stop whenever the manifest reports
    /// `canDisable`, and Code used to require *every* stop to map to a
    /// `ReasoningEffort` — `instant` maps to none, so the guard rejected the whole
    /// published ladder and substituted one without an off state. More than half
    /// the catalog lost the ability to turn thinking off.
    func testAnInstantStopIsCarriedThroughRatherThanSinkingTheLadder() {
        let option = ModelOption(
            catalog: makeDescriptor(
                stops: [
                    JunoThinkingStop(
                        id: JunoThinkingLadder.instantStopID,
                        label: "Off",
                        accessibilityLabel: "Thinking off"
                    ),
                    ReasoningEffort.low.junoStop,
                    ReasoningEffort.high.junoStop,
                ]
            )
        )
        XCTAssertEqual(option.thinkingLadder.stops.map(\.id), ["instant", "low", "high"])
        XCTAssertTrue(option.canDisableThinking)
        // `instant` is deliberately not a sendable effort — it is the absence of one.
        XCTAssertEqual(option.supportedReasoningEfforts, [.low, .high])
    }

    /// Instant only survives a model change where the new model publishes it.
    func testInstantIsRefittedOnAModelThatAlwaysReasons() {
        let alwaysReasons = ModelOption(
            catalog: makeDescriptor(stops: [ReasoningEffort.high.junoStop])
        )
        XCTAssertFalse(alwaysReasons.canDisableThinking)
        // `.some(.high)` — change it, because nil cannot be sent to this model.
        XCTAssertEqual(alwaysReasons.refittingEffort(nil), .some(.high))

        let canDisable = ModelOption(
            catalog: makeDescriptor(
                stops: [
                    JunoThinkingStop(
                        id: JunoThinkingLadder.instantStopID,
                        label: "Off",
                        accessibilityLabel: "Thinking off"
                    ),
                    ReasoningEffort.high.junoStop,
                ]
            )
        )
        // nil — no change needed, Instant is valid here.
        XCTAssertTrue(
            canDisable.refittingEffort(nil) == nil,
            "Instant is valid on this model, so nothing needs refitting"
        )
    }

    /// A depth the new model cannot reach still clamps down.
    func testRefittingClampsADepthTheModelLacks() {
        let option = ModelOption(
            modelID: "m",
            displayName: "M",
            supportedReasoningEfforts: [.low, .high]
        )
        XCTAssertEqual(option.refittingEffort(.max), .some(.high))
        XCTAssertTrue(option.refittingEffort(.high) == nil, "already fits")
    }

    /// A model that *does* publish depths still takes a thinking parameter.
    func testAPublishedLadderMeansTheModelTakesAThinkingParameter() {
        let option = ModelOption(
            catalog: makeDescriptor(stops: [ReasoningEffort.high.junoStop])
        )
        XCTAssertTrue(option.takesThinkingParameter)
        XCTAssertTrue(option.thinkingLadder.isPresentable)
    }

    /// The bootstrap option — built from an id and a name before the manifest
    /// arrives — keeps the conservative band, because there is genuinely no
    /// manifest answer yet and the session still has to send something.
    func testTheNoCatalogBootstrapOptionKeepsTheConservativeBand() {
        let option = ModelOption(modelID: "anthropic:claude-sonnet-5", displayName: "Sonnet")
        XCTAssertEqual(option.supportedReasoningEfforts, [.low, .medium, .high])
        XCTAssertEqual(option.supportedReasoningEfforts, ModelOption.contractReasoningEfforts)
        XCTAssertTrue(option.takesThinkingParameter)
    }

    /// The regression that motivated widening the enum: a depth the website
    /// publishes and Code could not express used to sink the whole ladder.
    ///
    /// Kimi K3 offers low/high/max and no medium. The old three-value enum could
    /// not represent `max`, so `thinkingLadder`'s all-or-nothing guard rejected
    /// the published ladder and fell back to low/medium/high — offering a depth
    /// K3 does not accept while hiding the deepest one it does.
    func testAPublishedLadderWithMaxSurvivesIntoCode() {
        let option = ModelOption(
            catalog: makeDescriptor(
                stops: [
                    ReasoningEffort.low.junoStop,
                    ReasoningEffort.high.junoStop,
                    ReasoningEffort.max.junoStop,
                ]
            )
        )
        XCTAssertEqual(option.supportedReasoningEfforts, [.low, .high, .max])
        XCTAssertEqual(option.thinkingLadder.stops.map(\.id), ["low", "high", "max"])
        XCTAssertEqual(option.thinkingLadder.label(for: "max"), "Max")
    }

    /// Depth order has to follow the enum's declaration order, because clamping
    /// re-fits a stored effort by comparing depths.
    func testDepthOrderSpansEveryTierShallowestFirst() {
        XCTAssertEqual(
            ReasoningEffort.allCases.map(\.junoDepth),
            Array(0..<ReasoningEffort.allCases.count)
        )
        XCTAssertLessThan(ReasoningEffort.high.junoDepth, ReasoningEffort.xhigh.junoDepth)
        XCTAssertLessThan(ReasoningEffort.xhigh.junoDepth, ReasoningEffort.max.junoDepth)
        XCTAssertLessThan(ReasoningEffort.minimal.junoDepth, ReasoningEffort.low.junoDepth)
    }

    /// Clamping down from a tier the model lacks must land on the deepest tier it
    /// has, not on the shallowest.
    func testMaxIsRefittedOntoTheDeepestSupportedTier() {
        let option = ModelOption(
            modelID: "m",
            displayName: "M",
            supportedReasoningEfforts: [.low, .high]
        )
        XCTAssertEqual(option.clampingReasoningEffort(.max), .high)
        XCTAssertEqual(option.clampingReasoningEffort(.xhigh), .high)
        XCTAssertEqual(option.clampingReasoningEffort(.minimal), .low)
    }

    func testUnsupportedDepthIsRefittedDownward() {
        let option = ModelOption(
            modelID: "m",
            displayName: "M",
            supportedReasoningEfforts: [.low]
        )
        XCTAssertEqual(option.clampingReasoningEffort(.high), .low)
        XCTAssertNil(option.clampingReasoningEffort(.low))
    }

    func testSupportedDepthIsLeftAlone() {
        let option = ModelOption(
            modelID: "m",
            displayName: "M",
            supportedReasoningEfforts: [.low, .high]
        )
        XCTAssertNil(option.clampingReasoningEffort(.high))
        XCTAssertEqual(option.clampingReasoningEffort(.medium), .low)
    }

    func testSynthesizedDescriptorInventsNothing() {
        let option = ModelOption(modelID: "m", displayName: "M")
        let descriptor = option.descriptor
        XCTAssertNil(descriptor.costGlyph)
        XCTAssertNil(descriptor.priceDetail)
        XCTAssertTrue(descriptor.capabilities.isEmpty)
        XCTAssertNil(descriptor.intelligenceGrade)
        XCTAssertNil(descriptor.speedGrade)
        XCTAssertTrue(descriptor.providerID.isEmpty)
    }
}
