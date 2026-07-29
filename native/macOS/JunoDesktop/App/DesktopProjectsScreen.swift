import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoVoiceKit
import SwiftUI
import UniformTypeIdentifiers

/// A focused project workspace: native index on the left, the selected
/// project's actual contents on the right.
///
/// The previous card-grid-plus-inspector composition produced three competing
/// hierarchies inside one window: global navigation, oversized cards, then a
/// cramped 320-point inspector containing the information the user came to
/// read. This is the macOS document-browser pattern instead. Projects are rows
/// that can be scanned and keyboard-selected; the selected project receives the
/// available reading width for its instructions, chats, and files.
struct DesktopProjectsScreen: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    @Bindable var conversationModel: NativeConversationModel<SQLiteAccountRepository>
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    let openConversation: (String) -> Void
    let startConversation: (String, String?) -> Void

    @State private var sortOrder: [KeyPathComparator<DesktopProjectRow>] = []
    @State private var query = ""
    @State private var showingNewProject = false
    @State private var showingFileImporter = false
    @State private var editingInstructionsFor: NativeProject?
    @State private var renameTarget: NativeProject?
    @State private var renameDraft = ""
    @State private var deleteTarget: NativeProject?
    @State private var showingProjectBrowser = false
    @State private var voiceSession: DesktopVoiceSession?

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The model already orders projects the way the product does — favourites
    /// first, then most recently updated — so an untouched table shows that
    /// order and only a clicked header takes it over.
    ///
    /// The filter matches the web page's: name *and* instructions, because a
    /// project's instructions are often the only place its subject is written
    /// down.
    private var rows: [DesktopProjectRow] {
        let needle = trimmedQuery
        let matching = needle.isEmpty
            ? model.projects
            : model.projects.filter {
                $0.name.localizedCaseInsensitiveContains(needle)
                    || $0.instructions.localizedCaseInsensitiveContains(needle)
            }
        let rows = matching.map { project in
            DesktopProjectRow(
                project: project,
                conversationCount: model.conversationsByProject[project.id]?.count ?? 0,
                fileCount: model.filesByProject[project.id]?.count ?? 0
            )
        }
        return sortOrder.isEmpty ? rows : rows.sorted(using: sortOrder)
    }

    var body: some View {
        Color.clear
            .overlay { projectWorkspace }
            .overlay(alignment: .bottom) { statusControl }
            .sheet(isPresented: $showingNewProject) {
                DesktopNewProjectSheet(model: model)
            }
            .sheet(item: $editingInstructionsFor) { project in
                DesktopProjectInstructionsSheet(project: project) { instructions in
                    await model.updateProject(id: project.id, instructions: instructions)
                }
            }
            .fileImporter(
                isPresented: $showingFileImporter,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true
            ) { result in
                guard case .success(let urls) = result,
                    let projectID = model.selectedProjectID
                else { return }
                Task {
                    await DesktopProjectFiles.upload(urls, projectID: projectID, model: model)
                }
            }
            .alert("Rename project", isPresented: presenting($renameTarget)) {
                TextField("Name", text: $renameDraft)
                Button("Cancel", role: .cancel) { renameTarget = nil }
                Button("Rename") {
                    if let target = renameTarget {
                        Task { await model.updateProject(id: target.id, name: renameDraft) }
                    }
                    renameTarget = nil
                }
            }
            .confirmationDialog(
                deleteTarget.map { "Delete “\($0.name)”?" } ?? "",
                isPresented: presenting($deleteTarget),
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
                Text("Chats stay in Juno and are unlinked from the project. The project's files are removed.")
            }
            .sheet(item: $voiceSession) { session in
                voiceSheet(session)
            }
    }

    // MARK: - Workspace

    private var projectWorkspace: some View {
        Group {
            if model.projects.isEmpty {
                projectIndex
            } else if showingProjectBrowser {
                projectBrowser
            } else {
                projectDetail
            }
        }
        .onChange(of: model.selectedProjectID) { oldValue, newValue in
            if showingProjectBrowser, oldValue != newValue, newValue != nil {
                showingProjectBrowser = false
            }
        }
    }

    private var projectBrowser: some View {
        VStack(spacing: 0) {
            DesktopScreenHeader(
                "Projects",
                subtitle: headerSubtitle
            ) {
                Button {
                    startCreate()
                } label: {
                    Label("New project", systemImage: "folder.badge.plus")
                }
                .keyboardShortcut("n", modifiers: [.command, .shift])
            }

            HStack(spacing: JunoSpace.tight) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search projects", text: $query)
                    .textFieldStyle(.plain)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 32)
            .background(.quaternary, in: RoundedRectangle(
                cornerRadius: JunoRadius.control,
                style: .continuous
            ))
            .frame(maxWidth: 560)
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.vertical, JunoSpace.regular)

            Divider()
            content
        }
        .accessibilityIdentifier("Projects browser")
    }

    private var projectIndex: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Projects")
                        .font(.title2.weight(.semibold))
                    Spacer(minLength: JunoSpace.snug)
                    Text(model.projects.count.formatted())
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(
                            model.projects.count == 1 ? "1 project" : "\(model.projects.count) projects"
                        )
                }

                HStack(spacing: JunoSpace.tight) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.tertiary)
                    TextField("Filter projects", text: $query)
                        .textFieldStyle(.plain)
                }
                .padding(.horizontal, JunoSpace.cozy)
                .frame(height: 30)
                .background(.quaternary, in: RoundedRectangle(
                    cornerRadius: JunoRadius.control,
                    style: .continuous
                ))
                .accessibilityIdentifier("Projects search")
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.regular)
            .padding(.bottom, JunoSpace.cozy)

            Divider()
            content
        }
        .background(.bar)
        .accessibilityIdentifier("Projects index")
    }

    private var headerSubtitle: String {
        let total = model.projects.count
        guard total > 0 else {
            return "Instructions you set on a project apply to every chat inside it."
        }
        guard !trimmedQuery.isEmpty else {
            return total == 1 ? "1 project" : "\(total) projects"
        }
        return "\(rows.count) of \(total) match “\(trimmedQuery)”"
    }

    @ViewBuilder
    private var content: some View {
        if model.projects.isEmpty {
            switch model.phase {
            case .idle, .loading:
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("Loading projects")
            case .failed:
                // Through the shared copy for the same reason the status bar is:
                // an empty screen whose only explanation is the word "Not found"
                // tells the reader nothing about what to do next.
                JunoEmptyState(
                    title: "Projects unavailable",
                    message: DesktopStatusCopy(subject: "projects", singular: "project")
                        .humanized(
                            model.lastErrorDescription,
                            fallback: "Check your connection and try again."
                        ),
                    symbol: "exclamationmark.triangle",
                    actionLabel: "Try again",
                    action: { Task { await model.reload() } }
                )
            case .ready, .offline:
                JunoEmptyState(
                    title: "No projects yet",
                    message: "A project keeps one topic's chats, files and instructions together, and applies those instructions to every chat inside it.",
                    symbol: "folder",
                    actionLabel: "New project",
                    action: startCreate
                )
            }
        } else if rows.isEmpty {
            JunoEmptyState(
                title: "No projects match your search",
                message: "Juno searched project names and instructions.",
                symbol: "magnifyingglass",
                actionLabel: "Clear search",
                action: { query = "" }
            )
        } else {
            projectList
        }
    }

    private var projectList: some View {
        List(selection: $model.selectedProjectID) {
            if rows.contains(where: \.project.starred) {
                Section("Favourites") {
                    ForEach(rows.filter(\.project.starred)) { projectListRow($0) }
                }
            }
            Section(rows.contains(where: \.project.starred) ? "All Projects" : "") {
                ForEach(rows.filter { !$0.project.starred }) { projectListRow($0) }
            }
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
        .junoSidebarSelectionTint()
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Divider()
                Button(action: startCreate) {
                    Label("New project", systemImage: "folder.badge.plus")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .help("Create a project (⇧⌘N)")
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.cozy)
                .accessibilityIdentifier("New project")
            }
            .background(.bar)
        }
        .contextMenu(forSelectionType: DesktopProjectRow.ID.self) { ids in
            rowMenu(ids)
        }
        .onDeleteCommand {
            if let project = model.selectedProject { deleteTarget = project }
        }
        .accessibilityIdentifier("Projects list")
    }

    private func projectListRow(_ row: DesktopProjectRow) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            Image(systemName: row.project.starred ? "folder.fill" : "folder")
                .foregroundStyle(row.project.starred ? Color.junoAccent : Color.secondary)
                .frame(width: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: JunoSpace.tight) {
                    Text(row.name)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    if row.project.isPending {
                        ProgressView()
                            .controlSize(.mini)
                            .accessibilityLabel("Waiting to sync")
                    }
                }
                Text(row.instructionsPreview)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text("\(row.conversationCount) chats · \(row.fileCount) files")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: JunoSpace.tight)
        }
        .junoSidebarRowInk()
        .padding(.vertical, JunoSpace.hairline)
        .contentShape(.rect)
        .onTapGesture {
            model.selectedProjectID = row.id
            showingProjectBrowser = false
        }
        .tag(row.id)
        .help(row.instructionsPreview)
    }

    /// The website's grid of project cards.
    ///
    /// This replaced a four-column `Table`. The table was defensible on paper —
    /// it sorts, it is dense, it is the Mac idiom for tabular data — but a
    /// project is not a row of numbers. What identifies one is its **name and
    /// its instructions**, and the instructions are the thing the web page leads
    /// with and the table could only show as a truncated caption in a 360pt
    /// column. Side by side with the website the two read as different products,
    /// which is the complaint this answers.
    ///
    /// Selection still drives the inspector, so nothing about the Mac's
    /// two-pane behaviour is lost; only the presentation of the list changed.
    private var projectGrid: some View {
        ScrollView {
            LazyVGrid(
                columns: [
                    GridItem(
                        .adaptive(
                            minimum: DesktopProjectGrid.minimumCardWidth,
                            maximum: DesktopProjectGrid.maximumCardWidth
                        ),
                        spacing: JunoSpace.regular,
                        alignment: .top
                    )
                ],
                spacing: JunoSpace.regular
            ) {
                ForEach(rows) { row in
                    DesktopProjectCard(
                        row: row,
                        isSelected: model.selectedProjectID == row.id,
                        open: {
                            model.selectedProjectID = row.id
                        },
                        menu: { rowMenu([row.id]) }
                    )
                }
            }
            .padding(.bottom, JunoSpace.region)
        }
        .scrollBounceBehavior(.basedOnSize)
        .accessibilityIdentifier("Projects grid")
    }

    private var projectTable: some View {
        Table(rows, selection: $model.selectedProjectID, sortOrder: $sortOrder) {
            TableColumn("Project", value: \.name) { row in
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(.projects, size: 15)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        HStack(spacing: JunoSpace.hairline) {
                            Text(row.project.name)
                                .junoRowLabel()
                                .lineLimit(1)
                            if row.project.starred {
                                Image(systemName: "star.fill")
                                    .font(.caption2)
                                    .foregroundStyle(Color.junoAccent)
                                    .accessibilityLabel("Favourite")
                            }
                            if row.project.isPending {
                                ProgressView()
                                    .controlSize(.mini)
                                    .accessibilityLabel("Waiting to sync")
                            }
                        }
                        // The web's project card shows the instructions under the
                        // name, and that preview is usually the only thing that
                        // tells two similarly-named projects apart.
                        Text(row.instructionsPreview)
                            .junoCaption()
                            .lineLimit(1)
                    }
                }
                .help(row.instructionsPreview)
            }
            .width(min: 220, ideal: 360)

            TableColumn("Chats", value: \.conversationCount) { row in
                Text(row.conversationCount.formatted())
                    .junoCaption()
                    .monospacedDigit()
            }
            .width(min: 56, ideal: 64, max: 96)

            TableColumn("Files", value: \.fileCount) { row in
                Text(row.fileCount.formatted())
                    .junoCaption()
                    .monospacedDigit()
            }
            .width(min: 56, ideal: 64, max: 96)

            // Relative, as the web's card footer is ("Updated 3d ago"). The
            // column still sorts on the real date, and the absolute one is a
            // pointer away.
            TableColumn("Updated", value: \.updatedAt) { row in
                Text(row.updatedAt, format: .relative(presentation: .named))
                    .junoCaption()
                    .help(row.updatedAt.formatted(date: .abbreviated, time: .shortened))
            }
            .width(min: 110, ideal: 150)
        }
        .tableStyle(.inset)
        // The table's own scroll background is the system control colour, which
        // reads cool against the card it now sits on.
        .scrollContentBackground(.hidden)
        // A short table draws alternating backgrounds for the *remaining* area,
        // which showed as blank grey phantom rows under the real ones. Off, so
        // the card's white runs to the bottom edge whatever the row count.
        .alternatingRowBackgrounds(.disabled)
        .contextMenu(forSelectionType: DesktopProjectRow.ID.self) { ids in
            rowMenu(ids)
        } primaryAction: { ids in
            guard let id = ids.first else { return }
            model.selectedProjectID = id
        }
        .onDeleteCommand {
            if let project = model.selectedProject { deleteTarget = project }
        }
        .accessibilityIdentifier("Projects table")
    }

    @ViewBuilder
    private func rowMenu(_ ids: Set<DesktopProjectRow.ID>) -> some View {
        if ids.count == 1, let id = ids.first,
            let project = model.projects.first(where: { $0.id == id })
        {
            Button {
                Task {
                    await model.updateProject(id: project.id, starred: !project.starred)
                }
            } label: {
                Label(
                    project.starred ? "Remove favourite" : "Favourite",
                    systemImage: project.starred ? "star.slash" : "star"
                )
            }
            .disabled(project.isPending)
            Button {
                startRename(project)
            } label: {
                Label("Rename…", systemImage: "pencil")
            }
            .disabled(project.isPending)
            Button {
                model.selectedProjectID = project.id
                showingFileImporter = true
            } label: {
                Label("Add files…", systemImage: "paperclip")
            }
            .disabled(project.isPending || model.isPerformingFileAction)
            Divider()
            Button(role: .destructive) {
                deleteTarget = project
            } label: {
                Label("Delete project", systemImage: "trash")
            }
            .disabled(project.isPending)
        } else {
            // Right-clicking the table's empty space selects nothing, and an
            // empty context menu is worse than no menu.
            Button {
                startCreate()
            } label: {
                Label("New project", systemImage: "folder.badge.plus")
            }
        }
    }

    /// The one thing on this screen allowed to float: a transient status control
    /// carrying an outage or a sync conflict, and the two ways out of it. It sits
    /// over the canvas rather than pushing the table down, so a conflict does not
    /// re-lay-out the rows the reader is looking at. Real glass, and the controls
    /// inside it are plain — glass inside glass has no rim light left to read.
    @ViewBuilder
    private var statusControl: some View {
        if !model.projects.isEmpty, let status = status {
            JunoDesktopGlass(spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.cozy) {
                    Image(systemName: status.symbol)
                        .foregroundStyle(status.isConflict ? Color.junoCaution : .secondary)
                        .accessibilityHidden(true)
                    Text(status.message)
                        .junoCaption()
                    if status.isConflict {
                        Button("Keep mine") {
                            Task { await model.resolveConflicts(keepLocalChanges: true) }
                        }
                        Button("Use server version") {
                            Task { await model.resolveConflicts(keepLocalChanges: false) }
                        }
                    } else {
                        Button("Try again") {
                            Task { await model.reload() }
                        }
                    }
                }
                .buttonStyle(.borderless)
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.snug)
                .junoFloatingChrome(cornerRadius: JunoRadius.panel)
            }
            .padding(JunoSpace.roomy)
            .accessibilityIdentifier("Projects status")
        }
    }

    /// A conflict is its own state — it has two specific answers rather than a
    /// retry — so it is decided here. Everything else goes through the shared
    /// copy, which is what stops a bare "Not found" or "401" from being printed
    /// under the table as if it were a sentence.
    private var status: (message: String, symbol: String, isConflict: Bool)? {
        if model.conflictedMutationCount > 0 {
            return (
                "A project changed on another device.",
                "exclamationmark.arrow.triangle.2.circlepath",
                true
            )
        }
        guard let resolved = DesktopArtifactStatus(
            localError: nil,
            phase: model.phase == .offline ? .offline : .ready,
            serverError: model.lastErrorDescription,
            subject: "projects",
            singular: "project"
        ) else { return nil }
        return (resolved.message, resolved.symbol, false)
    }

    // MARK: - Project detail

    @ViewBuilder
    private var projectDetail: some View {
        if let project = model.selectedProject {
            DesktopProjectInspector(
                model: model,
                conversationModel: conversationModel,
                configuration: configuration,
                project: project,
                openConversation: openConversation,
                startConversation: { prompt in startConversation(project.id, prompt) },
                openVoiceMode: { modelID in
                    startVoice(modelID: modelID, projectID: project.id)
                },
                addFiles: { showingFileImporter = true },
                editInstructions: { editingInstructionsFor = project },
                toggleFavourite: {
                    Task {
                        await model.updateProject(
                            id: project.id,
                            starred: !project.starred
                        )
                    }
                },
                renameProject: { startRename(project) },
                deleteProject: { deleteTarget = project },
                showAllProjects: { showingProjectBrowser = true }
            )
        } else {
            // No action here when there are no projects at all: the main region
            // already offers the one "New project" button, and a second copy of
            // the same call to action two panes apart reads as two features.
            JunoEmptyState(
                title: "No project selected",
                message: model.projects.isEmpty
                    ? "Create a project to keep a topic's chats, files and instructions together."
                    : "Select a project to see its instructions, chats and files.",
                symbol: "folder"
            )
        }
    }

    private func startCreate() {
        showingNewProject = true
    }

    private func startRename(_ project: NativeProject) {
        renameDraft = project.name
        renameTarget = project
    }

    private func startVoice(modelID: String, projectID: String) {
        guard let sender = configuration.requestSender,
            configuration.voiceTranscriptClient != nil
        else { return }
        voiceSession = DesktopVoiceSession(
            controller: JunoRealtimeVoiceController(
                authorization: JunoDesktopVoiceAuthorization(
                    sender: sender,
                    accountID: session.profile.id
                )
            ),
            modelID: modelID,
            conversationID: nil,
            projectID: projectID
        )
    }

    private func voiceSheet(_ voiceSession: DesktopVoiceSession) -> some View {
        DesktopVoiceView(
            controller: voiceSession.controller,
            saveTranscript: { sessionID, turns in
                guard let client = configuration.voiceTranscriptClient else {
                    throw DesktopVoiceError.unavailable
                }
                let saved = try await client.save(
                    sessionID: sessionID,
                    conversationID: nil,
                    modelID: voiceSession.modelID,
                    projectID: voiceSession.projectID,
                    connectors: [],
                    turns: turns,
                    for: session.profile.id
                )
                await configuration.syncModel?.refresh()
                await conversationModel.reload()
                openConversation(saved.conversationID)
                return saved.conversationID
            },
            close: { self.voiceSession = nil }
        )
    }

    /// Projects an optional target into the `Bool` an alert or dialog wants,
    /// so the presented sheet can read the target it was raised for.
    private func presenting<Value>(_ target: Binding<Value?>) -> Binding<Bool> {
        Binding(
            get: { target.wrappedValue != nil },
            set: { presented in if !presented { target.wrappedValue = nil } }
        )
    }
}

