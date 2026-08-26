import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UIKit

/// The chat destination: the selected conversation's transcript + composer, or —
/// when nothing is selected — a **draft**: the website's serif greeting above an
/// empty composer.
///
/// The draft is the load-bearing part. Tapping New chat used to create a row
/// immediately, so a chat opened and abandoned left a "New chat" in the sidebar
/// forever. Here nothing exists until the first message is sent, which is what
/// the web does and what the sidebar reads as.
struct JunoMobileChatDetailScreen: View {
  @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
  var projects: [NativeProject] = []
  var attachmentModel: NativeComposerAttachmentModel?
  var profileName: String?
  /// Opens the app's connected apps — the composer menu's Plugins row.
  var openPlugins: (() -> Void)?
  /// Leaves this conversation for a fresh draft. Owned by the shell, because
  /// starting a chat is a navigation change and not something the transcript
  /// can do to itself.
  var newChat: (() -> Void)?
  /// The model chosen in Settings. A new chat opens on this rather than on
  /// whatever the catalog happens to list first.
  var accountDefaultModelID: String = ""
  /// Resolves an artifact card in the transcript to the real artifact, so tapping
  /// one can open it. Nil where artifacts have not loaded.
  var artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
  /// Opens an incognito chat. Nil where no session is available.
  var startIncognito: (() -> Void)?
  /// Opens a spoken conversation. Nil where no voice session can be made, in
  /// which case the composer never offers one.
  var openVoiceMode: (() -> Void)?
  /// Backs the `+` menu's "From your library". Nil where the app could not be
  /// configured.
  var libraryModel: NativeLibraryModel?
  /// The account's connected apps, for the menu's per-chat connector picker.
  var connectors: [NativeConnector] = []
  var memoryEnabled: Bool = true
  var setMemoryEnabled: (@MainActor @Sendable (Bool) -> Void)?
  /// Server-backed message actions — rate, branch, read aloud.
  var messageActions: NativeMessageActionsClient?
  /// Suggests what to ask next, under a finished reply.
  var followUpClient: NativeFollowUpClient?
  /// Publishes a conversation behind an unguessable link.
  var shareClient: NativeShareClient?
  var accountID: AccountID?
  /// The account's read-aloud voice, from Settings.
  var voiceID: String?

  /// One speaker for the whole screen. Held here rather than per row so that
  /// starting a second reading stops the first — two answers talking over each
  /// other is what a per-row player would produce.
  @State private var readAloud: JunoMobileReadAloud?

  /// The per-message tools, owned **here** rather than in either child.
  ///
  /// A draft becomes a conversation the moment its first message lands, and
  /// the shell swaps `JunoMobileDraftChat` for `JunoMobileConversationDetail`
  /// underneath it. State held in either one is discarded at that swap, so a
  /// research turn armed in a draft would silently disarm between arming and
  /// sending. Held one level up, it survives the swap.
  @State private var tools = JunoMobileComposerTools()

  /// The send swell, owned here for the same reason ``tools`` is.
  ///
  /// A send from a draft creates the conversation, and creating it swaps
  /// `JunoMobileDraftChat` for `JunoMobileConversationDetail` mid-swell. One
  /// instance per child meant the new screen's bloom was handed a swell that
  /// had never fired — so the first message of every new chat was the one send
  /// with no light behind it.
  @State private var sendSwell = JunoMobileSendSwell()

  private var selected: NativeConversation? {
    guard let id = model.selectedConversationID else { return nil }
    return model.conversations.first { $0.id == id }
  }

  var body: some View {
    Group {
      if let selected {
        JunoMobileConversationDetail(
          model: model,
          conversation: selected,
          projects: projects,
          attachmentModel: attachmentModel,
          profileName: profileName,
          openPlugins: openPlugins,
          newChat: newChat,
          accountDefaultModelID: accountDefaultModelID,
          artifactModel: artifactModel,
          openVoiceMode: openVoiceMode,
          libraryModel: libraryModel,
          connectors: connectors,
          memoryEnabled: memoryEnabled,
          setMemoryEnabled: setMemoryEnabled,
          tools: tools,
          sendSwell: sendSwell,
          readAloud: readAloud,
          voiceID: voiceID,
          messageActions: messageActions,
          followUpClient: followUpClient,
          shareClient: shareClient,
          accountID: accountID
        )
      } else {
        JunoMobileDraftChat(
          model: model,
          projects: projects,
          attachmentModel: attachmentModel,
          profileName: profileName,
          openPlugins: openPlugins,
          accountDefaultModelID: accountDefaultModelID,
          startIncognito: startIncognito,
          openVoiceMode: openVoiceMode,
          libraryModel: libraryModel,
          connectors: connectors,
          memoryEnabled: memoryEnabled,
          setMemoryEnabled: setMemoryEnabled,
          tools: tools,
          sendSwell: sendSwell
        )
      }
    }
    // Connectors are scoped to one thread — see the note on
    // `JunoMobileComposerTools`. Moving to another conversation must not
    // carry "this chat may act through Gmail" with it.
    .onChange(of: model.selectedConversationID) { old, new in
      guard old != new else { return }
      tools.resetForConversationChange()
      // Leaving a chat stops whatever it was reading. A voice carrying on
      // over a different conversation is the one thing this must not do.
      readAloud?.stop()
    }
    .task(id: "\(accountID?.rawValue ?? ""):\(model.selectedConversationID ?? "")") {
      await model.refreshChatApprovals(
        conversationID: model.selectedConversationID,
        includeRecent: true
      )
    }
    .task(id: accountID?.rawValue) {
      readAloud = JunoMobileReadAloud(client: messageActions, accountID: accountID)
    }
    .onDisappear { readAloud?.stop() }
  }
}

// MARK: - Draft

/// A chat that does not exist yet: the greeting, the composer, nothing else.
private struct JunoMobileDraftChat: View {
  @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
  var projects: [NativeProject]
  var attachmentModel: NativeComposerAttachmentModel?
  var profileName: String?
  var openPlugins: (() -> Void)?
  var accountDefaultModelID: String = ""
  var startIncognito: (() -> Void)?
  var openVoiceMode: (() -> Void)?
  var libraryModel: NativeLibraryModel?
  var connectors: [NativeConnector] = []
  var memoryEnabled: Bool = true
  var setMemoryEnabled: (@MainActor @Sendable (Bool) -> Void)?
  let tools: JunoMobileComposerTools
  /// Shared with the composer, because on this screen the light it drives is
  /// behind the greeting rather than behind the capsule — and owned one level
  /// up, so it outlives this screen when the first message turns the draft
  /// into a conversation.
  let sendSwell: JunoMobileSendSwell

  @State private var prompt = ""
  @State private var selectedModelID = ""
  @State private var reasoningEffort: NativeReasoningEffort?
  @State private var thinkingNotice: String?
  @State private var attachments = JunoMobileAttachmentCoordinator()

  @State private var showingLibrary = false
  /// The column's height, for the voice field — see the conversation screen.
  @State private var chatColumnHeight: CGFloat = 0
  /// The call in progress. It reaches the home screen because that is where
  /// most calls are started: nothing is selected, so the spoken turns have no
  /// conversation to appear in until the save route makes one on hang-up.
  @Environment(\.junoVoiceSession) private var voiceSession
  @Environment(\.colorScheme) private var colorScheme
  @FocusState private var composerFocused: Bool

  /// Whether the reader has actually chosen a model on this screen.
  ///
  /// This exists because "keep the current selection" and "fall back to the
  /// first selectable model" fight each other. The first resolution runs before
  /// the settings row has loaded, so it falls back to `juno:auto`; the account
  /// default then arrives, resolution runs again — and sees a `current` that is
  /// selectable and keeps it. The account default could never win, which is the
  /// bug this flag closes: only a write that came through ``modelSelection``
  /// counts as a choice.
  @State private var userPickedModel = false

  /// The binding the model control writes through. `configureSelections()`
  /// assigns `selectedModelID` directly and so never sets the flag.
  private var modelSelection: Binding<String> {
    Binding(
      get: { selectedModelID },
      set: { newValue in
        selectedModelID = newValue
        userPickedModel = true
      }
    )
  }

  /// The greeting, or — once someone is talking — what they have said.
  ///
  /// A call from here has no conversation behind it to fall back on, so
  /// without this the whole of a spoken exchange happens under an unchanged
  /// "Good evening, Liam". The greeting returns when the session closes and
  /// the saved turns take over.
  @ViewBuilder
  private var column: some View {
    if voiceMessages.isEmpty {
      // The bloom rides with the greeting on this screen, not with the
      // composer: it is the sentence the reader is looking at, and the web
      // lights it with the same one element. `nil` during a call, where the
      // voice field below has the light instead.
      JunoMobileGreeting(
        name: profileName,
        aura: voiceSession == nil ? auraLight : nil,
        onSuggestion: { suggestion in
          prompt = suggestion
          composerFocused = true
        }
      )
    } else {
      ScrollView {
        // The transcript's own metrics, so a spoken turn is the same
        // shape here as it will be in the chat it is filed into.
        LazyVStack(spacing: JunoSpace.section) {
          JunoMobileVoiceLines(messages: voiceMessages)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.section)
        .frame(maxWidth: 768)
        .frame(maxWidth: .infinity)
      }
      .defaultScrollAnchor(.bottom)
    }
  }

