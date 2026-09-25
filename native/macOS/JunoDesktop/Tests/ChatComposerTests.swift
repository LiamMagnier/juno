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
    // MARK: - A prompt handed over

    /// Quick Entry's text lands even over a half-typed draft, which keeps its
    /// words: it never waits, pending, for some later empty field.
    @Test
    func aHandedOverPromptLandsOverAHalfTypedDraft() {
        #expect(ChatComposer.draft(consuming: "Plan a trip", into: "") == "Plan a trip")
        #expect(ChatComposer.draft(consuming: "Plan a trip", into: "Half a thought") == "Half a thought\n\nPlan a trip")
        #expect(ChatComposer.draft(consuming: "  ", into: "Half a thought") == "Half a thought")
        #expect(ChatComposer.draft(consuming: " Plan a trip \n", into: "   ") == "Plan a trip")
    }

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
        #expect(ChatComposerPlaceholder.text(steering: .question) == "Answer Juno\u{2019}s question…")
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
            research: true,
            webSearch: true,
            connectors: [(id: "github", label: "GitHub")],
            documentCount: 3
        )
        #expect(marks.map(\.id) == ["research", "web", "connector:github", "documents"])
        // One feature, no levels: "Research", no depth detail (SPEC §9.9).
        #expect(marks[0].label == "Research")
        #expect(marks[0].detail == nil)
        #expect(marks[0].help == "Research on")
        #expect(marks[0].removeLabel == "Turn off Research")
        #expect(marks.allSatisfy { !($0.help.contains("Deep") || $0.label.contains("Deep")) })
        #expect(marks[2].glyph == .connector("github"))
        #expect(marks.allSatisfy { !$0.label.localizedCaseInsensitiveContains("memory") })
        #expect(ChatComposerMark.marks(research: false, webSearch: false, connectors: [], documentCount: nil).isEmpty)
    }

    /// The model starts tasks (Phase 5 A3): there is no task mark to arm,
    /// and nothing in the `+` menu's marks names one.
    @Test
    func thereIsNoTaskMark() {
        let marks = ChatComposerMark.marks(
            research: true, webSearch: true, connectors: [], documentCount: nil
        )
        #expect(marks.map(\.id) == ["research", "web"])
        #expect(marks.allSatisfy { !$0.label.localizedCaseInsensitiveContains("task") })
    }

    /// Two, then one mark standing for the rest, which names them all.
    @Test
    func marksStopAtTwoAndCountTheRest() {
        let marks = ChatComposerMark.marks(
            research: true,
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

    // MARK: - Steering (Phase 5 A6)

    /// The web's placeholder ladder: steer mode first, then a clarification,
    /// a quote, the surface's own line, the modality's, "Message Juno…".
    @Test
    func steeringLeadsThePlaceholderLadder() {
        #expect(ChatComposerPlaceholder.text(isClarifying: true, quote: .ask, steering: .task)
            == "Add an instruction to the running task…")
        #expect(ChatComposerPlaceholder.text(isClarifying: true, quote: .ask) == "Or type your own answer…")
        #expect(ChatComposerPlaceholder.text(quote: .ask, custom: "Message Ada…") == "Ask about this selection…")
        #expect(ChatComposerPlaceholder.text(isPrivate: true, custom: "Message Ada…") == "Message Ada…")
        #expect(ChatComposerPlaceholder.text(modality: "image", custom: "Message Ada…") == "Message Ada…")
    }

    /// The disc in steer mode: an empty field is the run's Stop, named for
    /// what it ends; words are its Send, named for where they go.
    @Test
    func theDiscInSteerMode() {
        let task = (sendLabel: "Add this to the running task", stopLabel: "Stop the task")
        let empty = ChatComposerDisc.resolve(
            isGenerating: false, hasDraft: false, blockedReason: nil, waitingReason: nil, steering: task
        )
        #expect(empty.face == .stop)
        #expect(empty.label == "Stop the task")

        let draft = ChatComposerDisc.resolve(
            isGenerating: false, hasDraft: true, blockedReason: nil, waitingReason: nil, steering: task
        )
        #expect(draft.face == .send)
        #expect(draft.label == "Add this to the running task")
        #expect(draft.help == "Add this to the running task  \u{21A9}")

        // A reply streaming beside a live task: Stop names the reply.
        let streaming = ChatComposerSteering.task(
            answering: false, isGenerating: true, pending: [], steer: { _ in true }, stop: {}
        )
        #expect(streaming.stopLabel == "Stop generating")
        let streamingDisc = ChatComposerDisc.resolve(
            isGenerating: true, hasDraft: false, blockedReason: nil, waitingReason: nil,
            steering: (streaming.sendLabel, streaming.stopLabel)
        )
        #expect(streamingDisc.face == .stop)
        #expect(streamingDisc.label == "Stop generating")

        let research = ChatComposerSteering.research(steer: { _ in true }, stop: {})
        let researchDisc = ChatComposerDisc.resolve(
            isGenerating: true, hasDraft: true, blockedReason: nil, waitingReason: nil,
            steering: (research.sendLabel, research.stopLabel)
        )
        #expect(researchDisc.label == "Add to the research")
        #expect(research.stopLabel == "Stop the research")

        // Outside steer mode, the faces are the composer's own.
        let plain = ChatComposerDisc.resolve(
            isGenerating: false, hasDraft: false, blockedReason: nil, waitingReason: nil
        )
        #expect(plain.face == .voice)
        #expect(plain.label == nil)
    }

    /// The web's labels, verbatim.
    @Test
    func steeringLabels() {
        let answer = ChatComposerSteering.task(
            answering: true, isGenerating: false, pending: [], steer: { _ in true }, stop: {}
        )
        #expect(answer.kind == .answer)
        #expect(answer.placeholder == "Answer Juno\u{2019}s question…")
        #expect(answer.sendLabel == "Answer the task\u{2019}s question")
        #expect(answer.stopLabel == "Stop the task")
        let instruction = ChatComposerSteering.task(
            answering: false, isGenerating: false, pending: [], steer: { _ in true }, stop: {}
        )
        #expect(instruction.placeholder == "Add an instruction to the running task…")
        #expect(instruction.sendLabel == "Add this to the running task")
        let research = ChatComposerSteering.research(steer: { _ in true }, stop: {})
        #expect(research.placeholder == "Add a constraint, or paste a source to include…")
    }

    /// Steer mode: a task steers with nothing streaming; research only while
    /// its turn streams; never while a clarification is being answered.
    @Test
    func steerModeRule() {
        let task = ChatComposerSteering.task(
            answering: false, isGenerating: false, pending: [], steer: { _ in true }, stop: {}
        )
        let research = ChatComposerSteering.research(steer: { _ in true }, stop: {})
        #expect(ChatComposerSteering.isSteering(task, isGenerating: false))
        #expect(!ChatComposerSteering.isSteering(research, isGenerating: false))
        #expect(ChatComposerSteering.isSteering(research, isGenerating: true))
        #expect(!ChatComposerSteering.isSteering(task, isGenerating: false, isClarifying: true))
        #expect(!ChatComposerSteering.isSteering(nil, isGenerating: true))
    }

    /// A refused steer keeps the words: the steering closure says no, and the
    /// composer clears only on yes. The routing is the conversation's; here,
    /// the closure a fake follower hands over is what receives the text.
    @Test
    @MainActor
    func aSteerReachesTheRunAndARefusalIsReported() async {
        var received: [String] = []
        let refusing = ChatComposerSteering.task(
            answering: false, isGenerating: false, pending: [],
            steer: { text in received.append(text); return false }, stop: {}
        )
        let accepted = await refusing.steer("Use euros")
        #expect(accepted == false)
        #expect(received == ["Use euros"])
    }

}
