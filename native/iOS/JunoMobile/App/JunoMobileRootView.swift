import JunoAuth
import JunoChatKit
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
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    let memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    let searchModel: NativeSearchModel<SQLiteAccountRepository>?
    // Restores the last-viewed destination across relaunches (per scene).
    @SceneStorage("juno.mobile.selection") private var selection = JunoMobileSection.chat
    @State private var sidebarOpen = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if DEBUG
    /// Set only by the local UI Preview harness to render the real authenticated
    /// shell without any authentication; nil in every normal run.
    var previewSession: NativeAuthenticatedSession?
    #endif

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
                return
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
            } else {
                syncModel?.stop()
                conversationModel?.stop()
                projectModel?.stop()
                artifactModel?.stop()
                memorySettingsModel?.stop()
                searchModel?.stop()
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
            ProgressView("auth.restoring")
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
                isPreview: isPreviewSession,
                canCreateChat: conversationModel != nil,
                openDestination: openSidebarDestination,
                openConversation: openSidebarConversation,
                newChat: startNewChat
            )
            .frame(width: revealed, alignment: .leading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(Color.junoCanvas.ignoresSafeArea())

            detail(for: selection)
                .allowsHitTesting(!sidebarOpen)
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
                .clipShape(RoundedRectangle(cornerRadius: sidebarOpen ? 22 : 0, style: .continuous))
                .shadow(color: .black.opacity(sidebarOpen ? 0.22 : 0), radius: 22, x: -1)
                .scaleEffect(sidebarOpen ? 0.95 : 1, anchor: .center)
                .offset(x: sidebarOpen ? revealed : 0)
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.32), value: sidebarOpen)
        .gesture(
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
        else { withAnimation(.snappy(duration: 0.28)) { sidebarOpen = open } }
    }

    // MARK: Sidebar

    @ViewBuilder
    private func sidebar(session: NativeAuthenticatedSession) -> some View {
        JunoMobileSidebarDrawer(
            selection: $selection,
            conversationModel: conversationModel,
            session: session,
            isPreview: isPreviewSession,
            openDestination: openSidebarDestination,
            openConversation: openSidebarConversation,
            newChat: startNewChat
        )
    }

    private var isPreviewSession: Bool {
        #if DEBUG
        return previewSession != nil
        #else
        return false
        #endif
    }

    private func openSidebarDestination(_ destination: JunoMobileSection) {
        selection = destination
        if destination != .chat { conversationModel?.selectedConversationID = nil }
        setSidebar(false)
    }

    private func openSidebarConversation(_ id: String) {
        conversationModel?.selectedConversationID = id
        selection = .chat
        setSidebar(false)
    }

    private func startNewChat() {
        Task {
            if let id = await conversationModel?.createConversation() {
                conversationModel?.selectedConversationID = id
            }
            selection = .chat
            setSidebar(false)
        }
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
                JunoMobileChatDetailScreen(model: conversationModel)
            } else {
                unavailable
            }
        case .search:
            if let searchModel {
                JunoMobileSearchView(model: searchModel, open: openSearchResult)
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
                    session: currentSession
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
            selection = .settings
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
    var isPreview: Bool = false
    var canCreateChat: Bool = true
    let openDestination: (JunoMobileSection) -> Void
    let openConversation: (String) -> Void
    let newChat: () -> Void

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
                    JunoMobileSidebarRow(
                        icon: JunoMobileSection.chat.systemImage,
                        title: "navigation.chat",
                        selected: selection == .chat,
                        action: { openDestination(.chat) }
                    )
                    JunoMobileSidebarRow(
                        icon: JunoMobileSection.projects.systemImage,
                        title: "navigation.projects",
                        selected: selection == .projects,
                        action: { openDestination(.projects) }
                    )
                    JunoMobileSidebarRow(
                        icon: JunoMobileSection.library.systemImage,
                        title: "navigation.library",
                        selected: selection == .library,
                        action: { openDestination(.library) }
                    )
                    JunoMobileSidebarRow(
                        icon: JunoMobileSection.artifacts.systemImage,
                        title: "navigation.artifacts",
                        selected: selection == .artifacts,
                        action: { openDestination(.artifacts) }
                    )

                    if !pinned.isEmpty {
                        sectionLabel("sidebar.pinned")
                        ForEach(pinned) { conversation in
                            JunoMobileConversationRow(
                                title: conversation.title,
                                pinned: true,
                                pending: conversation.isPending,
                                action: { openConversation(conversation.id) }
                            )
                        }
                    }

                    if !recents.isEmpty {
                        sectionLabel("sidebar.recents")
                        ForEach(recents) { conversation in
                            JunoMobileConversationRow(
                                title: conversation.title,
                                pinned: false,
                                pending: conversation.isPending,
                                action: { openConversation(conversation.id) }
                            )
                        }
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
    }

    // Compact brand header — Juno wordmark left, circular glass Search right.
    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: "circle.hexagongrid.fill")
                .font(.system(size: 22))
                .foregroundStyle(Color.junoAccent)
                .accessibilityHidden(true)
            Text("Juno")
                .font(.system(size: 22, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            Button(action: { openDestination(.search) }) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 36, height: 36)
                    .modifier(JunoGlassCircle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("navigation.search")
        }
        .padding(.horizontal, 16)
        .frame(height: 56)
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
        VStack(spacing: 5) {
            if isPreview {
                Text("Preview")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 4)
                    .accessibilityLabel("Debug preview build")
            }
            HStack(spacing: 10) {
                profileButton
                newChatButton
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 8)
    }

    private var profileName: String { session.profile.name ?? session.profile.email }

    private var profileInitials: String {
        let source = session.profile.name ?? session.profile.email
        let parts = source.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first }.map(String.init).joined()
        return letters.isEmpty ? String(source.prefix(1)).uppercased() : letters.uppercased()
    }

    private var profileButton: some View {
        Button(action: { openDestination(.settings) }) {
            Group {
                if let url = session.profile.imageURL {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Text(profileInitials).font(.system(size: 16, weight: .semibold))
                    }
                } else {
                    Text(profileInitials)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.primary)
                }
            }
            .frame(width: 46, height: 46)
            .clipShape(Circle())
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
                Text("chat.new")
                    .font(.system(size: 16, weight: .semibold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
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
    let icon: String
    let title: LocalizedStringKey
    var selected: Bool
    var forcedTint: Color? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 19))
                    .frame(width: 26)
                    .foregroundStyle(forcedTint ?? (selected ? Color.junoAccent : .primary))
                Text(title)
                    .font(.system(size: 17, weight: selected ? .semibold : .regular))
                    .foregroundStyle(forcedTint ?? (selected ? Color.junoAccent : .primary))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 44)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? Color.junoAccent.opacity(0.08) : .clear)
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

