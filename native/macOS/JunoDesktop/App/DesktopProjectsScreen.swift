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

/// Projects, as the website has them: an **index** of every project at
/// `/projects`, and one project's workspace at `/projects/[id]`.
///
/// **Why a route and not a flag.** This screen used to decide what to show from
/// two pieces of long-lived state — a `showingProjectBrowser` boolean that
/// defaulted to *false* (the detail) and the model's `selectedProjectID`, which
/// the store auto-populated with the top favourite. Clicking Projects in the
/// sidebar therefore opened whichever project happened to sort first and there
/// was no path back to the index at all: the boolean reset to "show a detail"
/// every time the destination switch rebuilt this view. A route whose *root* is
/// the index cannot express that state, which is the point — the same shape Juno
/// Code uses for `DesktopCodeSidebarItem.allProjects`, and the same one the
/// Artifacts screen uses to get from its library to a document.
///
/// The model's `selectedProjectID` is deliberately left alone here. It is the
/// phone's navigation state, set by its own `navigationDestination`; mirroring it
/// on the Mac is what let a selection outlive a destination switch and re-open a
/// project the reader had already left.
struct DesktopProjectsScreen: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    @Bindable var conversationModel: NativeConversationModel<SQLiteAccountRepository>
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    let openConversation: (String) -> Void
    let startConversation: (String, String?) -> Void
    /// A one-shot route supplied by a concrete sidebar project row. Opening the
    /// Projects destination normally leaves this nil and therefore shows the
    /// index, matching the website.
    @Binding var requestedProjectID: String?

    @State private var route = DesktopProjectRoute.index
    @State private var sort = DesktopProjectSort.updated
    @State private var query = ""
    @State private var showingNewProject = false
    @State private var showingFileImporter = false
    /// Which project a picked file belongs to.
    ///
    /// Held separately from the route because the importer is reachable from the
    /// index's row menu as well as from an open project, and because reading the
    /// *model's* selection here is what tied file import to a selection that no
    /// longer exists.
    @State private var fileImportTarget: String?
    @State private var editingInstructionsFor: NativeProject?
    @State private var renameTarget: NativeProject?
    @State private var renameDraft = ""
    @State private var deleteTarget: NativeProject?
    @State private var voiceSession: DesktopVoiceSession?
    /// Why a spoken conversation could not be opened. An alert rather than an
    /// inline banner because the reader pressed a button and nothing happened —
    /// the answer has to arrive where they are looking. The same alert Chat has:
    /// this screen used to `return` in silence, so on any shell missing either
    /// half the microphone was a control that did nothing at all.
    @State private var voiceUnavailable: String?

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The project the route is on, if it still exists.
    ///
    /// Resolving through the model rather than storing the project itself is what
    /// makes a deletion — or a sync that drops the record — fall back to the index
    /// with no extra state to keep in step.
    private var openProject: NativeProject? {
        guard case .project(let id) = route else { return nil }
        return model.projects.first { $0.id == id }
    }

    /// The index's rows: the search applied, then the chosen sort.
    ///
    /// The filter matches the web page's — name *and* instructions, because a
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
        return matching
            .map { project in
                DesktopProjectRow(
                    project: project,
                    conversationCount: model.conversationsByProject[project.id]?.count ?? 0,
                    fileCount: model.filesByProject[project.id]?.count ?? 0
                )
            }
            .sorted(by: sort.precedes)
    }

    var body: some View {
        // `Color.clear.overlay { … }`: a detail-column page that reports an ideal
        // height resizes the window's split view rather than being clipped by it.
        // See ``JunoDetailPage``, which is the same clamp with a page inside it.
        Color.clear
            .overlay { workspace }
            .overlay(alignment: .bottom) { statusControl }
            // Belt and braces on top of `@State`'s own default. The destination
            // switch in ``DesktopDestinationView`` rebuilds this view, so the
            // route already starts at the index; saying it out loud means the
            // guarantee survives a future shell that keeps the view alive.
            .onAppear { consumeRequestedProject() }
            .onChange(of: requestedProjectID) { _, _ in consumeRequestedProject() }
            .sheet(isPresented: $showingNewProject) {
                // Straight into the new project, as `router.push` does on the
                // website — and as this screen used to do by accident, through
                // the model selection that no longer drives navigation.
                DesktopNewProjectSheet(model: model) { id in route = .project(id) }
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
                    let projectID = fileImportTarget
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
                        // Back to the index first: the page the reader is looking
                        // at is about to stop existing.
                        route = .index
                        Task { await model.deleteProject(id: target.id) }
                    }
                    deleteTarget = nil
                }
                .contentShape(.rect)
                Button("Cancel", role: .cancel) { deleteTarget = nil }
                .contentShape(.rect)
            } message: {
                Text("Chats stay in Juno and are unlinked from the project. The project's files are removed.")
            }
            .alert(
                "Voice is unavailable",
                isPresented: Binding(
                    get: { voiceUnavailable != nil },
                    set: { if !$0 { voiceUnavailable = nil } }
                ),
                presenting: voiceUnavailable
            ) { _ in
                Button("OK") { voiceUnavailable = nil }
                .contentShape(.rect)
            } message: { reason in
                Text(reason)
            }
            .desktopPreviewOverlays(
                sheet: { showingNewProject = true },
                alert: {
                    guard let project = model.projects.first else { return }
                    renameDraft = project.name
                    renameTarget = project
                },
                confirm: { deleteTarget = model.projects.first }
            )
    }

    private func consumeRequestedProject() {
        guard let projectID = requestedProjectID,
              model.projects.contains(where: { $0.id == projectID })
        else {
            route = .index
            return
        }
        route = .project(projectID)
    }

    @ViewBuilder
    private var workspace: some View {
        if let project = openProject {
            DesktopProjectDetail(
                model: model,
                conversationModel: conversationModel,
                configuration: configuration,
                project: project,
                openConversation: openConversation,
                startConversation: { prompt in startConversation(project.id, prompt) },
                openVoiceMode: { modelID in
                    startVoice(modelID: modelID, projectID: project.id)
                },
                voiceColumn: voiceColumn,
                addFiles: { beginFileImport(for: project) },
                editInstructions: { editingInstructionsFor = project },
                togglePin: { togglePin(project) },
                renameProject: { startRename(project) },
                deleteProject: { deleteTarget = project },
                showAllProjects: { route = .index }
            )
        } else {
            projectIndex
        }
    }

    // MARK: - Index

    private var projectIndex: some View {
        VStack(spacing: 0) {
            indexHeader
            Divider()
            indexContent
        }
        .accessibilityIdentifier("Projects index")
    }

    /// Serif title, count, sort, the one primary action — then one search field.
    ///
    /// One header, in the brand's own voice. The screen previously had two for
    /// the same page, neither of them serif, while the project detail underneath
    /// was already editorial: the index and the thing it indexes spoke different
    /// typographic languages.
    private var indexHeader: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack(alignment: .center, spacing: JunoSpace.cozy) {
                JunoIconView(.projects, size: DesktopProjectMetrics.titleGlyphSize)
                    .junoSecondaryInk()
                    .accessibilityHidden(true)
                Text("Projects")
                    .junoPageHeading()
                if let indexSummary {
                    Text(indexSummary)
                        .junoCodeSmall()
                        .junoSecondaryInk()
                        .accessibilityIdentifier("Projects count")
                }

                Spacer(minLength: JunoSpace.regular)

                sortMenu
                Button(action: startCreate) {
                    Label("New project", icon: .plus)
                }
                .junoProminentGlassButton()
                // Registered exactly once on this screen. While the old browser
                // was showing, two views claimed ⇧⌘N at the same time.
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .help("Create a project (⇧⌘N)")
                .accessibilityIdentifier("New project")
                .contentShape(.rect)
            }

            searchField
        }
        .padding(.horizontal, JunoSpace.region)
        .padding(.top, JunoSpace.section)
        .padding(.bottom, JunoSpace.roomy)
        .frame(maxWidth: DesktopProjectMetrics.indexWidth)
        .frame(maxWidth: .infinity)
    }

    /// The count, or how much of it the search left. Nil while there is nothing
    /// to count, so the empty state is not preceded by the word "0".
    private var indexSummary: String? {
        let total = model.projects.count
        guard total > 0 else { return nil }
        guard trimmedQuery.isEmpty else { return "\(rows.count) of \(total) match" }
        return total == 1 ? "1 project" : "\(total) projects"
    }

    /// The screen's only search field. It was built twice, at two heights, under
    /// two placeholders; a reader who used both saw two different controls doing
    /// the same job.
    private var searchField: some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(.search)
                .junoSecondaryInk()
                .accessibilityHidden(true)
            TextField("Search projects…", text: $query)
                .textFieldStyle(.plain)
                .accessibilityIdentifier("Projects search")
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    JunoIconView(.circleX)
                        .junoMetaInk()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear project search")
                .contentShape(.rect)
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: DesktopProjectMetrics.searchHeight)
        .background(
            // `NSColor.controlBackgroundColor` resolves to literal #FFFFFF in
            // light aqua, and this field runs the width of the screen — so
            // Projects opened with a full-width band of pure white across the
            // warmest page in the app, the single coldest surface anywhere in
            // it. `junoSurface` is the card token (`--card`, 54 44% 99%): still
            // a step above the canvas, so the field still reads as a control
            // sunk into the page, but on the same hue family as the paper it
            // sits on. It is also adaptive, which `controlBackgroundColor` was
            // only accidentally.
            RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                .fill(Color.junoSurface)
        )
    }

    private var sortMenu: some View {
        Menu {
            Picker("Sort by", selection: $sort) {
                ForEach(DesktopProjectSort.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            Label {
                Text("Sort by: \(sort.label)")
            } icon: {
                JunoIconView(.sliders)
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Order the projects below")
        .accessibilityIdentifier("Projects sort")
        .contentShape(.rect)
    }

    /// The website's states, in the website's order: failure, then loading, then
    /// nothing yet, then nothing matching.
    @ViewBuilder
    private var indexContent: some View {
        if model.projects.isEmpty {
            switch model.phase {
            case .idle, .loading:
                DesktopProjectSkeletonGrid()
            case .failed:
                // Through the shared copy for the same reason the status bar is:
                // an empty screen whose only explanation is the word "Not found"
                // tells the reader nothing about what to do next.
                JunoEmptyState(
                    title: "Couldn’t load your projects.",
                    message: DesktopStatusCopy(subject: "projects", singular: "project")
                        .humanized(
                            model.lastErrorDescription,
                            fallback: "Check your connection and try again."
                        ),
                    icon: .triangleAlert,
                    actionLabel: "Try again",
                    action: { Task { await model.reload() } }
                )
            case .ready, .offline:
                JunoEmptyState(
                    title: "No projects yet.",
                    message: "Create one to keep a topic’s chats, instructions, and files together.",
                    icon: .projects,
                    actionLabel: "New project",
                    action: startCreate
                )
            }
        } else if rows.isEmpty {
            // The website's own search mark, as the "no projects yet" state above
            // already uses the website's project mark.
            JunoEmptyState(
                title: "No projects match your search.",
                message: "Juno searched project names and instructions.",
                icon: .search,
                actionLabel: "Clear search",
                action: { query = "" }
            )
        } else {
            projectGrid
        }
    }

    private var projectGrid: some View {
        ScrollView {
            LazyVGrid(
                columns: DesktopProjectMetrics.gridColumns,
                alignment: .leading,
                spacing: JunoSpace.regular
            ) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    DesktopProjectCard(
                        row: row,
                        index: index,
                        open: { route = .project(row.id) },
                        menu: { projectMenu(row.project) }
                    )
                }
            }
            .padding(.horizontal, JunoSpace.region)
            .padding(.vertical, JunoSpace.section)
            .frame(maxWidth: DesktopProjectMetrics.indexWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .accessibilityIdentifier("Projects grid")
    }

    /// The card's ⋯ menu, and its right-click menu — one definition, because a
    /// project offers the same things however the reader asks for them.
    @ViewBuilder
    private func projectMenu(_ project: NativeProject) -> some View {
        Button {
            togglePin(project)
        } label: {
            Label(verbatim: project.starred ? "Unpin" : "Pin", icon: .pin)
        }
        .disabled(project.isPending)
        .contentShape(.rect)
        Button {
            startRename(project)
        } label: {
            Label("Rename…", icon: .pencil)
        }
        .disabled(project.isPending)
        .contentShape(.rect)
        // Not on the website's card menu, and kept anyway: dropping files onto a
        // project is a Mac gesture, and this is the keyboard-and-menu half of it.
        Button {
            beginFileImport(for: project)
        } label: {
            Label("Add files…", icon: .attach)
        }
        .disabled(project.isPending || model.isPerformingFileAction)
        .contentShape(.rect)
        Divider()
        Button(role: .destructive) {
            deleteTarget = project
        } label: {
            Label("Delete project", icon: .trash)
        }
        .disabled(project.isPending)
        .contentShape(.rect)
    }

    // MARK: - Status

    /// The one thing on this screen allowed to float: a transient status control
    /// carrying an outage or a sync conflict, and the two ways out of it. It sits
    /// over the canvas rather than pushing the grid down, so a conflict does not
    /// re-lay-out the cards the reader is looking at. Real glass, and the controls
    /// inside it are plain — glass inside glass has no rim light left to read.
    @ViewBuilder
    private var statusControl: some View {
        if !model.projects.isEmpty, let status = status {
            JunoDesktopGlass(spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.cozy) {
                    JunoIconView(status.icon, size: 16)
                        .foregroundStyle(status.isConflict ? Color.junoCaution : .secondary)
                        .accessibilityHidden(true)
                    Text(status.message)
                        .junoCaption()
                    if status.isConflict {
                        Button("Keep mine") {
                            Task { await model.resolveConflicts(keepLocalChanges: true) }
                        }
                        .contentShape(.rect)
                        Button("Use server version") {
                            Task { await model.resolveConflicts(keepLocalChanges: false) }
                        }
                        .contentShape(.rect)
                    } else {
                        Button("Try again") {
                            Task { await model.reload() }
                        }
                        .contentShape(.rect)
                    }
                }
                .buttonStyle(.borderless)
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.snug)
                .junoFloatingChrome(cornerRadius: JunoRadius.well)
            }
            .padding(JunoSpace.roomy)
            .accessibilityIdentifier("Projects status")
        }
    }

    /// A conflict is its own state — it has two specific answers rather than a
    /// retry — so it is decided here. Everything else goes through the shared
    /// copy, which is what stops a bare "Not found" or "401" from being printed
    /// under the grid as if it were a sentence.
    private var status: (message: String, icon: JunoIcon, isConflict: Bool)? {
        if model.conflictedMutationCount > 0 {
            return (
                "A project changed on another device.",
                .refresh,
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
        return (resolved.message, resolved.icon, false)
    }

    // MARK: - Actions

    private func startCreate() {
        showingNewProject = true
    }

    private func startRename(_ project: NativeProject) {
        renameDraft = project.name
        renameTarget = project
    }

    private func togglePin(_ project: NativeProject) {
        Task { await model.updateProject(id: project.id, starred: !project.starred) }
    }

    private func beginFileImport(for project: NativeProject) {
        fileImportTarget = project.id
        showingFileImporter = true
    }

    private func startVoice(modelID: String, projectID: String) {
        guard let sender = configuration.requestSender else {
            voiceUnavailable = "Juno is not signed in, so it cannot start a voice conversation."
            return
        }
        guard configuration.voiceTranscriptClient != nil else {
            voiceUnavailable = "Voice is unavailable for this account."
            return
        }
        let initialProvider = JunoVoiceProvider.productionDefault
        let started = DesktopVoiceSession(
            controller: JunoRealtimeVoiceController(
                authorization: JunoDesktopVoiceAuthorization(
                    sender: sender,
                    accountID: session.profile.id
                ),
                provider: initialProvider
            ),
            modelID: modelID,
            conversationID: nil,
            projectID: projectID
        )
        voiceSession = started
        // Dialled here rather than from the dock — see the same note in
        // ``DesktopConversationView/startVoice(modelID:)``.
        Task { await started.controller.start(provider: initialProvider) }
    }

    /// The live call, as this project's chat column needs it.
    ///
    /// Projects routes a saved call **differently from Chat**, and deliberately
    /// so: there is never an open conversation here, so `conversationID` is
    /// always nil and the server makes one, which this screen then opens. Chat
    /// appends to the thread the reader was already in. Do not unify them.
    private var voiceColumn: DesktopVoiceColumn? {
        guard let voiceSession else { return nil }
        return DesktopVoiceColumn(
            sessionID: voiceSession.id,
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

// MARK: - Route, sort, metrics

/// Where the Projects destination is. Its root is the index, which is the whole
/// fix: no value of this type means "open whichever project sorted first".
private enum DesktopProjectRoute: Equatable {
    case index
    case project(String)
}

/// The website's Sort-by control, with the same three keys.
///
/// Pinned projects lead in every order. The store and the sidebar already list
/// favourites first, and a sort that silently unpinned them would make one
/// account look like two different products in two places.
private enum DesktopProjectSort: String, CaseIterable, Identifiable {
    case updated
    case name
    case conversations

    var id: Self { self }

    var label: String {
        switch self {
        case .updated: "Last updated"
        case .name: "Name"
        case .conversations: "Conversations"
        }
    }

    /// A strict ordering: every key falls through to the id, so two projects that
    /// tie on the sort key still have a stable, repeatable position.
    func precedes(_ lhs: DesktopProjectRow, _ rhs: DesktopProjectRow) -> Bool {
        if lhs.project.starred != rhs.project.starred { return lhs.project.starred }
        switch self {
        case .updated:
            if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
        case .name:
            let order = lhs.name.localizedStandardCompare(rhs.name)
            if order != .orderedSame { return order == .orderedAscending }
        case .conversations:
            if lhs.conversationCount != rhs.conversationCount {
                return lhs.conversationCount > rhs.conversationCount
            }
        }
        return lhs.id < rhs.id
    }
}

/// The measurements this screen shares, so the index and the detail cannot drift
/// apart the way two hand-built headers did.
private enum DesktopProjectMetrics {
    /// The index's reading width — the website's `max-w-5xl`.
    static let indexWidth: CGFloat = 1024
    /// The detail's — the website's `max-w-6xl`. Wider because it carries a
    /// composer and a context column side by side.
    static let detailWidth: CGFloat = 1152
    /// The glyph beside the serif title, at the website's `size-[0.9em]`.
    static let titleGlyphSize: CGFloat = 25
    /// One search field, one height.
    static let searchHeight: CGFloat = 32
    /// A project card's corner. Deliberately larger than ``JunoRadius/panel`` for
    /// the same reason ``JunoSettingsMetrics/tileRadius`` is: a card holding a
    /// title, a paragraph and a footer is a bigger, calmer object than an
    /// inspector panel, and the website draws it at `rounded-[28px]`.
    static let cardRadius: CGFloat = 20
    /// The website's `h-[160px]`, as a floor rather than a fixed height.
    ///
    /// `NativeProject` has no cover image even though the web API returns
    /// `coverUrl`, so there is no 260-point variant here and none is invented:
    /// the card is designed to read correctly with type alone.
    static let cardHeight: CGFloat = 160
    /// Room kept clear at the top-trailing corner for the ⋯ menu, which is an
    /// overlay so it stays clickable inside the card's own button.
    static let cardMenuInset: CGFloat = 22
    /// The context column beside the composer — the website's `20rem`.
    static let contextColumnWidth: CGFloat = 320
    /// Under this the detail stacks into one column. Below it the composer would
    /// be squeezed under 440 points, which is where its own controls start to
    /// wrap.
    static let twoColumnThreshold: CGFloat = 820

    /// Two cards across at the full reading width, one when the window is narrow
    /// — the website's `grid gap-4 sm:grid-cols-2`. A computed property rather
    /// than a stored one: `GridItem` is a view value, not shared state.
    static var gridColumns: [GridItem] {
        [
            GridItem(
                .adaptive(minimum: 340, maximum: 560),
                spacing: JunoSpace.regular,
                alignment: .top
            )
        ]
    }
}

// MARK: - Card

/// One project, in the website's card anatomy: serif name, an actions menu, the
/// instructions preview, then a footer of real counts on a hairline.
///
/// The instructions preview is the point of the card. It is the only thing that
/// distinguishes two similarly named projects at a glance, and it is what a row
/// of raw `.caption` text could not give room to.
private struct DesktopProjectCard<MenuContent: View>: View {
    let row: DesktopProjectRow
    /// Position in the grid, for the staggered entrance. Capped, as on the web,
    /// so the fortieth card is not still waiting two seconds in.
    let index: Int
    let open: () -> Void
    @ViewBuilder var menu: () -> MenuContent

    @State private var isHovering = false
    @State private var hasAppeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: open) {
            card
        }
        .buttonStyle(.plain)
        // An overlay rather than a child of the button's label: a menu inside a
        // button's label is not clickable, and the website's card has the same
        // arrangement — a menu that does not open the project it sits on.
        .overlay(alignment: .topTrailing) { actionsMenu }
        .contextMenu { menu() }
        .onHover { isHovering = $0 }
        // Tint tier: the hover wash inside `card` is a fill crossfading in
        // place, so it keeps its animation under Reduce Motion.
        .animation(JunoMotion.fast, value: isHovering)
        .opacity(hasAppeared ? 1 : 0)
        .offset(y: hasAppeared || reduceMotion ? 0 : 6)
        // The 6pt rise is spatial travel, so under Reduce Motion the entrance
        // collapses to the flat cross-fade — and the stagger goes with it: a
        // scheduled delay is dead air once the motion it was pacing is gone.
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)?
                .delay(reduceMotion ? 0 : Double(min(index, 12)) * 0.04),
            value: hasAppeared
        )
        .onAppear { hasAppeared = true }
        .accessibilityLabel(row.name)
        .accessibilityValue(
            "\(row.conversationCount) chats, \(row.fileCount) files. \(row.instructionsPreview)"
        )
        .accessibilityIdentifier("juno.project-card.\(row.id)")
        .help(row.instructionsPreview)
        .contentShape(.rect)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            titleRow
            Text(row.instructionsPreview)
                .junoCaption()
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, JunoSpace.roomy)
                .padding(.top, JunoSpace.snug)

            Spacer(minLength: JunoSpace.cozy)

            Divider()
            footer
        }
        .frame(minHeight: DesktopProjectMetrics.cardHeight, alignment: .top)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The pointer-over state is a fill, not a lift. The card used to rise
        // 2pt and grow a 14pt shadow under the pointer — the web's hover idiom,
        // which no Mac surface speaks: Things and Craft answer hover the way a
        // list row does, with a quiet wash on the surface. `junoRowHover` is
        // that wash. An overlay rather than a background so it covers the
        // footer's opaque canvas band too, and at 4.5% alpha it washes rather
        // than dims the type it crosses.
        .overlay(
            Color.junoRowHover
                .opacity(isHovering ? 1 : 0)
                .allowsHitTesting(false)
        )
        // Clipped before the card fill is applied, so the footer's wash stops at
        // the corner curve instead of squaring it off.
        .clipShape(
            RoundedRectangle(
                cornerRadius: DesktopProjectMetrics.cardRadius,
                style: .continuous
            )
        )
        .junoCard(cornerRadius: DesktopProjectMetrics.cardRadius)
        .contentShape(.rect)
    }

    private var titleRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
            Text(row.name)
                .font(JunoSerif.cardTitle)
                .lineLimit(1)
                .truncationMode(.tail)
            if row.project.starred {
                JunoIconView(.pin, size: 12)
                    .foregroundStyle(Color.junoAccent)
                    .accessibilityLabel("Pinned")
            }
            if row.project.isPending {
                ProgressView()
                    .controlSize(.mini)
                    .accessibilityLabel("Waiting to sync")
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, JunoSpace.roomy)
        .padding(.trailing, JunoSpace.roomy + DesktopProjectMetrics.cardMenuInset)
        .padding(.top, JunoSpace.roomy)
    }

    private var actionsMenu: some View {
        Menu {
            menu()
        } label: {
            JunoIconView(.ellipsis)
                .junoSecondaryInk()
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: DesktopProjectMetrics.cardMenuInset)
        // Revealed on hover like the website's row actions, but kept in the
        // layout at all times so the title never reflows under the pointer.
        .opacity(isHovering ? 1 : 0)
        .padding(.trailing, JunoSpace.regular)
        .padding(.top, JunoSpace.regular)
        .accessibilityLabel("Actions for \(row.name)")
        .accessibilityIdentifier("juno.project-card-actions.\(row.id)")
        .contentShape(.rect)
    }

    private var footer: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("Updated \(row.updatedAt.formatted(.relative(presentation: .named)))")
                .junoCodeSmall()
                .junoSecondaryInk()
                .lineLimit(1)
            Spacer(minLength: JunoSpace.snug)
            count(.conversation, row.conversationCount, "chats")
            count(.file, row.fileCount, "files")
        }
        .padding(.horizontal, JunoSpace.roomy)
        .padding(.vertical, JunoSpace.cozy)
        // The canvas colour *inside* a raised card reads as the website's
        // `bg-muted/10`: a recess, using a token rather than a guessed alpha.
        .background(Color.junoCanvasWarm)
    }

    private func count(_ icon: JunoIcon, _ value: Int, _ label: String) -> some View {
        HStack(spacing: JunoSpace.hairline) {
            JunoIconView(icon, size: 11)
            Text(value.formatted())
                .monospacedDigit()
        }
        .junoCodeSmall()
        .junoSecondaryInk()
        .accessibilityLabel("\(value) \(label)")
    }
}

