import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoWorkKit
import SwiftUI
import UIKit

#if DEBUG
  import JunoPreviewSupport

  /// `--juno-preview-practice <state>`: the practice conversation's exercise
  /// in that state, or a block with its output open (``PreviewPracticeFixtures``).
  private struct JunoMobilePracticePreview: ViewModifier {
    func body(content: Content) -> some View {
      content
        .environment(\.junoLiveUIExerciseSeeds, PreviewPracticeFixtures.seeds(for: PreviewPracticeFixtures.state))
        .environment(\.junoCodeRunOpensBlocks, PreviewPracticeFixtures.openBlocks)
    }
  }
#endif

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
  /// The authenticated transport, for the transcript's pictures. Nil in an
  /// unconfigured shell, where image rows show their placeholder.
  var requestSender: (any NativeAuthenticatedRequestSending)?
  /// A question handed in from outside — Siri's "Ask Juno" — to drop into the
  /// draft composer. Cleared once taken.
  var pendingPrompt: Binding<String?> = .constant(nil)
  /// One-shot request from the Dictate App Intent / widget shortcut.
  var startDictation: Binding<Bool> = .constant(false)
  /// One-shot request from the drawer's Research row: arm deep research on
  /// the fresh draft. Cleared once taken.
  var startResearch: Binding<Bool> = .constant(false)
  /// The account's agents, to recognise an agent's own thread and put its
  /// face at the top of it. Nil where agents have not been built.
  var agentsModel: NativeAgentsModel?
  /// Opens an agent's page by id: the thread header's way back to it.
  var openAgent: ((String) -> Void)?

  /// Fetches and caches the transcript's pictures for the life of the screen.
  @State private var imageLoader: NativeChatImageLoader?

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

  /// The agent whose thread is open, if it is one. The thread is an ordinary
  /// conversation; what makes it the agent's is the agent pointing at it.
  private var threadAgent: NativeAgent? {
    guard let id = model.selectedConversationID, let agentsModel else { return nil }
    return agentsModel.agents.first { $0.conversationID == id }
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
          accountID: accountID,
          imageLoader: imageLoader,
          pendingPrompt: pendingPrompt,
          threadAgent: threadAgent,
          agentsModel: agentsModel,
          openAgent: openAgent
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
          sendSwell: sendSwell,
          pendingPrompt: pendingPrompt,
          startDictation: startDictation
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
    .onChange(of: startResearch.wrappedValue, initial: true) { _, requested in
      guard requested else { return }
      startResearch.wrappedValue = false
      // A beat later: leaving a conversation for the draft resets the tools
      // in the same update, and that reset must not undo this.
      Task { tools.deepResearch = true }
    }
    .onChange(of: model.latestCompletedAgentConfigMessageID, initial: false) { oldID, newID in
      guard let newID, newID != oldID, let agentsModel else { return }
      let activeAgentID = threadAgent?.id
      Task {
        await agentsModel.refresh()
        if let activeAgentID {
          await agentsModel.loadDetail(id: activeAgentID)
        }
      }
    }
    .task(id: "\(accountID?.rawValue ?? ""):\(model.selectedConversationID ?? "")") {
      await model.refreshChatApprovals(
        conversationID: model.selectedConversationID,
        includeRecent: true
      )
    }
    .task(id: accountID?.rawValue) {
      readAloud = JunoMobileReadAloud(client: messageActions, accountID: accountID)
      imageLoader = NativeChatImageLoader(sender: requestSender, accountID: accountID)
    }
    .onDisappear { readAloud?.stop() }
    // Run on a code block or an exercise answer: the web's console document,
    // run on the phone (``JunoCodeRunOutput``).
    .environment(\.junoCodeRunner, codeRunner)
    #if DEBUG
      .modifier(JunoMobilePracticePreview())
    #endif
  }

  private var codeRunner: JunoCodeRunner? {
    guard let requestSender, let accountID else { return nil }
    return NativeCodeConsoleClient(sender: requestSender).runner(for: accountID)
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
  var pendingPrompt: Binding<String?> = .constant(nil)
  /// A Dictate shortcut always begins from a blank draft, where the resulting
  /// transcript is unambiguously the message being composed.
  var startDictation: Binding<Bool> = .constant(false)

  @State private var prompt = ""
  @State private var selectedModelID = ""
  @State private var reasoningEffort: NativeReasoningEffort?
  @State private var thinkingNotice: String?
  @State private var attachments = JunoMobileAttachmentCoordinator()

  @State private var showingLibrary = false
  /// The call in progress. It reaches the home screen because that is where
  /// most calls are started: nothing is selected, so the spoken turns have no
  /// conversation to appear in until the save route makes one on hang-up.
  @Environment(\.junoVoiceSession) private var voiceSession
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.horizontalSizeClass) private var sizeClass
  @FocusState private var composerFocused: Bool

  /// The iPad's home: one centred block (greeting and composer) at a
  /// reading measure, where the phone docks the composer to the
  /// bottom edge for the thumb. A composer pinned to the foot of a 13-inch
  /// screen, under a greeting a foot away from it, is two things; centred
  /// together they are the one object the screen is about.
  private var centered: Bool { sizeClass == .regular && voiceMessages.isEmpty }

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
    if centered {
      VStack(spacing: 0) {
        Spacer(minLength: JunoSpace.region)
        VStack(spacing: JunoSpace.section) {
          JunoMobileHomeLine()
          composer
        }
        .frame(maxWidth: JunoMobileMeasure.home)
        // Two spacers under, one over: the block sits a little above the
        // middle, where the eye lands, and rides up with the keyboard.
        Spacer(minLength: JunoSpace.region)
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity)
      .padding(.horizontal, JunoSpace.region)
    } else if voiceMessages.isEmpty {
      // The home: the greeting low in the column, near the composer (the
      // hero) and the thumb, and nothing else. No starting-point cards: the
      // `+`, the voice action and the model are already one tap away in the
      // composer, and a row of cards under it was a second, weaker menu.
      //
      // ChatGPT's home is an empty page, and so is this one: no logo, no
      // greeting, no cards. The one thing above the composer is a quiet way
      // back into the last conversation, which is the likeliest next move.
      VStack(alignment: .leading, spacing: 0) {
        Spacer(minLength: 0)
        if let resume = resumeConversation {
          JunoMobileResumeRow(
            title: resume.title,
            icon: resume.projectId != nil ? .projects : (resume.kind == "code" ? .code : .conversation)
          ) {
            model.isDraftingNewConversation = false
            model.selectedConversationID = resume.id
          }
          .padding(.horizontal, JunoSpace.regular)
          .transition(.opacity)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.bottom, JunoSpace.tight)
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

  /// The conversation the home offers to pick back up: the most recent one
  /// with a real title.
  private var resumeConversation: NativeConversation? {
    model.conversations
      .filter { $0.archivedAt == nil && !$0.isPending && !$0.title.isEmpty }
      .max { $0.lastMessageAt < $1.lastMessageAt }
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
      .accessibilityIdentifier("juno.mobile.chat-draft")
      // No visible title: the greeting names this screen. The title stays
      // for VoiceOver and the back menu.
      .navigationTitle("navigation.chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        // The phone's bar carries the private-chat toggle itself (see the
        // shell); the iPad's detail column keeps it here.
        if sizeClass == .regular {
          // No title on the iPad's home either: the greeting names it.
          ToolbarItem(placement: .principal) { Text(verbatim: "") }
        }
        if let startIncognito, sizeClass == .regular {
          ToolbarItem(placement: .topBarTrailing) {
            Button(action: startIncognito) {
              // The phone's private-chat glyph: the dashed circle, no label.
              JunoMobileTemporaryChatGlyph(active: false)
                .foregroundStyle(Color.primary)
            }
            .accessibilityLabel("Start an incognito chat")
            .accessibilityIdentifier("juno.mobile.incognito-start")
          }
        }
      }
      .modifier(JunoMobileDockedComposer(docked: !centered) { composer })
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
      // "Ask Juno …" from Siri lands as the draft's text, ready to send.
      .onChange(of: pendingPrompt.wrappedValue, initial: true) { _, text in
        guard let text, !text.isEmpty else { return }
        prompt = text
        pendingPrompt.wrappedValue = nil
        composerFocused = true
      }
  }

  /// The one composer, placed by ``column`` on an iPad and docked on a phone.
  private var composer: some View {
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
      composerFocused: $composerFocused,
      sendSwell: sendSwell,
      // The greeting holds the bloom whenever it is on screen, so
      // the composer must not draw a second one.
      greetingVisible: voiceMessages.isEmpty,
      startDictation: startDictation
    )
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
  var imageLoader: NativeChatImageLoader?
  var pendingPrompt: Binding<String?> = .constant(nil)
  /// The agent this thread belongs to, drawn as the row above it.
  var threadAgent: NativeAgent? = nil
  /// The agents model, so the thread's presence bar can open the agent's
  /// profile, its computer and its menu in place.
  var agentsModel: NativeAgentsModel? = nil
  var openAgent: ((String) -> Void)? = nil
  /// The artifact the reader tapped in the transcript, presented over it.
  @State private var openArtifact: NativeArtifact?
  /// A message's text on its way to the system share sheet.
  @State private var sharingMessage: JunoMobileSharedText?
  @State private var copyHaptic = JunoMobileHapticTrigger()
  /// An artifact the transcript can render from the reply's own tag, used when
  /// the stored row has not arrived. See ``openArtifact(_:)``.
  @State private var inlineArtifact: JunoMobileInlineArtifact?
  @State private var showingLibrary = false
  /// The link just created, presented to the system share sheet. Held rather
  /// than shared inline because the link does not exist until the server makes
  /// it — a `ShareLink` needs its URL up front, and there is none to give.
  @State private var createdShare: NativeShare?
  /// The research report open in the reader sheet.
  @State private var reportRoute: JunoMobileReportRoute?
  /// Sources' logos for the research views, fetched once per site.
  @State private var sourceFavicons = NativeSourceFavicons()
  @State private var sharing = false
  @State private var shareError: String?

  /// Sends an exercise's answer as the next turn, on the conversation's model.
  private func sendLiveUIAnswer(_ text: String) {
    _ = model.sendMessage(
      conversationID: conversation.id,
      prompt: text,
      modelID: selectedModelID.isEmpty ? conversation.model : selectedModelID,
      reasoningEffort: reasoningEffort
    )
  }

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
  /// New content keeps the transcript at its end: true until the reader drags
  /// away from the bottom, and again when they come back, jump or send.
  @State private var follows = true
  /// The bar's width, which is this screen's: the title's room is measured
  /// from it rather than capped at a number (`JunoLayout.Bar.titleWidth`).
  @State private var barWidth: CGFloat = 0
  /// The reader's finger is on the transcript, so a change of position is
  /// theirs rather than the stream's.
  @State private var userScrolling = false
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
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
  /// Find in this conversation, from the "…" menu (JunoMobileFind.swift).
  @State private var find = JunoFindModel()

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

  /// Puts a message's words into the composer as a quote, the way a reply
  /// on a phone quotes what it answers.
  private func quote(_ text: String) {
    let quoted = text
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map { "> " + $0 }
      .joined(separator: "\n")
    prompt = prompt.isEmpty ? quoted + "\n\n" : prompt + "\n\n" + quoted + "\n\n"
    composerFocused = true
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

  /// The reader's words a reply answers: the nearest question above it — a
  /// research turn's title.
  private func question(answeredBy message: NativeChatMessage) -> String? {
    guard let index = messages.firstIndex(where: { $0.id == message.id }) else { return nil }
    return messages[..<index].last { $0.role == .user }
      .map { NativeMessageContent.plainText(of: $0.content) }
  }

  /// This conversation's background research runs that draw something: live
  /// ones, gates, and the report of one whose report lives only on the run.
  private var researchRuns: [NativeResearchRun] {
    model.researchRuns(for: conversation.id).filter { $0.presentation != .none }
  }

  /// Where each run goes: under the question it answers; else after the
  /// last turn created at or before it; else at the foot.
  private var researchPlacement: (byMessage: [String: [NativeResearchRun]], atFoot: [NativeResearchRun]) {
    var byMessage: [String: [NativeResearchRun]] = [:]
    var atFoot: [NativeResearchRun] = []
    for run in researchRuns {
      if let question = run.userMessageID, messages.contains(where: { $0.id == question }) {
        let anchor = messages.drop { $0.id != question }.dropFirst().first { $0.role == .assistant }?.id ?? question
        byMessage[anchor, default: []].append(run)
      } else if let created = run.createdAt, let anchor = messages.last(where: { $0.createdAt <= created }) {
        byMessage[anchor.id, default: []].append(run)
      } else {
        atFoot.append(run)
      }
    }
    return (byMessage, atFoot)
  }

  /// The runs still to follow, as a key: a hand-off changes it, which
  /// restarts the follower.
  private var openResearchKey: String {
    model.researchRuns(for: conversation.id).filter { !$0.phase.isTerminal }.map(\.id).joined(separator: ",")
  }

  /// Opens the report a tapped notification named, when it belongs to this
  /// chat: from its completion message (sources and citation check) when
  /// this phone has it, else from the run's own report.
  private func openPendingReport() async {
    let requests = JunoMobileLaunchRequests.shared
    guard let runID = requests.pendingReportRunID,
      let run = await model.loadResearchRun(id: runID),
      run.conversationID == conversation.id
    else { return }
    requests.pendingReportRunID = nil
    if let messageID = run.assistantMessageID,
      let message = model.messagesByConversation[conversation.id]?.first(where: { $0.id == messageID }),
      let report = NativeResearchReport(message: message, question: run.goal)
    {
      reportRoute = JunoMobileReportRoute(report: report)
    } else if let report = NativeResearchReport(run: run) {
      reportRoute = JunoMobileReportRoute(report: report)
    }
  }

  private func researchBlock(_ run: NativeResearchRun) -> some View {
    JunoMobileResearchRunBlock(
      run: run,
      model: model,
      conversationID: conversation.id,
      openReport: { report in reportRoute = JunoMobileReportRoute(report: report) }
    )
    .transition(.opacity)
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
      Color.clear
        .frame(maxWidth: .infinity)
        .containerRelativeFrame(.vertical)
    } else {
      // The web's own transcript metrics: `max-w-3xl space-y-6 px-4 py-6`.
      // The width clamp is not decoration — it is what keeps a line of
      // running text at a readable measure on an iPad, where a full-bleed
      // answer runs to ~90 characters.
      // A plain `VStack`, not a lazy one. Measured on the iOS 26/27
      // simulator: with `LazyVStack` under a bottom-anchored
      // `ScrollPosition`, sending a turn in a long conversation left the
      // whole visible transcript blank for the length of the reply — the
      // stack kept a stale layout (content height frozen while the answer
      // grew) and drew no rows in the viewport. An eager stack lays every
      // row out and follows the stream correctly.
      VStack(spacing: JunoSpace.section) {
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
            isGenerating: model.isGenerating,
            imageLoader: imageLoader,
            quote: { text in quote(text) },
            share: { text in sharingMessage = JunoMobileSharedText(text: text) },
            onCopy: { copyHaptic.fire() },
            researchQuestion: message.role == .assistant ? question(answeredBy: message) : nil,
            openReport: { report in reportRoute = JunoMobileReportRoute(report: report) },
            stopResearch: message.id == streamingMessageID ? { model.stopGeneration() } : nil
          )
          // `rise-in`, as the web gives every new turn. Scoped to the
          // stack's `.animation(_:value: messages.count)` below, which
          // is also what limits it to genuinely new messages: SwiftUI
          // does not run an insertion transition for rows that were
          // already there on the first layout, so a loaded history
          // arrives settled rather than cascading up the screen.
          .transition(.opacity.combined(with: .offset(y: JunoSpace.snug)))
          .environment(\.junoFindHighlight, find.highlight(for: message.id))
          .id(message.id)

          // The conversation's research runs that are not answers in it
          // (started on the web, or handed off), under the turn they
          // follow.
          ForEach(researchPlacement.byMessage[message.id] ?? []) { run in
            researchBlock(run)
          }
        }

        ForEach(researchPlacement.atFoot) { run in
          researchBlock(run)
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
      // A Live UI view's prompt button puts its prompt in the composer, as a
      // follow-up chip does (docs/design/LIVE_UI.md).
      // An exercise's Send answer sends straight away, as on the web: the
      // answer is the reader's next turn, corrected in the conversation.
      .environment(
        \.junoLiveUIHost,
        JunoLiveUIHost(onPrompt: { prompt = $0 }, onSend: { sendLiveUIAnswer($0) })
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
    // The title is the menu: the conversation's own verbs live under its name,
    // the way Notes and Photos put a document's actions under its title, so
    // the bar keeps exactly three things — sidebar, title, new chat.
    ToolbarItem(placement: .principal) {
      Menu {
        conversationMenuItems
      } label: {
        JunoMobileConversationTitle(
          title: conversation.title,
          maxWidth: barWidth > 0
            ? JunoLayout.Bar.titleWidth(barWidth: barWidth, leading: 1, trailing: newChat == nil ? 0 : 1)
            : nil,
          justRenamed: model.recentlyRenamedConversationID == conversation.id,
          onAnimationShown: { model.acknowledgeTitleAnimation(for: conversation.id) }
        )
      }
      .menuIndicator(.hidden)
      .tint(Color.primary)
      .disabled(model.isMutating || conversation.isPending)
      .accessibilityLabel("Conversation actions")
      .accessibilityIdentifier("juno.mobile.conversation-menu")
    }
    if let newChat {
      ToolbarItem(placement: .topBarTrailing) {
        Button(action: newChat) {
          JunoSymbol(.compose)
        }
        .tint(Color.primary)
        .disabled(messages.isEmpty)
        .accessibilityLabel("New chat")
        .accessibilityIdentifier("juno.mobile.chat-new")
      }
    }
  }

  @ViewBuilder
  private var conversationMenuItems: some View {
    if shareClient != nil {
      Button {
        Task { await createShare() }
      } label: {
        Label("Share", image: JunoIcon.share.assetName(.regular))
      }
      .contentShape(.rect)
      .disabled(sharing)
    }
    Button {
      find.open()
    } label: {
      Label("Find in Conversation", image: JunoIcon.search.assetName(.regular))
    }
    .contentShape(.rect)
    .accessibilityIdentifier("juno.mobile.conversation-find")
    Button {
      editValue = conversation.title
      showingRename = true
    } label: {
      Label("Rename", image: JunoIcon.pencil.assetName(.regular))
    }
    .contentShape(.rect)
    Button {
      Task {
        await model.setPinned(id: conversation.id, pinned: !conversation.pinned)
      }
    } label: {
      Label(conversation.pinned ? "Unpin" : "Pin", image: (conversation.pinned ? JunoIcon.pinOff : JunoIcon.pin).assetName(.regular))
    }
    .contentShape(.rect)
    Divider()
    // Delete, not archive. Archiving moved a conversation into a folder this
    // app has no screen for, which from the phone is indistinguishable from
    // losing it.
    Button(role: .destructive) {
      showingDelete = true
    } label: {
      Label("Delete", image: JunoIcon.trash.assetName(.regular))
    }
    .contentShape(.rect)
  }

  /// Returns the reader to the newest turn.
  ///
  /// `isNearBottom` is set here rather than left to the geometry callback: the
  /// control has done its job the moment it is pressed, and a jump-to-latest
  /// that lingers while the scroll animates reads as a button that failed. The
  /// callback still owns the value — it will put it back to `false` if the
  /// scroll did not in fact reach the bottom.
  private func jumpToLatest() {
    follows = true
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
      // The transcript opens at its end and stays aligned there; growth is
      // followed explicitly below, and only while the reader is following.
      // (A blanket `.defaultScrollAnchor(.bottom)` also anchors size changes,
      // which kept pulling the page under a reader who had scrolled up to
      // read — the stream must stop following the moment they leave.) The
      // position binding is how every follow and jump is expressed.
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .defaultScrollAnchor(.bottom, for: .alignment)
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
        if userScrolling { follows = nearBottom }
      }
      // The paced reply growing a line, a block arriving, a tool result
      // landing: followed smoothly, but only while following and never under
      // the reader's finger.
      .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { old, new in
        guard follows, !userScrolling, new > old else { return }
        withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) {
          scrollPosition.scrollTo(edge: .bottom)
        }
      }
      .onScrollPhaseChange { _, phase in
        switch phase {
        case .tracking, .interacting, .decelerating:
          userScrolling = true
        case .idle, .animating:
          if userScrolling { follows = isNearBottom }
          userScrolling = false
        @unknown default:
          userScrolling = false
        }
      }
      .onChange(of: messages.count) { previous, current in
        // A turn arriving is the reader's own send or its reply: back to the
        // end, and following again.
        guard current > previous else { return }
        follows = true
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
          scrollPosition.scrollTo(edge: .bottom)
        }
      }
      .onChange(of: streamSignature) { _, _ in
        guard follows, !userScrolling else { return }
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
          scrollPosition.scrollTo(edge: .bottom)
        }
      }
      .overlay(alignment: .bottomTrailing) {
        if !isNearBottom && !follows && !messages.isEmpty {
          Button {
            jumpToLatest()
          } label: {
            JunoIconView(.arrowDown, size: 16)
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
    // On a regular-width screen what the reader opens from the thread — an
    // artifact, a research report — stands in the system's trailing
    // inspector beside it, the website's right-side panel: resizable, the
    // thread keeping its place. On the phone the same content is a sheet.
    thread
      .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barWidth = $0 }
      .inspector(isPresented: inspectorShown) {
        inspectorContent
          .inspectorColumnWidth(min: 360, ideal: 460, max: 640)
      }
      // Outside the inspector, so the iPad's bar carries the title and New
      // chat over the thread column: declared inside it, iPadOS drew the
      // detail's bar empty (spacing pass).
      .toolbar { conversationToolbar }
  }

  @ViewBuilder
  private var inspectorContent: some View {
    if let artifact = dockedArtifact {
      JunoMobileArtifactDetail(
        model: artifactModel!,
        artifact: artifact,
        // Already in the conversation this came from; the only
        // sensible "go there" is to close.
        openConversation: { _ in closeArtifact() },
        close: closeArtifact
      )
    } else if let route = dockedReport {
      JunoMobileResearchReportView(
        report: route.report,
        loadAudit: { messageID in await model.researchAudit(messageID: messageID) },
        close: { reportRoute = nil },
        docked: true
      )
      .environment(\.nativeSourceFavicons, sourceFavicons)
      .tint(Color.junoAccent)
    }
  }

  private var inspectorShown: Binding<Bool> {
    Binding(
      get: { dockedArtifact != nil || dockedReport != nil },
      set: { shown in
        guard !shown else { return }
        openArtifact = nil
        reportRoute = nil
      }
    )
  }

  /// The report, when this screen is wide enough to read it beside the thread.
  private var dockedReport: JunoMobileReportRoute? {
    sizeClass == .regular ? reportRoute : nil
  }

  /// The report as a sheet — the phone's presentation.
  private var sheetedReport: Binding<JunoMobileReportRoute?> {
    Binding(
      get: { sizeClass == .regular ? nil : reportRoute },
      set: { reportRoute = $0 }
    )
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
      .modifier(JunoMobileSoftScrollEdges())
      .junoHaptic(JunoMobileHaptic.copy, trigger: copyHaptic)
      .sheet(item: $sharingMessage) { shared in
        JunoMobileShareSheet(items: [shared.text])
      }
      .onChange(of: pendingPrompt.wrappedValue, initial: true) { _, text in
        guard let text, !text.isEmpty else { return }
        prompt = text
        pendingPrompt.wrappedValue = nil
        composerFocused = true
      }
      .navigationBarTitleDisplayMode(.inline)
      .junoTranscriptFind(
        find, messages: messages, signature: streamSignature,
        follows: $follows, scrollPosition: $scrollPosition
      )
      // An agent's thread gains one row above the transcript: its face, what
      // it is doing, and the way to its page (docs/design/AGENTS.md §5.3).
      // Always applied, empty for an ordinary chat, so a roster that loads
      // after the thread opened does not remount the transcript under it.
      .safeAreaInset(edge: .top, spacing: 0) { agentHeader }
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
      .junoComposerBar {
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
      #if DEBUG
        // `--juno-preview-open-artifact` opens the thread's first artifact,
        // as a tap on its card would.
        .task {
          guard CommandLine.arguments.contains("--juno-preview-open-artifact") else { return }
          for _ in 0..<40 {
            try? await Task.sleep(for: .milliseconds(150))
            if messages.contains(where: { $0.content.contains("<juno:artifact") }),
              artifactModel?.artifacts.isEmpty == false
            { break }
          }
          let references = messages.flatMap { message in
            NativeMessageContent.parts(of: message.content).compactMap { part -> NativeMessageContent.ArtifactReference? in
              if case .artifact(let reference) = part { return reference }
              return nil
            }
          }
          // A stored artifact first (it docks); the tag's own body otherwise.
          if let reference = references.first(where: { storedArtifact(for: $0) != nil }) ?? references.first {
            openArtifact(reference)
          }
        }
      #endif
      // The research report, read in a sheet of its own.
      .sheet(item: sheetedReport) { route in
        JunoMobileResearchReportView(
          report: route.report,
          loadAudit: { messageID in await model.researchAudit(messageID: messageID) },
          close: { reportRoute = nil }
        )
        .environment(\.nativeSourceFavicons, sourceFavicons)
        .junoSheetSurface(.page)
        .tint(Color.junoAccent)
      }
      .environment(\.nativeSourceFavicons, sourceFavicons)
      // The conversation's research runs, followed while it is open — and
      // again whenever a hand-off adds one — so a run started on the web, or
      // still working after a relaunch, shows here as it does on the Mac.
      .task(id: "\(conversation.id):\(openResearchKey)") {
        await model.followResearch(conversationID: conversation.id)
      }
      // "Your research is ready" was tapped: its report, once its chat is
      // the one on screen.
      .task(id: "\(conversation.id):\(JunoMobileLaunchRequests.shared.pendingReportRunID ?? "")") {
        await openPendingReport()
      }
  }

  @ViewBuilder
  private var agentHeader: some View {
    if let threadAgent, let openAgent {
      NativeAgentThreadHeader(
        agent: threadAgent,
        state: threadAgentState,
        model: agentsModel,
        openThread: { model.selectedConversationID = $0 },
        focusComposer: { composerFocused = true },
        retired: { model.selectedConversationID = nil },
        openAgent: { openAgent(threadAgent.id) }
      )
      .padding(.horizontal, JunoSpace.regular)
    }
  }

  /// What the face shows while this thread knows better than the roster:
  /// listening through a call, thinking while a reply streams. Nil is the
  /// agent's own state.
  private var threadAgentState: JunoAgentState? {
    if voiceSession != nil { return .listening }
    if streamingMessageID != nil { return .thinking }
    return nil
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
  /// The room the bar leaves between its circles; nil until measured.
  var maxWidth: CGFloat?
  let justRenamed: Bool
  let onAnimationShown: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var highlighted = false

  var body: some View {
    HStack(spacing: JunoSpace.hairline) {
      Text(title)
        .font(.headline)
        .lineLimit(1)
        .truncationMode(.tail)
      JunoSymbol(.chevronDown)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.secondary)
        .fixedSize()
        .accessibilityHidden(true)
    }
      .foregroundStyle(highlighted ? Color.junoAccent : Color.primary)
      .frame(maxWidth: maxWidth ?? JunoLayout.Bar.titleWidth(barWidth: 320))
      .frame(minHeight: JunoLayout.Bar.button)
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
  /// Fetches the message's pictures. Nil renders their placeholders.
  var imageLoader: NativeChatImageLoader?
  /// Puts this message's words into the composer as a quote.
  var quote: ((String) -> Void)?
  /// Hands this message's text to the share sheet.
  var share: ((String) -> Void)?
  /// The screen's copy haptic, fired here because the row cannot host it.
  var onCopy: (() -> Void)?
  /// The question this reply answers, in the reader's words: a research
  /// turn's title.
  var researchQuestion: String? = nil
  /// Opens a research report in the reader sheet.
  var openReport: ((NativeResearchReport) -> Void)? = nil
  /// Stops the research turn while it works (the composer's Stop, here too).
  var stopResearch: (() -> Void)? = nil

  @State private var copied = false
  @State private var showingSelectText = false
  /// Find in conversation's share of this row (JunoMobileFind.swift).
  @Environment(\.junoFindHighlight) private var findHighlight
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
        if !message.imageAttachments.isEmpty, let imageLoader {
          JunoMobileMessageImages(
            attachments: message.imageAttachments,
            loader: imageLoader,
            alignment: .trailing,
            maxWidth: rowWidth > 0 ? min(288, rowWidth * 0.85) : 288
          )
          .junoMessageContextMenu(menuActions)
        }
        if editing {
          promptEditor
        } else if !plainText.isEmpty || message.imageAttachments.isEmpty {
          bubbleBody
          if isLongPrompt { expandControl }
        }
        promptControls
      }
      // A real cap, not a fixed width: the bubble hugs short messages
      // and wraps long ones at 85% of the transcript, as the web's
      // `max-w-[85%]` on a shrink-to-fit flex item does.
      .frame(maxWidth: rowWidth > 0 ? rowWidth * 0.8 : nil, alignment: .trailing)
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
    if !voice, branchPosition != nil {
      HStack(spacing: JunoSpace.micro) {
        // Tucked up under the bubble: it belongs to the words above it, and
        // at the full 44pt row height it floated halfway to the next turn.
        branchNavigator
        // Edit lives in the bubble's long-press menu, as ChatGPT keeps it:
        // a pencil under every question was chrome on every turn.
      }
      .padding(.top, -JunoSpace.snug)
      .padding(.bottom, -JunoSpace.snug)
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
    Text(JunoFindText.highlighted(plainText, with: findHighlight))
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
      // A flat, warm fill and nothing else. The hairline and the black drop
      // shadow made the reader's words look like a text field waiting for
      // input; a remark needs a tone, not a border.
      .background(Color.junoMuted, in: Self.bubbleShape)
      .contentShape(Self.bubbleShape)
      .junoMessageContextMenu(menuActions)
      .sheet(isPresented: $showingSelectText) {
        JunoMobileSelectTextSheet(title: isUser ? "Your message" : "Alevr's reply", text: plainText)
      }
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
        JunoIconView(expanded ? .chevronUp : .chevronDown, size: 11)
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
  /// One radius all round, 18pt — ChatGPT's bubble. The cut "tail" corner
  /// pointed at a speaker the layout already places.
  private static let bubbleShape = RoundedRectangle(
    cornerRadius: JunoRadius.message, style: .continuous
  )

  /// A research turn still working: the Deep Field view stands where the
  /// run trace would, through the planning, reading and writing.
  private var isLiveResearch: Bool {
    guard !voice, message.isPending, message.mediaProgress == nil else { return false }
    if NativeResearchRun.isInChatResearch(activity: message.activity) { return true }
    return message.researchRequested && message.content.isEmpty
      && !message.activity.contains { $0.seq != nil || $0.notice?.code == "research_skipped" }
  }

  /// The door into the research report this answer carries, in place of
  /// the generic artifact card.
  @ViewBuilder
  private func researchReportCard(_ artifact: NativeMessageContent.ArtifactReference) -> some View {
    if artifact.streaming {
      NativeResearchReportCard(
        content: .writing(
          title: artifact.title,
          words: artifact.content.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count,
          section: NativeResearchReport.sections(of: artifact.content).last(where: { $0.level > 0 })?.title
        ),
        open: nil
      )
      .padding(.vertical, JunoSpace.snug)
    } else if let report = NativeResearchReport(message: message, question: researchQuestion) {
      NativeResearchReportCard(
        content: .report(report),
        open: openReport.map { open in { open(report) } } ?? openArtifact.map { open in { open(artifact) } }
      )
      .padding(.vertical, JunoSpace.snug)
    } else {
      JunoMobileArtifactInlineCard(artifact: artifact, open: openArtifact.map { open in { open(artifact) } })
    }
  }

  private var assistantAnswer: some View {
    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
      if isLiveResearch {
        NativeResearchLiveView(
          run: NativeResearchRun.inChat(message: message, live: true, question: researchQuestion),
          citations: message.sources,
          citingText: message.content,
          actions: NativeResearchLiveActions(stop: stopResearch),
          compact: true
        )
        .padding(.bottom, JunoSpace.snug)
      }
      // The run trace leads the answer, as it does on the web: what Juno is
      // doing belongs above the thing it produced, not in a footnote under
      // it. Never on a spoken line — see ``voice``.
      if !voice && !isLiveResearch {
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

      // The generated picture — the answer itself, for an image turn.
      if !message.imageAttachments.isEmpty, let imageLoader {
        JunoMobileMessageImages(
          attachments: message.imageAttachments,
          loader: imageLoader,
          alignment: .leading
        )
        .padding(.top, JunoSpace.hairline)
      }

      // While the answer has no words yet, say what is happening — the
      // web's shimmering status line — rather than leaving a blank row.
      if message.isPending, message.content.isEmpty, message.mediaProgress == nil,
        (message.reasoning ?? "").isEmpty, !voice, !isLiveResearch
      {
        JunoShimmerText("Thinking…")
          .padding(.vertical, JunoSpace.tight)
      }

      // The words are paced: released at a steady cadence with the newest
      // fading in (JunoPacedStream), so a burst from the network never lands
      // as a block of text.
      JunoPacedStream(displayContent, live: message.isPending) { paced in
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
          let findBases = findHighlight.map { JunoMobileTranscriptFind.bases(of: $0.query, in: paced).bases } ?? []
          ForEach(Array(NativeMessageContent.parts(of: paced).enumerated()), id: \.offset) { index, part in
            switch part {
            case .text(let text):
              // While tokens arrive the newest words fade in where the
              // writing is (JunoStreamReveal) — the answer body's live
              // signal once the thought-process row above has settled.
              JunoLessonText(text, streaming: message.isPending)
                .environment(
                  \.junoFindHighlight,
                  findHighlight?.shifted(by: findBases.indices.contains(index) ? findBases[index] : 0)
                )
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .environment(\.junoLiveUIHost.messageID, message.id)
            case .artifact(let artifact) where NativeResearchReport.isReport(artifact):
              researchReportCard(artifact)
                .junoStreamBlockReveal()
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
              .junoStreamBlockReveal()
            }
          }
        }
      }

      if !message.sources.isEmpty {
        sources
          .padding(.top, JunoSpace.hairline)
      }

      if let error = message.errorDescription {
        HStack(spacing: JunoSpace.tight) {
          JunoIconView(.error, size: 14)
          Text(error)
            .font(.caption)
        }
        .foregroundStyle(Color.junoCaution)
      }

      // Fades in a beat after the answer settles — the row arriving is how
      // the reader learns the reply is finished.
      if !message.isPending && !voice {
        actionRow
          .transition(.opacity.animation(
            JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint)?.delay(0.18)
          ))
      }

      // Under the answer, where the web puts it. An answer has siblings
      // when the question above it was re-asked, so this is the same
      // pager the prompt carries, reading the same numbers.
      if !voice { branchNavigator }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .junoMessageContextMenu(menuActions)
    .sheet(isPresented: $showingSelectText) {
      JunoMobileSelectTextSheet(title: "Alevr's reply", text: plainText)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Alevr replied")
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

  /// The model only. The per-message price used to sit beside it, and a
  /// transcript that quotes a dollar figure under every answer reads as a
  /// meter rather than a conversation; the spend lives in Settings › Usage,
  /// where it is a total with a shape, not a tax on each reply.
  private var footerLine: String? {
    message.model.flatMap { $0.isEmpty ? nil : junoDisplayModelName($0) }
  }

  private var footerAccessibilityLabel: String? {
    footerLine.map { "Answered by \($0)" }
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
  /// ChatGPT's row under a finished answer: copy, thumbs up, thumbs down,
  /// read aloud, share, try again — bare SF Symbols in secondary ink with
  /// 44pt targets — and an overflow for the rest (which model answered,
  /// continue, branch).
  @ViewBuilder
  private var actionRow: some View {
    if hasAnyAction {
      HStack(spacing: 0) {
        if !plainText.isEmpty {
          Button {
            copy()
          } label: {
            JunoIconView(copied ? JunoIcon.check : JunoIcon.copy, size: 16)
              .foregroundStyle(Color.junoSecondaryInk)
              .frame(width: JunoLayout.touchTarget, height: JunoLayout.touchTarget)
              .contentShape(Rectangle())
          }
          .buttonStyle(.junoQuietPress)
          .accessibilityLabel(copied ? "message.copied" : "message.copy")
          .accessibilityIdentifier("juno.mobile.message-copy")
        }

        if let setFeedback {
          symbolButton(
            .thumbsUp, on: message.feedback == .up,
            label: "message.good",
            identifier: "juno.mobile.message-thumbs-up"
          ) { setFeedback(message.id, message.feedback == .up ? nil : .up) }

          symbolButton(
            .thumbsDown, on: message.feedback == .down,
            label: "message.bad",
            identifier: "juno.mobile.message-thumbs-down"
          ) { setFeedback(message.id, message.feedback == .down ? nil : .down) }
        }

        if let readAloud, !plainText.isEmpty {
          let speaking = readAloud.isSpeaking(message.id)
          symbolButton(
            speaking ? .circleStop : .volume,
            label: speaking ? "message.stop-reading" : "message.read-aloud",
            identifier: "juno.mobile.message-read-aloud"
          ) {
            readAloud.toggle(messageID: message.id, text: spokenText, voiceID: voiceID)
          }
        }

        if let share, !plainText.isEmpty {
          symbolButton(.share, label: "Share", identifier: "juno.mobile.message-share") {
            share(plainText)
          }
        }

        if let regenerate {
          symbolButton(
            .refresh,
            label: "message.regenerate",
            identifier: "juno.mobile.message-regenerate",
            action: regenerate
          )
        }

        overflowMenu

        Spacer(minLength: 0)
      }
      // Each key is a full 44pt target; pulled in by half the air around its
      // glyph so the first glyph sits on the text's own edge.
      .padding(.leading, -(JunoLayout.touchTarget - JunoLayout.Transcript.actionGlyph) / 2)
      .accessibilityElement(children: .contain)
    }
  }

  /// What does not earn a place in the row: who answered, and the rarer verbs.
  @ViewBuilder
  private var overflowMenu: some View {
    let canContinue = continueResponse != nil
      && (message.finishReason == .length || message.finishReason == .networkError)
    if footerLine != nil || canContinue || branch != nil {
      Menu {
        if let footerLine {
          Section(footerAccessibilityLabel ?? footerLine) {}
        }
        if canContinue, let continueResponse {
          Button(action: continueResponse) {
            Label("message.continue", image: JunoIcon.arrowDown.assetName(.regular))
          }
        }
        if let branch {
          Button { branch(message.id) } label: {
            Label("message.branch", image: JunoIcon.branch.assetName(.regular))
          }
        }
        Button { showingSelectText = true } label: {
          Label("Select text", image: JunoIcon.textCursor.assetName(.regular))
        }
      } label: {
        JunoIconView(.ellipsis, size: JunoLayout.Transcript.actionGlyph)
          .foregroundStyle(Color.junoSecondaryInk)
          .frame(width: JunoLayout.touchTarget, height: JunoLayout.touchTarget)
          .contentShape(Rectangle())
      }
      .tint(Color.primary)
      .accessibilityLabel("More actions")
      .accessibilityIdentifier("juno.mobile.message-more")
    }
  }

  private func symbolButton(
    _ icon: JunoIcon,
    on: Bool = false,
    label: LocalizedStringKey,
    identifier: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      // The web's message-action glyphs at its 16pt rung; the solid cut only
      // for an "on" state (a rated answer).
      JunoIconView(icon, size: JunoLayout.Transcript.actionGlyph, isOn: on)
        .foregroundStyle(Color.junoSecondaryInk)
        .frame(width: JunoLayout.touchTarget, height: JunoLayout.touchTarget)
        .contentShape(Rectangle())
    }
    .buttonStyle(.junoQuietPress)
    .accessibilityLabel(label)
    .accessibilityIdentifier(identifier)
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
    icon: JunoIcon,
    label: LocalizedStringKey,
    identifier: String,
    active: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      JunoIconView(icon, size: 15)
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
    onCopy?()
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

  /// What a long press offers this message. Copy takes what is on screen —
  /// copying `message.content` handed people a `<juno:memory>` tag and an
  /// artifact's entire source, text they never saw.
  private var menuActions: JunoMobileMessageMenuActions {
    JunoMobileMessageMenuActions(
      copy: { copy() },
      selectText: { showingSelectText = true },
      share: share.map { share in { share(plainText) } },
      quote: voice || plainText.isEmpty ? nil : quote.map { quote in { quote(plainText) } },
      readAloud: readAloud == nil || plainText.isEmpty || isUser
        ? nil
        : { readAloud?.toggle(messageID: message.id, text: spokenText, voiceID: voiceID) },
      isReadingAloud: readAloud?.isSpeaking(message.id) == true,
      regenerate: regenerate,
      edit: editMessage == nil || editing || isGenerating
        ? nil
        : {
          draft = plainText
          editing = true
        },
      branch: branch.map { branch in { branch(message.id) } }
    )
  }
}

/// A message's text on its way to the share sheet, wrapped so `.sheet(item:)`
/// can key on it.
struct JunoMobileSharedText: Identifiable {
  let id = UUID()
  let text: String
}

/// Soft scroll-edge effects under the navigation bar and over the composer on
/// iOS 26 — the platform's answer to content passing under floating chrome.
struct JunoMobileSoftScrollEdges: ViewModifier {
  func body(content: Content) -> some View {
    content
      .scrollEdgeEffectStyle(.soft, for: .top)
      .scrollEdgeEffectStyle(.soft, for: .bottom)
  }
}

extension View {
  /// The composer as a bottom inset.
  ///
  /// `safeAreaInset`, not `safeAreaBar`: the "+" panel grows up out of the
  /// composer, beyond the bar's own bounds, and a `safeAreaBar` hit-tests only
  /// inside those bounds, so every row of the open panel (Camera, Photos,
  /// Files, Deep research, Model…) passed its taps to the transcript behind
  /// and did nothing. The inset delivers them; the cost is the system's scroll
  /// edge blur under the bar, which the glass composer does not need.
  func junoComposerBar<Bar: View>(@ViewBuilder _ bar: @escaping () -> Bar) -> some View {
    safeAreaInset(edge: .bottom, spacing: 0, content: bar)
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

  private var glyph: JunoIcon {
    switch artifact.kind {
    case "REACT", "HTML": .code
    case "SVG": .artifacts
    case "MERMAID": .branch
    case "MARKDOWN", "DOCUMENT": .file
    case "SPREADSHEET": .grid
    case "PRESENTATION": .squareStack
    default: .code
    }
  }

  private var subtitle: String {
    if artifact.streaming { return "Writing…" }
    // A spreadsheet, document or deck says what is in it: "Deck · 8 slides".
    if let kind = NativeArtifactKind(rawValue: artifact.kind), kind.isSemantic {
      let label = NativeArtifactRuntimeInfo.resolve(kind: kind, language: nil).label
      let summary = SemanticArtifact.summary(kind: kind, content: artifact.content)
      return [label, summary].compactMap { $0 }.joined(separator: " · ")
    }
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
      JunoIconView(glyph, size: 17)
        .foregroundStyle(Color.junoMutedForeground)
        .frame(minWidth: 22)

      VStack(alignment: .leading, spacing: JunoSpace.micro) {
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
        JunoGalaxyMark(size: 16)
          .foregroundStyle(Color.junoMutedForeground)
      } else if open != nil {
        JunoIconView(.chevronRight, size: 13)
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


// MARK: - Home pieces

/// The one line above the composer on an empty home: the last conversation,
/// in secondary ink, to pick straight back up. ChatGPT's "continue" row.
struct JunoMobileResumeRow: View {
  let title: String
  /// The thread's own kind — a chat, a project's chat, a Code session —
  /// the way ChatGPT marks its continue row with the thread's icon.
  var icon: JunoIcon = .conversation
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: JunoSpace.snug) {
        JunoIconView(icon, size: 16)
          .foregroundStyle(.secondary)
          .frame(width: 20)
        Text(title)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      .padding(.horizontal, JunoSpace.tight)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.junoQuietPress)
    .accessibilityLabel("Continue \(title)")
    .accessibilityIdentifier("juno.mobile.home-resume")
  }
}

/// The iPad's centred home line: one sentence in the display face, regular,
/// no name and no mark. The phone's home has none at all.
struct JunoMobileHomeLine: View {
  var body: some View {
    Text("What can I help with?")
      .font(JunoMobileType.display(30, relativeTo: .title))
      .foregroundStyle(Color.junoForeground)
      .multilineTextAlignment(.center)
      .accessibilityAddTraits(.isHeader)
  }
}