/// A circular Liquid Glass container (OS 26+) with a material fallback, used for
/// the sidebar's Search and profile buttons.
private struct JunoGlassCircle: ViewModifier {
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

/// An accent-tinted Liquid Glass capsule (OS 26+) with an opaque accent fallback,
/// used for the primary "New Chat" control.
private struct JunoAccentGlassCapsule: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(.regular.tint(Color.junoAccent).interactive(), in: Capsule())
        } else {
            content
                .background(Color.junoAccent, in: Capsule())
        }
    }
}

/// A subtle pressed-state wash shared by sidebar rows.
private struct JunoSidebarPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(configuration.isPressed ? Color.primary.opacity(0.06) : .clear)
            )
    }
}

private struct JunoMobileSignInView: View {
    let authModel: NativeAuthModel

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "circle.hexagongrid.fill")
                .font(.system(size: 42))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("auth.welcome.title")
                .font(.title2.weight(.semibold))
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


private struct JunoMobileProjectsView: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let openConversation: (String) -> Void
    @State private var showingCreate = false
    @State private var createName = ""
    @State private var createInstructions = ""

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                ProgressView("Loading projects…")
            case .failed where model.projects.isEmpty:
                ContentUnavailableView(
                    "Projects unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text(model.lastErrorDescription ?? "Try again.")
                )
            case .ready where model.projects.isEmpty,
                 .offline where model.projects.isEmpty:
                ContentUnavailableView(
                    "No projects",
                    systemImage: "folder",
                    description: Text("Create a project to group conversations and files.")
                )
            default:
                List {
                    ForEach(model.projects) { project in
                        NavigationLink(value: project.id) {
                            projectRow(project)
                        }
                        .contextMenu {
                            Button {
                                Task { await model.updateProject(id: project.id, starred: !project.starred) }
                            } label: {
                                Label(project.starred ? "Unfavorite" : "Favorite",
                                      systemImage: project.starred ? "star.slash" : "star")
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .accessibilityIdentifier("juno.mobile.project-list")
            }
        }
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    createName = ""
                    createInstructions = ""
                    showingCreate = true
                } label: {
                    Label("New project", systemImage: "folder.badge.plus")
                }
                .disabled(model.isMutating)
                .accessibilityIdentifier("juno.mobile.project-new")
            }
        }
        .navigationDestination(for: String.self) { projectID in
            if let project = model.projects.first(where: { $0.id == projectID }) {
                JunoMobileProjectDetail(
                    model: model,
                    conversationModel: conversationModel,
                    project: project,
                    openConversation: openConversation
                )
                .onAppear { model.selectedProjectID = projectID }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if model.conflictedMutationCount > 0 {
                JunoMobileProjectConflict(model: model)
            } else if model.phase == .offline || model.lastErrorDescription != nil {
                JunoMobileProjectStatus(model: model)
            }
        }
        .alert("New project", isPresented: $showingCreate) {
            TextField("Name", text: $createName)
            TextField("Instructions", text: $createInstructions)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                Task {
                    await model.createProject(
                        name: createName,
                        instructions: createInstructions
                    )
                }
            }
        } message: {
            Text("Project instructions are included in every linked conversation.")
        }
    }

    private func projectRow(_ project: NativeProject) -> some View {
        let conversations = model.conversationsByProject[project.id]?.count ?? 0
        let files = model.filesByProject[project.id]?.count ?? 0
        return HStack(spacing: 12) {
            Image(systemName: project.starred ? "star.fill" : "folder")
                .font(.title3)
                .foregroundStyle(project.starred ? Color.yellow : Color.junoAccent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(project.name).font(.body.weight(.medium)).lineLimit(1)
                    if project.isPending {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.caption2).foregroundStyle(.secondary)
                            .accessibilityLabel("Waiting to sync")
                    }
                }
                Text("^[\(conversations) conversation](inflect: true) · ^[\(files) file](inflect: true) · \(project.updatedAt.formatted(.relative(presentation: .named)))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }
}

private struct JunoMobileProjectStatus: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: model.phase == .offline
                ? "wifi.slash" : "exclamationmark.circle")
            Text(model.lastErrorDescription ?? "Offline — showing saved projects.")
                .lineLimit(2)
            Spacer()
            Button("Retry") { Task { await model.reload() } }
        }
        .font(.caption)
        .padding(10)
        .background(.bar)
    }
}

