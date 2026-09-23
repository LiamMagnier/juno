import Foundation
import JunoChatKit
import JunoDesignSystem
import Testing
@testable import JunoDesktop

/// The composer's pure rules (Phase 1d of the Liquid Glass redesign, §5).
///
/// Each is a rule a screenshot would pass while being wrong: a grey disc that
/// should have been Stop, a placeholder that forgot private mode, a third mark
/// eating the sentence, a composer with no model before the catalog lands.
struct ChatComposerTests {
    // MARK: - The disc

    /// Stop wins over everything — it is the one thing left to press — then a
    /// reason nothing can be sent, then a wait, then send or voice.
    @Test
    func theDiscFacePrecedenceIsStopBlockedWaitingThenDraft() {
        #expect(ChatComposerFace.resolve(isGenerating: true, hasDraft: true, blockedReason: "x", waitingReason: "y") == .stop)
        #expect(ChatComposerFace.resolve(isGenerating: false, hasDraft: true, blockedReason: "spent", waitingReason: "uploading") == .disabled("spent"))
        #expect(ChatComposerFace.resolve(isGenerating: false, hasDraft: true, blockedReason: nil, waitingReason: "uploading") == .busy("uploading"))
        #expect(ChatComposerFace.resolve(isGenerating: false, hasDraft: true, blockedReason: nil, waitingReason: nil) == .send)
        #expect(ChatComposerFace.resolve(isGenerating: false, hasDraft: false, blockedReason: nil, waitingReason: nil) == .voice)
    }

