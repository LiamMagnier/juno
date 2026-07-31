import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoVoiceKit
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
    let artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    let memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
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
    /// Backs the composer's "From your library".
    var libraryModel: NativeLibraryModel?
    /// The authenticated transport, used to mint a voice relay credential. See
    /// ``startVoice()`` for why the controller cannot be built at launch.
    var requestSender: (any NativeAuthenticatedRequestSending)?
    /// Backs Settings › Danger zone.
    var accountDataClient: NativeAccountDataClient?
    /// Files a finished voice call into chat history. See ``saveVoiceTranscript``.
    var voiceTranscriptClient: NativeVoiceTranscriptClient?
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
        switch memorySettingsModel?.settings?.theme {
        case .light: .light
        case .dark: .dark
        // Nil, not a guess: `nil` is what tells SwiftUI to follow the system.
        case .system, .none: nil
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
                    let section = JunoMobileSection(rawValue: raw) {
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
                let section = JunoMobileSection(rawValue: raw) {
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
                syncModel?.start(for: session.profile.id)
                Task { await conversationModel?.start(for: session.profile.id) }
                Task { await projectModel?.start(for: session.profile.id) }
                Task { await artifactModel?.start(for: session.profile.id) }
                Task { await memorySettingsModel?.start(for: session.profile.id) }
                searchModel?.start(for: session.profile.id)
                privateChatModel?.start(for: session.profile.id)
                attachmentModel?.start(for: session.profile.id)
                avatarModel?.start(for: session.profile)
                Task { await connectorModel?.start(for: session.profile.id) }
                Task { await scheduledTaskModel?.start(for: session.profile.id) }
                Task { await codeModel?.start(for: session.profile.id) }
                libraryModel?.start(for: session.profile.id)
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
                artifactModel?.stop()
                memorySettingsModel?.stop()
                searchModel?.stop()
                // Signing out must not leave an incognito transcript in memory.
                privateChatModel?.stop()
                incognito = false
                avatarModel?.clear()
                connectorModel?.stop()
                scheduledTaskModel?.stop()
                codeModel?.stop()
                libraryModel?.stop()
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
            Task { await artifactModel?.synchronizationDidAdvance(to: generation) }
            Task { await memorySettingsModel?.synchronizationDidAdvance(to: generation) }
            searchModel?.synchronizationDidAdvance(to: generation)
        }
        .onChange(of: syncModel?.phase) { _, _ in
            Task { await conversationModel?.reload() }
            Task { await projectModel?.reload() }
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
            saveTranscript: voiceSaveAction,
            close: { voiceSession = nil }
        )
        voiceSession = started
        // Chat is where the dock renders, so a call started from anywhere else —
        // today only the DEBUG launch flag — has to land there or it opens with
        // no surface to appear on.
        selection = .chat
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
                        conversationModel: conversationModel,
                        authModel: authModel,
                        session: currentSession,
                        avatarData: avatarModel?.imageData,
                        syncModel: syncModel,
                        outbox: outbox,
                        accountDataClient: accountDataClient,
                        requestSender: requestSender,
                        shareClient: shareClient
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
                    Button { showingSettings = false } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                            // Ink: closing a sheet is chrome, not emphasis.
                            .foregroundStyle(Color.primary)
                    }
                    .accessibilityLabel("Close settings")
                    .accessibilityIdentifier("juno.mobile.settings-close")
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .tint(Color.junoAccent)
    }

    // MARK: iPhone drawer

    /// The "reveal" interaction: the sidebar is a fixed layer *behind* the main
    /// window, and opening slides the whole chat plate to the right to uncover
    /// it — no panel slides over the chat, and there is no dimming veil. Depth
    /// comes from the plate's rounded corners, a soft shadow and a subtle scale.
    private func compactDrawer(session: NativeAuthenticatedSession) -> some View {
        let revealed = min(UIScreen.main.bounds.width * 0.80, 340)
        return ZStack(alignment: .leading) {
            JunoMobileSidebarDrawer(
                selection: $selection,
                conversationModel: conversationModel,
                session: session,
                avatarData: avatarModel?.imageData,
                canCreateChat: conversationModel != nil,
                openDestination: openSidebarDestination,
                openConversation: openSidebarConversation,
                newChat: startNewChat
            )
            .frame(width: revealed, alignment: .leading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(Color.junoCanvas.ignoresSafeArea())

            ZStack {
                Color(uiColor: .systemBackground)
                detail(for: selection)
                    .allowsHitTesting(!sidebarOpen)
            }
            // Closed: the drawer's open-swipe lives on a narrow strip along the
            // leading edge, exactly where iOS puts its own edge gestures.
            //
            // It used to be a `simultaneousGesture` on the whole plate, and that
            // is the "+ does nothing" report twice over. As an exclusive gesture
            // it took the button's touch outright; recognising simultaneously
            // fixed the *button* — but the "+" is a `Menu` now, and a menu's own
            // recognizer loses that race often enough to be caught by a test
            // that taps it three times. A gesture that only exists where it is
            // meant to be used cannot compete with a control at all.
            .overlay(alignment: .leading) {
                if !sidebarOpen {
                    Color.clear
                        .frame(width: 20)
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 18)
                                .onEnded { value in
                                    guard value.translation.width > 60 else { return }
                                    setSidebar(true)
                                }
                        )
                        .ignoresSafeArea()
                        .accessibilityHidden(true)
                }
            }
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
            .clipShape(RoundedRectangle(cornerRadius: sidebarOpen ? 52 : 0, style: .continuous))
            .ignoresSafeArea()
            .shadow(color: .black.opacity(sidebarOpen ? 0.22 : 0), radius: 22, x: -1)
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
            withAnimation(.snappy(duration: 0.28)) { incognito = on }
        }
    }

    private func setSidebar(_ open: Bool) {
        if reduceMotion { sidebarOpen = open }
        else { withAnimation(JunoMotion.emphasized) { sidebarOpen = open } }
    }

    // MARK: Sidebar

    @ViewBuilder
    private func sidebar(session: NativeAuthenticatedSession) -> some View {
        JunoMobileSidebarDrawer(
            selection: $selection,
            conversationModel: conversationModel,
            session: session,
            avatarData: avatarModel?.imageData,
            openDestination: openSidebarDestination,
            openConversation: openSidebarConversation,
            newChat: startNewChat
        )
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
            } else { unavailable }
        case .code:
            if let codeModel {
                JunoMobileCodeView(
                    model: codeModel,
                    startConversation: startProjectlessCodeConversation,
                    pullsClient: pullsClient,
                    accountID: currentSession?.profile.id,
                    openConnections: { selection = .connections }
                )
            } else { unavailable }
        case .tasks:
            if let scheduledTaskModel {
                JunoMobileTasksView(
                    model: scheduledTaskModel,
                    models: conversationModel?.modelCatalog ?? [],
                    openConversation: openConversation
                )
            } else { unavailable }
        case .connections:
            if let connectorModel {
                JunoMobileConnectionsView(model: connectorModel)
            } else { unavailable }
        case .projects:
            if let projectModel {
                JunoMobileProjectsView(
                    model: projectModel,
                    conversationModel: conversationModel,
                    openConversation: openConversation
                )
            } else { unavailable }
        case .library:
            if let projectModel {
                JunoMobileLibraryView(
                    model: projectModel,
                    accountID: currentSession?.profile.id,
                    attachmentClient: requestSender.map { NativeAttachmentAPIClient(sender: $0) },
                    generateClient: generateClient,
                    modelCatalog: conversationModel?.modelCatalog ?? [],
                    openConversation: openConversation
                )
            } else { unavailable }
        case .artifacts:
            if let artifactModel {
                JunoMobileArtifactsView(model: artifactModel, openConversation: openConversation)
            } else { unavailable }
        case .settings:
            if let memorySettingsModel {
                JunoMobileSettingsView(
                    model: memorySettingsModel,
                    conversationModel: conversationModel,
                    authModel: authModel,
                    session: currentSession,
                    avatarData: avatarModel?.imageData,
                    syncModel: syncModel,
                    outbox: outbox,
                    accountDataClient: accountDataClient,
                    requestSender: requestSender,
                        shareClient: shareClient
                )
            } else { unavailable }
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
            Label("shell.unavailable.title", systemImage: "exclamationmark.triangle")
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
        guard let id = await conversationModel.createConversationResolvingID(
            title: String(prompt.prefix(60)),
            model: memorySettingsModel?.settings?.defaultModel,
            kind: "code"
        ) else { return }
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

