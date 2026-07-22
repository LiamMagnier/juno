import JunoAuth
import JunoChatKit
import JunoStorage
import JunoSync
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct JunoMacRootView: View {
    @Binding var selection: JunoMacSection
    let authModel: NativeAuthModel
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    let memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    let searchModel: NativeSearchModel<SQLiteAccountRepository>?
    @State private var sidebarSearch = ""

    var body: some View {
        Group {
            switch authModel.phase {
            case .signedIn(let session):
                authenticatedContent(session: session)
            case .restoring:
                ProgressView("auth.restoring")
            case .signedOut, .signingIn, .unavailable:
                JunoMacSignInView(authModel: authModel)
            }
        }
        .task {
            await authModel.restore()
        }
        .onChange(of: authModel.phase) { _, phase in
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

    private func authenticatedContent(
        session: NativeAuthenticatedSession
    ) -> some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("section.product") {
                    rows(for: [.chat, .projects, .library, .artifacts, .tasks, .connections])
                }

                Section("section.intelligence") {
                    rows(for: [.search, .code])
                }

                Section("section.account") {
                    rows(for: [.settings])
                }
            }
            .accessibilityIdentifier("juno.mac.sidebar")
            .navigationTitle("Juno")
            .searchable(text: $sidebarSearch, prompt: "sidebar.search.prompt")
            .navigationSplitViewColumnWidth(min: 210, ideal: 250, max: 340)
        } detail: {
            JunoMacDetailView(
                section: selection,
                conversationModel: conversationModel,
                projectModel: projectModel,
                artifactModel: artifactModel,
                memorySettingsModel: memorySettingsModel,
                searchModel: searchModel,
                openConversation: { id in
                    conversationModel?.selectedConversationID = id
                    selection = .chat
                },
                openSearchResult: { result in
                    switch result.kind {
                    case .conversation, .message:
                        conversationModel?.selectedConversationID =
                            result.conversationID ?? result.entityID
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
            )
                .id(selection)
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem {
                JunoMacSyncStatus(model: syncModel)
            }
            ToolbarItem {
                Menu {
                    Button("auth.sign-out", role: .destructive) {
                        Task { await authModel.signOut() }
                    }
                } label: {
                    Label(
                        session.profile.name ?? session.profile.email,
                        systemImage: "person.crop.circle"
                    )
                }
                .accessibilityIdentifier("juno.mac.account-menu")
            }
        }
    }

    @ViewBuilder
    private func rows(for sections: [JunoMacSection]) -> some View {
        ForEach(filtered(sections)) { section in
            NavigationLink(value: section) {
                Label(section.title, systemImage: section.systemImage)
            }
        }
    }

    private func filtered(_ sections: [JunoMacSection]) -> [JunoMacSection] {
        guard !sidebarSearch.isEmpty else { return sections }
        return sections.filter { section in
            String(localized: String.LocalizationValue(section.rawValue))
                .localizedStandardContains(sidebarSearch)
                || section.rawValue.localizedStandardContains(sidebarSearch)
        }
    }
}

private struct JunoMacSyncStatus: View {
    let model: NativeSyncModel<SQLiteAccountRepository>?

    var body: some View {
        if let model {
            Button {
                Task { await model.refresh() }
            } label: {
                switch model.phase {
                case .idle, .synchronizing:
                    ProgressView().controlSize(.small)
                case .live:
                    Label("Synced", systemImage: "checkmark.circle.fill")
                case .offline:
                    Label("Offline", systemImage: "wifi.slash")
                }
            }
            .buttonStyle(.plain)
            .help(model.lastErrorDescription ?? "Refresh Juno")
            .accessibilityIdentifier("juno.mac.sync-status")
        }
    }
}

private struct JunoMacSignInView: View {
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
                .frame(maxWidth: 420)
            if let error = authModel.lastErrorDescription {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("juno.mac.auth-error")
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
                .accessibilityIdentifier("juno.mac.sign-in")
            }
        }
        .padding(40)
    }
}