/// The loading state the website shows: six shaped cards, revealed 50ms apart.
///
/// Built from the real card's shape under `.redacted(reason: .placeholder)`
/// rather than from hand-painted bars, so a change to the card is a change to its
/// skeleton. A lone spinner used to stand in for this, which told the reader
/// nothing about what was arriving.
private struct DesktopProjectSkeletonGrid: View {
    @State private var hasAppeared = false

    var body: some View {
        ScrollView {
            LazyVGrid(
                columns: DesktopProjectMetrics.gridColumns,
                alignment: .leading,
                spacing: JunoSpace.regular
            ) {
                ForEach(0..<6, id: \.self) { index in
                    card
                        .opacity(hasAppeared ? 1 : 0)
                        .animation(
                            JunoMotion.standard.delay(Double(index) * 0.05),
                            value: hasAppeared
                        )
                }
            }
            .padding(.horizontal, JunoSpace.region)
            .padding(.vertical, JunoSpace.section)
            .frame(maxWidth: DesktopProjectMetrics.indexWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .onAppear { hasAppeared = true }
        .accessibilityLabel("Loading projects")
        .accessibilityIdentifier("Projects loading")
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                Text("Project name")
                    .font(JunoSerif.cardTitle)
                Text("Two lines of the instructions this project applies to every chat inside it.")
                    .junoCaption()
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(JunoSpace.roomy)

            Spacer(minLength: JunoSpace.cozy)

            Divider()
            HStack {
                Text("Updated recently")
                Spacer(minLength: JunoSpace.snug)
                Text("0 · 0")
            }
            .junoCodeSmall()
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.vertical, JunoSpace.cozy)
            .background(Color.junoCanvasWarm)
        }
        .frame(minHeight: DesktopProjectMetrics.cardHeight, alignment: .top)
        .redacted(reason: .placeholder)
        .clipShape(
            RoundedRectangle(
                cornerRadius: DesktopProjectMetrics.cardRadius,
                style: .continuous
            )
        )
        .junoCard(cornerRadius: DesktopProjectMetrics.cardRadius)
        .accessibilityHidden(true)
    }
}