/// A fully custom iPhone/iPad sidebar drawer — deliberately **not** built on
/// `List`/`Form`/`Section`, whose grouped metrics read like a Settings page.
/// A compact header, a scrolling `LazyVStack` of dense rows, and a fixed footer
/// reproduce the proportions and density of a modern chat drawer.
private struct JunoMobileSidebarDrawer: View {
    @Binding var selection: JunoMobileSection
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let session: NativeAuthenticatedSession
    /// The account photo's bytes, already fetched through the authenticated file
    /// route. Nil falls back to initials.
    var avatarData: Data?
    var canCreateChat: Bool = true
    let openDestination: (JunoMobileSection) -> Void
    let openConversation: (String) -> Void
    let newChat: () -> Void

    @State private var renameTarget: NativeConversation?
    @State private var renameValue = ""
    @State private var deleteTarget: NativeConversation?

    private var pinned: [NativeConversation] {
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

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(JunoMobileSection.drawerDestinations) { destination in
                        JunoMobileSidebarRow(
                            junoIcon: destination.junoIcon,
                            icon: destination.systemImage,
                            title: destination.title,
                            selected: selection == destination,
                            action: { openDestination(destination) }
                        )
                    }

                    if !pinned.isEmpty {
                        sectionLabel("sidebar.pinned")
                        ForEach(pinned) { conversationRow($0, pinned: true) }
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
        .alert("Rename conversation", isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )) {
            TextField("Title", text: $renameValue)
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Save") {
                guard let target = renameTarget else { return }
                renameTarget = nil
                Task { await conversationModel?.renameConversation(id: target.id, title: renameValue) }
            }
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
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("chat.delete.warning")
        }
    }

    /// One conversation, with the actions a long press should offer.
    ///
    /// The menu lives on the row rather than only in the conversation's own
    /// toolbar because the drawer is where you *see* the list — reaching Rename
    /// meant opening the chat you wanted to rename first, which is backwards.
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
                Label("Rename", systemImage: "pencil")
            }
            Button {
                Task {
                    await conversationModel?.setPinned(
                        id: conversation.id, pinned: !conversation.pinned
                    )
                }
            } label: {
                Label(
                    conversation.pinned ? "Unpin" : "Pin",
                    systemImage: conversation.pinned ? "pin.slash" : "pin"
                )
            }
            Divider()
            Button(role: .destructive) {
                deleteTarget = conversation
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        // A conversation still syncing cannot be renamed, pinned or deleted —
        // the mutation would target a row the server has never seen. Gated on
        // the conversation's own state, not on `isMutating`: that flag is true
        // during *any* mutation anywhere, so using it here would randomly make
        // the long press do nothing while an unrelated change was in flight.
        .disabled(conversation.isPending)
    }

    // Compact brand header — Juno wordmark left, circular glass Search right.
    private var header: some View {
        HStack(spacing: 9) {
            // The real mark from `public/juno-mark.png`, not an SF Symbol
            // stand-in. It is ink-coloured rather than coral: on the website the
            // mark is ink and the coral is spent on emphasis, so tinting
            // always-present chrome would spend the accent on nothing.
            JunoMark(size: 24)
            Text("Juno")
                .font(.system(size: 22, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            Button(action: { openDestination(.search) }) {
                JunoIconView(.search, size: 18)
                    .foregroundStyle(.primary)
                    .frame(width: 46, height: 46)
                    .modifier(JunoGlassCircle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("navigation.search")
        }
        .padding(.horizontal, 16)
        // No fixed height. It was pinned to 44pt around a 46pt glass circle, so
        // the button overflowed its own header and the first destination row sat
        // hard against Search — the mark, the wordmark and "Projects" reading as
        // one undifferentiated block.
        //
        // The bottom inset is the load-bearing half: a brand header and a list of
        // destinations are two different things, and the gap is what says so.
        .padding(.top, 6)
        .padding(.bottom, 14)
    }

    private func sectionLabel(_ key: LocalizedStringKey) -> some View {
        Text(key)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.top, 14)
            .padding(.bottom, 4)
    }

    // MARK: Bottom bar — profile (glass circle) + New Chat (accent glass capsule)

    private var bottomBar: some View {
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

    /// The photo sits **inside** the glass, not over it.
    ///
    /// The avatar used to be 46pt with `JunoGlassCircle` behind it — an opaque
    /// disc exactly covering the glass, so the button had a Liquid Glass
    /// background that was impossible to see and read as a bare cropped photo.
    /// A 32pt photo in a 46pt circle leaves a 7pt ring of real glass around it:
    /// the control refracts and flexes under a finger like every other piece of
    /// chrome, and the photo reads as mounted in it rather than as the button.
    ///
    /// The outer size is unchanged, so the touch target is still 46pt.
    private var profileButton: some View {
        Button(action: { openDestination(.settings) }) {
            JunoAvatar(
                imageData: avatarData,
                imageURL: session.profile.imageURL,
                name: profileName,
                size: 32
            )
            .padding(7)
            .modifier(JunoGlassCircle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open settings for \(profileName)")
    }

    private var newChatButton: some View {
        Button(action: newChat) {
            HStack(spacing: 7) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 16, weight: .semibold))
                Text("navigation.chat")
                    .font(.system(size: 16, weight: .semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 20)
            .frame(height: 46)
            .modifier(JunoAccentGlassCapsule())
        }
        .buttonStyle(.plain)
        .disabled(!canCreateChat)
        .opacity(canCreateChat ? 1 : 0.5)
        .accessibilityLabel("chat.new")
    }
}

/// A single destination / action row: constant icon column, 44pt tall, with a
/// restrained accent wash only when selected.
private struct JunoMobileSidebarRow: View {
    /// The destination's own glyph. When it has a Juno icon that is used; the
    /// system symbol is the fallback for destinations the web shell has no
    /// glyph for. Neither is tinted coral — every row coral was one of the
    /// rejected build's louder mistakes, and it left the accent meaning nothing.
    var junoIcon: JunoIcon?
    var icon: String
    let title: LocalizedStringKey
    var selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Group {
                    if let junoIcon {
                        JunoIconView(junoIcon, size: 19)
                    } else {
                        Image(systemName: icon)
                            .font(.system(size: 19))
                    }
                }
                .frame(width: 26)
                .foregroundStyle(.primary)
                Text(title)
                    .font(.system(size: 17, weight: selected ? .semibold : .regular))
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 44)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? Color.primary.opacity(0.06) : .clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(JunoSidebarPressStyle())
    }
}

/// A dense single-line conversation row (~40pt) with tail truncation and no
/// background or separator, so many rows stay visible at once.
private struct JunoMobileConversationRow: View {
    let title: String
    var pinned: Bool
    var pending: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if pinned {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                Text(title)
                    .font(.system(size: 16))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                if pending {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(JunoSidebarPressStyle())
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
        // Hand the plaintext over and drop it from view state immediately.
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
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if let error = authModel.lastErrorDescription {
                    Text(error)
                        .foregroundStyle(.red)
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

                    Text("auth.divider.or")
                        .junoCaption()
                        .foregroundStyle(.secondary)

                    Button {
                        Task { await authModel.signIn() }
                    } label: {
                        Text("auth.sign-in")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(isBusy)
                    .accessibilityIdentifier("juno.mobile.sign-in")

                    Text("auth.password.disclaimer")
                        .junoCaption()
                        .foregroundStyle(.secondary)
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

/// The mobile counterpart to the desktop offline banner: the workspace below is
/// the local copy, and Juno has not confirmed it.
private struct JunoMobileOfflineBanner: View {
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "bolt.horizontal.circle")
            Text("auth.offline.title")
                .font(.footnote)
            Spacer(minLength: 8)
            Button("auth.offline.retry", action: retry)
                .font(.footnote)
                .buttonStyle(.bordered)
                .controlSize(.mini)
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