  /// The live half of the call. Empty when no session is running.
  private var voiceMessages: [NativeChatMessage] {
    voiceSession?.liveMessages() ?? []
  }

  /// What the greeting's bloom is made of. Gathered here because this screen is
  /// the one that owns both the model selection and the send swell.
  private var auraLight: JunoMobileAuraLight {
    JunoMobileAuraLight(
      model: model.modelCatalog.first { $0.id == selectedModelID },
      effort: reasoningEffort,
      focused: composerFocused,
      sending: sendSwell.active,
      viewport: chatColumnHeight,
      dark: colorScheme == .dark
    )
  }

  var body: some View {
    column
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.junoCanvas)
      .scrollDismissesKeyboard(.interactively)
      .simultaneousGesture(
        TapGesture().onEnded {
          composerFocused = false
        }
      )
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        chatColumnHeight = $0
      }
      .accessibilityIdentifier("juno.mobile.chat-draft")
      .navigationTitle("navigation.chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if let startIncognito {
          ToolbarItem(placement: .topBarTrailing) {
            Button(action: startIncognito) {
              JunoGhostMark(active: false, size: 21)
            }
            .accessibilityLabel("Start an incognito chat")
            .accessibilityIdentifier("juno.mobile.incognito-start")
          }
        }
      }
      .safeAreaInset(edge: .bottom) {
        JunoMobileComposer(
          model: model,
          conversation: nil,
          projects: projects,
          prompt: $prompt,
          selectedModelID: modelSelection,
          reasoningEffort: $reasoningEffort,
          thinkingNotice: $thinkingNotice,
          attachmentModel: attachmentModel,
          tools: tools,
          connectors: connectors,
          memoryEnabled: memoryEnabled,
          setMemoryEnabled: setMemoryEnabled,
          openLibrary: libraryModel == nil ? nil : { showingLibrary = true },
          attachmentCoordinator: attachments,
          openPlugins: openPlugins,
          openVoiceMode: openVoiceMode,
          startConversation: {
            await model.createConversationResolvingID(
              model: selectedModelID.isEmpty ? nil : selectedModelID
            )
          },
          chatColumnHeight: chatColumnHeight,
          composerFocused: $composerFocused,
          sendSwell: sendSwell,
          // The greeting holds the bloom whenever it is on screen, so
          // the composer must not draw a second one.
          greetingVisible: voiceMessages.isEmpty
        )
      }
      // After the inset, never before it: the camera panel is a sibling
      // *above* the composer, and applying this first would layer it under.
      .junoAttachmentSurfaces(
        coordinator: attachments,
        attachmentModel: attachmentModel,
        conversationID: nil
      )
      .junoLibraryPicker(
        isPresented: $showingLibrary,
        libraryModel: libraryModel,
        attachmentModel: attachmentModel
      )
      .onAppear { configureSelections() }
      .onChange(of: selectedModelID) { _, _ in configureSelections() }
      .onChange(of: model.modelCatalog) { _, _ in configureSelections() }
      .onChange(of: accountDefaultModelID) { _, _ in configureSelections() }
  }

  private func configureSelections() {
    selectedModelID = JunoMobileComposerSelection.resolvedModelID(
      current: userPickedModel ? selectedModelID : "",
      conversationModel: "",
      accountDefault: accountDefaultModelID,
      selectable: model.selectableModels
    )
    guard let selected = model.modelCatalog.first(where: { $0.id == selectedModelID }) else {
      reasoningEffort = nil
      return
    }
    let adjustment = NativeThinkingScale(model: selected).adjusting(reasoningEffort)
    reasoningEffort = adjustment.effort
    thinkingNotice = adjustment.explanation
  }
}

// MARK: - Conversation

private struct JunoMobileConversationDetail: View {
  @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
  let conversation: NativeConversation
  var projects: [NativeProject] = []
  var attachmentModel: NativeComposerAttachmentModel?
  var profileName: String?
  var openPlugins: (() -> Void)?
  var newChat: (() -> Void)?
  var accountDefaultModelID: String = ""
  var artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
  var openVoiceMode: (() -> Void)?
  var libraryModel: NativeLibraryModel?
  var connectors: [NativeConnector] = []
  var memoryEnabled: Bool = true
  var setMemoryEnabled: (@MainActor @Sendable (Bool) -> Void)?
  let tools: JunoMobileComposerTools
  /// Shared with the composer so the swell reaches whichever aura is mounted —
  /// the greeting's on an empty conversation, the composer's once it has turns.
  /// Owned one level up so a send made in a draft survives the swap onto this
  /// screen still swelling.
  let sendSwell: JunoMobileSendSwell
  /// The screen's one speaker, so two answers cannot read over each other.
  var readAloud: JunoMobileReadAloud?
  var voiceID: String?
  /// Server-backed message actions. Nil where the app could not be configured.
  var messageActions: NativeMessageActionsClient?
  /// Suggests what to ask next, under a finished reply.
  var followUpClient: NativeFollowUpClient?
  /// Publishes a conversation behind an unguessable link.
  var shareClient: NativeShareClient?
  var accountID: AccountID?
  /// The artifact the reader tapped in the transcript, presented over it.
  @State private var openArtifact: NativeArtifact?
  /// An artifact the transcript can render from the reply's own tag, used when
  /// the stored row has not arrived. See ``openArtifact(_:)``.
  @State private var inlineArtifact: JunoMobileInlineArtifact?
  @State private var showingLibrary = false
  /// The link just created, presented to the system share sheet. Held rather
  /// than shared inline because the link does not exist until the server makes
  /// it — a `ShareLink` needs its URL up front, and there is none to give.
  @State private var createdShare: NativeShare?
  @State private var sharing = false
  @State private var shareError: String?

  /// Creates the link, then hands it to the system sheet.
  ///
  /// The route is idempotent per conversation, so tapping Share twice returns
  /// the same link rather than littering the account with duplicates.
  private func createShare() async {
    guard let shareClient, let accountID, !sharing else { return }
    sharing = true
    defer { sharing = false }
    do {
      createdShare = try await shareClient.share(
        conversationID: conversation.id,
        for: accountID
      )
    } catch {
      shareError = "The conversation couldn’t be published. Try again in a moment."
    }
  }

  @State private var attachments = JunoMobileAttachmentCoordinator()
  @State private var showingRename = false
  @State private var showingDelete = false
  @State private var editValue = ""
  @State private var prompt = ""
  @State private var selectedModelID = ""
  @State private var reasoningEffort: NativeReasoningEffort?
  /// Set when switching models forced the thinking level to move, so the
  /// change is explained rather than silent.
  @State private var thinkingNotice: String?
  @State private var isNearBottom = true
  /// When the run in flight began, and — once it settles — which answer it
  /// produced and how long it took.
  ///
  /// The clock lives here rather than in the row because the row's *identity
  /// changes as the run ends*: the streamed placeholder is `local-assistant-…`
  /// until the server's message replaces it, so any `@State` inside the row is
  /// discarded at exactly the moment the duration becomes final. One clock per
  /// transcript is also all that is ever needed — a conversation streams one
  /// answer at a time.
  @State private var runStartedAt: Date?
  @State private var settledRunID: String?
  @State private var settledRunDuration: TimeInterval?
  /// The chat column's own height, handed to the composer so the voice field
  /// can be sized from the conversation instead of from the composer's strip.
  /// See ``JunoMobileComposer/auraLayer``.
  @State private var chatColumnHeight: CGFloat = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var colorScheme
  /// Regular width docks the artifact canvas beside the thread instead of
  /// covering it, which is what the browser does.
  @Environment(\.horizontalSizeClass) private var sizeClass
  /// The call in progress, published by the shell. Read here as well as in the
  /// composer because the spoken turns belong in this transcript.
  @Environment(\.junoVoiceSession) private var voiceSession
  @FocusState private var composerFocused: Bool

  /// Whether the reader has actually chosen a model on this screen.
  ///
  /// This exists because "keep the current selection" and "fall back to the
  /// first selectable model" fight each other. The first resolution runs before
  /// the settings row has loaded, so it falls back to `juno:auto`; the account
  /// default then arrives, resolution runs again — and sees a `current` that is
  /// selectable and keeps it. The account default could never win, which is the
  /// bug this flag closes: only a write that came through ``modelSelection``
  /// counts as a choice.
  @State private var userPickedModel = false

  /// The binding the model control writes through. `configureSelections()`
  /// assigns `selectedModelID` directly and so never sets the flag.
  private var modelSelection: Binding<String> {
    Binding(
      get: { selectedModelID },
      set: { newValue in
        selectedModelID = newValue
        userPickedModel = true
      }
    )
  }

  /// Drives the transcript's scroll offset.
  ///
  /// This replaced a `ScrollViewReader` + `proxy.scrollTo(bottomAnchor)`, which
  /// **silently did nothing here**: on a scroll view carrying
  /// `.defaultScrollAnchor(.bottom)`, `scrollTo(id:)` is inert, so the
  /// jump-to-latest button was a control that appeared, highlighted under a
  /// finger, and moved the transcript not at all. It went unnoticed because the
  /// bottom anchor *also* pins the view as content grows — so the follow-the-
  /// stream path looked correct while its `scrollTo` was doing nothing either.
  ///
  /// `ScrollPosition.scrollTo(edge:)` asks for the edge directly rather than for
  /// a view that happens to sit near it, which is both what the feature means
  /// and the API that works with a bottom-anchored scroll view.
  @State private var scrollPosition = ScrollPosition(edge: .bottom)

