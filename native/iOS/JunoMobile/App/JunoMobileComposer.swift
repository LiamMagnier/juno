import JunoChatKit
#if DEBUG
import JunoPreviewSupport
#endif
import JunoDesignSystem
import JunoStorage
import JunoVoiceKit
import SwiftUI

/// The chat composer: one Liquid Glass container holding the pending
/// attachments, the message editor, and beneath them a single row of compact
/// controls — `+`, the model, Thinking, then Send. The model and Thinking
/// controls live *inside* this container rather than above it, because they are
/// part of composing a message, not settings.
///
/// The composer also serves the **draft** state, where no conversation exists
/// yet: `conversation` is nil and `startConversation` creates the row on the
/// first send. That is what keeps a chat the reader opened and abandoned out of
/// the sidebar.
struct JunoMobileComposer: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    /// Nil while composing a draft — the conversation is created on first send.
    var conversation: NativeConversation?
    var projects: [NativeProject] = []
    @Binding var prompt: String
    @Binding var selectedModelID: String
    @Binding var reasoningEffort: NativeReasoningEffort?
    /// The one line explaining a thinking level that had to move when the model
    /// changed. Cleared by the owner once shown.
    @Binding var thinkingNotice: String?
    /// Owns the pending uploads. Held by the shell, not here, so a queued
    /// attachment survives navigating away and back.
    var attachmentModel: NativeComposerAttachmentModel?
    /// The per-message tools the `+` menu switches: research, web search,
    /// canvas, connectors. Owned by the chat screen so they survive the
    /// composer's own re-renders and reset when the conversation changes.
    @Bindable var tools: JunoMobileComposerTools
    /// The account's connected apps, already filtered to the connected ones.
    var connectors: [NativeConnector] = []
    /// Settings › Memory, surfaced in the menu as the web surfaces it.
    var memoryEnabled: Bool = true
    var setMemoryEnabled: ((Bool) -> Void)?
    /// Opens the library picker. Nil where the shell has no library model.
    var openLibrary: (() -> Void)?
    /// Which attachment surface is up. Owned by the chat screen, which is also
    /// where the surfaces themselves are installed — see
    /// `junoAttachmentSurfaces(coordinator:attachmentModel:conversationID:)`.
    var attachmentCoordinator: JunoMobileAttachmentCoordinator
    /// Opens the app's connected apps. Nil where there is nothing to navigate.
    var openPlugins: (() -> Void)?
    /// Starts a spoken conversation. Nil where no voice session is available, in
    /// which case the primary action never offers one — see
    /// ``composerActionButton``.
    var openVoiceMode: (() -> Void)?
    /// Creates the conversation a draft send belongs to and returns its id.
    /// Nil inside an existing conversation.
    var startConversation: (() async -> String?)?
    var composerFocused: FocusState<Bool>.Binding

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Set while a draft's conversation is being created, so a second tap on
    /// Send cannot create a second conversation.
    @State private var isStarting = false
    /// Whether Dictate Mode has taken over the composer.
    @State private var dictating = false

    private var selectedModel: NativeChatModelOption? {
        model.modelCatalog.first { $0.id == selectedModelID }
    }

    private var thinkingScale: NativeThinkingScale? {
        selectedModel.map(NativeThinkingScale.init)
    }

    private var generatingHere: Bool {
        guard let conversation else { return false }
        return model.isGenerating && model.activeChatConversationID == conversation.id
    }

    private var attachments: [NativeComposerAttachment] {
        attachmentModel?.attachments ?? []
    }

    /// Send is blocked while any upload is still in flight. Sending a message
    /// that references an attachment the server has not accepted produces a
    /// message with a missing file, which cannot be repaired from the client.
    private var sendDisabled: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || model.isGenerating
            || isStarting
            || conversation?.isPending == true
            || attachmentModel.map { !$0.canSend } == true
    }

    var body: some View {
        VStack(spacing: 8) {
            if model.canRetrySelectedConversation && !model.isGenerating {
                retryBanner
            }

            // Above the composer, not below it: under the container it would sit
            // in the home-indicator strip and go unread.
            if let thinkingNotice {
                notice(thinkingNotice, symbol: "info.circle", tint: Color.secondary)
                    .accessibilityIdentifier("juno.mobile.thinking-notice")
            }
            if let attachmentError = attachmentModel?.lastErrorDescription {
                notice(attachmentError, symbol: "exclamationmark.circle", tint: Color.orange)
                    .accessibilityIdentifier("juno.mobile.attachment-error")
            }
            // A photo the picker accepted and the app could not read is its own
            // failure, separate from an upload that was refused.
            if let importError = attachmentCoordinator.importError {
                notice(importError, symbol: "exclamationmark.circle", tint: Color.orange)
                    .accessibilityIdentifier("juno.mobile.attachment-import-error")
            }

            // Deep research runs PLAN → SEARCH → READ for tens of seconds before
            // the first token of the report. Without the live step above the
            // composer that whole stretch is an empty bubble and a spinner,
            // which reads as a hung app rather than as work in progress.
            if tools.deepResearch || !model.researchActivity.isEmpty {
                JunoMobileResearchProgress(
                    enabled: tools.deepResearch,
                    activity: model.researchActivity,
                    degradedWarning: model.researchDegradedWarning,
                    onDisable: { tools.deepResearch = false }
                )
                .transition(.opacity)
            }

            // Dictation REPLACES the composer rather than sitting beside it: it
            // owns the microphone, the transcript and the send action for as long
            // as it is up, and leaving the text field visible underneath invited
            // typing into a field whose contents were about to be overwritten.
            if dictating {
                JunoMobileDictation(
                    onCancel: { setDictating(false) },
                    onStop: { transcript in
                        setDictating(false)
                        appendDictated(transcript)
                        composerFocused.wrappedValue = true
                    },
                    onSend: { transcript in
                        setDictating(false)
                        appendDictated(transcript)
                        send()
                    }
                )
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            } else {
                VStack(spacing: 8) {
                    if !attachments.isEmpty, let attachmentModel {
                        JunoMobileAttachmentChips(
                            attachments: attachments,
                            onRemove: { attachmentModel.remove($0) },
                            onRetry: { attachmentModel.retry($0, conversationID: conversation?.id) }
                        )
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    TextField("Message Juno", text: $prompt, axis: .vertical)
                        .lineLimit(1...6)
                        .textFieldStyle(.plain)
                        .focused(composerFocused)
                        .padding(.horizontal, 8)
                        .padding(.top, 4)
                        .accessibilityIdentifier("juno.mobile.chat-composer")

                    controlRow
                }
                .padding(8)
                .background(JunoGlassBackground(cornerRadius: 26))
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: sendDisabled)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: generatingHere)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: thinkingNotice)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: attachments.count)
        .task { await applyPreviewFlags() }
    }

    private func notice(_ text: String, symbol: String, tint: Color) -> some View {
        Label(text, systemImage: symbol)
            .font(.caption2)
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6)
            .transition(.opacity)
    }

    /// Drives the composer into one exact state for visual QA. No effect — and
    /// no code — outside DEBUG.
    private func applyPreviewFlags() async {
        #if DEBUG
        if let forced = JunoComposerPreviewFlags.forcedModelID {
            // The catalog arrives asynchronously; without waiting, a scripted
            // screenshot silently lands on whatever was selected by default.
            for _ in 0..<20 where !model.modelCatalog.contains(where: { $0.id == forced }) {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            if model.modelCatalog.contains(where: { $0.id == forced }) {
                selectedModelID = forced
            }
        }
        if let level = JunoComposerPreviewFlags.forcedThinkingLevel {
            reasoningEffort = level
        }
        if JunoComposerPreviewFlags.focusesComposer {
            composerFocused.wrappedValue = true
        }
        #endif
    }

    /// `+` · model · Thinking · phase · mic · Send.
    ///
    /// The trailing pair is the website's own: a microphone for Dictate Mode, a
    /// hairline, then **one** primary action that morphs in place —
    /// voice when there is nothing to send, Send once there is, Stop while a reply
    /// is arriving. One slot for the primary action means the reader's thumb
    /// learns one position, and the glyph tells them what it will do.
    private var controlRow: some View {
        HStack(spacing: 6) {
            JunoMobileComposerActions(
                projects: projects,
                selectedProjectID: conversation?.projectId,
                canPickProject: conversation != nil,
                canAttach: attachmentModel?.hasCapacity ?? false,
                canOpenPlugins: openPlugins != nil,
                tools: tools,
                // Unknown model → assume it can. The server is the authority and
                // refuses the flag on a model without the capability; guessing
                // "no" here would hide the switch while the catalog loads.
                modelSupportsWebSearch: selectedModel?.supportsWebSearch ?? true,
                memoryEnabled: memoryEnabled,
                setMemoryEnabled: setMemoryEnabled,
                connectors: connectors,
                setProject: { projectID in
                    guard let conversation else { return }
                    await model.setProject(id: conversation.id, projectID: projectID)
                },
                open: open,
                openLibrary: openLibrary.map { open in
                    {
                        // Same rule as Camera and Photos: the sheet takes the
                        // screen, and a keyboard still on its way out while it
                        // arrives is the layout jump this all exists to remove.
                        composerFocused.wrappedValue = false
                        open()
                    }
                },
                startCanvas: startCanvas,
                openPlugins: { openPlugins?() }
            )

            JunoMobileModelControl(
                models: model.modelCatalog,
                selectedModelID: $selectedModelID,
                fallbackName: junoDisplayModelName(conversation?.model ?? "")
            )
            .layoutPriority(1)

            if let thinkingScale {
                JunoMobileThinkingControl(scale: thinkingScale, effort: $reasoningEffort)
                    .layoutPriority(2)
            }

            Spacer(minLength: 2)

            if model.chatPhase != .idle {
                phaseIndicator
            }

            if canDictate {
                dictateButton
                // The hairline is what makes the trailing pair read as *two*
                // controls rather than as one two-part button.
                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(width: 1, height: 20)
                    .padding(.horizontal, 1)
                    .accessibilityHidden(true)
            }

            composerActionButton
        }
    }

    /// Offered only where it can actually work. A Simulator with no recognizer,
    /// or a device where speech is restricted, gets no microphone at all rather
    /// than one that opens a capsule and immediately apologises.
    private var canDictate: Bool {
        JunoSpeechService.isSupported && !generatingHere
    }

    private var dictateButton: some View {
        Button {
            // The keyboard goes first: the capsule takes the field's place, and a
            // keyboard still on its way out while it arrives is the layout jump
            // the attachment surfaces already learned to avoid.
            composerFocused.wrappedValue = false
            setDictating(true)
        } label: {
            Image(systemName: "mic")
                .font(.system(size: 16))
                .foregroundStyle(Color.primary.opacity(0.75))
                .frame(width: 34, height: 34)
                .frame(width: 40, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dictate")
        .accessibilityIdentifier("juno.mobile.chat-dictate")
    }

    private func setDictating(_ active: Bool) {
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
            dictating = active
        }
    }

    /// Puts a dictated passage into the draft without discarding what was already
    /// typed — dictation continues a message, it does not replace one.
    private func appendDictated(_ transcript: String) {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let existing = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        prompt = existing.isEmpty ? text : "\(existing) \(text)"
    }

    private var phaseIndicator: some View {
        HStack(spacing: 5) {
            if isStreamingPhase {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: phaseSymbol)
            }
            Text(phaseLabel)
                .lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(phaseLabel)
    }

    private var retryBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(model.chatErrorDescription ?? "The response was interrupted.")
                .lineLimit(2)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button("Retry") {
                guard let conversation else { return }
                model.retryLastMessage(conversationID: conversation.id)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("juno.mobile.chat-retry")
        }
        .font(.caption)
    }

    private var isStreamingPhase: Bool {
        switch model.chatPhase {
        case .appending, .submitting, .reasoning, .streaming, .reconnecting: true
        case .idle, .stopping, .failed: false
        }
    }

    private var phaseLabel: String {
        switch model.chatPhase {
        case .idle: "Ready"
        case .appending: "Saving message"
        case .submitting: "Starting"
        case .reasoning: "Reasoning"
        case .streaming: "Writing"
        case .stopping: "Stopping"
        case .reconnecting: "Reconnecting"
        case .failed: "Interrupted"
        }
    }

    private var phaseSymbol: String {
        switch model.chatPhase {
        case .reconnecting: "wifi.exclamationmark"
        case .failed: "exclamationmark.circle"
        case .stopping: "stop.circle"
        default: "sparkles"
        }
    }

    /// The one primary action, in three states.
    ///
    /// The web's rule, ported exactly: **Stop** while a reply is arriving,
    /// **Voice** when there is nothing to send, **Send** once there is. The slot,
    /// the circle and the coral never move — only the glyph changes — so the
    /// control reads as one thing doing the obvious next thing rather than as
    /// three buttons taking turns.
    ///
    /// Voice appears only when there is somewhere for it to go. That is the same
    /// `!!onOpenVoiceMode` guard the web applies, and it is what keeps a shell
    /// with no voice session from offering a button that does nothing: without a
    /// handler this falls back to the discreet disabled Send.
    ///
    /// Every state carries the same 44pt-tall `contentShape` as the "+": they had
    /// the identical 32pt-frame-without-content-shape construction, so they had
    /// the identical shrunken touch target. Stop especially must not be hard to
    /// hit — it is the control you reach for when something is going wrong.
    @ViewBuilder
    private var composerActionButton: some View {
        if generatingHere {
            Button {
                model.stopGeneration()
            } label: {
                actionLabel(active: true) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 14, weight: .bold))
                }
            }
            .buttonStyle(.plain)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Stop generation")
            .accessibilityIdentifier("juno.mobile.chat-stop")
        } else if showsVoiceAction, let openVoiceMode {
            Button(action: openVoiceMode) {
                actionLabel(active: true) { JunoMobileVoiceWave() }
            }
            .buttonStyle(.plain)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Start voice conversation")
            .accessibilityIdentifier("juno.mobile.chat-voice")
        } else {
            Button(action: send) {
                actionLabel(active: !sendDisabled) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                }
                .scaleEffect(sendDisabled ? 0.92 : 1)
            }
            .buttonStyle(.plain)
            .disabled(sendDisabled)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("juno.mobile.chat-send")
        }
    }

    /// Voice takes the slot exactly when Send has nothing to do — which is what
    /// makes the two feel like one control rather than a choice.
    private var showsVoiceAction: Bool {
        openVoiceMode != nil
            && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.isGenerating
            && !isStarting
    }

    private func actionLabel<Glyph: View>(
        active: Bool,
        @ViewBuilder glyph: () -> Glyph
    ) -> some View {
        glyph()
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .modifier(JunoComposerSendBackground(active: active))
            .frame(width: 40, height: 44)
            .contentShape(Rectangle())
    }

    // MARK: Attachments


    /// Opens one attachment surface.
    ///
    /// The keyboard goes first for Camera and Photos — both take the lower half
    /// of the screen, and a keyboard still on its way out while they arrive is
    /// the layout jump this feature exists to remove. Opening the menu itself
    /// does nothing to focus at all, which is the point of it being a menu.
    private func open(_ surface: JunoAttachmentSurface) {
        if surface.dismissesKeyboard { composerFocused.wrappedValue = false }
        attachmentCoordinator.present(surface, reduceMotion: reduceMotion)
    }

    /// "Create a canvas": turn artifacts on and hand the reader a sentence to
    /// finish. Ported from the web's `startCanvas` — including the rule that an
    /// existing draft is never overwritten, because the row is next to Photos and
    /// Files and a mis-tap must not eat what someone was typing.
    private func startCanvas() {
        tools.canvas = true
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            prompt = String(localized: "composer.canvas.seed")
        }
        composerFocused.wrappedValue = true
    }


    // MARK: Send

    private func send() {
        let attachmentIDs = attachmentModel?.uploadedIDs ?? []
        // Read the tools once, here, and let the read disarm research. Reading
        // them again inside `deliver` would mean a draft's send resolved them
        // *after* the conversation was created — an await during which the menu
        // is still live.
        let options = tools.consumeForSend()
        if let conversation {
            deliver(
                conversationID: conversation.id,
                attachmentIDs: attachmentIDs,
                options: options
            )
            return
        }
        // Draft: create the conversation, then send into it. Sending first and
        // creating after would leave the message with nowhere to land.
        guard let startConversation else { return }
        isStarting = true
        Task {
            let created = await startConversation()
            isStarting = false
            guard let created else { return }
            deliver(
                conversationID: created,
                attachmentIDs: attachmentIDs,
                options: options
            )
        }
    }

    private func deliver(
        conversationID: String,
        attachmentIDs: [String],
        options: JunoMobileComposerTools.Sent
    ) {
        let sent = model.sendMessage(
            conversationID: conversationID,
            prompt: prompt,
            modelID: selectedModelID.isEmpty
                ? (conversation?.model ?? selectedModelID) : selectedModelID,
            reasoningEffort: reasoningEffort,
            attachmentIDs: attachmentIDs,
            deepResearch: options.deepResearch,
            webSearch: options.webSearch,
            // Only ever sent as `false`. Canvas defaults to on server-side, so
            // `nil` is how "leave it alone" is said and `true` would be noise.
            canvasEnabled: options.canvas ? nil : false,
            connectors: options.connectors
        )
        guard sent else { return }
        prompt = ""
        attachmentModel?.clear()
        // The title is generated from the first turn, exactly as the web does —
        // see NativeConversationModel.generateTitleIfNeeded.
        Task { await model.generateTitleIfNeeded(conversationID: conversationID) }
    }
}