private struct JunoMobileProjectConflict: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                Text("A project changed on another device.")
                    .lineLimit(2)
                Spacer()
            }
            HStack {
                Button("Keep mine") {
                    Task { await model.resolveConflicts(keepLocalChanges: true) }
                }
                Spacer()
                Button("Use server version") {
                    Task { await model.resolveConflicts(keepLocalChanges: false) }
                }
            }
        }
        .font(.caption)
        .padding(10)
        .background(.bar)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.mobile.project-conflict")
    }
}

private struct JunoMobileProjectDetail: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let project: NativeProject
    let openConversation: (String) -> Void
    @State private var showingEdit = false
    @State private var editName = ""
    @State private var editInstructions = ""
    @State private var showingDelete = false
    @State private var showingImporter = false
    @State private var renameFileID: String?
    @State private var renameValue = ""
    @State private var previewURL: URL?
    @State private var localError: String?

    var body: some View {
        List {
            Section("Instructions") {
                Text(project.instructions.isEmpty
                    ? "No project instructions" : project.instructions)
                    .foregroundStyle(project.instructions.isEmpty ? .secondary : .primary)
            }
            Section("Conversations") {
                if model.selectedConversations.isEmpty {
                    Text("No linked conversations")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.selectedConversations) { conversation in
                        Button {
                            openConversation(conversation.id)
                        } label: {
                            HStack {
                                if conversation.pinned { Image(systemName: "pin.fill") }
                                Text(conversation.title).lineLimit(1)
                                Spacer()
                                Text(conversation.lastMessageAt, style: .relative)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                Button {
                    Task {
                        if let id = await conversationModel?.createConversation(
                            projectID: project.id
                        ) {
                            openConversation(id)
                        }
                    }
                } label: {
                    Label("New project conversation", systemImage: "square.and.pencil")
                }
                .disabled(project.isPending || conversationModel == nil)
            }
            Section("Files") {
                if model.selectedFiles.isEmpty {
                    Text("No project files")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.selectedFiles) { file in
                        JunoMobileProjectFileRow(
                            file: file,
                            busy: model.isPerformingFileAction,
                            open: { openFile(file) },
                            rename: {
                                renameValue = file.fileName
                                renameFileID = file.id
                            },
                            delete: { Task { await model.deleteFile(id: file.id) } }
                        )
                    }
                }
                Button { showingImporter = true } label: {
                    Label("Add file", systemImage: "paperclip")
                }
                .disabled(project.isPending || model.isPerformingFileAction)
                .accessibilityIdentifier("juno.mobile.project-file-add")
            }
        }
        .navigationTitle(project.name)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    Task {
                        await model.updateProject(
                            id: project.id,
                            starred: !project.starred
                        )
                    }
                } label: {
                    Image(systemName: project.starred ? "star.fill" : "star")
                }
                .disabled(project.isPending || model.isMutating)
                Menu {
                    Button("Edit") {
                        editName = project.name
                        editInstructions = project.instructions
                        showingEdit = true
                    }
                    Button("Delete", role: .destructive) { showingDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(project.isPending || model.isMutating)
            }
        }
        .alert("Edit project", isPresented: $showingEdit) {
            TextField("Name", text: $editName)
            TextField("Instructions", text: $editInstructions)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task {
                    await model.updateProject(
                        id: project.id,
                        name: editName,
                        instructions: editInstructions
                    )
                }
            }
        }
        .alert("Delete project?", isPresented: $showingDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                Task { await model.deleteProject(id: project.id) }
            }
        } message: {
            Text("Linked conversations are kept. Project files are removed.")
        }
        .alert("Rename file", isPresented: Binding(
            get: { renameFileID != nil },
            set: { if !$0 { renameFileID = nil } }
        )) {
            TextField("File name", text: $renameValue)
            Button("Cancel", role: .cancel) { renameFileID = nil }
            Button("Save") {
                guard let id = renameFileID else { return }
                renameFileID = nil
                Task { await model.renameFile(id: id, fileName: renameValue) }
            }
        }
        .alert("File unavailable", isPresented: Binding(
            get: { localError != nil },
            set: { if !$0 { localError = nil } }
        )) {
            Button("OK") { localError = nil }
        } message: {
            Text(localError ?? "Try again.")
        }
        .fileImporter(
            isPresented: $showingImporter,
            allowedContentTypes: [.data],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                if let url = urls.first { importFile(url) }
            case .failure(let error):
                localError = error.localizedDescription
            }
        }
        .quickLookPreview($previewURL)
    }

    private func importFile(_ url: URL) {
        let projectID = project.id
        Task {
            do {
                let payload = try await Task.detached(priority: .userInitiated) {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize
                    if let size, size > NativeProjectAPIClient.maximumUploadBytes {
                        throw NativeProjectAPIError.fileTooLarge(
                            maximumBytes: NativeProjectAPIClient.maximumUploadBytes
                        )
                    }
                    let data = try Data(contentsOf: url, options: [.mappedIfSafe])
                    let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                        ?? "application/octet-stream"
                    return (data, url.lastPathComponent, mime)
                }.value
                await model.uploadFile(
                    data: payload.0,
                    fileName: payload.1,
                    mimeType: payload.2,
                    projectID: projectID
                )
            } catch {
                localError = error.localizedDescription
            }
        }
    }

    private func openFile(_ file: NativeProjectFile) {
        Task {
            guard let access = await model.accessFile(id: file.id) else { return }
            do {
                previewURL = try JunoMobileFilePreview.url(
                    for: access,
                    fileName: file.fileName
                )
            } catch {
                localError = error.localizedDescription
            }
        }
    }
}