  private var messages: [NativeChatMessage] {
    model.messages(for: conversation.id)
  }

  /// The live half of a spoken conversation, if one is running. Transient —
  /// the dock files the finished turns on hang-up, and these disappear with
  /// the session that produced them.
  private var voiceMessages: [NativeChatMessage] {
    voiceSession?.liveMessages(conversationID: conversation.id) ?? []
  }

  /// Opens the artifact a transcript card stands for. **Always.**
  ///
  /// This used to be a lookup that could fail silently. The transcript sees
  /// only what the tag said — `identifier="sidebar-spec"` — while the store
  /// keys artifacts by their row id, so resolution went `identifier` →
  /// `NativeArtifact` and simply returned when there was no match. Tapping the
  /// card then did nothing, with no explanation, in three ordinary cases: the
  /// row had not synced yet (every freshly-written artifact, for as long as the
  /// next sync takes), the model omitted `identifier` and the derived `art-…`
  /// hash disagreed with the server's, and any reply read on a device that is
  /// offline.
  ///
  /// Three steps now, in descending order of what they can offer:
  ///
  /// 1. **The stored row by identifier** — the full screen: versions, restore,
  ///    edit, export.
  /// 2. **The stored row by title**, within this conversation. A title collision
  ///    across two artifacts in one thread is a far smaller risk than the
  ///    identifier mismatch this repairs.
  /// 3. **The tag's own body**, rendered read-only. No versions and no editing,
  ///    because there is no row to version or edit — but the artifact itself,
  ///    which is what the reader asked to see.
  private func openArtifact(_ reference: NativeMessageContent.ArtifactReference) {
    if let match = storedArtifact(for: reference) {
      // Animated because on a regular-width screen this is a *layout*
      // change — the canvas slides in beside the thread and the thread
      // gives up its width. A sheet ignores the transaction and animates
      // itself, so one call is correct for both.
      withAnimation(
        JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion)
      ) {
        openArtifact = match
      }
      return
    }
    guard !reference.content.isEmpty else { return }
    inlineArtifact = JunoMobileInlineArtifact(reference: reference)
  }

  /// Branch-from-here: the server copies the thread up to this message into a
  /// new conversation, and the app opens it — the same move the web makes.
  private var branchAction: ((String) -> Void)? {
    guard let messageActions, let accountID else { return nil }
    let conversationID = conversation.id
    return { messageID in
      Task {
        guard
          let branched = try? await messageActions.branch(
            conversationID: conversationID,
            atMessageID: messageID,
            for: accountID
          )
        else { return }
        await model.reload()
        model.selectedConversationID = branched
      }
    }
  }

  /// Re-asks a prompt as a new branch beside the original.
  ///
  /// Nothing is overwritten: the original keeps its words and its replies, and
  /// the pager under the bubble is what goes back to them. The model is the
  /// composer's live selection — the reader can change it and then re-ask,
  /// which is the whole point of asking again.
  private func editMessage(_ message: NativeChatMessage, newContent: String) {
    guard !selectedModelID.isEmpty else { return }
    Task {
      await model.editUserMessage(
        messageID: message.id,
        conversationID: conversation.id,
        newContent: newContent,
        modelID: selectedModelID,
        reasoningEffort: reasoningEffort
      )
    }
  }

  /// Rating an answer. Applied to the row optimistically because the round trip
  /// is a write with no reply worth waiting for, and a thumb that fills in a
  /// second after the tap reads as a broken button.
  private var feedbackAction: ((String, NativeChatFeedback?) -> Void)? {
    guard let messageActions, let accountID else { return nil }
    let conversationID = conversation.id
    return { messageID, feedback in
      model.applyFeedback(
        feedback, messageID: messageID, conversationID: conversationID
      )
      Task {
        try? await messageActions.setFeedback(
          messageID: messageID,
          feedback: feedback.map { $0 == .up ? .up : .down },
          for: accountID
        )
      }
    }
  }

  private func storedArtifact(
    for reference: NativeMessageContent.ArtifactReference
  ) -> NativeArtifact? {
    guard let artifactModel else { return nil }
    if !reference.identifier.isEmpty,
      let match = artifactModel.artifacts.first(where: {
        $0.identifier == reference.identifier
      })
    {
      return match
    }
    let title = reference.title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return nil }
    return artifactModel.artifacts.first {
      $0.conversationID == conversation.id
        && $0.title.caseInsensitiveCompare(title) == .orderedSame
    }
  }

  /// The answer currently being produced, if any.
  private var streamingMessageID: String? {
    guard let last = messages.last, last.role == .assistant, last.isPending else { return nil }
    return last.id
  }

  /// This run's clock as the given row should see it: live while the row is the
  /// one streaming, the frozen measurement on the row it belongs to, and empty
  /// for every message whose run this session never watched.
  private func clock(for message: NativeChatMessage) -> JunoMobileRunClock {
    if message.id == streamingMessageID {
      return JunoMobileRunClock(startedAt: runStartedAt)
    }
    if message.id == settledRunID {
      return JunoMobileRunClock(duration: settledRunDuration)
    }
    return .none
  }

  /// Changes whenever streamed content grows or a message is added, driving
  /// the follow-the-stream auto-scroll.
  ///
  /// The spoken lines count too: during a call they are the only thing growing
  /// at the bottom of the transcript, and left out of this the reader watches a
  /// conversation scroll off the foot of the screen.
  private var streamSignature: Int {
    let last = messages.last
    let voice = voiceMessages
    return messages.count
      + (last?.content.count ?? 0)
      + (last?.reasoning?.count ?? 0)
      + voice.count
      + (voice.last?.content.count ?? 0)
  }

  private var selectedModel: NativeChatModelOption? {
    model.modelCatalog.first { $0.id == selectedModelID }
  }

  /// Whether the greeting is standing in for the transcript. It owns the bloom
  /// whenever it is, and the composer stands its own down.
  private var greetingVisible: Bool {
    messages.isEmpty && voiceMessages.isEmpty
  }

  /// What the greeting's bloom is made of, gathered here because this screen
  /// owns both the model selection and the send swell.
  private var auraLight: JunoMobileAuraLight {
    JunoMobileAuraLight(
      model: selectedModel,
      effort: reasoningEffort,
      focused: composerFocused,
      sending: sendSwell.active,
      viewport: chatColumnHeight,
      dark: colorScheme == .dark
    )
  }

  /// The transcript itself. Extracted from `body` because the merged view
  /// stacks a long modifier chain on an inline `ScrollView`, and the type
  /// checker times out on the combined expression.
  @ViewBuilder
  private var transcript: some View {
    if greetingVisible {
      // A conversation with no turns is the same moment as a draft, so it
      // gets the same greeting rather than a "No messages yet" placard.
      // `containerRelativeFrame` gives it the scroll view's own height so
      // it centres in the visible area — a fixed `minHeight` inside a
      // bottom-anchored scroll view pins it to the composer instead.
      JunoMobileGreeting(
        name: profileName,
        aura: voiceSession == nil ? auraLight : nil,
        onSuggestion: { suggestion in
          prompt = suggestion
          composerFocused = true
        }
      )
      .frame(maxWidth: .infinity)
      .containerRelativeFrame(.vertical)
    } else {
      // The web's own transcript metrics: `max-w-3xl space-y-6 px-4 py-6`.
      // The width clamp is not decoration — it is what keeps a line of
      // running text at a readable measure on an iPad, where a full-bleed
      // answer runs to ~90 characters.
      LazyVStack(spacing: JunoSpace.section) {
        ForEach(messages) { message in
          JunoMobileMessageRow(
            message: message,
            clock: clock(for: message),
            openArtifact: openArtifact,
            readAloud: readAloud,
            voiceID: voiceID,
            // Only the last answer, as the web does: regenerating an
            // earlier one would discard every turn after it. During
            // a call it is not the last answer — the spoken lines
            // below it are — which is exactly why the web's own
            // `isLast` is computed over the displayed messages and
            // not over the filed ones.
            regenerate: voiceSession == nil
              && message.id == messages.last?.id
              && message.role == .assistant
              && !model.isGenerating
              ? { model.retryLastMessage(conversationID: conversation.id) }
              : nil,
            continueResponse: voiceSession == nil
              && message.id == messages.last?.id
              && message.role == .assistant
              && model.canContinueSelectedConversation
              ? { _ = model.continueLastResponse(conversationID: conversation.id) }
              : nil,
            branch: branchAction,
            setFeedback: feedbackAction,
            branchPosition: model.branchPosition(
              for: message.id,
              in: conversation.id
            ),
            stepBranch: { offset in
              Task {
                await model.stepBranch(
                  from: message.id,
                  in: conversation.id,
                  offset: offset
                )
              }
            },
            // Only a question can be re-asked, and only once it is
            // a message the store holds — the fork hangs the new
            // wording off this row's own place in the tree.
            editMessage: message.role == .user && !message.isPending
              ? { newContent in editMessage(message, newContent: newContent) }
              : nil,
            isGenerating: model.isGenerating
          )
          // `rise-in`, as the web gives every new turn. Scoped to the
          // stack's `.animation(_:value: messages.count)` below, which
          // is also what limits it to genuinely new messages: SwiftUI
          // does not run an insertion transition for rows that were
          // already there on the first layout, so a loaded history
          // arrives settled rather than cascading up the screen.
          .transition(.opacity.combined(with: .offset(y: JunoSpace.snug)))
        }

        // Approval receipts are rendered as their own safety surface,
        // beside the turn they block. They are also recovered from the
        // server on selection, so a missed stream cannot strand an
        // action behind an invisible native-only state.
        ForEach(model.chatApprovals(for: conversation.id)) { approval in
          NativeChatApprovalCard(
            approval: approval,
            isBusy: model.chatApprovalInFlightID == approval.id,
            errorMessage: model.chatApprovalError(for: approval.id),
            canAllowScope: model.canAllowChatApprovalScope(approval),
            decide: { decision in
              Task {
                await model.decideChatApproval(approval, decision: decision)
              }
            }
          )
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        // The call, still being spoken, after the messages that are
        // already filed — the web's `[...chat.messages, ...voiceMessages]`
        // in the order it means.
        JunoMobileVoiceLines(messages: voiceMessages)

        // Under the last reply, and only once it has settled. Inside the
        // same stack so it scrolls with the transcript rather than
        // floating over it, and after the ForEach so it cannot come
        // between two messages.
        NativeFollowUpStrip(
          conversationID: conversation.id,
          accountID: accountID,
          client: followUpClient,
          // Never during a call: the strip keys off the last *filed*
          // message, so it would open between the persisted turns and
          // the spoken ones — and "ask this next" is not an offer to
          // make to someone who is mid-sentence.
          ready: voiceSession == nil
            && !model.isGenerating
            && messages.last?.role == .assistant,
          onPick: { prompt = $0 }
        )
      }
      // Keyed on the count, never on the messages themselves: an unkeyed
      // `.animation` here would also animate every streamed token as the
      // last answer grows, which is a transcript that visibly reflows
      // while it is being read.
      .animation(
        JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion),
        value: messages.count
      )
      .padding(.horizontal, JunoSpace.regular)
      .padding(.vertical, JunoSpace.section)
      .frame(maxWidth: 768)
      .frame(maxWidth: .infinity)
    }
  }

  /// Extracted from `body` for the same reason as `scrollArea`: the nested menu
  /// was on its own enough to time the type checker out.
  @ToolbarContentBuilder
  private var conversationToolbar: some ToolbarContent {
    ToolbarItem(placement: .principal) {
      JunoMobileConversationTitle(
        title: conversation.title,
        justRenamed: model.recentlyRenamedConversationID == conversation.id,
        onAnimationShown: { model.acknowledgeTitleAnimation(for: conversation.id) }
      )
    }
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        if !messages.isEmpty, let newChat {
          Button(action: newChat) {
            Label("New chat", systemImage: "square.and.pencil")
          }
          Divider()
        }
        if shareClient != nil {
          Button {
            Task { await createShare() }
          } label: {
            Label("Share…", systemImage: "square.and.arrow.up")
          }
          .disabled(sharing)
        }
        Button {
          editValue = conversation.title
          showingRename = true
        } label: {
          Label("Rename", systemImage: "pencil")
        }
        Button {
          Task {
            await model.setPinned(id: conversation.id, pinned: !conversation.pinned)
          }
        } label: {
          Label(
            conversation.pinned ? "Unpin" : "Pin",
            systemImage: conversation.pinned ? "pin.slash" : "pin"
          )
        }
        Divider()
        // Delete, not archive. Archiving moved a conversation into a
        // folder this app has no screen for, which from the phone is
        // indistinguishable from losing it.
        Button(role: .destructive) {
          showingDelete = true
        } label: {
          Label("Delete", systemImage: "trash")
        }
      } label: {
        // `ellipsis`, not `ellipsis.circle`. The symbol's own ring sat
        // inside the capsule the toolbar already draws, so the button
        // wore two concentric outlines around three dots.
        Image(systemName: "ellipsis")
          .junoFont(size: 16, relativeTo: .callout, weight: .semibold)
          .foregroundStyle(Color.primary)
          .frame(minWidth: 32, minHeight: 32)
      }
      // On the Menu, not on the Label. A `Menu` tints its whole label with
      // the accent, and a `foregroundStyle` inside cannot override that —
      // the same trap `JunoMobileComposerActions` already documents for the
      // composer's "+". With the accent applied this came out coral.
      .tint(Color.primary)
      .disabled(model.isMutating || conversation.isPending)
      .accessibilityIdentifier("juno.mobile.conversation-menu")
    }
  }

  /// Returns the reader to the newest turn.
  ///
  /// `isNearBottom` is set here rather than left to the geometry callback: the
  /// control has done its job the moment it is pressed, and a jump-to-latest
  /// that lingers while the scroll animates reads as a button that failed. The
  /// callback still owns the value — it will put it back to `false` if the
  /// scroll did not in fact reach the bottom.
  private func jumpToLatest() {
    withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
      scrollPosition.scrollTo(edge: .bottom)
      isNearBottom = true
    }
  }

  /// The scrolling transcript with its follow-the-stream behaviour and
  /// jump-to-latest control. A separate function so `body` stays a short
  /// enough expression for the type checker.
  private var scrollArea: some View {
    ScrollView { transcript }
      // Scoped to the transcript, NOT to the whole screen: applied after
      // `.safeAreaInset` it was stamped onto every composer control too,
      // so the model and Thinking chips all reported this identifier
      // instead of their own.
      .accessibilityIdentifier("juno.mobile.conversation-detail")
      .background(Color.junoCanvas)
      .scrollDismissesKeyboard(.interactively)
      .simultaneousGesture(
        TapGesture().onEnded {
          composerFocused = false
        }
      )
      // The chat column, measured where it is: this scroll view spans the
      // whole column — the composer is a safe-area inset *inside* it, not a
      // sibling below it — so its height is the column's height, and the voice
      // field takes its 46% from here. Measuring anything the composer can
      // reach on its own would only ever measure the composer.
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        chatColumnHeight = $0
      }
      // Both are needed and they do different jobs. `defaultScrollAnchor`
      // keeps the bottom pinned as the answer grows — that is what makes a
      // streaming reply stay in view without anyone asking it to. The
      // position binding is how a *deliberate* jump is expressed.
      .defaultScrollAnchor(.bottom)
      .scrollPosition($scrollPosition)
      .onScrollGeometryChange(for: Bool.self) { geometry in
        let distance =
          geometry.contentSize.height
          - geometry.contentOffset.y
          - geometry.containerSize.height
        // Non-scrollable (content fits) counts as "at bottom" so the
        // jump-to-latest control never shows when there is nothing to
        // scroll to.
        return geometry.contentSize.height <= geometry.containerSize.height
          || distance < 120
      } action: { _, nearBottom in
        isNearBottom = nearBottom
      }
      .onChange(of: streamSignature) { _, _ in
        guard isNearBottom else { return }
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
          scrollPosition.scrollTo(edge: .bottom)
        }
      }
      .overlay(alignment: .bottomTrailing) {
        if !isNearBottom && !messages.isEmpty {
          Button {
            jumpToLatest()
          } label: {
            Image(systemName: "arrow.down")
              .font(.body.weight(.semibold))
              // Ink, not coral. The screen's `.tint` is the accent, and
              // a bare `Image` in a `Button` label takes it — so the one
              // piece of chrome that means "you have scrolled up" was
              // wearing the colour this app spends on what is *active*.
              // `Color.primary` follows the theme, so it is black on the
              // light canvas and white on the dark one.
              .foregroundStyle(Color.primary)
              .frame(width: 44, height: 44)
              // Real Liquid Glass, like every other floating control in
              // this app. `.regularMaterial` is a blur — it does not
              // refract, it does not flex under a finger, and beside the
              // glass composer directly below it the difference reads.
              .modifier(JunoGlassCircle())
              // **Load-bearing.** A `.plain` button's hit region is its
              // label's content shape, and an `Image` in a `.frame` has
              // one the size of the glyph — around 17pt in the middle of
              // a 44pt circle. VoiceOver and XCUITest both read the 44pt
              // accessibility frame and call it hittable, so the control
              // looked fine from every angle except a thumb: taps landed
              // on the glass, the action never ran, and the transcript
              // sat still. Every other icon button in this app declares
              // its shape for exactly this reason.
              .contentShape(Circle())
          }
          .buttonStyle(.plain)
          .padding(.trailing, JunoSpace.regular)
          .padding(.bottom, JunoSpace.snug)
          .transition(.scale.combined(with: .opacity))
          .accessibilityLabel("Scroll to latest")
          .accessibilityIdentifier("juno.mobile.chat-scroll-bottom")
        }
      }
  }

  /// The thread and, on a screen wide enough to hold both, the artifact canvas
  /// docked beside it.
  ///
  /// This is the browser's arrangement — the canvas takes the right of the
  /// window and the conversation stays exactly where it was, still scrollable,
  /// still typeable — and it is docked **in layout**, as a plain `HStack` pane,
  /// rather than presented. An `.inspector` here would be the same shape but a
  /// different mechanism, and on this OS it re-enters the constraint pass and
  /// traps. The composer's `safeAreaInset` stays on the thread column, so the
  /// keyboard still lifts the capsule and not the canvas.
  ///
  /// The `HStack` is unconditional, and that is load-bearing rather than
  /// tidiness: branching between "just the thread" and "the thread plus a
  /// pane" would put the thread in two different places in the view tree, and
  /// SwiftUI would read that as a different view — resetting the transcript's
  /// scroll position and remounting the composer every time an artifact was
  /// opened or closed. Keeping the stack means only the pane comes and goes.
  var body: some View {
    HStack(spacing: 0) {
      thread
      if let artifact = dockedArtifact {
        Rectangle()
          .fill(Color.junoHairline)
          .frame(width: 1)
          .accessibilityHidden(true)
        JunoMobileArtifactDetail(
          model: artifactModel!,
          artifact: artifact,
          // Already in the conversation this came from; the only
          // sensible "go there" is to close.
          openConversation: { _ in closeArtifact() },
          close: closeArtifact
        )
        .frame(width: 420)
        .transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
  }

  /// The artifact the reader opened, when this screen is wide enough to dock it.
  private var dockedArtifact: NativeArtifact? {
    guard sizeClass == .regular, artifactModel != nil else { return nil }
    return openArtifact
  }

  /// The same artifact as a *sheet* — nil whenever it is docked instead, so the
  /// two presentations can never both be up.
  private var sheetedArtifact: Binding<NativeArtifact?> {
    Binding(
      get: { dockedArtifact == nil ? openArtifact : nil },
      set: { openArtifact = $0 }
    )
  }

  private func closeArtifact() {
    withAnimation(
      JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion)
    ) {
      openArtifact = nil
    }
  }

  private var thread: some View {
    scrollArea
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { conversationToolbar }
      .alert("Rename conversation", isPresented: $showingRename) {
        TextField("Title", text: $editValue)
        Button("Cancel", role: .cancel) {}
        Button("Save") {
          Task { await model.renameConversation(id: conversation.id, title: editValue) }
        }
      }
      .confirmationDialog(
        "Delete this conversation?",
        isPresented: $showingDelete,
        titleVisibility: .visible
      ) {
        Button("Delete", role: .destructive) {
          Task { await model.deleteConversation(id: conversation.id) }
        }
        .contentShape(.rect)
        Button("Cancel", role: .cancel) {}
          .contentShape(.rect)
      } message: {
        Text("chat.delete.warning")
      }
      .safeAreaInset(edge: .bottom) {
        JunoMobileComposer(
          model: model,
          conversation: conversation,
          projects: projects,
          prompt: $prompt,
          selectedModelID: modelSelection,
          reasoningEffort: $reasoningEffort,
          thinkingNotice: $thinkingNotice,
          attachmentModel: attachmentModel,
          tools: tools,
          connectors: connectors,
          memoryEnabled: memoryEnabled,
          setMemoryEnabled: setMemoryEnabled,
          openLibrary: libraryModel == nil ? nil : { showingLibrary = true },
          attachmentCoordinator: attachments,
          openPlugins: openPlugins,
          openVoiceMode: openVoiceMode,
          chatColumnHeight: chatColumnHeight,
          composerFocused: $composerFocused,
          sendSwell: sendSwell,
          greetingVisible: greetingVisible
        )
      }
      // After the inset, never before it — see the note in the draft screen.
      .junoAttachmentSurfaces(
        coordinator: attachments,
        attachmentModel: attachmentModel,
        conversationID: conversation.id
      )
      .junoLibraryPicker(
        isPresented: $showingLibrary,
        libraryModel: libraryModel,
        attachmentModel: attachmentModel
      )
      .sheet(item: $inlineArtifact) { inline in
        NavigationStack {
          JunoMobileInlineArtifactView(
            artifact: inline,
            close: { inlineArtifact = nil }
          )
        }
        // No detents and no grabber. `[.large]` is what a sheet does anyway
        // when you say nothing, and a grabber on a sheet with a single detent
        // advertises a resize that cannot happen — the HIG's rule is that a
        // grabber belongs on a *resizable* sheet. The artifact is reading
        // material, so full height is right and the ground is ours; the
        // system still owns the platter, its radius and its material edge.
        .junoSheetSurface(.page)
        .tint(Color.junoAccent)
      }
      .onAppear { configureSelections() }
      .onChange(of: selectedModelID) { _, _ in configureSelections() }
      .onChange(of: model.modelCatalog) { _, _ in configureSelections() }
      .onChange(of: accountDefaultModelID) { _, _ in configureSelections() }
      // A sheet, not a push, on a phone: the web docks the canvas beside the
      // thread so the conversation stays put, and where there is no room to
      // dock, the equivalent of "stays put" is a sheet the reader dismisses
      // straight back onto it. Regular width gets the real dock — see `body`.
      //
      // No `NavigationStack` and no navigation bar: the canvas draws the
      // website's own header instead — title, mono meta line, the view switch,
      // share, close — so the sheet and the iPad's docked panel are the same
      // surface rather than two designs for one thing.
      .sheet(item: sheetedArtifact) { artifact in
        JunoMobileArtifactDetail(
          model: artifactModel!,
          artifact: artifact,
          openConversation: { _ in openArtifact = nil },
          close: { openArtifact = nil }
        )
        // Same as the inline sheet above: a canvas is not a chooser, so it
        // goes full height with our ground under it and no grabber over it.
        .junoSheetSurface(.page)
      }
      .onChange(of: streamingMessageID) { previous, current in
        trackRun(from: previous, to: current)
      }
  }

  /// Starts the run clock when an answer begins and freezes it when that answer
  /// settles.
  ///
  /// The id moving from `local-assistant-…` to the server's own id *mid-run* is
  /// why this watches the transition rather than the value: both ends are
  /// non-nil across that swap, so the start time survives it. Only a fall to nil
  /// is the run ending, and the message it belongs to is the last answer in the
  /// transcript at that instant.
  private func trackRun(from previous: String?, to current: String?) {
    if current != nil {
      if runStartedAt == nil { runStartedAt = Date() }
      return
    }
    guard let startedAt = runStartedAt else { return }
    runStartedAt = nil
    // Prefer the id that just settled; fall back to the placeholder's, which
    // is what a run that never reached the server leaves behind.
    settledRunID = messages.last(where: { $0.role == .assistant })?.id ?? previous
    settledRunDuration = Date().timeIntervalSince(startedAt)
  }

  /// Keeps the composer's model and thinking selections valid as the catalog
  /// loads and as the user switches models. Two rules matter here: a model
  /// that is no longer selectable (plan change, retirement) falls back to one
  /// that is, and a thinking level the new model cannot honour is re-fitted —
  /// with a sentence explaining it, never silently.
  private func configureSelections() {
    selectedModelID = JunoMobileComposerSelection.resolvedModelID(
      current: userPickedModel ? selectedModelID : "",
      conversationModel: conversation.model,
      accountDefault: accountDefaultModelID,
      selectable: model.selectableModels
    )
    guard let selectedModel else {
      reasoningEffort = nil
      return
    }
    let adjustment = NativeThinkingScale(model: selectedModel)
      .adjusting(reasoningEffort)
    reasoningEffort = adjustment.effort
    // Only surface the notice when something actually moved; the draft is
    // untouched either way.
    thinkingNotice = adjustment.explanation
  }
}

