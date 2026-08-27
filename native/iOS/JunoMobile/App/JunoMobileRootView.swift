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
        if let previewSession {
          authenticatedContent(session: previewSession)
        } else {
          phaseContent
        }
      #else
        phaseContent
      #endif
    }
    .junoScreenCanvas()
    .preferredColorScheme(preferredColorScheme)
    .onChange(of: memorySettingsModel?.settings?.accent) { _, accent in
      JunoAccentSelection.shared.apply(setting: accent)
    }
    .task(id: memorySettingsModel?.settings?.accent) {
      #if DEBUG
        if let forced = JunoPreviewEnvironment.initialAccent {
          JunoAccentSelection.shared.apply(setting: forced)
          return
        }
      #endif
      JunoAccentSelection.shared.apply(setting: memorySettingsModel?.settings?.accent)
    }
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
          if CommandLine.arguments.contains("--juno-preview-incognito") {
            selection = .chat
            conversationModel?.selectedConversationID = nil
            incognito = true
          }
          if CommandLine.arguments.contains("--juno-preview-chat-draft") {
            selection = .chat
            conversationModel?.isDraftingNewConversation = true
            conversationModel?.selectedConversationID = nil
          }
          if CommandLine.arguments.contains("--juno-preview-voice") {
            startVoice()
          }
          return
        }
        let environment = ProcessInfo.processInfo.environment
        if let raw = environment["JUNO_START_TAB"],
          let section = JunoMobileSection(rawValue: raw)
        {
          selection = section
        }
        switch environment["JUNO_START_OVERLAY"] {
        case "settings": showingSettings = true
        case "sidebar": sidebarOpen = true
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
        if let memoryLearningModel {
          Task { await memoryLearningModel.stop() }
        }
        searchModel?.stop()
        privateChatModel?.stop()
        incognito = false
        avatarModel?.clear()
        connectorModel?.stop()
        scheduledTaskModel?.stop()
        codeModel?.stop()
        workModel?.stop()
        libraryModel?.stop()
        documentIndex.stop()
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
    .environment(\.junoVoiceSession, voiceSession)
  }

  private var voiceSaveAction: ((JunoMobileVoiceTranscript) async -> String?)? {
    guard voiceTranscriptClient != nil else { return nil }
    return { transcript in await saveVoiceTranscript(transcript) }
  }

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
      await syncModel?.refresh()
      await conversationModel.reload()
      conversationModel.selectedConversationID = saved.conversationID
      selection = .chat
      await conversationModel.generateTitleIfNeeded(
        conversationID: saved.conversationID
      )
      return saved.conversationID
    } catch {
      return nil
    }
  }

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
    selection = .chat
    Task { await started.controller.start() }
  }

  private var canStartVoice: Bool {
    requestSender != nil && currentSession != nil
  }

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
            requestSender: requestSender
          )
        } else {
          unavailable
        }
      }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            showingSettings = false
          } label: {
            JunoIconView(.close, size: 15)
              .foregroundStyle(Color.primary)
          }
          .accessibilityLabel("Close settings")
          .accessibilityIdentifier("juno.mobile.settings-close")
        }
      }
      .junoScreenCanvas()
    }
    .junoSheetSurface(.page)
    .tint(Color.junoAccent)
  }

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
        openDestination: openSidebarDestination,
        openConversation: openSidebarConversation,
        openProject: openSidebarProject,
        openRecent: openRecent,
        newChat: startNewChat
      )
      .frame(width: revealed, alignment: .leading)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .background(Color.junoCanvas.ignoresSafeArea())

      ZStack {
        Color.junoCanvas
        detail(for: selection)
          .allowsHitTesting(!sidebarOpen)
      }
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
      .modifier(JunoMobileDrawerPlate(open: sidebarOpen))
      .ignoresSafeArea()
      .shadow(color: .black.opacity(sidebarOpen ? 0.16 : 0), radius: 20, x: -1)
      .offset(x: sidebarOpen ? revealed : 0)
    }
    .animation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion), value: sidebarOpen)
  }

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
      openDestination: openSidebarDestination,
      openConversation: openSidebarConversation,
      openProject: openSidebarProject,
      openRecent: openRecent,
      newChat: startNewChat
    )
  }

  private func openSidebarProject(_ id: String) {
    projectModel?.selectedProjectID = id
    selection = .projects
    setSidebar(false)
  }

  private func openSidebarDestination(_ destination: JunoMobileSection) {
    setSidebar(false)
    if destination != .chat, incognito {
      privateChatModel?.reset()
      incognito = false
    }
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

  private func startNewChat() {
    conversationModel?.isDraftingNewConversation = true
    conversationModel?.selectedConversationID = nil
    selection = .chat
    setSidebar(false)
  }

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

  @ViewBuilder
  private var chatDestination: some View {
    if incognito, let privateChatModel, let conversationModel {
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
        openPlugins: { selection = .connections },
        newChat: startNewChat,
        accountDefaultModelID: memorySettingsModel?.settings?.defaultModel ?? "",
        artifactModel: artifactModel,
        startIncognito: privateChatModel == nil ? nil : { setIncognito(true) },
        openVoiceMode: voiceAction,
        libraryModel: libraryModel,
        connectors: connectedApps,
        memoryEnabled: memorySettingsModel?.settings?.memoryEnabled ?? true,
        setMemoryEnabled: memoryAction,
        messageActions: messageActionsClient,
        followUpClient: followUpClient,
        shareClient: shareClient,
        accountID: currentSession?.profile.id,
        voiceID: memorySettingsModel?.settings?.voiceID
      )
      .transition(.opacity)
    } else {
      unavailable
    }
  }

  private var connectedApps: [NativeConnector] {
    (connectorModel?.linked ?? []).filter(\.connected)
  }

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
          startConversation: startProjectlessCodeConversation,
          pullsClient: pullsClient,
          accountID: currentSession?.profile.id,
          openConnections: { selection = .connections },
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
        JunoMobileWorkHubView(
          model: workModel,
          requestSender: requestSender,
          accountID: currentSession?.profile.id
        )
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
          requestSender: requestSender
        )
      } else {
        unavailable
      }
    }
  }

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

  private func startProjectlessCodeConversation(_ prompt: String) async {
    guard let conversationModel else { return }
    guard
      let id = await conversationModel.createConversationResolvingID(
        title: String(prompt.prefix(60)),
        model: memorySettingsModel?.settings?.defaultModel,
        kind: "code"
      )
    else { return }
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

private struct JunoMobileSidebarDrawer: View {
  @Binding var selection: JunoMobileSection
  let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
  let projectModel: NativeProjectModel<SQLiteAccountRepository>?
  let workModel: NativeWorkModel?
  let codeModel: NativeCodeModel?
  let session: NativeAuthenticatedSession
  var avatarData: Data?
  var canCreateChat: Bool = true
  let openDestination: (JunoMobileSection) -> Void
  let openConversation: (String) -> Void
  var openProject: (String) -> Void = { _ in }
  let openRecent: (JunoRecentItem) -> Void
  let newChat: () -> Void

  @State private var renameTarget: NativeConversation?
  @State private var renameValue = ""
  @State private var deleteTarget: NativeConversation?
  @State private var renameProjectTarget: NativeProject?
  @State private var renameProjectValue = ""
  @State private var deleteProjectTarget: NativeProject?

  private var pinnedProjects: [NativeProject] {
    (projectModel?.projects ?? [])
      .filter(\.starred)
      .sorted { $0.updatedAt > $1.updatedAt }
  }

  private var pinnedChats: [NativeConversation] {
    (conversationModel?.conversations ?? [])
      .filter { $0.pinned && !$0.isArchived }
  }

  private var recents: [NativeConversation] {
    (conversationModel?.conversations ?? [])
      .filter { !$0.pinned && !$0.isArchived }
      .sorted { $0.lastMessageAt > $1.lastMessageAt }
      .prefix(30)
      .map { $0 }
  }

  private var attentionItems: [JunoRecentItem] {
    var sources: [[JunoRecentItem]] = []
    if let workModel {
      sources.append(
        workModel.sessionsNeedingAttention
          .filter { !$0.archived }
          .map(\.junoRecentItem)
      )
    }
    if let codeModel {
      sources.append(
        codeModel.tasks
          .filter { $0.status == .awaitingApproval || $0.status == .failed }
          .map(\.junoRecentItem)
      )
    }
    return JunoRecentActivity.attentionItems(
      from: JunoRecentActivity.merge(sources, limit: 20),
      limit: 6
    )
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 2) {
          ForEach(JunoMobileSection.drawerDestinations) { destination in
            JunoMobileSidebarRow(
              junoIcon: destination.junoIcon,
              title: destination.title,
              selected: selection == destination,
              action: { openDestination(destination) }
            )
          }

          if !attentionItems.isEmpty {
            attentionSummary
          }

          if !pinnedProjects.isEmpty || !pinnedChats.isEmpty {
            sectionLabel("sidebar.pinned")
            ForEach(pinnedProjects) { projectRow($0) }
            ForEach(pinnedChats) { conversationRow($0, pinned: true) }
          }

          if !recents.isEmpty {
            sectionLabel("sidebar.recents")
            ForEach(recents) { conversationRow($0, pinned: false) }
          }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 12)
      }
      .scrollIndicators(.hidden)

      bottomBar
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .accessibilityIdentifier("juno.mobile.sidebar")
    .alert(
      "Rename conversation",
      isPresented: Binding(
        get: { renameTarget != nil },
        set: { if !$0 { renameTarget = nil } }
      )
    ) {
      TextField("Title", text: $renameValue)
      Button("Cancel", role: .cancel) { renameTarget = nil }
        .contentShape(.rect)
      Button("Save") {
        guard let target = renameTarget else { return }
        renameTarget = nil
        Task { await conversationModel?.renameConversation(id: target.id, title: renameValue) }
      }
      .contentShape(.rect)
    }
    .confirmationDialog(
      deleteTarget.map { "Delete “\($0.title)”?" } ?? "",
      isPresented: Binding(
        get: { deleteTarget != nil },
        set: { if !$0 { deleteTarget = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        guard let target = deleteTarget else { return }
        deleteTarget = nil
        Task { await conversationModel?.deleteConversation(id: target.id) }
      }
      .contentShape(.rect)
      Button("Cancel", role: .cancel) { deleteTarget = nil }
        .contentShape(.rect)
    } message: {
      Text("chat.delete.warning")
    }
    .alert(
      "Rename project",
      isPresented: Binding(
        get: { renameProjectTarget != nil },
        set: { if !$0 { renameProjectTarget = nil } }
      )
    ) {
      TextField("Name", text: $renameProjectValue)
      Button("Cancel", role: .cancel) { renameProjectTarget = nil }
        .contentShape(.rect)
      Button("Save") {
        guard let target = renameProjectTarget else { return }
        renameProjectTarget = nil
        Task { await projectModel?.updateProject(id: target.id, name: renameProjectValue) }
      }
      .contentShape(.rect)
    }
    .confirmationDialog(
      deleteProjectTarget.map { "Delete “\($0.name)”?" } ?? "",
      isPresented: Binding(
        get: { deleteProjectTarget != nil },
        set: { if !$0 { deleteProjectTarget = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        guard let target = deleteProjectTarget else { return }
        deleteProjectTarget = nil
        Task { await projectModel?.deleteProject(id: target.id) }
      }
      .contentShape(.rect)
      Button("Cancel", role: .cancel) { deleteProjectTarget = nil }
        .contentShape(.rect)
    } message: {
      Text("Conversations are kept and unlinked; project files are removed.")
    }
  }

  private var attentionSummary: some View {
    Button {
      if let first = attentionItems.first { openRecent(first) }
    } label: {
      HStack(spacing: 10) {
        Circle()
          .fill(Color.junoCaution)
          .frame(width: 7, height: 7)
          .accessibilityHidden(true)

        VStack(alignment: .leading, spacing: 2) {
          Text("Needs attention")
            .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
          Text("\(attentionItems.count) item\(attentionItems.count == 1 ? "" : "s") waiting")
            .junoFont(size: 12, relativeTo: .caption)
            .junoSecondaryInk()
        }

        Spacer(minLength: 0)
        JunoIconView(.chevronRight, size: 12)
          .junoMetaInk()
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
          .fill(Color.junoSurface.opacity(0.72))
      )
      .overlay(
        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
          .strokeBorder(Color.junoHairline.opacity(0.65), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 10)
    .padding(.top, 12)
    .accessibilityIdentifier("juno.mobile.attention-summary")
    .accessibilityLabel(
      "Needs attention, \(attentionItems.count) item\(attentionItems.count == 1 ? "" : "s") waiting"
    )
    .frame(minWidth: 44, minHeight: 44)
    .contentShape(.rect)
  }

  private func conversationRow(
    _ conversation: NativeConversation, pinned: Bool
  ) -> some View {
    JunoMobileConversationRow(
      title: conversation.title,
      pinned: pinned,
      pending: conversation.isPending,
      action: { openConversation(conversation.id) }
    )
    .contextMenu {
      Button {
        renameValue = conversation.title
        renameTarget = conversation
      } label: {
        Label { Text("Rename") } icon: { JunoIconView(.pencil, size: 15) }
      }
      Button {
        Task {
          await conversationModel?.setPinned(
            id: conversation.id, pinned: !conversation.pinned
          )
        }
      } label: {
        Label { Text(conversation.pinned ? "Unpin" : "Pin") } icon: {
          JunoIconView(.pin, size: 15)
        }
      }
      Divider()
      Button(role: .destructive) {
        deleteTarget = conversation
      } label: {
        Label { Text("Delete") } icon: { JunoIconView(.trash, size: 15) }
      }
    }
    .disabled(conversation.isPending)
  }

  private func projectRow(_ project: NativeProject) -> some View {
    Button {
      openProject(project.id)
    } label: {
      HStack(spacing: 7) {
        JunoIconView(.projects, size: 14)
          .foregroundStyle(Color.junoAccent)
        Text(project.name)
          .junoFont(size: 16, relativeTo: .body)
          .foregroundStyle(.primary)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 0)
        if project.isPending {
          JunoIconView(.refresh, size: 12)
            .junoSecondaryInk()
        }
      }
      .padding(.horizontal, 10)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(JunoSidebarPressStyle())
    .contextMenu {
      Button {
        renameProjectValue = project.name
        renameProjectTarget = project
      } label: {
        Label { Text("Rename") } icon: { JunoIconView(.pencil, size: 15) }
      }
      Button {
        Task {
          await projectModel?.updateProject(
            id: project.id, starred: !project.starred
          )
        }
      } label: {
        Label { Text(project.starred ? "Unpin" : "Pin") } icon: {
          JunoIconView(.pin, size: 15)
        }
      }
      Divider()
      Button(role: .destructive) {
        deleteProjectTarget = project
      } label: {
        Label { Text("Delete") } icon: { JunoIconView(.trash, size: 15) }
      }
    }
    .disabled(project.isPending)
  }

  private var header: some View {
    HStack(spacing: 9) {
      JunoMark(size: 24)
      Text("Juno")
        .junoFont(size: 22, relativeTo: .body, weight: .semibold)
        .accessibilityAddTraits(.isHeader)
      Spacer(minLength: 0)
      Button(action: { openDestination(.search) }) {
        JunoIconView(.search, size: 18)
          .foregroundStyle(Color.junoSidebarForeground)
          .frame(width: 40, height: 40)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("navigation.search")
      .frame(minWidth: 44, minHeight: 44)
    }
    .padding(.horizontal, 16)
    .padding(.top, 6)
    .padding(.bottom, 10)
  }

  private func sectionLabel(_ key: LocalizedStringKey) -> some View {
    Text(key)
      .junoFont(size: 14, relativeTo: .body, weight: .semibold)
      .junoSecondaryInk()
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 10)
      .padding(.top, 12)
      .padding(.bottom, 4)
  }

  @ViewBuilder
  private var bottomBar: some View {
    if #available(iOS 26.0, *) {
      GlassEffectContainer(spacing: 10) {
        bottomBarControls
      }
    } else {
      bottomBarControls
    }
  }

  private var bottomBarControls: some View {
    HStack(spacing: 10) {
      profileButton
      Spacer(minLength: 0)
      newChatButton
    }
    .padding(.horizontal, 22)
    .padding(.top, 8)
    .padding(.bottom, 8)
  }

  private var profileName: String { session.profile.name ?? session.profile.email }

  private var profileButton: some View {
    Button(action: { openDestination(.settings) }) {
      JunoAvatar(
        imageData: avatarData,
        imageURL: session.profile.imageURL,
        name: profileName,
        size: 32
      )
      .padding(8)
      .modifier(JunoGlassCircle())
    }
    .buttonStyle(.plain)
    .frame(width: 48, height: 48)
    .accessibilityLabel("Open settings for \(profileName)")
    .accessibilityIdentifier("juno.mobile.sidebar-profile")
    .contentShape(.rect)
  }

  private var newChatButton: some View {
    Button(action: newChat) {
      HStack(spacing: 3) {
        JunoIconView(.new, size: 12)
        Text("navigation.chat")
          .junoFont(size: 12, relativeTo: .subheadline, weight: .semibold)
      }
      .padding(.horizontal, 1)
      .frame(minWidth: 46, minHeight: 24)
    }
    .buttonStyle(.plain)
    .foregroundStyle(Color.junoOnAccent)
    .junoAccentGlass(in: Capsule())
    .frame(height: 48)
    .disabled(!canCreateChat)
    .opacity(canCreateChat ? 1 : 0.5)
    .accessibilityLabel("chat.new")
    .accessibilityIdentifier("juno.mobile.sidebar-chat")
    .contentShape(.rect)
  }
}

private struct JunoMobileSidebarRow: View {
  let junoIcon: JunoIcon
  let title: LocalizedStringKey
  var selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        JunoIconView(junoIcon, size: 19)
          .frame(width: 24)
          .foregroundStyle(selected ? Color.junoForeground : Color.junoSidebarForeground)
        Text(title)
          .junoFont(size: 16, relativeTo: .body, weight: selected ? .semibold : .regular)
          .foregroundStyle(selected ? Color.junoForeground : Color.junoSidebarForeground)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 10)
      .frame(height: 44)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(selected ? Color.junoMuted : .clear)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(JunoSidebarPressStyle())
  }
}

private struct JunoMobileConversationRow: View {
  let title: String
  var pinned: Bool
  var pending: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 7) {
        if pinned {
          JunoIconView(.pin, size: 12)
            .foregroundStyle(Color.junoAccent)
        }
        Text(title)
          .junoFont(size: 16, relativeTo: .body)
          .foregroundStyle(.primary)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 0)
        if pending {
          JunoIconView(.refresh, size: 12)
            .junoSecondaryInk()
        }
      }
      .padding(.horizontal, 10)
      .frame(height: 40)
      .contentShape(Rectangle())
    }
    .buttonStyle(JunoSidebarPressStyle())
    .frame(minWidth: 44, minHeight: 44)
  }
}

