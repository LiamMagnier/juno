import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI
import UniformTypeIdentifiers

/// Projects, as one Mac window region: an editorial page header, a grid of
/// project cards over the warm canvas, and the selected project's instructions,
/// chats and files in a trailing inspector.
///
/// Three structural decisions are worth stating:
///
/// 1. **A card grid, not a `Table`.** This screen *was* a four-column table, on
///    the reasoning that name / chats / files / updated is tabular data and a
///    real `Table` brings sorting, type-select and the platform's selection
///    states for free. That reasoning was wrong about the subject matter: what
///    identifies a project is its name and its **instructions**, and the
///    instructions are a paragraph, not a column value. The website leads with
///    them; the table could only show them as a truncated caption inside the
///    first cell. Put side by side, the two read as different products. The grid
///    matches the web's card anatomy — serif name, actions menu, two-line
///    instructions preview, a footer of real counts — and selection still drives
///    the inspector, so none of the two-pane behaviour was traded away.
/// 2. **`.searchable`, not a hand-built search field.** The web page filters by
///    name and instructions; so does this, through the platform's own toolbar
///    search field, which brings ⌘F, the clear button and Escape with it.
/// 3. **`.inspector`, not `HSplitView`.** The window's detail column is already
///    inside the shell's `NavigationSplitView`; an inspector adds a *trailing*
///    pane the user can resize and hide from the toolbar, without a second
///    navigation column competing with the one the shell owns.
///
/// The instructions editor is deliberately *not* in the inspector. A project's
/// instructions are a prompt — often long and structured — and editing one in a
/// 320-point column is the reason both the website and the phone open it in a
/// dialog of its own. The inspector shows it, monospaced and clamped; editing
/// happens in a sheet with room to read.
///
/// Nothing here paints `junoReadingCanvas()`. The detail column already does,
/// once, in `DesktopChatWorkspace`; repainting it per page is what flattened the
/// window and left floating glass with nothing to refract.
struct DesktopProjectsScreen: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    let openConversation: (String) -> Void

    @SceneStorage("juno.desktop.projects.inspector") private var showsInspector = true
    @State private var sortOrder: [KeyPathComparator<DesktopProjectRow>] = []
    @State private var query = ""
    @State private var showingNewProject = false
    @State private var showingFileImporter = false
    @State private var editingInstructionsFor: NativeProject?
    @State private var renameTarget: NativeProject?
    @State private var renameDraft = ""
    @State private var deleteTarget: NativeProject?

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
        // `Color.clear.overlay`, and the choice is load-bearing. A detail column
        // reports an ideal size upward and `NavigationSplitView` grows its AppKit
        // split view to satisfy it, so a tall page resizes the *window* instead
        // of being clipped by it. `Color.clear` accepts whatever height it is
        // proposed and an overlay is sized by its base, so nothing below this
        // line can reach the split view.
        Color.clear
            .overlay { page }
            .overlay(alignment: .bottom) { statusControl }
            .inspector(isPresented: $showsInspector) {
                inspectorContent
                    .inspectorColumnWidth(
                        min: JunoInspectorMetrics.minimum,
                        ideal: JunoInspectorMetrics.ideal,
                        max: JunoInspectorMetrics.maximum
                    )
            }
            .toolbar { projectsToolbar }
            .searchable(
                text: $query,
                placement: .toolbar,
                prompt: "Search projects"
            )
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
    }

    // MARK: - Main region

    /// The page: heading, then content, with the warm canvas showing through
    /// around both.
    ///
    /// The outer padding is applied to the stack, not around a greedy frame —
    /// `.frame(maxHeight: .infinity)` followed by `.padding()` asks for "all of
    /// the height, plus 32", which nothing can satisfy. The table below is
    /// greedy on its own, so it takes whatever the header leaves.
    private var page: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            header
            content
        }
        .padding(JunoSpace.region)
    }

    /// The web's page header: the destination's own icon, the name in the
    /// editorial serif, and a line of real counts under it. The web's "Sort by"
    /// menu has no equivalent here on purpose — the table's own column headers
    /// are where a Mac user sorts, and they offer the same three keys.
    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.projects)
                    .foregroundStyle(.secondary)
                Text("Projects")
                    .junoPageHeading()
            }
            Text(headerSubtitle)
                .junoCaption()
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
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
            projectGrid
        }
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
                            showsInspector = true
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
            showsInspector = true
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

    // MARK: - Inspector

    @ViewBuilder
    private var inspectorContent: some View {
        if let project = model.selectedProject {
            DesktopProjectInspector(
                model: model,
                project: project,
                openConversation: openConversation,
                addFiles: { showingFileImporter = true },
                editInstructions: { editingInstructionsFor = project }
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

    // MARK: - Toolbar

    /// Every item is present in every state and `.disabled()` rather than
    /// removed. A `ToolbarItem` that comes and goes rebuilds the AppKit toolbar
    /// under a live window, and it also moves the remaining controls out from
    /// under the pointer that was heading for them.
    @ToolbarContentBuilder
    private var projectsToolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                startCreate()
            } label: {
                Label("New project", systemImage: "folder.badge.plus")
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])
            .help("Create a project (⇧⌘N)")
            .accessibilityLabel("New project")
            .accessibilityIdentifier("New project")
        }

        ToolbarItem(placement: .primaryAction) {
            Toggle(isOn: favouriteBinding) {
                Label(
                    isFavourite ? "Remove favourite" : "Favourite",
                    systemImage: isFavourite ? "star.fill" : "star"
                )
            }
            .toggleStyle(.button)
            .disabled(!canEditSelection)
            .help(isFavourite ? "Remove from favourites" : "Keep this project at the top")
            .accessibilityLabel(isFavourite ? "Remove favourite" : "Favourite")
            .accessibilityIdentifier("Favourite project")
        }

        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button("Rename…") {
                    if let project = model.selectedProject { startRename(project) }
                }
                Button("Add files…") { showingFileImporter = true }
                Divider()
                Button("Delete project", role: .destructive) {
                    deleteTarget = model.selectedProject
                }
            } label: {
                Label("Project actions", systemImage: "ellipsis")
            }
            .disabled(!canEditSelection)
            .accessibilityLabel("Project actions")
            .accessibilityIdentifier("Project actions")
        }

        ToolbarItem(placement: .primaryAction) {
            Button {
                showsInspector.toggle()
            } label: {
                Label("Project details", systemImage: "sidebar.trailing")
            }
            .help(showsInspector ? "Hide project details" : "Show project details")
            .accessibilityLabel("Project details")
            .accessibilityIdentifier("Project details")
        }
    }

    private var isFavourite: Bool { model.selectedProject?.starred ?? false }

    /// A project that has not reached the server yet cannot be renamed, starred
    /// or deleted — the outbox has nothing to address the change to — which is
    /// what ``NativeProjectModel`` reports as `pendingProject`.
    private var canEditSelection: Bool {
        guard let project = model.selectedProject else { return false }
        return !project.isPending && !model.isMutating
    }

    private var favouriteBinding: Binding<Bool> {
        Binding(
            get: { isFavourite },
            set: { starred in
                guard let id = model.selectedProjectID else { return }
                Task { await model.updateProject(id: id, starred: starred) }
            }
        )
    }

    private func startCreate() {
        showingNewProject = true
    }

    private func startRename(_ project: NativeProject) {
        renameDraft = project.name
        renameTarget = project
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

/// The selected project, as a native inspector.
///
/// A grouped `Form`, because that is how macOS draws exactly the treatment the
/// website uses: each section becomes a rounded raised card on the inspector's
/// own background, so the pane reads as white cards on a warm ground without a
/// single hand-painted fill. The two dates at the top are `LabeledContent`, the
/// same component the system's own inspectors use for a labelled value.
private struct DesktopProjectInspector: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    let project: NativeProject
    let openConversation: (String) -> Void
    let addFiles: () -> Void
    let editInstructions: () -> Void

    @State private var renameFileTarget: NativeProjectFile?
    @State private var fileNameDraft = ""

    private var conversations: [NativeProjectConversation] {
        model.conversationsByProject[project.id] ?? []
    }

    private var files: [NativeProjectFile] {
        model.filesByProject[project.id] ?? []
    }

    var body: some View {
        // The same clamp the main region uses, for the same reason: the inspector
        // is another column of the window's split view, and a grouped `Form` is a
        // `ScrollView`, which propagates its content's ideal height rather than
        // absorbing it.
        Color.clear
            .overlay {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    Form {
                        overview
                        instructions
                        chats
                        projectFiles
                    }
                    .formStyle(.grouped)
                }
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
            .accessibilityIdentifier("Project inspector")
    }

    /// The project's name in the editorial serif, above the form rather than
    /// inside it: a grouped `Form`'s section headers are small secondary labels,
    /// and a display-size serif in that slot reads as a mistake.
    private var header: some View {
        Text(project.name)
            .font(JunoSerif.cardTitle)
            .lineLimit(2)
            .textSelection(.enabled)
            .accessibilityAddTraits(.isHeader)
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.top, JunoSpace.regular)
            .padding(.bottom, JunoSpace.snug)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var overview: some View {
        Section {
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
        }
    }

    private var instructions: some View {
        Section {
            if project.instructions.isEmpty {
                Text("No instructions set.")
                    .junoCaption()
            } else {
                // Monospaced and clamped. Instructions are a prompt: the
                // indentation and the angle brackets that give one its structure
                // disappear in a proportional face, and the full text belongs in
                // the editor rather than in a 320-point column.
                Text(project.instructions)
                    .junoMono()
                    .lineLimit(8)
                    .textSelection(.enabled)
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
