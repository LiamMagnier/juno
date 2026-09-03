import CoreSpotlight
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoVoiceKit
import JunoWorkKit
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

#if DEBUG
  import JunoPreviewSupport
#endif

struct JunoMobileRootView: View {
  let authModel: NativeAuthModel
  let syncModel: NativeSyncModel<SQLiteAccountRepository>?
  /// Passed through only so Settings › Diagnostics can report how much work
  /// is still queued. Nothing else on this screen reads it.
  var outbox: (any MutationOutboxRepository)?
  /// Owns the composer's pending uploads. Held here rather than in the chat
  /// screen so a queued attachment survives navigating away and back.
  var attachmentModel: NativeComposerAttachmentModel?
  /// Fetches the account photo, which lives behind an authenticated route no
  /// image view can reach on its own.
  var avatarModel: NativeAvatarModel?
  let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
  let projectModel: NativeProjectModel<SQLiteAccountRepository>?
  var projectWorkspaceModel: ProjectWorkspaceModel<SQLiteAccountRepository>?
  let artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
  let memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
  /// Runs ``MemoryExtractionEngine`` when a turn finishes, and holds what it
  /// proposed until Settings › Memory is opened and the reader answers.
  ///
  /// Optional and `var`-defaulted so the DEBUG preview harness — which composes
  /// this view with eleven of its thirty inputs — keeps compiling. A nil model
  /// means nothing is learned, which is a real and safe state.
  var memoryLearningModel: MemoryLearningModel<SQLiteAccountRepository>?
  let searchModel: NativeSearchModel<SQLiteAccountRepository>?
  /// The in-memory incognito session. Nil when the app could not be configured.
  var privateChatModel: NativePrivateChatModel?
  var generateClient: NativeChatAPIClient?
  /// The three server-backed sections. Unlike the models above they hold no
  /// local mirror — connections, scheduled tasks and code sessions live only
  /// on the server, so each screen reads them live and says so when it cannot.
  var connectorModel: NativeConnectorModel?
  var scheduledTaskModel: NativeScheduledTaskModel?
  var codeModel: NativeCodeModel?
  /// Trusted-device remote state. This is distinct from server Code tasks: it
  /// follows sessions running on a paired host and never exposes host paths.
  var remoteCodeModel: CodeRemoteBrowserModel? = nil
  /// Juno Work: the tasks the account has handed Juno, and the Macs that can
  /// run them. Server-backed like the three above, and started at sign-in
  /// rather than when the screen opens — the model polls the task list so the
  /// "waiting on you" count is true before anybody navigates to it.
  var workModel: NativeWorkModel?
  /// Backs the composer's "From your library".
  var libraryModel: NativeLibraryModel?
  /// The authenticated transport, used to mint a voice relay credential. See
  /// ``startVoice()`` for why the controller cannot be built at launch.
  var requestSender: (any NativeAuthenticatedRequestSending)?
  /// Backs Settings › Danger zone.
  var accountDataClient: NativeAccountDataClient?
  /// Files a finished voice call into chat history. See ``saveVoiceTranscript``.
  var voiceTranscriptClient: NativeVoiceTranscriptClient?
  /// Resolves durable document context for composed Voice turns.
  var voiceAttachmentContextClient: NativeVoiceAttachmentContextClient? = nil
  /// Backs the transcript's action row — rate, branch, read aloud.
  var messageActionsClient: NativeMessageActionsClient?
  var followUpClient: NativeFollowUpClient?
  var pullsClient: NativeGitHubPullsClient?
  var shareClient: NativeShareClient?
  // Restores the last-viewed destination across relaunches (per scene).
  @SceneStorage("juno.mobile.selection") private var selection = JunoMobileSection.chat
  @State private var sidebarOpen = false
  @State private var showingSettings = false
  /// A link the drawer just published, waiting for the share sheet.
  @State private var drawerShare: NativeShare?
  /// Requests from Siri, Shortcuts, the Home Screen and notifications.
  private var launchRequests: JunoMobileLaunchRequests { .shared }
  /// A question from "Ask Juno", handed to the draft composer.
  @State private var pendingAskPrompt: String?
  /// The Widget / App Intent "Dictate" shortcut. It is a one-shot binding so
  /// the composer can clear it once speech recognition owns the microphone.
  @State private var pendingDictation = false
  /// Whether full-screen voice is up — see the note on the cover.
  @State private var voiceFullScreenPresented = false
  /// Local notifications and the background approval check for Juno Code.
  private var codeNotifications: JunoMobileCodeNotifications { .shared }

  /// Nil in the preview harness, where a permission prompt would sit over
  /// every screenshot of Code.
  private var previewNotifications: JunoMobileCodeNotifications? {
    #if DEBUG
      if previewSession != nil { return nil }
    #endif
    return codeNotifications
  }
  @State private var incognito = false
  /// The live voice session, built when one is asked for and published to the
  /// chat column through the environment. Held here rather than in the chat
  /// screen so a call survives the screen re-rendering underneath it.
  @State private var voiceSession: JunoMobileVoiceSession?
  /// This phone's local document index — files read through
  /// ``DocumentIngestionPipeline`` and ranked by `JunoSearch`.
  ///
  /// Owned here rather than by the Library screen, and for the same two reasons
  /// the Mac keeps it at its composition root: it has to survive leaving the
  /// tab, or nobody could index a document and then look for it; and it holds
  /// the plaintext of what was indexed, so sign-out has to be able to reach it
  /// and wipe it. It takes no transport, because nothing indexed here is
  /// uploaded — extraction, chunking and ranking all happen on the device.
  @State private var documentIndex = NativeDocumentIndexModel()
  #if DEBUG
    /// Set by `JUNO_START_OVERLAY=voice`, and acted on once the account is
    /// signed in — the launch flag fires before `restore()` finishes, and a
    /// session cannot be authorized without an account.
    @State private var pendingVoiceLaunch = false
  #endif
  @Environment(\.horizontalSizeClass) private var sizeClass
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  #if DEBUG
    /// Set only by the local UI Preview harness to render the real authenticated
    /// shell without any authentication; nil in every normal run.
    var previewSession: NativeAuthenticatedSession?
  #endif