private struct JunoMobileSignInView: View {
  let authModel: NativeAuthModel

  @State private var email = ""
  @State private var password = ""
  @FocusState private var focusedField: Field?

  private enum Field: Hashable { case email, password }

  private var isBusy: Bool { authModel.phase == .signingIn }
  private var canSubmitPassword: Bool {
    !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !password.isEmpty
      && !isBusy
  }

  private func submitPassword() {
    guard canSubmitPassword else { return }
    let submittedPassword = password
    password = ""
    Task { await authModel.signIn(email: email, password: submittedPassword) }
  }

  var body: some View {
    ScrollView {
      VStack(spacing: 18) {
        JunoMark(size: 44)
        Text("auth.welcome.title")
          .junoPageHeading()
        Text("auth.welcome.description")
          .junoSecondaryInk()
          .multilineTextAlignment(.center)
        if let error = authModel.lastErrorDescription {
          Text(error)
            .foregroundStyle(Color.junoDanger)
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("juno.mobile.auth-error")
        }
        if authModel.phase != .unavailable {
          credentialFields
          Button(action: submitPassword) {
            if isBusy {
              ProgressView()
                .controlSize(.small)
            } else {
              Text("auth.sign-in.password")
                .frame(maxWidth: .infinity)
            }
          }
          .buttonStyle(.borderedProminent)
          .disabled(!canSubmitPassword)
          .accessibilityIdentifier("juno.mobile.sign-in.password")
          .contentShape(.rect)

          Text("auth.divider.or")
            .junoCaption()
            .junoSecondaryInk()

          Button {
            Task { await authModel.signIn() }
          } label: {
            Text("auth.sign-in")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .disabled(isBusy)
          .accessibilityIdentifier("juno.mobile.sign-in")
          .contentShape(.rect)

          Text("auth.password.disclaimer")
            .junoCaption()
            .junoSecondaryInk()
            .multilineTextAlignment(.center)
        }
      }
      .padding(32)
    }
    .scrollBounceBehavior(.basedOnSize)
  }

  private var credentialFields: some View {
    VStack(spacing: 12) {
      TextField("auth.email.placeholder", text: $email)
        .textContentType(.username)
        .keyboardType(.emailAddress)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused($focusedField, equals: .email)
        .onSubmit { focusedField = .password }
        .accessibilityIdentifier("juno.mobile.email")
      SecureField("auth.password.label", text: $password)
        .textContentType(.password)
        .focused($focusedField, equals: .password)
        .onSubmit(submitPassword)
        .accessibilityIdentifier("juno.mobile.password")
    }
    .textFieldStyle(.roundedBorder)
    .disabled(isBusy)
  }
}

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

private struct JunoMenuGlyph: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 5.5) {
      Capsule().fill(Color.primary).frame(width: 20, height: 2.5)
      Capsule().fill(Color.primary).frame(width: 13, height: 2.5)
    }
    .frame(width: 24, height: 24, alignment: .center)
  }
}