/// The navigation-bar title, which has to be able to *change under the reader*
/// when the server names the conversation from its first message.
///
/// A silent swap is the thing to avoid: the reader typed a message, looked away,
/// and the header is suddenly different text. So the new title arrives as a
/// blur-replace and holds a brief coral tint — long enough to be noticed as "Juno
/// named this", short enough not to become chrome.
private struct JunoMobileConversationTitle: View {
  let title: String
  let justRenamed: Bool
  let onAnimationShown: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var highlighted = false

  var body: some View {
    Text(title)
      .junoFont(size: 16, relativeTo: .headline, weight: .semibold)
      .lineLimit(1)
      .truncationMode(.tail)
      .foregroundStyle(highlighted ? Color.junoAccent : Color.primary)
      .id(title)
      .transition(.blurReplace)
      .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: title)
      .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: highlighted)
      .accessibilityLabel(title)
      .accessibilityIdentifier("juno.mobile.conversation-title")
      .task(id: justRenamed) {
        guard justRenamed else { return }
        highlighted = true
        try? await Task.sleep(for: .milliseconds(1_100))
        highlighted = false
        onAnimationShown()
      }
  }
}

/// The live half of a spoken conversation, as ordinary bubbles.
///
/// There is no voice-shaped row here and there should not be one: what the
/// reader hears is what they will find in this chat afterwards, so it is shown
/// in the shapes the chat already uses — the reader's own words in a bubble on
/// the trailing edge, Juno's as running text — and the only thing that marks a
/// line as live is that it is dimmed until the recognizer settles it.
///
/// **Dimmed, and that is the whole signal.** A non-final line is a hypothesis
/// being rewritten several times a second: the words visibly change under the
/// eye, and rendering them at full weight claims a sentence was said that may
/// not have been. The screens this replaced dimmed them for the same reason.
private struct JunoMobileVoiceLines: View {
  let messages: [NativeChatMessage]

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// Enough to read at arm's length, far enough from settled text that the
  /// difference is not a trick of the light.
  private static let provisional: Double = 0.55