  /// The appearance the account asked for. Stored and synced like every other
  /// preference, but nothing was applying it — the Dark option moved a value
  /// the UI never read, so the app stayed light whatever you picked.
  private var preferredColorScheme: ColorScheme? {
    #if DEBUG
      // The fixture account has a stored theme, but a visual review launch
      // must be able to override it deterministically. Without this branch
      // the root's account preference won over the preview container's
      // appearance and every supposed dark-mode capture was actually light.
      if let appearance = JunoPreviewEnvironment.appearance {
        return appearance.colorScheme
      }
    #endif
    switch memorySettingsModel?.settings?.theme {
    case .light: return ColorScheme.light
    case .dark: return ColorScheme.dark
    // Nil, not a guess: `nil` is what tells SwiftUI to follow the system.
    case .system, .none: return nil
    }
  }

  var body: some View {
    Group {
      #if DEBUG
        if previewSession != nil, JunoPreviewEnvironment.signedOut {
          // The signed-out front door, which the harness's fixture session
          // otherwise makes unreachable.
          JunoMobileSignInView(authModel: authModel)
        } else if let previewSession {
          authenticatedContent(session: previewSession)
        } else {
          phaseContent
        }
      #else
        phaseContent
      #endif
    }
    // The window's own backdrop. It catches what no screen paints — chiefly
    // the signed-out shell, which declares no background at all and was
    // therefore the one screen in the app whose colour was `systemBackground`
    // rather than the canvas.
    //
    // Safe to read here, unlike the accent below: `junoCanvas` is a `static
    // let`, so it registers no observable dependency and cannot re-evaluate
    // this body.
    .junoScreenCanvas()
    .preferredColorScheme(preferredColorScheme)
    // NOTE: `.tint(Color.junoAccent)` must NOT go here. Reading the accent in
    // this body makes the body re-evaluate whenever it changes, and this body is
    // an ancestor of the Settings sheet — so choosing a colour tore the sheet
    // down and dropped the reader back on the chat mid-tap, which is what
    // "the accent selector doesn't work" actually was. The tint is applied on
    // the leaves instead, none of which is an ancestor of a presentation the
    // accent can move.
    // The accent is a *process* value, not a view value — see
    // `JunoAccentSelection`. Applied on first read of the settings row and on
    // every subsequent sync, so a change made on the web lands here too.
    .onChange(of: memorySettingsModel?.settings?.accent) { _, accent in
      JunoAccentSelection.shared.apply(setting: accent)
    }
    // And once at launch: `onChange` does not fire for the value that is
    // already there when the settings row loads before this view appears.
    .task(id: memorySettingsModel?.settings?.accent) {
      #if DEBUG
        // A launch override wins, so every palette has a reachable state.
        if let forced = JunoPreviewEnvironment.initialAccent {
          JunoAccentSelection.shared.apply(setting: forced)
          return
        }
      #endif
      JunoAccentSelection.shared.apply(setting: memorySettingsModel?.settings?.accent)
    }
    // Deliberately NOT wrapped in `.animation(_:value:)`. Crossfading the
    // whole app on a theme change reads well for about a second and costs
    // far more than that: an `.animation` at the root applies to every state
    // change in the entire hierarchy, including the ones that drive sheets
    // and covers, and this codebase has already paid for that once — see the
    // note on the composer's "+", whose action stopped running when it was
    // wrapped the same way. The system's own appearance transition is
    // perfectly good.
    .task {
      #if DEBUG
        if previewSession != nil {
          if let raw = JunoPreviewEnvironment.initialDestination,
            let section = JunoMobileSection(rawValue: raw)
          {
            selection = section
          }
          if CommandLine.arguments.contains("--juno-preview-sidebar") {
            sidebarOpen = true
          }
          if CommandLine.arguments.contains("--juno-preview-settings") {
            showingSettings = true
          }
          // Opens straight into incognito, so the mode's own look is one
          // relaunch away rather than a scripted tap.
          if CommandLine.arguments.contains("--juno-preview-incognito") {
            selection = .chat
            conversationModel?.selectedConversationID = nil
            incognito = true
          }
          // A draft is a first-class preview state. Keep it separate from the
          // signed-in fixture conversation so header controls can be audited
          // in both states without relying on a prior tap or restored scene
          // storage.
          if CommandLine.arguments.contains("--juno-preview-chat-draft") {
            selection = .chat
            conversationModel?.isDraftingNewConversation = true
            conversationModel?.selectedConversationID = nil
          }
          if CommandLine.arguments.contains("--juno-preview-voice")
            || JunoPreviewEnvironment.opensVoiceFullScreen
          {
            startVoice()
            if JunoPreviewEnvironment.opensVoiceFullScreen {
              voiceSession?.isFullScreen = true
            }
          }
          return
        }
        // Opens the real, signed-in shell straight onto one destination, so
        // a screenshot of any section is one relaunch rather than a scripted
        // tap sequence:
        //   SIMCTL_CHILD_JUNO_START_TAB=connections xcrun simctl launch …
        //   SIMCTL_CHILD_JUNO_START_OVERLAY=settings|sidebar
        // The overlay flag matters because Settings and the drawer are not
        // destinations on iPhone — they are a sheet and a reveal — so
        // selecting them as sections would screenshot something the app
        // never actually shows. DEBUG-only, like every other flag here.
        let environment = ProcessInfo.processInfo.environment
        if let raw = environment["JUNO_START_TAB"],
          let section = JunoMobileSection(rawValue: raw)
        {
          selection = section
        }
        switch environment["JUNO_START_OVERLAY"] {
        case "settings": showingSettings = true
        case "sidebar": sidebarOpen = true
        // Voice is otherwise only reachable by tapping the composer's
        // primary action on an empty draft, which a scripted screenshot
        // cannot do. The session it opens is a real one — the relay refuses
        // or accepts it exactly as it would from a tap.
        case "voice": pendingVoiceLaunch = true
        default: break
        }
      #endif
      await authModel.restore()
    }
    .onChange(of: authModel.phase) { _, phase in
      #if DEBUG
        if previewSession != nil { return }
      #endif
      if case .signedIn(let session) = phase {
        // Attached before anything can be sent. Nothing in this client
        // used to look at a finished conversation at all, which is why
        // `MemoryExtractionEngine` had no caller — this is the seam.
        connectProjectAssistantHooks()
        syncModel?.start(for: session.profile.id)
        Task { await conversationModel?.start(for: session.profile.id) }
        Task { await projectModel?.start(for: session.profile.id) }
        Task {
          await projectWorkspaceModel?.start(for: session.profile.id)
          await projectWorkspaceModel?.reload(
            knownProjectIDs: Set((projectModel?.projects ?? []).map(\.id))
          )
        }
        Task { await artifactModel?.start(for: session.profile.id) }
        Task { await memorySettingsModel?.start(for: session.profile.id) }
        searchModel?.start(for: session.profile.id)
        privateChatModel?.start(for: session.profile.id)
        attachmentModel?.start(for: session.profile.id)
        avatarModel?.start(for: session.profile)
        Task { await connectorModel?.start(for: session.profile.id) }
        Task { await scheduledTaskModel?.start(for: session.profile.id) }
        Task { await codeModel?.start(for: session.profile.id) }
        remoteCodeModel?.start(for: session.profile.id)
        codeNotifications.attach(remoteCodeModel)
        Task { await workModel?.start(for: session.profile.id) }
        libraryModel?.start(for: session.profile.id)
        documentIndex.start(for: session.profile.id)
        #if DEBUG
          if pendingVoiceLaunch {
            pendingVoiceLaunch = false
            startVoice()
          }
        #endif
      } else {
        syncModel?.stop()
        attachmentModel?.stop()
        conversationModel?.stop()
        projectModel?.stop()
        projectWorkspaceModel?.stop()
        artifactModel?.stop()
        memorySettingsModel?.stop()
        // Proposals are held in memory and belong to one account. Leaving
        // them would show whoever signs in next what the previous reader
        // had been asked about — and the whole promise of a proposal is
        // that it was never stored.
        if let memoryLearningModel {
          Task { await memoryLearningModel.stop() }
        }
        searchModel?.stop()
        // Signing out must not leave an incognito transcript in memory.
        privateChatModel?.stop()
        incognito = false
        avatarModel?.clear()
        connectorModel?.stop()
        scheduledTaskModel?.stop()
        codeModel?.stop()
        remoteCodeModel?.stop()
        Task { await JunoMobileSpotlight.clear() }
        // Signing out has to close the Work event stream as well as the
        // poll: it is an authenticated connection following a task on a
        // machine the signed-out reader no longer has an account for.
        workModel?.stop()
        libraryModel?.stop()
        // Not merely "forget the list": the plaintext of every indexed
        // document is in that index, so `stop()` wipes the account's
        // partition. Nothing indexed by the person signing out may be
        // retrievable by whoever signs in next.
        documentIndex.stop()
        // A voice session outliving the account it was authorized for is
        // a live microphone on a signed-out device.
        voiceSession?.controller.end()
        voiceSession = nil
      }
    }
    .onChange(of: syncModel?.synchronizationGeneration) { _, generation in
      guard let generation else { return }
      Task { await conversationModel?.synchronizationDidAdvance(to: generation) }
      Task { await projectModel?.synchronizationDidAdvance(to: generation) }
      Task { await projectWorkspaceModel?.synchronizationDidAdvance(to: generation) }
      Task { await artifactModel?.synchronizationDidAdvance(to: generation) }
      Task { await memorySettingsModel?.synchronizationDidAdvance(to: generation) }
      searchModel?.synchronizationDidAdvance(to: generation)
    }
    .onChange(of: syncModel?.phase) { _, _ in
      Task { await conversationModel?.reload() }
      Task { await projectModel?.reload() }
      Task {
        await projectWorkspaceModel?.reload(
          knownProjectIDs: Set((projectModel?.projects ?? []).map(\.id))
        )
      }
      Task { await artifactModel?.reload() }
      Task { await memorySettingsModel?.reload() }
    }
  }