private struct JunoMobileFilesView: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    @State private var renameFileID: String?
    @State private var renameValue = ""
    @State private var previewURL: URL?
    @State private var localError: String?

    var body: some View {
        Group {
            if model.phase == .loading || model.phase == .idle {
                ProgressView("Loading files…")
            } else if model.files.isEmpty {
                ContentUnavailableView(
                    "No files",
                    systemImage: "doc.on.doc",
                    description: Text("Files uploaded to Juno will appear here offline.")
                )
            } else {
                List(model.files) { file in
                    JunoMobileProjectFileRow(
                        file: file,
                        busy: model.isPerformingFileAction,
                        open: { openFile(file) },
                        rename: {
                            renameValue = file.fileName
                            renameFileID = file.id
                        },
                        delete: { Task { await model.deleteFile(id: file.id) } }
                    )
                }
                .listStyle(.insetGrouped)
                .accessibilityIdentifier("juno.mobile.file-list")
            }
        }
        .navigationTitle("navigation.library")
        .navigationBarTitleDisplayMode(.large)
        .safeAreaInset(edge: .bottom) {
            if model.phase == .offline || model.lastErrorDescription != nil {
                JunoMobileProjectStatus(model: model)
            }
        }
        .alert("Rename file", isPresented: Binding(
            get: { renameFileID != nil },
            set: { if !$0 { renameFileID = nil } }
        )) {
            TextField("File name", text: $renameValue)
            Button("Cancel", role: .cancel) { renameFileID = nil }
            Button("Save") {
                guard let id = renameFileID else { return }
                renameFileID = nil
                Task { await model.renameFile(id: id, fileName: renameValue) }
            }
        }
        .alert("File unavailable", isPresented: Binding(
            get: { localError != nil },
            set: { if !$0 { localError = nil } }
        )) {
            Button("OK") { localError = nil }
        } message: {
            Text(localError ?? "Try again.")
        }
        .quickLookPreview($previewURL)
    }

    private func openFile(_ file: NativeProjectFile) {
        Task {
            guard let access = await model.accessFile(id: file.id) else { return }
            do {
                previewURL = try JunoMobileFilePreview.url(
                    for: access,
                    fileName: file.fileName
                )
            } catch {
                localError = error.localizedDescription
            }
        }
    }
}