private struct JunoMacDetailView: View {
    let section: JunoMacSection
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    let memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    let searchModel: NativeSearchModel<SQLiteAccountRepository>?
    let openConversation: (String) -> Void
    let openSearchResult: (NativeSearchResult) -> Void

    @ViewBuilder
    var body: some View {
        if section == .chat, let conversationModel {
            JunoMacConversationsView(model: conversationModel)
        } else if section == .search, let searchModel {
            JunoMacSearchView(model: searchModel, open: openSearchResult)
        } else if section == .settings, let memorySettingsModel {
            JunoMacSettingsView(
                model: memorySettingsModel,
                conversationModel: conversationModel
            )
        } else if section == .projects, let projectModel {
            JunoMacProjectsView(
                model: projectModel,
                conversationModel: conversationModel,
                openConversation: openConversation
            )
        } else if section == .library, let projectModel {
            JunoMacLibraryView(model: projectModel)
        } else if section == .artifacts, let artifactModel {
            JunoMacArtifactsView(
                model: artifactModel,
                openConversation: openConversation
            )
        } else {
            NavigationStack {
                ContentUnavailableView {
                    Label(section.title, systemImage: section.systemImage)
                } description: {
                    Text("shell.foundation.description")
                }
                .accessibilityIdentifier("juno.mac.detail")
                .navigationTitle(section.title)
            }
        }
    }
}

private struct JunoMacProjectsView: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let openConversation: (String) -> Void
    @State private var showingCreate = false
    @State private var createName = ""
    @State private var createInstructions = ""

    var body: some View {
        NavigationSplitView {
            List(selection: $model.selectedProjectID) {
                ForEach(model.projects) { project in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            if project.starred {
                                Image(systemName: "star.fill")
                                    .foregroundStyle(.yellow)
                            }
                            Text(project.name).lineLimit(1)
                            Spacer(minLength: 4)
                            if project.isPending {
                                Image(systemName: "arrow.triangle.2.circlepath")
                                    .foregroundStyle(.secondary)
                                    .accessibilityLabel("Waiting to sync")
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
                    .tag(project.id)
                }
            }
            .navigationTitle("Projects")
            .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 380)
            .toolbar {
                ToolbarItem {
                    Button {
                        createName = ""
                        createInstructions = ""
                        showingCreate = true
                    } label: {
                        Label("New project", systemImage: "folder.badge.plus")
                    }
                    .disabled(model.isMutating)
                    .accessibilityIdentifier("juno.mac.project-new")
                }
            }
            .overlay { projectListOverlay }
        } detail: {
            if let project = model.selectedProject {
                JunoMacProjectDetail(
                    model: model,
                    conversationModel: conversationModel,
                    project: project,
                    openConversation: openConversation
                )
                .id(project.id)
            } else {
                ContentUnavailableView("Choose a project", systemImage: "folder")
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
        .safeAreaInset(edge: .bottom) {
            if model.conflictedMutationCount > 0 {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                    Text("A project changed on another device.")
                        .lineLimit(2)
                    Spacer()
                    Button("Keep mine") {
                        Task { await model.resolveConflicts(keepLocalChanges: true) }
                    }
                    Button("Use server") {
                        Task { await model.resolveConflicts(keepLocalChanges: false) }
                    }
                }
                .font(.caption)
                .padding(10)
                .background(.bar)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("juno.mac.project-conflict")
            } else if model.phase == .offline || model.lastErrorDescription != nil {
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
        .accessibilityIdentifier("juno.mac.project-list")
    }

    @ViewBuilder
    private var projectListOverlay: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView("Loading projects…")
        case .ready where model.projects.isEmpty,
             .offline where model.projects.isEmpty:
            ContentUnavailableView(
                "No projects",
                systemImage: "folder",
                description: Text("Create a project to group conversations and files.")
            )
        case .failed where model.projects.isEmpty:
            ContentUnavailableView(
                "Projects unavailable",
                systemImage: "exclamationmark.triangle",
                description: Text(model.lastErrorDescription ?? "Try again.")
            )
        default:
            EmptyView()
        }
    }
}