  @ViewBuilder
  private var phaseContent: some View {
    switch authModel.phase {
    case .signedIn(let session):
      VStack(spacing: 0) {
        if authModel.connectivity.isUnreachable {
          JunoMobileOfflineBanner {
            Task { await authModel.retryRestore() }
          }
        }
        authenticatedContent(session: session)
      }
    case .restoring:
      JunoMobileQuietLoading()
    case .signedOut, .signingIn, .unavailable:
      JunoMobileSignInView(authModel: authModel)
    }
  }

  /// Size-adaptive navigation. iPhone uses a real sliding sidebar drawer
  /// (hamburger + veil), iPad/large uses a persistent NavigationSplitView.
  @ViewBuilder
  private func authenticatedContent(
    session: NativeAuthenticatedSession
  ) -> some View {
    Group {
      if sizeClass == .compact {
        compactDrawer(session: session)
      } else {
        NavigationSplitView {
          sidebar(session: session)
            .navigationBarTitleDisplayMode(.inline)
        } detail: {
          detail(for: selection)
        }
        .navigationSplitViewStyle(.balanced)
      }
    }
    .sheet(isPresented: $showingSettings) { settingsSheet }
    .sheet(item: $drawerShare) { share in
      JunoMobileShareSheet(items: [share.url])
    }
    // Voice is **not** a presentation any more. It used to be a
    // `fullScreenCover`, on the argument that a spoken conversation is the
    // whole interaction while it lasts — and that argument is what made it
    // impossible to show Juno a photo while talking, because taking the
    // screen took the composer, the camera and the picker with it. The
    // session is published here instead and the chat column renders it in
    // place: a field behind the composer and a dock above it, exactly as
    // `chat-view.tsx` mounts them.
    //
    // Published from the shell rather than from the chat screen because a
    // call must not end because a screen re-rendered, and because the shell
    // is where the credential that authorized it lives.
    .environment(\.junoVoiceSession, voiceSession)
    // Full-screen voice, over everything. A cover rather than a push so the
    // chat underneath keeps its scroll position and its composer, and so
    // swiping down lands exactly where the reader left.
    // Mirrored into local state rather than read through a binding getter:
    // Observation only tracks what the *body* reads, and a presentation
    // binding is read too late for the cover to notice the flag flipping.
    .onChange(of: voiceSession?.isFullScreen ?? false, initial: true) { _, open in
      voiceFullScreenPresented = open
    }
    .onChange(of: voiceFullScreenPresented) { _, open in
      if !open { voiceSession?.isFullScreen = false }
    }
    .fullScreenCover(isPresented: $voiceFullScreenPresented) {
      if let voiceSession {
        JunoMobileVoiceFullScreen(session: voiceSession) {
          voiceSession.isFullScreen = false
        }
        .tint(Color.junoAccent)
      }
    }
    // Siri, Shortcuts, quick actions and notification taps all land here.
    .onChange(of: launchRequests.pending, initial: true) { _, request in
      guard let request else { return }
      handleLaunchRequest(request)
    }
    // Conversation titles in Spotlight, rebuilt whenever the list changes.
    .onChange(of: conversationModel?.conversations.map(\.id).hashValue ?? 0) { _, _ in
      guard let conversations = conversationModel?.conversations else { return }
      Task { await JunoMobileSpotlight.index(conversations) }
    }
    .onContinueUserActivity(CSSearchableItemActionType) { activity in
      guard let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return }
      launchRequests.request(.openConversation(id))
    }
  }

  /// Acts on one launch request once the shell can — a request that arrives
  /// before sign-in waits for it.
  private func handleLaunchRequest(_ request: JunoMobileLaunchRequests.Request) {
    guard currentSession != nil else { return }
    launchRequests.pending = nil
    setSidebar(false)
    switch request {
    case .newChat:
      showingSettings = false
      startNewChat()
    case .voice:
      showingSettings = false
      startVoice()
      voiceSession?.isFullScreen = true
    case .dictate:
      showingSettings = false
      startNewChat()
      pendingDictation = true
    case .code:
      showingSettings = false
      selection = .code
    case .ask(let prompt):
      showingSettings = false
      startNewChat()
      pendingAskPrompt = prompt
    case .openConversation(let id):
      showingSettings = false
      openConversation(id)
    case .openRemoteSession(let deviceID, let sessionID):
      showingSettings = false
      selection = .code
      remoteCodeModel?.selectedDeviceID = deviceID
      remoteCodeModel?.openSession(sessionID)
    }
  }

  /// Written as a typed property rather than an inline `cond ? method : nil`.
  /// That form is a closure-or-nil choice the type checker has now given up on
  /// twice in this file — see `voiceAction` and `memoryAction`.
  private var voiceSaveAction: ((JunoMobileVoiceTranscript) async -> String?)? {
    guard voiceTranscriptClient != nil else { return nil }
    return { transcript in await saveVoiceTranscript(transcript) }
  }

  /// Files a finished voice call into the account's chat history.
  ///
  /// **Which conversation it lands in is decided here, by one line.** If a chat
  /// was open when the call started, `selectedConversationID` is non-nil and the
  /// turns are appended to it. On the home screen — a draft, nothing selected —
  /// it is nil, and the server creates a conversation for them. That is the
  /// same rule the website applies, and it is the whole of the behaviour: no
  /// client-side branching, because the route already treats a null
  /// `conversationId` as "make one".
  ///
  /// Returns the conversation id, or nil on failure so the screen can offer a
  /// retry — the relay keeps nothing, so a dropped save loses the conversation.
  private func saveVoiceTranscript(
    _ transcript: JunoMobileVoiceTranscript
  ) async -> String? {
    guard let voiceTranscriptClient,
      let session = currentSession,
      let conversationModel
    else { return nil }

    let openConversationID = conversationModel.selectedConversationID
    do {
      let saved = try await voiceTranscriptClient.save(
        sessionID: transcript.sessionID,
        conversationID: openConversationID,
        // The conversation's own model when there is one, so a voice turn
        // in an existing chat is attributed to what that chat is using.
        modelID: conversationModel.conversations
          .first { $0.id == openConversationID }?.model
          ?? memorySettingsModel?.settings?.defaultModel
          ?? conversationModel.selectableModels.first?.id
          ?? "juno:auto",
        projectID: conversationModel.conversations
          .first { $0.id == openConversationID }?.projectId,
        connectors: [],
        turns: transcript.turns,
        for: session.profile.id
      )
      // Pull the server's rows down before selecting, so opening the chat
      // shows the turns rather than an empty transcript that fills in.
      await syncModel?.refresh()
      await conversationModel.reload()
      conversationModel.selectedConversationID = saved.conversationID
      selection = .chat
      // A conversation the server just created has no name yet. This is the
      // same naming the typed path gets — from the spoken turns instead of
      // a typed one.
      await conversationModel.generateTitleIfNeeded(
        conversationID: saved.conversationID
      )
      return saved.conversationID
    } catch {
      return nil
    }
  }

  /// Builds a voice session for the signed-in account and dials it.
  ///
  /// Built here, on demand, rather than at launch with the other models: a
  /// relay credential is minted per session against a specific account, and at
  /// `makeConfiguration()` time there is no account. Returning without doing
  /// anything when either half is missing is what keeps the composer's voice
  /// button honest — `openVoiceMode` is nil in that case, so the button is
  /// never offered at all.
  ///
  /// `start()` is called here rather than from the dock's `task`. The dock
  /// lives in the chat column now, so it can appear a second time over the
  /// same session — and `start()` is legal from `ended`, which would make that
  /// second appearance silently redial a call the reader had hung up.
  private func startVoice() {
    guard voiceSession == nil,
      let requestSender,
      let session = currentSession
    else { return }
    let started = JunoMobileVoiceSession(
      controller: JunoRealtimeVoiceController(
        authorization: JunoMobileVoiceAuthorization(
          sender: requestSender,
          accountID: session.profile.id
        )
      ),
      accountID: session.profile.id,
      attachmentContextClient: voiceAttachmentContextClient,
      saveTranscript: voiceSaveAction,
      close: { voiceSession = nil }
    )
    voiceSession = started
    // Chat is where the dock renders, so a call started from anywhere else —
    // today only the DEBUG launch flag — has to land there or it opens with
    // no surface to appear on.
    selection = .chat
    #if DEBUG
      if previewSession != nil {
        // No relay in the harness: a live-looking call with a transcript, so
        // the dock and the full-screen mode can be looked at.
        started.controller.beginPreviewSession(
          lines: [
            (role: .user, text: "What's the quickest way to check the sync monitor's reconnect path?"),
            (role: .assistant, text: "Run the JunoSync tests with the reconnect filter — I can kick that off on your Mac if you like."),
            (role: .user, text: "Yes, do that, and tell me if anything fails."),
          ]
        )
        return
      }
    #endif
    Task { await started.controller.start() }
  }

  /// Whether a spoken conversation can be started at all. Both halves have to
  /// be present, and on a signed-out or unconfigured shell neither is.
  private var canStartVoice: Bool {
    requestSender != nil && currentSession != nil
  }

  /// Settings is presented as a large modal sheet over the current screen —
  /// the app stays visible and dimmed behind it, and dismissing restores the
  /// exact screen underneath. The sheet owns a single NavigationStack so
  /// subpages (Memory, …) push with one Back and the root shows only a close
  /// button.
  @ViewBuilder
  private var settingsSheet: some View {
    NavigationStack {
      Group {
        if let memorySettingsModel {
          JunoMobileSettingsView(
            model: memorySettingsModel,
            learningModel: memoryLearningModel,
            conversationModel: conversationModel,
            authModel: authModel,
            session: currentSession,
            avatarData: avatarModel?.imageData,
            syncModel: syncModel,
            outbox: outbox,
            accountDataClient: accountDataClient,
            requestSender: requestSender,
            openConversation: { id in
              showingSettings = false
              openConversation(id)
            },
            messageActionsClient: messageActionsClient,
            remoteCodeModel: remoteCodeModel
          )
        } else {
          unavailable
        }
      }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          // A bare glyph, deliberately. From OS 26 the toolbar draws
          // its own Liquid Glass capsule behind every item, so adding
          // `JunoGlassCircle` here stacked a second bubble inside the
          // system's one — two concentric rings around one ×.
          Button {
            showingSettings = false
          } label: {
            JunoIconView(.close, size: 15)
              // Ink: closing a sheet is chrome, not emphasis.
              .foregroundStyle(Color.primary)
          }
          .accessibilityLabel("Close settings")
          .accessibilityIdentifier("juno.mobile.settings-close")
        }
      }
      .junoScreenCanvas()
    }
    // Settings is a page of sustained text and controls — a reading surface,
    // not chrome — so it takes the full height it already had (`[.large]` is
    // the default, so saying it was noise) and loses the grabber, which on a
    // single-detent sheet promises a drag that does nothing. What it gains is
    // `scrollContentBackground(.hidden)`: the `Form` inside supplies its own
    // opaque grouped background, which was painting over the warm canvas the
    // screen puts down.
    .junoSheetSurface(.page)
    .tint(Color.junoAccent)
  }

  // MARK: iPhone drawer

  /// The "reveal" interaction: the sidebar is a fixed layer *behind* the main
  /// window, and opening slides the whole chat plate to the right to uncover
  /// it — no panel slides over the chat, and there is no dimming veil. Depth
  /// comes from the plate's rounded corners, a soft shadow and a subtle scale.
  private func compactDrawer(session: NativeAuthenticatedSession) -> some View {
    let revealed = min(UIScreen.main.bounds.width * 0.84, 360)
    return ZStack(alignment: .leading) {
      JunoMobileSidebarDrawer(
        selection: $selection,
        conversationModel: conversationModel,
        projectModel: projectModel,
        workModel: workModel,
        codeModel: codeModel,
        session: session,
        avatarData: avatarModel?.imageData,
        canCreateChat: conversationModel != nil,
        requestSender: requestSender,
        openDestination: openSidebarDestination,
        openConversation: openSidebarConversation,
        openProject: openSidebarProject,
        openRecent: openRecent,
        newChat: startNewChat,
        shareConversation: shareAction
      )
      .frame(width: revealed, alignment: .leading)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .background(Color.junoCanvas.ignoresSafeArea())

      ZStack {
        // The plate's own fill, opaque because the drawer's rows sit
        // directly behind it while it is closed. It was
        // `systemBackground`, which is the one colour it must not be:
        // every screen paints `junoCanvas` over it, so the only way that
        // fill can ever be seen is as a seam where a screen stops — and a
        // seam in pure white or pure black is exactly the failure this
        // pass is about.
        Color.junoCanvas
        detail(for: selection)
          .allowsHitTesting(!sidebarOpen)
      }
      // The drawer can be revealed from anywhere on the chat plate. A
      // simultaneous, horizontal-only recognizer preserves buttons and
      // menus while making the gesture discoverable on the whole screen,
      // not just the first 20 points at the leading edge.
      .simultaneousGesture(
        DragGesture(minimumDistance: 18)
          .onEnded { value in
            guard !sidebarOpen,
              value.translation.width > 60,
              abs(value.translation.width) > abs(value.translation.height)
            else { return }
            setSidebar(true)
          }
      )
      .overlay {
        if sidebarOpen {
          // Open: the plate is inert anyway, so the close tap *and*
          // the close swipe both live here, competing with nothing.
          Rectangle()
            .fill(.clear)
            .contentShape(Rectangle())
            .onTapGesture { setSidebar(false) }
            .gesture(
              DragGesture(minimumDistance: 18)
                .onEnded { value in
                  guard value.translation.width < -60 else { return }
                  setSidebar(false)
                }
            )
            .accessibilityLabel("Close sidebar")
            .accessibilityAddTraits(.isButton)
        }
      }
      // On iOS 26/27 the system can derive a concentric corner from the
      // enclosing device shape. That keeps the revealed chat plate parallel
      // to the iPhone instead of approximating it with a generic 32pt radius.
      .modifier(JunoMobileDrawerPlate(open: sidebarOpen))
      .ignoresSafeArea()
      .shadow(color: .black.opacity(sidebarOpen ? 0.16 : 0), radius: 20, x: -1)
      .offset(x: sidebarOpen ? revealed : 0)
    }
    .animation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion), value: sidebarOpen)
  }

  /// Enters or leaves incognito.
  ///
  /// One animation for the whole mode change, applied here rather than at either
  /// face: the two are siblings in the same `Group`, so animating the flag is what
  /// crossfades them. A `.snappy` rather than a spring — the mode is a state, and
  /// overshoot on a privacy affordance reads as playfulness in the wrong place.
  private func setIncognito(_ on: Bool) {
    if reduceMotion {
      incognito = on
    } else {
      withAnimation(JunoMotion.standard) { incognito = on }
    }
  }

  private func setSidebar(_ open: Bool) {
    if reduceMotion {
      sidebarOpen = open
    } else {
      withAnimation(JunoMotion.emphasized) { sidebarOpen = open }
    }
  }

  // MARK: Sidebar

  @ViewBuilder
  private func sidebar(session: NativeAuthenticatedSession) -> some View {
    JunoMobileSidebarDrawer(
      selection: $selection,
      conversationModel: conversationModel,
      projectModel: projectModel,
      workModel: workModel,
      codeModel: codeModel,
      session: session,
      avatarData: avatarModel?.imageData,
      requestSender: requestSender,
      openDestination: openSidebarDestination,
      openConversation: openSidebarConversation,
      openProject: openSidebarProject,
      openRecent: openRecent,
      newChat: startNewChat,
      shareConversation: shareAction
    )
  }

  /// Publishes a conversation from the drawer and hands the link to the
  /// system share sheet. Nil where there is no share client, so the menu row
  /// is absent rather than present and inert.
  private var shareAction: ((String) -> Void)? {
    guard let shareClient, let session = currentSession else { return nil }
    return { conversationID in
      Task {
        guard
          let share = try? await shareClient.share(
            conversationID: conversationID, for: session.profile.id
          )
        else { return }
        drawerShare = share
      }
    }
  }

  private func openSidebarProject(_ id: String) {
    projectModel?.selectedProjectID = id
    selection = .projects
    setSidebar(false)
  }

  private func openSidebarDestination(_ destination: JunoMobileSection) {
    setSidebar(false)
    // Navigating away ends it. Leaving the mode armed behind another section
    // means coming back to Chat later and typing into a session the reader has
    // forgotten is incognito — or worse, assuming one is.
    if destination != .chat, incognito {
      privateChatModel?.reset()
      incognito = false
    }
    // Settings is a modal sheet over the current screen, never a pushed
    // destination that replaces it.
    guard destination != .settings else {
      showingSettings = true
      return
    }
    selection = destination
    if destination != .chat { conversationModel?.selectedConversationID = nil }
  }

  private func openSidebarConversation(_ id: String) {
    conversationModel?.isDraftingNewConversation = false
    conversationModel?.selectedConversationID = id
    selection = .chat
    setSidebar(false)
  }

  private func openRecent(_ item: JunoRecentItem) {
    switch item.kind {
    case .chat:
      openSidebarConversation(item.sourceID)
    case .work:
      guard let session = workModel?.sessions.first(where: { $0.id == item.sourceID }) else {
        return
      }
      workModel?.open(session)
      selection = .work
      setSidebar(false)
    case .code:
      guard let task = codeModel?.tasks.first(where: { $0.id == item.sourceID }) else { return }
      codeModel?.open(task)
      selection = .code
      setSidebar(false)
    case .project:
      selection = .projects
      setSidebar(false)
    }
  }

  /// New chat opens a *draft*: an empty composer under the greeting, with no
  /// row in the sidebar. The conversation is created by the first send — see
  /// `NativeConversationModel.createConversationResolvingID`.
  private func startNewChat() {
    conversationModel?.isDraftingNewConversation = true
    conversationModel?.selectedConversationID = nil
    selection = .chat
    setSidebar(false)
  }

  // MARK: Detail

  @ViewBuilder
  private func detail(for destination: JunoMobileSection) -> some View {
    NavigationStack {
      destinationRoot(destination)
        .toolbar {
          if sizeClass == .compact {
            ToolbarItem(placement: .topBarLeading) {
              Button {
                setSidebar(true)
              } label: {
                JunoMenuGlyph()
              }
              .accessibilityLabel("Open sidebar")
              .accessibilityIdentifier("juno.mobile.menu")
            }
          }
        }
        .junoScreenCanvas()
    }
    .tint(Color.junoAccent)
  }

  /// The chat destination, extracted from `destinationRoot`.
  ///
  /// Not a style choice: with the composer's tools wired in, the `switch` over
  /// every section became one expression the type checker gave up on —
  /// literally "failed to produce diagnostic for expression". The transcript
  /// and the conversation toolbar are already split out of their own bodies for
  /// the same reason. Anything that has to grow here should grow as another
  /// property, not as another argument in the middle of the switch.
  @ViewBuilder
  private var chatDestination: some View {
    if incognito, let privateChatModel, let conversationModel {
      // The SAME destination, wearing its incognito face. Not presented
      // over the chat and not pushed onto it — see the note on
      // `JunoMobileIncognitoChat`. The crossfade is the shell's, so the
      // navigation bar and the drawer stay exactly where they are.
      JunoMobileIncognitoChat(
        model: privateChatModel,
        selectableModels: conversationModel.selectableModels,
        initialModelID: memorySettingsModel?.settings?.defaultModel
          ?? conversationModel.selectableModels.first?.id ?? "",
        profileName: currentSession?.profile.name,
        onClose: { setIncognito(false) }
      )
      .transition(.opacity)
    } else if let conversationModel {
      JunoMobileChatDetailScreen(
        model: conversationModel,
        projects: projectModel?.projects ?? [],
        attachmentModel: attachmentModel,
        profileName: currentSession?.profile.name,
        // The composer's connected-apps row goes where the web's does:
        // Juno's connections. Always offered, exactly as the drawer
        // offers that destination — the screen itself is what says when
        // there is nothing behind it.
        openPlugins: { selection = .connections },
        // The same action the drawer's + runs, so New chat from the
        // chat header and New chat from the sidebar cannot diverge.
        newChat: startNewChat,
        // Settings' own choice. Empty until the settings row loads,
        // which is why the composer re-resolves when it changes.
        accountDefaultModelID: memorySettingsModel?.settings?.defaultModel ?? "",
        // Lets a tapped artifact card in the transcript resolve to the
        // stored artifact and open over the conversation.
        artifactModel: artifactModel,
        // Offered only where the web offers it: with no chat open. In a
        // saved conversation the reader is already in a chat that IS
        // being saved, and a ghost there reads as a promise about the
        // thread they can see.
        startIncognito: privateChatModel == nil ? nil : { setIncognito(true) },
        // Nil where a session cannot be authorized, which is what keeps
        // the composer from offering a voice button that opens nothing —
        // the state this app shipped in.
        openVoiceMode: voiceAction,
        libraryModel: libraryModel,
        // Only the connected ones. A menu listing every app in the
        // catalog would be a catalog, and choosing an unconnected app for
        // a turn does nothing the server can honour.
        connectors: connectedApps,
        memoryEnabled: memorySettingsModel?.settings?.memoryEnabled ?? true,
        setMemoryEnabled: memoryAction,
        messageActions: messageActionsClient,
        followUpClient: followUpClient,
        shareClient: shareClient,
        accountID: currentSession?.profile.id,
        voiceID: memorySettingsModel?.settings?.voiceID,
        requestSender: requestSender,
        pendingPrompt: $pendingAskPrompt
        , startDictation: $pendingDictation
      )
      .transition(.opacity)
    } else {
      unavailable
    }
  }

  private var connectedApps: [NativeConnector] {
    (connectorModel?.linked ?? []).filter(\.connected)
  }

  /// Written as typed properties rather than inline `cond ? method : nil`
  /// ternaries. Both of those are a closure-or-nil choice in the middle of a
  /// twenty-argument initializer, and they are what tipped this expression past
  /// what the type checker would solve.
  private var voiceAction: (() -> Void)? {
    guard canStartVoice else { return nil }
    return { startVoice() }
  }

  private var memoryAction: (@MainActor @Sendable (Bool) -> Void)? {
    guard let memorySettingsModel else { return nil }
    return { enabled in
      Task {
        await memorySettingsModel.updateSettings(
          NativeSettingsPatch(memoryEnabled: enabled)
        )
      }
    }
  }

  @ViewBuilder
  private func destinationRoot(_ destination: JunoMobileSection) -> some View {
    switch destination {
    case .chat:
      chatDestination
    case .search:
      if let searchModel {
        JunoMobileSearchView(
          model: searchModel,
          open: openSearchResult,
          // The drawer's own ordering, reused: pinned first, then most
          // recently touched. Search's resting state should agree with
          // the sidebar rather than invent a second notion of "recent".
          recentConversations: recentsForSearch,
          projects: projectModel?.projects ?? [],
          openConversation: openConversation,
          openProject: { id in
            projectModel?.selectedProjectID = id
            selection = .projects
          }
        )
      } else {
        unavailable
      }
    case .code:
      if let codeModel {
        JunoMobileCodeView(
          model: codeModel,
          remoteModel: remoteCodeModel,
          notifications: previewNotifications,
          startConversation: startProjectlessCodeConversation,
          pullsClient: pullsClient,
          accountID: currentSession?.profile.id,
          openConnections: { selection = .connections },
          // Code gets the account the same way the website's Code mode
          // does — the user menu stays in the sidebar there, so plan
          // and usage are never more than a glance away.
          session: currentSession,
          avatarData: avatarModel?.imageData,
          requestSender: requestSender,
          modelCatalog: conversationModel?.modelCatalog ?? [],
          openSettings: { openSidebarDestination(.settings) }
        )
      } else {
        unavailable
      }
    case .work:
      if let workModel {
        JunoMobileWorkView(model: workModel)
      } else {
        unavailable
      }
    case .tasks:
      if let scheduledTaskModel {
        JunoMobileTasksView(
          model: scheduledTaskModel,
          models: conversationModel?.modelCatalog ?? [],
          openConversation: openConversation
        )
      } else {
        unavailable
      }
    case .connections:
      if let connectorModel {
        JunoMobileConnectionsView(model: connectorModel)
      } else {
        unavailable
      }
    case .projects:
      if let projectModel {
        JunoMobileProjectsView(
          model: projectModel,
          workspaceModel: projectWorkspaceModel,
          conversationModel: conversationModel,
          openConversation: openConversation
        )
      } else {
        unavailable
      }
    case .library:
      if let projectModel {
        JunoMobileLibraryView(
          model: projectModel,
          documentIndex: documentIndex,
          accountID: currentSession?.profile.id,
          attachmentClient: requestSender.map { NativeAttachmentAPIClient(sender: $0) },
          generateClient: generateClient,
          modelCatalog: conversationModel?.modelCatalog ?? [],
          openConversation: openConversation
        )
      } else {
        unavailable
      }
    case .artifacts:
      if let artifactModel {
        JunoMobileArtifactsView(model: artifactModel, openConversation: openConversation)
      } else {
        unavailable
      }
    case .settings:
      if let memorySettingsModel {
        JunoMobileSettingsView(
          model: memorySettingsModel,
          learningModel: memoryLearningModel,
          conversationModel: conversationModel,
          authModel: authModel,
          session: currentSession,
          avatarData: avatarModel?.imageData,
          syncModel: syncModel,
          outbox: outbox,
          accountDataClient: accountDataClient,
          requestSender: requestSender,
          openConversation: openConversation,
          messageActionsClient: messageActionsClient,
          remoteCodeModel: remoteCodeModel
        )
      } else {
        unavailable
      }
    }
  }

  /// Joins chat turns to the synced project assistant and memory learner.
  ///
  /// **Incognito needs no exclusion here and gets none by construction.** A
  /// private chat runs on ``NativePrivateChatModel``, which shares no state with
  /// the persisted one and never appends to `conversationModel` — so its turns
  /// cannot reach this hook at all. An `isExcluded` flag would be a second,
  /// weaker guarantee sitting on top of a structural one, and the weaker one is
  /// what a future refactor would preserve.
  ///
  private func connectProjectAssistantHooks() {
    guard let conversationModel else { return }
    conversationModel.workspacePermissions = {
      [weak projectWorkspaceModel] projectID, requested in
      projectWorkspaceModel?.workspaces[projectID]?.permitting(requested) ?? requested
    }
    guard let memoryLearningModel else { return }
    conversationModel.didFinishTurn = { [weak memoryLearningModel] turn in
      guard let memoryLearningModel else { return }
      Task {
        await memoryLearningModel.observe(
          conversationID: turn.conversationID,
          turns: turn.userTurns,
          isExcluded: !turn.mayLearn
        )
      }
    }
  }

  private var currentSession: NativeAuthenticatedSession? {
    #if DEBUG
      if let previewSession { return previewSession }
    #endif
    if case .signedIn(let s) = authModel.phase { return s }
    return nil
  }

  private var unavailable: some View {
    ContentUnavailableView {
      JunoIconLabel("shell.unavailable.title", icon: .error)
    } description: {
      Text("shell.unavailable.description")
    }
  }

  private func openConversation(_ id: String) {
    conversationModel?.selectedConversationID = id
    selection = .chat
  }

  /// Starts a Juno Code conversation with no project and sends its first turn.
  ///
  /// It goes through the same create-then-send path a new chat uses —
  /// `createConversationResolvingID` solves the race where the settled server
  /// row arrives a beat after the local one is retired, and a second
  /// implementation of that would be a second place to get it wrong. Only the
  /// kind differs, and the server already accepts it: the chat pipeline
  /// answers exactly those `kind: "code"` conversations that have no
  /// workspace, which is what this creates.
  private func startProjectlessCodeConversation(_ prompt: String) async {
    guard let conversationModel else { return }
    guard
      let id = await conversationModel.createConversationResolvingID(
        title: String(prompt.prefix(60)),
        model: memorySettingsModel?.settings?.defaultModel,
        kind: "code"
      )
    else { return }
    // Open first: the transcript should already be on screen when the
    // answer starts streaming, rather than appearing part-way through it.
    openConversation(id)
    _ = conversationModel.sendMessage(
      conversationID: id,
      prompt: prompt,
      modelID: conversationModel.conversations.first { $0.id == id }?.model
        ?? memorySettingsModel?.settings?.defaultModel
        ?? conversationModel.selectableModels.first?.id
        ?? "juno:auto",
      reasoningEffort: nil
    )
  }

  /// Non-archived conversations, pinned first then newest — the drawer's rule.
  private var recentsForSearch: [NativeConversation] {
    (conversationModel?.conversations ?? [])
      .filter { $0.archivedAt == nil }
      .sorted { lhs, rhs in
        if lhs.pinned != rhs.pinned { return lhs.pinned }
        return lhs.lastMessageAt > rhs.lastMessageAt
      }
  }

  private func openSearchResult(_ result: NativeSearchResult) {
    switch result.kind {
    case .conversation, .message:
      conversationModel?.selectedConversationID = result.conversationID ?? result.entityID
      selection = .chat
    case .project:
      projectModel?.selectedProjectID = result.entityID
      selection = .projects
    case .file:
      selection = .library
    case .artifact:
      artifactModel?.selectedArtifactID = result.entityID
      selection = .artifacts
    case .memory:
      showingSettings = true
    }
  }
}

