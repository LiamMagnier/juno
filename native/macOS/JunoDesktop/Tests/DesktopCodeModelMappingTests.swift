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
        efforts: [NativeReasoningEffort] = [.low, .medium, .high]
    ) -> NativeChatModelOption {
        NativeChatModelOption(
            id: id,
            providerID: "anthropic",
            providerName: "Anthropic",
            displayName: "Claude Sonnet 5",
            summary: "Best speed-to-intelligence balance.",
            minimumPlan: "FREE",
            availability: "available",
            supportedReasoningEfforts: efforts,
            canDisableReasoning: false,
            supportsStreaming: true
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

    // MARK: - Thinking

    /// The control must offer the depths the model publishes, not three fixed
    /// ones — and never a depth the Code request contract cannot send.
    @Test
    func theThinkingLadderFollowsThePublishedDepths() {
        let option = JunoDesktopRootView
            .codeModels(from: [manifestEntry(efforts: [.low, .high])])
            .first
        let stops = option?.thinkingLadder.stops.map(\.id) ?? []
        #expect(!stops.isEmpty)
        #expect(stops.allSatisfy { ReasoningEffort(rawValue: $0) != nil })
    }

    @Test
    func aModelPublishingNoDepthsStillOffersTheContractLadder() {
        let option = JunoDesktopRootView
            .codeModels(from: [manifestEntry(efforts: [])])
            .first
        // The session always sends one of the three, so the control can never be
        // empty — an unset thinking control would send an effort nobody chose.
        #expect(option?.supportedReasoningEfforts.isEmpty == false)
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