/// One table row: a project plus the two counts the table compares across rows.
///
/// The counts live here rather than being read inside a cell because a sortable
/// `TableColumn` needs a key path to the value it sorts by, and "chats" and
/// "files" are counts of two other collections on the model.
// MARK: - Card

private enum DesktopProjectGrid {
    /// Wide enough for a serif title and two lines of instructions without the
    /// preview collapsing to three words; narrow enough that a wide window shows
    /// three across, as the website does.
    static let minimumCardWidth: CGFloat = 300
    static let maximumCardWidth: CGFloat = 460
    /// A floor, not a fixed height: a project with no instructions must not make
    /// its neighbour in the same row look half-empty.
    static let minimumCardHeight: CGFloat = 150
}

/// One project, in the website's card anatomy: serif name, an actions menu, the
/// instructions preview, then a footer of real counts.
///
/// The instructions preview is the point of the card. It is the only thing that
/// distinguishes two projects at a glance, and it is what the previous table
/// could not give room to.
private struct DesktopProjectCard<MenuContent: View>: View {
    let row: DesktopProjectRow
    let isSelected: Bool
    let open: () -> Void
    @ViewBuilder var menu: () -> MenuContent

    @State private var isHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            titleRow
            instructions
            Spacer(minLength: JunoSpace.cozy)
            Divider()
            footer
        }
        .frame(minHeight: DesktopProjectGrid.minimumCardHeight, alignment: .top)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(
                    isSelected ? Color.junoAccent.opacity(0.55) : .clear,
                    lineWidth: 1.5
                )
        )
        .contentShape(.rect)
        .onTapGesture(perform: open)
        .onHover { isHovering = $0 }
        .animation(JunoMotion.fast, value: isHovering)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.name)
        .accessibilityValue(
            "\(row.conversationCount) chats, \(row.fileCount) files. \(row.instructionsPreview)"
        )
        .accessibilityAddTraits(.isButton)
    }

    private var titleRow: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            Text(row.name)
                .font(JunoSerif.cardTitle)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if row.project.starred {
                Image(systemName: "star.fill")
                    .font(.caption)
                    .foregroundStyle(Color.junoAccent)
                    .accessibilityLabel("Favourite")
            }
            Spacer(minLength: JunoSpace.snug)
            actionsMenu
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.regular)
    }

    private var actionsMenu: some View {
        Menu {
            menu()
        } label: {
            Image(systemName: "ellipsis")
                .foregroundStyle(.secondary)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: 18)
        // Revealed on hover like the web's row actions, but kept in the layout
        // at all times so the title never reflows under the pointer.
        .opacity(isHovering || isSelected ? 1 : 0)
        .accessibilityLabel("Project actions")
    }

    private var instructions: some View {
        Text(row.instructionsPreview)
            .junoCaption()
            .lineLimit(2)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.snug)
    }

    private var footer: some View {
        HStack(spacing: JunoSpace.snug) {
            Text(updatedLabel)
                .junoCodeSmall()
                .foregroundStyle(.secondary)
            Spacer(minLength: JunoSpace.snug)
            count("bubble.left", row.conversationCount, "chats")
            count("doc", row.fileCount, "files")
            if row.project.isPending {
                ProgressView()
                    .controlSize(.mini)
                    .accessibilityLabel("Waiting to sync")
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
    }

    private var updatedLabel: String {
        "Updated " + row.updatedAt.formatted(.relative(presentation: .named))
    }

    private func count(_ symbol: String, _ value: Int, _ label: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol)
                .imageScale(.small)
            Text(value.formatted())
                .monospacedDigit()
        }
        .junoCodeSmall()
        .foregroundStyle(.secondary)
        .accessibilityLabel("\(value) \(label)")
    }
}

