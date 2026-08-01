import JunoChatKit
import JunoDesignSystem
import JunoStorage
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// **Projects and Artifacts** — two of the three places the account's own
/// content lives. The Library is its own screen, see `JunoMobileLibraryView`.
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

/// One file inside the project's Files card.
///
/// **A row, not a card.** It used to wrap itself in `JunoCard(padding: 12)`, and
/// the only place it is used already puts it inside a `JunoCard(padding: 0)` — so
/// every file was a 16pt-radius card sitting inside a 16pt-radius card, its
/// corners a few points from its parent's, with two hairlines running in
/// parallel. The inset was asymmetric on top of that (16 horizontal, 10
/// vertical), which is what tipped it from "nested" to visibly crooked.
///
/// The conversations section directly above it has always drawn plain rows
/// separated by dividers. This now matches it exactly — same 16/12 padding, same
/// press style, same divider — so the two sections of one screen stop being two
/// different designs.
private struct JunoMobileProjectFileRow: View {
    let file: NativeProjectFile
    let busy: Bool
    var projectName: String?
    let open: () -> Void
    let rename: () -> Void
    let delete: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                JunoWorkspaceGlyph(
                    systemName: file.kind == "IMAGE" ? "photo" : "doc.text",
                    size: 34
                )
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
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(JunoSidebarPressStyle())
        .accessibilityLabel(file.fileName)
    }
}

enum JunoMobileFilePreview {
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

    /// The web's `bg-foreground text-background` inversion, not the accent.
    ///
    /// Coral is spent on primary actions and never on a filter — a row of chips
    /// where the selected one is the brightest thing on the screen reads as five
    /// buttons of which one is urgent. Ink-on-canvas says "this one" just as
    /// clearly and costs the accent nothing. The Mac's connector chips already
    /// follow this rule; this is the phone catching up.
    private func chip(_ kind: NativeArtifactKind?, label: String) -> some View {
        let active = kindFilter == kind
        return Button {
            withAnimation(JunoMobileMotion.easeOutSoft(JunoMobileMotion.durBase)) {
                kindFilter = kind
            }
        } label: {
            Text(label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(active ? Color.junoCanvas : Color.primary)
                .padding(.horizontal, 13)
                .frame(height: 32)
                .background(
                    Capsule().fill(active ? Color.primary : Color.primary.opacity(0.06))
                )
        }
        .buttonStyle(JunoMobileChipPressStyle())
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
struct JunoMobileWorkspaceStatus: View {
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

    /// The project's own identity, stated once in the editorial serif with its
    /// two counts beneath — the same header shape the projects *list* uses for
    /// each card, so opening one does not land somewhere that looks unrelated.
    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(project.name)
                .junoPageHeading(compact: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

            // Scrollable, as the artifact header's chips are. Three chips fit an
            // iPhone in English and do not fit one in German, and a fixed HStack
            // answers that by squeezing every chip until the words truncate.
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    if project.starred {
                        JunoMobileMetaChip(title: "Favourite", systemImage: "star.fill")
                    }
                    JunoMobileMetaChip(
                        title: count(model.selectedConversations.count, "conversation"),
                        systemImage: "bubble.left.and.text.bubble.right"
                    )
                    JunoMobileMetaChip(
                        title: count(model.selectedFiles.count, "file"),
                        systemImage: "paperclip"
                    )
                }
                // 1pt, so the chips' own shadow-free capsules are not clipped by
                // the scroll view's bounds on either edge.
                .padding(.vertical, 1)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.hidden)
        }
        .padding(.top, 6)
    }

    private func count(_ value: Int, _ noun: String) -> String {
        "\(value) \(noun)\(value == 1 ? "" : "s")"
    }

    private var instructionsSection: some View {
        JunoMobileWorkspaceSection(
            title: "Instructions",
            actionTitle: project.instructions.isEmpty ? "Add" : "Edit",
            actionImage: project.instructions.isEmpty ? "plus" : "pencil",
            action: (project.isPending || model.isMutating)
                ? nil
                : {
                    instructionsDraft = project.instructions
                    showingInstructions = true
                },
            footnote: "Included in every conversation linked to this project.",
            identifier: "juno.mobile.project-instructions"
        ) {
            JunoCard {
                if project.instructions.isEmpty {
                    JunoMobileEmptyLine(text: "No project instructions yet.")
                } else {
                    JunoMobileClampedText(text: project.instructions)
                }
            }
        }
    }