    /// Where no call can start — a private chat, a call already running — an
    /// empty draft offers Send, disabled, never the voice face: the web's rule
    /// for the same slot, and the one that stops a second call being dialled
    /// over the first.
    @Test
    func anEmptyDraftWithNoCallToStartShowsASendItCannotUse() {
        let face = ChatComposerFace.resolve(
            isGenerating: false, hasDraft: false, blockedReason: nil, waitingReason: nil, voiceAvailable: false
        )
        #expect(face == .disabled("Send"))
        #expect(!face.isEnabled)
        #expect(!face.isAccented)
        // A draft still sends, and a reply still stops, without a call.
        #expect(ChatComposerFace.resolve(
            isGenerating: false, hasDraft: true, blockedReason: nil, waitingReason: nil, voiceAvailable: false
        ) == .send)
        #expect(ChatComposerFace.resolve(
            isGenerating: true, hasDraft: false, blockedReason: nil, waitingReason: nil, voiceAvailable: false
        ) == .stop)
    }

    /// Coral is for the faces that act (§0.4); voice and disabled rest on the
    /// glass fill. The web's labels, and the keys in the tooltips.
    @Test
    func onlyTheActingFacesAreCoralAndEachNamesItself() {
        #expect(ChatComposerFace.send.isAccented)
        #expect(ChatComposerFace.stop.isAccented)
        #expect(ChatComposerFace.busy("Waiting for the upload to finish").isAccented)
        #expect(!ChatComposerFace.voice.isAccented)
        #expect(!ChatComposerFace.disabled("x").isAccented)

        #expect(ChatComposerFace.voice.label == "Start a voice chat")
        #expect(ChatComposerFace.send.help == "Send  ↩")
        #expect(ChatComposerFace.stop.help == "Stop  ⌘.")
        #expect(ChatComposerFace.disabled("You've reached your weekly limit.").help == "You've reached your weekly limit.")
        #expect(!ChatComposerFace.busy("x").isEnabled)
        #expect(ChatComposerFace.voice.isEnabled)
    }

    // MARK: - Placeholders

    /// The web's ladder, in its order (`composer.tsx`).
    @Test
    func thePlaceholderLadderFollowsTheWeb() {
        #expect(ChatComposerPlaceholder.text() == "Message Juno…")
        #expect(ChatComposerPlaceholder.text(modality: "image") == "Describe an image to generate…")
        #expect(ChatComposerPlaceholder.text(modality: "video") == "Describe a video to generate…")
        #expect(ChatComposerPlaceholder.text(isPrivate: true) == "How can I help you today?")
        #expect(ChatComposerPlaceholder.text(isPrivate: true, isClarifying: true) == "Or type your own answer…")
        #expect(ChatComposerPlaceholder.text(quote: .modify) == "Describe the change…")
        #expect(ChatComposerPlaceholder.text(quote: .ask) == "Ask about this selection…")
        #expect(ChatComposerPlaceholder.text(steering: .question) == "Answer Juno's question…")
        #expect(ChatComposerPlaceholder.text(steering: .task) == "Add an instruction to the running task…")
        #expect(ChatComposerPlaceholder.text(steering: .research) == "Add a constraint, or paste a source to include…")
    }

    // MARK: - Quota

    /// A plan with no allowance is not "reached"; the week is named before the
    /// five hours; an unlimited plan never locks.
    @Test
    func theQuotaNamesTheWindowThatIsSpent() {
        #expect(ChatComposerQuota(isUnlimited: true, isBrowseOnly: false, weeklyFraction: 2, sessionFraction: 2) == nil)
        #expect(ChatComposerQuota(isUnlimited: false, isBrowseOnly: false, weeklyFraction: 0.99, sessionFraction: 0.5) == nil)
        #expect(ChatComposerQuota(isUnlimited: false, isBrowseOnly: true, weeklyFraction: 0, sessionFraction: 0) == .noMessages)
        #expect(ChatComposerQuota(isUnlimited: false, isBrowseOnly: false, weeklyFraction: 1, sessionFraction: 1) == .weeklyLimit)
        #expect(ChatComposerQuota(isUnlimited: false, isBrowseOnly: false, weeklyFraction: 0.4, sessionFraction: 1) == .fiveHourLimit)

        #expect(ChatComposerQuota.noMessages.message == "The Free plan doesn't include any messages.")
        #expect(ChatComposerQuota.noMessages.action == "Upgrade to start chatting")
        #expect(ChatComposerQuota.weeklyLimit.action == "Upgrade to keep chatting")
    }

    // MARK: - Armed marks

    /// Research, web search, connectors, documents — in the web's order — and
    /// never a mark for memory, which is true of every message.
    @Test
    func marksFollowTheWebOrder() {
        let marks = ChatComposerMark.marks(
            researchDepth: .deep,
            webSearch: true,
            connectors: [(id: "github", label: "GitHub")],
            documentCount: 3
        )
        #expect(marks.map(\.id) == ["research", "web", "connector:github", "documents"])
        #expect(marks[0].label == "Deep research")
        #expect(marks[0].detail == "Deep")
        #expect(marks[2].glyph == .connector("github"))
        #expect(marks.allSatisfy { !$0.label.localizedCaseInsensitiveContains("memory") })
        #expect(ChatComposerMark.marks(researchDepth: nil, webSearch: false, connectors: [], documentCount: nil).isEmpty)
    }

    /// Two, then one mark standing for the rest, which names them all.
    @Test
    func marksStopAtTwoAndCountTheRest() {
        let marks = ChatComposerMark.marks(
            researchDepth: .standard,
            webSearch: true,
            connectors: [(id: "github", label: "GitHub"), (id: "notion", label: "Notion")],
            documentCount: nil
        )
        let split = ChatComposerMark.visible(marks)
        #expect(split.shown.map(\.id) == ["research", "web"])
        #expect(split.rest.map(\.id) == ["connector:github", "connector:notion"])

        let overflow = ChatComposerMark.overflow(for: split.rest)
        #expect(overflow.label == "2 more")
        #expect(overflow.help == "GitHub, Notion")
        #expect(overflow.glyph == .icon(.more))
    }

    // MARK: - The model

    /// The composer always has a model: the pick, then the conversation's, then
    /// Auto — and Auto by id before the catalog has loaded.
    @Test
    func theModelFallsBackToAutoRatherThanToNothing() {
        let auto = model("juno:auto", provider: "juno", automatic: true)
        let claude = model("anthropic:claude", provider: "anthropic")

        #expect(DesktopChatSelection.resolvedModelID(current: "", conversationModel: "", selectable: []) == ChatComposerModels.autoModelID)
        #expect(DesktopChatSelection.resolvedModelID(current: "", conversationModel: "gone", selectable: []) == "gone")
        #expect(DesktopChatSelection.resolvedModelID(current: "gone", conversationModel: "gone", selectable: [claude, auto]) == auto.id)
        #expect(DesktopChatSelection.resolvedModelID(current: claude.id, conversationModel: "", selectable: [auto, claude]) == claude.id)
        #expect(DesktopChatSelection.resolvedModelID(current: "", conversationModel: "", selectable: [claude]) == claude.id)
        #expect(auto.isJunoAuto)
        #expect(!claude.isJunoAuto)
    }

    /// Stage one's frame is stated before the panel exists (crash rule 2): the
    /// row band alone for Auto and for a model with nothing to set, the band
    /// plus the rule and the panel otherwise.
    @Test
    func stageOneStatesItsHeightFromTheScale() {
        let auto = model("juno:auto", provider: "juno", automatic: true)
        let tiered = model("openai:gpt", provider: "openai", efforts: [.low, .medium, .high])

        #expect(JunoThinkingPopover.height(for: nil) == 0)
        #expect(JunoThinkingPopover.height(for: NativeThinkingScale(model: auto)) == 0)
        #expect(ComposerModelChip.settingsHeight(for: NativeThinkingScale(model: auto)) == ComposerModelChip.settingsRowBand)

        let scale = NativeThinkingScale(model: tiered)
        #expect(JunoThinkingPopover.height(for: scale) == JunoThinkingMetrics.height)
        #expect(ComposerModelChip.settingsHeight(for: scale) == ComposerModelChip.settingsRowBand + 1 + JunoThinkingMetrics.height)
    }

    // MARK: - The dock

    /// A draft's group sits a little above the column's middle; a short column
    /// never pushes it below the resting lift.
    @Test
    func aDraftIsLiftedToTheOpticalCentre() {
        #expect(ChatComposerLift.draft(columnHeight: 800, groupHeight: 200) == 324)
        #expect(ChatComposerLift.draft(columnHeight: 240, groupHeight: 300) == ChatComposerLift.resting)
        #expect(ChatComposerLift.draft(columnHeight: 0, groupHeight: 200) == ChatComposerLift.resting)
    }

    /// The chips hang below the composer rather than sitting in the bar, so
    /// the padding under the composer carries their height as well: the
    /// group, chips and all, is what stays on the optical centre.
    @Test
    func theChipsBelowTheComposerAreClearedByTheLift() {
        #expect(ChatComposerLift.draft(columnHeight: 800, groupHeight: 244, footerHeight: 44) == 346)
        #expect(
            ChatComposerLift.draft(columnHeight: 240, groupHeight: 300, footerHeight: 44)
                == ChatComposerLift.resting + 44
        )
    }

    // MARK: - Fixtures

    private func model(
        _ id: String,
        provider: String,
        automatic: Bool = false,
        efforts: [NativeReasoningEffort] = []
    ) -> NativeChatModelOption {
        NativeChatModelOption(
            id: id,
            providerID: provider,
            providerName: provider,
            displayName: id,
            minimumPlan: "free",
            availability: "available",
            supportedReasoningEfforts: efforts,
            canDisableReasoning: !efforts.isEmpty,
            supportsReasoning: automatic || !efforts.isEmpty,
            choosesReasoningAutomatically: automatic,
            supportsStreaming: true
        )
    }
}
