import JunoChatKit
import JunoCodeBridge
import JunoCodeCore
import JunoCodeKit
import JunoCodeUI
import Testing
@testable import JunoDesktop

/// How the account's model manifest reaches Juno Code.
///
/// The regression these pin down: the mapping was
/// `ModelOption(modelID:displayName:)`, which kept the two fields the runtime
/// needs and dropped the catalog entry. Code's picker then had no provider mark,
/// no lab name, no capability chips and no spec sheet — a list of bare names
/// under "Unknown provider" — while Chat, reading the *same* manifest, showed the
/// full website catalog. Nothing crashed and nothing logged; the two windows just
/// looked like different products.
/// `@MainActor` because the mapping is a static on a SwiftUI `View` and runs
/// from the app's main-actor lifecycle; running it off that actor crashed the
/// suite at load rather than failing an assertion.
@MainActor
struct DesktopCodeModelMappingTests {
    private func manifestEntry(
        id: String = "anthropic:claude-sonnet-5",
        efforts: [NativeReasoningEffort] = [.low, .medium, .high],
        modality: String = "chat"
    ) -> NativeChatModelOption {
        NativeChatModelOption(
            id: id,
            providerID: "anthropic",
            providerName: "Anthropic",
            displayName: "Claude Sonnet 5",
            summary: "Best speed-to-intelligence balance.",
            minimumPlan: "FREE",
            availability: "available",
            modality: modality,
            supportedReasoningEfforts: efforts,
            canDisableReasoning: false,
            // The manifest never publishes tiers for a model it also reports as
            // non-reasoning, and `NativeThinkingScale` returns no stops at all
            // when `supportsReasoning` is false — so leaving this at its `false`
            // default made every "publishes depths" fixture silently describe a
            // model with no ladder.
            supportsReasoning: !efforts.isEmpty,
            // The manifest sets `streaming: modality === "chat"`, and
            // `isChatCapable` reads it. Mirroring that here is what makes the
            // generation-model case exercise the real predicate.
            supportsStreaming: modality == "chat"
        )
    }

    // MARK: - The catalog survives the crossing

    @Test
    func theProviderIdentityReachesCode() {
        let options = JunoDesktopRootView.codeModels(from: [manifestEntry()])
        let catalog = options.first?.catalog
        #expect(catalog != nil, "the manifest entry must arrive with its catalog attached")
        // The provider id is what resolves the lab's artwork; an empty one is
        // exactly what produced a monogram where a logo belongs.
        #expect(catalog?.providerID == "anthropic")
        #expect(catalog?.providerName == "Anthropic")
    }

    @Test
    func theSpecSheetContentSurvives() {
        let catalog = JunoDesktopRootView.codeModels(from: [manifestEntry()]).first?.catalog
        #expect(catalog?.displayName == "Claude Sonnet 5")
        #expect(catalog?.summary?.isEmpty == false)
    }

    @Test
    func theRuntimeIdentifierIsUnchanged() {
        let option = JunoDesktopRootView.codeModels(from: [manifestEntry()]).first
        #expect(option?.modelID == "anthropic:claude-sonnet-5")
    }

    // MARK: - Only models Code can actually route

    /// The filter is the reason this mapping exists at all: Code may only offer
    /// models its own transport can call.
    @Test
    func modelsCodeCannotRouteAreLeftOut() {
        let unroutable = manifestEntry(id: "juno:auto")
        let routable = manifestEntry()
        let options = JunoDesktopRootView.codeModels(from: [unroutable, routable])
        #expect(options.allSatisfy { CodeModelProviderResolver.supports($0.modelID) })
    }

    @Test
    func anEmptyManifestProducesNoOptions() {
        #expect(JunoDesktopRootView.codeModels(from: []).isEmpty)
    }

    /// Image and video models must not reach Code's picker.
    ///
    /// The provider filter alone could not keep them out: it matches on the
    /// *provider prefix*, so every id under a lab `/api/agent` can reach passed —
    /// including that lab's generation models. The account manifest carries 27 of
    /// them, 23 under providers Code allows, so `openai:gpt-image-2` and
    /// `xai:grok-imagine-video` were offered as models to run a coding session
    /// on. Neither can hold a tool-calling loop.
    @Test
    func generationModelsAreNotOfferedAsCodingModels() {
        let image = manifestEntry(id: "openai:gpt-image-2", modality: "image")
        let video = manifestEntry(id: "xai:grok-imagine-video", modality: "video")
        let chat = manifestEntry()
        let options = JunoDesktopRootView.codeModels(from: [image, video, chat])
        #expect(options.map(\.modelID) == ["anthropic:claude-sonnet-5"])
    }