    private var conversationsSection: some View {
        JunoMobileWorkspaceSection(
            title: "Conversations",
            actionTitle: "New chat",
            actionImage: "square.and.pencil",
            action: (project.isPending || conversationModel == nil)
                ? nil
                : {
                    Task {
                        if let id = await conversationModel?.createConversation(
                            projectID: project.id
                        ) {
                            openConversation(id)
                        }
                    }
                }
        ) {
            JunoCard(padding: 0) {
                if model.selectedConversations.isEmpty {
                    JunoMobileEmptyLine(text: "No linked conversations yet.")
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(model.selectedConversations.enumerated()), id: \.element.id) {
                            index, conversation in
                            if index > 0 {
                                Divider().padding(.leading, 16)
                            }
                            conversationRow(conversation)
                        }
                    }
                }
            }
        }
    }

    private func conversationRow(_ conversation: NativeProjectConversation) -> some View {
        Button { openConversation(conversation.id) } label: {
            HStack(spacing: 10) {
                if conversation.pinned {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Color.junoAccent)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(conversation.title)
                        .font(.system(size: 15, weight: .medium))
                        .lineLimit(1)
                    Text(conversation.lastMessageAt, style: .relative)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.junoMutedForeground.opacity(0.75))
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.junoMutedForeground.opacity(0.35))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(JunoSidebarPressStyle())
        .accessibilityLabel(conversation.title)
    }

    private var filesSection: some View {
        JunoMobileWorkspaceSection(
            title: "Files",
            actionTitle: "Add file",
            actionImage: "paperclip",
            action: (project.isPending || model.isPerformingFileAction)
                ? nil
                : { showingImporter = true },
            footnote: model.selectedFiles.isEmpty
                ? "Files added here are available to every conversation in the project."
                : nil,
            identifier: "juno.mobile.project-files"
        ) {
            JunoCard(padding: 0) {
                if model.selectedFiles.isEmpty {
                    JunoMobileEmptyLine(text: "No project files yet.")
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(model.selectedFiles.enumerated()), id: \.element.id) {
                            index, file in
                            if index > 0 {
                                Divider().padding(.leading, 16)
                            }
                            // No padding here: the row owns its own, exactly as
                            // `conversationRow` does. Adding it at the call site
                            // is what produced the asymmetric inset around the
                            // nested card this replaced.
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
                }
            }
        }
    }

    /// A scrolling stack of cards, not a `List`.
    ///
    /// This screen was the last `.insetGrouped` `List` in the app: a Settings page
    /// wearing a project's name, opening on forty unbroken lines of `<role>` prompt
    /// text that pushed the project's own conversations and files off the bottom of
    /// the screen. Everything else in the app composes from `JunoCard` on
    /// `junoCanvas`, and the instructions are clamped so the screen's *shape* is
    /// legible before its longest field is.
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                instructionsSection
                conversationsSection
                filesSection
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 28)
            .frame(maxWidth: 768)
            .frame(maxWidth: .infinity)
        }
        .junoScreenCanvas()
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Adjacent items, no `ToolbarSpacer`: from OS 26 the toolbar merges
            // them into one Liquid Glass capsule — star on the leading edge, the
            // menu on the trailing one.
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task {
                        await model.updateProject(
                            id: project.id,
                            starred: !project.starred
                        )
                    }
                } label: {
                    Image(systemName: project.starred ? "star.fill" : "star")
                        .font(.system(size: 15))
                        // Coral only when it is *on*: a starred project is an
                        // active state, which is what the accent is for.
                        .foregroundStyle(project.starred ? Color.junoAccent : Color.primary)
                }
                .disabled(project.isPending || model.isMutating)
                .accessibilityLabel(project.starred ? "Unstar project" : "Star project")
                .accessibilityIdentifier("juno.mobile.project-star")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Rename") {
                        editName = project.name
                        showingRename = true
                    }
                    Button("Delete", role: .destructive) { showingDelete = true }
                } label: {
                    // `ellipsis`, not `ellipsis.circle` — the symbol's own ring
                    // sat inside the capsule the toolbar already draws.
                    Image(systemName: "ellipsis")
                }
                // See the note on the chat header's menu: the tint has to be set
                // on the Menu itself or the glyph takes the accent.
                .tint(Color.primary)
                .disabled(project.isPending || model.isMutating)
                .accessibilityLabel("Project actions")
                .accessibilityIdentifier("juno.mobile.project-menu")
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
                // Monospaced, matching the clamped preview: this is a prompt, and
                // editing it in a proportional face hides the indentation and the
                // angle brackets that give it its structure.
                TextEditor(text: $instructionsDraft)
                    .font(.system(size: 14, design: .monospaced))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .junoScreenCanvas()
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