private struct JunoMacProjectDetail: View {
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
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(project.name).font(.largeTitle.bold())
                        if project.isPending { ProgressView().controlSize(.small) }
                        Spacer()
                    }
                    if project.instructions.isEmpty {
                        Text("No project instructions")
                            .foregroundStyle(.secondary)
                    } else {
                        Text(project.instructions)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                GroupBox("Conversations") {
                    VStack(alignment: .leading, spacing: 0) {
                        if model.selectedConversations.isEmpty {
                            ContentUnavailableView(
                                "No linked conversations",
                                systemImage: "bubble.left",
                                description: Text("Start a conversation with this project's context.")
                            )
                            .frame(maxWidth: .infinity, minHeight: 150)
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
                                            .foregroundStyle(.secondary)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .padding(.vertical, 8)
                                Divider()
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
                        .padding(.top, 10)
                        .disabled(project.isPending || conversationModel == nil)
                    }
                    .padding(8)
                }

                GroupBox("Files") {
                    VStack(alignment: .leading, spacing: 0) {
                        if model.selectedFiles.isEmpty {
                            ContentUnavailableView(
                                "No project files",
                                systemImage: "doc",
                                description: Text("Add reference material for this project.")
                            )
                            .frame(maxWidth: .infinity, minHeight: 150)
                        } else {
                            ForEach(model.selectedFiles) { file in
                                fileRow(file)
                                Divider()
                            }
                        }
                        Button {
                            showingImporter = true
                        } label: {
                            Label("Add file", systemImage: "paperclip")
                        }
                        .padding(.top, 10)
                        .disabled(project.isPending || model.isPerformingFileAction)
                        .accessibilityIdentifier("juno.mac.project-file-add")
                    }
                    .padding(8)
                }
            }
            .padding(28)
            .frame(maxWidth: 900, alignment: .leading)
        }
        .navigationTitle(project.name)
        .toolbar {
            ToolbarItemGroup {
                Button {
                    Task {
                        await model.updateProject(
                            id: project.id,
                            starred: !project.starred
                        )
                    }
                } label: {
                    Label(
                        project.starred ? "Unfavorite" : "Favorite",
                        systemImage: project.starred ? "star.fill" : "star"
                    )
                }
                .disabled(project.isPending || model.isMutating)
                Button("Edit") {
                    editName = project.name
                    editInstructions = project.instructions
                    showingEdit = true
                }
                .disabled(project.isPending || model.isMutating)
                Button("Delete", role: .destructive) { showingDelete = true }
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

    private func fileRow(_ file: NativeProjectFile) -> some View {
        HStack(spacing: 12) {
            Image(systemName: file.kind == "IMAGE" ? "photo" : "doc")
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(file.fileName).lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.isPerformingFileAction { ProgressView().controlSize(.small) }
            Button("Open") { openFile(file) }
            Menu {
                Button("Rename") {
                    renameValue = file.fileName
                    renameFileID = file.id
                }
                Button("Delete", role: .destructive) {
                    Task { await model.deleteFile(id: file.id) }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
        }
        .padding(.vertical, 8)
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
            switch access {
            case .remote(let url):
                previewURL = url
            case .downloaded(let data):
                do {
                    let ext = URL(fileURLWithPath: file.fileName).pathExtension
                        .filter { $0.isLetter || $0.isNumber }
                    let name = "juno-preview-\(UUID().uuidString)"
                        + (ext.isEmpty ? "" : ".\(ext)")
                    let url = FileManager.default.temporaryDirectory
                        .appendingPathComponent(name)
                    try data.write(to: url, options: [.atomic])
                    previewURL = url
                } catch {
                    localError = error.localizedDescription
                }
            }
        }
    }
}

private struct JunoMacLibraryView: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    @State private var kind = "ALL"
    @State private var renameFileID: String?
    @State private var renameValue = ""
    @State private var previewURL: URL?
    @State private var localError: String?

    private var visibleFiles: [NativeProjectFile] {
        kind == "ALL" ? model.files : model.files.filter { $0.kind == kind }
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.phase == .idle || model.phase == .loading {
                    ProgressView("Loading library…")
                } else if visibleFiles.isEmpty {
                    ContentUnavailableView(
                        kind == "ALL" ? "No files" : "No matching files",
                        systemImage: "books.vertical",
                        description: Text("Files and images shared with Juno appear here offline.")
                    )
                } else {
                    List(visibleFiles) { file in
                        HStack(spacing: 12) {
                            Image(systemName: file.kind == "IMAGE" ? "photo" : "doc")
                                .frame(width: 28)
                            Button { openFile(file) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(file.fileName).lineLimit(1)
                                    HStack(spacing: 8) {
                                        Text(ByteCountFormatter.string(
                                            fromByteCount: Int64(file.size),
                                            countStyle: .file
                                        ))
                                        if file.projectID != nil { Text("Project file") }
                                        else if file.conversationID != nil { Text("Conversation file") }
                                    }
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Spacer()
                            Text(file.createdAt, style: .relative)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if model.isPerformingFileAction {
                                ProgressView().controlSize(.small)
                            }
                            Menu {
                                Button("Open") { openFile(file) }
                                Button("Rename") {
                                    renameValue = file.fileName
                                    renameFileID = file.id
                                }
                                Button("Delete", role: .destructive) {
                                    Task { await model.deleteFile(id: file.id) }
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                            .menuStyle(.borderlessButton)
                        }
                        .padding(.vertical, 5)
                    }
                    .accessibilityIdentifier("juno.mac.library-list")
                }
            }
            .navigationTitle("Library")
            .toolbar {
                ToolbarItem {
                    Picker("Kind", selection: $kind) {
                        Text("All").tag("ALL")
                        Text("Images").tag("IMAGE")
                        Text("Files").tag("FILE")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 240)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if model.phase == .offline || model.lastErrorDescription != nil {
                    HStack(spacing: 8) {
                        Image(systemName: model.phase == .offline
                            ? "wifi.slash" : "exclamationmark.circle")
                        Text(model.lastErrorDescription ?? "Offline — showing saved files.")
                        Spacer()
                        Button("Retry") { Task { await model.reload() } }
                    }
                    .font(.caption)
                    .padding(10)
                    .background(.bar)
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
            switch access {
            case .remote(let url):
                previewURL = url
            case .downloaded(let data):
                do {
                    previewURL = try JunoMacExportFile.write(
                        data: data,
                        fileName: file.fileName
                    )
                } catch {
                    localError = error.localizedDescription
                }
            }
        }
    }
}

private struct JunoMacArtifactsView: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    let openConversation: (String) -> Void

    var body: some View {
        NavigationSplitView {
            List(selection: $model.selectedArtifactID) {
                ForEach(model.artifacts) { artifact in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Image(systemName: artifactIcon(artifact.kind))
                            Text(artifact.title).lineLimit(1)
                            Spacer()
                            Text("v\(artifact.currentVersion)")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        HStack {
                            Text(artifact.conversationTitle).lineLimit(1)
                            Spacer()
                            Text(artifact.updatedAt, style: .relative)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .tag(artifact.id)
                }
            }
            .navigationTitle("Artifacts")
            .navigationSplitViewColumnWidth(min: 250, ideal: 310, max: 390)
            .overlay { listOverlay }
        } detail: {
            if let artifact = model.selectedArtifact {
                JunoMacArtifactDetail(
                    model: model,
                    artifact: artifact,
                    openConversation: openConversation
                )
                .id(artifact.id)
            } else {
                ContentUnavailableView("Choose an artifact", systemImage: "square.stack.3d.up")
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
        .accessibilityIdentifier("juno.mac.artifact-list")
    }

    @ViewBuilder
    private var listOverlay: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView("Loading artifacts…")
        case .ready where model.artifacts.isEmpty,
             .offline where model.artifacts.isEmpty:
            ContentUnavailableView(
                "No artifacts",
                systemImage: "square.stack.3d.up",
                description: Text("Artifacts generated in conversations appear here.")
            )
        case .failed where model.artifacts.isEmpty:
            ContentUnavailableView(
                "Artifacts unavailable",
                systemImage: "exclamationmark.triangle",
                description: Text(model.lastErrorDescription ?? "Try again.")
            )
        default:
            EmptyView()
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

private struct JunoMacArtifactDetail: View {
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
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(artifact.title).font(.title2.bold()).lineLimit(1)
                    Button(artifact.conversationTitle) {
                        openConversation(artifact.conversationID)
                    }
                    .buttonStyle(.link)
                }
                Spacer()
                if artifact.versions.count > 1 {
                    Picker("Version", selection: $selectedVersion) {
                        ForEach(artifact.versions.reversed()) { version in
                            Text("v\(version.version)").tag(version.version)
                        }
                    }
                    .frame(width: 110)
                }
                if artifact.kind.supportsRenderedPreview {
                    Picker("View", selection: $displayMode) {
                        Text("Preview").tag(NativeArtifactDisplayMode.preview)
                        Text("Source").tag(NativeArtifactDisplayMode.source)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 180)
                }
                ShareLink(item: version?.content ?? "") {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                .disabled(version == nil)
                if let exportURL {
                    ShareLink(item: exportURL) {
                        Label("Share export", systemImage: "doc.badge.arrow.up")
                    }
                }
            }
            .padding(16)
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
        .toolbar {
            ToolbarItemGroup {
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
                if !model.availableExportFormats.isEmpty {
                    Menu("Export") {
                        ForEach(model.availableExportFormats, id: \.rawValue) { format in
                            Button(format.rawValue.uppercased()) { export(format) }
                        }
                    }
                    .disabled(model.isExporting)
                }
                Button("Edit") {
                    editValue = artifact.currentContent ?? ""
                    showingEditor = true
                }
                .disabled(model.isMutating || artifact.currentContent == nil)
                Menu {
                    Button("Rename") {
                        renameValue = artifact.title
                        showingRename = true
                    }
                    Button("Delete", role: .destructive) { showingDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(model.isMutating)
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
            VStack(spacing: 0) {
                HStack {
                    Text("Edit artifact").font(.headline)
                    Spacer()
                    Button("Cancel") { showingEditor = false }
                    Button("Save") {
                        showingEditor = false
                        Task { await model.saveArtifact(id: artifact.id, content: editValue) }
                    }
                    .keyboardShortcut(.defaultAction)
                }
                .padding()
                Divider()
                TextEditor(text: $editValue)
                    .font(.system(.body, design: .monospaced))
                    .padding(8)
            }
            .frame(minWidth: 680, minHeight: 520)
        }
    }

    private func export(_ format: NativeArtifactExportFormat) {
        Task {
            guard let result = await model.exportArtifact(id: artifact.id, format: format)
            else { return }
            do {
                exportURL = try JunoMacExportFile.write(
                    data: result.data,
                    fileName: result.fileName
                )
            } catch {
                localError = error.localizedDescription
            }
        }
    }
}

private enum JunoMacExportFile {
    static func write(data: Data, fileName: String) throws -> URL {
        let safeName = fileName.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-\(UUID().uuidString)-\(safeName)")
        try data.write(to: url, options: [.atomic])
        return url
    }
}
