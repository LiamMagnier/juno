import JunoChatKit
import JunoDesignSystem
import JunoStorage
import JunoVoiceKit
import SwiftUI

#if DEBUG
  import JunoPreviewSupport
#endif

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
  /// A one-shot request from a shortcut. The owner resets it as soon as the
  /// composer has claimed the microphone.
  var startDictation: Binding<Bool> = .constant(false)
  /// Opens Orbit, the account's agents — the "+" menu's Orbit row. Nil hides it.
  var openOrbit: (() -> Void)? = nil
  /// The draft's placeholder. A private chat says so where the reader types.
  var placeholder: LocalizedStringKey = "Ask Alevr"

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// The thinking dial, open in place of the control row.
  @State private var thinkingOpen = false
  /// The model picker, from the top of "+" or a long press on the dial.
  @State private var showingModelPicker = false
  /// Send, stop and voice answer in the hand. See `JunoMobileHaptic`.
  @State private var sendHaptic = JunoMobileHapticTrigger()
  @State private var stopHaptic = JunoMobileHapticTrigger()
  /// A call placed, and a call ended.
  @State private var voiceStartHaptic = JunoMobileHapticTrigger()
  @State private var endHaptic = JunoMobileHapticTrigger()
  /// One namespace for the composer's glass: the `+` and the primary action
  /// carry ids in it, so a state change morphs the material rather than
  /// cross-fading two panes.
  @Namespace private var glassNamespace
  /// The call in progress, published by the shell. Non-nil is what puts the
  /// call controls into this composer, the voice glow behind it, and every voice-mode
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

  /// The "/" commands this composer can honour. Rows whose surface the
  /// shell did not hand over (voice, library, connected apps) are absent
  /// rather than present and inert.
  private var slashCommands: [JunoMobileSlashCommand] {
    var rows: [JunoMobileSlashCommand] = [
      .init(key: "research", icon: .research, hint: "Run deep research on this message"),
      .init(key: "search", icon: .web, hint: "Search the web for this message"),
      .init(key: "canvas", icon: .canvas, hint: "Answer as a canvas"),
    ]
    if openVoiceMode != nil {
      rows.append(.init(key: "voice", icon: .mic, hint: "Start voice mode"))
    }
    if openLibrary != nil {
      rows.append(.init(key: "library", icon: .files, hint: "Attach from your library"))
    }
    if openPlugins != nil {
      rows.append(.init(key: "apps", icon: .blocks, hint: "Connected apps"))
    }
    return rows
  }

  /// Consumes the token and acts. The prompt is cleared first so the command
  /// never lands in the sent message as literal text.
  private func runSlashCommand(_ command: JunoMobileSlashCommand) {
    prompt = ""
    switch command.key {
    case "research": tools.deepResearch = true
    case "search": tools.webSearch = true
    case "canvas": tools.canvas = true
    case "voice": openVoiceMode?()
    case "library": openLibrary?()
    case "apps": openPlugins?()
    default: break
    }
    if ["research", "search", "canvas"].contains(command.key) {
      composerFocused.wrappedValue = true
    }
  }

  /// The research depth these choices buy — the chip's line, and the same
  /// answer the server derives from the same three inputs.
  private var researchDepth: NativeResearchEffort {
    NativeResearchEffort.derived(
      priceClass: selectedModel?.pricing?.priceClass,
      reasoningEffort: reasoningEffort,
      proMode: tools.proMode
    )
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
  /// microphone — while the ordinary attachment uploader remains available
  /// for images and durable documents.
  private var voiceActive: Bool { voiceSession != nil }

  /// Past four attachments a turn, providers start answering about the first
  /// one and ignoring the rest. The relay and transcript route enforce the
  /// same ceiling; this is here so the reader is told before they compose a
  /// fifth.
  private static let maximumVoiceAttachments = 4

  /// Whether the model on the other end of the call can see at all.
  ///
  /// Read from what the relay said in `session.ready` rather than from a list
  /// of providers kept here, which would be a second copy to drift. Nil while
  /// connecting reads as "no", so the camera row is not offered a beat before
  /// it can work.
  private var voiceCanSeeImages: Bool {
    voiceSession?.controller.capabilities?.videoInput == true
  }

  /// Whether talking over Juno interrupts it: a fact about this device's
  /// audio route (echo cancellation or not), never a preference, so it is
  /// said where VoiceOver finds the call.
  private var voiceBargeInHint: Text {
    guard let voiceSession, voiceSession.isLive else { return Text(verbatim: "") }
    return voiceSession.controller.bargeIn == .automatic
      ? Text("voice.barge-in.automatic")
      : Text("voice.barge-in.manual")
  }

  private var canAttachInVoice: Bool {
    attachments.count < Self.maximumVoiceAttachments
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
    contextTokens = []
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

  @State private var contextTokens: [NativeContextToken] = []

  var body: some View {
    VStack(spacing: JunoSpace.snug) {
      NativeContextSuggestions(query: NativeContextMention.query(in: prompt), search: {
        try await model.mentions(query: $0, conversationID: conversation?.id)
      }, select: { token in
        guard contextTokens.count < 16 else { return }
        if !contextTokens.contains(where: { $0.identity == token.identity }) { contextTokens.append(token) }
        prompt = NativeContextMention.inserting(token, in: prompt)
      })
      if model.canRetrySelectedConversation && !model.isGenerating {
        retryBanner
      }

      // Above the composer, not below it: under the container it would sit
      // in the home-indicator strip and go unread.
      if let thinkingNotice {
        notice(thinkingNotice, icon: .about, tint: Color.junoMutedForeground)
          .accessibilityIdentifier("juno.mobile.thinking-notice")
      }
      if let attachmentError = attachmentModel?.lastErrorDescription {
        notice(attachmentError, icon: .error, tint: Color.junoCaution)
          .accessibilityIdentifier("juno.mobile.attachment-error")
      }
      // A photo the picker accepted and the app could not read is its own
      // failure, separate from an upload that was refused.
      if let importError = attachmentCoordinator.importError {
        notice(importError, icon: .error, tint: Color.junoCaution)
          .accessibilityIdentifier("juno.mobile.attachment-import-error")
      }
      if let voiceTurnError {
        notice(voiceTurnError, icon: .error, tint: Color.junoCaution)
          .accessibilityIdentifier("juno.mobile.voice-turn-error")
      }

      // Deep research runs PLAN → SEARCH → READ for tens of seconds before
      // the first token of the report. Without the live step above the
      // composer that whole stretch is an empty bubble and a spinner,
      // which reads as a hung app rather than as work in progress.
      // Once the run has rows, the transcript carries it (the Deep Field
      // view in the answer's place); this stays only as the armed state.
      if tools.deepResearch && !model.researchActivity.isEmpty {
        JunoMobileResearchProgress(
          enabled: tools.deepResearch,
          depth: researchDepth,
          activity: model.researchActivity,
          degradedWarning: model.researchDegradedWarning,
          onDisable: { tools.deepResearch = false },
          onStop: generatingHere ? { model.stopGeneration() } : nil
        )
        .transition(.opacity)
      }

      // The dial's level, named over the composer while the dial is open —
      // ChatGPT's "Instant" above its slider.
      if thinkingOpen, let thinkingScale {
        Text(verbatim: thinkingScale.stops.first { $0.effort == reasoningEffort }?.label ?? "Off")
          .junoFont(size: 15, relativeTo: .subheadline, weight: .semibold)
          .foregroundStyle(Color.junoForeground)
          .contentTransition(.opacity)
          .frame(maxWidth: .infinity)
          .transition(.opacity.combined(with: .offset(y: 4)))
          .accessibilityHidden(true)
      }

      // The composer is the call now (the web's `voiceCallParts`): no dock
      // above it. What is left above is the call's one plain line of news,
      // and the camera's own preview while Juno is looking through it.
      if let voiceSession {
        JunoMobileVoiceCallNotices(session: voiceSession)
        JunoMobileVoiceSelfView(camera: voiceSession.camera) { voiceSession.camera.stop() }
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
        JunoGlass(spacing: JunoSpace.snug) {
          VStack(alignment: .leading, spacing: 0) {
            if thinkingOpen, let thinkingScale, voiceSession == nil {
              JunoMobileThinkingDialSlider(
                scale: thinkingScale,
                effort: $reasoningEffort,
                close: closeThinking
              )
              .padding(.horizontal, JunoSpace.tight)
              .padding(.vertical, JunoSpace.tight)
              .transition(.opacity)
            } else {
              if !attachments.isEmpty, let attachmentModel {
                JunoMobileAttachmentChips(
                  attachments: attachments,
                  onRemove: { attachmentModel.remove($0) },
                  onRetry: { attachmentModel.retry($0, conversationID: conversation?.id) }
                )
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.top, JunoSpace.cozy)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
              }

              if let slashQuery = JunoMobileSlashPalette.query(in: prompt), !showsCollapsedDraft {
                JunoMobileSlashPalette(
                  commands: slashCommands,
                  query: slashQuery,
                  pick: runSlashCommand
                )
                .padding(.horizontal, JunoSpace.snug)
                .padding(.top, JunoSpace.snug)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
              }

              if voiceSession == nil, !armedTokens.isEmpty {
                ScrollView(.horizontal) {
                  HStack(spacing: JunoSpace.cozy) {
                    ForEach(armedTokens) { token in
                      JunoMobileComposerToken(
                        symbol: token.symbol, title: token.title, remove: token.remove
                      )
                    }
                  }
                }
                .scrollIndicators(.hidden)
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.snug)
                .transition(.opacity)
              }

              if showsCollapsedDraft {
                collapsedDraftCard
                  .padding(JunoSpace.snug)
                  .transition(.opacity)
              } else {
                // The placeholder in secondary ink, not the system's paler
                // placeholder grey: ChatGPT's "Ask ChatGPT" reads at a glance.
                TextField(
                  text: $prompt,
                  prompt: Text(voiceActive ? "Type while you talk…" : placeholder)
                    .foregroundStyle(Color.secondary),
                  axis: .vertical
                ) {
                  Text(voiceActive ? "Type while you talk…" : placeholder)
                }
                .junoFont(size: 17, relativeTo: .body)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .focused(composerFocused)
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, 14)
                .padding(.bottom, JunoSpace.tight)
                .accessibilityIdentifier("juno.mobile.chat-composer")

                if isLongDraft {
                  attachAsFileOffer
                }
              }

              controlRow
                .padding(.horizontal, JunoSpace.tight)
                .padding(.bottom, JunoSpace.tight)
            }
          }
          // In a call the glow carries the phase, so the words go here: the
          // composer is named as the call and its value is what it is doing.
          .accessibilityElement(children: .contain)
          .accessibilityLabel(voiceSession == nil ? Text("Message composer") : Text("Voice call"))
          .accessibilityValue(voiceSession.map { Text(verbatim: $0.callPhase.title) } ?? Text(verbatim: ""))
          .accessibilityHint(voiceBargeInHint)
          // Native Liquid Glass, as the owner requires for floating chrome:
          // the system material, not a rebuilt one. One rounded card, radius
          // 24 — no border, no shadow, nothing inside it wearing its own glass.
          .junoGlass(
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
          )
          .animation(JunoMotion.reduced(JunoMotion.chatControl, when: reduceMotion), value: thinkingOpen)
        }
        .transition(.opacity)
      }
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.vertical, JunoSpace.tight)
    // The transcript's measure, so on an iPad the capsule lines up with the
    // column it writes into instead of spanning the window. Before the voice
    // field, which stays as wide as the screen it lights.
    .frame(maxWidth: JunoMobileMeasure.reading)
    .frame(maxWidth: .infinity)
    // Voice is the one ambient field with semantic meaning. It remains mounted
    // here so it tracks the keyboard with the safe-area composer.
    .background(alignment: .bottom) { voiceGlowLayer }
    .junoHaptic(JunoMobileHaptic.send, trigger: sendHaptic)
    .junoHaptic(JunoMobileHaptic.stop, trigger: stopHaptic)
    .junoHaptic(JunoMobileHaptic.send, trigger: voiceStartHaptic)
    .junoHaptic(JunoMobileHaptic.stop, trigger: endHaptic)
    .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: voiceActive)
    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: sendDisabled)
    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: generatingHere)
    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: thinkingNotice)
    .animation(
      JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: attachments.count
    )
    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: showsCollapsedDraft)
    // Once the draft is back under the inline ceiling, forget that it was
    // ever expanded — otherwise the *next* huge paste would land straight
    // in the text field, which is the state this card exists to avoid.
    .onChange(of: prompt) { _, text in
      if !NativePromptLimits.isHugeDraft(text) { draftExpanded = false }
    }
    .onChange(of: startDictation.wrappedValue, initial: true) { _, requested in
      guard requested, !dictating else { return }
      // Clear the one-shot request before presenting the recorder: returning
      // to this view after a send must not immediately reopen it.
      startDictation.wrappedValue = false
      composerFocused.wrappedValue = false
      setDictating(true)
    }
    // A refusal explains a turn that is no longer being attempted, so it
    // goes with the call it belonged to rather than sitting over the next
    // typed message.
    .onChange(of: voiceSession == nil) { _, ended in
      if ended { voiceTurnError = nil }
    }
    .task { await applyPreviewFlags() }
    .sheet(isPresented: $showingModelPicker) {
      JunoMobileModelSelectorView(
        models: model.modelCatalog,
        selectedModelID: selectedModelID,
        layout: .compact,
        onSelect: { option in
          selectedModelID = option.id
          showingModelPicker = false
        }
      )
      // Full height: a list of labs and models reads as a page, and at the
      // medium detent only Auto and one lab were visible.
      .presentationDetents([.large])
      .presentationDragIndicator(.visible)
    }
    .onChange(of: composerFocused.wrappedValue) { _, focused in
      if focused { closeThinking() }
    }
  }

  // MARK: Thinking dial

  private func openThinking() {
    composerFocused.wrappedValue = false
    withAnimation(JunoMotion.reduced(JunoMotion.chatControl, when: reduceMotion)) {
      thinkingOpen = true
    }
  }

  private func closeThinking() {
    guard thinkingOpen else { return }
    withAnimation(JunoMotion.reduced(JunoMotion.chatControl, when: reduceMotion)) {
      thinkingOpen = false
    }
  }

  private func chooseModel() {
    composerFocused.wrappedValue = false
    showingModelPicker = true
  }

  // MARK: Armed tools

  /// What the next message will carry beyond its words, as tokens in the
  /// field. Only what the reader turned on for *this* turn or chose as a
  /// premium mode: web search and canvas are standing preferences that are on
  /// by default, and a token for the default would be noise on every message.
  private struct ArmedToken: Identifiable {
    let id: String
    let symbol: String
    let title: String
    let remove: () -> Void
  }

  private var armedTokens: [ArmedToken] {
    var tokens: [ArmedToken] = []
    if tools.deepResearch {
      tokens.append(ArmedToken(id: "research", symbol: "binoculars", title: String(localized: "Deep research")) {
        tools.deepResearch = false
      })
    }
    if tools.fastMode {
      tokens.append(ArmedToken(id: "flash", symbol: "bolt", title: "Flash") { tools.fastMode = false })
    }
    if tools.proMode {
      tokens.append(ArmedToken(id: "pro", symbol: "sparkle", title: "Pro") { tools.proMode = false })
    }
    for id in tools.connectors {
      let name = connectors.first { $0.id == id }?.label ?? id
      tokens.append(ArmedToken(id: "app-\(id)", symbol: "puzzlepiece.extension", title: name) {
        tools.toggleConnector(id)
      })
    }
    return tokens
  }

  // MARK: Voice glow

  /// Libraries.dev Voice, "mobile": the light pooled at the foot of the
  /// screen and rising through the composer's glass. Mounted only during a
  /// call, so an ordinary composer pays nothing for it.
  @ViewBuilder
  private var voiceGlowLayer: some View {
    if let voiceSession {
      JunoMobileVoiceComposerGlow(session: voiceSession)
        .transition(.opacity)
    }
  }

  /// The quiet offer under a long draft: "That's a long one — attach it as a
  /// file to keep the chat tidy?" One line and one button, exactly as the web
  /// puts it, and it never touches the draft unless the button is tapped.
  private var attachAsFileOffer: some View {
    HStack(spacing: JunoSpace.snug) {
      Text("That's a long one — send it as a file to keep the chat tidy?")
        .junoFont(size: 12, relativeTo: .caption)
        .foregroundStyle(Color.junoMutedForeground)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 4)
      Button(action: attachDraftAsFile) {
        HStack(spacing: JunoSpace.tight) {
          JunoIconView(.file, size: 12)
          Text("Attach")
            .junoFont(size: 12, relativeTo: .caption, weight: .medium)
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 28)
        .modifier(JunoGlassCapsule())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Send this message as a file")
      .accessibilityIdentifier("juno.mobile.chat-attach-draft")
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(.rect)
    }
    .padding(.horizontal, JunoSpace.snug)
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
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      HStack(alignment: .top, spacing: JunoSpace.snug) {
        VStack(alignment: .leading, spacing: 3) {
          Text("Long message ready to send")
            .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
          Text(
            "\(prompt.count.formatted(.number)) characters · sent in full"
          )
          .junoFont(size: 12, relativeTo: .caption)
          .monospacedDigit()
          .foregroundStyle(Color.junoMutedForeground)
          Text(prompt.prefix(160) + (prompt.count > 160 ? "…" : ""))
            .junoFont(size: 12, relativeTo: .caption)
            .foregroundStyle(Color.junoMutedForeground)
            .lineLimit(3)
            .padding(.top, JunoSpace.hairline)
        }
        Spacer(minLength: 0)
        Button {
          prompt = ""
          draftExpanded = false
        } label: {
          JunoIconView(.close, size: 12)
            .foregroundStyle(Color.junoMutedForeground)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear this message")
      }

      HStack(spacing: JunoSpace.snug) {
        Button {
          draftExpanded = true
          composerFocused.wrappedValue = true
        } label: {
          capsuleLabel("Edit", icon: .pencil)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("juno.mobile.chat-expand-draft")
        .contentShape(.rect)

        if canAttachDraft {
          Button(action: attachDraftAsFile) {
            capsuleLabel("Attach as file", icon: .file)
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("juno.mobile.chat-attach-draft")
          .contentShape(.rect)
        }
        Spacer(minLength: 0)
      }
    }
    .padding(.horizontal, JunoSpace.cozy)
    .padding(.vertical, JunoSpace.cozy)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(Color.junoMuted.opacity(0.6))
    )
    .accessibilityIdentifier("juno.mobile.chat-collapsed-draft")
  }

  private func capsuleLabel(_ title: LocalizedStringKey, icon: JunoIcon) -> some View {
    HStack(spacing: JunoSpace.tight) {
      JunoIconView(icon, size: 12)
      Text(title)
        .junoFont(size: 12, relativeTo: .caption, weight: .medium)
    }
    .foregroundStyle(Color.primary)
    .padding(.horizontal, JunoSpace.cozy)
    .frame(height: 28)
    .modifier(JunoGlassCapsule())
  }

  private func notice(_ text: String, icon: JunoIcon, tint: Color) -> some View {
    HStack(spacing: JunoSpace.tight) {
      JunoIconView(icon, size: 13)
      Text(text)
    }
      .font(.caption2)
      .foregroundStyle(tint)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, JunoSpace.tight)
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
      if JunoComposerPreviewFlags.opensThinking || JunoComposerPreviewFlags.opensModelSelector {
        // The dial needs the catalog to know the model's scale.
        for _ in 0..<30 where thinkingScale == nil {
          try? await Task.sleep(nanoseconds: 100_000_000)
        }
      }
      if JunoComposerPreviewFlags.opensThinking, thinkingScale?.isAdjustable == true {
        try? await Task.sleep(nanoseconds: 500_000_000)
        openThinking()
      }
      if JunoComposerPreviewFlags.opensModelSelector {
        try? await Task.sleep(nanoseconds: 400_000_000)
        chooseModel()
      }
      // `--juno-preview-prompt <text>` types a draft; `--juno-preview-send
      // <text>` types it and sends it, against the harness's paced stream.
      if let typed = JunoComposerPreviewFlags.value("--juno-preview-prompt") {
        prompt = typed
      }
      if JunoComposerPreviewFlags.focusesComposer {
        composerFocused.wrappedValue = true
      }
      if let sent = JunoComposerPreviewFlags.value("--juno-preview-send"),
        // Only from the conversation the launch opened (if it named one):
        // the home's composer appears first and must not send a draft.
        JunoPreviewEnvironment.initialConversation == nil
          || conversation?.id == JunoPreviewEnvironment.initialConversation
      {
        try? await Task.sleep(nanoseconds: 600_000_000)
        prompt = sent
        send()
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
    HStack(spacing: JunoSpace.tight) {
      if let voiceSession {
        voiceControlRow(voiceSession)
      } else {
        chatControlRow
      }
    }
  }

  /// The row while the composer is a call: `+` alone on the left, the call's
  /// verbs on the right, then End in Send's place (Send again once something
  /// is typed). No status text and no meter: the glow behind the glass says
  /// what the call is doing.
  @ViewBuilder
  private func voiceControlRow(_ session: JunoMobileVoiceSession) -> some View {
    voiceAddMenu
    Spacer(minLength: 0)
    JunoMobileVoiceCallControls(session: session)
    composerActionButton
  }

  /// `+` on the left; the dial, the microphone and the one primary action on
  /// the right. Bare glyphs on the card's own glass — ChatGPT's row, with
  /// nothing wearing a chip.
  @ViewBuilder
  private var chatControlRow: some View {
      addMenu

      Spacer(minLength: 2)

      // Only the states worth a word: a stall or a failure. A reply that is
      // simply arriving is said by the stop button and the transcript.
      if phaseWorthAWord {
        phaseIndicator
          .transition(.opacity)
      }

      if let thinkingScale, thinkingScale.isPresentable || !model.modelCatalog.isEmpty {
        JunoMobileThinkingDialButton(
          scale: thinkingScale,
          effort: reasoningEffort,
          open: openThinking,
          chooseModel: chooseModel
        )
      }

      if canDictate {
        dictateButton
      }

      composerActionButton
  }

  /// The `+`, in an ordinary chat.
  private var addMenu: some View {
    JunoMobileComposerActions(
      projects: projects,
      selectedProjectID: conversation?.projectId,
      canPickProject: conversation != nil,
      canAttach: attachmentModel?.hasCapacity ?? false,
      canOpenPlugins: openPlugins != nil,
      glassNamespace: glassNamespace,
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
      openPlugins: { openPlugins?() },
      openOrbit: openOrbit,
      modelName: selectedModel?.displayName ?? junoDisplayModelName(conversation?.model ?? ""),
      chooseModel: chooseModel,
      thinkingScale: thinkingScale
    )
  }

  /// The `+`, during a call: images and durable documents.
  ///
  /// A separate menu rather than the full one with rows switched off, which is
  /// what the web does too. Everything the normal menu offers below "Add" —
  /// projects, canvas, research, connectors — belongs to a turn the chat route
  /// composes, and a spoken turn does not go through that route at all. A menu
  /// of controls that quietly apply to nothing is worse than a short menu.
  ///
  private var voiceAddMenu: some View {
    Menu {
      Section("attachments.add") {
        Button {
          open(.camera)
        } label: {
          JunoIconLabel("attachments.camera", icon: .photos)
        }
        .disabled(!canAttachInVoice || !voiceCanSeeImages)

        Button {
          open(.photos)
        } label: {
          JunoIconLabel("attachments.photos", icon: .photos)
        }
        .disabled(!canAttachInVoice || !voiceCanSeeImages)

        Button {
          open(.files)
        } label: {
          JunoIconLabel("attachments.files", icon: .files)
        }
        .disabled(!canAttachInVoice)
      }
      if !voiceCanSeeImages {
        Section {
          Button {
          } label: {
            JunoIconLabel("composer.voice.no-vision", icon: .error)
          }
          .disabled(true)
        }
      }
    } label: {
      Image(systemName: "plus")
        .junoFont(size: 21, relativeTo: .body, weight: .regular)
        .foregroundStyle(.primary)
        .frame(width: 44, height: 44)
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
        .junoFont(size: 19, relativeTo: .body, weight: .regular)
        .foregroundStyle(Color.primary)
        .frame(width: 40, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.junoQuietPress)
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
    HStack(spacing: JunoSpace.tight) {
      if isStreamingPhase {
        ProgressView().controlSize(.mini)
      } else {
        JunoIconView(phaseIcon, size: 13)
      }
      Text(phaseLabel)
        .lineLimit(1)
    }
    .junoCaption()
    .accessibilityElement(children: .combine)
    .accessibilityLabel(phaseLabel)
  }

  private var retryBanner: some View {
    HStack(spacing: JunoSpace.snug) {
      JunoIconView(.error, size: 14)
        .foregroundStyle(Color.junoCaution)
      Text(model.chatErrorDescription ?? "The response was interrupted.")
        .lineLimit(2)
        .junoSecondaryInk()
      Spacer(minLength: 8)
      Button("Retry") {
        guard let conversation else { return }
        model.retryLastMessage(conversationID: conversation.id)
      }
      .buttonStyle(.bordered)
      .accessibilityIdentifier("juno.mobile.chat-retry")
      .contentShape(.rect)
    }
    .font(.caption)
  }

  private var phaseWorthAWord: Bool {
    switch model.chatPhase {
    case .reconnecting, .failed, .stopping: true
    default: false
    }
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

  private var phaseIcon: JunoIcon {
    switch model.chatPhase {
    case .reconnecting: .refresh
    case .failed: .error
    case .stopping: .stop
    default: .models
    }
  }

  /// The one primary action. End keeps its own red face during a call;
  /// otherwise voice, send and stop are one button changing face — see
  /// ``JunoMobileComposerPrimaryButton``.
  @ViewBuilder
  private var composerActionButton: some View {
    if !generatingHere, showsEndAction, let voiceSession {
      Button {
        endHaptic.fire()
        voiceSession.hangUp()
      } label: {
        endLabel(saving: voiceSession.isSaving)
      }
      .buttonStyle(.plain)
      .disabled(voiceSession.isSaving)
      .transition(.scale.combined(with: .opacity))
      .accessibilityLabel("voice.end")
      .accessibilityIdentifier("juno.mobile.voice-end")
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(.rect)
    } else {
      JunoMobileComposerPrimaryButton(face: primaryFace) {
        switch primaryFace {
        case .stop:
          stopHaptic.fire()
          model.stopGeneration()
        case .voice:
          voiceStartHaptic.fire()
          openVoiceMode?()
        case .send:
          send()
        }
      }
    }
  }

  private var primaryFace: JunoMobileComposerPrimaryButton.Face {
    if generatingHere { return .stop }
    if showsVoiceAction, openVoiceMode != nil { return .voice }
    return .send(enabled: !sendDisabled)
  }

  /// Voice takes the slot exactly when Send has nothing to do — which is what
  /// makes the two feel like one control rather than a choice.
  private var showsVoiceAction: Bool {
    openVoiceMode != nil
      // Never during a call. End has the hang-up; a second
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

  /// During a call, End takes the slot exactly when Send has nothing to do:
  /// the same size and place, so the hand already knows where it is, and the
  /// only coloured control in a call.
  private var showsEndAction: Bool {
    voiceActive
      && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && attachments.isEmpty
  }

  /// End, as the primary slot's red face. The glyph takes the canvas ink, which
  /// inverts with the appearance, so it clears contrast on the light red and
  /// on the dark appearance's lifted red alike.
  private func endLabel(saving: Bool) -> some View {
    Group {
      if saving {
        ProgressView().tint(Color.junoCanvas)
      } else {
        JunoIconView(.phoneOff, size: 16)
      }
    }
    .foregroundStyle(Color.junoCanvas)
    .frame(width: 34, height: 34)
    .modifier(JunoComposerSendBackground(active: true, tint: Color.junoDanger))
    .junoGlassID("composer.action", in: glassNamespace)
    .frame(minWidth: 44, minHeight: 44)
    .contentShape(Rectangle())
  }

  private func actionLabel<Glyph: View>(
    active: Bool,
    @ViewBuilder glyph: () -> Glyph
  ) -> some View {
    glyph()
      // The glyph follows the ground it is standing on. On the accent it
      // is `junoOnAccent` — the accent is an account setting, and a
      // literal white fails contrast on two of the five palettes, which is
      // exactly the case the token exists for. Off the accent the circle
      // is neutral glass, so the glyph takes the ink the rest of the
      // composer's quiet chrome uses rather than staying white on clear.
      .foregroundStyle(active ? Color.junoOnAccent : Color.junoMutedForeground)
      .frame(width: 34, height: 34)
      .modifier(JunoComposerSendBackground(active: active))
      // Voice → Send → Stop is one element changing state, so the glass
      // stretches between them rather than fading two circles.
      .junoGlassID("composer.action", in: glassNamespace)
      .frame(width: 44, height: 44)
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
      proMode: options.proMode,
      contextTokens: contextTokens.filter { prompt.contains("@" + $0.label) }
    )
    guard sent else { return }
    sendHaptic.fire()
    prompt = ""
    draftExpanded = false
    attachmentModel?.clear()
    // The title is generated from the first turn, exactly as the web does —
    // see NativeConversationModel.generateTitleIfNeeded.
    Task { await model.generateTitleIfNeeded(conversationID: conversationID) }
  }

  // MARK: Sending into a call

  /// Sends the draft — text, images, and durable document context — through the live session
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
      // red End button — is not the way out of a slow one.
      voiceTurnError =
        switch session.controller.phase {
        case .ended, .error: String(localized: "composer.voice.not-live")
        default: String(localized: "composer.voice.connecting")
        }
      return
    }
    let staged = attachments
    guard staged.count <= Self.maximumVoiceAttachments else {
      voiceTurnError = String(localized: "composer.voice.image-limit")
      return
    }
    guard staged.allSatisfy({ $0.uploadedID != nil }) else {
      voiceTurnError = String(localized: "composer.voice.attachments-pending")
      return
    }
    guard !staged.contains(where: { $0.isImage }) || voiceCanSeeImages else {
      voiceTurnError = String(localized: "composer.voice.no-vision")
      return
    }
    let documentIDs =
      staged
      .filter { !$0.isImage }
      .compactMap { $0.uploadedID }

    sendSwell.fire()
    let text = prompt
    isSendingVoiceTurn = true
    Task {
      var images: [JunoVoiceTurnImage] = []
      if let attachmentModel {
        do {
          for attachment in staged where attachment.isImage {
            let data = try await attachmentModel.voiceImageData(for: attachment.id)
            guard let uploadedID = attachment.uploadedID else {
              throw NativeAttachmentAPIError.malformedResponse
            }
            images.append(
              JunoVoiceTurnImage(jpeg: data, attachmentID: uploadedID)
            )
          }
        } catch {
          isSendingVoiceTurn = false
          voiceTurnError = String(localized: "composer.voice.image-unavailable")
          return
        }
      } else if staged.contains(where: \.isImage) {
        isSendingVoiceTurn = false
        voiceTurnError = String(localized: "composer.voice.image-unavailable")
        return
      }
      guard images.isEmpty || voiceCanSeeImages else {
        isSendingVoiceTurn = false
        voiceTurnError = String(localized: "composer.voice.no-vision")
        return
      }

      let context: NativeVoiceAttachmentContext?
      if documentIDs.isEmpty {
        context = nil
      } else if let client = session.attachmentContextClient {
        do {
          context = try await client.fetch(
            attachmentIDs: documentIDs,
            query: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              ? "Summarize the attached document and tell me what matters."
              : text,
            provider: session.controller.provider.rawValue,
            for: session.accountID
          )
        } catch {
          isSendingVoiceTurn = false
          voiceTurnError = error.localizedDescription
          return
        }
      } else {
        isSendingVoiceTurn = false
        voiceTurnError = String(localized: "composer.voice.context-unavailable")
        return
      }
      let accepted = await session.controller.sendTurn(
        text: text,
        images: images,
        context: context?.context,
        documentAttachmentIDs: documentIDs
      )
      isSendingVoiceTurn = false
      guard accepted else {
        voiceTurnError =
          images.isEmpty
          ? String(localized: "composer.voice.send-failed")
          : String(localized: "composer.voice.no-vision")
        return
      }
      prompt = ""
      draftExpanded = false
      attachmentModel?.clear()
      if context?.hasPendingAttachments == true {
        voiceTurnError = String(localized: "composer.voice.context-pending")
      } else if context?.hasUnavailableAttachments == true {
        voiceTurnError = String(localized: "composer.voice.context-unavailable")
      }
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
      let phase =
        reduceMotion
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

/// A circular Liquid Glass background for the composer's send/stop button, coral
/// when the control has something to do and plain glass when it does not.
///
/// **The inactive state is untinted, not a faded tint.** It used to pass
/// `Color.junoAccent.opacity(0.32)`, which `Glass.tint(_:)` honours as alpha: a
/// third-strength coral does not read as "a quiet coral", it reads as glass with
/// no reliable luminance of its own, and the arrow on top of it was left with
/// whatever contrast the transcript happened to be scrolling past. Passing `nil`
/// gives the honest thing — plain `.regular` glass, the same neutral material
/// the "+" beside it wears — and the *active* tint then goes in at full
/// strength (it was 0.95, which was the same dilution one twentieth of the way
/// in) so the accent establishes a predictable ground under the glyph.
///
/// Written as one expression rather than an `if active` branch on purpose: a
/// runtime `if` around a modifier produces two view identities, so the send
/// button would lose its state and its transition every time the prompt went
/// from empty to non-empty. Animating the tint keeps one view.
struct JunoComposerSendBackground: ViewModifier {
  let active: Bool
  /// The active face's colour: the accent for Send and Voice, the danger red
  /// for End.
  var tint: Color = Color.junoAccent

  func body(content: Content) -> some View {
    content
      .junoGlass(
        in: Circle(),
        tint: active ? tint : nil,
        interactive: true
      )
  }
}

/// A neutral (non-accent) circular Liquid Glass background for the composer's
/// "+" button, with a material fallback below OS 26.
struct JunoComposerGlassCircle: ViewModifier {
  func body(content: Content) -> some View {
    content
      .junoGlass(in: Circle(), interactive: true)
  }
}