  var body: some View {
    ForEach(messages) { message in
      JunoMobileMessageRow(message: message, voice: true)
        .opacity(message.isPending ? Self.provisional : 1)
        // The settle is the one moment worth animating: a line snapping
        // to full weight is how the reader learns it is now a fact.
        .animation(
          JunoMotion.reduced(JunoMotion.fast, when: reduceMotion),
          value: message.isPending
        )
    }
  }
}

/// One turn.
///
/// The two roles are shaped differently on purpose, matching the web: the
/// reader's own message is a contained bubble on the trailing edge, and Juno's
/// answer is full-width running text with no container at all. Boxing the answer
/// too made long replies read as a wall of chrome and cost most of the line
/// length on a phone.
///
/// **Nothing here renders `message.content` directly.** The server's text carries
/// wire tags the reader must never see — `<juno:memory>` most of all, which
/// `juno` being a legal URI scheme turned into a coral *tappable link* labelled
/// "juno:memory" in the middle of an answer. `NativeMessageContent` is the one
/// place that knows which runs of a reply are prose, and every path through this
/// view goes through it: the bubbles, the pasteboard and VoiceOver alike.
private struct JunoMobileMessageRow: View {
  let message: NativeChatMessage
  var clock: JunoMobileRunClock = .none
  /// Opens the artifact a card stands for. Takes the whole reference, not just
  /// the identifier: the tag's body is the fallback when no stored row matches,
  /// so the resolver needs it. See `openArtifact(_:)` on the chat screen.
  var openArtifact: ((NativeMessageContent.ArtifactReference) -> Void)?
  /// The screen's one speaker. Nil where reading aloud is unavailable.
  var readAloud: JunoMobileReadAloud?
  /// The account's chosen read-aloud voice, passed to the server's TTS.
  var voiceID: String?
  /// Offered only on the last answer, as the web does — regenerating anything
  /// earlier would silently discard every turn after it.
  var regenerate: (() -> Void)?
  /// Offered for a length/network boundary, preserving the partial answer and
  /// sending the website's continuation prompt as a new turn.
  var continueResponse: (() -> Void)? = nil
  var branch: ((String) -> Void)?
  var setFeedback: ((String, NativeChatFeedback?) -> Void)?
  /// Whether this is a line of a call in progress rather than a filed message.
  ///
  /// The web's `message.voice`, and it withholds the same two things. The run
  /// trace, because a spoken answer is not produced by a run this client
  /// watched — the dock above says whether Juno is speaking, and a second
  /// "Writing…" over every partial line contradicts it. And the action row,
  /// because rating, branching from or regenerating a turn that exists nowhere
  /// yet has nothing to act on; all six controls arrive with the saved message
  /// when the call is filed.
  var voice: Bool = false
  /// Where this message sits among its revisions, or nil when it has none.
  ///
  /// Nil is the answer for every message in a conversation nobody has edited,
  /// which is what keeps the `‹ 1 / 1 ›` pager — a control that cannot do
  /// anything — off the overwhelming majority of transcripts.
  var branchPosition: NativeMessageBranchPosition?
  /// Switches to the revision `offset` steps away. Supplied by the screen
  /// rather than derived here: a row cannot reach the store.
  var stepBranch: ((Int) -> Void)?
  /// Re-asks this prompt with new wording, as a **new branch**. The original
  /// keeps its text and its whole subtree of replies. Nil on answers and on
  /// spoken lines, neither of which can be re-asked.
  var editMessage: ((String) -> Void)?
  /// Whether a generation is running. Greys the pager and withholds Edit
  /// rather than hiding either — a control that vanishes mid-stream reads as a
  /// revision that was lost.
  var isGenerating: Bool = false

