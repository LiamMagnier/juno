import JunoAuth
import JunoChatKit
import JunoStorage
import JunoSync
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct JunoMobileRootView: View {
    let authModel: NativeAuthModel
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    @State private var selection: JunoMobileSection? = .chat
    @State private var sidebarSearch = ""

    var body: some View {
        Group {
            switch authModel.phase {
            case .signedIn(let session):
                authenticatedContent(session: session)
            case .restoring:
                ProgressView("auth.restoring")
            case .signedOut, .signingIn, .unavailable:
                JunoMobileSignInView(authModel: authModel)
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
                    rows(for: [.chat, .search, .projects, .files, .artifacts, .tasks, .connections])
                }

                Section("section.code") {
                    rows(for: [.codeCloud, .codeRemote])
                }

                Section("section.account") {
                    rows(for: [.settings])
                }
            }
            .accessibilityIdentifier("juno.mobile.sidebar")
            .navigationTitle("Juno")
            .searchable(text: $sidebarSearch, prompt: "sidebar.search.prompt")
        } detail: {
            if let selection {
                JunoMobileDetailView(
                    section: selection,
                    conversationModel: conversationModel,
                    projectModel: projectModel,
                    openConversation: { id in
                        conversationModel?.selectedConversationID = id
                        self.selection = .chat
                    }
                )
                    .id(selection)
            } else {
                ContentUnavailableView("shell.choose.title", systemImage: "sidebar.left")
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                JunoMobileSyncStatus(model: syncModel)
            }
            ToolbarItem(placement: .topBarTrailing) {
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
                .accessibilityIdentifier("juno.mobile.account-menu")
            }
        }
    }

    @ViewBuilder
    private func rows(for sections: [JunoMobileSection]) -> some View {
        ForEach(filtered(sections)) { section in
            NavigationLink(value: section) {
                Label(section.title, systemImage: section.systemImage)
            }
        }
    }

    private func filtered(_ sections: [JunoMobileSection]) -> [JunoMobileSection] {
        guard !sidebarSearch.isEmpty else { return sections }
        return sections.filter { section in
            section.rawValue.localizedStandardContains(sidebarSearch)
        }
    }
}

private struct JunoMobileSyncStatus: View {
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
                    Image(systemName: "checkmark.icloud.fill")
                case .offline:
                    Image(systemName: "icloud.slash")
                }
            }
            .accessibilityLabel(model.phase == .offline ? "Offline" : "Synced")
            .accessibilityIdentifier("juno.mobile.sync-status")
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

private struct JunoMobileDetailView: View {
    let section: JunoMobileSection
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let openConversation: (String) -> Void

    @ViewBuilder
    var body: some View {
        if section == .chat, let conversationModel {
            JunoMobileConversationsView(model: conversationModel)
        } else if section == .projects, let projectModel {
            JunoMobileProjectsView(
                model: projectModel,
                conversationModel: conversationModel,
                openConversation: openConversation
            )
        } else if section == .files, let projectModel {
            JunoMobileFilesView(model: projectModel)
        } else {
            NavigationStack {
                ContentUnavailableView {
                    Label(section.title, systemImage: section.systemImage)
                } description: {
                    Text("shell.foundation.description")
                }
                .accessibilityIdentifier("juno.mobile.detail")
                .navigationTitle(section.title)
            }
        }
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
                if model.phase == .offline || model.lastErrorDescription != nil {
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