private struct JunoMobileProjectFileRow: View {
    let file: NativeProjectFile
    let busy: Bool
    let open: () -> Void
    let rename: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: file.kind == "IMAGE" ? "photo" : "doc")
                .frame(width: 24)
            Button(action: open) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(file.fileName).lineLimit(1)
                    HStack {
                        Text(ByteCountFormatter.string(
                            fromByteCount: Int64(file.size),
                            countStyle: .file
                        ))
                        if let projectID = file.projectID {
                            Text("• \(projectID)").lineLimit(1)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            Spacer()
            if busy { ProgressView().controlSize(.small) }
            Menu {
                Button("Open", action: open)
                Button("Rename", action: rename)
                Button("Delete", role: .destructive, action: delete)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }
}

private enum JunoMobileFilePreview {
    static func url(
        for access: NativeProjectFileAccess,
        fileName: String
    ) throws -> URL {
        switch access {
        case .remote(let url):
            return url
        case .downloaded(let data):
            let ext = URL(fileURLWithPath: fileName).pathExtension
                .filter { $0.isLetter || $0.isNumber }
            let name = "juno-preview-\(UUID().uuidString)"
                + (ext.isEmpty ? "" : ".\(ext)")
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(name)
            try data.write(to: url, options: [.atomic])
            return url
        }
    }
}

private struct JunoMobileArtifactsView: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    let openConversation: (String) -> Void

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                ProgressView("Loading artifacts…")
            case .failed where model.artifacts.isEmpty:
                ContentUnavailableView(
                    "Artifacts unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text(model.lastErrorDescription ?? "Try again.")
                )
            case .ready where model.artifacts.isEmpty,
                 .offline where model.artifacts.isEmpty:
                ContentUnavailableView(
                    "No artifacts",
                    systemImage: "square.stack.3d.up",
                    description: Text("Artifacts generated in conversations appear here.")
                )
            default:
                List(model.artifacts) { artifact in
                    NavigationLink(value: artifact.id) {
                        HStack(spacing: 12) {
                            Image(systemName: artifactIcon(artifact.kind))
                                .font(.title3)
                                .foregroundStyle(Color.junoAccent)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(artifact.title).font(.body.weight(.medium)).lineLimit(1)
                                HStack {
                                    Text(artifact.conversationTitle).lineLimit(1)
                                    Spacer()
                                    Text("v\(artifact.currentVersion)").monospacedDigit()
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 3)
                    }
                }
                .listStyle(.insetGrouped)
                .accessibilityIdentifier("juno.mobile.artifact-list")
            }
        }
        .navigationTitle("Artifacts")
        .navigationBarTitleDisplayMode(.large)
        .navigationDestination(for: String.self) { id in
            if let artifact = model.artifacts.first(where: { $0.id == id }) {
                JunoMobileArtifactDetail(
                    model: model,
                    artifact: artifact,
                    openConversation: openConversation
                )
                .id(artifact.id)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if model.phase == .offline || model.lastErrorDescription != nil {
                HStack(spacing: 8) {
                    Image(systemName: model.phase == .offline
                        ? "wifi.slash" : "exclamationmark.circle")
                    Text(model.lastErrorDescription ?? "Offline — showing saved artifacts.")
                        .lineLimit(2)
                    Spacer()
                    Button("Retry") { Task { await model.reload() } }
                }
                .font(.caption)
                .padding(10)
                .background(.bar)
            }
        }
    }

    private func artifactIcon(_ kind: NativeArtifactKind) -> String {
        switch kind {
        case .html: "globe"
        case .react: "atom"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .markdown: "doc.text"
        case .svg: "scribble.variable"
        case .mermaid: "flowchart"
        }
    }
}