/// One card's worth of project: the record plus the two counts the index shows
/// and can sort on, read once here rather than in every cell.
private struct DesktopProjectRow: Identifiable {
    let project: NativeProject
    let conversationCount: Int
    let fileCount: Int

    var id: String { project.id }
    var name: String { project.name }
    var updatedAt: Date { project.updatedAt }

    /// The instructions on one run of text, for the card's two-line preview.
    ///
    /// Collapsed rather than truncated by `lineLimit` alone: a prompt usually
    /// opens with a heading or a blank line, so the first *visual* line of the
    /// raw text is frequently empty and the card would look broken.
    ///
    /// **And stripped of its structural markup, which is the rest of the fix.**
    /// Juno's own prompt guidance tells people to bracket a system prompt into
    /// sections, so a real project's instructions commonly begin `<role> You are
    /// a research assistant… </role> <standing_context>…`. Two lines of that on a
    /// card spends the entire preview on tag names — the reader sees `<role>` and
    /// `<standing_context>` and learns nothing about which project this is, which
    /// is the one job the preview has. The tags are scaffolding for the model,
    /// not prose for a person, so the card shows the prose between them.
    ///
    /// The pattern is deliberately narrow: `<`, an optional `/`, an identifier
    /// that starts with a letter, optional attributes containing no angle
    /// bracket, and `>`. Prompts are full of ordinary text and this must not eat
    /// `a < b`, `->` or `<= 3`, none of which match. Nothing is stripped from the
    /// stored instructions — this is a display transform on the card alone, and
    /// the detail page and the editor still show the prompt exactly as written,
    /// because a prompt is source and a reader editing one needs its structure.
    var instructionsPreview: String {
        JunoPromptPreview.text(project.instructions)
    }
}