/// Clips the revealed chat plate with the device-aware shape introduced with
/// Liquid Glass. The fallback keeps the same visual hierarchy on older iOS.
private struct JunoMobileDrawerPlate: ViewModifier {
  let open: Bool

  @ViewBuilder
  func body(content: Content) -> some View {
    if open {
      if #available(iOS 26.0, *) {
        content.clipShape(
          ConcentricRectangle(
            corners: .concentric(minimum: .fixed(32)),
            isUniform: true
          )
        )
      } else {
        content.clipShape(
          RoundedRectangle(cornerRadius: 32, style: .continuous)
        )
      }
    } else {
      content.clipShape(Rectangle())
    }
  }
}

/// The mobile counterpart to the desktop offline banner: the workspace below is
/// the local copy, and Juno has not confirmed it.
private struct JunoMobileOfflineBanner: View {
  let retry: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      JunoIconView(.cloud, size: 16)
      Text("auth.offline.title")
        .font(.footnote)
      Spacer(minLength: 8)
      Button("auth.offline.retry", action: retry)
        .font(.footnote)
        .buttonStyle(.bordered)
        .controlSize(.mini)
        .contentShape(.rect)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.thinMaterial)
    .accessibilityIdentifier("juno.mobile.offline-banner")
  }
}

/// The menu affordance for opening the mobile drawer. Two left-aligned bars —
/// a longer top bar over a shorter bottom bar — matching the iOS convention for
/// a slide-in navigation menu rather than the macOS `sidebar.leading` rectangle.
private struct JunoMenuGlyph: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 5.5) {
      Capsule().fill(Color.primary).frame(width: 20, height: 2.5)
      Capsule().fill(Color.primary).frame(width: 13, height: 2.5)
    }
    .frame(width: 24, height: 24, alignment: .center)
  }
}
