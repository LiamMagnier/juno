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
    var setMemoryEnabled: (@MainActor @Sendable (Bool) -> Void)?
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
    /// How tall the chat column is, measured by the screen that owns it.
    ///
    /// The voice field is sized from this rather than from anything the composer
    /// can see, because the light belongs to the conversation and the composer
    /// occupies a strip at the bottom of it. See ``auraLayer``.
    var chatColumnHeight: CGFloat = 0
    var composerFocused: FocusState<Bool>.Binding
    /// The swell an accepted send fires, owned by the screen because the light it
    /// drives is not always behind this view — see ``JunoMobileSendSwell``.
    var sendSwell: JunoMobileSendSwell
    /// True while the screen is showing its greeting.
    ///
    /// The bloom moves there when it is: the web lights the greeting and the
    /// composer with one element, and a second instance here would double every
    /// alpha in the ramp. See ``auraLayer`` and ``JunoMobileGreeting``.
    var greetingVisible: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    /// The call in progress, published by the shell. Non-nil is what puts the
    /// dock above this composer, the voice field behind it, and every voice-mode
    /// degradation below into effect. See ``JunoMobileVoiceSession``.
    @Environment(\.junoVoiceSession) private var voiceSession
    /// Set while a draft's conversation is being created, so a second tap on
    /// Send cannot create a second conversation.
    @State private var isStarting = false
    /// Set while a spoken turn is on the wire, so a second tap cannot send the
    /// same images twice.
    @State private var isSendingVoiceTurn = false
    /// Why the last spoken turn was refused. Shown in the same notice row as the
    /// attachment errors, because it is the same kind of news.
    @State private var voiceTurnError: String?
    /// Whether Dictate Mode has taken over the composer.
    @State private var dictating = false
    /// Whether a very large draft has been opened back up for editing. Huge
    /// pastes stay in `prompt` and are sent in full either way — this only
    /// decides whether they are live in the text field. See
    /// ``NativePromptLimits/composerInlineSoftCharacters``.
    @State private var draftExpanded = false

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

    // MARK: Voice mode

    /// What the composer becomes while a call is running, and the web's list
    /// exactly (`composer.tsx`, `voiceActive`): connectors and tools hidden, the
    /// library closed, dictation gone — it would fight the call for the
    /// microphone — and attachments narrowed to images.
    private var voiceActive: Bool { voiceSession != nil }

    /// Past four images a turn, providers start answering about the first one
    /// and ignoring the rest. The relay enforces the same ceiling; this is here
    /// so the reader is told before they compose a fifth.
    private static let maximumVoiceImages = 4

    /// Whether the model on the other end of the call can see at all.
    ///
    /// Read from what the relay said in `session.ready` rather than from a list
    /// of providers kept here, which would be a second copy to drift. Nil while
    /// connecting reads as "no", so the camera row is not offered a beat before
    /// it can work.
    private var voiceCanSeeImages: Bool {
        voiceSession?.controller.capabilities?.videoInput == true
    }

    private var canAttachInVoice: Bool {
        voiceCanSeeImages && attachments.count < Self.maximumVoiceImages
    }

    // MARK: Long drafts

    /// Whether the draft is long enough that sending it as a file is worth
    /// offering. An offer, never a rule — see ``NativePromptLimits``.
    private var isLongDraft: Bool {
        canAttachDraft && NativePromptLimits.isLongDraft(prompt)
    }

    /// Past this the draft leaves the text field entirely and shows as a card.
    /// A 40k-character paste in a `TextField(axis: .vertical)` re-measures the
    /// whole passage on every keystroke, on the main actor, and the composer
    /// stops accepting input long before the reader gets to Send.
    private var showsCollapsedDraft: Bool {
        NativePromptLimits.isHugeDraft(prompt) && !draftExpanded
    }

    /// Attaching needs somewhere to put the file. Without an attachment model —
    /// an unconfigured shell — the offer is absent rather than present and
    /// broken.
    private var canAttachDraft: Bool {
        attachmentModel?.hasCapacity ?? false
    }

    /// Sends the draft as `prompt.txt` instead of as message text.
    ///
    /// The web's `attachAsFile`, ported: same file name, same MIME type, and the
    /// same clearing of the draft afterwards, so a prompt attached on the phone
    /// and one attached in the browser arrive at the model as the same message.
    private func attachDraftAsFile() {
        let content = prompt
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let attachmentModel
        else { return }
        attachmentModel.add(
            data: Data(content.utf8),
            fileName: NativePromptLimits.attachedPromptFileName,
            mimeType: NativePromptLimits.attachedPromptMimeType,
            conversationID: conversation?.id,
            isImage: false
        )
        prompt = ""
        draftExpanded = false
    }

    /// Send is blocked while any upload is still in flight. Sending a message
    /// that references an attachment the server has not accepted produces a
    /// message with a missing file, which cannot be repaired from the client.
    private var sendDisabled: Bool {
        // Text *or* attachments, as the web has it: a message that is nothing
        // but the file you attached is a message. Requiring text here is what
        // made "Attach as file" leave a draft that could not be sent.
        (prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty)
            || model.isGenerating
            || isStarting
            || isSendingVoiceTurn
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
            if let voiceTurnError {
                notice(voiceTurnError, symbol: "exclamationmark.circle", tint: Color.orange)
                    .accessibilityIdentifier("juno.mobile.voice-turn-error")
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

            // The call's own controls, directly above the capsule and inside it,
            // so they ride the keyboard with everything else here rather than
            // being left behind by it.
            if let voiceSession {
                JunoMobileVoiceDock(session: voiceSession)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
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

                    if showsCollapsedDraft {
                        collapsedDraftCard
                            .transition(.opacity)
                    } else {
                        TextField("Message Juno", text: $prompt, axis: .vertical)
                            .lineLimit(1...6)
                            .textFieldStyle(.plain)
                            .focused(composerFocused)
                            .padding(.horizontal, 8)
                            .padding(.top, 4)
                            .accessibilityIdentifier("juno.mobile.chat-composer")

                        if isLongDraft {
                            attachAsFileOffer
                        }
                    }

                    controlRow
                }
                .padding(8)
                .background(JunoGlassBackground(cornerRadius: 26))
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        // The light behind the composer, and the one place it can be mounted.
        //
        // It has to be *here*, on the outer stack, and not on the capsule's own
        // `.background(JunoGlassBackground…)` a few lines up: a background of
        // the capsule paints inside the glass, over the text field, and washes
        // out what is being typed. A background of this stack paints behind the
        // whole composer, glass included, which is the sibling-at-z-index-minus-one
        // arrangement the web builds by hand.
        //
        // And it has to be inside this view, because this view is what a
        // `safeAreaInset` moves with the keyboard. Anything anchored to the
        // screen stays put while the composer rises away from it.
        //
        // Never in incognito: that mode is deliberately colourless, and its
        // composer is a different view entirely (``JunoMobileIncognitoChat``)
        // which never reaches this line.
        .background(alignment: .bottom) { auraLayer }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: sendDisabled)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: generatingHere)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: thinkingNotice)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: attachments.count)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: showsCollapsedDraft)
        // Once the draft is back under the inline ceiling, forget that it was
        // ever expanded — otherwise the *next* huge paste would land straight
        // in the text field, which is the state this card exists to avoid.
        .onChange(of: prompt) { _, text in
            if !NativePromptLimits.isHugeDraft(text) { draftExpanded = false }
        }
        // A refusal explains a turn that is no longer being attempted, so it
        // goes with the call it belonged to rather than sitting over the next
        // typed message.
        .onChange(of: voiceSession == nil) { _, ended in
            if ended { voiceTurnError = nil }
        }
        .task { await applyPreviewFlags() }
    }

    // MARK: Aura

    /// The two auras, which are mutually exclusive on purpose — and, once there
    /// is a greeting on screen, neither.
    ///
    /// A call replaces the composer's bloom with the voice field for its whole
    /// duration — the web makes the same swap, and for the same reason: two
    /// lights under one capsule read as a bug, and while someone is talking the
    /// thing worth reporting is the conversation, not which model is selected.
    ///
    /// The greeting takes it on the same terms. There is exactly one bloom in
    /// the browser and it is tall enough to light both the sentence and the
    /// capsule from one place; a SwiftUI background is sized by its host, so
    /// native gets the same result by *moving* the mount rather than by adding a
    /// second one — see ``JunoMobileGreeting``. That is what ``greetingVisible``
    /// decides, and why this view draws nothing at all on an empty screen.
    ///
    /// **The voice field is scoped to the column but mounted here, and that is a
    /// choice rather than an accident.** On the web the field is a sibling of the
    /// composer inside `.composer-aura-host` — a stacking context whose only job
    /// is to make `z-index: -1` mean "behind the composer" — and it overflows
    /// upward to `min(30rem, 46vh)`, framing the reading area from below. This
    /// background is that same arrangement: it paints behind the composer, glass
    /// included, and is free to overflow into the transcript above.
    ///
    /// The phone adds one constraint the browser does not have. This composer is
    /// installed as a `.safeAreaInset(edge: .bottom)`, and the inset's content is
    /// the *only* thing in the chat screen that rises with the keyboard — the
    /// scroll view keeps its frame and grows its safe area instead. A field
    /// anchored to the transcript, or to the screen, would therefore stay behind
    /// the keyboard the moment anyone typed during a call. So the mount point
    /// stays here, where it inherits keyboard tracking for free, and what changes
    /// is the box: ``chatColumnHeight`` carries the column's own measurement down
    /// so the field can be sized from the conversation rather than from the strip
    /// it happens to be mounted in.
    @ViewBuilder
    private var auraLayer: some View {
        if let voiceSession {
            JunoMobileVoiceField(
                controller: voiceSession.controller,
                columnHeight: chatColumnHeight
            )
        } else if !greetingVisible {
            // Only when nothing else is holding it. On an empty screen the
            // greeting carries the undocked bloom instead, because that is where
            // the web's one 32rem-tall element actually lands — see
            // ``JunoMobileGreeting``. Mounting it in both places would double
            // every alpha in the ramp.
            //
            // Through ``JunoMobileAuraLayer`` rather than straight into
            // `JunoComposerAura`: this bloom is regularly *born* with the send
            // already in flight — sending the first message is what takes the
            // greeting away and puts this one on screen — and an aura born hot
            // never sees the rising edge its swell needs.
            JunoMobileAuraLayer(
                light: light,
                // The dialled-down variant inside a conversation: there are
                // messages above it to stay out of the way of.
                docked: conversation != nil
            )
        }
    }

    /// The bloom's inputs, in the one form the greeting reads them too, so the
    /// two mount points cannot describe different light.
    private var light: JunoMobileAuraLight {
        JunoMobileAuraLight(
            model: selectedModel,
            effort: reasoningEffort,
            focused: composerFocused.wrappedValue,
            sending: sendSwell.active,
            viewport: chatColumnHeight,
            dark: colorScheme == .dark
        )
    }

    /// The quiet offer under a long draft: "That's a long one — attach it as a
    /// file to keep the chat tidy?" One line and one button, exactly as the web
    /// puts it, and it never touches the draft unless the button is tapped.
    private var attachAsFileOffer: some View {
        HStack(spacing: 8) {
            Text("That's a long one — send it as a file to keep the chat tidy?")
                .font(.system(size: 12))
                .foregroundStyle(Color.junoMutedForeground)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button(action: attachDraftAsFile) {
                HStack(spacing: 5) {
                    Image(systemName: "doc.badge.arrow.up")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Attach")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(Color.primary)
                .padding(.horizontal, 11)
                .frame(height: 28)
                .modifier(JunoGlassCapsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Send this message as a file")
            .accessibilityIdentifier("juno.mobile.chat-attach-draft")
        }
        .padding(.horizontal, 8)
        .transition(.opacity)
    }

    /// What a very large paste looks like in the composer: a card standing for
    /// the draft, not the draft itself.
    ///
    /// The text is untouched — it is still in `prompt` and Send still sends all
    /// of it. What has gone is the live `TextField`, which was re-measuring tens
    /// of thousands of characters on every keystroke and taking the composer
    /// with it. "Edit" puts it back, for a reader who really does want to work
    /// inside a 40,000-character prompt on a phone.
    private var collapsedDraftCard: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Long message ready to send")
                        .font(.system(size: 14, weight: .medium))
                    Text(
                        "\(prompt.count.formatted(.number)) characters · sent in full"
                    )
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.junoMutedForeground)
                    Text(prompt.prefix(160) + (prompt.count > 160 ? "…" : ""))
                        .font(.system(size: 11))
                        .foregroundStyle(Color.junoMutedForeground)
                        .lineLimit(3)
                        .padding(.top, 2)
                }
                Spacer(minLength: 0)
                Button {
                    prompt = ""
                    draftExpanded = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color.junoMutedForeground)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear this message")
            }

            HStack(spacing: 8) {
                Button {
                    draftExpanded = true
                    composerFocused.wrappedValue = true
                } label: {
                    capsuleLabel("Edit", symbol: "pencil")
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("juno.mobile.chat-expand-draft")

                if canAttachDraft {
                    Button(action: attachDraftAsFile) {
                        capsuleLabel("Attach as file", symbol: "doc.badge.arrow.up")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("juno.mobile.chat-attach-draft")
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.junoMuted.opacity(0.6))
        )
        .accessibilityIdentifier("juno.mobile.chat-collapsed-draft")
    }

    private func capsuleLabel(_ title: LocalizedStringKey, symbol: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
            Text(title)
                .font(.system(size: 12, weight: .medium))
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, 11)
        .frame(height: 28)
        .modifier(JunoGlassCapsule())
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
            if voiceActive {
                voiceAddMenu
            } else {
                addMenu
            }

            JunoMobileModelControl(
                models: model.modelCatalog,
                selectedModelID: $selectedModelID,
                fallbackName: junoDisplayModelName(conversation?.model ?? "")
            )
            .layoutPriority(1)

            if let thinkingScale {
                JunoMobileThinkingControl(
                    scale: thinkingScale,
                    effort: $reasoningEffort,
                    fastMode: $tools.fastMode,
                    proMode: $tools.proMode
                )
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

    /// The `+`, in an ordinary chat.
    private var addMenu: some View {
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
    }

    /// The `+`, during a call: **images only**.
    ///
    /// A separate menu rather than the full one with rows switched off, which is
    /// what the web does too. Everything the normal menu offers below "Add" —
    /// projects, canvas, research, connectors — belongs to a turn the chat route
    /// composes, and a spoken turn does not go through that route at all. A menu
    /// of controls that quietly apply to nothing is worse than a short menu.
    ///
    /// Files stays visible and disabled rather than being removed, because
    /// "where did attaching a PDF go" is a question worth answering in place.
    private var voiceAddMenu: some View {
        Menu {
            Section("attachments.add") {
                Button {
                    open(.camera)
                } label: {
                    Label("attachments.camera", systemImage: "camera")
                }
                .disabled(!canAttachInVoice)

                Button {
                    open(.photos)
                } label: {
                    JunoIconLabel("attachments.photos", icon: .photos)
                }
                .disabled(!canAttachInVoice)

                Button {} label: {
                    JunoIconLabel("composer.voice.files-chat-only", icon: .files)
                }
                .disabled(true)
            }
            if !voiceCanSeeImages {
                Section {
                    Button {} label: {
                        Label("composer.voice.no-vision", systemImage: "eye.slash")
                    }
                    .disabled(true)
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 34, height: 34)
                .modifier(JunoComposerGlassCircle())
                .frame(width: 40, height: 44)
                .contentShape(Rectangle())
        }
        // Same three rules as the full menu: source order, ink rather than
        // accent, and a chosen row must not take the keyboard with it.
        .menuOrder(.fixed)
        .tint(Color.primary)
        .menuActionDismissBehavior(.automatic)
        .accessibilityLabel("attachments.add")
        .accessibilityIdentifier("juno.mobile.chat-voice-add")
    }

    /// Offered only where it can actually work. A Simulator with no recognizer,
    /// or a device where speech is restricted, gets no microphone at all rather
    /// than one that opens a capsule and immediately apologises.
    ///
    /// And never during a call: Dictate Mode opens a second recognizer on the
    /// microphone the call already holds.
    private var canDictate: Bool {
        JunoSpeechService.isSupported && !generatingHere && !voiceActive
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
            // Never during a call. The dock above has the hang-up; a second
            // control that reopens what is already open is a control that does
            // nothing, and it would take the slot Send needs to talk into the
            // conversation.
            && !voiceActive
            && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            // A staged attachment is something to send, so the slot stays Send.
            && attachments.isEmpty
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
        // Past the guards that can still refuse the turn, so the aura only
        // swells for a send that is actually going out.
        if let voiceSession {
            sendVoiceTurn(voiceSession)
            return
        }
        sendSwell.fire()
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
            connectors: options.connectors,
            fastMode: options.fastMode,
            proMode: options.proMode
        )
        guard sent else { return }
        prompt = ""
        draftExpanded = false
        attachmentModel?.clear()
        // The title is generated from the first turn, exactly as the web does —
        // see NativeConversationModel.generateTitleIfNeeded.
        Task { await model.generateTitleIfNeeded(conversationID: conversationID) }
    }

    // MARK: Sending into a call

    /// Sends the draft — text and up to four images — through the live session
    /// rather than through the chat route.
    ///
    /// This is what makes the composer worth keeping on screen during a call.
    /// The turn goes over the socket the conversation is already on, so the
    /// model answers it out loud in context instead of it arriving as a separate
    /// written exchange the spoken thread knows nothing about.
    ///
    /// **The images are new surface, and gated accordingly.** The relay's
    /// `video.frame` takes JPEG from any source, and the Mac already feeds it
    /// screen captures — but no web client has ever sent a *camera* frame into a
    /// call, so there is no precedent to match and no field report to lean on.
    /// `sendTurn` refuses unless the relay itself said `videoInput`, and so does
    /// the `+` menu above it: nothing here assumes a provider can see.
    private func sendVoiceTurn(_ session: JunoMobileVoiceSession) {
        guard !isSendingVoiceTurn else { return }
        voiceTurnError = nil
        guard session.isLive else {
            // Two different situations with one useless shared message on the
            // web ("still connecting" for a session that has already hung up).
            // A finished call needs to say so, because the way out of it — the
            // red button on the dock — is not the way out of a slow one.
            voiceTurnError = switch session.controller.phase {
            case .ended, .error: String(localized: "composer.voice.not-live")
            default: String(localized: "composer.voice.connecting")
            }
            return
        }
        let staged = attachments
        guard staged.count <= Self.maximumVoiceImages else {
            voiceTurnError = String(localized: "composer.voice.image-limit")
            return
        }
        // `previewData` is the payload the upload model already holds for an
        // image, which is why this needs no second read and no network. An
        // attachment without one is either a document or a library clone whose
        // bytes only ever existed on the server — neither can be shown to a
        // model over this socket, so the turn is refused rather than silently
        // sent without them.
        //
        // The uploaded id rides along where there is one, and nil where the
        // upload has not landed yet — see ``JunoVoiceTurnImage``. Waiting for it
        // would hold a spoken turn on a network round trip the model does not
        // need.
        let images = staged.compactMap { attachment in
            attachment.previewData.map {
                JunoVoiceTurnImage(jpeg: $0, attachmentID: attachment.uploadedID)
            }
        }
        guard images.count == staged.count else {
            voiceTurnError = String(localized: "composer.voice.images-only")
            return
        }
        guard images.isEmpty || voiceCanSeeImages else {
            voiceTurnError = String(localized: "composer.voice.no-vision")
            return
        }

        sendSwell.fire()
        let text = prompt
        isSendingVoiceTurn = true
        Task {
            let accepted = await session.controller.sendTurn(text: text, images: images)
            isSendingVoiceTurn = false
            guard accepted else {
                voiceTurnError = images.isEmpty
                    ? String(localized: "composer.voice.send-failed")
                    : String(localized: "composer.voice.no-vision")
                return
            }
            prompt = ""
            draftExpanded = false
            attachmentModel?.clear()
        }
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