/// The composer's selection rules, kept as pure functions so the fallback
/// behaviour is testable without standing up a view.
enum JunoMobileComposerSelection {
    /// The model the composer should be on.
    ///
    /// Preference order: keep the current choice if it is still selectable, then
    /// the conversation's own model, then **the account's default model**, then the
    /// first selectable one. The conversation's model is the last resort when
    /// nothing is selectable at all, so the composer still names something real
    /// rather than going blank.
    ///
    /// The account default used to be missing entirely, and the fallthrough landed
    /// on `selectable.first` — which is `juno:auto`. So a reader who had chosen a
    /// default in Settings opened the app on Auto every time, and the setting they
    /// had changed appeared to do nothing.
    static func resolvedModelID(
        current: String,
        conversationModel: String,
        accountDefault: String = "",
        selectable: [NativeChatModelOption]
    ) -> String {
        if !current.isEmpty, selectable.contains(where: { $0.id == current }) {
            return current
        }
        if selectable.contains(where: { $0.id == conversationModel }) {
            return conversationModel
        }
        if !accountDefault.isEmpty, selectable.contains(where: { $0.id == accountDefault }) {
            return accountDefault
        }
        return selectable.first?.id ?? conversationModel
    }
}

/// The voice action's glyph: five bars rising to the centre.
///
/// Ported from the web's `.composer-voice-wave` — the same five bars at the same
/// heights (5 · 9 · 13 · 9 · 5), 1.5pt wide with 1.5pt gaps in a 17×16 box. It is
/// deliberately **not** a microphone: a mic glyph in the send slot reads as
/// "record something", and this is an action that opens a conversation.
///
/// The bars breathe rather than dance. On the web the animation is a hover
/// affordance, which a phone has no equivalent of, so here it runs continuously
/// at a low amplitude — enough to say the control is live, quiet enough to sit
/// beside a text field. Reduce Motion holds them at rest, where the shape still
/// reads.
struct JunoMobileVoiceWave: View {
    private static let heights: [Double] = [5, 9, 13, 9, 5]
    private static let cycle: Double = 1.6

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let phase = reduceMotion
                ? nil
                : context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: Self.cycle) / Self.cycle

            HStack(alignment: .center, spacing: 1.5) {
                ForEach(Array(Self.heights.enumerated()), id: \.offset) { index, height in
                    Capsule(style: .continuous)
                        .frame(width: 1.5, height: height * scale(index, phase: phase))
                }
            }
            .frame(width: 17, height: 16)
        }
        .accessibilityHidden(true)
    }

    /// The web's `composer-wave` keyframes — 1 → 0.48 at 38% → 1.24 at 70% → 1 —
    /// with each bar entering 45ms after the one before it.
    private func scale(_ index: Int, phase: Double?) -> Double {
        guard let phase else { return 1 }
        let offset = (phase - Double(index) * 0.045 / Self.cycle)
            .truncatingRemainder(dividingBy: 1)
        let t = offset < 0 ? offset + 1 : offset
        switch t {
        case ..<0.38: return interpolate(1, 0.48, t / 0.38)
        case ..<0.70: return interpolate(0.48, 1.24, (t - 0.38) / 0.32)
        default: return interpolate(1.24, 1, (t - 0.70) / 0.30)
        }
    }

    private func interpolate(_ from: Double, _ to: Double, _ t: Double) -> Double {
        from + (to - from) * min(max(t, 0), 1)
    }
}

/// A circular coral Liquid Glass background for the composer's send/stop button,
/// with a material fallback below OS 26. When inactive the coral tint fades to a
/// discreet level so the disabled state stays legible without shouting.
struct JunoComposerSendBackground: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(
                    .regular.tint(Color.junoAccent.opacity(active ? 0.95 : 0.32)).interactive(),
                    in: Circle()
                )
        } else {
            content
                .background(Color.junoAccent.opacity(active ? 1 : 0.35), in: Circle())
        }
    }
}

/// A neutral (non-accent) circular Liquid Glass background for the composer's
/// "+" button, with a material fallback below OS 26.
struct JunoComposerGlassCircle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: Circle())
        } else {
            content
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}
