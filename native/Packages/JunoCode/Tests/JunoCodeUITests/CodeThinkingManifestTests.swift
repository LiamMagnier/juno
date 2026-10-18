import XCTest
import JunoCodeBridge
import JunoCodeCore
import JunoDesignSystem

@testable import JunoCodeUI

/// Code's pickers (the Studio chip, Settings, and the v2 composer) take their
/// thinking stops only from the manifest entry — supportedReasoningEfforts,
/// canDisable, onOffOnly, defaultEffort — exactly as Chat's do, and a depth
/// stored for one model is fitted to the next on a switch.
///
/// The descriptors below are what `NativeChatModelOption.junoDescriptor`
/// builds from the manifest's Haiku rows (the Chat side of this is
/// `NativeModelManifestTests.testHaikuManifestEntriesYieldTheirOwnLaddersAndDefaults`).
// The pickers' ladder helpers are main-actor isolated; Xcode 26.6 (CI) does not
// infer the isolation the way the local 27 toolchain does.
@MainActor
final class CodeThinkingManifestTests: XCTestCase {
    private func stop(_ id: String, _ label: String) -> JunoThinkingStop {
        JunoThinkingStop(id: id, label: label, accessibilityLabel: label)
    }

    private var haiku55: ModelOption {
        ModelOption(catalog: JunoModelDescriptor(
            id: "anthropic:claude-haiku-5-5",
            providerID: "anthropic",
            providerName: "Anthropic",
            displayName: "Claude Haiku 5.5",
            capabilities: [.reasoning, .tools],
            thinking: JunoThinkingLadder(
                stops: [
                    stop(JunoThinkingLadder.instantStopID, "Instant"),
                    stop("low", "Low"), stop("medium", "Medium"), stop("high", "High"),
                    stop("xhigh", "Extra high"), stop("max", "Max"),
                ],
                modelName: "Claude Haiku 5.5",
                defaultStopID: "medium"
            ),
            codeAgentic: true
        ))
    }

    private var haiku45: ModelOption {
        ModelOption(catalog: JunoModelDescriptor(
            id: "anthropic:claude-haiku-4-5",
            providerID: "anthropic",
            providerName: "Anthropic",
            displayName: "Claude Haiku 4.5",
            capabilities: [.reasoning, .tools],
            thinking: JunoThinkingLadder(
                stops: [
                    stop(JunoThinkingLadder.instantStopID, "Instant"),
                    stop(JunoThinkingLadder.onStopID, "Thinking"),
                ],
                modelName: "Claude Haiku 4.5",
                defaultStopID: JunoThinkingLadder.instantStopID
            ),
            codeAgentic: true
        ))
    }

    // MARK: - Studio picker (ModelOption)

    func testHaiku55OffersInstantPlusAllFiveDepthsWithMediumDefault() {
        let option = haiku55
        XCTAssertEqual(
            option.thinkingLadder.stops.map(\.label),
            ["Instant", "Low", "Medium", "High", "Extra high", "Max"]
        )
        XCTAssertEqual(option.thinkingLadder.defaultStopID, "medium")
        XCTAssertEqual(option.supportedReasoningEfforts, [.low, .medium, .high, .xhigh, .max])
        XCTAssertEqual(option.defaultReasoningEffort, .medium)
        XCTAssertTrue(option.canDisableThinking)
    }

    /// Switching from a GPT session at `minimal` must not carry `minimal` over.
    func testSwitchingToHaiku55ResetsAForeignDepthToItsDefault() {
        XCTAssertEqual(haiku55.refittingEffort(.minimal), .some(.medium))
        XCTAssertTrue(haiku55.refittingEffort(.xhigh) == nil, "already fits")
        XCTAssertTrue(haiku55.refittingEffort(nil) == nil, "Instant is valid")
    }

    func testHaiku45IsOnOffOnlyAndOnIsSentAsHigh() {
        let option = haiku45
        XCTAssertEqual(option.thinkingLadder.stops.map(\.label), ["Instant", "Thinking"])
        XCTAssertTrue(option.isOnOffThinking)
        XCTAssertEqual(option.supportedReasoningEfforts, [.high])
        XCTAssertEqual(option.thinkingStopID(for: .high), JunoThinkingLadder.onStopID)
        XCTAssertEqual(option.thinkingStopID(for: nil), JunoThinkingLadder.instantStopID)
        XCTAssertEqual(option.refittingEffort(.minimal), .some(.high))
        XCTAssertTrue(ModelOption.reasoningEffort(forStopID: JunoThinkingLadder.onStopID) == .some(.high))
        XCTAssertTrue(ModelOption.reasoningEffort(forStopID: JunoThinkingLadder.instantStopID) == .some(nil))
    }

    // MARK: - v2 composer (CodeV2.ProviderModel)

    func testV2LevelsComeFromTheManifestOnly() {
        let models = CodeV2AlevrCatalog.codingModels([haiku55, haiku45])
        let h55 = models.first { $0.id == "anthropic:claude-haiku-5-5" }
        XCTAssertEqual(h55?.effortLevels, [CodeV2.EffortLevel.none, .low, .medium, .high, .xhigh, .max])
        XCTAssertEqual(h55?.defaultEffort, .medium)
        let ladder = CodeV2ModelControl.ladder(for: h55, name: "Claude Haiku 5.5")
        XCTAssertEqual(ladder.stops.map(\.label), ["Instant", "Low", "Medium", "High", "Extra high", "Max"])
        XCTAssertEqual(ladder.defaultStopID, "medium")

        let h45 = models.first { $0.id == "anthropic:claude-haiku-4-5" }
        XCTAssertEqual(h45?.effortLevels, [CodeV2.EffortLevel.none, .high])
        XCTAssertEqual(h45?.defaultEffort, CodeV2.EffortLevel.none)
    }

    func testV2InstantStopMapsToTheNoneLevel() {
        XCTAssertEqual(CodeV2ModelControl.stopID(for: CodeV2.EffortLevel.none), JunoThinkingLadder.instantStopID)
        XCTAssertEqual(CodeV2ModelControl.level(forStopID: JunoThinkingLadder.instantStopID), CodeV2.EffortLevel.none)
        XCTAssertEqual(CodeV2ModelControl.level(forStopID: "xhigh"), .xhigh)
    }

    // MARK: - Request layer

    func testTheManifestCapsReachTheRequestLayer() {
        let caps = haiku55.reasoningCaps
        XCTAssertEqual(caps, CodeReasoningCaps(
            supported: true, canDisable: true, onOffOnly: false,
            tiers: [.low, .medium, .high, .xhigh, .max], defaultEffort: .medium
        ))
        XCTAssertEqual(caps?.clamp(.minimal), .medium)
        XCTAssertNil(caps?.clamp(nil))

        let on = haiku45.reasoningCaps
        XCTAssertEqual(on?.onOffOnly, true)
        XCTAssertEqual(on?.clamp(.low), .high)

        let registry = CodeReasoningCapsRegistry()
        ModelOption.registerReasoningCaps([haiku55, haiku45], registry: registry)
        XCTAssertEqual(registry.caps(for: "anthropic:claude-haiku-5-5"), caps)
        XCTAssertEqual(
            registry.caps(for: "haiku", providerID: "anthropic", providerModelID: "claude-haiku-4-5"),
            on
        )
    }
}