    // MARK: - Thinking

    /// The control must offer the depths the model publishes, not three fixed
    /// ones — and never a depth the Code request contract cannot send.
    @Test
    func theThinkingLadderFollowsThePublishedDepths() {
        let option = JunoDesktopRootView
            .codeModels(from: [manifestEntry(efforts: [.low, .high])])
            .first
        let stops = option?.thinkingLadder.stops.map(\.id) ?? []
        #expect(stops == ["low", "high"])
        #expect(stops.allSatisfy { ReasoningEffort(rawValue: $0) != nil })
    }

    /// Kimi K3's real ladder, end to end through the mapping.
    ///
    /// `max` is the depth the user reported missing. It could not survive before,
    /// because the three-value `ReasoningEffort` could not represent it and the
    /// all-or-nothing guard in `thinkingLadder` therefore discarded the whole
    /// published ladder and substituted low/medium/high — offering K3 a depth it
    /// rejects while hiding the deepest one it supports.
    @Test
    func kimiK3KeepsItsLowHighMaxLadder() {
        let option = JunoDesktopRootView
            .codeModels(from: [
                manifestEntry(id: "moonshot:kimi-k3", efforts: [.low, .high, .max])
            ])
            .first
        #expect(option?.thinkingLadder.stops.map(\.id) == ["low", "high", "max"])
        #expect(option?.supportedReasoningEfforts == [.low, .high, .max])
    }

    /// A model that publishes no depths gets no control and no wire parameter.
    ///
    /// This inverts an earlier expectation deliberately. Substituting a ladder
    /// here drew a depth slider for models that have no depths — and, once the
    /// bridge started actually sending the thinking parameter, put one on the wire
    /// for models that reject it outright, which is a 400 on the Mistral line, the
    /// non-reasoning OpenAI snapshots and the non-thinking Qwen models.
    @Test
    func aModelPublishingNoDepthsGetsNoLadderAndNoWireParameter() {
        let option = JunoDesktopRootView
            .codeModels(from: [manifestEntry(efforts: [])])
            .first
        #expect(option?.supportedReasoningEfforts.isEmpty == true)
        #expect(option?.takesThinkingParameter == false)
        #expect(option?.thinkingLadder.isPresentable == false)
    }

    // MARK: - First-turn launch contract

    @Test
    func desktopLaunchTargetsMapOnlyRelayedWorkToTheNativeTaskAPI() {
        #expect(DesktopCodeLaunchTarget.local.nativeTarget == nil)
        #expect(DesktopCodeLaunchTarget.cloud.nativeTarget == .cloud)
        #expect(DesktopCodeLaunchTarget.device.nativeTarget == .device)
    }

    @Test
    func aLocalDraftPreservesEveryVisibleChoice() {
        let workspaceID = WorkspaceID(value: "workspace")
        let draft = DesktopLocalCodeDraft(
            workspaceID: workspaceID,
            prompt: "Review this safely",
            behavior: .plan,
            permissionMode: .askBeforeChanges,
            modelID: "anthropic:claude-sonnet-5",
            reasoningEffort: .high
        )

        #expect(draft.configuration.location == .local)
        #expect(draft.configuration.behavior == .plan)
        #expect(draft.configuration.permissionMode == .askBeforeChanges)
        #expect(draft.configuration.modelID == "anthropic:claude-sonnet-5")
        #expect(draft.configuration.reasoningEffort == .high)
    }

    @Test
    func firstPromptBecomesAReadableSessionTitle() {
        #expect(
            DesktopLocalCodeDraft.title(
                from: "\n  Fix the authentication race\nand verify the signed build"
            ) == "Fix the authentication race"
        )
        #expect(
            DesktopLocalCodeDraft.title(from: String(repeating: "a", count: 80)).count == 61
        )
    }
}
