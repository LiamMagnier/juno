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
            } else {
                syncModel?.stop()
                conversationModel?.stop()
                projectModel?.stop()
            }
        }
        .onChange(of: syncModel?.synchronizationGeneration) { _, generation in
            guard let generation else { return }
            Task { await conversationModel?.synchronizationDidAdvance(to: generation) }
            Task { await projectModel?.synchronizationDidAdvance(to: generation) }
        }
        .onChange(of: syncModel?.phase) { _, _ in
            Task { await conversationModel?.reload() }
            Task { await projectModel?.reload() }
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
                openConversation: { id in
                    conversationModel?.selectedConversationID = id
                    selection = .chat
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
    let openConversation: (String) -> Void

    @ViewBuilder
    var body: some View {
        if section == .chat, let conversationModel {
            JunoMacConversationsView(model: conversationModel)
        } else if section == .projects, let projectModel {
            JunoMacProjectsView(
                model: projectModel,
                conversationModel: conversationModel,
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
            if model.phase == .offline || model.lastErrorDescription != nil {
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
