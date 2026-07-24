import JunoChatKit
import JunoDesignSystem
import JunoStorage
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// **Projects, Library and Artifacts** — the three places the account's own
/// content lives.
///
/// All three were plain `List`s with an SF Symbol, a bold line and a grey line:
/// the default shape you get for free, which is why they read as filler beside
/// the rest of the app. They are rebuilt here on the same system as Connections,
/// Tasks and Code — a serif page heading, cards on the warm canvas, a monospaced
/// metadata line, and grouping that means something (favourites, file kind,
/// artifact kind) rather than one undifferentiated column.

// MARK: - Projects

struct JunoMobileProjectsView: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let openConversation: (String) -> Void
    @State private var showingCreate = false
    @State private var createName = ""
    @State private var createInstructions = ""
    @State private var renameTarget: NativeProject?
    @State private var renameValue = ""
    @State private var deleteTarget: NativeProject?

    private var favourites: [NativeProject] { model.projects.filter(\.starred) }
    private var others: [NativeProject] { model.projects.filter { !$0.starred } }

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                JunoMobileQuietLoading()
            case .failed where model.projects.isEmpty:
                ContentUnavailableView {
                    Label("Projects unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(model.lastErrorDescription ?? "Check your connection and try again.")
                } actions: {
                    Button("Retry") { Task { await model.reload() } }
                        .buttonStyle(.borderedProminent)
                }
            default:
                content
            }
        }
        .background(Color.junoCanvas)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { startCreate() } label: { Image(systemName: "plus") }
                    .disabled(model.isMutating)
                    .accessibilityLabel("New project")
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
        .alert("New project", isPresented: $showingCreate) {
            TextField("Name", text: $createName)
            TextField("Instructions", text: $createInstructions)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                Task {
                    await model.createProject(
                        name: createName, instructions: createInstructions
                    )
                }
            }
        } message: {
            Text("Project instructions are included in every linked conversation.")
        }
        .alert("Rename project", isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )) {
            TextField("Name", text: $renameValue)
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Save") {
                if let target = renameTarget {
                    Task { await model.updateProject(id: target.id, name: renameValue) }
                }
                renameTarget = nil
            }
        }
        .confirmationDialog(
            deleteTarget.map { "Delete “\($0.name)”?" } ?? "",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete project", role: .destructive) {
                if let target = deleteTarget {
                    Task { await model.deleteProject(id: target.id) }
                }
                deleteTarget = nil
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("Conversations are kept and unlinked; project files are removed.")
        }
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                JunoPageTitle(title: "navigation.projects", subtitle: "projects.subtitle")
                    .padding(.top, 6)

                JunoMobileWorkspaceStatus(
                    conflicted: model.conflictedMutationCount > 0,
                    offline: model.phase == .offline,
                    message: model.lastErrorDescription,
                    conflictMessage: "A project changed on another device.",
                    offlineMessage: "Offline — showing saved projects.",
                    retry: { Task { await model.reload() } },
                    keepMine: { Task { await model.resolveConflicts(keepLocalChanges: true) } },
                    useServer: { Task { await model.resolveConflicts(keepLocalChanges: false) } }
                )

                if model.projects.isEmpty {
                    empty
                } else {
                    if !favourites.isEmpty {
                        JunoGroupLabel(text: "Favourites")
                        ForEach(favourites) { card($0) }
                    }
                    if !others.isEmpty {
                        if !favourites.isEmpty { JunoGroupLabel(text: "All projects") }
                        ForEach(others) { card($0) }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .accessibilityIdentifier("juno.mobile.project-list")
    }

    private var empty: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("No projects yet").font(.system(size: 17, weight: .semibold))
                Text("A project groups conversations and files, and gives every chat in it the same standing instructions.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Button { startCreate() } label: {
                    Text("New project")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 18)
                        .frame(height: 40)
                        .modifier(JunoAccentGlassCapsule())
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
        }
    }

    private func card(_ project: NativeProject) -> some View {
        let conversations = model.conversationsByProject[project.id]?.count ?? 0
        let files = model.filesByProject[project.id]?.count ?? 0
        return NavigationLink(value: project.id) {
            JunoCard(padding: 14) {
                HStack(alignment: .top, spacing: 13) {
                    JunoWorkspaceGlyph(systemName: "folder")
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(project.name)
                                .font(JunoSerif.cardTitle)
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            if project.starred {
                                Image(systemName: "star.fill")
                                    .font(.caption2)
                                    .foregroundStyle(Color.junoAccent)
                                    .accessibilityLabel("Favourite")
                            }
                            if project.isPending {
                                Image(systemName: "arrow.triangle.2.circlepath")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .accessibilityLabel("Waiting to sync")
                            }
                        }
                        Text("^[\(conversations) conversation](inflect: true) · ^[\(files) file](inflect: true)")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                        if !project.instructions.isEmpty {
                            // Flattened to one run of text. Instructions are
                            // often structured ("<role>\n You are…"), and
                            // showing them verbatim spent the card's first
                            // preview line on a lone opening tag.
                            Text(
                                project.instructions
                                    .split(whereSeparator: \.isNewline)
                                    .joined(separator: " ")
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 4)
                }
            }
        }
        .buttonStyle(.plain)
        .contextMenu { projectMenu(project) }
    }

    @ViewBuilder
    private func projectMenu(_ project: NativeProject) -> some View {
        Button {
            Task { await model.updateProject(id: project.id, starred: !project.starred) }
        } label: {
            Label(
                project.starred ? "Remove favourite" : "Favourite",
                systemImage: project.starred ? "star.slash" : "star"
            )
        }
        Button {
            renameValue = project.name
            renameTarget = project
        } label: {
            Label("Rename", systemImage: "pencil")
        }
        Divider()
        Button(role: .destructive) { deleteTarget = project } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    private func startCreate() {
        createName = ""
        createInstructions = ""
        showingCreate = true
    }
}

