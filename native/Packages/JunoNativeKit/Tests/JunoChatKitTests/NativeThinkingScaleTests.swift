import XCTest
@testable import JunoChatKit

/// The thinking control must offer exactly what a model supports — never a
/// ladder it made up, and never a value the chat route would reject.
final class NativeThinkingScaleTests: XCTestCase {
    private func option(
        id: String = "openai:gpt-5",
        name: String = "GPT-5",
        efforts: [NativeReasoningEffort] = [],
        canDisable: Bool = true,
        reasoning: Bool = true,
        onOffOnly: Bool = false,
        automatic: Bool = false,
        availability: String = "available"
    ) -> NativeChatModelOption {
        NativeChatModelOption(
            id: id,
            providerID: "openai",
            providerName: "OpenAI · GPT",
            displayName: name,
            minimumPlan: "free",
            availability: availability,
            supportedReasoningEfforts: efforts,
            canDisableReasoning: canDisable,
            supportsReasoning: reasoning,
            isOnOffReasoningOnly: onOffOnly,
            choosesReasoningAutomatically: automatic,
            supportsStreaming: true
        )
    }

    func testLadderIsOffPlusExactlyTheSupportedTiers() {
        let scale = NativeThinkingScale(model: option(efforts: [.low, .high]))

        XCTAssertEqual(scale.stops.map(\.label), ["Off", "Low", "High"])
        XCTAssertTrue(scale.isAdjustable)
        XCTAssertEqual(scale.stop(at: 2)?.effort, .high)
    }

    func testTiersAreOrderedByDepthRegardlessOfServerOrder() {
        let scale = NativeThinkingScale(model: option(efforts: [.max, .low, .medium]))

        XCTAssertEqual(scale.stops.map(\.label), ["Off", "Low", "Medium", "Max"])
    }

    func testAlwaysOnModelHasNoOffStop() {
        let scale = NativeThinkingScale(
            model: option(efforts: [.medium, .high, .xhigh], canDisable: false)
        )

        XCTAssertEqual(scale.stops.map(\.label), ["Medium", "High", "Extra high"])
        XCTAssertEqual(scale.defaultStop?.effort, .medium)
    }

    func testNonReasoningModelPresentsNoControlAtAll() {
        let scale = NativeThinkingScale(model: option(reasoning: false))

        XCTAssertTrue(scale.stops.isEmpty)
        XCTAssertFalse(scale.isPresentable)
    }

    func testAlwaysOnModelWithoutTiersOffersNothingToChoose() {
        // Always reasons, no exposed control: one inert stop would be a lie.
        let scale = NativeThinkingScale(model: option(efforts: [], canDisable: false))

        XCTAssertTrue(scale.stops.isEmpty)
        XCTAssertFalse(scale.isPresentable)
    }

    func testOnOffModelGetsTwoStopsAndSendsHighForOn() {
        let scale = NativeThinkingScale(model: option(onOffOnly: true))

        XCTAssertEqual(scale.stops.map(\.label), ["Off", "Thinking"])
        XCTAssertNil(scale.stops[0].effort)
        XCTAssertEqual(scale.stops[1].effort, .high)
    }

    func testAutoIsShownButNotAdjustable() {
        let scale = NativeThinkingScale(model: option(name: "Auto", automatic: true))

        XCTAssertTrue(scale.isAutomatic)
        XCTAssertTrue(scale.isPresentable)
        XCTAssertFalse(scale.isAdjustable)
        XCTAssertTrue(scale.stops.isEmpty)
    }

    // MARK: Clamping across a model switch

    func testSupportedLevelSurvivesTheSwitchWithoutANotice() {
        let adjustment = NativeThinkingScale(model: option(efforts: [.low, .high]))
            .adjusting(.high)

        XCTAssertEqual(adjustment.effort, .high)
        XCTAssertNil(adjustment.explanation)
    }

    func testDeeperLevelClampsDownToTheDeepestSupportedAndExplainsIt() {
        let adjustment = NativeThinkingScale(
            model: option(name: "Claude Opus 4.5", efforts: [.low, .medium, .high])
        ).adjusting(.max)

        XCTAssertEqual(adjustment.effort, .high)
        XCTAssertEqual(
            adjustment.explanation,
            "Claude Opus 4.5 supports up to High — thinking set to High."
        )
    }

    func testOffBecomesTheShallowestLevelOnAnAlwaysOnModel() {
        let adjustment = NativeThinkingScale(
            model: option(name: "GPT-5.4 Pro", efforts: [.medium, .high], canDisable: false)
        ).adjusting(nil)

        XCTAssertEqual(adjustment.effort, .medium)
        XCTAssertEqual(
            adjustment.explanation,
            "GPT-5.4 Pro always thinks — set to Medium."
        )
    }

    func testAnyDepthCollapsesToTheSingleModeOfAnOnOffModel() {
        let adjustment = NativeThinkingScale(
            model: option(name: "Claude Haiku 4.5", onOffOnly: true)
        ).adjusting(.max)

        XCTAssertEqual(adjustment.effort, .high)
        XCTAssertEqual(
            adjustment.explanation,
            "Claude Haiku 4.5 has a single thinking mode."
        )
    }

    func testSwitchingToAutoDropsTheEffortAndSaysWhy() {
        let adjustment = NativeThinkingScale(model: option(name: "Auto", automatic: true))
            .adjusting(.high)

        XCTAssertNil(adjustment.effort)
        XCTAssertEqual(
            adjustment.explanation,
            "Auto picks the thinking depth for each message."
        )
    }

    func testSwitchingToAutoFromOffSaysNothing() {
        let adjustment = NativeThinkingScale(model: option(automatic: true)).adjusting(nil)

        XCTAssertNil(adjustment.effort)
        XCTAssertNil(adjustment.explanation)
    }

    func testSwitchingToANonReasoningModelDropsTheEffortAndSaysWhy() {
        let adjustment = NativeThinkingScale(
            model: option(name: "Gemini 3 Flash", reasoning: false)
        ).adjusting(.medium)

        XCTAssertNil(adjustment.effort)
        XCTAssertEqual(
            adjustment.explanation,
            "Gemini 3 Flash has no thinking levels to set."
        )
    }
}