  @State private var copied = false
  /// Whether this prompt is open for rewriting, and the words being written.
  ///
  /// Local to the row on purpose: an edit in progress is not conversation
  /// state, and hoisting it would make a `LazyVStack` tearing the row down on
  /// scroll into a way to lose what someone was typing.
  @State private var editing = false
  @State private var draft = ""
  @FocusState private var editorFocused: Bool

  /// The transcript's own width, so the user bubble can be capped at a share of
  /// it rather than at a guessed number of points.
  @State private var rowWidth: CGFloat = 0

  /// Whether a long prompt is showing in full. Collapsed is the resting state,
  /// as it is on the web.
  @State private var expanded = false

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var isUser: Bool { message.role == .user }

  /// The reply as the reader sees it — wire tags removed, and the duplicate
  /// trailing `## Sources` list dropped when the chips below already carry it.
  private var displayContent: String {
    message.sources.isEmpty
      ? message.content
      : NativeMessageContent.strippingTrailingSourcesSection(message.content)
  }

  private var parts: [NativeMessageContent.Part] {
    NativeMessageContent.parts(of: displayContent)
  }

  /// What Copy puts on the pasteboard and what VoiceOver reads: the visible
  /// answer, never the wire format.
  private var plainText: String {
    NativeMessageContent.plainText(of: message.content)
  }

  /// What speech gets. Same text minus the inline learning blocks — those are
  /// figures, and a figure read out as YAML is noise. Copy keeps them, because
  /// pasting a reply somewhere should round-trip the lesson.
  private var spokenText: String {
    NativeMessageContent.spoken(of: message.content)
  }

  var body: some View {
    if isUser {
      userBubble
    } else {
      assistantAnswer
    }
  }

  /// The web's bubble, ported metric for metric: `bg-secondary`, a hairline,
  /// `rounded-2xl rounded-br-md` and `max-w-[85%]`.
  ///
  /// The tail corner is the load-bearing detail — a uniformly rounded rectangle
  /// is a card, and one clipped corner on the trailing-bottom edge is what makes
  /// it read as something *said*. The fill was coral at 13%, which spent the
  /// accent on the reader's own words; the web keeps the accent for what is
  /// active and the bubble neutral.
  /// Whether this prompt is long enough to open collapsed. The rule and the
  /// numbers are the website's — see ``NativePromptLimits``.
  private var isLongPrompt: Bool {
    isUser && NativePromptLimits.isLongMessage(plainText)
  }

  private var userBubble: some View {
    HStack(spacing: 0) {
      Spacer(minLength: 0)
      VStack(alignment: .trailing, spacing: JunoSpace.tight) {
        if editing {
          promptEditor
        } else {
          bubbleBody
          if isLongPrompt { expandControl }
        }
        promptControls
      }
      // A real cap, not a fixed width: the bubble hugs short messages
      // and wraps long ones at 85% of the transcript, as the web's
      // `max-w-[85%]` on a shrink-to-fit flex item does.
      .frame(maxWidth: rowWidth > 0 ? rowWidth * 0.85 : nil, alignment: .trailing)
    }
    .onGeometryChange(for: CGFloat.self) {
      $0.size.width
    } action: {
      rowWidth = $0
    }
    .accessibilityElement(children: .contain)
  }

  /// The `‹ 1 / 3 ›` pager, where this message has revisions to page through.
  ///
  /// Built only when the store handed down a position, which it does only for
  /// a message that genuinely has siblings — so this is empty on almost every
  /// row, and the transcript keeps the spacing it had before trees existed.
  @ViewBuilder
  private var branchNavigator: some View {
    if let branchPosition, let stepBranch {
      NativeBranchNavigator(
        position: branchPosition,
        isEnabled: !isGenerating,
        onStep: stepBranch
      )
    }
  }

