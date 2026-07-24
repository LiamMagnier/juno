import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoDesignSystem
import JunoStorage
import JunoSync
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
    /// The three server-backed sections. Unlike the models above they hold no
    /// local mirror — connections, scheduled tasks and code sessions live only
    /// on the server, so each screen reads them live and says so when it cannot.
    var connectorModel: NativeConnectorModel?
    var scheduledTaskModel: NativeScheduledTaskModel?
    var codeModel: NativeCodeModel?
    // Restores the last-viewed destination across relaunches (per scene).
    @SceneStorage("juno.mobile.selection") private var selection = JunoMobileSection.chat
    @State private var sidebarOpen = false
    @State private var showingSettings = false
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
                attachmentModel?.start(for: session.profile.id)
                avatarModel?.start(for: session.profile)
                Task { await connectorModel?.start(for: session.profile.id) }
                Task { await scheduledTaskModel?.start(for: session.profile.id) }
                Task { await codeModel?.start(for: session.profile.id) }
            } else {
                syncModel?.stop()
                attachmentModel?.stop()
                conversationModel?.stop()
                projectModel?.stop()
                artifactModel?.stop()
                memorySettingsModel?.stop()
                searchModel?.stop()
                avatarModel?.clear()
                connectorModel?.stop()
                scheduledTaskModel?.stop()
                codeModel?.stop()
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
            authenticatedContent(session: session)
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
                        outbox: outbox
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
                    }
                    .accessibilityLabel("Close settings")
                    .accessibilityIdentifier("juno.mobile.settings-close")
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
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
            .overlay {
                if sidebarOpen {
                    Rectangle()
                        .fill(.clear)
                        .contentShape(Rectangle())
                        .onTapGesture { setSidebar(false) }
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
        // `simultaneousGesture`, not `gesture`. Attached as an exclusive gesture
        // this tracked every touch in the whole shell and won against the
        // control nearest the leading edge: the composer's "+" sits at x≈36 and
        // its action simply never fired, while the model chip 40pt to its right
        // always worked. That is the "+ does nothing" report — the button was
        // never broken, its touch was being taken. Recognising simultaneously
        // lets the button act and still leaves the drawer swipe intact.
        .simultaneousGesture(
            DragGesture(minimumDistance: 18)
                .onEnded { value in
                    if value.translation.width < -60 { setSidebar(false) }
                    else if value.translation.width > 60 && value.startLocation.x < 32 {
                        setSidebar(true)
                    }
                }
        )
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
    }

    @ViewBuilder
    private func destinationRoot(_ destination: JunoMobileSection) -> some View {
        switch destination {
        case .chat:
            if let conversationModel {
                JunoMobileChatDetailScreen(
                    model: conversationModel,
                    projects: projectModel?.projects ?? [],
                    attachmentModel: attachmentModel,
                    profileName: currentSession?.profile.name
                )
            } else {
                unavailable
            }
        case .search:
            if let searchModel {
                JunoMobileSearchView(model: searchModel, open: openSearchResult)
            } else { unavailable }
        case .code:
            if let codeModel {
                JunoMobileCodeView(model: codeModel)
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
                JunoMobileFilesView(model: projectModel)
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
                    outbox: outbox
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
        .frame(height: 44)
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

    private var profileButton: some View {
        Button(action: { openDestination(.settings) }) {
            JunoAvatar(
                imageData: avatarData,
                imageURL: session.profile.imageURL,
                name: profileName,
                size: 46
            )
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

    var body: some View {
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
                Button {
                    Task { await authModel.signIn() }
                } label: {
                    if authModel.phase == .signingIn {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("auth.sign-in")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(authModel.phase == .signingIn)
                .accessibilityIdentifier("juno.mobile.sign-in")
            }
        }
        .padding(32)
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