private struct DesktopProjectRow: Identifiable {
    let project: NativeProject
    let conversationCount: Int
    let fileCount: Int

    var id: String { project.id }
    var name: String { project.name }
    var updatedAt: Date { project.updatedAt }

    /// The instructions on one line, for the second line of the name cell.
    ///
    /// Collapsed rather than truncated by `lineLimit` alone: a prompt usually
    /// opens with a blank line or a heading, so the first *visual* line of the
    /// raw text is frequently empty and the cell would look broken.
    var instructionsPreview: String {
        let collapsed = project.instructions
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return collapsed.isEmpty ? "No instructions set." : collapsed
    }
}

// MARK: - Inspector

private enum DesktopProjectTab: String, CaseIterable, Identifiable {
    case overview
    case workspace

    var id: Self { self }
    var label: String { rawValue.capitalized }
}

/// The selected project, as a native inspector.
///
/// A grouped `Form`, because that is how macOS draws exactly the treatment the
/// website uses: each section becomes a rounded raised card on the inspector's
/// own background, so the pane reads as white cards on a warm ground without a
/// single hand-painted fill. The two dates at the top are `LabeledContent`, the
/// same component the system's own inspectors use for a labelled value.
private struct DesktopProjectInspector: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    @Bindable var conversationModel: NativeConversationModel<SQLiteAccountRepository>
    let configuration: JunoDesktopConfiguration
    let project: NativeProject
    let openConversation: (String) -> Void
    let startConversation: (String?) -> Void
    let openVoiceMode: (String) -> Void
    let addFiles: () -> Void
    let editInstructions: () -> Void
    let toggleFavourite: () -> Void
    let renameProject: () -> Void
    let deleteProject: () -> Void
    let showAllProjects: () -> Void

    @State private var renameFileTarget: NativeProjectFile?
    @State private var fileNameDraft = ""
    @State private var tab = DesktopProjectTab.overview

    private var conversations: [NativeProjectConversation] {
        model.conversationsByProject[project.id] ?? []
    }

    private var files: [NativeProjectFile] {
        model.filesByProject[project.id] ?? []
    }

    var body: some View {
        HSplitView {
            projectPage
                .frame(minWidth: 620, maxWidth: .infinity)

            contextInspector
                .frame(minWidth: 280, idealWidth: 330, maxWidth: 400)
        }
            // Dropping a file onto the project's details is the same operation as
            // the Add files… button, and it is the gesture a Mac user tries first.
            .dropDestination(for: URL.self) { urls, _ in
                guard !project.isPending, !urls.isEmpty else { return false }
                Task {
                    await DesktopProjectFiles.upload(urls, projectID: project.id, model: model)
                }
                return true
            }
            .alert(
                "Rename file",
                isPresented: Binding(
                    get: { renameFileTarget != nil },
                    set: { presented in if !presented { renameFileTarget = nil } }
                )
            ) {
                TextField("File name", text: $fileNameDraft)
                Button("Cancel", role: .cancel) { renameFileTarget = nil }
                Button("Rename") {
                    if let target = renameFileTarget {
                        Task { await model.renameFile(id: target.id, fileName: fileNameDraft) }
                    }
                    renameFileTarget = nil
                }
            }
    }

    private var projectPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                Button(action: showAllProjects) {
                    Label("All projects", systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("All projects")

                projectHeader

                Picker("Project section", selection: $tab) {
                    ForEach(DesktopProjectTab.allCases) { tab in
                        Text(tab.label).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 240)
                .accessibilityIdentifier("Project section")

                if tab == .overview {
                    quickStart
                    projectChats
                } else {
                    workspaceOverview
                }
            }
            .frame(maxWidth: 900, alignment: .leading)
            .padding(.horizontal, JunoSpace.section)
            .padding(.vertical, JunoSpace.roomy)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private var projectHeader: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .center, spacing: JunoSpace.cozy) {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text("PROJECT")
                        .font(.caption.weight(.semibold))
                        .tracking(1.2)
                        .foregroundStyle(.secondary)
                    HStack(spacing: JunoSpace.snug) {
                        Text(project.name)
                            .font(JunoSerif.font(
                                size: 38,
                                relativeTo: .largeTitle,
                                face: .medium
                            ))
                            .lineLimit(2)
                            .textSelection(.enabled)
                        Button(action: renameProject) {
                            Image(systemName: "pencil")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .help("Rename project")
                    }
                }

                Spacer(minLength: JunoSpace.regular)

                Button {
                    startConversation(nil)
                } label: {
                    Label("New chat", systemImage: "square.and.pencil")
                }
                .junoProminentGlassButton()
                .disabled(project.isPending)
                .help("Start a chat with this project's instructions and files")
                .accessibilityIdentifier("New chat in project")

                projectActions
            }

            Text(projectSummary)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Project detail header")
    }

    private var projectActions: some View {
        Menu {
            Button {
                toggleFavourite()
            } label: {
                Label(
                    project.starred ? "Remove from Favourites" : "Add to Favourites",
                    systemImage: project.starred ? "star.slash" : "star"
                )
            }
            Button("Rename…", action: renameProject)
            Button("Add files…", action: addFiles)
            Divider()
            Button("Delete project…", role: .destructive, action: deleteProject)
        } label: {
            Label("Project actions", systemImage: "ellipsis")
        }
        .labelStyle(.iconOnly)
        .disabled(project.isPending || model.isMutating)
        .help("Favourite, rename, add files, or delete this project")
        .accessibilityIdentifier("Project detail actions")
    }

    private var projectSummary: String {
        "\(conversations.count) chats · \(files.count) files · Updated "
            + project.updatedAt.formatted(.relative(presentation: .named))
    }

    private var quickStart: some View {
        DesktopComposer(
            model: conversationModel,
            attachmentModel: configuration.attachmentModel,
            libraryModel: configuration.libraryModel,
            projectModel: model,
            connectorModel: configuration.connectorModel,
            draftProjectID: .constant(nil),
            draftPrompt: .constant(nil),
            openVoiceMode: openVoiceMode,
            fixedProjectID: project.id,
            didSendConversation: openConversation
        )
        .frame(maxWidth: .infinity)
        .disabled(project.isPending)
    }

    private var projectChats: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Chats in this project")
                .font(.headline)
            if conversations.isEmpty {
                ContentUnavailableView(
                    "No chats yet",
                    systemImage: "bubble.left",
                    description: Text("Start above and this project's context will be attached.")
                )
                .frame(maxWidth: .infinity, minHeight: 180)
            } else {
                VStack(spacing: 0) {
                    ForEach(conversations) { conversation in
                        Button {
                            openConversation(conversation.id)
                        } label: {
                            HStack(spacing: JunoSpace.cozy) {
                                Image(systemName: "bubble.left")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(conversation.title)
                                        .font(.body.weight(.medium))
                                        .lineLimit(1)
                                    Text(
                                        conversation.lastMessageAt,
                                        format: .relative(presentation: .named)
                                    )
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, JunoSpace.regular)
                            .frame(minHeight: 58)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        if conversation.id != conversations.last?.id {
                            Divider().padding(.leading, 44)
                        }
                    }
                }
                .background(.background, in: RoundedRectangle(
                    cornerRadius: JunoRadius.panel,
                    style: .continuous
                ))
                .overlay {
                    RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                        .strokeBorder(Color.junoBorder)
                }
            }
        }
    }

    private var workspaceOverview: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                HStack {
                    Text("Instructions")
                        .font(.headline)
                    Spacer()
                    Button("Edit", action: editInstructions)
                }
                Text(project.instructions.isEmpty ? "No instructions set." : project.instructions)
                    .font(.body)
                    .foregroundStyle(project.instructions.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()

            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                HStack {
                    Text("Project files")
                        .font(.headline)
                    Spacer()
                    Button("Add files…", action: addFiles)
                }
                if files.isEmpty {
                    Text("No files yet. Drop files anywhere in this workspace or add them here.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(files) { file in
                        Label(file.fileName, systemImage: symbol(for: file))
                            .lineLimit(1)
                    }
                }
            }
        }
        .padding(JunoSpace.regular)
        .background(.background, in: RoundedRectangle(
            cornerRadius: JunoRadius.panel,
            style: .continuous
        ))
        .overlay {
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(Color.junoBorder)
        }
    }

    private var contextInspector: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.cozy) {
                Image(systemName: "folder.fill")
                    .font(.title3)
                    .foregroundStyle(Color.junoAccent)
                    .frame(width: 38, height: 38)
                    .background(.quaternary, in: RoundedRectangle(
                        cornerRadius: JunoRadius.row,
                        style: .continuous
                    ))
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name)
                        .font(.headline)
                        .lineLimit(1)
                    Text("Private project context")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(JunoSpace.regular)

            Divider()

            List {
                instructions
                projectFiles
                overview
            }
            .listStyle(.inset)
            .scrollContentBackground(.hidden)
        }
        .background(.bar)
    }

    private var overview: some View {
        Section("Overview") {
            LabeledContent("Updated") {
                Text(project.updatedAt.formatted(date: .abbreviated, time: .shortened))
            }
            LabeledContent("Created") {
                Text(project.createdAt.formatted(date: .abbreviated, time: .omitted))
            }
            if project.isPending {
                LabeledContent("Status") {
                    Text("Waiting to sync")
                }
            }
            LabeledContent("Contents") {
                Text("\(conversations.count) chats · \(files.count) files")
                    .monospacedDigit()
            }
        }
    }

    private var instructions: some View {
        Section {
            if project.instructions.isEmpty {
                Text("No instructions set.")
                    .junoCaption()
            } else {
                Text(project.instructions)
                    .junoMono()
                    .lineLimit(14)
                    .textSelection(.enabled)
                    .padding(.vertical, JunoSpace.hairline)
            }
            Button(
                project.instructions.isEmpty ? "Add instructions…" : "Edit instructions…",
                action: editInstructions
            )
            .disabled(project.isPending || model.isMutating)
            .accessibilityIdentifier("Edit project instructions")
        } header: {
            Text("Instructions")
        } footer: {
            Text("Included in every chat in this project.")
                .junoCaption()
        }
    }

    private var chats: some View {
        Section("Chats") {
            if conversations.isEmpty {
                Text("No chats in this project yet.")
                    .junoCaption()
            } else {
                ForEach(conversations) { conversation in
                    Button {
                        openConversation(conversation.id)
                    } label: {
                        HStack(spacing: JunoSpace.snug) {
                            JunoIconView(.conversation, size: 14)
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                                Text(conversation.title)
                                    .junoRowLabel()
                                    .lineLimit(1)
                                Text(
                                    conversation.lastMessageAt,
                                    format: .relative(presentation: .named)
                                )
                                .junoCaption()
                            }
                            Spacer(minLength: JunoSpace.snug)
                            if conversation.pinned {
                                Image(systemName: "pin.fill")
                                    .font(.caption2)
                                    .foregroundStyle(Color.junoAccent)
                                    .accessibilityLabel("Pinned")
                            }
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .help("Open this chat")
                    .accessibilityLabel("Open chat, \(conversation.title)")
                }
            }
        }
    }

    private var projectFiles: some View {
        Section {
            if files.isEmpty {
                Text("No files yet.")
                    .junoCaption()
            } else {
                ForEach(files) { file in
                    fileRow(file)
                }
            }
            Button("Add files…", action: addFiles)
                .disabled(project.isPending || model.isPerformingFileAction)
                .accessibilityIdentifier("Add project files")
        } header: {
            Text("Files")
        } footer: {
            Text("Available to every chat in this project. Files can also be dropped here.")
                .junoCaption()
        }
    }

    private func fileRow(_ file: NativeProjectFile) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Image(systemName: symbol(for: file))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                // A link, because activating it opens the file outside Juno —
                // the platform's own signal for "this leaves here".
                Button {
                    Task { await open(file) }
                } label: {
                    Text(file.fileName)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .buttonStyle(.link)
                .help("Open \(file.fileName)")
                Text(detail(for: file))
                    .junoCaption()
            }
            Spacer(minLength: JunoSpace.snug)
            if model.isPerformingFileAction {
                ProgressView()
                    .controlSize(.mini)
                    .accessibilityHidden(true)
            }
            Menu {
                Button("Open") { Task { await open(file) } }
                Button("Rename…") {
                    fileNameDraft = file.fileName
                    renameFileTarget = file
                }
                Divider()
                Button("Delete", role: .destructive) {
                    Task { await model.deleteFile(id: file.id) }
                }
            } label: {
                Label("File options", systemImage: "ellipsis")
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(model.isPerformingFileAction)
            .accessibilityLabel("Options for \(file.fileName)")
        }
    }

    /// A glyph for the file's own type, from the MIME type the server recorded.
    /// No thumbnail: the only way to reach a file's bytes is `accessFile`, which
    /// flips the model's `isPerformingFileAction` flag and would put every row's
    /// spinner on and every file action off for as long as previews were loading.
    private func symbol(for file: NativeProjectFile) -> String {
        let mime = file.mimeType.lowercased()
        if mime.hasPrefix("image/") || file.kind.uppercased() == "IMAGE" { return "photo" }
        if mime.hasPrefix("audio/") { return "waveform" }
        if mime.hasPrefix("video/") { return "film" }
        if mime.contains("pdf") { return "doc.richtext" }
        if mime.contains("csv") || mime.contains("spreadsheet") { return "tablecells" }
        if mime.hasPrefix("text/") { return "doc.text" }
        return "doc"
    }

    /// Size, plus the pixel dimensions when the server recorded them — which it
    /// does only for images, so this line is what tells a 4000-pixel screenshot
    /// from a thumbnail without opening either.
    private func detail(for file: NativeProjectFile) -> String {
        let size = ByteCountFormatter.string(
            fromByteCount: Int64(file.size),
            countStyle: .file
        )
        guard let width = file.width, let height = file.height else { return size }
        return "\(size) · \(width)×\(height)"
    }

    private func open(_ file: NativeProjectFile) async {
        guard let access = await model.accessFile(id: file.id) else { return }
        switch access {
        case .remote(let url):
            NSWorkspace.shared.open(url)
        case .downloaded(let data):
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(file.fileName)
            guard (try? data.write(to: url, options: .atomic)) != nil else { return }
            NSWorkspace.shared.open(url)
        }
    }
}