private struct JunoMobileArtifactDetail: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    let artifact: NativeArtifact
    let openConversation: (String) -> Void
    @State private var selectedVersion = 0
    @State private var displayMode = NativeArtifactDisplayMode.preview
    @State private var showingRename = false
    @State private var renameValue = ""
    @State private var showingEditor = false
    @State private var editValue = ""
    @State private var showingDelete = false
    @State private var exportURL: URL?
    @State private var localError: String?

    private var version: NativeArtifactVersion? {
        let target = selectedVersion == 0 ? artifact.currentVersion : selectedVersion
        return artifact.versions.first { $0.version == target }
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Button(artifact.conversationTitle) {
                        openConversation(artifact.conversationID)
                    }
                    .lineLimit(1)
                    Spacer()
                    if artifact.versions.count > 1 {
                        Picker("Version", selection: $selectedVersion) {
                            ForEach(artifact.versions.reversed()) { version in
                                Text("v\(version.version)").tag(version.version)
                            }
                        }
                    }
                }
                if artifact.kind.supportsRenderedPreview {
                    Picker("View", selection: $displayMode) {
                        Text("Preview").tag(NativeArtifactDisplayMode.preview)
                        Text("Source").tag(NativeArtifactDisplayMode.source)
                    }
                    .pickerStyle(.segmented)
                }
                HStack {
                    ShareLink(item: version?.content ?? "") {
                        Label("Share source", systemImage: "square.and.arrow.up")
                    }
                    .disabled(version == nil)
                    if let exportURL {
                        Spacer()
                        ShareLink(item: exportURL) {
                            Label("Share export", systemImage: "doc.badge.arrow.up")
                        }
                    }
                }
                .font(.caption)
            }
            .padding()
            Divider()
            if let version {
                NativeArtifactPreview(
                    kind: artifact.kind,
                    content: version.content,
                    mode: displayMode
                )
            } else {
                ContentUnavailableView(
                    "Version unavailable",
                    systemImage: "clock.arrow.circlepath",
                    description: Text("Reconnect to hydrate the latest artifact content.")
                )
            }
        }
        .navigationTitle(artifact.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let version, version.version != artifact.currentVersion {
                    Button("Restore") {
                        Task {
                            await model.restoreArtifact(
                                id: artifact.id,
                                version: version.version
                            )
                        }
                    }
                    .disabled(model.isMutating)
                }
                Menu {
                    Button("Edit") {
                        editValue = artifact.currentContent ?? ""
                        showingEditor = true
                    }
                    .disabled(artifact.currentContent == nil)
                    Button("Rename") {
                        renameValue = artifact.title
                        showingRename = true
                    }
                    if !model.availableExportFormats.isEmpty {
                        Section("Export") {
                            ForEach(model.availableExportFormats, id: \.rawValue) { format in
                                Button(format.rawValue.uppercased()) { export(format) }
                            }
                        }
                    }
                    Button("Delete", role: .destructive) { showingDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(model.isMutating || model.isExporting)
            }
        }
        .onAppear {
            selectedVersion = artifact.currentVersion
            displayMode = artifact.kind.supportsRenderedPreview ? .preview : .source
            Task { await model.openArtifact(id: artifact.id) }
        }
        .onChange(of: artifact.currentVersion) { _, value in
            selectedVersion = value
        }
        .alert("Rename artifact", isPresented: $showingRename) {
            TextField("Title", text: $renameValue)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task { await model.renameArtifact(id: artifact.id, title: renameValue) }
            }
        }
        .alert("Delete artifact?", isPresented: $showingDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                Task { await model.deleteArtifact(id: artifact.id) }
            }
        } message: {
            Text("All versions of this artifact will be removed.")
        }
        .alert("Artifact unavailable", isPresented: Binding(
            get: { localError != nil },
            set: { if !$0 { localError = nil } }
        )) {
            Button("OK") { localError = nil }
        } message: {
            Text(localError ?? "Try again.")
        }
        .sheet(isPresented: $showingEditor) {
            NavigationStack {
                TextEditor(text: $editValue)
                    .font(.system(.body, design: .monospaced))
                    .padding(8)
                    .navigationTitle("Edit artifact")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showingEditor = false }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Save") {
                                showingEditor = false
                                Task {
                                    await model.saveArtifact(
                                        id: artifact.id,
                                        content: editValue
                                    )
                                }
                            }
                        }
                    }
            }
        }
    }

    private func export(_ format: NativeArtifactExportFormat) {
        Task {
            guard let result = await model.exportArtifact(id: artifact.id, format: format)
            else { return }
            do {
                exportURL = try JunoMobileExportFile.write(
                    data: result.data,
                    fileName: result.fileName
                )
            } catch {
                localError = error.localizedDescription
            }
        }
    }
}

private enum JunoMobileExportFile {
    static func write(data: Data, fileName: String) throws -> URL {
        let safeName = fileName.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-\(UUID().uuidString)-\(safeName)")
        try data.write(to: url, options: [.atomic])
        return url
    }
}

/// The menu affordance for opening the mobile drawer. Two left-aligned bars —
/// a longer top bar over a shorter bottom bar — matching the iOS convention for
/// a slide-in navigation menu rather than the macOS `sidebar.leading` rectangle.
private struct JunoMenuGlyph: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Capsule().frame(width: 18, height: 2)
            Capsule().frame(width: 12, height: 2)
        }
        .frame(width: 22, height: 22, alignment: .center)
        .foregroundStyle(.primary)
    }
}
