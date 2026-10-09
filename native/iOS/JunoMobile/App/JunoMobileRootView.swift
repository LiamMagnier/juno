import CoreSpotlight
import JunoAPI
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
  /// Lent to the agents model, so an agent's page answers its tasks'
  /// approvals and questions in place. Nil keeps that page read-only about
  /// them, which is what the preview harness gets.
  var workClient: NativeWorkClient?
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
  /// The conversation history sheet on iPhone. On iPad the same list is the
  /// Chat tab's own sidebar column and this is never set.
  @State private var showingHistory = false
  /// Workspace destinations pushed on the Chat tab's stack on iPhone —
  /// Projects, Library, Artifacts, Tasks, Connections. On iPad they are tabs
  /// in the sidebar and this stays empty.
  @State private var chatPath: [JunoMobileSection] = []
  @State private var showingSettings = false
  #if DEBUG
    /// The report reader, opened by `--juno-preview-report`.
    @State private var previewReport: JunoMobileReportRoute?
  #endif
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
  /// Asked before a private chat with turns in it is thrown away.
  @State private var confirmingEndPrivate = false
  /// The drawer's Research row: a new chat with deep research armed.
  @State private var pendingResearch = false
  /// The iPad split's columns. Collapsing the sidebar is a reading choice the
  /// shell respects until the reader opens it again.
  @State private var padColumns: NavigationSplitViewVisibility = .all
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
  /// What Alevr made, for the Library's "Made by Alevr" (`/api/library/made`).
  @State private var libraryMadeModel: NativeLibraryMadeModel?
  /// The account's agents (docs/design/AGENTS.md). Built at sign-in over the
  /// same bearer transport as everything else here, and held by the shell
  /// rather than the screen so the roster survives leaving it and the store
  /// can be stopped — and emptied — at sign-out like every other account model.
  @State private var agentsModel: NativeAgentsModel?
  /// The agent whose page is open, held here so a notification or a thread's
  /// header can open one from outside the Agents screen.
  @State private var selectedAgentID: String?
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
    .modifier(previewReportSheet)
    .preferredColorScheme(preferredColorScheme)
    // The plans page, wherever a locked feature or Settings asks for it.
    .junoMobilePlansSheet()
    // Inbox, announcements, server search, account security, Skills and
    // Routines: one environment value the newer screens read
    // (JunoMobileFeatureHub.swift).
    .junoMobileFeatures(sender: requestSender, accountID: currentSession?.profile.id)
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
        if let previewSession {
          // Orbit reads its roster from the canned server like every other
          // section; without a model the harness drew "Something went wrong".
          if agentsModel == nil, let requestSender {
            let agents = NativeAgentsModel(
              client: NativeAgentsClient(sender: requestSender), workClient: workClient)
            agentsModel = agents
            Task { await agents.start(for: previewSession.profile.id) }
          }
          await applyPreviewLaunchFlags()
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
        case "sidebar": showingHistory = true
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
        // Research runs are background jobs: notice the ones that finish
        // while the phone is elsewhere, or finished while the app was closed.
        JunoMobileResearchNotifications.shared.attach(conversationModel)
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
        // Held in a local so the model that is started is the one that was
        // stored, whether it was just made or survived an earlier sign-in.
        let agents =
          agentsModel
          ?? requestSender.map {
            NativeAgentsModel(client: NativeAgentsClient(sender: $0), workClient: workClient)
          }
        agentsModel = agents
        if let agents {
          Task { await agents.start(for: session.profile.id) }
        }
        libraryModel?.start(for: session.profile.id)
        documentIndex.start(for: session.profile.id)
        // Pushes follow the account: the token the delegate was handed goes
        // to the server now. Quiet delivery is taken without a prompt; the
        // question about banners waits for a moment that explains it.
        if let requestSender {
          // The plan the gates read, and the server that confirms an App
          // Store purchase for this account.
          let accountID = session.profile.id
          Task { await JunoMobilePlanStore.shared.refresh(sender: requestSender, accountID: accountID) }
          Task {
            await JunoStoreKitManager.shared.setBackendSyncHandler(
              JunoMobileAppStoreSync.handler(sender: requestSender, accountID: accountID)
            )
          }
          NativePushRegistrar.shared.start(for: session.profile.id, sender: requestSender)
          Task { await NativePushRegistrar.shared.requestQuietAuthorizationIfUndetermined() }
        }
        #if DEBUG
          if pendingVoiceLaunch {
            pendingVoiceLaunch = false
            startVoice()
          }
        #endif
      } else {
        JunoMobileResearchNotifications.shared.attach(nil)
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
        // An agent's brief, goals and memory belong to the account that
        // hired it; nothing of them may be on screen for whoever signs in next.
        agentsModel?.stop()
        selectedAgentID = nil
        // The server has already retired this session's tokens; this only
        // forgets the account so the next sign-in registers afresh.
        NativePushRegistrar.shared.stop()
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
      JunoMobileQuietLoading(.blank)
    case .signedOut, .signingIn, .unavailable:
      JunoMobileSignInView(authModel: authModel)
    }
  }

  /// The shell: one tab bar carrying the three products and search.
  ///
  /// Chat, Crew and Code are the top-level destinations — the same three
  /// the Mac's product switcher and the website's sidebar carry. Everything
  /// else is nested: the workspace surfaces (Projects, Library, Artifacts,
  /// Tasks, Connections) sit in sections that `.sidebarAdaptable` shows in the
  /// iPad sidebar and hides from the iPhone tab bar, where they are reached from
  /// the history sheet and pushed on the Chat stack. Settings stays a sheet.
  ///
  /// This replaced a hand-built reveal drawer. Beyond the ten destinations it
  /// listed behind a hamburger, the drawer sized itself from
  /// `UIScreen.main.bounds` and clamped at 340pt, so in a 320pt Slide Over it
  /// drew a drawer wider than the window holding it. The system tab bar is
  /// Liquid Glass, minimises on scroll so a long transcript reads edge to edge,
  /// and carries the one persistent status the products share — a run in
  /// progress — as its bottom accessory.
  @ViewBuilder
  private func authenticatedContent(
    session: NativeAuthenticatedSession
  ) -> some View {
    Group {
      if sizeClass == .compact {
        phoneShell(session: session)
      } else {
        padShell(session: session)
      }
    }
    // Moving between a compact and a regular window (Slide Over, Stage
    // Manager, rotating a split) re-homes the destination the other shape
    // cannot show: a workspace surface is a push on the phone's Chat stack
    // and a sidebar row on the iPad.
    .task(id: sizeClass) {
      if sizeClass == .compact {
        if selection != .chat && selection != .code { show(selection) }
      } else if let pushed = chatPath.last {
        chatPath = []
        selection = pushed
      }
    }
    .focusedSceneValue(\.junoShellActions, shellActions)
    .tint(Color.junoAccent)
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
    .onOpenURL { url in
      if let request = JunoMobileLaunchRequests.request(for: url) {
        launchRequests.request(request)
      }
    }
  }

  #if DEBUG
    /// The harness's launch flags, applied once the shell is up. Its own
    /// function so the root body stays within the type checker's budget.
    private func applyPreviewLaunchFlags() async {
          if let raw = JunoPreviewEnvironment.initialDestination,
            let section = JunoMobileSection(rawValue: raw)
          {
            show(section)
          }
          if CommandLine.arguments.contains("--juno-preview-sidebar") {
            showingHistory = true
          }
          if CommandLine.arguments.contains("--juno-preview-settings")
            || ["profile", "username"].contains(JunoPreviewEnvironment.initialRoute ?? "")
          {
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
          // `--juno-preview-conversation <id>` opens one chat; the fixture
          // rows land a beat after launch, so wait for the row first.
          if let id = JunoPreviewEnvironment.initialConversation {
            for _ in 0..<30 where conversationModel?.conversations.contains(where: { $0.id == id }) != true {
              try? await Task.sleep(for: .milliseconds(100))
            }
            openConversation(id)
          }
          // `--juno-preview-notification research` takes the path a tapped
          // "Your research is ready" notification takes: the run's chat, then
          // its report over it.
          if JunoComposerPreviewFlags.value("--juno-preview-notification") == "research" {
            try? await Task.sleep(for: .milliseconds(1_200))
            launchRequests.request(.openResearch("rr_sc_done"))
          }
          // `--juno-preview-report` opens the research report reader over
          // the home, on the harness's finished heat-pump run.
          if CommandLine.arguments.contains("--juno-preview-report") {
            previewReport = NativeResearchReport(
              message: PreviewResearch.reportMessage(),
              question: PreviewResearch.question
            ).map(JunoMobileReportRoute.init(report:))
          }
          if CommandLine.arguments.contains("--juno-preview-voice")
            || JunoPreviewEnvironment.opensVoiceFullScreen
          {
            startVoice()
            if JunoPreviewEnvironment.opensVoiceFullScreen {
              voiceSession?.isFullScreen = true
            }
          }
    }
  #endif

  /// The report reader `--juno-preview-report` opens; inert in Release.
  private var previewReportSheet: JunoMobilePreviewReportSheet {
    #if DEBUG
      JunoMobilePreviewReportSheet(route: $previewReport)
    #else
      JunoMobilePreviewReportSheet()
    #endif
  }

  /// The phone's shell: the conversation, with the sidebar pushed out from
  /// under it (see ``JunoMobilePushDrawer``).
  ///
  /// This replaced a four-tab bar — Chat, Crew, Code, Search, each with a red
  /// count — and a "runs in progress" capsule over it. Nothing those reached
  /// is gone: Chat and Code are the two roots, switched from the centre of the
  /// top bar; every other destination is a row in the drawer and pushes on the
  /// one stack; what needs the reader is said in plain words on its row.
  private func phoneShell(session: NativeAuthenticatedSession) -> some View {
    JunoMobilePushDrawer(
      isOpen: $showingHistory,
      edgeSwipeEnabled: chatPath.isEmpty
    ) {
      historyList(session: session)
        .background(JunoMobileDrawerGround().ignoresSafeArea())
    } content: {
      phoneStack(session: session)
    }
    .confirmationDialog(
      "End this private chat?",
      isPresented: $confirmingEndPrivate,
      titleVisibility: .visible
    ) {
      Button("End chat", role: .destructive) { endIncognito() }
        .contentShape(.rect)
      Button("Keep chatting", role: .cancel) {}
        .contentShape(.rect)
    } message: {
      Text("It was never saved, so closing it is the only copy gone.")
    }
  }

  /// The iPad's shell: the Mac's sidebar and one detail column.
  ///
  /// This replaced a sidebar-adaptable `TabView` whose Chat tab held a second
  /// split of its own. The result was two navigation systems on one screen, a
  /// floating tab strip over a conversation list over a transcript, and the
  /// phone's drawer (a two-column tile grid, a coral compose disc, a card for
  /// what needs attention) stretched into a sidebar. One `NavigationSplitView`
  /// is what Notes, Things and the Mac build of Juno all are: the system
  /// draws the sidebar's glass, the toggle, the drag-to-resize and the
  /// collapse to an overlay in a narrow window.
  private func padShell(session: NativeAuthenticatedSession) -> some View {
    NavigationSplitView(columnVisibility: $padColumns) {
      historyList(session: session, layout: .sidebar)
        // The Mac's warm sidebar ground, opaque. Left to the column's glass
        // it sampled whatever the detail drew under it: a cool grey beside
        // the warm canvas, and a muddy one beside the incognito ink.
        .background(.regularMaterial)
        .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 360)
    } detail: {
      NavigationStack {
        destinationRoot(selection)
          .junoScreenCanvas()
          .toolbar { padDetailToolbar }
      }
      // A new root per destination, so a stack pushed inside Projects is not
      // still there, half-remembered, the next time Code is opened.
      .id(selection)
    }
    .navigationSplitViewStyle(.balanced)
  }

  /// With the sidebar tucked away, New chat stays one tap from anywhere,
  /// beside the system's own sidebar button, as Notes keeps its compose.
  @ToolbarContentBuilder
  private var padDetailToolbar: some ToolbarContent {
    if padColumns == .detailOnly, conversationModel != nil {
      ToolbarItem(placement: .topBarLeading) {
        Button(action: startNewChat) {
          JunoIconView(.compose, size: 17)
            .foregroundStyle(Color.primary)
        }
        .accessibilityLabel("chat.new")
        .accessibilityIdentifier("juno.mobile.detail-new-chat")
      }
    }
  }

  /// What the keyboard and the menu bar can reach. See ``JunoMobileCommands``.
  private var shellActions: JunoMobileShellActions {
    JunoMobileShellActions(
      newChat: {
        if incognito { endIncognito() }
        startNewChat()
      },
      newIncognitoChat: privateChatModel == nil
        ? nil
        : {
          startNewChat()
          setIncognito(true)
        },
      search: { openSidebarDestination(.search) },
      settings: { show(.settings) },
      show: { openSidebarDestination($0) }
    )
  }

  /// Plain-text status for the iPad sidebar's product rows.
  private var sidebarStatuses: [JunoMobileSection: JunoMobileSidebarStatus] {
    let workRunning = (workModel?.sessions ?? []).filter { session in
      !session.archived && (workModel?.isRunning(session) ?? false)
    }.count
    let codeRunning = (codeModel?.tasks ?? []).filter {
      $0.status == .running || $0.status == .queued
    }.count
    return [
      .code: JunoMobileSidebarStatus(running: codeRunning, needsYou: codeAttentionCount),
      .work: JunoMobileSidebarStatus(running: workRunning, needsYou: workAttentionCount),
    ]
  }

  /// Acts on one launch request once the shell can — a request that arrives
  /// before sign-in waits for it.
  private func handleLaunchRequest(_ request: JunoMobileLaunchRequests.Request) {
    guard currentSession != nil else { return }
    launchRequests.pending = nil
    showingHistory = false
    switch request {
    case .newChat:
      showingSettings = false
      startNewChat()
    case .voice:
      showingSettings = false
      // The call opens in the composer, as every call does now; full
      // screen is one tap away in the call's settings.
      startVoice()
    case .dictate:
      showingSettings = false
      startNewChat()
      pendingDictation = true
    case .code:
      showingSettings = false
      show(.code)
    case .ask(let prompt):
      showingSettings = false
      startNewChat()
      pendingAskPrompt = prompt
    case .openConversation(let id):
      showingSettings = false
      // Through the refresh-first path: a pushed conversation can be one this
      // phone has not synced yet, such as an agent's thread the server has
      // just made.
      openAgentThread(id)
    case .openAgent(let id):
      showingSettings = false
      openAgent(id)
    case .openWorkSession(let id):
      showingSettings = false
      openWorkSession(id)
    case .openResearch(let runID):
      showingSettings = false
      // "Your research is ready": the run's chat, with its report open over
      // it (the conversation presents it once it is on screen).
      launchRequests.pendingReportRunID = runID
      Task {
        guard let conversationID = await conversationModel?.researchConversationID(runID: runID) else {
          launchRequests.pendingReportRunID = nil
          return
        }
        openAgentThread(conversationID)
      }
    case .openRemoteSession(let deviceID, let sessionID):
      showingSettings = false
      show(.code)
      remoteCodeModel?.selectedDeviceID = deviceID
      remoteCodeModel?.openSession(sessionID)
    case let .respondToRemoteApproval(deviceID, sessionID, requestID, approved):
      showingSettings = false
      show(.code)
      remoteCodeModel?.selectedDeviceID = deviceID
      remoteCodeModel?.openSession(sessionID)
      Task {
        await remoteCodeModel?.respondToApproval(
          deviceID: deviceID, sessionID: sessionID, requestID: requestID, approved: approved
        )
        JunoMobileLiveActivityCoordinator.shared.resolveApproval(requestID: requestID)
      }
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
    // Voice is Pro and up: a plan without it gets the plans page instead.
    guard JunoMobilePlanStore.shared.require(.voice) else { return }
    guard voiceSession == nil,
      let requestSender,
      let session = currentSession
    else { return }
    let started = JunoMobileVoiceSession(
      controller: JunoRealtimeVoiceController(
        authorization: JunoMobileVoiceAuthorization(
          sender: requestSender,
          accountID: session.profile.id,
          // The open chat, so a call in an agent's thread is had with that
          // agent. Never an incognito one: nothing about it may reach the
          // server's context for the call.
          conversationID: incognito ? nil : conversationModel?.selectedConversationID
        )
      ),
      accountID: session.profile.id,
      attachmentContextClient: voiceAttachmentContextClient,
      saveTranscript: voiceSaveAction,
      close: {
        JunoMobileLiveActivityCoordinator.shared.endVoice()
        voiceSession = nil
      }
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
        // `--juno-preview-voice-state listening|speaking|thinking|muted`
        // holds the call in one phase for a screenshot.
        let arguments = CommandLine.arguments
        let state = arguments.firstIndex(of: "--juno-preview-voice-state")
          .flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? "speaking"
        var lines: [(role: JunoVoiceTranscriptRole, text: String)] = [
          (role: .user, text: "What's the quickest way to check the sync monitor's reconnect path?"),
          (role: .assistant, text: "Run the JunoSync tests with the reconnect filter. I can kick that off on your Mac if you like."),
        ]
        // Thinking is your last line heard in full with nothing back yet.
        if state == "thinking" || state == "speaking" {
          lines.append((role: .user, text: "Yes, do that, and tell me if anything fails."))
        }
        started.controller.beginPreviewSession(lines: lines, assistantSpeaking: state == "speaking")
        if state == "muted" { started.controller.setMuted(true) }
        return
      }
    #endif
    JunoMobileLiveActivityCoordinator.shared.beginVoice()
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

  // MARK: Chat tab

  /// The phone's one stack. Its root is Chat (the conversation, the draft or
  /// the private chat) or Code, chosen from the bar's centre; every drawer
  /// destination pushes on it, so the system back swipe is the way out.
  private func phoneStack(session: NativeAuthenticatedSession) -> some View {
    NavigationStack(path: $chatPath) {
      phoneRoot
        .toolbar { phoneToolbar }
        .navigationDestination(for: JunoMobileSection.self) { destination in
          destinationRoot(destination)
            .junoScreenCanvas()
        }
        .junoScreenCanvas()
    }
    .tint(Color.junoAccent)
  }

  @ViewBuilder
  private var phoneRoot: some View {
    if selection == .code {
      destinationRoot(.code)
        .transition(.opacity)
    } else {
      chatDestination
    }
  }

  /// Whether the bar is showing a home — a new chat, a private chat or Code —
  /// rather than a conversation, which titles the bar itself.
  private var phoneShowsHome: Bool {
    selection == .code || incognito || conversationModel?.selectedConversationID == nil
  }

  /// The ChatGPT bar: the sidebar mark, Chat | Code, the private-chat toggle.
  /// Three glass elements and nothing else — the OS 26 toolbar draws each
  /// item's Liquid Glass itself, so none of these carries its own.
  @ToolbarContentBuilder
  private var phoneToolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      Button {
        withAnimation(JunoMotion.reduced(JunoMotion.drawerSettle, when: reduceMotion)) {
          showingHistory = true
        }
      } label: {
        JunoMobileSidebarGlyph()
          .foregroundStyle(Color.primary)
      }
      .accessibilityLabel("Open sidebar")
      .accessibilityIdentifier("juno.mobile.menu")
    }
    if phoneShowsHome {
      ToolbarItem(placement: .principal) {
        JunoMobileProductSwitch(selection: productSelection)
      }
    }
    if phoneShowsHome, selection != .code, privateChatModel != nil {
      ToolbarItem(placement: .topBarTrailing) {
        Button(action: togglePrivateChat) {
          JunoMobileTemporaryChatGlyph(active: incognito)
            .foregroundStyle(Color.primary)
        }
        .accessibilityLabel(incognito ? "End private chat" : "Start a private chat")
        .accessibilityValue(incognito ? "On" : "Off")
        .accessibilityIdentifier(incognito ? "juno.mobile.incognito" : "juno.mobile.incognito-start")
      }
    }
  }

  /// Chat | Code. Choosing a product leaves a private chat (it was never
  /// saved, and it does not exist in Code) and resets the stack.
  private var productSelection: Binding<JunoMobileSection> {
    Binding(
      get: { selection == .code ? .code : .chat },
      set: { product in
        if product == .code, incognito {
          if privateChatModel?.isEmpty == false {
            confirmingEndPrivate = true
            return
          }
          endIncognito()
        }
        withAnimation(JunoMotion.reduced(JunoMotion.chatLayout, when: reduceMotion)) {
          chatPath = []
          selection = product
        }
      }
    )
  }

  private func togglePrivateChat() {
    if incognito {
      if privateChatModel?.isEmpty == false {
        confirmingEndPrivate = true
      } else {
        endIncognito()
      }
    } else {
      conversationModel?.selectedConversationID = nil
      setIncognito(true)
    }
  }

  /// Every product but Chat: one stack, its own root.
  private func productStack(_ destination: JunoMobileSection) -> some View {
    NavigationStack {
      destinationRoot(destination)
        .junoScreenCanvas()
    }
    .tint(Color.junoAccent)
  }

  private func historyList(
    session: NativeAuthenticatedSession,
    layout: JunoMobileSidebarDrawer.Layout = .drawer
  ) -> some View {
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
      newChat: {
        if incognito { endIncognito() }
        startNewChat()
      },
      shareConversation: shareAction,
      layout: layout,
      isDrafting: !incognito && conversationModel?.selectedConversationID == nil,
      statuses: sidebarStatuses,
      incognito: incognito,
      startResearch: layout == .drawer ? researchAction : nil
    )
  }

  /// The drawer's Research row. A typed property for the reason the voice
  /// and memory actions are: an inline closure-or-nil in that initializer is
  /// more than the type checker will solve.
  private var researchAction: (() -> Void)? {
    {
      if incognito { endIncognito() }
      startNewChat()
      pendingResearch = true
    }
  }

  // MARK: Attention

  private var workAttentionCount: Int {
    (workModel?.sessionsNeedingAttention ?? []).filter { !$0.archived }.count
  }

  private var codeAttentionCount: Int {
    (codeModel?.tasks ?? []).filter { $0.status == .awaitingApproval }.count
  }

  /// Enters or leaves incognito.
  ///
  /// One animation for the whole mode change, applied here rather than at either
  /// face: the two are siblings in the same `Group`, so animating the flag is what
  /// crossfades them.
  private func setIncognito(_ on: Bool) {
    if reduceMotion {
      incognito = on
    } else {
      withAnimation(JunoMotion.standard) { incognito = on }
    }
  }

  /// Leaves incognito and forgets the session, as navigating away does.
  private func endIncognito() {
    privateChatModel?.reset()
    setIncognito(false)
  }

  /// Publishes a conversation from the list and hands the link to the
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

  /// Routes a destination the way the shell is shaped: products select a tab,
  /// workspace surfaces push on the Chat stack on iPhone and select their
  /// sidebar tab on iPad, Settings presents.
  private func show(_ destination: JunoMobileSection) {
    if showingHistory {
      withAnimation(JunoMotion.reduced(JunoMotion.drawerSettle, when: reduceMotion)) {
        showingHistory = false
      }
    }
    switch destination {
    case .settings:
      showingSettings = true
    case .chat, .code:
      if sizeClass == .compact { chatPath = [] }
      selection = destination
    case .projects, .library, .artifacts, .agents, .tasks, .connections, .work, .search:
      // On the phone every destination but the two products pushes on the
      // one stack, over whichever product is showing.
      if sizeClass == .compact {
        if selection != .chat && selection != .code { selection = .chat }
        if chatPath.last != destination { chatPath = [destination] }
      } else {
        selection = destination
      }
    }
  }

  /// A destination reached from inside another (Artifacts from Library, Work
  /// from Code): pushed on top, so Back returns to where it was opened.
  private func pushDestination(_ destination: JunoMobileSection) {
    guard sizeClass == .compact else { return openSidebarDestination(destination) }
    if chatPath.last != destination { chatPath.append(destination) }
  }

  private func openSidebarProject(_ id: String) {
    projectModel?.selectedProjectID = id
    show(.projects)
  }

  private func openSidebarDestination(_ destination: JunoMobileSection) {
    // Navigating away ends it. Leaving the mode armed behind another section
    // means coming back to Chat later and typing into a session the reader has
    // forgotten is incognito — or worse, assuming one is.
    if destination != .chat, incognito {
      privateChatModel?.reset()
      incognito = false
    }
    if destination != .chat, destination != .settings {
      conversationModel?.selectedConversationID = nil
    }
    // Agents from the sidebar is the roster, not whichever page was last
    // opened from a notification.
    if destination == .agents { selectedAgentID = nil }
    show(destination)
  }

  private func openSidebarConversation(_ id: String) {
    // Opening a saved chat from the iPad sidebar leaves incognito behind, as
    // choosing any other destination does.
    if incognito {
      privateChatModel?.reset()
      incognito = false
    }
    conversationModel?.isDraftingNewConversation = false
    conversationModel?.selectedConversationID = id
    chatPath = []
    show(.chat)
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
      show(.work)
    case .code:
      guard let task = codeModel?.tasks.first(where: { $0.id == item.sourceID }) else { return }
      codeModel?.open(task)
      show(.code)
    case .project:
      show(.projects)
    }
  }

  /// New chat opens a *draft*: an empty composer under the greeting, with no
  /// row in the list. The conversation is created by the first send — see
  /// `NativeConversationModel.createConversationResolvingID`.
  private func startNewChat() {
    conversationModel?.isDraftingNewConversation = true
    conversationModel?.selectedConversationID = nil
    chatPath = []
    show(.chat)
  }

  // MARK: Detail

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
        openPlugins: { show(.connections) },
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
        pendingPrompt: $pendingAskPrompt,
        startDictation: $pendingDictation,
        startResearch: $pendingResearch,
        agentsModel: agentsModel,
        openAgent: openAgent,
        openOrbit: { openSidebarDestination(.agents) }
      )
      .transition(.opacity)
    } else {
      unavailable
    }
  }

  private var connectedApps: [NativeConnector] {
    (connectorModel?.linked ?? []).filter(\.connected)
  }

  /// Agents, extracted from `destinationRoot` for the reason `chatDestination`
  /// is: every argument added to that switch is one more thing the type
  /// checker has to solve in a single expression.
  @ViewBuilder
  private var agentsDestination: some View {
    if !JunoMobilePlanStore.shared.allows(.agents) {
      JunoMobilePlanLockedView(feature: .agents, title: "Agents", icon: .agents)
    } else if let agentsModel {
      NativeAgentsScreen(
        model: agentsModel,
        apps: agentApps,
        selectedAgentID: $selectedAgentID,
        openConversation: openAgentThread
      )
      // The moment to ask about banners: an agent has just joined, and it is
      // the one who will need them. The roster growing while it is on screen
      // is that moment, whether the hire was made here or arrived with the
      // poll. Asked once; the system never shows the question twice.
      .onChange(of: agentsModel.agents.count) { old, new in
        guard new > old else { return }
        askForBannersAfterHire()
      }
    } else {
      unavailable
    }
  }

  private func askForBannersAfterHire() {
    #if DEBUG
      // No prompt over the preview harness's screenshots.
      if previewSession != nil { return }
    #endif
    Task { await NativePushRegistrar.shared.requestFullAuthorization() }
  }

  /// The apps an agent may be given: only the connected ones, by name.
  private var agentApps: [NativeAgentAppChoice] {
    connectedApps.map { NativeAgentAppChoice(id: $0.id, label: $0.label) }
  }

  /// Opens an agent's thread from its page.
  ///
  /// The server creates the thread on first use, so it can be a conversation
  /// this phone has never synced — and selecting an id the local store does
  /// not know is undone by the store's next reload. So the store is brought
  /// up to date first, exactly as a saved voice call is, and only then is the
  /// conversation opened.
  private func openAgentThread(_ id: String) {
    Task {
      if conversationModel?.conversations.contains(where: { $0.id == id }) != true {
        await syncModel?.refresh()
        await conversationModel?.reload()
      }
      conversationModel?.isDraftingNewConversation = false
      openConversation(id)
    }
  }

  /// Opens an agent's page from outside the Agents screen: a notification, a
  /// link, or the header of its thread.
  private func openAgent(_ id: String) {
    selectedAgentID = id
    show(.agents)
  }

  /// Opens a Work task's thread from a notification or a link.
  ///
  /// The task can be newer than the last poll, so the list is brought up to
  /// date first. `start` rather than `refresh`: on a cold launch from a tap
  /// this runs before sign-in's own start has reached the model, and `start`
  /// for the account it already follows is a refresh.
  private func openWorkSession(_ id: String) {
    show(.work)
    guard let workModel, let accountID = currentSession?.profile.id else { return }
    Task {
      if !workModel.sessions.contains(where: { $0.sessionID == id }) {
        await workModel.start(for: accountID)
      }
      guard let summary = workModel.sessions.first(where: { $0.sessionID == id }) else { return }
      workModel.open(summary)
    }
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
            show(.projects)
          },
          openServerHit: openSearchHit
        )
      } else {
        unavailable
      }
    case .code:
      if !JunoMobilePlanStore.shared.allows(.code) {
        JunoMobilePlanLockedView(feature: .code, title: "Code", icon: .code)
      } else if let codeModel {
        JunoMobileCodeView(
          model: codeModel,
          remoteModel: remoteCodeModel,
          notifications: previewNotifications,
          startConversation: startProjectlessCodeConversation,
          pullsClient: pullsClient,
          accountID: currentSession?.profile.id,
          openConnections: { show(.connections) },
          // Code gets the account the same way the website's Code mode
          // does — the user menu stays in the sidebar there, so plan
          // and usage are never more than a glance away.
          session: currentSession,
          avatarData: avatarModel?.imageData,
          requestSender: requestSender,
          modelCatalog: conversationModel?.modelCatalog ?? [],
          openSettings: { openSidebarDestination(.settings) },
          // Work sessions are reached from Code on the phone (the drawer
          // folds them in — see `JunoMobileSection.foldedDestinations`).
          openWork: { pushDestination(.work) }
        )
      } else {
        unavailable
      }
    case .work:
      if !JunoMobilePlanStore.shared.allows(.agents) {
        JunoMobilePlanLockedView(feature: .agents, title: "Work", icon: .work)
      } else if let workModel {
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
    case .agents:
      agentsDestination
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
          openConversation: openConversation,
          madeModel: madeModel(),
          artifactModel: artifactModel,
          workClient: workClient,
          openArtifacts: { pushDestination(.artifacts) }
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

  /// The Library's made list, built once per signed-in account.
  private func madeModel() -> NativeLibraryMadeModel? {
    guard let requestSender, let accountID = currentSession?.profile.id else { return nil }
    if let libraryMadeModel {
      libraryMadeModel.start(for: accountID)
      return libraryMadeModel
    }
    let model = NativeLibraryMadeModel(client: NativeLibraryMadeClient(sender: requestSender), accountID: accountID)
    Task { @MainActor in libraryMadeModel = model }
    return model
  }

  private var unavailable: some View {
    ContentUnavailableView {
      JunoIconLabel("shell.unavailable.title", icon: .error)
    } description: {
      Text("shell.unavailable.description")
    }
  }

  /// Where a server search hit (memory, knowledge, tasks) opens.
  private func openSearchHit(_ destination: NativeSearchHitDestination) {
    switch destination {
    case .conversation(let id, _): openConversation(id)
    case .workSession(let id): openWorkSession(id)
    case .project(let id):
      projectModel?.selectedProjectID = id
      show(.projects)
    case .artifact: show(.artifacts)
    case .library: show(.library)
    case .memory: show(.settings)
    }
  }

  private func openConversation(_ id: String) {
    conversationModel?.selectedConversationID = id
    chatPath = []
    show(.chat)
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
      chatPath = []
      show(.chat)
    case .project:
      projectModel?.selectedProjectID = result.entityID
      show(.projects)
    case .file:
      show(.library)
    case .artifact:
      artifactModel?.selectedArtifactID = result.entityID
      show(.artifacts)
    case .memory:
      showingSettings = true
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


/// The DEBUG harness's report reader, as a modifier so the root body stays
/// within the type checker's budget.
struct JunoMobilePreviewReportSheet: ViewModifier {
  var route: Binding<JunoMobileReportRoute?> = .constant(nil)

  func body(content: Content) -> some View {
    content.sheet(item: route) { route in
      JunoMobileResearchReportView(report: route.report, close: { self.route.wrappedValue = nil })
        .junoSheetSurface(.page)
        .tint(Color.junoAccent)
    }
  }
}