  /// The bubble, opened for rewriting in place.
  ///
  /// In place rather than in a sheet: the reader is changing one sentence in a
  /// conversation they can see, and a modal over the transcript takes away the
  /// context that tells them what to change it to. `axis: .vertical` so the
  /// field grows with the prompt instead of scrolling a long one inside two
  /// lines — the same words were readable a moment ago in the bubble.
  private var promptEditor: some View {
    VStack(alignment: .trailing, spacing: JunoSpace.snug) {
      TextField("Edit message", text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .junoFont(size: 15, relativeTo: .body)
        .lineSpacing(5)
        .lineLimit(1...12)
        .focused($editorFocused)
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .background(Color.junoMuted, in: Self.bubbleShape)
        .overlay(Self.bubbleShape.strokeBorder(Color.junoAccent, lineWidth: 1))
        .accessibilityIdentifier("juno.mobile.message-editor")

      HStack(spacing: JunoSpace.cozy) {
        Button("Cancel") {
          editing = false
          editorFocused = false
        }
        .foregroundStyle(Color.junoMutedForeground)
        .accessibilityIdentifier("juno.mobile.message-edit-cancel")
        .contentShape(.rect)

        Button("Send") { submitEdit() }
          .fontWeight(.semibold)
          .foregroundStyle(
            canSubmitEdit ? Color.junoAccent : Color.junoMutedForeground
          )
          .disabled(!canSubmitEdit)
          .accessibilityIdentifier("juno.mobile.message-edit-send")
          .contentShape(.rect)
      }
      .junoFont(size: 14, relativeTo: .subheadline)
      .buttonStyle(.plain)
    }
    .onAppear { editorFocused = true }
  }

  /// Whether the rewrite is worth sending: not blank, and not the words that
  /// are already there. Re-asking an unchanged prompt would spend a turn to
  /// add a revision identical to the one beside it.
  private var canSubmitEdit: Bool {
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    return !trimmed.isEmpty
      && trimmed != plainText.trimmingCharacters(in: .whitespacesAndNewlines)
      && !isGenerating
  }

  private func submitEdit() {
    guard canSubmitEdit, let editMessage else { return }
    editing = false
    editorFocused = false
    editMessage(draft)
  }

  /// Edit and the pager, under the reader's own words.
  @ViewBuilder
  private var promptControls: some View {
    // `voice` withholds Edit for the same reason it withholds the action
    // row: a spoken line exists only in the call controller, and there is no
    // stored message for a fork to branch away from.
    if !voice, editMessage != nil || branchPosition != nil {
      HStack(spacing: 2) {
        branchNavigator
        if editMessage != nil, !editing {
          actionButton(
            systemImage: "pencil",
            label: "message.edit",
            identifier: "juno.mobile.message-edit"
          ) {
            draft = plainText
            editing = true
          }
          .disabled(isGenerating)
        }
      }
      .accessibilityElement(children: .contain)
    }
  }

  /// The bubble proper.
  ///
  /// A long prompt — a pasted system prompt, a curriculum, a stack trace — is
  /// clipped to ``NativePromptLimits/collapsedMessageHeight`` with a fade off
  /// its bottom edge, so the answer the reader actually came back for is not
  /// pushed a full screen down by the thing they already know they wrote.
  /// The text itself is untouched: Copy, VoiceOver and every resend read the
  /// whole message whatever the bubble is showing.
  private var bubbleBody: some View {
    Text(plainText)
      // **Relative to `.body`, which is the whole point.** This was a flat
      // `.junoFont(size: 15, relativeTo: .subheadline)`, so the reader's own words were the one
      // thing in the transcript Dynamic Type could not move: the answer
      // beside it renders through `JunoMarkdownText` at `.font(.body)` and
      // scales all the way to AX5, so at the largest accessibility sizes
      // one conversation was being drawn at two wildly different sizes —
      // Juno at ~53pt and the person at 15pt. Anchoring to `.body` keeps
      // the web's 15px metric at the default setting and keeps the ratio
      // between the two sides constant at every setting above it.
      .junoFont(size: 15, relativeTo: .body)
      // 15pt at the web's `leading-relaxed` (1.625) is ~24pt of line
      // box, so 9pt of extra leading on top of the glyph height.
      .lineSpacing(5)
      .textSelection(.enabled)
      .padding(.horizontal, JunoSpace.regular)
      .padding(.vertical, JunoSpace.cozy)
      .frame(
        maxHeight: isLongPrompt && !expanded
          ? NativePromptLimits.collapsedMessageHeight : nil,
        alignment: .top
      )
      .clipped()
      .overlay(alignment: .bottom) {
        if isLongPrompt && !expanded { fade }
      }
      .background(Color.junoMuted, in: Self.bubbleShape)
      .overlay(Self.bubbleShape.strokeBorder(Color.junoHairline, lineWidth: 1))
      .shadow(color: .black.opacity(0.06), radius: 4, y: 1)
      .contentShape(Self.bubbleShape)
      .contextMenu { copyButton }
      .accessibilityLabel("You said, \(plainText)")
  }

  /// The web's `bg-gradient-to-t from-secondary` — the bubble's own fill
  /// dissolving upward, which is what says "clipped" rather than "ended".
  private var fade: some View {
    LinearGradient(
      colors: [Color.junoMuted, Color.junoMuted.opacity(0)],
      startPoint: .bottom,
      endPoint: .top
    )
    .frame(height: 56)
    .allowsHitTesting(false)
  }

  /// The size is sampled off the head of the message, never counted across the
  /// whole of a multi-megabyte paste.
  private var expandLabel: String {
    guard !expanded else { return String(localized: "Show less") }
    return String(
      localized: "Show more · \(NativePromptLimits.collapsedSummary(for: plainText))",
      comment: "Expands a collapsed long prompt in the transcript"
    )
  }

  /// "Show more · 22 lines", in the metadata voice, on a
  /// Liquid Glass capsule — it is a floating control over the transcript, and
  /// this app's other floating controls are glass.
  private var expandControl: some View {
    Button {
      withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
        expanded.toggle()
      }
    } label: {
      HStack(spacing: JunoSpace.tight) {
        Image(systemName: expanded ? "chevron.up" : "chevron.down")
          .junoFont(size: 11, relativeTo: .caption2, weight: .semibold)
        Text(expandLabel)
          .junoFont(size: 12, relativeTo: .caption)
      }
      .foregroundStyle(Color.junoMutedForeground)
      .padding(.horizontal, JunoSpace.cozy)
      // `minHeight`, not `height`: the capsule has to be able to grow with
      // the label now that the label scales, or the text is clipped by its
      // own control at the accessibility sizes.
      .frame(minHeight: 28)
      .modifier(JunoGlassCapsule())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("juno.mobile.message-expand")
    .frame(minWidth: 44, minHeight: 44)
    .contentShape(.rect)
  }

  /// `rounded-2xl rounded-br-md`: one clipped corner on the trailing-bottom
  /// edge. Uniform corners make a card; the notch is what makes it a remark.
  private static let bubbleShape = UnevenRoundedRectangle(
    topLeadingRadius: JunoRadius.message,
    bottomLeadingRadius: JunoRadius.message,
    bottomTrailingRadius: 6,
    topTrailingRadius: JunoRadius.message,
    style: .continuous
  )

  private var assistantAnswer: some View {
    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
      // The run trace leads the answer, as it does on the web: what Juno is
      // doing belongs above the thing it produced, not in a footnote under
      // it. Never on a spoken line — see ``voice``.
      if !voice {
        JunoMobileThoughtProcessRow(
          streaming: message.isPending,
          writing: !message.content.isEmpty,
          reasoning: message.reasoning,
          clock: clock
        )
      }

      // A generation in flight has no text to render — the picture is the
      // answer, and it arrives whole in the `done` frame. Until then this
      // stands in its place rather than under it.
      if let progress = message.mediaProgress {
        NativeMediaGenerationView(progress: progress)
          .padding(.top, JunoSpace.hairline)
      }

      ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
        switch part {
        case .text(let text):
          // AIcss's caret rides the last paragraph while tokens are
          // still arriving — the one live signal the answer body had
          // none of, since the thought-process row above settles the
          // moment the first token lands.
          JunoLessonText(text, streaming: message.isPending)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .artifact(let artifact):
          JunoMobileArtifactInlineCard(
            artifact: artifact,
            // Inert only while it is still *writing*: half an artifact
            // is not something to open. Once the closing tag lands the
            // card is always live, because the resolver can now always
            // answer — from the store when the row has synced, and from
            // the tag's own body when it has not.
            open: artifact.streaming || openArtifact == nil
              ? nil
              : { openArtifact?(artifact) }
          )
        }
      }

      if !message.sources.isEmpty {
        sources
          .padding(.top, JunoSpace.hairline)
      }

      footer

      if let error = message.errorDescription {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(Color.junoCaution)
      }

      if !message.isPending && !voice { actionRow }

      // Under the answer, where the web puts it. An answer has siblings
      // when the question above it was re-asked, so this is the same
      // pager the prompt carries, reading the same numbers.
      if !voice { branchNavigator }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contextMenu { copyButton }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Juno replied")
  }

  /// AIcss's search rows, in place of a horizontal rail of capsules.
  ///
  /// The capsules spent a whole 28pt chip on a title and dropped the host
  /// entirely, so two results from the same site were indistinguishable and the
  /// row scrolled sideways — which on a phone means half the sources are off
  /// screen with nothing to say they exist. The rows stack, name the page, then
  /// the host, and hang off one rail.
  ///
  /// `query: nil` is deliberate: the native message model carries sources but not
  /// the query the model searched for, and the block omits its label row rather
  /// than inventing one. Every row is `done` — a source on a finished message has
  /// by definition been read.
  private var sources: some View {
    JunoAIcssWebSearch(
      query: nil,
      sites: message.sources.map { source in
        JunoAIcssSearchSite(
          title: source.title,
          label: JunoAIcssSearchSite.label(for: source.url),
          url: source.url,
          state: .done
        )
      },
      settled: true
    )
  }

  /// Which model wrote this and what it cost, in the metadata voice. The
  /// spinner is gone: while a reply is pending the thought-process row
  /// above already says so, and the composer is showing Stop throughout — a
  /// third indicator for one event was the "AI slop" the transcript is being
  /// cleared of.
  ///
  /// The price is the server's own figure, arriving with the message row.
  /// It appears a beat after the answer finishes rather than with the last
  /// token, because the cost is only known once the generation is billed — the
  /// browser has exactly the same gap.
  ///
  /// The ink is `junoMutedForeground` flat. It used to be that token times
  /// `.opacity(0.6)`, and the multiplier was the whole legibility problem:
  /// the token already sits at the contrast floor — 5.2:1 on the canvas in
  /// light, which clears WCAG AA for body text with nothing to spare — so
  /// scaling it down by hand puts this line at roughly 2.4:1, in the
  /// smallest and faintest text in the product. A hand-scaled fixed colour also stops participating in the
  /// system's Increase Contrast adaptation, so the one setting a low-vision
  /// reader would reach for does nothing to it. There is no rung below the
  /// muted token; a line that should be quieter gets less weight or less
  /// size, never less contrast.
  @ViewBuilder
  private var footer: some View {
    if !message.isPending, let line = footerLine {
      Text(line)
        .junoFont(size: 12, relativeTo: .caption)
        .monospacedDigit()
        .junoMetaInk()
        .padding(.top, JunoSpace.hairline)
        .accessibilityLabel(footerAccessibilityLabel ?? line)
    }
  }