// MARK: - Library

struct JunoMobileFilesView: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    @State private var renameFileID: String?
    @State private var renameValue = ""
    @State private var previewURL: URL?
    @State private var localError: String?
    @State private var searchText = ""

    private var filteredFiles: [NativeProjectFile] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return model.files }
        return model.files.filter { $0.fileName.localizedCaseInsensitiveContains(query) }
    }

    /// Images and documents are looked for differently — you scan images by
    /// shape and documents by name — so they are separated rather than
    /// interleaved by upload date.
    private var images: [NativeProjectFile] { filteredFiles.filter { $0.kind == "IMAGE" } }
    private var documents: [NativeProjectFile] { filteredFiles.filter { $0.kind != "IMAGE" } }

    var body: some View {
        Group {
            if model.phase == .loading || model.phase == .idle {
                JunoMobileQuietLoading()
            } else {
                content
            }
        }
        .background(Color.junoCanvas)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search files"
        )
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

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                JunoPageTitle(title: "navigation.library", subtitle: "library.subtitle")
                    .padding(.top, 6)

                JunoMobileWorkspaceStatus(
                    conflicted: false,
                    offline: model.phase == .offline,
                    message: model.lastErrorDescription,
                    conflictMessage: "",
                    offlineMessage: "Offline — showing saved files.",
                    retry: { Task { await model.reload() } },
                    keepMine: {},
                    useServer: {}
                )

                if model.files.isEmpty {
                    JunoCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("No files yet").font(.system(size: 17, weight: .semibold))
                            Text("Anything you attach to a chat or upload to a project is kept here, and stays readable offline.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                } else if filteredFiles.isEmpty {
                    Text("Nothing matches “\(searchText)”.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                } else {
                    if !images.isEmpty {
                        JunoGroupLabel(text: "Images")
                        ForEach(images) { row($0) }
                    }
                    if !documents.isEmpty {
                        JunoGroupLabel(text: "Documents")
                        ForEach(documents) { row($0) }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .accessibilityIdentifier("juno.mobile.file-list")
    }

    private func row(_ file: NativeProjectFile) -> some View {
        JunoMobileProjectFileRow(
            file: file,
            busy: model.isPerformingFileAction,
            projectName: file.projectID.flatMap { pid in
                model.projects.first { $0.id == pid }?.name
            },
            open: { openFile(file) },
            rename: {
                renameValue = file.fileName
                renameFileID = file.id
            },
            delete: { Task { await model.deleteFile(id: file.id) } }
        )
    }

    private func openFile(_ file: NativeProjectFile) {
        Task {
            guard let access = await model.accessFile(id: file.id) else { return }
            do {
                previewURL = try JunoMobileFilePreview.url(for: access, fileName: file.fileName)
            } catch {
                localError = error.localizedDescription
            }
        }
    }
}

private struct JunoMobileProjectFileRow: View {
    let file: NativeProjectFile
    let busy: Bool
    var projectName: String?
    let open: () -> Void
    let rename: () -> Void
    let delete: () -> Void

    var body: some View {
        Button(action: open) {
            JunoCard(padding: 12) {
                HStack(spacing: 12) {
                    JunoWorkspaceGlyph(systemName: file.kind == "IMAGE" ? "photo" : "doc.text")
                    VStack(alignment: .leading, spacing: 3) {
                        Text(file.fileName)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        HStack(spacing: 5) {
                            Text(
                                ByteCountFormatter.string(
                                    fromByteCount: Int64(file.size), countStyle: .file
                                )
                            )
                            if let projectName, !projectName.isEmpty {
                                Text("· \(projectName)").lineLimit(1)
                            }
                        }
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                    if busy { ProgressView().controlSize(.small) }
                    Menu {
                        Button("Open", action: open)
                        Button("Rename", action: rename)
                        Divider()
                        Button("Delete", role: .destructive, action: delete)
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("File options")
                }
            }
        }
        .buttonStyle(.plain)
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

// MARK: - Artifacts

struct JunoMobileArtifactsView: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    let openConversation: (String) -> Void
    @State private var searchText = ""
    @State private var kindFilter: NativeArtifactKind?

    private var filteredArtifacts: [NativeArtifact] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.artifacts.filter { artifact in
            if let kindFilter, artifact.kind != kindFilter { return false }
            guard !query.isEmpty else { return true }
            return artifact.title.localizedCaseInsensitiveContains(query)
                || artifact.conversationTitle.localizedCaseInsensitiveContains(query)
        }
    }

    /// Only the kinds actually present. A filter row offering six chips when the
    /// account has two artifacts is a menu of dead ends.
    private var availableKinds: [NativeArtifactKind] {
        NativeArtifactKind.allCases.filter { kind in
            model.artifacts.contains { $0.kind == kind }
        }
    }

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                JunoMobileQuietLoading()
            case .failed where model.artifacts.isEmpty:
                ContentUnavailableView {
                    Label("Artifacts unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(model.lastErrorDescription ?? "Check your connection and try again.")
                } actions: {
                    Button("Retry") { Task { await model.reload() } }
                        .buttonStyle(.borderedProminent)
                }
            default:
                content
            }
        }
        .background(Color.junoCanvas)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search artifacts"
        )
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
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                JunoPageTitle(title: "navigation.artifacts", subtitle: "artifacts.subtitle")
                    .padding(.top, 6)

                JunoMobileWorkspaceStatus(
                    conflicted: false,
                    offline: model.phase == .offline,
                    message: model.lastErrorDescription,
                    conflictMessage: "",
                    offlineMessage: "Offline — showing saved artifacts.",
                    retry: { Task { await model.reload() } },
                    keepMine: {},
                    useServer: {}
                )

                if availableKinds.count > 1 { kindChips }

                if model.artifacts.isEmpty {
                    JunoCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("No artifacts yet").font(.system(size: 17, weight: .semibold))
                            Text("When Juno builds a page, a component or a diagram in a chat, it is kept here — every version of it.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                } else if filteredArtifacts.isEmpty {
                    Text("Nothing matches this search.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                } else {
                    ForEach(filteredArtifacts) { card($0) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .accessibilityIdentifier("juno.mobile.artifact-list")
    }

    private var kindChips: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                chip(nil, label: "All")
                ForEach(availableKinds, id: \.self) { kind in
                    chip(kind, label: Self.kindLabel(kind))
                }
            }
            .padding(.vertical, 1)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize)
    }

    private func chip(_ kind: NativeArtifactKind?, label: String) -> some View {
        let active = kindFilter == kind
        return Button {
            kindFilter = kind
        } label: {
            Text(label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(active ? Color.white : Color.primary)
                .padding(.horizontal, 13)
                .frame(height: 32)
                .background(
                    Capsule().fill(active ? Color.junoAccent : Color.primary.opacity(0.06))
                )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
    }

    private func card(_ artifact: NativeArtifact) -> some View {
        NavigationLink(value: artifact.id) {
            JunoCard(padding: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        JunoWorkspaceGlyph(systemName: Self.kindIcon(artifact.kind), size: 32)
                        Text(Self.kindLabel(artifact.kind).uppercased())
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.tertiary)
                        Spacer(minLength: 4)
                        JunoStatusPill(
                            text: "v\(artifact.currentVersion)", tint: Color.junoAccent
                        )
                    }
                    Text(artifact.title)
                        .font(JunoSerif.cardTitle)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 5) {
                        Image(systemName: "bubble.left")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text(artifact.conversationTitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Text("·").foregroundStyle(.tertiary)
                        Text(artifact.updatedAt.formatted(.relative(presentation: .named)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    private static func kindIcon(_ kind: NativeArtifactKind) -> String {
        switch kind {
        case .html: "globe"
        case .react: "atom"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .markdown: "doc.text"
        case .svg: "scribble.variable"
        case .mermaid: "flowchart"
        }
    }

    private static func kindLabel(_ kind: NativeArtifactKind) -> String {
        switch kind {
        case .html: "Page"
        case .react: "Component"
        case .code: "Code"
        case .markdown: "Document"
        case .svg: "Vector"
        case .mermaid: "Diagram"
        }
    }
}

// MARK: - Shared

/// The tinted rounded-square a workspace row leads with. A bare SF Symbol on the
/// canvas is what made these lists read as unfinished; a contained glyph gives
/// the row a left edge to align to.
private struct JunoWorkspaceGlyph: View {
    let systemName: String
    var size: CGFloat = 38

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(Color.junoAccent.opacity(0.12))
            Image(systemName: systemName)
                .font(.system(size: size * 0.44))
                .foregroundStyle(Color.junoAccent)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The offline / error / conflict strip these three screens share.
///
/// It sits *in* the scroll content rather than pinned over the bottom edge: as a
/// `safeAreaInset` it covered the last row on every one of these screens, and an
/// offline notice that hides your most recent file is worse than the outage it
/// is reporting.
private struct JunoMobileWorkspaceStatus: View {
    let conflicted: Bool
    let offline: Bool
    let message: String?
    let conflictMessage: String
    let offlineMessage: String
    let retry: () -> Void
    let keepMine: () -> Void
    let useServer: () -> Void

    var body: some View {
        if conflicted {
            JunoCard(padding: 12) {
                VStack(alignment: .leading, spacing: 10) {
                    Label(conflictMessage, systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 10) {
                        Button("Keep mine", action: keepMine)
                        Spacer(minLength: 0)
                        Button("Use server version", action: useServer)
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.junoAccent)
                }
            }
            .accessibilityIdentifier("juno.mobile.project-conflict")
        } else if offline || message != nil {
            JunoInlineError(message: message ?? offlineMessage, retry: retry)
        }
    }
}
private struct JunoMobileProjectDetail: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let project: NativeProject
    let openConversation: (String) -> Void
    @State private var showingRename = false
    @State private var editName = ""
    @State private var showingInstructions = false
    @State private var instructionsDraft = ""
    @State private var showingDelete = false
    @State private var showingImporter = false
    @State private var renameFileID: String?
    @State private var renameValue = ""
    @State private var previewURL: URL?
    @State private var localError: String?

    var body: some View {
        List {
            Section {
                Text(project.instructions.isEmpty
                    ? "No project instructions yet." : project.instructions)
                    .foregroundStyle(project.instructions.isEmpty ? .secondary : .primary)
                Button {
                    instructionsDraft = project.instructions
                    showingInstructions = true
                } label: {
                    Label("Edit instructions", systemImage: "pencil")
                }
                .disabled(project.isPending || model.isMutating)
                .accessibilityIdentifier("juno.mobile.project-edit-instructions")
            } header: {
                Text("Instructions")
            } footer: {
                Text("Included in every conversation linked to this project.")
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
                    Button("Rename") {
                        editName = project.name
                        showingRename = true
                    }
                    Button("Delete", role: .destructive) { showingDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(project.isPending || model.isMutating)
            }
        }
        .alert("Rename project", isPresented: $showingRename) {
            TextField("Name", text: $editName)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task { await model.updateProject(id: project.id, name: editName) }
            }
        }
        .sheet(isPresented: $showingInstructions) {
            NavigationStack {
                TextEditor(text: $instructionsDraft)
                    .font(.body)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .navigationTitle("Instructions")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showingInstructions = false }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            if model.isMutating {
                                ProgressView()
                            } else {
                                Button("Save") {
                                    Task {
                                        await model.updateProject(
                                            id: project.id, instructions: instructionsDraft
                                        )
                                        showingInstructions = false
                                    }
                                }
                            }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
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