// MARK: - Detail

private enum DesktopProjectTab: String, CaseIterable, Identifiable {
    case overview
    case workspace
    /// The assistant half of the project: persona, tool whitelist, knowledge
    /// selection, preferred model.
    ///
    /// Its own section rather than a third column on Workspace, because
    /// everything here has its own independently revisioned sync entity, so a
    /// tool edit cannot collide with a project rename from another device.
    case assistant

    var id: Self { self }
    var label: String { rawValue.capitalized }
}

/// One project's page: the website's `/projects/[id]`, column for column.
///
/// **What this is not any more.** It was an `HSplitView` whose right-hand pane
/// repeated the left one — instructions twice, files twice, the counts three
/// times — so the page argued with itself about which copy was authoritative.
/// The website's answer, and now this one: Overview is the *working* surface
/// (composer, chats, and a context card that summarises), Workspace is where the
/// same instructions and files are actually managed. Never both at once.
private struct DesktopProjectDetail: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    @Bindable var conversationModel: NativeConversationModel<SQLiteAccountRepository>
    let configuration: JunoDesktopConfiguration
    let project: NativeProject
    let openConversation: (String) -> Void
    let startConversation: (String?) -> Void
    let openVoiceMode: (String) -> Void
    /// The live call, when there is one. Passed down rather than owned here
    /// because the screen above owns the session *and* its save routing — see
    /// ``DesktopProjectsScreen/voiceColumn``.
    let voiceColumn: DesktopVoiceColumn?
    let addFiles: () -> Void
    let editInstructions: () -> Void
    let togglePin: () -> Void
    let renameProject: () -> Void
    let deleteProject: () -> Void
    let showAllProjects: () -> Void

    @State private var tab = DesktopProjectTab.overview
    @State private var isWide = true
    @State private var isDropTargeted = false
    @State private var renameFileTarget: NativeProjectFile?
    @State private var fileNameDraft = ""

    private var conversations: [NativeProjectConversation] {
        model.conversationsByProject[project.id] ?? []
    }

    private var files: [NativeProjectFile] {
        model.filesByProject[project.id] ?? []
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                backControl
                header
                sectionPicker
                switch tab {
                case .overview: overview
                case .workspace: workspace
                case .assistant: assistant
                }
            }
            // Width only. The column count changes this page's height, never its
            // width, so the measurement cannot feed back into itself.
            .onGeometryChange(for: Bool.self) { proxy in
                proxy.size.width >= DesktopProjectMetrics.twoColumnThreshold
            } action: { isWide = $0 }
            .frame(maxWidth: DesktopProjectMetrics.detailWidth, alignment: .leading)
            .padding(.horizontal, JunoSpace.region)
            .padding(.vertical, JunoSpace.section)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        // Dropping a file onto the project is the same operation as Add files…,
        // and it is the gesture a Mac user tries first.
        .dropDestination(for: URL.self) { urls, _ in
            guard !project.isPending, !urls.isEmpty else { return false }
            Task {
                await DesktopProjectFiles.upload(urls, projectID: project.id, model: model)
            }
            return true
        } isTargeted: { isDropTargeted = $0 }
        .alert(
            "Rename file",
            isPresented: Binding(
                get: { renameFileTarget != nil },
                set: { presented in if !presented { renameFileTarget = nil } }
            )
        ) {
            TextField("File name", text: $fileNameDraft)
            Button("Cancel", role: .cancel) { renameFileTarget = nil }
            .contentShape(.rect)
            Button("Rename") {
                if let target = renameFileTarget {
                    Task { await model.renameFile(id: target.id, fileName: fileNameDraft) }
                }
                renameFileTarget = nil
            }
            .contentShape(.rect)
        }
        .accessibilityIdentifier("Project detail")
    }

    private var backControl: some View {
        Button(action: showAllProjects) {
            Label("All projects", icon: .chevronLeft)
                .junoRowLabel()
        }
        .buttonStyle(.plain)
        .junoSecondaryInk()
        .help("Back to every project")
        .accessibilityIdentifier("All projects")
        .contentShape(.rect)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("Project")
                .junoCodeSmall()
                .junoSecondaryInk()
                .accessibilityAddTraits(.isHeader)

            HStack(alignment: .center, spacing: JunoSpace.cozy) {
                Text(project.name)
                    .font(JunoSerif.font(size: 38, relativeTo: .largeTitle, face: .medium))
                    .lineLimit(2)
                    .textSelection(.enabled)
                Button(action: renameProject) {
                    JunoIconView(.pencil)
                }
                .buttonStyle(.plain)
                .junoSecondaryInk()
                .disabled(project.isPending)
                .help("Rename project")
                .accessibilityLabel("Rename project")
                .contentShape(.rect)

                Spacer(minLength: JunoSpace.regular)

                Button {
                    startConversation(nil)
                } label: {
                    Label("New chat", icon: .compose)
                }
                .junoProminentGlassButton()
                .disabled(project.isPending)
                .help("Start a chat with this project's instructions and files")
                .accessibilityIdentifier("New chat in project")
                .contentShape(.rect)

                pinControl
                actionsMenu
            }

            Text(
                "^[\(conversations.count) chat](inflect: true) · ^[\(files.count) file](inflect: true) · Updated \(project.updatedAt.formatted(.relative(presentation: .named)))"
            )
            .junoCodeSmall()
            .junoSecondaryInk()

            assistantSummaryLine
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Project detail header")
    }

    /// This project's local assistant setup, when one has been made.
    ///
    /// Resolved through the model on every read rather than copied into state:
    /// the Assistant tab writes to the same object, and a cached copy here is how
    /// a header comes to advertise a persona the reader renamed a moment ago.
    private var assistantConfiguration: ProjectWorkspaceConfiguration? {
        configuration.projectWorkspaceModel?.workspaces[project.id]
    }

    /// Says out loud that this project answers as something other than itself,
    /// and that its assistant is restricted.
    ///
    /// In the header rather than only inside the Assistant tab because a
    /// whitelist the reader has to go looking for is one they forget they set —
    /// and "why did Juno not search the web in here" is the support question that
    /// follows.
    @ViewBuilder
    private var assistantSummaryLine: some View {
        if let assistantConfiguration {
            let persona = assistantConfiguration.personaName?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let parts: [String] = [
                persona.flatMap { $0.isEmpty ? nil : "Answers as “\($0)”" },
                assistantConfiguration.toolAccess.isRestricted ? "Restricted tools" : nil,
                DesktopAssistantCopy.knowledgeCount(
                    assistantConfiguration.knowledgeFileIDs.count
                ),
            ].compactMap { $0 }
            if !parts.isEmpty {
                // `verbatim:` because these are already-composed strings. Without
                // it SwiftUI reads them as localization keys and a persona named
                // with a `%` or a bracket would be rendered as a format
                // specifier — a project name is arbitrary text, not a key.
                Text(verbatim: parts.joined(separator: " · "))
                    .junoCodeSmall()
                    .junoSecondaryInk()
                    .accessibilityIdentifier("Project assistant summary")
            }
        }
    }

    private var pinControl: some View {
        Button(action: togglePin) {
            JunoIconView(.pin, size: 16)
                .foregroundStyle(project.starred ? Color.junoAccent : Color.junoMutedForeground)
        }
        .buttonStyle(.plain)
        .disabled(project.isPending || model.isMutating)
        .help(project.starred ? "Unpin this project" : "Pin this project")
        .accessibilityLabel(project.starred ? "Unpin project" : "Pin project")
        .accessibilityIdentifier("Pin project")
        .contentShape(.rect)
    }

    private var actionsMenu: some View {
        Menu {
            Button("Rename…", action: renameProject)
            Button("Edit instructions…", action: editInstructions)
            Button("Add files…", action: addFiles)
            Divider()
            Button("Delete project…", role: .destructive, action: deleteProject)
        } label: {
            Label("Project actions", icon: .ellipsis)
        }
        .labelStyle(.iconOnly)
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(project.isPending || model.isMutating)
        .help("Rename, edit instructions, add files, or delete this project")
        .accessibilityIdentifier("Project detail actions")
        .contentShape(.rect)
    }

    private var sectionPicker: some View {
        // `DesktopSegmented`, not `Picker(.segmented)`: the AppKit control is
        // for window toolbars, and inside content it draws its pre-Tahoe
        // chrome in the app accent. The glass-knob switcher is the in-content
        // rule everywhere else, and it sizes itself — the 240pt frame the
        // picker needed goes with it.
        DesktopSegmented(
            options: DesktopProjectTab.allCases.map { .init($0, $0.label) },
            selection: $tab,
            accessibilityLabel: "Project section"
        )
        .accessibilityIdentifier("Project section")
    }

    // MARK: Overview

    /// `AnyLayout` rather than two branches of an `if`: the children keep their
    /// identity across the switch, so dragging the window past the threshold does
    /// not tear down and rebuild the composer with the reader's draft in it.
    private var overview: some View {
        let layout = isWide
            ? AnyLayout(HStackLayout(alignment: .top, spacing: JunoSpace.section))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: JunoSpace.section))
        return layout {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                quickStart
                projectChats
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            contextCard
                .frame(maxWidth: isWide ? DesktopProjectMetrics.contextColumnWidth : .infinity)
        }
    }

    private var quickStart: some View {
        DesktopComposer(
            model: conversationModel,
            attachmentModel: configuration.attachmentModel,
            libraryModel: configuration.libraryModel,
            projectModel: model,
            // This composer is locked to `project.id`, so the assistant's
            // preferred model applies to everything started from here — see
            // ``DesktopComposer/routedModelID(for:)``.
            workspaceModel: configuration.projectWorkspaceModel,
            documentIndex: configuration.documentIndexModel,
            connectorModel: configuration.connectorModel,
            draftProjectID: .constant(nil),
            draftPrompt: .constant(nil),
            openVoiceMode: openVoiceMode,
            fixedProjectID: project.id,
            didSendConversation: openConversation
        )
        // Voice happens here, over this project's own composer, rather than in a
        // sheet — see ``DesktopVoiceDock``.
        .junoVoiceColumn(voiceColumn)
        .frame(maxWidth: .infinity)
        .disabled(project.isPending)
    }

    private var projectChats: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            eyebrow("Chats in this project")
            if conversations.isEmpty {
                DesktopProjectPlaceholder(
                    title: "No chats yet",
                    message: "Ask a question in the composer above to start a conversation."
                )
            } else {
                ForEach(conversations) { conversation in
                    chatRow(conversation)
                }
            }
        }
    }

    private func chatRow(_ conversation: NativeProjectConversation) -> some View {
        Button {
            openConversation(conversation.id)
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                JunoIconView(.conversation, size: 15)
                    .junoSecondaryInk()
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(conversation.title)
                        .junoRowLabel()
                        .fontWeight(.medium)
                        .lineLimit(1)
                    Text(
                        "Last message \(conversation.lastMessageAt.formatted(.relative(presentation: .named)))"
                    )
                    .junoCodeSmall()
                    .junoSecondaryInk()
                }
                Spacer(minLength: JunoSpace.snug)
                if conversation.pinned {
                    JunoIconView(.pin, size: 12)
                        .foregroundStyle(Color.junoAccent)
                        .accessibilityLabel("Pinned")
                }
                JunoIconView(.chevronRight)
                    .font(.caption)
                    .junoMetaInk()
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
            .junoCard()
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Open this chat")
        .accessibilityLabel("Open chat, \(conversation.title)")
    }

    /// The website's right-hand card: what this project *is*, summarised, beside
    /// the place the reader works. Every control on it opens the surface that
    /// owns the thing it summarises — nothing is edited twice.
    private var contextCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            contextInstructions
            Divider()
            contextFiles
            Divider()
            contextFacts
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
        .accessibilityIdentifier("Project context")
    }

    private var contextInstructions: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack {
                eyebrow("Instructions")
                Spacer(minLength: JunoSpace.snug)
                Button(action: editInstructions) {
                    JunoIconView(.pencil)
                }
                .buttonStyle(.plain)
                .junoSecondaryInk()
                .disabled(project.isPending || model.isMutating)
                .help("Edit this project's instructions")
                .accessibilityLabel("Edit project instructions")
                .accessibilityIdentifier("Edit project instructions")
                .contentShape(.rect)
            }

            if project.instructions.isEmpty {
                DesktopProjectPlaceholder(
                    message: "No instructions yet — add a prompt Juno follows in every chat here.",
                    action: editInstructions
                )
            } else {
                Button(action: editInstructions) {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        // Monospaced: it is a prompt, and its structure is part of
                        // what the reader is checking.
                        Text(project.instructions)
                            .junoCode()
                            .junoSecondaryInk()
                            .lineLimit(4)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(instructionsFacts)
                            .junoCodeSmall()
                            .junoMetaInk()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(JunoSpace.cozy)
                    .junoPanel(cornerRadius: JunoRadius.chip)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Edit this project's instructions")
            }
        }
        .padding(JunoSpace.regular)
    }

    private var instructionsFacts: String {
        let lines = project.instructions
            .split(whereSeparator: \.isNewline)
            .count
        return "\(project.instructions.count.formatted()) chars · \(lines) lines"
    }

    private var contextFiles: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack {
                eyebrow("Files")
                Spacer(minLength: JunoSpace.snug)
                Button(action: addFiles) {
                    JunoIconView(.plus)
                }
                .buttonStyle(.plain)
                .junoSecondaryInk()
                .disabled(project.isPending || model.isPerformingFileAction)
                .help("Add files to this project")
                .accessibilityLabel("Add project files")
                .accessibilityIdentifier("Add project files")
                .contentShape(.rect)
            }

            if files.isEmpty {
                DesktopProjectPlaceholder(
                    message: "Add PDFs, documents, or other text to reference in this project.",
                    action: addFiles
                )
            } else {
                // Names and sizes only. Managing files — rename, delete, open — is
                // Workspace's job, and putting the same menu in both places is how
                // this screen ended up with two of everything.
                ForEach(files) { file in
                    HStack(spacing: JunoSpace.snug) {
                        JunoIconView(DesktopProjectFileFacts.icon(for: file), size: 16)
                            .junoSecondaryInk()
                            .accessibilityHidden(true)
                        Text(file.fileName)
                            .junoCaption()
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: JunoSpace.snug)
                        Text(DesktopProjectFileFacts.size(of: file))
                            .junoCodeSmall()
                            .junoSecondaryInk()
                    }
                }
            }
        }
        .padding(JunoSpace.regular)
    }

    private var contextFacts: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            eyebrow("Details")
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
        .junoCaption()
        .padding(JunoSpace.regular)
    }

    // MARK: Assistant

    /// The custom-assistant surface, or an honest explanation of why it is not
    /// there.
    ///
    /// Absent rather than disabled when the store could not be opened: a page of
    /// greyed-out switches invites the reader to work out what is wrong, while a
    /// sentence tells them.
    @ViewBuilder
    private var assistant: some View {
        if let workspaceModel = configuration.projectWorkspaceModel {
            DesktopProjectAssistantPanel(
                project: project,
                files: files,
                workspaceModel: workspaceModel,
                // Chat models only. An assistant's preferred model is the one a
                // conversation opens on, and an image model cannot hold one.
                modelCatalog: conversationModel.selectableModels.filter {
                    $0.modality == "chat"
                },
                memories: configuration.memorySettingsModel?.memories ?? [],
                isWide: isWide
            )
        } else {
            DesktopProjectPlaceholder(
                title: "Assistant setup is unavailable",
                message: "Juno could not open the account store, so assistant settings cannot be saved.",
                icon: .triangleAlert
            )
        }
    }

    // MARK: Workspace

    private var workspace: some View {
        let layout = isWide
            ? AnyLayout(HStackLayout(alignment: .top, spacing: JunoSpace.section))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: JunoSpace.section))
        return layout {
            instructionsCard
            filesCard
        }
    }

    private var instructionsCard: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    eyebrow("System instructions")
                    Text("How Juno behaves in this project")
                        .font(JunoSerif.cardTitle)
                }
                Spacer(minLength: JunoSpace.snug)
                Button(action: editInstructions) {
                    Label("Full editor", icon: .maximize)
                }
                .disabled(project.isPending || model.isMutating)
                .accessibilityIdentifier("Open instructions editor")
                .contentShape(.rect)
            }

            if project.instructions.isEmpty {
                DesktopProjectPlaceholder(
                    title: "No instructions yet",
                    message: "Add a prompt Juno reads before every chat in this project.",
                    action: editInstructions
                )
            } else {
                Text(project.instructions)
                    .junoCode()
                    .textSelection(.enabled)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(JunoSpace.cozy)
                    .junoPanel(cornerRadius: JunoRadius.chip)
                Text("\(instructionsFacts) · Updated \(project.updatedAt.formatted(.relative(presentation: .named)))")
                    .junoCodeSmall()
                    .junoSecondaryInk()
            }

            Text("These instructions are prepended to every chat in this project — Juno reads them before your first message, alongside the files below.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(JunoSpace.cozy)
                .junoPanel(cornerRadius: JunoRadius.chip)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(JunoSpace.regular)
        .junoCard()
    }

    private var filesCard: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    eyebrow("Referenced files")
                    Text("^[\(files.count) file](inflect: true) · \(DesktopProjectFileFacts.totalSize(of: files))")
                        .junoCodeSmall()
                        .junoSecondaryInk()
                }
                Spacer(minLength: JunoSpace.snug)
                Button(action: addFiles) {
                    Label("Add file", icon: .attach)
                }
                .disabled(project.isPending || model.isPerformingFileAction)
                .accessibilityIdentifier("Add project files")
                .contentShape(.rect)
            }

            if files.isEmpty {
                DesktopProjectPlaceholder(
                    title: "No files yet",
                    message: "Drop files here or click to browse — Juno references them in every chat.",
                    icon: .upload,
                    action: addFiles
                )
            } else {
                ForEach(files) { file in
                    fileRow(file)
                }
            }

            Text("Drag and drop anywhere on this page to add files.")
                .junoCodeSmall()
                .junoMetaInk()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(JunoSpace.regular)
        .junoCard()
        .overlay {
            // The drop lands in this project's files wherever it is released, so
            // this is the surface that acknowledges it.
            //
            // One of the few places the accent survived the greyscale pass, and
            // deliberately: the web's own drop target is `border-primary/60
            // ring-2 ring-primary/20` (`projects/[id]/page.tsx:929`). Coral here
            // is not decoration on a resting state — it appears only while a drag
            // is over the page, and it is what says the release will land.
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(
                    isDropTargeted ? Color.junoAccent : .clear,
                    lineWidth: 2
                )
        }
        .animation(JunoMotion.fast, value: isDropTargeted)
    }

    private func fileRow(_ file: NativeProjectFile) -> some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(DesktopProjectFileFacts.icon(for: file), size: 16)
                .junoSecondaryInk()
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                // A link, because activating it opens the file outside Juno —
                // the platform's own signal for "this leaves here".
                Button {
                    Task { await open(file) }
                } label: {
                    Text(file.fileName)
                        .junoRowLabel()
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .buttonStyle(.link)
                .help("Open \(file.fileName)")
                .contentShape(.rect)
                Text(DesktopProjectFileFacts.detail(for: file))
                    .junoCodeSmall()
                    .junoSecondaryInk()
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
                Label("File options", icon: .ellipsis)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(model.isPerformingFileAction)
            .accessibilityLabel("Options for \(file.fileName)")
            .contentShape(.rect)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .junoPanel(cornerRadius: JunoRadius.chip)
    }

    private func eyebrow(_ text: String) -> some View {
        Text(text)
            .junoCodeSmall()
            .junoSecondaryInk()
            .accessibilityAddTraits(.isHeader)
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

/// An empty section *inside* a page — the dashed box the website uses for "no
/// chats yet", "no instructions yet", "no files yet".
///
/// Deliberately not ``JunoEmptyState``: that one owns a whole screen, with a
/// 72-point circle and a centred column, and using it for a section is how this
/// screen ended up speaking two empty-state languages at once (plus a bare
/// `ContentUnavailableView` in a third).
private struct DesktopProjectPlaceholder: View {
    var title: String?
    let message: String
    var icon: JunoIcon?
    var action: (() -> Void)?

    var body: some View {
        if let action {
            Button(action: action) { box }
                .buttonStyle(.plain)
                .contentShape(.rect)
        } else {
            box
        }
    }

    private var box: some View {
        VStack(spacing: JunoSpace.snug) {
            if let icon {
                JunoIconView(icon, size: 16)
                    .font(.title2)
                    .junoMetaInk()
            }
            if let title {
                Text(title)
                    .font(JunoSerif.cardTitle)
            }
            Text(message)
                .junoCaption()
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(JunoSpace.roomy)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(
                    Color.junoBorder,
                    style: StrokeStyle(lineWidth: 1, dash: [4, 4])
                )
        )
        .contentShape(.rect)
    }
}

// MARK: - Assistant

/// Wording shared by the two surfaces that describe a custom assistant, so the
/// header's summary and the panel's own labels cannot drift into saying different
/// things about the same configuration.
private enum DesktopAssistantCopy {
    /// Nil at zero. "0 knowledge files" in a summary line is a fact nobody needs,
    /// and it makes an unconfigured project look configured.
    static func knowledgeCount(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count == 1 ? "1 knowledge file" : "\(count) knowledge files"
    }

    /// What withholding a tool actually does on this device.
    ///
    /// Written per tool rather than as one blanket sentence because the vetoes are
    /// genuinely different mechanisms, and a reader deciding whether to trust a
    /// switch deserves to know which one they are getting. Canvas in particular is
    /// inverted — the server's default is *on*, so denying it means sending an
    /// explicit `false` rather than sending nothing.
    static func enforcement(of tool: ProjectWorkspaceTool) -> String {
        switch tool {
        case .webSearch:
            "Turns in this project are sent without the web-search flag."
        case .deepResearch:
            "The research pipeline is never requested from this project."
        case .canvas:
            "Sent as an explicit “off”, because the server turns canvas on by default."
        case .mediaGeneration:
            "Sending to an image or video model from this project is refused."
        case .connectors:
            "No connected app is offered to a turn in this project."
        case .memoryRecall:
            "Juno is not told what it remembers about you here — and learns nothing new from these chats."
        }
    }
}

/// One project's **custom assistant**: the persona, the tool whitelist, which of
/// its files count as knowledge, and which model it prefers.
///
/// Everything on this panel is stored as a revisioned `project_workspace`
/// entity. The alternative — folding a whitelist into project instructions as
/// prose — remains deliberately absent: prose is not an enforceable gate.
private struct DesktopProjectAssistantPanel: View {
    let project: NativeProject
    let files: [NativeProjectFile]
    let workspaceModel: ProjectWorkspaceModel<SQLiteAccountRepository>
    let modelCatalog: [NativeChatModelOption]
    /// Read only to render the prompt preview honestly. Nothing here writes a
    /// memory; that is ``NativeMemorySettingsModel``'s job and its alone.
    let memories: [NativeMemoryEntry]
    let isWide: Bool

    /// The two free-text fields are drafts with explicit saves rather than
    /// write-on-keystroke bindings. A persona name is committed once; enqueuing a
    /// compare-and-set write per character would race its own retries and make
    /// every keystroke a chance to lose the edit next door.
    @State private var personaDraft = ""
    @State private var instructionsDraft = ""
    @State private var overridesInstructions = false

    private var workspace: ProjectWorkspaceConfiguration? {
        workspaceModel.workspaces[project.id]
    }

    var body: some View {
        let layout = isWide
            ? AnyLayout(HStackLayout(alignment: .top, spacing: JunoSpace.section))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: JunoSpace.section))
        return VStack(alignment: .leading, spacing: JunoSpace.regular) {
            syncNotice
            layout {
                VStack(alignment: .leading, spacing: JunoSpace.section) {
                    personaCard
                    toolsCard
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: JunoSpace.section) {
                    knowledgeCard
                    promptCard
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let error = workspaceModel.lastErrorDescription {
                Text(error)
                    .junoCaption()
                    .foregroundStyle(Color.junoDanger)
                    .textSelection(.enabled)
            }
        }
        // Keyed on the project, not on the workspace record: re-seeding the drafts
        // every time the record changed would wipe a half-typed persona name the
        // moment the save it is racing lands.
        .task(id: project.id) { seedDrafts() }
        .accessibilityIdentifier("Project assistant")
    }

    // MARK: Sync

    private var syncNotice: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            JunoIconView(.refresh)
                .junoSecondaryInk()
                .accessibilityHidden(true)
            Text("Persona, preferred model, tool limits and knowledge selection sync with this project on your Juno devices.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(JunoSpace.cozy)
        .junoPanel(cornerRadius: JunoRadius.chip)
        .accessibilityIdentifier("Assistant sync status")
    }

    // MARK: Persona

    private var personaCard: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            cardHeading("Persona", "Who this project answers as")

            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(spacing: JunoSpace.snug) {
                    // The placeholder is the project's own name, which is what an
                    // empty field means. Clearing the field is therefore a real
                    // instruction — "go back to the project name" — rather than a
                    // persona called nothing.
                    TextField(project.name, text: $personaDraft)
                        .onSubmit(savePersonaName)
                        .accessibilityLabel("Assistant name")
                        .accessibilityIdentifier("Assistant name")
                    Button("Save", action: savePersonaName)
                        .disabled(!personaNameChanged || workspaceModel.isSaving)
                        .contentShape(.rect)
                }
                Text("Leave empty to use the project's own name.")
                    .junoCaption()
            }

            Divider()

            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Picker("Preferred model", selection: preferredModelBinding) {
                    Text("Account default").tag(String?.none)
                    ForEach(modelCatalog) { option in
                        Text(option.displayName).tag(String?.some(option.id))
                    }
                }
                .accessibilityIdentifier("Assistant preferred model")
                // The caption this replaces admitted the setting did nothing —
                // "Chat's own model picker still chooses the model for each
                // turn". It does now, so this says what it does and, just as
                // importantly, what still beats it.
                Text("Chats in this project use this model on every device. An explicit composer choice still wins for that conversation.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Toggle("Replace the project's instructions", isOn: overrideBinding)
                    .accessibilityIdentifier("Assistant overrides instructions")
                if overridesInstructions {
                    TextEditor(text: $instructionsDraft)
                        .junoMono()
                        .scrollContentBackground(.hidden)
                        .padding(JunoSpace.snug)
                        .frame(minHeight: 120)
                        .junoPanel(cornerRadius: JunoRadius.chip)
                        .accessibilityLabel("Assistant instructions")
                        .accessibilityIdentifier("Assistant instructions")
                    HStack {
                        Text("\(instructionsDraft.count) characters")
                            .junoCaption()
                            .monospacedDigit()
                        Spacer(minLength: JunoSpace.snug)
                        Button("Save instructions", action: saveInstructions)
                            .disabled(!instructionsChanged || workspaceModel.isSaving)
                            .contentShape(.rect)
                    }
                    // Empty is a real override and not the same as switching this
                    // off: it says "this assistant has no instructions at all",
                    // which is a legitimate thing to want and impossible to say
                    // any other way.
                    Text("Empty means this assistant answers with no instructions at all. Switch this off to go back to the project's synced instructions.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Using the project's own instructions, which sync to your other devices.")
                        .junoCaption()
                }
            }

            if workspace != nil {
                Divider()
                Button("Forget this assistant", role: .destructive) {
                    Task {
                        await workspaceModel.delete(projectID: project.id)
                        seedDrafts()
                    }
                }
                .disabled(workspaceModel.isSaving)
                .help("Removes the persona, whitelist and knowledge selection. The project, its chats and its files are untouched.")
                .accessibilityIdentifier("Forget assistant")
                .contentShape(.rect)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(JunoSpace.regular)
        .junoCard()
    }

    // MARK: Tools

    private var toolsCard: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            cardHeading("Tools", "What this assistant may reach for")

            Toggle("Restrict this assistant's tools", isOn: restrictionBinding)
                .accessibilityIdentifier("Assistant restrict tools")

            if workspace?.toolAccess.isRestricted == true {
                ForEach(ProjectWorkspaceTool.allCases) { tool in
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Toggle(tool.displayName, isOn: toolBinding(tool))
                            .accessibilityIdentifier("Assistant tool \(tool.rawValue)")
                        if workspace?.toolAccess.allows(tool) == false {
                            Text(DesktopAssistantCopy.enforcement(of: tool))
                                .junoCaption()
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                Text("Juno stops sending the capability, rather than asking the model not to use it. A restriction written into a prompt is advice; this is the client refusing.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(JunoSpace.cozy)
                    .junoPanel(cornerRadius: JunoRadius.chip)
            } else {
                Text("This assistant uses whatever your account and the chosen model normally allow. That is not the same as allowing everything — it is having no opinion.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(JunoSpace.regular)
        .junoCard()
    }

    // MARK: Knowledge

    private var knowledgeCard: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            cardHeading("Knowledge", "Which of this project's files are reference material")

            if files.isEmpty {
                DesktopProjectPlaceholder(
                    message: "This project has no files yet. Add some on the Workspace tab and they can be chosen here."
                )
            } else {
                ForEach(files) { file in
                    Toggle(isOn: knowledgeBinding(file)) {
                        HStack(spacing: JunoSpace.snug) {
                            JunoIconView(DesktopProjectFileFacts.icon(for: file), size: 16)
                                .junoSecondaryInk()
                                .accessibilityHidden(true)
                            Text(file.fileName)
                                .junoRowLabel()
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: JunoSpace.snug)
                            Text(DesktopProjectFileFacts.size(of: file))
                                .junoCodeSmall()
                                .junoSecondaryInk()
                        }
                    }
                    .disabled(isKnowledgeFull && !isKnowledge(file))
                    .accessibilityIdentifier("Assistant knowledge \(file.id)")
                }
                if isKnowledgeFull {
                    Text("An assistant can hold \(ProjectWorkspaceConfiguration.maximumKnowledgeFiles) knowledge files. Past that the list of them crowds out the conversation.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // The reason this is a selection rather than "all of them": a project
            // collects every image ever pasted into one of its chats.
            Text("A project keeps every file that has ever been attached to a chat inside it. Only the ones ticked here are treated as this assistant's reference material.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(JunoSpace.regular)
        .junoCard()
    }

    // MARK: Prompt preview

    /// Exactly what this assistant would be told, assembled by the same function
    /// that would assemble it for real.
    ///
    /// Rendered rather than described, and built by ``ProjectWorkspacePrompt``
    /// rather than by a second copy of its rules here: a preview written
    /// separately is a preview that can be wrong, and the whole reason to show one
    /// is that memory injection and a knowledge manifest are otherwise invisible.
    private var promptCard: some View {
        let composed = ProjectWorkspacePrompt.systemPrompt(
            workspace: workspace,
            project: project,
            knowledgeFileNames: knowledgeFileNames,
            memories: memories
        )
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            cardHeading("Preview", "What this assistant is told")

            if composed.isEmpty {
                DesktopProjectPlaceholder(
                    message: "Nothing yet — add instructions, pick knowledge files, or let Juno remember something."
                )
            } else {
                ScrollView {
                    Text(composed)
                        .junoCode()
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(JunoSpace.cozy)
                }
                .frame(maxHeight: 260)
                .junoPanel(cornerRadius: JunoRadius.chip)
                .accessibilityIdentifier("Assistant prompt preview")
            }

            Text("Memory appears here only while this assistant is allowed to recall it. The knowledge list names files rather than repeating their contents — the server already has the bytes.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(JunoSpace.regular)
        .junoCard()
    }

    // MARK: Bindings

    private var preferredModelBinding: Binding<String?> {
        Binding(
            get: { workspace?.preferredModelID },
            set: { value in save { $0.preferredModelID = value } }
        )
    }

    private var overrideBinding: Binding<Bool> {
        Binding(
            get: { overridesInstructions },
            set: { isOn in
                overridesInstructions = isOn
                if isOn {
                    // Seeded from the synced instructions so switching the toggle
                    // on does not present an empty editor over a project that has
                    // a prompt — the reader would take the blank field for the
                    // truth and save it.
                    if instructionsDraft.isEmpty { instructionsDraft = project.instructions }
                    save { $0.instructionsOverride = instructionsDraft }
                } else {
                    save { $0.instructionsOverride = nil }
                }
            }
        )
    }

    private var restrictionBinding: Binding<Bool> {
        Binding(
            get: { workspace?.toolAccess.isRestricted ?? false },
            set: { restricted in
                save { configuration in
                    // Switching restriction *on* seeds every tool rather than
                    // none. An empty allow-list is a legitimate state but a
                    // terrible default: the reader would flip one switch and
                    // silently lose web search, canvas and connectors in one go.
                    configuration.toolAccess = restricted
                        ? .restricted(Set(ProjectWorkspaceTool.allCases))
                        : .inheritsAccountDefaults
                }
            }
        )
    }

    private func toolBinding(_ tool: ProjectWorkspaceTool) -> Binding<Bool> {
        Binding(
            get: { workspace?.toolAccess.allows(tool) ?? true },
            set: { allowed in
                save { configuration in
                    var allowedTools: Set<ProjectWorkspaceTool>
                    if case .restricted(let existing) = configuration.toolAccess {
                        allowedTools = existing
                    } else {
                        allowedTools = Set(ProjectWorkspaceTool.allCases)
                    }
                    if allowed {
                        allowedTools.insert(tool)
                    } else {
                        allowedTools.remove(tool)
                    }
                    configuration.toolAccess = .restricted(allowedTools)
                }
            }
        )
    }

    private func knowledgeBinding(_ file: NativeProjectFile) -> Binding<Bool> {
        Binding(
            get: { isKnowledge(file) },
            set: { included in
                save { configuration in
                    var ids = configuration.knowledgeFileIDs
                    if included {
                        guard !ids.contains(file.id),
                            ids.count < ProjectWorkspaceConfiguration.maximumKnowledgeFiles
                        else { return }
                        // Appended, so the order is the order the reader chose —
                        // which is the order the manifest is written in, and the
                        // order a model reads it.
                        ids.append(file.id)
                    } else {
                        ids.removeAll { $0 == file.id }
                    }
                    configuration.knowledgeFileIDs = ids
                }
            }
        )
    }

    // MARK: Facts

    private func isKnowledge(_ file: NativeProjectFile) -> Bool {
        workspace?.knowledgeFileIDs.contains(file.id) ?? false
    }

    private var isKnowledgeFull: Bool {
        (workspace?.knowledgeFileIDs.count ?? 0)
            >= ProjectWorkspaceConfiguration.maximumKnowledgeFiles
    }

    /// The chosen files' names, in the reader's order.
    ///
    /// Driven from the id list rather than from `files` so a selection made before
    /// a file was renamed still names it correctly, and so an id whose file has
    /// been deleted simply drops out instead of leaving a blank line in the
    /// manifest.
    private var knowledgeFileNames: [String] {
        (workspace?.knowledgeFileIDs ?? []).compactMap { id in
            files.first { $0.id == id }?.fileName
        }
    }

    private var personaNameChanged: Bool {
        normalizedPersona != workspace?.personaName
    }

    /// Empty text means *no persona*, which is nil rather than `""`. The store
    /// draws the same distinction: nil shows the project's name, `""` would show
    /// nothing at all.
    private var normalizedPersona: String? {
        let trimmed = personaDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var instructionsChanged: Bool {
        instructionsDraft != (workspace?.instructionsOverride ?? "")
    }

    // MARK: Actions

    private func seedDrafts() {
        personaDraft = workspace?.personaName ?? ""
        overridesInstructions = workspace?.instructionsOverride != nil
        instructionsDraft = workspace?.instructionsOverride ?? ""
    }

    private func savePersonaName() {
        let value = normalizedPersona
        save { $0.personaName = value }
    }

    private func saveInstructions() {
        let value = instructionsDraft
        save { $0.instructionsOverride = value }
    }

    /// One write path for every control on this panel.
    ///
    /// `update` creates the configuration on first use, so the first flip of the
    /// first switch works on a project that has never had an assistant — without
    /// the panel having to decide when a workspace comes into existence.
    private func save(_ edit: @escaping (inout ProjectWorkspaceConfiguration) -> Void) {
        Task { await workspaceModel.update(projectID: project.id, edit) }
    }

    private func cardHeading(_ eyebrow: String, _ title: String) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(eyebrow)
                .junoCodeSmall()
                .junoSecondaryInk()
                .accessibilityAddTraits(.isHeader)
            Text(title)
                .font(JunoSerif.cardTitle)
        }
    }
}

// MARK: - File facts

/// What a project file says about itself, in the two places that show it.
private enum DesktopProjectFileFacts {
    /// A glyph for the file's own type, from the MIME type the server recorded.
    /// No thumbnail: the only way to reach a file's bytes is `accessFile`, which
    /// flips the model's `isPerformingFileAction` flag and would put every row's
    /// spinner on and every file action off for as long as previews were loading.
    static func icon(for file: NativeProjectFile) -> JunoIcon {
        let mime = file.mimeType.lowercased()
        if mime.hasPrefix("image/") || file.kind.uppercased() == "IMAGE" { return .image }
        if mime.hasPrefix("audio/") { return .activity }
        if mime.hasPrefix("video/") { return .image }
        if mime.contains("csv") || mime.contains("spreadsheet") { return .grid }
        return .file
    }

    static func size(of file: NativeProjectFile) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)
    }

    /// Size, plus the pixel dimensions when the server recorded them — which it
    /// does only for images, so this line is what tells a 4000-pixel screenshot
    /// from a thumbnail without opening either.
    static func detail(for file: NativeProjectFile) -> String {
        guard let width = file.width, let height = file.height else { return size(of: file) }
        return "\(size(of: file)) · \(width)×\(height)"
    }

    /// What the whole set costs, in the same units one file reports. The website
    /// prints a token estimate here; nothing native has a tokenizer, and a guessed
    /// one would be a number the reader could not check.
    static func totalSize(of files: [NativeProjectFile]) -> String {
        ByteCountFormatter.string(
            fromByteCount: Int64(files.reduce(0) { $0 + $1.size }),
            countStyle: .file
        )
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
    /// Handed the new project's id so the screen can open it. The id is the
    /// *client* one the outbox was given, which is also the id the project keeps
    /// while it is pending, so the page opens before the server has answered.
    let created: (String) -> Void
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
                    .contentShape(.rect)
                Button("Create project") {
                    Task {
                        creationError = nil
                        guard let id = await model.createProject(
                            name: name,
                            instructions: instructions
                        ) else {
                            creationError = model.lastErrorDescription
                                ?? "Juno could not create this project."
                            return
                        }
                        created(id)
                        dismiss()
                    }
                }
                .junoProminentGlassButton()
                .keyboardShortcut(.defaultAction)
                .disabled(trimmedName.isEmpty || model.isMutating)
                .accessibilityIdentifier("Create project")
                .contentShape(.rect)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 520)
        // The sheet contract, from `JunoOverlays.swift`. This sheet painted no
        // ground at all, so the system's neutral window grey showed through and a
        // cold rectangle opened out of a warm cream window — eight of the app's
        // nine macOS sheets had the same defect, and `DesktopTaskEditor` was the
        // one that did not. `junoSheetSurface` is that pattern named: it puts the
        // warm canvas down *inside* the content and touches nothing else. The
        // platter, its Liquid Glass material, its corner radius and its shadow
        // stay the system's — `.presentationBackground` would replace all four,
        // which is why the contract forbids it.
        //
        // `.fitted` because the content already declares its own frame; `.form`
        // would impose a standard width and fight it.
        .junoSheetSurface(.fitted)
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
                    Label("Very long — a model may not attend to all of it.", icon: .triangleAlert)
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
                    .contentShape(.rect)
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
                .contentShape(.rect)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 580, height: 460)
        // Sheet contract: the warm ground inside the content, the platter left
        // to the system. `.fitted` because the frame above is the size it wants.
        .junoSheetSurface(.fitted)
    }
}