  private var footerLine: String? {
    let name = message.model.flatMap { $0.isEmpty ? nil : junoDisplayModelName($0) }
    let price = message.costUSD.map(JunoMobileCost.formatted)
    switch (name, price) {
    case (let name?, let price?): return "\(name) · \(price)"
    case (let name?, nil): return name
    case (nil, let price?): return price
    default: return nil
    }
  }

  private var footerAccessibilityLabel: String? {
    guard let price = message.costUSD.map(JunoMobileCost.formatted) else { return nil }
    guard let name = message.model.flatMap({ $0.isEmpty ? nil : junoDisplayModelName($0) })
    else { return "Cost \(price)" }
    return "\(name), cost \(price)"
  }

  /// The website's action row, ported.
  ///
  /// The phone had **one** of these six, and it was hidden behind a long
  /// press: copy, in a context menu nobody discovers. Everything else the web
  /// puts under an answer — rate it, hear it, branch from it, ask again — had
  /// no equivalent at all.
  ///
  /// Always visible rather than revealed on hover, because a phone has no
  /// hover. That is the one place this deliberately departs from the web,
  /// where the row fades in under the pointer; `coarse:opacity-100` in the
  /// web's own class list is that same concession for touch.
  @ViewBuilder
  private var actionRow: some View {
    if hasAnyAction {
      HStack(spacing: 2) {
        if !plainText.isEmpty {
          actionButton(
            systemImage: copied ? "checkmark" : "doc.on.doc",
            label: copied ? "message.copied" : "message.copy",
            identifier: "juno.mobile.message-copy"
          ) { copy() }
        }

        if let readAloud, !plainText.isEmpty {
          actionButton(
            systemImage: readAloud.isSpeaking(message.id)
              ? "stop.fill"
              : (readAloud.isPreparing(message.id)
                ? "waveform" : "speaker.wave.2"),
            label: readAloud.isSpeaking(message.id)
              ? "message.stop-reading" : "message.read-aloud",
            identifier: "juno.mobile.message-read-aloud",
            active: readAloud.isSpeaking(message.id)
              || readAloud.isPreparing(message.id)
          ) {
            readAloud.toggle(
              messageID: message.id, text: spokenText, voiceID: voiceID
            )
          }
        }

        if let regenerate {
          actionButton(
            systemImage: "arrow.clockwise",
            label: "message.regenerate",
            identifier: "juno.mobile.message-regenerate",
            action: regenerate
          )
        }

        if let continueResponse,
          message.finishReason == .length
            || message.finishReason == .networkError
        {
          actionButton(
            systemImage: "arrow.down.circle",
            label: "message.continue",
            identifier: "juno.mobile.message-continue",
            action: continueResponse
          )
        }

        if let branch {
          actionButton(
            systemImage: "arrow.triangle.branch",
            label: "message.branch",
            identifier: "juno.mobile.message-branch"
          ) { branch(message.id) }
        }

        if let setFeedback {
          actionButton(
            systemImage: message.feedback == .up
              ? "hand.thumbsup.fill" : "hand.thumbsup",
            label: "message.good",
            identifier: "juno.mobile.message-thumbs-up",
            active: message.feedback == .up
          ) { setFeedback(message.id, message.feedback == .up ? nil : .up) }

          actionButton(
            systemImage: message.feedback == .down
              ? "hand.thumbsdown.fill" : "hand.thumbsdown",
            label: "message.bad",
            identifier: "juno.mobile.message-thumbs-down",
            active: message.feedback == .down
          ) { setFeedback(message.id, message.feedback == .down ? nil : .down) }
        }

        Spacer(minLength: 0)
      }
      .padding(.top, JunoSpace.hairline)
      .accessibilityElement(children: .contain)
    }
  }

  private var hasAnyAction: Bool {
    !plainText.isEmpty || regenerate != nil || branch != nil || setFeedback != nil
  }

  /// At least 34pt of touch target around a 14pt glyph. The row reads as quiet
  /// secondary chrome until one of its controls is *on*, which is the only
  /// time the accent appears — a rated answer and a reading in progress are
  /// both states worth seeing from across the screen.
  ///
  /// The frame is a minimum rather than a fixed size because the glyph now
  /// scales: a fixed 34pt box around a glyph that reaches 40pt at AX5 clips
  /// the symbol into a smear. Growing the row is the correct answer — the
  /// whole point of a larger text setting is that the controls get larger too.
  private func actionButton(
    systemImage: String,
    label: LocalizedStringKey,
    identifier: String,
    active: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .junoFont(size: 14, relativeTo: .footnote)
        .foregroundStyle(active ? Color.junoAccent : Color.junoMutedForeground)
        .frame(minWidth: 34, minHeight: 34)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityIdentifier(identifier)
    .frame(minWidth: 44, minHeight: 44)
  }

  private func copy() {
    UIPasteboard.general.string = plainText
    withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
      copied = true
    }
    // Long enough to read, short enough that the row is back to normal
    // before the reader looks again.
    Task {
      try? await Task.sleep(for: .seconds(1.6))
      withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion, tier: .tint)) {
        copied = false
      }
    }
  }

  /// Copies what is on screen. Copying `message.content` handed people a
  /// `<juno:memory>` tag and an artifact's entire source — text they never saw.
  private var copyButton: some View {
    Button {
      UIPasteboard.general.string = plainText
    } label: {
      Label("Copy", systemImage: "doc.on.doc")
    }
    .disabled(plainText.isEmpty)
    .contentShape(.rect)
  }
}

/// An artifact the reply produced, as the compact card the web draws
/// (`artifact-inline-card.tsx`) instead of the tag's raw source.
///
/// Tapping it opens the artifact over the conversation.
///
/// The transcript only knows the `identifier` the tag carried, not the stored
/// row's id, so the chat screen resolves one to the other — and a card whose
/// artifact has not synced yet stays inert rather than opening an empty screen.
private struct JunoMobileArtifactInlineCard: View {
  let artifact: NativeMessageContent.ArtifactReference
  var open: (() -> Void)?

  private var glyph: String {
    switch artifact.kind {
    case "REACT", "HTML": "curlybraces.square"
    case "SVG": "square.on.circle"
    case "MERMAID": "flowchart"
    case "MARKDOWN": "doc.text"
    default: "chevron.left.forwardslash.chevron.right"
    }
  }

  private var subtitle: String {
    if artifact.streaming { return "Writing…" }
    return artifact.language?.uppercased() ?? artifact.kind.capitalized
  }

  var body: some View {
    if let open {
      Button(action: open) { card }
        .buttonStyle(.plain)
        .accessibilityLabel("Artifact, \(artifact.title), \(subtitle). Opens it.")
        .accessibilityIdentifier("juno.mobile.chat-artifact")
        .contentShape(.rect)
    } else {
      card.accessibilityElement(children: .combine)
        .accessibilityLabel("Artifact, \(artifact.title), \(subtitle)")
    }
  }

  private var card: some View {
    HStack(spacing: JunoSpace.cozy) {
      Image(systemName: glyph)
        .junoFont(size: 15, relativeTo: .subheadline)
        .foregroundStyle(Color.junoMutedForeground)
        .frame(minWidth: 22)

      VStack(alignment: .leading, spacing: 1) {
        Text(artifact.title)
          .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
          .lineLimit(1)
          .junoInk()
        Text(subtitle)
          .junoFont(size: 12, relativeTo: .caption)
          .junoMetaInk()
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if artifact.streaming {
        JunoThinkingMatrix(dot: 3, spacing: 2)
          .foregroundStyle(Color.junoMutedForeground)
      } else if open != nil {
        Image(systemName: "chevron.right")
          .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
          .foregroundStyle(Color.junoMutedForeground)
      }
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.vertical, JunoSpace.cozy)
    .background(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .fill(Color.junoSurface)
    )
    .overlay(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .strokeBorder(Color.junoHairline, lineWidth: 1)
    )
    .padding(.vertical, JunoSpace.hairline)
    .contentShape(Rectangle())
  }
}

// The reasoning trace and the pre-answer status both live in
// `JunoMobileThoughtProcess.swift` now, as one control in two states — the shape
// the web settled on. The pair they replaced (a coral `brain` DisclosureGroup and
// a pulsing `sparkles`) is gone.

/// What an answer cost, as the transcript writes it.
///
/// The web's `formatUsd` from `src/lib/utils.ts`, thresholds included — four
/// decimals under a cent, three under a dollar, two above. The two clients have
/// to agree, or the same answer costs "$0.0021" in a browser and "$0.00" on a
/// phone. A flat two-decimal format is exactly that failure: almost every answer
/// costs less than a cent, so it would print "$0.00" for all of them.
enum JunoMobileCost {
  static func formatted(_ value: Double) -> String {
    guard value.isFinite, value > 0 else { return "$0" }
    if value < 0.0001 { return "<$0.0001" }
    if value < 0.01 { return String(format: "$%.4f", value) }
    if value < 1 { return String(format: "$%.3f", value) }
    return String(format: "$%.2f", value)
  }
}
