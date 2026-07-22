import JunoChatKit
import XCTest
@testable import JunoMobile

/// The composer must never sit on a model the account cannot send to — not
/// after a plan change, not after a model is retired, and not while the catalog
/// is still loading.
final class JunoMobileComposerSelectionTests: XCTestCase {
    private func option(
        _ id: String,
        availability: String = "available"
    ) -> NativeChatModelOption {
        NativeChatModelOption(
            id: id,
            providerID: "anthropic",
            providerName: "Anthropic · Claude",
            displayName: id,
            minimumPlan: "free",
            availability: availability,
            supportedReasoningEfforts: [],
            canDisableReasoning: true,
            supportsStreaming: true
        )
    }

    func testKeepsTheCurrentSelectionWhileItIsStillSelectable() {
        let resolved = JunoMobileComposerSelection.resolvedModelID(
            current: "openai:gpt-5",
            conversationModel: "anthropic:sonnet",
            selectable: [option("anthropic:sonnet"), option("openai:gpt-5")]
        )

        XCTAssertEqual(resolved, "openai:gpt-5")
    }

    func testFallsBackToTheConversationsOwnModelWhenTheSelectionGoesAway() {
        let resolved = JunoMobileComposerSelection.resolvedModelID(
            current: "xai:grok-5",
            conversationModel: "anthropic:sonnet",
            selectable: [option("anthropic:sonnet"), option("openai:gpt-5")]
        )

        XCTAssertEqual(resolved, "anthropic:sonnet")
    }

    func testFallsBackToTheFirstSelectableModelWhenNeitherSurvives() {
        let resolved = JunoMobileComposerSelection.resolvedModelID(
            current: "xai:grok-5",
            conversationModel: "meta:llama-4",
            selectable: [option("anthropic:sonnet"), option("openai:gpt-5")]
        )

        XCTAssertEqual(resolved, "anthropic:sonnet")
    }

    func testKeepsNamingTheConversationsModelBeforeTheCatalogLoads() {
        let resolved = JunoMobileComposerSelection.resolvedModelID(
            current: "",
            conversationModel: "anthropic:sonnet",
            selectable: []
        )

        XCTAssertEqual(resolved, "anthropic:sonnet")
    }

    func testAPlanGatedModelIsNeverResolvedTo() {
        // `selectable` is the store's filtered list; a gated model is in the
        // catalog for display but must not be reachable through this path.
        let gated = option("xai:grok-5", availability: "requires_plan")
        XCTAssertFalse(gated.isAvailable)

        let resolved = JunoMobileComposerSelection.resolvedModelID(
            current: "xai:grok-5",
            conversationModel: "xai:grok-5",
            selectable: [option("anthropic:sonnet")]
        )

        XCTAssertEqual(resolved, "anthropic:sonnet")
    }

    func testProviderRailShortensTheLabToWhatFitsAChip() {
        XCTAssertEqual(
            JunoMobileModelSelectorView.shortProviderName("Anthropic · Claude"),
            "Anthropic"
        )
        XCTAssertEqual(JunoMobileModelSelectorView.shortProviderName("Juno"), "Juno")
    }
}