// MARK: - File import

private enum DesktopProjectFiles {
    /// Reads each picked or dropped URL and hands it to the project uploader.
    ///
    /// The security-scoped access dance is required for both routes under the
    /// sandbox: an open panel and a drag both grant access to the URL they
    /// produce, and that grant has to be claimed before the bytes are read.
    @MainActor
    static func upload(
        _ urls: [URL],
        projectID: String,
        model: NativeProjectModel<SQLiteAccountRepository>
    ) async {
        for url in urls {
            let granted = url.startAccessingSecurityScopedResource()
            defer {
                if granted { url.stopAccessingSecurityScopedResource() }
            }
            guard let data = try? Data(contentsOf: url) else { continue }
            let type = try? url.resourceValues(forKeys: [.contentTypeKey]).contentType
            await model.uploadFile(
                data: data,
                fileName: url.lastPathComponent,
                mimeType: type?.preferredMIMEType ?? "application/octet-stream",
                projectID: projectID
            )
        }
    }
}

// MARK: - Sheets

private struct DesktopNewProjectSheet: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var instructions = ""
    @State private var creationError: String?

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("New project")
                    .junoPageHeading(compact: true)
                Text("A project keeps one topic's chats, files and instructions together.")
                    .junoCaption()
            }

            TextField("Name", text: $name)
                .accessibilityIdentifier("New project name")

            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Instructions")
                    .junoRowLabel()
                TextEditor(text: $instructions)
                    .junoMono()
                    .scrollContentBackground(.hidden)
                    // Padding inside the frame, never around it: a frame wrapped
                    // in padding asks for "that height plus 8" from whatever is
                    // sizing this sheet.
                    .padding(JunoSpace.snug)
                    .frame(minHeight: 130)
                    .junoPanel()
                    .accessibilityLabel("Project instructions")
                Text("Optional. Included in every chat in this project.")
                    .junoCaption()
            }

            HStack(spacing: JunoSpace.cozy) {
                // Only an error this sheet's own attempt produced. Reading the
                // model's last error unconditionally would show an unrelated
                // sync message from ten minutes ago as if it were a rejection.
                if let creationError {
                    Text(creationError)
                        .junoCaption()
                        .foregroundStyle(Color.junoDanger)
                        .textSelection(.enabled)
                }
                Spacer(minLength: JunoSpace.snug)
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Create project") {
                    Task {
                        creationError = nil
                        guard await model.createProject(
                            name: name,
                            instructions: instructions
                        ) != nil else {
                            creationError = model.lastErrorDescription
                                ?? "Juno could not create this project."
                            return
                        }
                        dismiss()
                    }
                }
                .junoProminentGlassButton()
                .keyboardShortcut(.defaultAction)
                .disabled(trimmedName.isEmpty || model.isMutating)
                .accessibilityIdentifier("Create project")
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 520)
    }
}