/// Internal, not private: the chat transcript shows this beside the thread on a
/// wide screen and over it on a phone, which is the two shapes the website's
/// canvas takes.
///
/// **Two chromes, one screen.** Pushed from the Artifacts list this is a *page*:
/// the navigation bar owns the title and the actions, and the artifact's identity
/// is stated once in the editorial serif below it. Opened from a conversation it
/// is the web's *canvas* instead — `close` is non-nil — and it draws
/// `canvas-panel.tsx`'s own header: the title small and semibold, a monospaced
/// meta line under it, then the view switch, share and the close control on one
/// line. That mode deliberately sets no `navigationTitle` and adds no toolbar
/// items: docked, it is a pane inside the *conversation's* navigation stack, and
/// either one would rename the chat the reader is still looking at.
struct JunoMobileArtifactDetail: View {
    @Bindable var model: NativeArtifactModel<SQLiteAccountRepository>
    let artifact: NativeArtifact
    let openConversation: (String) -> Void
    /// Dismisses the canvas. Non-nil only where this view *is* the presentation —
    /// the docked pane and the phone's sheet. Nil when pushed as a page, where
    /// the navigation bar's back button already does this job.
    var close: (() -> Void)?
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

    /// The one place the artifact's own identity is stated: the editorial serif
    /// for the title, then the facts about it as quiet chips. The navigation bar
    /// keeps the title too, for the moment it scrolls away.
    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(artifact.title)
                .junoPageHeading(compact: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    JunoMobileMetaChip(
                        title: artifact.conversationTitle,
                        systemImage: "bubble.left.and.text.bubble.right"
                    ) {
                        openConversation(artifact.conversationID)
                    }
                    JunoMobileMetaChip(title: kindName, systemImage: kindGlyph)
                    if let language = artifact.language, !language.isEmpty {
                        JunoMobileMetaChip(title: language.uppercased())
                    }
                    if artifact.versions.count > 1 {
                        versionChip
                    }
                }
                .padding(.vertical, 1)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.hidden)
        }
    }

    /// The kind as a word rather than a shout: the wire value is `MARKDOWN`, and
    /// a chip full of capitals reads as an error code.
    private var kindName: String {
        switch artifact.kind {
        case .html: "HTML"
        case .react: "React"
        case .code: "Code"
        case .markdown: "Markdown"
        case .svg: "SVG"
        case .mermaid: "Diagram"
        }
    }

    private var kindGlyph: String {
        switch artifact.kind {
        case .react, .html: "curlybraces.square"
        case .svg: "square.on.circle"
        case .mermaid: "flowchart"
        case .markdown: "doc.text"
        case .code: "chevron.left.forwardslash.chevron.right"
        }
    }

    /// A menu rather than a `Picker`: the bare `Picker` in a header rendered as a
    /// naked wheel label with no indication it opened anything.
    private var versionChip: some View {
        Menu {
            ForEach(artifact.versions.reversed()) { candidate in
                Button {
                    selectedVersion = candidate.version
                } label: {
                    if candidate.version == selectedVersion {
                        Label("Version \(candidate.version)", systemImage: "checkmark")
                    } else {
                        Text("Version \(candidate.version)")
                    }
                }
            }
        } label: {
            JunoMobileMetaChip(
                title: "v\(selectedVersion == 0 ? artifact.currentVersion : selectedVersion)",
                systemImage: "clock.arrow.circlepath"
            )
        }
        .accessibilityLabel("Version")
        .accessibilityIdentifier("juno.mobile.artifact-version")
    }

    /// One switch and the shares, on one line. Kinds with nothing to render — a
    /// code artifact — get no switch at all rather than a disabled one.
    private var controls: some View {
        HStack(spacing: 10) {
            if artifact.kind.supportsRenderedPreview {
                JunoMobileSegmented(
                    options: [
                        .init(NativeArtifactDisplayMode.preview, "Preview"),
                        .init(NativeArtifactDisplayMode.source, "Source"),
                    ],
                    selection: $displayMode,
                    accessibilityLabel: "View"
                )
                .accessibilityIdentifier("juno.mobile.artifact-view-mode")
            }

            Spacer(minLength: 0)

            ShareLink(item: version?.content ?? "") {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.primary.opacity(0.75))
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .disabled(version == nil)
            .accessibilityLabel("Share source")

            if let exportURL {
                ShareLink(item: exportURL) {
                    Image(systemName: "doc.badge.arrow.up")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.primary.opacity(0.75))
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Share export")
            }
        }
    }

    /// The website's canvas header: identity, then one line of monospaced facts,
    /// then the controls. `canvas-panel.tsx` draws the same three things in the
    /// same order, and the mono line is what makes an artifact read as a *file*
    /// rather than as another card in the chat.
    private var canvasHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(artifact.title)
                        .font(.system(size: 15, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .accessibilityAddTraits(.isHeader)
                    Text(metaLine)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.junoMutedForeground)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 6)
                if let version, version.version != artifact.currentVersion {
                    restoreButton
                }
                actionsMenu
                if let close {
                    Button(action: close) {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close artifact")
                    .accessibilityIdentifier("juno.mobile.artifact-close")
                }
            }

            HStack(spacing: 10) {
                if artifact.versions.count > 1 { versionChip }
                controls
            }
        }
        .padding(.horizontal, 14)
        // Taller at the top than the bottom: presented as a sheet there is no
        // navigation bar above this, only the drag indicator, and a title that
        // starts flush under it reads as a collision.
        .padding(.top, 16)
        .padding(.bottom, 10)
        // `bg-card/50` over a hairline: the header is chrome, so it reads one
        // step off the canvas the artifact itself sits on.
        .background(Color.junoSurface.opacity(0.5))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.junoHairline)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
    }

    /// `runtime · where it came from · version`, the web's own order.
    private var metaLine: String {
        var parts = [kindName]
        if let language = artifact.language, !language.isEmpty {
            parts.append(language.uppercased())
        }
        parts.append("From this conversation")
        parts.append("v\(selectedVersion == 0 ? artifact.currentVersion : selectedVersion)")
        return parts.joined(separator: " · ")
    }

    private var restoreButton: some View {
        Button("Restore") {
            guard let version else { return }
            Task { await model.restoreArtifact(id: artifact.id, version: version.version) }
        }
        .disabled(model.isMutating)
    }

    /// Whichever header this presentation calls for, then the artifact itself.
    private var surface: some View {
        VStack(spacing: 0) {
            if close == nil {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    controls
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 14)
            } else {
                canvasHeader
            }

            if let version {
                NativeArtifactPreview(
                    kind: artifact.kind,
                    content: version.content,
                    mode: displayMode
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous)
                        .fill(Color.junoSurface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous)
                        .strokeBorder(Color.junoHairline, lineWidth: 1)
                )
                .padding(.horizontal, close == nil ? 16 : 12)
                .padding(.top, close == nil ? 0 : 12)
                .padding(.bottom, close == nil ? 16 : 12)
            } else {
                ContentUnavailableView(
                    "Version unavailable",
                    systemImage: "clock.arrow.circlepath",
                    description: Text("Reconnect to hydrate the latest artifact content.")
                )
            }
        }
        .junoScreenCanvas()
    }

    /// The navigation chrome, applied **only** in page mode.
    ///
    /// Docked, this view is a pane inside the conversation's own navigation
    /// stack: a `navigationTitle` here would rename the chat the reader is still
    /// looking at, and a `toolbar` would move the artifact's actions onto the
    /// conversation's bar. Both live in ``canvasHeader`` in that mode instead.
    @ViewBuilder
    private func pageChrome(_ content: some View) -> some View {
        if close == nil {
            content
                .navigationTitle(artifact.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if let version, version.version != artifact.currentVersion {
                        ToolbarItem(placement: .topBarTrailing) { restoreButton }
                    }
                    ToolbarItem(placement: .topBarTrailing) { actionsMenu }
                }
        } else {
            content
        }
    }

    /// The overflow, shared by the page's navigation bar and the canvas header so
    /// an artifact opened from a chat can do everything one opened from the
    /// library can.
    private var actionsMenu: some View {
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
            Image(systemName: "ellipsis")
        }
        .tint(Color.primary)
        .disabled(model.isMutating || model.isExporting)
        .accessibilityLabel("Artifact actions")
        .accessibilityIdentifier("juno.mobile.artifact-menu")
    }

    /// Header, then one switch, then the artifact — with the artifact getting the
    /// screen.
    ///
    /// What this replaces: a coral text button standing in for a link to the
    /// conversation, a full-width `.segmented` `Picker`, a naked `Picker` for the
    /// version, and a second coral row reading "Share source" — four competing
    /// controls stacked above a hairline, and *then* the thing the screen is
    /// about. The identity is now stated once at the top, the facts are quiet
    /// chips, Share is an icon beside the switch, and the artifact starts higher
    /// up the screen than it used to end.
    var body: some View {
        pageChrome(surface)
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
                    .junoScreenCanvas()
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
