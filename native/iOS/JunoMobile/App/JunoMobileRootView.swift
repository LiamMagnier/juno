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
    // Restores the last-viewed tab across relaunches (per scene).
    @SceneStorage("juno.mobile.selection") private var selection = JunoMobileSection.chat
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

    /// Size-adaptive top-level navigation: a tab bar on iPhone and a sidebar on
    /// iPad/large widths, from one declaration. Every tab hosts a real surface.
    private func authenticatedContent(
        session: NativeAuthenticatedSession
    ) -> some View {
        TabView(selection: $selection) {
            Tab(value: JunoMobileSection.chat) {
                chatTab
            } label: {
                Label("navigation.chat", systemImage: JunoMobileSection.chat.systemImage)
            }

            Tab(value: JunoMobileSection.search, role: .search) {
                searchTab
            } label: {
                Label("navigation.search", systemImage: JunoMobileSection.search.systemImage)
            }

            TabSection("sidebar.group.content") {
                Tab(value: JunoMobileSection.projects) {
                    projectsTab
                } label: {
                    Label("navigation.projects", systemImage: JunoMobileSection.projects.systemImage)
                }
                Tab(value: JunoMobileSection.library) {
                    libraryTab
                } label: {
                    Label("navigation.library", systemImage: JunoMobileSection.library.systemImage)
                }
                Tab(value: JunoMobileSection.artifacts) {
                    artifactsTab
                } label: {
                    Label("navigation.artifacts", systemImage: JunoMobileSection.artifacts.systemImage)
                }
            }

            Tab(value: JunoMobileSection.settings) {
                settingsTab(session: session)
            } label: {
                Label("navigation.settings", systemImage: JunoMobileSection.settings.systemImage)
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .accessibilityIdentifier("juno.mobile.tabs")
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

    @ViewBuilder
    private var chatTab: some View {
        if let conversationModel {
            JunoMobileConversationsView(model: conversationModel, syncModel: syncModel)
        } else {
            JunoMobileUnavailableTab()
        }
    }

    @ViewBuilder
    private var searchTab: some View {
        if let searchModel {
            JunoMobileSearchView(model: searchModel, open: openSearchResult)
        } else {
            JunoMobileUnavailableTab()
        }
    }

    @ViewBuilder
    private var projectsTab: some View {
        if let projectModel {
            JunoMobileProjectsView(
                model: projectModel,
                conversationModel: conversationModel,
                openConversation: openConversation
            )
        } else {
            JunoMobileUnavailableTab()
        }
    }

    @ViewBuilder
    private var libraryTab: some View {
        if let projectModel {
            JunoMobileFilesView(model: projectModel)
        } else {
            JunoMobileUnavailableTab()
        }
    }

    @ViewBuilder
    private var artifactsTab: some View {
        if let artifactModel {
            JunoMobileArtifactsView(model: artifactModel, openConversation: openConversation)
        } else {
            JunoMobileUnavailableTab()
        }
    }

    @ViewBuilder
    private func settingsTab(session: NativeAuthenticatedSession) -> some View {
        if let memorySettingsModel {
            JunoMobileSettingsView(
                model: memorySettingsModel,
                conversationModel: conversationModel,
                authModel: authModel,
                session: session
            )
        } else {
            JunoMobileUnavailableTab()
        }
    }
}

/// Honest fallback shown only when a store failed to open at launch — never a
/// placeholder for an unbuilt feature.
private struct JunoMobileUnavailableTab: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("shell.unavailable.title", systemImage: "exclamationmark.triangle")
            } description: {
                Text("shell.unavailable.description")
            }
        }
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
        NavigationStack {
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
                    List(model.projects) { project in
                        NavigationLink(value: project.id) {
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    if project.starred {
                                        Image(systemName: "star.fill")
                                            .foregroundStyle(.yellow)
                                    }
                                    Text(project.name).lineLimit(1)
                                    Spacer()
                                    if project.isPending {
                                        Image(systemName: "arrow.triangle.2.circlepath")
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                HStack {
                                    Label(
                                        "\(model.conversationsByProject[project.id]?.count ?? 0)",
                                        systemImage: "bubble.left"
                                    )
                                    Label(
                                        "\(model.filesByProject[project.id]?.count ?? 0)",
                                        systemImage: "doc"
                                    )
                                    Spacer()
                                    Text(project.updatedAt, style: .relative)
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("juno.mobile.project-list")
                }
            }
            .navigationTitle("Projects")
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
        NavigationStack {
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
                    .accessibilityIdentifier("juno.mobile.file-list")
                }
            }
            .navigationTitle("Files")
            .safeAreaInset(edge: .bottom) {
                if model.phase == .offline || model.lastErrorDescription != nil {
                    JunoMobileProjectStatus(model: model)
                }
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
        NavigationStack {
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
                                    .frame(width: 28)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(artifact.title).lineLimit(1)
                                    HStack {
                                        Text(artifact.conversationTitle).lineLimit(1)
                                        Spacer()
                                        Text("v\(artifact.currentVersion)")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .accessibilityIdentifier("juno.mobile.artifact-list")
                }
            }
            .navigationTitle("Artifacts")
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