/// The instructions editor, in the room a prompt needs.
private struct DesktopProjectInstructionsSheet: View {
    let project: NativeProject
    /// Main-actor qualified deliberately: the closure the caller passes captures
    /// the observable model, which is main-actor isolated and not `Sendable`.
    let save: @MainActor (String) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft: String
    @State private var isSaving = false

    /// The web warns above this length and still saves (`INSTRUCTIONS_SOFT_WARN`
    /// in `src/app/(app)/projects/[id]/page.tsx`); so does this. It is advice
    /// about how much of a prompt a model will actually attend to, not a limit.
    private let softWarnLength = 50_000

    init(project: NativeProject, save: @escaping @MainActor (String) async -> Void) {
        self.project = project
        self.save = save
        _draft = State(initialValue: project.instructions)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Instructions")
                    .junoPageHeading(compact: true)
                Text("How Juno behaves in “\(project.name)”, in every chat in the project.")
                    .junoCaption()
            }

            TextEditor(text: $draft)
                .junoMono()
                .scrollContentBackground(.hidden)
                // The padding goes *inside* the greedy frame. Wrapping a
                // `.frame(maxHeight: .infinity)` in padding asks for "all of the
                // height, plus 12", which nothing can satisfy — the mistake that
                // lets a detail surface resize the window rather than be clipped
                // by it. Here the sheet's own frame bounds it, and the editor
                // fills whatever the header and footer leave.
                .padding(JunoSpace.cozy)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .junoPanel()
                .accessibilityLabel("Project instructions")
                .accessibilityIdentifier("Project instructions editor")

            HStack(spacing: JunoSpace.cozy) {
                if draft.count > softWarnLength {
                    Label(
                        "Very long — a model may not attend to all of it.",
                        systemImage: "exclamationmark.triangle"
                    )
                    .junoCaption()
                    .foregroundStyle(Color.junoCaution)
                } else {
                    Text("\(draft.count) characters")
                        .junoCaption()
                        .monospacedDigit()
                }
                Spacer(minLength: JunoSpace.snug)
                if isSaving {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Saving")
                }
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") {
                    Task {
                        isSaving = true
                        await save(draft)
                        isSaving = false
                        dismiss()
                    }
                }
                .junoProminentGlassButton()
                .keyboardShortcut(.defaultAction)
                .disabled(draft == project.instructions || isSaving)
                .accessibilityIdentifier("Save project instructions")
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 580, height: 460)
    }
}
