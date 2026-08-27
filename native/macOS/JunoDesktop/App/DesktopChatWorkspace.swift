import AVFoundation
import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoVoiceKit
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

enum DesktopChatSelection {
    static func resolvedModelID(
        current: String,
        conversationModel: String,
        selectable: [NativeChatModelOption]
    ) -> String {
        if selectable.contains(where: { $0.id == current }) {
            return current
        }
        if selectable.contains(where: { $0.id == conversationModel }) {
            return conversationModel
        }
        return selectable.first?.id ?? conversationModel
    }
}

/// One selection value for the whole navigation column.
///
/// `List(selection:)` needs a single `Hashable` to drive native selection, and
/// getting that right is what buys the arrow-key navigation, type-select, focus
/// ring and focused/unfocused accent states that a stack of `Button`s cannot
/// have. The chat destination and the selected conversation used to be two
/// independent pieces of state, which is why the old column had to draw its own
/// highlight — nothing about it was a selection as far as the platform knew.
enum DesktopSidebarItem: Hashable {
    case destination(DesktopDestination)
    case conversation(String)
}

struct DesktopChatWorkspace: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Binding var product: DesktopProductMode
    /// Forces the window to open on a given destination, overriding the restored
    /// one exactly once.
    ///
    /// This exists for the screenshot harness. `capture-desktop.sh` passes
    /// `--juno-preview-tab artifacts` and names the resulting file
    /// `artifacts-light.png`, but nothing was reading that value below the
    /// product level — so every "surface" in the capture set was really the Chat
    /// window, and a reviewer looking at sixteen files was looking at two.
    /// Production passes nil and the restored destination wins as before.
    var initialDestination: DesktopDestination?
    /// Lets the root retire a one-shot production launch route after this view
    /// has actually applied it. The screenshot harness does not provide one.
    var consumeInitialDestination: (() -> Void)?
    /// A one-shot request made from the Code sidebar to start an ordinary Chat
    /// conversation that is not scoped to any local repository.
    var unscopedChatRequestID: UUID?
    let consumeUnscopedChatRequest: () -> Void
    @SceneStorage("juno.desktop.destination") private var storedDestination =
        DesktopDestination.chat.rawValue
    /// Holds the launch override until the reader navigates somewhere themselves.
    ///
    /// Writing `storedDestination` from `onAppear` was not enough: scene storage
    /// is restored asynchronously, so AppKit could hand the window its previous
    /// destination *after* the override had been written, and the harness landed
    /// on whichever surface was last open instead of the one it asked for.
    /// Reading the override ahead of storage sidesteps the race entirely.
    @State private var overrideDestination: DesktopDestination?
    /// Distinguishes "never seeded" from "seeded, then retired by a navigation",
    /// which a nil `overrideDestination` alone cannot.
    @State private var hasSeededOverride = false
    @SceneStorage("juno.desktop.columns") private var storedColumnVisibility = ""
    /// Whether the Tasks inspector is up. The key is ``DesktopTasksScreen``'s own
    /// — scene storage is one value per key per scene, so the page's toolbar
    /// toggle and this window's `.inspector` are reading and writing the same
    /// flag, and the page keeps its default of showing.
    @SceneStorage("juno.desktop.tasks.inspector") private var tasksInspectorShown = true
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    /// The Tasks page's selection and its pending presentations.
    ///
    /// Held by the window because the page and the inspector are now two views in
    /// two different columns of it, and `@State` cannot span them. See
    /// ``DesktopTasksSurface``.
    @State private var tasksSurface = DesktopTasksSurface()
    /// Set by Projects immediately before it opens a new draft. The composer
    /// consumes it once so an ordinary toolbar New Chat never inherits an old
    /// project's scope.
    @State private var draftProjectID: String?
    /// Optional text entered on a project overview before opening Chat. The
    /// composer consumes this once, so the project page never presents a fake
    /// prompt field.
    @State private var draftPrompt: String?
    /// A one-shot deep link into Projects. The Projects destination itself still
    /// opens the index; only a concrete project row writes this value.
    @State private var requestedProjectID: String?
    @State private var sharing = false
    @State private var showingSettingsModal = false

    /// One line under the toolbar after a Share, so the copy is acknowledged.
    @State private var shareNotice: String?

    /// The destination in force: the launch override while it stands, otherwise
    /// whatever scene storage restored.
    private var currentDestination: DesktopDestination {
        overrideDestination
            ?? DesktopNavigationState.destination(fromStored: storedDestination)
    }

    private var destination: Binding<DesktopDestination> {
        Binding(
            get: { currentDestination },
            set: { value in
                // Any deliberate navigation retires the override — from here on
                // the window behaves exactly as it did before it existed.
                overrideDestination = nil
                storedDestination = value.rawValue
            }
        )
    }

    /// Projects the two underlying pieces of state into the column's single
    /// selection, and back. The rules themselves are in
    /// ``DesktopNavigationState`` so they can be tested; this only moves values.
    private var selection: Binding<DesktopSidebarItem?> {
        Binding(
            get: {
                DesktopNavigationState.selection(
                    destination: currentDestination,
                    selectedConversationID: model.selectedConversationID
                )
            },
            set: { item in
                // A sidebar destination means "open its root". A concrete
                // pinned-project row writes its id again after this selection,
                // so only that path deep-links into a project.
                requestedProjectID = nil
                let resolved = DesktopNavigationState.resolve(
                    selection: item,
                    current: (currentDestination, model.selectedConversationID)
                )
                overrideDestination = nil
                storedDestination = resolved.destination.rawValue
                model.selectedConversationID = resolved.conversationID
                model.isDraftingNewConversation = resolved.isDrafting
            }
        )
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            DesktopChatSidebar(
                model: model,
                syncModel: configuration.syncModel,
                avatarModel: configuration.avatarModel,
                workModel: configuration.workModel,
                codeModel: configuration.codeModel,
                projectModel: configuration.projectModel,
                session: session,
                product: $product,
                destination: destination,
                selection: selection,
                requestedProjectID: $requestedProjectID,
                openSettingsModal: { showingSettingsModal = true }
            )
            .junoSidebarColumn()
        } detail: {
            DesktopDestinationView(
                destination: destination,
                configuration: configuration,
                session: session,
                conversationModel: model,
                draftProjectID: $draftProjectID,
                draftPrompt: $draftPrompt,
                requestedProjectID: $requestedProjectID
            )
            // The Tasks page reads its selection from here; the inspector below
            // writes it. One object, injected once, because the page is built by
            // `DesktopDestinationView` — which has nothing of its own to hand it.
            .environment(tasksSurface)
            .junoReadingCanvas()
            .navigationTitle("")
            .toolbar { detailToolbar }
        }
        .sheet(isPresented: $showingSettingsModal) {
            if let settingsModel = configuration.memorySettingsModel {
                DesktopSettingsModal(
                    model: settingsModel,
                    authModel: configuration.authModel,
                    session: session,
                    configuration: configuration,
                    accountDataClient: configuration.accountDataClient,
                    shareClient: configuration.shareClient,
                    modelCatalog: model.selectableModels,
                    avatarData: configuration.avatarModel?.imageData,
                    syncModel: configuration.syncModel,
                    outbox: configuration.outbox,
                    openUsage: { destination.wrappedValue = .usage },
                    codeHostModel: configuration.codeHostModel,
                    workHostModel: configuration.workHostModel,
                    learningModel: nil,
                    onDismiss: { showingSettingsModal = false }
                )
            }
        }
        .inspector(isPresented: inspectorPresentation) { inspector }
        .focusedSceneValue(
            \.junoWorkspaceActions,
            DesktopWorkspaceActions(
                newItem: beginDraft,
                newChat: beginDraft,
                openSearch: { destination.wrappedValue = .search },
                switchProduct: { product = $0 },
                currentProduct: product
            )
        )
        // Column visibility is restored by hand rather than through
        // `@SceneStorage` directly: `NavigationSplitViewVisibility` is not
        // `RawRepresentable`, so it cannot be stored, and a window that always
        // reopened with the sidebar showing lost the one piece of window layout
        // a user is most likely to have deliberately changed.
        .onAppear {
            if storedColumnVisibility == "detailOnly" {
                columnVisibility = .detailOnly
            }
            // Seeded once. `overrideDestination` is `@State`, so a later
            // re-appear (a mode switch, the window returning to the foreground)
            // finds it already set — or already retired by a navigation — and
            // cannot yank the reader back to the launch surface.
            if let initialDestination, overrideDestination == nil, !hasSeededOverride {
                hasSeededOverride = true
                overrideDestination = initialDestination
                model.selectedConversationID = nil
                consumeInitialDestination?()
            }
            consumePendingUnscopedChatRequest()
        }
        .onChange(of: unscopedChatRequestID) { _, _ in
            consumePendingUnscopedChatRequest()
        }
        .onChange(of: columnVisibility) { _, visibility in
            storedColumnVisibility = visibility == .detailOnly ? "detailOnly" : "all"
        }
    }

    /// What the destination in force puts in the trailing column, or nil when it
    /// has nothing to put there.
    ///
    /// Tasks is the only destination that fills it. Artifacts keeps its version
    /// history as a pane inside its own page — ``DesktopArtifactsScreen`` says why
    /// — and the rest have nothing to inspect. The model is part of the answer
    /// rather than checked separately: an account whose scheduled-task service is
    /// unavailable gets the page's own explanation and no empty column beside it.
    private var inspectableTasks: NativeScheduledTaskModel? {
        guard currentDestination == .tasks else { return nil }
        return configuration.scheduledTaskModel
    }

    /// Whether the window's one inspector is up.
    ///
    /// The write is gated on the same condition as the read. A column dismissed
    /// while some other surface is showing must not be recorded as the reader
    /// hiding the *task* inspector, or Tasks would open closed next time for a
    /// reason that had nothing to do with it.
    private var inspectorPresentation: Binding<Bool> {
        Binding(
            get: { inspectableTasks != nil && tasksInspectorShown },
            set: { shown in
                guard inspectableTasks != nil else { return }
                tasksInspectorShown = shown
            }
        )
    }

    /// The trailing column's content, given the inspector's resize range once
    /// rather than per destination: a column whose width is redeclared as the
    /// reader moves through the sidebar is a column AppKit re-lays out on every
    /// navigation.
    private var inspector: some View {
        Group {
            if let inspectableTasks {
                DesktopTasksInspector(
                    model: inspectableTasks,
                    surface: tasksSurface,
                    openConversation: openConversation
                )
            }
        }
        .inspectorColumnWidth(
            min: JunoInspectorMetrics.minimum,
            ideal: JunoInspectorMetrics.ideal,
            max: JunoInspectorMetrics.maximum
        )
    }

    /// Opens a conversation some other surface points at — today, the chat a
    /// scheduled task writes its runs into.
    ///
    /// `DesktopDestinationView` performs the same navigation for the pages it
    /// builds, but the task inspector is no longer one of them: it hangs off this
    /// window's split view, above anything that view can reach.
    private func openConversation(_ id: String) {
        draftProjectID = nil
        draftPrompt = nil
        model.isDraftingNewConversation = false
        model.selectedConversationID = id
        destination.wrappedValue = .chat
    }

    /// Every item is present in every state and disables rather than vanishing.
    ///
    /// A `ToolbarItem` that appears and disappears makes SwiftUI rebuild the
    /// AppKit toolbar underneath a live window, and that rebuild is what drove
    /// the split-view constraint loop this shell previously crashed in. Disabling
    /// is also better behaviour: the control keeps its position, so the pointer
    /// does not have to re-find it.
    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                beginDraft()
            } label: {
                JunoIconLabel("New chat", systemImage: "square.and.pencil")
            }
            .help("Start a new chat (⌘N)")
            .accessibilityIdentifier("New chat")
        }

        ToolbarItem(placement: .primaryAction) {
            Button {
                destination.wrappedValue = .search
            } label: {
                JunoIconLabel("Search", systemImage: "magnifyingglass")
            }
            .help("Search chats, projects and files (⌘⇧F)")
            .accessibilityIdentifier("Search")
        }



        // Only for a conversation that exists. A draft has nothing to publish,
        // and an item that is present but inert is worse than one that is absent.
        if configuration.shareClient != nil, model.selectedConversationID != nil {
            ToolbarSpacer(.fixed, placement: .primaryAction)

            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await createShare() }
                } label: {
                    JunoIconLabel("Share", systemImage: "square.and.arrow.up")
                }
                .disabled(sharing)
                .help("Create a public link to this conversation")
                .accessibilityIdentifier("Share")
            }
        }
    }

    /// Publishes the conversation and puts the link on the pasteboard.
    ///
    /// The Mac copies rather than opening a share sheet: a link is going into a
    /// message or a document the reader is already writing, and the pasteboard is
    /// one step where the sheet is three. The route is idempotent per
    /// conversation, so pressing Share twice yields the same link.
    private func createShare() async {
        guard let client = configuration.shareClient,
              let conversationID = model.selectedConversationID,
              case .signedIn(let session) = configuration.authModel.phase,
              !sharing
        else { return }
        sharing = true
        defer { sharing = false }
        do {
            let share = try await client.share(conversationID: conversationID, for: session.profile.id)
            JunoPasteboard.copy(share.url.absoluteString)
            shareNotice = "Link copied — anyone with it can read this conversation as it is now."
        } catch {
            shareNotice = "The conversation couldn’t be published. Try again in a moment."
        }
    }

    private func beginDraft() {
        draftProjectID = nil
        draftPrompt = nil
        storedDestination = DesktopDestination.chat.rawValue
        model.isDraftingNewConversation = true
        model.selectedConversationID = nil
        configuration.attachmentModel?.clear()
    }

    private func consumePendingUnscopedChatRequest() {
        guard unscopedChatRequestID != nil else { return }
        overrideDestination = nil
        beginDraft()
        consumeUnscopedChatRequest()
    }
}

/// The navigation column, as a real macOS source list.
///
/// Everything visual here is the platform's: `List(selection:)` in `.sidebar`
/// style draws the selection, the hover state, the section headers and the row
/// metrics, and it is what makes the column keyboard-navigable. The column
/// paints **no background** — a sidebar is a vibrant region on macOS, and the
/// opaque fill this view used to apply is the exact failure ``JunoSurfaces``
/// documents: it turned a vibrant source list into a grey slab.
private struct DesktopChatSidebar: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let avatarModel: NativeAvatarModel?
    let workModel: NativeWorkModel?
    let codeModel: NativeCodeModel?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let session: NativeAuthenticatedSession
    @Binding var product: DesktopProductMode
    @Binding var destination: DesktopDestination
    @Binding var selection: DesktopSidebarItem?
    @Binding var requestedProjectID: String?
    var openSettingsModal: (() -> Void)? = nil
    @State private var renameProjectTarget: NativeProject?
    @State private var renameChatTarget: NativeConversation?
    @State private var renameDraft = ""
    @State private var deleteProjectTarget: NativeProject?

    private var pinnedProjects: [NativeProject] {
        (projectModel?.projects ?? [])
            .filter(\.starred)
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private var pinnedChats: [NativeConversation] {
        model.conversations
            .filter { $0.pinned && !$0.isArchived }
            .sorted { $0.lastMessageAt > $1.lastMessageAt }
    }

    private var recentChats: [NativeConversation] {
        model.conversations
            .filter { !$0.pinned && !$0.isArchived }
            .sorted { $0.lastMessageAt > $1.lastMessageAt }
    }

    var body: some View {
        List(selection: $selection) {
            Section {
                ForEach(DesktopDestination.sidebarCases) { item in
                    destinationRow(item)
                }
            }

            if !pinnedProjects.isEmpty || !pinnedChats.isEmpty {
                Section("Pinned") {
                    ForEach(pinnedProjects) { project in
                        projectRow(project)
                    }
                    ForEach(pinnedChats) { conversation in
                        conversationRow(conversation)
                    }
                }
            }

            if !recentChats.isEmpty {
                Section("Recent") {
                    ForEach(recentChats) { conversation in
                        conversationRow(conversation)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        // The selection is still the platform's — only its colour is Juno's.
        .junoSidebarSelectionTint()
        .junoSidebarProductHeader(product: $product)
        // `safeAreaBar`, not `safeAreaInset`: the bar variant is what the
        // system's bottom scroll-edge effect is measured against, and that
        // effect is what lets the footer sit on a translucent column without an
        // opaque bar painted behind it.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            accountFooter
        }
        .junoSidebarScrollEdge()
        .alert("Rename", isPresented: renamePresentation) {
            TextField("Name", text: $renameDraft)
            Button("Cancel", role: .cancel) {
                renameProjectTarget = nil
                renameChatTarget = nil
            }
            Button("Save") { commitRename() }
                .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog(
            deleteProjectTarget.map { "Delete “\($0.name)”?" } ?? "",
            isPresented: Binding(
                get: { deleteProjectTarget != nil },
                set: { if !$0 { deleteProjectTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete project", role: .destructive) {
                guard let project = deleteProjectTarget else { return }
                deleteProjectTarget = nil
                Task { await projectModel?.deleteProject(id: project.id) }
            }
            Button("Cancel", role: .cancel) { deleteProjectTarget = nil }
        } message: {
            Text("Chats stay in Juno and are unlinked from the project. The project’s files are removed.")
        }
    }

    private func projectRow(_ project: NativeProject) -> some View {
        Button {
            projectModel?.selectedProjectID = project.id
            destination = .projects
            selection = .destination(.projects)
            requestedProjectID = project.id
        } label: {
            HStack(spacing: JunoSpace.tight) {
                Text(project.name)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .junoSidebarRowInk()
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Pinned project, \(project.name)")
        .accessibilityIdentifier("juno.desktop.project.\(project.id)")
        .contextMenu {
            Button("Open") {
                projectModel?.selectedProjectID = project.id
                destination = .projects
                selection = .destination(.projects)
                requestedProjectID = project.id
            }
            Button("Unpin") {
                Task { await projectModel?.updateProject(id: project.id, starred: false) }
            }
            Button("Rename…") { beginRename(project) }
            Divider()
            Button("Delete project…", role: .destructive) {
                deleteProjectTarget = project
            }
        }
    }

    private func destinationRow(_ item: DesktopDestination) -> some View {
        // The ink is stated on the mark as well as on the label. A `Label` in a
        // `.sidebar` list resolves its icon slot against the system accent, and
        // an inherited `foregroundStyle` does not reach it — so every destination
        // glyph in this column drew coral no matter what the row said. The web
        // spends no accent here at all: one fill, one ink, resting on
        // `--sidebar-foreground` and lifting to `--foreground` when selected.
        let selected = selection == .destination(item)
        let ink = selected ? Color.junoForeground : Color.junoSidebarForeground

        return Label {
            Text(item.label)
        } icon: {
            if let icon = item.junoIcon {
                JunoIconView(icon, size: 16)
                    .foregroundStyle(ink)
            } else {
                JunoIconView(systemImage: item.symbol)
                    .foregroundStyle(ink)
            }
        }
        .foregroundStyle(ink)
        // A selection changing is `standard`'s documented brief; the inline
        // 0.22 it replaces was the base rung's own duration living off the
        // ladder. The lift is a colour crossfade in place — tint-tier motion,
        // which Reduce Motion leaves alone — so it is deliberately not gated
        // behind the preference.
        .animation(JunoMotion.standard, value: selected)
        .tag(DesktopSidebarItem.destination(item))
    }

    private func conversationRow(_ conversation: NativeConversation) -> some View {
        HStack(spacing: JunoSpace.tight) {
            Text(conversation.title)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: JunoSpace.hairline)
            if conversation.isPending {
                ProgressView()
                    .controlSize(.mini)
                    .accessibilityLabel("Sending")
            }
        }
        .junoSidebarRowInk()
        .tag(DesktopSidebarItem.conversation(conversation.id))
        .contextMenu {
            Button(conversation.pinned ? "Unpin" : "Pin") {
                Task {
                    await model.setPinned(
                        id: conversation.id,
                        pinned: !conversation.pinned
                    )
                }
            }
            Button("Rename…") { beginRename(conversation) }
            Divider()
            // One destructive action, and it really deletes: `deleteConversation`
            // enqueues `conversation.delete`, not an archive flag. There is no
            // Archive/Restore pair any more — a chat the reader is done with
            // should leave, not move to a drawer they have to remember exists.
            Button("Delete", role: .destructive) {
                Task { await model.deleteConversation(id: conversation.id) }
            }
        }
    }

    private var renamePresentation: Binding<Bool> {
        Binding(
            get: { renameProjectTarget != nil || renameChatTarget != nil },
            set: {
                if !$0 {
                    renameProjectTarget = nil
                    renameChatTarget = nil
                }
            }
        )
    }

    private func beginRename(_ project: NativeProject) {
        renameDraft = project.name
        renameProjectTarget = project
        renameChatTarget = nil
    }

    private func beginRename(_ conversation: NativeConversation) {
        renameDraft = conversation.title
        renameChatTarget = conversation
        renameProjectTarget = nil
    }

    private func commitRename() {
        let name = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        if let project = renameProjectTarget {
            Task { await projectModel?.updateProject(id: project.id, name: name) }
        } else if let conversation = renameChatTarget {
            Task { await model.renameConversation(id: conversation.id, title: name) }
        }
        renameProjectTarget = nil
        renameChatTarget = nil
    }

    /// The door to Design, a staged update, and then the account row — pinned to
    /// the bottom of the column by `safeAreaBar` rather than by being the last
    /// child of a `VStack`, so the list scrolls underneath them and they stay
    /// reachable.
    ///
    /// ``DesktopSidebarFooter`` is the same component Code's column pins, which
    /// is what stops the two from describing the same account — or the same
    /// waiting update — differently. No plan is passed: the quota meter needs a
    /// plan model this column does not read, and a meter drawn from nothing is a
    /// claim about spend that nobody made.
    ///
    /// Design sits *above* that block rather than inside it, which is the
    /// website's own arrangement: `app-sidebar.tsx` gives the row its own
    /// container and then a bordered block for the account. The footer component
    /// is about the account — who is signed in, what they have spent, what is
    /// waiting to install — and a navigation row is not one of those things.
    private var accountFooter: some View {
        VStack(spacing: 0) {
            DesktopSidebarDesignRow(isActive: destination == .design) {
                destination = .design
            }
            DesktopSidebarFooter(
                session: session,
                avatarModel: avatarModel,
                syncModel: syncModel,
                plan: nil,
                openUsage: { destination = .usage },
                openSettings: {
                    if let openSettingsModal {
                        openSettingsModal()
                    } else {
                        destination = .settings
                    }
                }
            )
        }
    }
}

enum DesktopDestination: String, CaseIterable, Identifiable {
    case chat
    case search
    case projects
    case library
    case artifacts
    case connections
    case tasks
    /// Juno Design — the canvas, and the list of what has been drawn on it.
    ///
    /// A destination and deliberately **not** a fourth ``DesktopProductMode``. A
    /// product owns the whole window: its own source list, its own toolbar, its
    /// own `NavigationSplitView`. Design has none of those, and the website
    /// learned this the expensive way — as a fourth segment it only routed away
    /// and left Home's sidebar standing, which is why `app-sidebar.tsx` now draws
    /// it as a row in the footer. It is also absent from ``sidebarCases`` for the
    /// same reason it is absent from the web's rail: the footer is where it goes.
    case design
    case usage
    case settings

    var id: Self { self }

    static let sidebarCases: [Self] = [
        .library, .artifacts, .connections, .projects, .tasks, .usage,
    ]

    var label: String {
        switch self {
        case .chat: "Chat"
        case .search: "Search"
        case .projects: "Projects"
        case .library: "Library"
        case .artifacts: "Artifacts"
        case .connections: "Connections"
        case .tasks: "Tasks"
        case .design: "Design"
        case .usage: "Usage"
        case .settings: "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .search: "magnifyingglass"
        case .projects: "folder"
        case .library: "books.vertical"
        case .artifacts: "square.stack.3d.up"
        case .connections: "link"
        case .tasks: "clock"
        case .design: "pencil.tip"
        case .usage: "chart.line.uptrend.xyaxis"
        case .settings: "gearshape"
        }
    }

    var junoIcon: JunoIcon? {
        switch self {
        case .chat: .home
        case .search: .search
        case .projects: .projects
        case .library: .library
        case .artifacts: .artifacts
        case .connections: .connections
        case .tasks: .tasks
        case .settings: .settings
        case .usage: .usage
        case .design: .pencil
        }
    }
}

// The chat column's own sync dot lived here, drawn in `.green`/`.orange`/`.red`
// while Code's copy drew the same five states on Juno's status tokens. Both
// footers now pin `DesktopSidebarFooter`, and `DesktopSidebarSyncDot` is the
// palette that survived — see DesktopCodeAccountFooter.swift.

struct DesktopConversationView: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let attachmentModel: NativeComposerAttachmentModel?
    let profileName: String?
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Binding var draftProjectID: String?
    @Binding var draftPrompt: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var voiceSession: DesktopVoiceSession?
    /// Why a spoken conversation could not be opened. An alert rather than an
    /// inline banner because the reader pressed a button and nothing happened —
    /// the answer has to arrive where they are looking.
    @State private var voiceUnavailable: String?
    /// The artifact the canvas is showing, or nil when it is closed.
    ///
    /// Held **here**, not on the message row that mentions it. A docked column
    /// has to be a sibling of the transcript, and the row is one cell inside a
    /// `LazyVStack` that the scroll view is free to tear down — which is what
    /// made the sheet this replaces a presentation whose presenter could vanish
    /// underneath it. The row now only says "open this".
    @State private var openArtifact: DesktopChatArtifact?
    /// Everything the composer bloom is driven by. See ``DesktopChatAuraState``
    /// for why it cannot live inside the composer.
    @State private var aura = DesktopChatAuraState()
    /// The conversation column's own height, which is what the aura's `54vh` and
    /// `26vh` caps are measured against. Without it the bloom falls back to its
    /// absolute cap and is taller on a short window than the web ever draws it.
    @State private var columnHeight: CGFloat = 0

    var body: some View {
        // Clamped through `Color.clear.overlay { … }`, for the reason
        // ``JunoDetailPage`` spells out: a `ScrollView` propagates its content's
        // ideal height rather than absorbing it, so a long transcript reports an
        // ideal of "every message stacked" — and `NavigationSplitView` answers an
        // ideal it cannot meet by *growing the window's split view*. `Color.clear`
        // takes whatever height it is proposed and an overlay is sized by its
        // base, so the chat can never resize the window it lives in.
        Color.clear
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                columnHeight = $0
            }
            .overlay { conversationContent }
            // The canvas closes when a conversation does. It belongs to the
            // thread it was opened from, and a panel that survived the switch
            // would be describing a reply that is no longer on screen.
            .onChange(of: model.selectedConversationID) { _, _ in
                openArtifact = nil
            }
            .task(id: "\(session.profile.id.rawValue):\(model.selectedConversationID ?? "")") {
                await model.refreshChatApprovals(
                    conversationID: model.selectedConversationID,
                    includeRecent: true
                )
            }
            // The web's COEXISTENCE RULE, in the one shape this window has for
            // it: the canvas and a live call are both large right-hand claims on
            // the conversation column, and the call also lights the whole column
            // with its own field. Starting one dismisses the other.
            .onChange(of: voiceSession?.id) { _, started in
                guard started != nil, openArtifact != nil else { return }
                withAnimation(
                    JunoMotion.reduced(DesktopChatMotion.canvasExit, when: reduceMotion)
                ) {
                    openArtifact = nil
                }
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
            } message: { reason in
                Text(reason)
            }
    }

    /// The transcript (or the draft greeting) and the composer.
    ///
    /// Paints **no background**. The detail column applies `junoReadingCanvas()`
    /// once, at the window level; painting the canvas a second time here is what
    /// flattened the window into one cream field and boxed the composer in a
    /// rectangle of its own.
    @ViewBuilder
    private var conversationContent: some View {
        // A live call takes the greeting's place even before a single word has
        // been said, which is the web's `hasMessages || voiceOpen`
        // (`chat-view.tsx`). Without it the most common way to start a call —
        // pressing the microphone on the home screen — is the one place the
        // spoken conversation could never be read, because a draft has no
        // message list to append it to.
        if model.selectedConversation == nil, voiceSession == nil {
            draftColumn
        } else {
            // The canvas is a **column**, not a presentation. It sits beside the
            // conversation exactly as the website's does, so the reply the
            // artifact came out of stays readable next to it — which is the whole
            // difference between docking and covering.
            DesktopArtifactDock(
                artifact: openArtifact,
                close: closeArtifact,
                requestEdit: { prompt in
                    draftPrompt = prompt
                    closeArtifact()
                }
            ) {
                transcriptColumn
            }
        }
    }

    /// The home screen: greeting on its bloom, composer under it, fine print
    /// pinned to the foot.
    ///
    /// The disclaimer is a bottom inset rather than a third row of the stack —
    /// the web's own split (`justify-center` on the group, a `shrink-0`
    /// disclaimer at the bottom of the column). Two flexible `Spacer`s with
    /// different minimums approximated it and left the fine print floating a
    /// third of the way up a tall window. Pinning it also makes the two branches
    /// of this view agree, so it does not jump the moment a chat starts.
    private var draftColumn: some View {
        VStack(spacing: JunoSpace.section) {
            DesktopDraftGreeting(
                profileName: profileName,
                aura: aura,
                viewport: columnHeight > 0 ? columnHeight : nil
            )
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The field behind the whole column — the conversation and the composer
        // both — scoped to it, so the sidebar is never washed by it.
        .junoVoiceField(voiceColumn)
    }

    /// The conversation and its composer.
    ///
    /// No in-content title strip. The conversation's title and its last-updated
    /// stamp are the window's `navigationTitle` and `navigationSubtitle`, which is
    /// where a Mac window says what it is showing. Repeating it in a bordered bar
    /// directly under the toolbar said the same thing twice and cost 42pt of the
    /// reading canvas.
    ///
    /// The composer is a *safe-area inset*, not the last row of a `VStack`, and
    /// that is what makes it glass. Stacked, it occupied its own band of canvas —
    /// a rectangle of `--background` with nothing behind it — so the glass had
    /// nothing to refract and read as a flat white pill. As an inset the
    /// transcript keeps the full height and scrolls *underneath* the composer, so
    /// messages pass behind it and the material finally has something to bend.
    ///
    /// The inset spans this column alone, which is why the canvas docks around it
    /// rather than inside it: the composer belongs to the conversation, and a
    /// composer stretched under an artifact would be offering to send into it.
    private var transcriptColumn: some View {
        DesktopTranscript(
            model: model,
            voiceMessages: voiceMessages,
            messageActions: configuration.messageActionsClient,
            followUpClient: configuration.followUpClient,
            draftPrompt: $draftPrompt,
            accountID: session.profile.id,
            syncModel: configuration.syncModel,
            openArtifact: open(artifact:)
        )
        .safeAreaInset(edge: .bottom, spacing: 0) {
            composer
        }
        .junoVoiceField(voiceColumn)
    }

    private func open(artifact: NativeMessageContent.ArtifactReference) {
        withAnimation(JunoMotion.reduced(DesktopChatMotion.canvasEnter, when: reduceMotion)) {
            openArtifact = DesktopChatArtifact(reference: artifact)
        }
    }

    private func closeArtifact() {
        withAnimation(JunoMotion.reduced(DesktopChatMotion.canvasExit, when: reduceMotion)) {
            openArtifact = nil
        }
    }

    /// The spoken conversation as it is happening, as ordinary message rows.
    ///
    /// The web's `voiceMessages` (`chat-view.tsx`), reproduced: the live lines
    /// are appended after the persisted ones and rendered by the same row, with
    /// a line the recognizer is still rewriting marked as still arriving. They
    /// are **transient** — nothing here writes them anywhere. Hanging up is what
    /// files a conversation, from the controller's own record, and only the
    /// final lines (``DesktopVoiceDock``); a row built here that also persisted
    /// would file every half-heard hypothesis twice.
    private var voiceMessages: [NativeChatMessage] {
        guard let voiceSession else { return [] }
        // The closure's result type is spelled out: without it Swift infers the
        // non-optional `NativeChatMessage` from the trailing return and then
        // rejects the `nil` that drops a blank hypothesis.
        return voiceSession.controller.transcript.compactMap { line -> NativeChatMessage? in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return NativeChatMessage(
                id: "voice-\(line.id.uuidString)",
                conversationID: model.selectedConversationID ?? "",
                clientID: nil,
                role: line.role == .assistant ? .assistant : .user,
                content: text,
                reasoning: nil,
                model: nil,
                createdAt: voiceSession.startedAt,
                revision: 0,
                isPending: !line.final
            )
        }
    }

    /// The live call, as the chat column needs it.
    ///
    /// Chat's routing, which is **not** the Projects screen's: the open
    /// conversation is passed down so the turns append to the thread the reader
    /// was already in, and the saved id is selected so a call started from a
    /// draft lands the reader in the conversation the server just created.
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
                    conversationID: voiceSession.conversationID,
                    modelID: voiceSession.modelID,
                    projectID: voiceSession.projectID,
                    connectors: [],
                    turns: turns,
                    for: session.profile.id
                )
                await configuration.syncModel?.refresh()
                await model.reload()
                model.isDraftingNewConversation = false
                model.selectedConversationID = saved.conversationID
                return saved.conversationID
            },
            close: { self.voiceSession = nil }
        )
    }

    /// Opens a spoken conversation.
    ///
    /// The guard used to `return` with nothing said, so on any shell missing
    /// either half the microphone button was a control that did nothing at all
    /// when pressed — indistinguishable from a broken app, and impossible to
    /// report. It now says which half is missing.
    private func startVoice(modelID: String) {
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
            conversationID: model.selectedConversationID,
            projectID: model.selectedConversation?.projectId
        )
        voiceSession = started
        // Dialled from here rather than from the dock's `task`. The dock lives
        // in the chat column now, so it can appear a second time over the same
        // session — and `start()` is legal from `ended`, which would make that
        // second appearance silently redial.
        Task { await started.controller.start(provider: initialProvider) }
    }

    private var composer: some View {
        DesktopComposer(
            model: model,
            attachmentModel: attachmentModel,
            libraryModel: configuration.libraryModel,
            projectModel: configuration.projectModel,
            workspaceModel: configuration.projectWorkspaceModel,
            documentIndex: configuration.documentIndexModel,
            connectorModel: configuration.connectorModel,
            draftProjectID: $draftProjectID,
            draftPrompt: $draftPrompt,
            openVoiceMode: startVoice,
            aura: aura
        )
        // The dock only. The field this composer used to carry is now behind
        // the whole column — see ``conversationContent``.
        .junoVoiceDock(voiceColumn)
    }
}

private struct DesktopChatDisclaimer: View {
    var body: some View {
        // This line was `.foregroundStyle(.tertiary)` and measured **1.93:1** on
        // the warm canvas in light appearance (2.27 dark) — not quiet, illegible,
        // and less than half the 4.5:1 AA floor. It is also the app's only
        // statement that the model can be wrong, so of everything on this screen
        // it is the last text that should be unreadable. `junoMetaInk()` is the
        // bottom of the ramp at 5.2:1 light / 7.2:1 dark; the line stays quiet
        // through `caption2` and the absence of weight, which is how a tertiary
        // role is expressed once contrast is off the table.
        //
        // `.accessibilityHidden(true)` came off with it. A safety notice that was
        // both below the contrast floor *and* removed from the accessibility tree
        // left a low-vision reader with no path to it at all — neither eyes nor
        // VoiceOver. It is prose a person is meant to read, not decoration.
        Text("Juno can be wrong — worth a second look on anything that matters.")
            .font(.caption2)
            .junoMetaInk()
            .padding(.vertical, 7)
    }
}

/// The chat column's reading measure — **one number, read by both halves of it**.
///
/// The transcript clamped to 768 and the composer to 720. Because the composer
/// also insets its field by `JunoSpace.snug`, the two text edges landed 32pt
/// apart on every window wider than about 830pt: a reader's own sentence and the
/// reply to it were typeset to two different columns, with the composer's the
/// narrower of the two, so the eye had to reset its line start every time it
/// moved between them. Nothing chose those numbers against each other — 768 is
/// the web's `max-w-3xl` and 720 was freehand — which is exactly why they had to
/// stop being two numbers.
///
/// The 8pt that remains between the composer's *field* and the transcript's text
/// is the composer's own chrome inset, and that one is deliberate: the composer
/// is a bordered control on a glass platter, so its text sits inside its rim the
/// way any control's does. A measure and a control's padding are different
/// things; only the measure was ever in disagreement.
enum DesktopChatMeasure {
    /// The web's `max-w-3xl`.
    static let reading: CGFloat = 768
    /// The gutter the column keeps from the window edge before the measure binds.
    static let gutter: CGFloat = JunoSpace.region
}

private struct DesktopTranscript: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    /// The live spoken turns, if a call is running. Kept apart from
    /// `model.selectedMessages` rather than merged into the store: these belong
    /// to the call, not to the conversation, and a store that held them would
    /// have to decide when to take them out again.
    let voiceMessages: [NativeChatMessage]
    let messageActions: NativeMessageActionsClient?
    /// Suggests what to ask next, under a finished reply.
    let followUpClient: NativeFollowUpClient?
    /// Picking a suggestion seeds the composer through the same binding the
    /// sidebar's "start from this" already uses, rather than a second path into
    /// the same text field.
    @Binding var draftPrompt: String?
    let accountID: AccountID
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    /// Asks the conversation column to dock the canvas. A row cannot own that
    /// panel — see ``DesktopConversationView/openArtifact``.
    let openArtifact: (NativeMessageContent.ArtifactReference) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var actionError: String?
    @State private var speechPlayback = DesktopSpeechPlayback()
    /// The index from which rows rise in, so opening a conversation does not
    /// replay every entrance it ever had. See ``noteMessages(from:to:)``.
    @State private var animateFrom = Int.max
    /// The conversation whose count `animateFrom` was last seeded against.
    @State private var settledConversationID: String?

    /// The web's `max-w-3xl` reading column. See ``DesktopChatMeasure``.
    static let readingWidth: CGFloat = DesktopChatMeasure.reading

    private var lastAssistantMessageID: String? {
        model.selectedMessages.last(where: { $0.role == .assistant })?.id
    }

    /// The account catalog's name for a canonical model id.
    ///
    /// Falls back to the id when the catalog has no entry, which happens for a
    /// model the account has since lost access to. Showing the id there is
    /// honest — the answer really did come from something this account can no
    /// longer name — and is better than attributing it to nothing.
    private func displayName(forModelID id: String) -> String {
        model.model(withID: id)?.displayName ?? id
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // The web's reading column, metric for metric: `max-w-3xl`
                // (768pt) at `space-y-6` (24pt) — see `message-list.tsx`. The
                // numbers this replaces were freehand and read slightly airier
                // than the site at the same window width.
                LazyVStack(alignment: .leading, spacing: JunoSpace.section) {
                    ForEach(Array(model.selectedMessages.enumerated()), id: \.element.id) {
                        index, message in
                        DesktopMessageRow(
                            message: message,
                            isVoice: false,
                            modelDisplayName: message.model.map(displayName(forModelID:)),
                            isLastAssistant: message.id == lastAssistantMessageID,
                            copy: {
                                copy(NativeMessageContent.plainText(of: message.content))
                            },
                            regenerate: {
                                guard let conversationID = model.selectedConversationID else {
                                    return
                                }
                                model.retryLastMessage(conversationID: conversationID)
                            },
                            continueResponse: model.canContinueSelectedConversation
                                ? {
                                    guard let conversationID = model.selectedConversationID else {
                                        return
                                    }
                                    _ = model.continueLastResponse(conversationID: conversationID)
                                }
                                : nil,
                            branch: messageActions.map { _ in
                                { branch(from: message) }
                            },
                            setFeedback: messageActions.map { _ in
                                { feedback in
                                    setFeedback(feedback, for: message)
                                }
                            },
                            readAloud: messageActions.map { _ in
                                {
                                    readAloud(
                                        NativeMessageContent.spoken(of: message.content)
                                    )
                                }
                            },
                            openArtifact: openArtifact,
                            branchPosition: branchPosition(for: message),
                            stepBranch: { offset in
                                stepBranch(from: message, offset: offset)
                            },
                            editMessage: message.role == .user && !message.isPending
                                ? { newContent in
                                    editMessage(message, newContent: newContent)
                                }
                                : nil,
                            isGenerating: model.isGenerating
                        )
                        .modifier(DesktopMessageRise(rises: index >= animateFrom))
                        .id(message.id)
                    }

                    // Connector approvals are not prose and must stay above the
                    // pending answer they block. The receipt is recovered from
                    // `/api/approvals` as well as from the live stream, so this
                    // card remains answerable after a cold launch or a missed
                    // SSE frame.
                    if let conversationID = model.selectedConversationID {
                        ForEach(model.chatApprovals(for: conversationID)) { approval in
                            NativeChatApprovalCard(
                                approval: approval,
                                isBusy: model.chatApprovalInFlightID == approval.id,
                                errorMessage: model.chatApprovalError(for: approval.id),
                                canAllowScope: model.canAllowChatApprovalScope(approval),
                                decide: { decision in
                                    Task {
                                        await model.decideChatApproval(approval, decision: decision)
                                    }
                                }
                            )
                            .frame(maxWidth: Self.readingWidth, alignment: .leading)
                        }
                    }

                    // The call, in the transcript it belongs to. Same rows, same
                    // reading column, appended after the persisted turns — the
                    // web's arrangement, and the reason it has no transcript
                    // pane: a spoken conversation is the conversation, not a
                    // second view of one.
                    ForEach(voiceMessages) { message in
                        DesktopMessageRow(
                            message: message,
                            isVoice: true,
                            modelDisplayName: nil,
                            isLastAssistant: false,
                            copy: {
                                copy(NativeMessageContent.plainText(of: message.content))
                            },
                            regenerate: nil,
                            continueResponse: nil,
                            branch: nil,
                            setFeedback: nil,
                            readAloud: nil,
                            // A spoken turn carries no artifact tag: it is a
                            // recognizer's line, not a written reply.
                            openArtifact: { _ in },
                            // And no place in the tree: it exists in the call
                            // controller until the call is hung up and filed,
                            // so there is nothing yet to branch from or re-ask.
                            branchPosition: nil,
                            stepBranch: nil,
                            editMessage: nil,
                            isGenerating: model.isGenerating
                        )
                        // A line the recognizer has not finalized is a
                        // hypothesis it is still rewriting several times a
                        // second, and it is frequently wrong. Dimmed, it reads
                        // as something being heard; at full strength it reads as
                        // something that was said.
                        .opacity(message.isPending ? 0.55 : 1)
                        .id(message.id)
                    }

                    if model.isGenerating, !model.researchActivity.isEmpty {
                        DesktopResearchActivity(items: model.researchActivity)
                    }

                    // Under the last reply, once it has settled. Inside the stack
                    // so it scrolls with the transcript rather than floating over
                    // it, and clamped to the reading column like everything else.
                    if let conversationID = model.selectedConversationID {
                        NativeFollowUpStrip(
                            conversationID: conversationID,
                            accountID: accountID,
                            client: followUpClient,
                            ready: !model.isGenerating
                                && model.selectedMessages.last?.role == .assistant,
                            onPick: { draftPrompt = $0 }
                        )
                        .frame(maxWidth: Self.readingWidth, alignment: .leading)
                    }

                    if let error = model.chatErrorDescription {
                        DesktopChatError(
                            message: error,
                            canRetry: model.canRetrySelectedConversation,
                            retry: {
                                guard let id = model.selectedConversationID else { return }
                                model.retryLastMessage(conversationID: id)
                            }
                        )
                    }

                    if let actionError {
                        DesktopChatError(
                            message: actionError,
                            canRetry: false,
                            retry: {}
                        )
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("transcript-bottom")
                }
                .frame(maxWidth: DesktopChatMeasure.reading)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, DesktopChatMeasure.gutter)
                .padding(.vertical, JunoSpace.section)
            }
            // `initial: true` so a conversation opens at its latest turn even when
            // the messages were already in hand — which is the case every time the
            // canvas takes the whole column on a narrow window and gives it back.
            .onChange(of: model.selectedMessages, initial: true) { previous, current in
                noteMessages(from: previous.count, to: current.count)
                // Animated only when a turn actually arrived. The other two cases
                // are the transcript being drawn for the first time and a reply
                // growing token by token — travelling from a position the reader
                // never saw reads as the page moving on its own, and an animated
                // scroll restarted several times a second never arrives anywhere.
                // The same reasoning as the voice branch below.
                guard current.count != previous.count else {
                    proxy.scrollTo("transcript-bottom", anchor: .bottom)
                    return
                }
                // `standard`, replacing a freehand 0.18: a small spatial move to
                // the new turn is the base rung's exact brief, and 0.18 sitting
                // between `exit` 0.16 and `base` 0.22 is the near-miss drift the
                // ladder's audit calls out by name. Spatial travel, so it
                // collapses to the flat fallback under Reduce Motion.
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    proxy.scrollTo("transcript-bottom", anchor: .bottom)
                }
            }
            // Unanimated, unlike a sent message: a partial transcript lands
            // several times a second, and an animated scroll restarted that
            // often never arrives anywhere.
            .onChange(of: voiceMessages) { _, _ in
                proxy.scrollTo("transcript-bottom", anchor: .bottom)
            }
            .onChange(of: model.chatPhase) { _, _ in
                proxy.scrollTo("transcript-bottom", anchor: .bottom)
            }
        }
    }

    /// Decides which rows are new enough to rise in.
    ///
    /// The web seeds the same index at mount and calls it `animateFrom`
    /// (`message-list.tsx`) — it gets away with one line because its list mounts
    /// with the messages already in hand. A store that loads asynchronously does
    /// not: selecting a conversation sets the id first and the transcript arrives
    /// a moment later, so "everything that appeared since the last render" would
    /// mean the entire history every time a chat is opened.
    private func noteMessages(from previous: Int, to current: Int) {
        guard settledConversationID == model.selectedConversationID else {
            // A conversation that has only just been selected has not loaded yet,
            // so whatever arrives first is its history — however short — and
            // history must not replay. It is not recorded as settled until
            // something actually lands, or an empty first pass would count as the
            // load and the real one would animate.
            if current > 0 { settledConversationID = model.selectedConversationID }
            animateFrom = current
            return
        }
        // A send appends the reader's own turn and then the reply's placeholder,
        // one at a time. Anything larger is a block landing — a sync catching up,
        // a branch being read — and that is history again.
        animateFrom = current - previous > 2 ? current : previous
    }

    private func copy(_ content: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(content, forType: .string)
    }

    private func setFeedback(
        _ feedback: NativeChatFeedback?,
        for message: NativeChatMessage
    ) {
        guard let messageActions else { return }
        let previous = message.feedback
        model.applyFeedback(
            feedback,
            messageID: message.id,
            conversationID: message.conversationID
        )
        actionError = nil
        Task {
            do {
                try await messageActions.setFeedback(
                    messageID: message.id,
                    feedback: feedback.map {
                        $0 == .up ? .up : .down
                    },
                    for: accountID
                )
            } catch {
                model.applyFeedback(
                    previous,
                    messageID: message.id,
                    conversationID: message.conversationID
                )
                actionError = error.localizedDescription
            }
        }
    }

    /// Where `message` sits among its revisions, or nil when it has none.
    ///
    /// Asked of the store per row rather than cached on the message: a position
    /// is a fact about the tree, and one copied onto a message would keep
    /// reading `2 / 3` after the reader's next edit made it `2 / 4`.
    private func branchPosition(
        for message: NativeChatMessage
    ) -> NativeMessageBranchPosition? {
        model.branchPosition(for: message.id, in: message.conversationID)
    }

    private func stepBranch(from message: NativeChatMessage, offset: Int) {
        Task {
            await model.stepBranch(
                from: message.id,
                in: message.conversationID,
                offset: offset
            )
        }
    }

    /// Re-asks a prompt as a new branch beside the original.
    ///
    /// The model is resolved the same way the composer resolves its own on
    /// opening a conversation — the account's pick for this conversation,
    /// falling back to the first model it can still use. Reading the composer's
    /// live selection instead would mean threading its state through the
    /// transcript, and the conversation's own model is the honest answer for a
    /// turn being asked again inside that conversation.
    private func editMessage(_ message: NativeChatMessage, newContent: String) {
        let modelID = DesktopChatSelection.resolvedModelID(
            current: "",
            conversationModel: model.selectedConversation?.model ?? "",
            selectable: model.selectableModels
        )
        guard !modelID.isEmpty else { return }
        Task {
            await model.editUserMessage(
                messageID: message.id,
                conversationID: message.conversationID,
                newContent: newContent,
                modelID: modelID
            )
        }
    }

    private func branch(from message: NativeChatMessage) {
        guard let messageActions else { return }
        actionError = nil
        Task {
            do {
                let id = try await messageActions.branch(
                    conversationID: message.conversationID,
                    atMessageID: message.id,
                    for: accountID
                )
                await syncModel?.refresh()
                await model.reload()
                model.isDraftingNewConversation = false
                model.selectedConversationID = id
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private func readAloud(_ content: String) {
        guard let messageActions else { return }
        actionError = nil
        Task {
            do {
                let audio = try await messageActions.speech(
                    text: content,
                    voiceID: nil,
                    for: accountID
                )
                try speechPlayback.play(audio: audio, fallbackText: content)
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
}

/// The web's `rise-in`, applied to a message that has just arrived.
///
/// `rises` is what keeps a scrolled history still. A `LazyVStack` builds a row
/// the moment it comes into view and destroys it again when it leaves, so a
/// transition driven by appearance alone replays for every old message the reader
/// scrolls back to — the row genuinely *is* appearing, it is simply not new. The
/// index gate answers the question appearance cannot.
private struct DesktopMessageRise: ViewModifier {
    let rises: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var risen: Bool

    /// A row that is not rising starts *already* risen rather than being set
    /// there by `onAppear`. Seeded the other way it spent its first frame at zero
    /// opacity, which on a lazily-built stack means every old message flickers as
    /// the reader scrolls back through the conversation.
    init(rises: Bool) {
        self.rises = rises
        _risen = State(initialValue: !rises)
    }

    func body(content: Content) -> some View {
        content
            .opacity(risen ? 1 : 0)
            .offset(y: risen ? 0 : DesktopChatMotion.riseDistance)
            .onAppear {
                guard rises, !reduceMotion else {
                    risen = true
                    return
                }
                withAnimation(JunoMotion.reduced(DesktopChatMotion.riseIn, when: reduceMotion)) {
                    risen = true
                }
            }
    }
}

private struct DesktopMessageRow: View {
    let message: NativeChatMessage
    /// Whether this is a spoken turn from a call that is still running.
    ///
    /// It suppresses the footer and the action row, as `isVoice` does on the web
    /// (`message-item.tsx`), and for the same reason: there is no row behind it
    /// yet. Regenerate, Branch and the feedback thumbs all address a message the
    /// server knows about, and this one exists only in the controller until the
    /// call is hung up and filed.
    let isVoice: Bool
    /// The model's human name, resolved from the account catalog by the caller.
    ///
    /// The footer used to render `message.model` directly, which is the canonical
    /// id — so the most-read surface in the product attributed answers to
    /// "anthropic:claude-sonnet-4-6". The id is a routing key, not a name.
    let modelDisplayName: String?
    let isLastAssistant: Bool
    let copy: () -> Void
    /// Nil where there is nothing on the server to regenerate — the same
    /// absence `branch` and `setFeedback` express, rather than a closure that
    /// does nothing.
    let regenerate: (() -> Void)?
    /// Nil unless the last answer ended at a resumable boundary. Continue is a
    /// new user turn; unlike regenerate it leaves the partial answer visible.
    let continueResponse: (() -> Void)?
    let branch: (() -> Void)?
    let setFeedback: ((NativeChatFeedback?) -> Void)?
    let readAloud: (() -> Void)?
    /// Hands an artifact up to the conversation column, which owns the canvas.
    /// This row only says which one — it cannot hold the panel, because a
    /// `LazyVStack` is free to tear the row down while the reader is still
    /// reading it.
    let openArtifact: (NativeMessageContent.ArtifactReference) -> Void
    /// Where this message sits among its revisions, or nil when it has none.
    ///
    /// Nil is the answer for every message in a conversation nobody has edited,
    /// which is what keeps the `‹ 1 / 1 ›` pager — a control that cannot do
    /// anything — off the overwhelming majority of transcripts.
    let branchPosition: NativeMessageBranchPosition?
    /// Switches to the revision `offset` steps away. Supplied by the transcript
    /// rather than derived here: a row cannot reach the store.
    let stepBranch: ((Int) -> Void)?
    /// Re-asks this prompt with new wording, as a **new branch**. The original
    /// keeps its text and its whole subtree of replies — see
    /// ``NativeConversationModel/editUserMessage(messageID:conversationID:newContent:modelID:)``.
    /// Nil on answers and on spoken lines, neither of which can be re-asked.
    let editMessage: ((String) -> Void)?
    /// Whether a generation is running. Greys the pager and withholds Edit
    /// rather than hiding either — a control that vanishes mid-stream reads as a
    /// revision that was lost.
    let isGenerating: Bool
    /// Whether a long prompt is showing in full. Collapsed is the resting state,
    /// as it is on the web.
    @State private var promptExpanded = false
    /// Whether this prompt is open for rewriting, and the words being written.
    ///
    /// Local to the row on purpose: an edit in progress is not conversation
    /// state, and hoisting it would make a `LazyVStack` tearing the row down on
    /// scroll into a way to lose what someone was typing.
    @State private var editing = false
    @State private var draft = ""

    private var displayContent: String {
        message.sources.isEmpty
            ? message.content
            : NativeMessageContent.strippingTrailingSourcesSection(message.content)
    }

    private var parts: [NativeMessageContent.Part] {
        NativeMessageContent.parts(of: displayContent)
    }

    private var plainText: String {
        NativeMessageContent.plainText(of: message.content)
    }

    /// The lines AIcss's viewport shows, or nil when the model sent no trace.
    ///
    /// A display chunking of what the provider sent — never a claim about where its
    /// steps were. See `JunoAIcssReasoningLines`.
    private var reasoningLines: [String]? {
        guard let reasoning = message.reasoning, !reasoning.isEmpty else { return nil }
        return JunoAIcssReasoningLines.lines(text: reasoning)
    }

    /// `rounded-2xl rounded-br-md`: one clipped corner on the trailing-bottom
    /// edge. Uniform corners make a card; the notch is what makes it a remark.
    private static let bubbleShape = UnevenRoundedRectangle(
        topLeadingRadius: JunoRadius.message,
        bottomLeadingRadius: JunoRadius.message,
        bottomTrailingRadius: JunoRadius.chip,
        topTrailingRadius: JunoRadius.message,
        style: .continuous
    )

    /// Which model wrote this, what it cost, and whether it is still arriving —
    /// one line, in the web's monospaced metadata voice.
    ///
    /// Joined here rather than laid out as three `Text`s in an `HStack`: the web
    /// writes a single `font-mono` string with "·" separators, and three floating
    /// fragments under every answer is three things to read instead of one.
    private var footerLine: String? {
        // Not named `parts`: that is already this row's *content* parts, and one
        // shadowing the other in a file this long is a trap for the next reader.
        var fields: [String] = []
        if let modelDisplayName {
            fields.append(modelDisplayName)
        }
        if let cost = message.costUSD {
            fields.append(cost.formatted(.currency(code: "USD")))
        }
        if message.isPending {
            fields.append("Streaming")
        }
        return fields.isEmpty ? nil : fields.joined(separator: " · ")
    }

    /// Whether this prompt is long enough to open collapsed. The rule and the
    /// numbers are the website's — see ``NativePromptLimits``.
    private var isLongPrompt: Bool {
        message.role == .user && NativePromptLimits.isLongMessage(plainText)
    }

    /// The bubble proper.
    ///
    /// A long prompt — a pasted system prompt, a curriculum, a stack trace — is
    /// clipped to ``NativePromptLimits/collapsedMessageHeight`` with a fade off
    /// its bottom edge, so the answer the reader came back for is not pushed a
    /// screen down by the thing they already know they wrote. The text itself is
    /// untouched: Copy and VoiceOver read the whole message either way.
    private var userBubble: some View {
        Text(plainText)
            .textSelection(.enabled)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.snug)
            .frame(
                maxHeight: isLongPrompt && !promptExpanded
                    ? NativePromptLimits.collapsedMessageHeight : nil,
                alignment: .top
            )
            .clipped()
            .overlay(alignment: .bottom) {
                if isLongPrompt, !promptExpanded {
                    // The web's `bg-gradient-to-t from-secondary` — the bubble's
                    // own fill dissolving upward, which is what says "clipped"
                    // rather than "ended".
                    LinearGradient(
                        colors: [Color.junoMuted, Color.junoMuted.opacity(0)],
                        startPoint: .bottom,
                        endPoint: .top
                    )
                    .frame(height: 64)
                    .allowsHitTesting(false)
                }
            }
            // The web's bubble is a *raised* surface, not a tint:
            // `bg-secondary` **plus** `border-border/50` and
            // `--shadow-soft`. With the fill alone it read as a
            // slightly darker patch of the same cream field — the
            // flatness this redesign exists to remove — because
            // `--muted` and `--background` are barely a step apart.
            // Hand-rolled rather than `junoCard()` only because the
            // shape is uneven; the tokens are the card's own.
            .background(Self.bubbleShape.fill(Color.junoMuted))
            .overlay(
                Self.bubbleShape
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .shadow(
                color: .junoCardShadow,
                radius: JunoElevation.cardBlur,
                y: JunoElevation.cardOffsetY
            )
    }

    /// "Show more · 22 lines", in the web's monospaced metadata voice. The size
    /// is sampled off the head of the message, never counted across the whole of
    /// a multi-megabyte paste.
    private var expandControl: some View {
        Button {
            withAnimation(JunoMotion.standard) { promptExpanded.toggle() }
        } label: {
            HStack(spacing: 4) {
                JunoIconView(systemImage: promptExpanded ? "chevron.up" : "chevron.down")
                    .junoFont(size: 9, relativeTo: .caption, weight: .semibold)
                Text(
                    promptExpanded
                        ? "Show less"
                        : "Show more · \(NativePromptLimits.collapsedSummary(for: plainText))"
                )
                .font(.caption.monospaced())
            }
            .junoSecondaryInk()
        }
        .buttonStyle(.plain)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.desktop.chat.message-expand")
    }

    /// The `‹ 1 / 3 ›` pager, where this message has revisions to page through.
    ///
    /// Built only when the store handed down a position, which it does only for
    /// a message that genuinely has siblings — so this is empty on almost every
    /// row, and the transcript keeps the spacing it had before trees existed.
    @ViewBuilder
    private var branchNavigator: some View {
        if let branchPosition, let stepBranch {
            NativeBranchNavigator(
                position: branchPosition,
                isEnabled: !isGenerating,
                onStep: stepBranch
            )
        }
    }

    /// The bubble, opened for rewriting in place.
    ///
    /// In place rather than in a sheet: the reader is changing one sentence in a
    /// conversation they can see, and a modal over the transcript takes away the
    /// context that tells them what to change it to.
    private var promptEditor: some View {
        VStack(alignment: .trailing, spacing: JunoSpace.snug) {
            TextEditor(text: $draft)
                .font(.body)
                .textEditorStyle(.plain)
                // The editor draws its own opaque backing, which would sit as a
                // white slab inside the bubble's fill.
                .scrollContentBackground(.hidden)
                .frame(minHeight: 64, maxHeight: 240)
                .padding(.horizontal, JunoSpace.tight)
                .padding(.vertical, JunoSpace.hairline)
                .background(Self.bubbleShape.fill(Color.junoMuted))
                .overlay(
                    Self.bubbleShape
                        .strokeBorder(Color.junoFocusRing, lineWidth: 1)
                )
                .frame(maxWidth: 560)
                .accessibilityLabel("Edit message")
                .accessibilityIdentifier("juno.desktop.chat.message-editor")

            HStack(spacing: JunoSpace.snug) {
                Button("Cancel") { editing = false }
                    .buttonStyle(.plain)
                    .junoSecondaryInk()
                Button("Send") { submitEdit() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSubmitEdit)
            }
            .font(.callout)
        }
    }

    /// Whether the rewrite is worth sending: not blank, and not the words that
    /// are already there. Re-asking an unchanged prompt would spend a turn to
    /// add a revision identical to the one beside it.
    private var canSubmitEdit: Bool {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty
            && trimmed != plainText.trimmingCharacters(in: .whitespacesAndNewlines)
            && !isGenerating
    }

    private func submitEdit() {
        guard canSubmitEdit, let editMessage else { return }
        editing = false
        editMessage(draft)
    }

    /// Edit and the pager, under the reader's own words.
    @ViewBuilder
    private var promptControls: some View {
        // `isVoice` withholds Edit for the same reason it withholds the action
        // row: a spoken line exists only in the call controller, and there is no
        // stored message for a fork to branch away from.
        if !isVoice, editMessage != nil || branchPosition != nil {
            HStack(spacing: JunoSpace.hairline) {
                branchNavigator
                if editMessage != nil, !editing {
                    messageAction("Edit message", symbol: "pencil") {
                        draft = plainText
                        editing = true
                    }
                    .disabled(isGenerating)
                    .accessibilityIdentifier("juno.desktop.chat.message-edit")
                }
            }
        }
    }

    var body: some View {
        Group {
            switch message.role {
            case .user:
                HStack {
                    Spacer(minLength: 90)
                    VStack(alignment: .trailing, spacing: JunoSpace.hairline) {
                        if editing {
                            promptEditor
                        } else {
                            userBubble
                            if isLongPrompt { expandControl }
                        }
                        promptControls
                    }
                }

            case .assistant:
                VStack(alignment: .leading, spacing: 14) {
                // THE TRACE, in AIcss's viewport.
                //
                // This was a system `DisclosureGroup` over the whole reasoning
                // trace as one `Text`: a triangle labelled "Thought process" that,
                // opened, dropped an unbounded wall of prose into the transcript
                // and pushed the answer off screen. Nothing about it said how long
                // the run took, and while streaming it grew under the reader on
                // every delta. The viewport is bounded — 40pt slots clamped to two
                // lines, capped at 180pt, then masked — so the trace can now be
                // open by default while the answer is being written, which is when
                // it is worth anything.
                if let lines = reasoningLines, !lines.isEmpty {
                    JunoAIcssReasoningStream(
                        lines: lines,
                        streaming: message.isPending,
                        duration: nil,
                        showsHeader: !message.isPending
                    )
                    .frame(maxWidth: 520, alignment: .leading)
                }

                if let progress = message.mediaProgress {
                    // A generation in flight has no text to render — the picture
                    // is the answer, and it arrives whole in the `done` frame.
                    NativeMediaGenerationView(progress: progress)
                } else if message.content.isEmpty, message.isPending {
                    // The dot matrix and AIcss's shine, as on the phone and the
                    // web. This was a stock `ProgressView` spinner beside "Juno is
                    // working…" — a system control saying nothing of Juno's, next
                    // to a sentence that named the app rather than the work.
                    HStack(spacing: 10) {
                        // No ink stated here, deliberately. The matrix draws
                        // itself in absolute `junoForeground` at the web's own
                        // per-dot alphas, so the diluted
                        // `junoMutedForeground.opacity(0.65)` this used to
                        // carry never reached a single dot — and the ramp has
                        // no diluted rung to restate it with anyway.
                        JunoThinkingMatrix()
                        JunoAIcssThinkingLabel("Thinking about your request", size: 15)
                    }
                    .frame(minHeight: 22)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Thinking about your request")
                    .accessibilityAddTraits(.updatesFrequently)
                } else {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                        switch part {
                        case .text(let text):
                            // AIcss's caret rides the last paragraph while tokens
                            // are still arriving. Same signal as the phone's.
                            JunoLessonText(text, streaming: message.isPending)
                        case .artifact(let artifact):
                            DesktopInlineArtifactCard(
                                artifact: artifact,
                                open: artifact.streaming
                                    ? nil
                                    : { openArtifact(artifact) }
                            )
                        }
                    }
                }

                if !message.sources.isEmpty {
                    DesktopMessageSources(sources: message.sources)
                }

                if let footerLine, !isVoice {
                    // The per-message meta line: model, token count, latency. It
                    // was `.tertiary` and measured **1.89:1** in light appearance
                    // — the worst contrast anywhere in the product, on text that
                    // is offered as selectable and is therefore explicitly meant
                    // to be read and copied. It is still the quietest thing in
                    // the message: `caption2`, monospaced, no weight. Quiet is a
                    // matter of size and weight; it was never a licence to go
                    // below the AA floor.
                    Text(footerLine)
                        .font(.system(.caption2, design: .monospaced))
                        .junoMetaInk()
                        .textSelection(.enabled)
                }

                if let error = message.errorDescription {
                    Text(error)
                        .font(.callout)
                        // The status ramp, not `.red`: `junoDanger` is tuned for
                        // contrast against both the warm canvas and the raised
                        // surfaces, and it lifts rather than saturates in dark.
                        .foregroundStyle(Color.junoDanger)
                        .textSelection(.enabled)
                }

                if !message.isPending, !isVoice {
                    HStack(spacing: 4) {
                        messageAction(
                            "Copy",
                            symbol: "doc.on.doc",
                            action: copy
                        )
                        if let readAloud {
                            messageAction(
                                "Read aloud",
                                symbol: "speaker.wave.2",
                                action: readAloud
                            )
                        }
                        if let branch {
                            messageAction(
                                "Branch from here",
                                symbol: "arrow.triangle.branch",
                                action: branch
                            )
                        }
                        if isLastAssistant, let regenerate {
                            messageAction(
                                "Regenerate",
                                symbol: "arrow.clockwise",
                                action: regenerate
                            )
                        }
                        if isLastAssistant,
                            let continueResponse,
                            message.finishReason == .length
                                || message.finishReason == .networkError
                        {
                            messageAction(
                                "Continue",
                                symbol: "arrow.down.circle",
                                action: continueResponse
                            )
                        }
                        if let setFeedback {
                            Spacer()
                            messageAction(
                                "Good response",
                                symbol: message.feedback == .up
                                    ? "hand.thumbsup.fill" : "hand.thumbsup",
                                active: message.feedback == .up
                            ) {
                                setFeedback(message.feedback == .up ? nil : .up)
                            }
                            messageAction(
                                "Bad response",
                                symbol: message.feedback == .down
                                    ? "hand.thumbsdown.fill" : "hand.thumbsdown",
                                active: message.feedback == .down
                            ) {
                                setFeedback(message.feedback == .down ? nil : .down)
                            }
                        }
                    }
                    .junoSecondaryInk()
                }

                // Under the answer, where the web puts it. An answer has
                // siblings when the question above it was re-asked, so this is
                // the same pager the prompt carries, reading the same numbers.
                branchNavigator
                }

            case .system, .tool:
                Text(message.content)
                    .font(.callout)
                    .junoSecondaryInk()
                    .textSelection(.enabled)
            }
        }
    }

    private func messageAction(
        _ label: String,
        symbol: String,
        active: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            JunoIconView(systemImage: symbol)
                .frame(width: 22, height: 22)
                .foregroundStyle(active ? Color.junoAccent : Color.junoMutedForeground)
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }
}

/// An artifact referenced inline in an answer.
///
/// Built from the web's `artifact-inline-card.tsx`: a raised card, a glyph in its
/// own bordered tile, the title in the UI face, and everything else — the kind,
/// the language, the live status — on one monospaced metadata line. The chrome
/// stays quiet on purpose; on the web the artifact's *content* is the visual
/// event, which is also why the icon is not painted coral. Coral is spent on one
/// primary action per surface, and a card in a transcript is not it.
///
/// The card is a launcher and nothing more: it hands the artifact up and
/// ``DesktopArtifactCanvas`` docks beside the conversation. Names come from
/// ``DesktopArtifactKindLabel`` so the card and the panel it opens cannot
/// describe the same object differently.
private struct DesktopInlineArtifactCard: View {
    let artifact: NativeMessageContent.ArtifactReference
    let open: (() -> Void)?

    private var glyph: String {
        DesktopArtifactKindLabel.symbol(forWireKind: artifact.kind)
    }

    private var kindLabel: String {
        DesktopArtifactKindLabel.title(forWireKind: artifact.kind)
    }

    /// The web's mono line: the kind, then the language when the model named one.
    /// "Writing" replaces both while the source is still arriving.
    private var metadata: String {
        if artifact.streaming { return "Writing" }
        guard let language = artifact.language, !language.isEmpty else {
            return kindLabel
        }
        return "\(kindLabel) · \(language.uppercased())"
    }

    var body: some View {
        Button {
            open?()
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                // The web's `size-8` tile. The glyph needs a surface of its own or
                // it reads as punctuation in front of the title. Fill only, no
                // second hairline: this is nested inside a card that already has
                // one, which is the distinction `junoPanel` draws against
                // `junoCard`.
                JunoIconView(systemImage: glyph)
                    .font(.callout)
                    .foregroundStyle(
                        artifact.streaming ? Color.junoAccent : Color.junoMutedForeground
                    )
                    .frame(width: 32, height: 32)
                    .background(
                        RoundedRectangle(
                            cornerRadius: JunoRadius.row,
                            style: .continuous
                        )
                        .fill(Color.junoMuted)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(artifact.title.isEmpty ? "Untitled artifact" : artifact.title)
                        .font(.callout.weight(.medium))
                        .junoInk()
                        .lineLimit(1)
                    Text(metadata)
                        .font(.system(.caption2, design: .monospaced))
                        .junoSecondaryInk()
                        .lineLimit(1)
                }

                Spacer(minLength: JunoSpace.snug)

                if artifact.streaming {
                    // Juno's own dot matrix, which is what the web animates while
                    // an artifact writes — not a spinner, which says "blocked".
                    JunoThinkingMatrix(dot: 3, spacing: 2)
                        .junoSecondaryInk()
                } else if open != nil {
                    JunoIconLabel("Open", systemImage: "arrow.up.right")
                        .labelStyle(.titleAndIcon)
                        .font(.caption.weight(.medium))
                        .junoSecondaryInk()
                }
            }
            .padding(JunoSpace.cozy)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(open == nil)
        .junoCard(cornerRadius: JunoRadius.card)
        .accessibilityLabel(
            artifact.streaming
                ? "Writing artifact \(artifact.title)"
                : "Open artifact \(artifact.title), \(metadata)"
        )
    }
}

@MainActor
private final class DesktopSpeechPlayback {
    private let synthesizer = AVSpeechSynthesizer()
    private var audioPlayer: AVAudioPlayer?

    func play(audio: Data?, fallbackText: String) throws {
        synthesizer.stopSpeaking(at: .immediate)
        audioPlayer?.stop()
        audioPlayer = nil
        if let audio {
            let player = try AVAudioPlayer(data: audio)
            player.prepareToPlay()
            player.play()
            audioPlayer = player
        } else {
            synthesizer.speak(AVSpeechUtterance(string: fallbackText))
        }
    }
}

/// The answer's bibliography, as the web writes it: a pill that reports how many
/// sources backed the reply and expands into the cited list.
///
/// The flat "Sources" heading with every link permanently open that this replaces
/// was the loudest thing under a long answer, and it grew without limit — a deep
/// research reply cites dozens. The web collapses it deliberately: the inline
/// citations are what a reader follows mid-sentence, and this is the bibliography
/// they open afterwards. Both the pill and the expanded list are raised surfaces,
/// so they read as objects sitting on the canvas rather than as more text printed
/// onto it.
private struct DesktopMessageSources: View {
    let sources: [NativeChatSource]
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            pill
            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                        if index > 0 {
                            Divider().padding(.leading, JunoSpace.region)
                        }
                        row(source, index: index + 1)
                    }
                }
                .junoCard()
                // The web's `max-w-xl`: a citation list is scanned down its left
                // edge, so it stops well short of the reading column's width.
                .frame(maxWidth: 576, alignment: .leading)
                .transition(.opacity)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var pill: some View {
        Button {
            withAnimation(JunoMotion.standard) { expanded.toggle() }
        } label: {
            HStack(spacing: JunoSpace.tight) {
                // The web stacks each site's favicon here. This client fetches no
                // remote images for a transcript, so it says the same thing with
                // one glyph rather than inventing placeholder logos.
                JunoIconView(systemImage: "globe")
                    .font(.caption)
                    .junoSecondaryInk()
                Text("Sources")
                    .font(.system(.caption, design: .monospaced))
                    .junoInk()
                Text(sources.count.formatted())
                    .font(.system(.caption2, design: .monospaced))
                    .junoSecondaryInk()
                    .monospacedDigit()
                JunoIconView(systemImage: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .junoSecondaryInk()
                    .rotationEffect(.degrees(expanded ? 180 : 0))
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.tight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        // The radius exceeds half the pill's height, so it resolves to a capsule —
        // which is what makes it read as a control rather than as a small card,
        // exactly as the web's `rounded-full` pill does.
        .junoCard(cornerRadius: JunoRadius.message)
        .accessibilityLabel("Sources, \(sources.count)")
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }

    private func row(_ source: NativeChatSource, index: Int) -> some View {
        Link(destination: source.url) {
            HStack(spacing: JunoSpace.cozy) {
                // Numbered to match the inline `[n]` citations in the answer
                // above, so the two read as one numbering.
                Text(index.formatted())
                    .font(.system(.caption2, design: .monospaced))
                    .junoMetaInk()
                    .monospacedDigit()
                    .frame(minWidth: JunoSpace.regular, alignment: .trailing)

                VStack(alignment: .leading, spacing: 1) {
                    Text(source.title.isEmpty ? host(of: source.url) : source.title)
                        .font(.callout)
                        .junoInk()
                        .lineLimit(1)
                    Text(host(of: source.url))
                        .font(.system(.caption2, design: .monospaced))
                        .junoSecondaryInk()
                        .lineLimit(1)
                }

                Spacer(minLength: JunoSpace.snug)

                JunoIconView(systemImage: "arrow.up.right")
                    .font(.caption2)
                    .junoMetaInk()
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(source.url.absoluteString)
    }

    /// The web's `hostOf`: the bare host, without the `www.` that carries no
    /// information and pushes the part a reader recognises off the line.
    private func host(of url: URL) -> String {
        guard let host = url.host() else { return url.absoluteString }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

/// The live run's searches, in AIcss's Web Search block.
///
/// What that replaced: a card headed "Research in progress" over a coral bullet
/// per activity item, showing `detail ?? title` for every kind of event. Three
/// things were wrong with it. Coral is reserved for what is active or selected,
/// and every bullet wore it including the finished ones. Every event became a
/// row, so "Selected model" and "Reasoning mode enabled" sat in a list the reader
/// would take for search results. And the query the run was actually searching
/// for — the one thing that answers "what is it doing?" — was never distinguished
/// from anything else in the list.
///
/// Now the query leads and shimmers while the search is open, and only real
/// sources become rows.
private struct DesktopResearchActivity: View {
    let items: [NativeChatActivity]

    private var query: String? { NativeSearchActivity.query(in: items) }
    private var sites: [JunoAIcssSearchSite] { NativeSearchActivity.sites(in: items) }

    var body: some View {
        // Nothing to say is no card. Before the first search or visit lands there
        // is no query and no source, and an empty "Research in progress" card is a
        // claim that something is being shown.
        if query != nil || !sites.isEmpty {
            JunoAIcssWebSearch(
                query: query,
                sites: sites,
                settled: NativeSearchActivity.settled(in: items)
            )
            .padding(JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
            // A raised card, not a bare fill: without the hairline and the throw
            // this was a white rectangle on a warm field with no edge to it.
            .junoCard()
        }
    }
}

private struct DesktopChatError: View {
    let message: String
    let canRetry: Bool
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            JunoIconView(systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.junoDanger)
            Text(message)
                .font(.callout)
                .textSelection(.enabled)
            Spacer(minLength: JunoSpace.snug)
            if canRetry {
                Button("Retry", action: retry)
            }
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The card treatment plus a danger-coloured glyph, rather than a red wash
        // behind the text. A tinted fill needs an opacity nobody owns and it drops
        // the contrast of the very message the reader has to act on; the glyph and
        // the status ramp carry the meaning without touching legibility.
        .junoCard()
    }
}

struct DesktopComposer: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let attachmentModel: NativeComposerAttachmentModel?
    let libraryModel: NativeLibraryModel?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    /// The local half of every custom assistant on this account, which is where a
    /// project's preferred model is kept. Optional for the same reason
    /// ``JunoDesktopConfiguration/projectWorkspaceModel`` is: a composition root
    /// that could not open this Mac's local store has no preferences to read, and
    /// a composer with no preferences behaves exactly as it did before they
    /// existed.
    let workspaceModel: ProjectWorkspaceModel<SQLiteAccountRepository>?
    /// This Mac's local document index. Non-nil is what makes the "My documents"
    /// row in the "+" menu appear at all — see ``documentGroundingArmed``.
    let documentIndex: NativeDocumentIndexModel?
    let connectorModel: NativeConnectorModel?
    @Binding var draftProjectID: String?
    @Binding var draftPrompt: String?
    let openVoiceMode: (String) -> Void
    /// Locks this composer to a project and always starts a new conversation.
    /// Used by the project overview so it is the same composer as Chat, not a
    /// prompt-shaped imitation with fewer controls.
    var fixedProjectID: String? = nil
    /// Called after the first message is accepted, so an embedded project
    /// composer can move to the real transcript it just created.
    var didSendConversation: ((String) -> Void)? = nil
    /// The bloom this composer feeds, when the surface it is on has one.
    ///
    /// Optional because the project overview embeds this same composer in the
    /// middle of a page of other things — the website puts no aura there either,
    /// and a light under a card in a list would be claiming that card is the
    /// screen.
    var aura: DesktopChatAuraState? = nil

    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var thinkingStopID = ""
    @State private var deepResearch = false
    @State private var webSearch = false
    @State private var canvasEnabled = false
    // @AppStorage rather than @State, unlike its neighbours: these two are
    // preferences that must survive a relaunch (the web keeps them in
    // localStorage, iOS in UserDefaults), where deepResearch above is
    // deliberately per-send and webSearch/canvas are per-view here already.
    @AppStorage("juno.desktop.composer.fast-mode") private var fastMode = false
    @AppStorage("juno.desktop.composer.pro-mode") private var proMode = false
    /// Let Juno pick the model per turn instead of always using the selection.
    ///
    /// Defaults to false so an existing reader's model choice keeps being obeyed
    /// exactly as before. See ``routedModelID(for:)`` for why this is opt-in.
    @AppStorage("juno.desktop.composer.auto-route-model") private var autoRouteModel = false
    /// Whether a turn may quote this Mac's own document index.
    ///
    /// **Off by default, and that default is the point.** Importing a file into
    /// the Library is consent to *search* it on this machine; it is not standing
    /// consent to put paragraphs of it into every question that leaves the Mac
    /// afterwards. Somebody who has indexed a medical letter and then asks Juno
    /// an unrelated question must not have the letter quoted at a provider
    /// because a lexical ranker thought two words matched.
    ///
    /// `@AppStorage` rather than `@State`, beside `fastMode` and `proMode`: it is
    /// a preference, and a reader who turns it on should not have to turn it on
    /// again in the next window. It can therefore be on with an empty index —
    /// which is fine and says so, because the index is memory-only and starts
    /// empty at every launch.
    @AppStorage("juno.desktop.composer.document-context") private var documentContext = false
    /// What grounding did on the last send, in one sentence.
    ///
    /// Kept because "your documents were searched and nothing matched" and "your
    /// documents were quoted" have to be told apart from outside. Without it a
    /// reader with the switch on has no way to know which of the two happened,
    /// and the safe assumption — that their files were consulted — is the wrong
    /// one about half the time.
    @State private var groundingNote: String?
    /// Whether the reader opened the model picker and chose, in this composer,
    /// since the conversation was selected.
    ///
    /// The top rung of ``routedModelID(for:)``'s precedence. It cannot be derived
    /// from `selectedModelID`: that value is *also* what `configureSelection()`
    /// resolves from the conversation and the catalog, so "GPT-5.6 because the
    /// reader said so" and "GPT-5.6 because it was first in the list" are the
    /// same string and must not be treated as the same instruction.
    @State private var modelChosenByReader = false
    @State private var selectedProjectID: String?
    @State private var selectedConnectors: Set<String> = []
    @State private var showingFileImporter = false
    @State private var showingLibrary = false
    @State private var showingModelSelector = false
    @State private var showingThinking = false
    @State private var dictating = false
    @State private var importError: String?
    /// Set while a spoken turn is on the wire, so a second Return cannot send
    /// the same images twice.
    @State private var isSendingVoiceTurn = false
    /// Why the last spoken turn was refused, shown in the same notice row as the
    /// attachment errors because it is the same kind of news.
    @State private var voiceTurnError: String?
    /// Whether a very large draft has been opened back up for editing. The text
    /// is in `prompt` and sent in full either way — this only decides whether it
    /// is live in the text field. See ``NativePromptLimits``.
    @State private var draftExpanded = false
    @State private var isHoveringDictate = false
    @FocusState private var focused: Bool
    /// The call this composer is inside, published by ``junoVoiceDock(_:)``.
    /// Non-nil is what routes a send over the socket instead of to `/api/chat`.
    @Environment(\.junoVoiceCall) private var voiceCall
    /// Read here for the control strip's hover states: the fills cross under
    /// ``JunoMotion/Tier/tint`` and survive the preference, the 2% lift is travel
    /// and does not.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var selectedModel: NativeChatModelOption? {
        model.model(withID: selectedModelID)
    }

    private var thinkingScale: NativeThinkingScale? {
        selectedModel.map(NativeThinkingScale.init(model:))
    }

    private var reasoningEffort: NativeReasoningEffort? {
        thinkingScale?.stops.first { $0.id == thinkingStopID }?.effort
    }

    // MARK: The reader's own documents

    /// How many files this Mac currently has indexed. Zero is a real and common
    /// state — the index is memory-only and empty at every launch.
    private var indexedDocumentCount: Int {
        documentIndex?.documents.count ?? 0
    }

    /// Whether the next send will search this Mac's documents.
    ///
    /// All three conditions are required. A lit switch over an empty index would
    /// promise something that cannot happen — the same rule the Web search row
    /// already follows for a model that cannot search — and a spoken turn leaves
    /// over the realtime socket, which carries none of the text this grounding
    /// extends. Claiming otherwise mid-call would be the one thing this feature
    /// must never do: say documents were consulted when they were not.
    private var documentGroundingArmed: Bool {
        documentContext && indexedDocumentCount > 0 && !voiceActive
    }

    /// The line above the composer about the reader's documents.
    ///
    /// Two states, never merged: before a send it says what *will* happen, and
    /// after one it says what *did*. Silence in between is not an option — the
    /// whole objection to prompt-side retrieval is that files get read into a
    /// message with nothing on screen admitting it.
    @ViewBuilder
    private var documentContextNotice: some View {
        if let groundingNote {
            JunoIconLabel(verbatim: groundingNote, systemImage: "doc.text.magnifyingglass")
                .junoCaption()
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("juno.desktop.chat.document-context-note")
        } else if documentGroundingArmed {
            Label(
                indexedDocumentCount == 1
                    ? "Juno will search 1 document on this Mac and quote what it finds in your message."
                    : "Juno will search \(indexedDocumentCount) documents on this Mac and quote what it finds in your message.",
                systemImage: "doc.text.magnifyingglass"
            )
            .junoCaption()
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("juno.desktop.chat.document-context-armed")
        }
    }

    private var canSend: Bool {
        // Text *or* attachments, as the web has it: a message that is nothing
        // but the file you attached is a message. Requiring text here is what
        // made "Attach as file" leave a draft that could not be sent.
        (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !(attachmentModel?.attachments.isEmpty ?? true))
            && !selectedModelID.isEmpty
            && !model.isGenerating
            && !isSendingVoiceTurn
            && (attachmentModel?.canSend ?? true)
    }

    // MARK: Voice mode

    /// Whether a call is running over this composer. While it is, the draft goes
    /// to the model that is speaking rather than to the chat route.
    private var voiceActive: Bool { voiceCall != nil }

    /// Past four images a turn, providers start answering about the first one
    /// and ignoring the rest. The relay enforces the same ceiling; this is here
    /// so the reader is stopped before they compose a fifth.
    private static let maximumVoiceImages = 4

    /// Whether the model on the other end of the call can see at all.
    ///
    /// Read from what the relay said in `session.ready` rather than from a list
    /// of providers kept here, which would be a second copy to drift. Nil while
    /// connecting reads as "no", so the attach row is not offered a beat before
    /// it can work.
    private var voiceCanSeeImages: Bool {
        voiceCall?.controller.capabilities?.videoInput == true
    }

    /// Whether another image can be staged for the call in progress.
    private var canAttachInVoice: Bool {
        voiceCanSeeImages
            && (attachmentModel?.attachments.count ?? 0) < Self.maximumVoiceImages
    }

    /// What the file importer will accept.
    ///
    /// Narrowed to images during a call, which is the Mac's version of the phone
    /// disabling its Files row: no realtime provider accepts a document, and this
    /// column has no separate Photos row to fall back on, so the one attach row
    /// has to become the image row rather than the refused one.
    private var importedContentTypes: [UTType] {
        voiceActive ? [.image] : [.item]
    }

    // MARK: Long drafts

    /// Whether the draft is long enough that sending it as a file is worth
    /// offering. An offer, never a rule — see ``NativePromptLimits``.
    private var isLongDraft: Bool {
        canAttachDraft && NativePromptLimits.isLongDraft(prompt)
    }

    /// Past this the draft leaves the text field entirely and shows as a card.
    /// Tens of thousands of characters in an auto-sizing `TextField` re-measure
    /// on every keystroke, and the composer stops accepting input long before
    /// the reader gets to Send.
    private var showsCollapsedDraft: Bool {
        NativePromptLimits.isHugeDraft(prompt) && !draftExpanded
    }

    private var canAttachDraft: Bool {
        attachmentModel?.hasCapacity ?? false
    }

    /// Sends the draft as `prompt.txt` instead of as message text.
    ///
    /// The web's `attachAsFile`, ported: same file name, same MIME type, and the
    /// same clearing of the draft afterwards, so a prompt attached here and one
    /// attached in the browser arrive at the model as the same message.
    private func attachDraftAsFile() {
        let content = prompt
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let attachmentModel
        else { return }
        attachmentModel.add(
            data: Data(content.utf8),
            fileName: NativePromptLimits.attachedPromptFileName,
            mimeType: NativePromptLimits.attachedPromptMimeType,
            conversationID: model.selectedConversationID,
            isImage: false
        )
        prompt = ""
        draftExpanded = false
    }

    var body: some View {
        // One glass container for the whole composer. The bar and the send
        // button are both glass; without a shared container each samples the
        // canvas independently and they seam where they meet instead of
        // refracting one sample and blending as they approach.
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            composerContent
        }
    }

    private var composerContent: some View {
        VStack(spacing: 10) {
            if let attachmentModel, !attachmentModel.attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(attachmentModel.attachments) { attachment in
                            DesktopAttachmentChip(
                                attachment: attachment,
                                remove: { attachmentModel.remove(attachment.id) },
                                retry: {
                                    attachmentModel.retry(
                                        attachment.id,
                                        conversationID: model.selectedConversationID
                                    )
                                }
                            )
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }

            if let message = voiceTurnError ?? importError
                ?? attachmentModel?.lastErrorDescription
            {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(Color.junoDanger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            documentContextNotice

            if dictating {
                DesktopDictation(
                    onCancel: {
                        withAnimation(JunoMotion.fast) {
                            dictating = false
                        }
                        focused = true
                    },
                    onStop: { transcript in
                        appendDictated(transcript)
                        withAnimation(JunoMotion.fast) {
                            dictating = false
                        }
                        focused = true
                    },
                    onSend: { transcript in
                        appendDictated(transcript)
                        withAnimation(JunoMotion.fast) {
                            dictating = false
                        }
                        Task {
                            await Task.yield()
                            send()
                        }
                    }
                )
                .transition(.opacity)
            } else {
                if showsCollapsedDraft {
                    collapsedDraftCard
                        .transition(.opacity)
                } else {
                TextField("Message Juno", text: $prompt, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .font(.body)
                    .focused($focused)
                    .padding(.horizontal, 8)
                    .padding(.top, 4)
                    .accessibilityIdentifier("Message Juno")
                    // Return sends; Shift-Return breaks the line.
                    //
                    // This is what every chat surface does, including Juno's own
                    // web composer, and it is why the send button below carries no
                    // keyboard shortcut of its own — an accelerator on the button
                    // would fight this handler for the same key. A vertical
                    // `TextField` inserts a newline on Return by default, so the
                    // key has to be intercepted rather than merely bound.
                    .onKeyPress(.return, phases: .down) { press in
                        // Shift-Return falls through to the field's own newline.
                        if press.modifiers.contains(.shift) { return .ignored }
                        if canSend {
                            send()
                            return .handled
                        }
                        // Swallowed rather than ignored: with an empty prompt, or
                        // while a turn is still streaming, Return must not quietly
                        // grow the box instead of doing what the user asked.
                        return .handled
                    }

                    if isLongDraft {
                        attachAsFileOffer
                    }
                }

                HStack(spacing: 6) {
                    addMenu

                    Rectangle()
                        .fill(Color.junoHairline)
                        .frame(width: 1, height: 19)
                        .padding(.horizontal, 2)

                    modelControl

                    if let scale = thinkingScale, scale.isPresentable {
                        thinkingControl(scale)
                    }

                    Spacer(minLength: 8)

                    if JunoSpeechService.isSupported, !model.isGenerating {
                        dictateButton
                        Rectangle()
                            .fill(Color.junoHairline)
                            .frame(width: 1, height: 20)
                            .padding(.horizontal, 1)
                            .accessibilityHidden(true)
                    }

                    primaryAction
                }
            }
        }
        .padding(JunoSpace.snug)
        // Was a freehand 720 against the transcript's 768 — see
        // ``DesktopChatMeasure``. The composer and the transcript are one column
        // and now read one number for it, gutter included, so they stay one
        // column at every window width rather than only at the two where the old
        // pair of numbers happened to cross.
        .frame(maxWidth: DesktopChatMeasure.reading)
        // Real Liquid Glass, and nothing drawn on top of it. The previous
        // treatment stroked a hairline border over the glass, which flattened
        // the rim's light scatter — the thing that makes glass read as having
        // thickness — back into a translucent rounded rectangle. Focus adds
        // nothing here either: an accent stroke, an accent shadow and a 1.003
        // scale on an off-ladder spring shipped briefly and were removed with
        // the ornamented `junoFloatingChrome` build, whose contract names them
        // as exactly the decoration that flattens the material. Focus already
        // has honest voices — the field's own caret, and the aura warming
        // behind the greeting while the composer holds it — so the chrome
        // stays still.
        .junoFloatingChrome(cornerRadius: JunoRadius.composer)
        .padding(.horizontal, DesktopChatMeasure.gutter)
        .padding(.bottom, JunoSpace.tight)
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: importedContentTypes,
            allowsMultipleSelection: true,
            onCompletion: importFiles
        )
        .sheet(isPresented: $showingLibrary) {
            if let libraryModel, let attachmentModel {
                DesktopLibraryPicker(
                    model: libraryModel,
                    capacity: max(
                        0,
                        NativeComposerAttachmentModel.maximumAttachments
                            - attachmentModel.attachments.count
                    ),
                    attach: {
                        if let uploaded = await libraryModel.attachSelection() {
                            attachmentModel.adopt(uploaded)
                            showingLibrary = false
                        }
                    },
                    cancel: {
                        libraryModel.selection = []
                        showingLibrary = false
                    }
                )
            }
        }
        .onAppear {
            // The project is settled *before* the model is, and the order is
            // load-bearing: a project's preferred model is part of the answer
            // `configureSelection()` gives, so resolving first would show the
            // account default for a frame and then jump to the assistant's model
            // in front of the reader.
            if let fixedProjectID {
                selectedProjectID = fixedProjectID
            }
            consumeDraftProject()
            configureSelection()
            consumeDraftPrompt()
            focused = true
            // Published here as well as from the `onChange` pair below, because a
            // composer that opens on the model it already had changes nothing —
            // and the bloom would sit on the accent until the reader happened to
            // pick something.
            publishAura()
        }
        // Every transient presentation is torn down with the composer.
        //
        // A `.popover` whose anchor leaves the hierarchy while still presented
        // makes SwiftUI's `PopoverBridge` call `showRelativeToRect:` against a
        // window that is already being ordered — `addChildWindow:` →
        // `_doOrderWindow:` → an uncaught `NSRemoteView` exception and SIGTRAP.
        // Opening the model selector and then clicking a different sidebar row
        // reproduces it: the click destroys the composer that owns the anchor.
        .onDisappear {
            showingModelSelector = false
            showingThinking = false
            showingLibrary = false
            showingFileImporter = false
        }
        .animation(JunoMotion.fast, value: showsCollapsedDraft)
        // Once the draft is back under the inline ceiling, forget that it was
        // ever expanded — otherwise the *next* huge paste would land straight in
        // the text field, which is the state this card exists to avoid.
        .onChange(of: prompt) { _, text in
            if !NativePromptLimits.isHugeDraft(text) { draftExpanded = false }
        }
        // A refusal that named the call is meaningless once the call is over.
        .onChange(of: voiceActive) { _, active in
            if !active { voiceTurnError = nil }
        }
        .onChange(of: model.modelCatalog) { _, _ in configureSelection() }
        .onChange(of: model.selectedConversationID) { _, selected in
            // A pick is about the conversation it was made in. Moving to another
            // one retires it, so the next conversation's project preference is
            // free to apply — otherwise one deliberate choice would follow the
            // reader around the sidebar for the rest of the session.
            modelChosenByReader = false
            // A note about the last send describes a message in the conversation
            // it was sent to. Carried into another one it is a claim about
            // nothing the reader is looking at.
            groundingNote = nil
            // Project first, then selection: `configureSelection()` reads the
            // project's preferred model, and running it against the *previous*
            // conversation's project would resolve one assistant's model into
            // another assistant's chat. Same reason as `onAppear` above.
            if let fixedProjectID {
                selectedProjectID = fixedProjectID
            } else {
                selectedProjectID = selected == nil
                    ? nil : model.selectedConversation?.projectId
            }
            configureSelection()
            if selected == nil {
                selectedConnectors = []
                canvasEnabled = false
            }
        }
        // Covers both directions the preference can move: the reader filing the
        // draft under a different project from the "+" menu, and the preference
        // itself being edited on the Projects page while this composer is open.
        .onChange(of: projectPreferredModelID) { _, _ in configureSelection() }
        // Disarming the switch retires the note with it: "nothing matched" beside
        // a switch that is now off reads as the state rather than as history.
        .onChange(of: documentContext) { _, _ in groundingNote = nil }
        .onChange(of: draftProjectID) { _, _ in
            consumeDraftProject()
        }
        .onChange(of: draftPrompt) { _, _ in
            consumeDraftPrompt()
        }
        .onChange(of: selectedModelID) { _, _ in
            configureThinking()
            publishAura()
        }
        .onChange(of: thinkingStopID) { _, _ in publishAura() }
        .onChange(of: focused) { _, hasFocus in aura?.focused = hasFocus }
    }

    /// Hands the bloom its two derived inputs.
    ///
    /// `hasEffortControl` is the test of whether a slider is *actually on screen*
    /// — the composer's own gate a few lines up — and deliberately not "does this
    /// model reason". Eleven shipped models declare reasoning and expose no
    /// tiers, and Auto resolves the full ladder while showing no slider at all;
    /// either would leave the page burning at its dimmest with nothing on screen
    /// to explain why.
    private func publishAura() {
        guard let aura else { return }
        aura.providerID = selectedModel?.providerID ?? ""
        aura.think = JunoProviderGlow.auraThink(
            effort: reasoningEffort?.rawValue,
            hasEffortControl: thinkingScale?.isPresentable ?? false
        )
    }

    private func consumeDraftProject() {
        guard model.selectedConversationID == nil, let projectID = draftProjectID else {
            return
        }
        selectedProjectID = projectID
        draftProjectID = nil
    }

    private func consumeDraftPrompt() {
        guard prompt.isEmpty,
            let seededPrompt = draftPrompt
        else { return }
        prompt = seededPrompt
        draftPrompt = nil
        focused = true
    }

    /// The quiet offer under a long draft: "That's a long one — send it as a
    /// file to keep the chat tidy?" One line and one button, exactly as the web
    /// puts it, and it never touches the draft unless the button is used.
    private var attachAsFileOffer: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("That's a long one — send it as a file to keep the chat tidy?")
                .font(.caption)
                .junoSecondaryInk()
            Spacer(minLength: JunoSpace.tight)
            Button(action: attachDraftAsFile) {
                JunoIconLabel("Attach as file", systemImage: "doc.badge.arrow.up")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityIdentifier("juno.desktop.chat.attach-draft")
        }
        .padding(.horizontal, 8)
        .transition(.opacity)
    }

    /// What a very large paste looks like in the composer: a card standing for
    /// the draft, not the draft itself.
    ///
    /// The text is untouched — it is still in `prompt`, and Send still sends all
    /// of it. What has gone is the live `TextField`, which was re-measuring the
    /// whole passage on every keystroke. "Edit" puts it back for a reader who
    /// really does want to work inside a 40,000-character prompt.
    private var collapsedDraftCard: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Long message ready to send")
                        .font(.callout.weight(.medium))
                    Text("\(prompt.count.formatted(.number)) characters · sent in full · Return to send")
                        .font(.caption.monospaced())
                        .junoSecondaryInk()
                    Text(prompt.prefix(240) + (prompt.count > 240 ? "…" : ""))
                        .font(.caption)
                        .junoSecondaryInk()
                        .lineLimit(3)
                        .padding(.top, 2)
                }
                Spacer(minLength: 0)
                Button {
                    prompt = ""
                    draftExpanded = false
                } label: {
                    JunoIconView(systemImage: "xmark")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .help("Clear this message")
                .accessibilityLabel("Clear this message")
            }

            HStack(spacing: JunoSpace.snug) {
                Button {
                    draftExpanded = true
                    focused = true
                } label: {
                    JunoIconLabel("Edit", systemImage: "pencil")
                }
                .accessibilityIdentifier("juno.desktop.chat.expand-draft")

                if canAttachDraft {
                    Button(action: attachDraftAsFile) {
                        JunoIconLabel("Attach as file", systemImage: "doc.badge.arrow.up")
                    }
                    .accessibilityIdentifier("juno.desktop.chat.attach-draft")
                }
                Spacer(minLength: 0)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(Color.junoMuted.opacity(0.6))
        )
        // Return sends from here too: the card *is* the draft, and a reader who
        // has just pasted should not have to find the button with the mouse.
        .onKeyPress(.return, phases: .down) { press in
            if press.modifiers.contains(.shift) { return .ignored }
            if canSend { send() }
            return .handled
        }
        .accessibilityIdentifier("juno.desktop.chat.collapsed-draft")
    }

    /// Whether the closed "+" is holding anything — what lights its badge.
    ///
    /// All four of the states the menu can leave behind, where the badge used to
    /// answer for two of them. A chat armed with web search or with canvas looked
    /// from the outside exactly like a chat armed with nothing.
    private var hasArmedTools: Bool {
        deepResearch || webSearch || canvasEnabled || !selectedConnectors.isEmpty
            || documentGroundingArmed
    }

    /// The composer's native action menu.
    ///
    /// This is deliberately a real SwiftUI `Menu`. The previous implementation
    /// recreated a dropdown inside a custom popover: it had to own hover fills,
    /// nested drawers, checkmarks, disabled explanations, focus, dismissal and
    /// glass independently from macOS. That is exactly why it looked foreign.
    /// Native menu groups and submenus give the same information architecture as
    /// the website while letting the platform own Liquid Glass and interaction.
    private var addMenu: some View {
        Menu {
            Button {
                showingFileImporter = true
            } label: {
                JunoIconLabel(
                    verbatim: voiceActive ? "Attach images…" : "Attach files…",
                    systemImage: "paperclip"
                )
            }
            .disabled(voiceActive ? !canAttachInVoice : !(attachmentModel?.hasCapacity ?? false))

            Button {
                showingLibrary = true
            } label: {
                JunoIconLabel("Choose from Library…", systemImage: "books.vertical")
            }
            .disabled(voiceActive || !(attachmentModel?.hasCapacity ?? false))

            if fixedProjectID == nil, let projectModel {
                Menu {
                    Button {
                        selectedProjectID = nil
                    } label: {
                        JunoIconLabel(
                            "No project",
                            systemImage: selectedProjectID == nil ? "checkmark" : "folder"
                        )
                    }
                    ForEach(projectModel.projects) { project in
                        Button {
                            selectedProjectID = project.id
                        } label: {
                            Label(
                                project.name,
                                systemImage: selectedProjectID == project.id ? "checkmark" : "folder"
                            )
                        }
                    }
                } label: {
                    JunoIconLabel(
                        verbatim: selectedProjectName ?? "Add to project",
                        systemImage: "folder"
                    )
                }
                .disabled(model.selectedConversationID != nil)
            }

            Divider()

            Toggle(isOn: $deepResearch) {
                JunoIconLabel("Deep research", systemImage: "telescope")
            }

            Toggle(isOn: $webSearch) {
                JunoIconLabel("Web search", systemImage: "globe")
            }
            .disabled(selectedModel?.supportsWebSearch != true)

            Toggle(isOn: $canvasEnabled) {
                JunoIconLabel("Canvas & artifacts", systemImage: "rectangle.3.group")
            }

            if documentIndex != nil {
                Toggle(isOn: $documentContext) {
                    Label(
                        indexedDocumentCount == 0 ? "My documents — none on this Mac" : "My documents",
                        systemImage: "doc.text.magnifyingglass"
                    )
                }
                .disabled(voiceActive || indexedDocumentCount == 0)
            }

            if connectorModel != nil {
                Divider()
                Menu {
                    if connectedConnectors.isEmpty {
                        Text("No connected apps")
                    } else {
                        ForEach(connectedConnectors) { connector in
                            Toggle(
                                connector.label,
                                isOn: Binding(
                                    get: { selectedConnectors.contains(connector.id) },
                                    set: { _ in toggleConnector(connector.id) }
                                )
                            )
                            .disabled(
                                !selectedConnectors.contains(connector.id)
                                    && selectedConnectors.count >= 5
                            )
                        }
                    }
                } label: {
                    Label(
                        selectedConnectors.isEmpty
                            ? "Connectors" : "Connectors (\(selectedConnectors.count))",
                        systemImage: "powerplug"
                    )
                }
            }
        } label: {
            DesktopAddMenuMark(isArmed: hasArmedTools)
            .contentShape(.circle)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Add files, tools, projects, or connected apps")
        .accessibilityLabel("Add")
        .accessibilityValue(hasArmedTools ? "Tools armed" : "")
        .accessibilityIdentifier("juno.desktop.chat.add")
    }

    private var modelControl: some View {
        Button {
            showingModelSelector = true
        } label: {
            HStack(spacing: 6) {
                JunoProviderMark(
                    providerID: selectedModel?.providerID ?? "juno",
                    providerName: selectedModel?.providerName ?? "Juno",
                    size: 14
                )
                Text(selectedModel?.displayName ?? "Choose model")
                    .font(.subheadline.weight(.medium))
                    .junoInk()
                    .lineLimit(1)
                    .truncationMode(.tail)
                JunoIconView(systemImage: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .junoSecondaryInk()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .contentShape(.capsule)
        }
        .buttonStyle(.borderless)
        .fixedSize(horizontal: true, vertical: false)
        .help("Choose model")
        .accessibilityLabel("Model")
        .accessibilityValue(selectedModel?.displayName ?? "Not selected")
        .accessibilityIdentifier("juno.desktop.chat-model")
        .popover(
            isPresented: $showingModelSelector,
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .bottom
        ) {
            JunoModelSelector(
                models: model.modelCatalog.map(\.junoDescriptor),
                selectedModelID: selectedModelID,
                select: { descriptor in
                    selectedModelID = descriptor.id
                    // The only place this is set. It is what makes rung 1 of
                    // ``routedModelID(for:)`` distinguishable from the same id
                    // arriving out of `configureSelection()`, and it is why a
                    // project's preferred model stops reasserting itself after
                    // somebody has said otherwise.
                    modelChosenByReader = true
                    showingModelSelector = false
                }
            )
        }
        .desktopPreviewOverlays(popover: { showingModelSelector = true })
    }

    private var thinkingSymbol: some View {
        JunoIconView(systemImage: "gauge.with.dots.needle.33percent")
            .imageScale(.small)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private func thinkingControl(_ scale: NativeThinkingScale) -> some View {
        if scale.isAutomatic {
            // Nothing, which is what the web does: `{!isAuto && effortOptions.length
            // > 0 && …}` in composer.tsx, over the comment "Auto picks thinking
            // server-side — no manual slider."
            //
            // The Mac used to draw an inert chip here instead — a 34pt-tall row
            // reading "Auto", the same height as the model button, immediately
            // beside a model button that ALSO read "Auto". Two adjacent chips,
            // one word, two meanings (which model / how much thinking), and only
            // one of them responded to a click. A control that looks exactly like
            // its neighbour and does nothing is worse than an absent one: the
            // reader does not learn it is decorative until they have already
            // pressed it.
            //
            // No information is lost. The model selector's own detail panel
            // states "Thinking — chosen automatically for each message", which is
            // where a reader who wants that fact goes looking.
            EmptyView()
        } else {
            Button {
                showingThinking = true
            } label: {
                HStack(spacing: 5) {
                    thinkingSymbol
                    Text(currentThinkingLabel(in: scale))
                        .lineLimit(1)
                    JunoIconView(systemImage: "chevron.up")
                        .font(.caption2.weight(.semibold))
                        .junoSecondaryInk()
                }
                .font(.subheadline.weight(.medium))
                .junoInk()
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .contentShape(.capsule)
            }
            .buttonStyle(.borderless)
            .fixedSize()
            .help("How much thinking the model does before answering")
            .accessibilityLabel("Thinking")
            .accessibilityValue(currentThinkingLabel(in: scale))
            .accessibilityIdentifier("juno.desktop.chat-thinking")
            .popover(
                isPresented: $showingThinking,
                attachmentAnchor: .rect(.bounds),
                arrowEdge: .bottom
            ) {
                let popover = JunoThinkingPopover(
                    scale: scale,
                    effort: thinkingEffortBinding(for: scale),
                    width: 268,
                    fastMode: $fastMode,
                    proMode: $proMode
                )
                popover.frame(
                    width: 268,
                    height: JunoThinkingMetrics.captionedHeight
                )
            }
        }
    }

    private var dictateButton: some View {
        Button {
            focused = false
            withAnimation(JunoMotion.fast) {
                dictating = true
            }
        } label: {
            JunoIconView(systemImage: "mic.fill")
                .font(.callout.weight(.medium))
                .frame(width: 36, height: 36)
                // On-accent over the armed tint, primary ink otherwise — the
                // ramp's own rungs. `Color.primary.opacity(0.85)` was a fourth,
                // diluted ink the three-rung ramp deliberately does not have.
                .foregroundStyle(dictating ? Color.junoOnAccent : Color.junoForeground)
                // Hover on the Mac is a fill, the same `junoRowHover` wash the
                // model and thinking chips beside this button answer with. The
                // scale-and-shadow treatment this replaces was the web's hover
                // idiom, and it hand-painted a black shadow onto glass — the
                // decoration the floating-chrome contract exists to forbid.
                // Drawn inside the label so it sits between the material and
                // the glyph, and skipped while dictating, when the full-alpha
                // accent tint already owns the button's whole ground.
                .background(
                    Circle().fill(
                        isHoveringDictate && !dictating
                            ? Color.junoRowHover : Color.clear
                    )
                )
                .contentShape(.circle)
        }
        .junoGlass(
            in: Circle(),
            tint: dictating ? Color.junoAccent : nil,
            interactive: true
        )
        // A fill crossfading in place is tint-tier motion: it keeps `fast`'s
        // character under Reduce Motion, exactly as its two sibling chips do.
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
            value: isHoveringDictate
        )
        .onHover { isHoveringDictate = $0 }
        .buttonStyle(.junoPress)
        .help("Dictate")
        .accessibilityLabel("Dictate")
        .accessibilityIdentifier("juno.desktop.chat-dictate")
    }

    @ViewBuilder
    /// The composer's single morphing action: stop while generating, voice on an
    /// empty prompt, send otherwise.
    ///
    /// Two fixes over the flat version this replaces. It is real interactive
    /// Liquid Glass tinted with the accent, so it belongs to the composer's glass
    /// container instead of sitting on it as an opaque tile. And the glyph uses
    /// ``Color/junoOnAccent`` rather than a hardcoded white: the accent is an
    /// account setting, and white on the amber and sage accents fails contrast —
    /// which is the entire reason the design system carries an on-accent token.
    ///
    /// Every variant states a `Circle` content shape. SwiftUI hit-tests a button
    /// by what its label *draws*, not by the frame around it, and all three
    /// glyphs are small ink in a 36pt frame — the voice bars are five 2pt
    /// capsules, roughly 110pt² inside 1296pt², so nine tenths of the circle the
    /// reader aims at was dead. `Circle` rather than `.rect` because
    /// ``View/accentGlassAction(active:)`` draws a circle: claiming the corners
    /// would make the button react where it visibly is not.
    private var primaryAction: some View {
        Group {
            if model.isGenerating {
                Button {
                    model.stopGeneration()
                } label: {
                    JunoIconView(systemImage: "stop.fill")
                        .font(.caption.weight(.bold))
                        .frame(width: 36, height: 36)
                        .foregroundStyle(Color.junoOnAccent)
                        .contentShape(.circle)
                }
                .accentGlassAction(active: true)
                .help("Stop generating")
                .accessibilityLabel("Stop generating")
            } else if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                attachmentModel?.attachments.isEmpty ?? true
            {
                // Voice takes the slot exactly when Send has nothing to do. A
                // staged attachment is something to send, so it keeps Send.
                Button {
                    openVoiceMode(selectedModelID)
                } label: {
                    DesktopVoiceGlyph()
                        .frame(width: 36, height: 36)
                        .foregroundStyle(Color.junoOnAccent)
                        .contentShape(.circle)
                }
                .accentGlassAction(active: !selectedModelID.isEmpty)
                .disabled(selectedModelID.isEmpty)
                .help("Start a voice conversation")
                .accessibilityIdentifier("Start voice conversation")
                .accessibilityLabel("Start voice conversation")
            } else {
                Button {
                    send()
                } label: {
                    JunoIconView(systemImage: "arrow.up")
                        .font(.callout.weight(.bold))
                        .frame(width: 36, height: 36)
                        .foregroundStyle(
                            canSend ? Color.junoOnAccent : Color.junoMutedForeground
                        )
                        .contentShape(.circle)
                }
                .accentGlassAction(active: canSend)
                .disabled(!canSend)
                .help("Send message")
                .accessibilityIdentifier("Send message")
                .accessibilityLabel("Send message")
            }
        }
    }

    private func thinkingEffortBinding(
        for scale: NativeThinkingScale
    ) -> Binding<NativeReasoningEffort?> {
        Binding(
            get: { reasoningEffort },
            set: { effort in
                thinkingStopID = scale.stops.first { $0.effort == effort }?.id
                    ?? scale.defaultStop?.id
                    ?? ""
            }
        )
    }

    private func currentThinkingLabel(in scale: NativeThinkingScale) -> String {
        scale.stops.first { $0.id == thinkingStopID }?.label ?? "Off"
    }

    private func selectionMenuButton(
        title: String,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            if selected {
                JunoIconLabel(verbatim: title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    /// The project whose preferences apply to this composer, if any. The fixed
    /// one wins because a project overview's composer cannot be filed anywhere
    /// else, whatever the "+" menu last remembered.
    private var activeProjectID: String? {
        fixedProjectID ?? selectedProjectID
    }

    /// The project's preferred model, when it applies.
    ///
    /// Nil is the common answer and means "this changes nothing" — no project, no
    /// preference saved, a preference naming a model this account can no longer
    /// select, or a reader who has made a pick of their own. The rule itself is
    /// ``ProjectPreferredModel/resolve(preferredModelID:readerChoseExplicitly:selectableModelIDs:)``,
    /// which lives in JunoChatKit so the phone cannot grow a second, different
    /// version of the same precedence.
    private var projectPreferredModelID: String? {
        guard let activeProjectID, let workspaceModel else { return nil }
        return ProjectPreferredModel.resolve(
            preferredModelID: workspaceModel.workspaces[activeProjectID]?.preferredModelID,
            readerChoseExplicitly: modelChosenByReader,
            selectableModelIDs: model.selectableModels.map(\.id)
        )
    }

    private func configureSelection() {
        selectedModelID = DesktopChatSelection.resolvedModelID(
            current: selectedModelID,
            conversationModel: model.selectedConversation?.model ?? "",
            selectable: model.selectableModels
        )
        // A project's preference is written into the **picker**, not only onto
        // the wire. That is what keeps the control honest: an assistant
        // configured for Sonnet shows "Sonnet" in the composer before the reader
        // presses Send, rather than showing the account default and quietly
        // answering as something else. It sits after the resolve above so it
        // outranks the conversation's own stored model, which is only a record of
        // what the last turn used — see ``routedModelID(for:)`` for the full
        // order and the reasoning.
        if let preferred = projectPreferredModelID {
            selectedModelID = preferred
        }
        configureThinking()
    }

    private func configureThinking() {
        guard let scale = thinkingScale else {
            thinkingStopID = ""
            return
        }
        if scale.stops.contains(where: { $0.id == thinkingStopID }) {
            return
        }
        thinkingStopID = scale.defaultStop?.id ?? ""
        if selectedModel?.supportsWebSearch != true {
            webSearch = false
        }
    }

    /// The model this turn will actually go to.
    ///
    /// **The precedence, highest first, and why it is this order.**
    ///
    /// 1. **An explicit pick the reader made in this composer.** Opening the
    ///    picker and choosing is a specific statement about this conversation,
    ///    made now. Nothing below may quietly overrule it — including
    ///    auto-routing, which used to. That is a deliberate change: routing is a
    ///    *standing* preference set once in Settings, and when a standing default
    ///    and a specific instruction disagree, honouring the standing one is how
    ///    a reader ends up watching a model they did not choose answer a question
    ///    they chose it for.
    /// 2. **The project's preferred model.** Also the reader's instruction, also
    ///    explicit — just made earlier, on the Projects page, about every chat in
    ///    this assistant rather than about this one. It outranks the
    ///    conversation's own stored model because that field only records what
    ///    the last turn happened to use. `configureSelection()` has already put
    ///    it in the picker, so this rung shows before it fires.
    /// 3. **Auto-routing**, when the reader has opted into it and neither of the
    ///    above has spoken. This is the one rung that is not visible in the
    ///    picker beforehand, which is why it is opt-in and off by default.
    /// 4. **Whatever the picker is showing** — the conversation's model, or the
    ///    account default. The behaviour every reader had before any of this
    ///    existed.
    ///
    /// The routed id is not written back into `selectedModelID`: the picker keeps
    /// showing what the reader chose as their default, and routing stays a
    /// per-turn decision rather than something that silently rewrites a setting.
    private func routedModelID(for content: String) -> String {
        // Rung 2 is tested first only because it is the one that needs work:
        // `projectPreferredModelID` is nil exactly when rung 1 applies, and rung
        // 1's answer is already sitting in `selectedModelID`.
        if let preferred = projectPreferredModelID { return preferred }
        if modelChosenByReader { return selectedModelID }
        guard autoRouteModel else { return selectedModelID }
        let signals = NativeComposerSignals(
            prompt: content,
            hasAttachments: !(attachmentModel?.uploadedIDs ?? []).isEmpty,
            deepResearch: deepResearch,
            webSearch: webSearch,
            connectorCount: selectedConnectors.count
        )
        return ModelTierRouter().route(
            task: NativeChatTaskClassifier.classify(signals),
            preference: .automatic,
            models: model.modelCatalog,
            // An empty catalog (offline, or a failed manifest fetch) must still
            // send to what the reader picked rather than to nothing.
            fallback: selectedModelID
        ).modelID
    }

    private func send() {
        guard canSend else { return }
        // A live call takes the turn before the chat route ever sees it. Without
        // this the draft went to `/api/chat` and came back as a written exchange
        // the spoken conversation knew nothing about — two threads, from one
        // composer, with the reader watching the wrong one.
        if let voiceCall {
            sendVoiceTurn(voiceCall)
            return
        }
        // Past the guard that can still refuse the turn, and before the work —
        // the swell answers the keystroke, not the round trip. The web sets its
        // flag in exactly the same place inside `sendFromComposer`.
        aura?.fireSendSwell()
        let content = prompt
        let modelID = routedModelID(for: content)
        let effort = reasoningEffort
        let uploadedIDs = attachmentModel?.uploadedIDs ?? []
        let research = deepResearch
        let search = webSearch
        let canvas = canvasEnabled
        // Snapshotted with the others: the send is async, and reading the
        // @AppStorage values inside the task would pick up a toggle the reader
        // flipped after hitting send.
        let fast = fastMode
        let pro = proMode
        let connectors = Array(selectedConnectors.prefix(5))
        let projectID = selectedProjectID
        // Whatever the last send said about documents is now history about a
        // message further up the transcript. Cleared here rather than on arrival
        // so nothing about the previous turn is on screen while this one runs.
        groundingNote = nil
        let documentCount = indexedDocumentCount
        // Snapshotted for the same reason `fastMode` is: the send is async, and
        // a switch flipped while the turn is in flight must not change what the
        // composer then says about a turn that was already composed.
        let wasGroundingArmed = documentGroundingArmed

        Task {
            // Grounding happens before anything is created or appended, because
            // the turn's text has to be final by then: `sendMessage` sends the
            // string it is given and there is no second channel to add to
            // afterwards. See ``NativeDocumentGrounding`` for why the passages
            // travel inside the message rather than beside it.
            let grounding = await groundedTurn(for: content, armed: wasGroundingArmed)

            let conversationID: String?
            if fixedProjectID == nil, let selected = model.selectedConversationID {
                conversationID = selected
            } else {
                model.isDraftingNewConversation = true
                conversationID = await model.createConversationResolvingID(
                    model: modelID,
                    projectID: fixedProjectID ?? projectID
                )
            }

            guard let conversationID else { return }
            let sent = model.sendMessage(
                conversationID: conversationID,
                prompt: grounding.promptForModel,
                modelID: modelID,
                reasoningEffort: effort,
                attachmentIDs: uploadedIDs,
                deepResearch: research,
                webSearch: search,
                canvasEnabled: canvas ? true : nil,
                connectors: connectors,
                fastMode: fast,
                proMode: pro
            )
            guard sent else { return }
            prompt = ""
            draftExpanded = false
            attachmentModel?.clear()
            deepResearch = false
            canvasEnabled = false
            // Written only after the turn was accepted, and only when the switch
            // was armed: a note about documents beside a message that never left
            // is news about something that did not happen.
            if wasGroundingArmed {
                groundingNote = Self.groundingNote(
                    for: grounding,
                    documentCount: documentCount
                )
            }
            Task {
                await model.generateTitleIfNeeded(conversationID: conversationID)
            }
            didSendConversation?(conversationID)
        }
    }

    /// Retrieves this Mac's passages for one turn and folds them into its text.
    ///
    /// Returns the reader's own words untouched whenever grounding is off, there
    /// is no index, or nothing matched — ``NativeDocumentGrounding`` is the only
    /// thing that decides what a grounded turn looks like, and it refuses to
    /// build a block over an empty result.
    ///
    /// - Parameter armed: the snapshot taken in ``send()``, not the live switch.
    ///   Reading the live one here would let a toggle flipped mid-flight decide
    ///   one thing while the note printed afterwards claims the other — the
    ///   composer would report "nothing matched" for a corpus it never searched.
    private func groundedTurn(for content: String, armed: Bool) async -> NativeDocumentGrounding {
        guard armed, let documentIndex else {
            return NativeDocumentGrounding(ungrounded: content)
        }
        // Asking for exactly what can be used, rather than the index's default
        // eight: five of them would be ranked, formatted and thrown away.
        let passages = await documentIndex.passages(
            matching: content,
            limit: NativeDocumentGrounding.maximumPassages
        )
        return NativeDocumentGrounding.ground(prompt: content, in: passages)
    }

    /// What the composer says about a send that has just happened.
    ///
    /// The two outcomes are worded so they cannot be confused, because the
    /// difference matters: one means the reader's files were read into a message
    /// that has now left the Mac, and the other means they were searched and had
    /// nothing to say. Silence would leave both looking identical.
    private static func groundingNote(
        for grounding: NativeDocumentGrounding,
        documentCount: Int
    ) -> String {
        guard grounding.isGrounded else {
            return documentCount == 1
                ? "Nothing in your 1 indexed document matched that question, so none of it was attached."
                : "Nothing in your \(documentCount) indexed documents matched that question, so none of it was attached."
        }
        let excerpts = grounding.cited.count == 1 ? "1 excerpt" : "\(grounding.cited.count) excerpts"
        // The file names, not a count of them. "2 documents" is a number somebody
        // has to go and check; "Q3 Report.pdf, Contract.docx" is the answer.
        // "in your message", not "in full": a long passage is cut to length
        // before it is quoted, and this line must not claim otherwise.
        return "Sent \(excerpts) from \(grounding.citedSourceNames.joined(separator: ", ")) — they are in your message above."
    }

    /// Sends the draft — text and up to four images — through the live session
    /// rather than through the chat route.
    ///
    /// This is what makes keeping the composer on screen during a call worth
    /// anything. The turn goes over the socket the conversation is already on, so
    /// the model answers it out loud in context; the same draft through
    /// `/api/chat` produced a second, silent conversation instead.
    ///
    /// The encoding, the four-image ceiling, the relay's byte bound and the
    /// re-check that the socket has not been replaced underneath a slow encode
    /// all live in ``JunoRealtimeVoiceController/sendTurn(text:images:)``, which
    /// the phone calls too. Nothing here duplicates them — this only decides
    /// whether there is a turn worth handing over, and says why when there is not.
    private func sendVoiceTurn(_ call: DesktopVoiceColumn) {
        guard !isSendingVoiceTurn else { return }
        voiceTurnError = nil
        let controller = call.controller
        guard controller.phase == .live else {
            // A finished call and a slow one need different sentences: the way out
            // of the first is the dock's restart button, and the way out of the
            // second is waiting.
            voiceTurnError = switch controller.phase {
            case .ended, .error:
                "This voice session has ended. Restart it, or hang up to keep typing."
            default:
                "Voice is still connecting. Try again in a moment."
            }
            return
        }

        let staged = attachmentModel?.attachments ?? []
        guard staged.count <= Self.maximumVoiceImages else {
            voiceTurnError = "Voice mode accepts up to 4 images in one turn."
            return
        }
        // `previewData` is the payload the upload model already holds for an
        // image, which is why this needs no second read and no network. An
        // attachment without one is either a document or a library clone whose
        // bytes only ever existed on the server — neither can be shown to a model
        // over this socket, so the turn is refused rather than quietly sent
        // without them.
        //
        // The uploaded id rides along so the saved transcript can claim the same
        // attachment the model was shown; it is nil until the upload lands, and a
        // turn sent then still reaches the model — it is only the saved copy that
        // loses the picture.
        let images = staged.compactMap { attachment in
            attachment.previewData.map {
                JunoVoiceTurnImage(jpeg: $0, attachmentID: attachment.uploadedID)
            }
        }
        guard images.count == staged.count else {
            voiceTurnError =
                "Voice mode can send images only — remove the other attachments first."
            return
        }
        guard images.isEmpty || voiceCanSeeImages else {
            voiceTurnError = Self.noVisionMessage
            return
        }

        aura?.fireSendSwell()
        let text = prompt
        isSendingVoiceTurn = true
        Task {
            let accepted = await controller.sendTurn(text: text, images: images)
            isSendingVoiceTurn = false
            guard accepted else {
                // The controller re-reads the provider's capabilities after the
                // encode, so a turn with images can be refused there even though
                // it passed the check above — a provider switch mid-encode is
                // exactly that case.
                voiceTurnError = images.isEmpty
                    ? "Voice could not send that turn."
                    : Self.noVisionMessage
                return
            }
            prompt = ""
            draftExpanded = false
            attachmentModel?.clear()
        }
    }

    /// The web's own wording for a provider with no eyes, so both clients name
    /// the same three alternatives.
    private static let noVisionMessage =
        "This voice model can’t see images. Switch to OpenAI, Gemini or Qwen."

    private var connectedConnectors: [NativeConnector] {
        (connectorModel?.linked ?? []).filter(\.connected)
    }

    private var selectedProjectName: String? {
        guard let projectID = fixedProjectID ?? selectedProjectID else { return nil }
        return projectModel?.projects.first { $0.id == projectID }?.name
    }

    private func toggleConnector(_ id: String) {
        if selectedConnectors.contains(id) {
            selectedConnectors.remove(id)
        } else if selectedConnectors.count < 5 {
            selectedConnectors.insert(id)
        }
    }

    private func appendDictated(_ transcript: String) {
        let dictated = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !dictated.isEmpty else { return }
        let current = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        prompt = current.isEmpty ? dictated : "\(current) \(dictated)"
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            importError = error.localizedDescription
        case .success(let urls):
            importError = nil
            // A call's ceiling is the relay's four, not the message route's ten.
            let ceiling = voiceActive
                ? Self.maximumVoiceImages
                : NativeComposerAttachmentModel.maximumAttachments
            for url in urls.prefix(ceiling) {
                let granted = url.startAccessingSecurityScopedResource()
                defer {
                    if granted { url.stopAccessingSecurityScopedResource() }
                }
                do {
                    let values = try url.resourceValues(forKeys: [.contentTypeKey])
                    let contentType = values.contentType
                    let data = try Data(contentsOf: url)
                    attachmentModel?.add(
                        data: data,
                        fileName: url.lastPathComponent,
                        mimeType: contentType?.preferredMIMEType
                            ?? "application/octet-stream",
                        conversationID: model.selectedConversationID,
                        isImage: contentType?.conforms(to: .image) == true
                    )
                } catch {
                    importError = "Could not attach \(url.lastPathComponent): \(error.localizedDescription)"
                }
            }
        }
    }
}

private struct DesktopVoiceGlyph: View {
    private let heights: [CGFloat] = [7, 13, 18, 11, 6]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(heights.enumerated()), id: \.offset) { _, height in
                // `.foreground`, not `Color.white`. `primaryAction` states
                // `.foregroundStyle(Color.junoOnAccent)` on this glyph and its two
                // siblings are `Image`s that honour it — but a `Shape.fill` with an
                // absolute colour silently overrode the inherited style, so the one
                // variant of the button that is not an SF Symbol was the one that
                // ignored the on-accent token the doc comment above `primaryAction`
                // promises. That matters because the accent is an account setting:
                // white bars on the amber and sage accents are the exact contrast
                // failure the token exists to prevent.
                Capsule()
                    .fill(.foreground)
                    .frame(width: 2, height: height)
            }
        }
        .accessibilityHidden(true)
    }
}

/// **Attach from Library** — a grid of the files themselves.
///
/// It used to be a `List` of rows: an SF Symbol, the filename, the size. That
/// asks the reader to recognise a screenshot by its name, which nobody can do.
/// The card, its fallback and its press behaviour are the shared
/// ``NativeFilePreviewTile`` — the same one the Library screen and the phone's
/// picker draw, so all three cannot drift into three designs again.
struct DesktopLibraryPicker: View {
    @Bindable var model: NativeLibraryModel
    let capacity: Int
    let attach: () async -> Void
    let cancel: () -> Void

    @State private var previews = NativeFilePreviewLoader()

    private let columns = [GridItem(.adaptive(minimum: 132, maximum: 190), spacing: 14)]

    private func card(_ item: NativeLibraryItem) -> some View {
        let file = NativeFilePreviewRequest(item)
        let selected = model.selection.contains(item.id)
        // Unselected cards go quiet at the ceiling rather than vanishing, so the
        // limit reads as a limit instead of as a grid that stopped responding.
        let blocked = !selected && model.selection.count >= capacity
        return Button {
            model.toggle(item.id, limit: capacity)
        } label: {
            NativeFilePreviewTile(
                file: file,
                state: previews.state(for: item.id),
                cornerRadius: JunoRadius.well
            )
            .overlay {
                // A stroke over the picture, never a wash across it: a coral
                // tint over a photograph changes the photograph, which is the
                // one thing this grid exists to show.
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(Color.junoAccent, lineWidth: 2)
                    .opacity(selected ? 1 : 0)
            }
            .overlay(alignment: .topTrailing) {
                JunoIconView(systemImage: selected ? "checkmark.circle.fill" : "circle")
                    .junoFont(size: 16, relativeTo: .body)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(
                        selected ? Color.junoOnAccent : Color.white,
                        selected ? Color.junoAccent : Color.black.opacity(0.35)
                    )
                    .padding(8)
                    .shadow(color: .black.opacity(selected ? 0 : 0.25), radius: 2)
            }
        }
        .buttonStyle(NativeFilePreviewPressStyle())
        .disabled(blocked)
        .opacity(blocked ? 0.45 : 1)
        .help(item.fileName)
        .accessibilityLabel("\(item.fileName), \(file.sizeLabel)")
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .task(id: item.id) {
            await previews.load(file) { await model.accessFile(id: item.id) }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Attach from Library")
                        .font(.title2.weight(.semibold))
                    Text("Choose files already shared with Juno.")
                        .font(.callout)
                        .junoSecondaryInk()
                }
                Spacer()
                // The glass-knob switcher, not `Picker(.segmented)`. This
                // header is content inside a sheet, and `NSSegmentedControl`
                // draws its pre-Tahoe slab there — hard dividers, a knob whose
                // radius does not match its track — which is exactly the weight
                // ``DesktopSegmented`` exists to replace everywhere else in the
                // app. The control sizes itself to its labels, so the fixed
                // 220pt frame the picker needed goes with it.
                DesktopSegmented(
                    options: NativeLibraryModel.Filter.allCases.map {
                        .init($0, $0.title)
                    },
                    selection: $model.filter,
                    accessibilityLabel: "Filter"
                )
            }
            .padding(18)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }

            Group {
                if model.isLoading && model.items.isEmpty {
                    ProgressView("Loading Library…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.visibleItems.isEmpty {
                    ContentUnavailableView(
                        "No matching files",
                        systemImage: "books.vertical",
                        description: Text(
                            "Files and images you share in conversations appear here."
                        )
                    )
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(model.visibleItems) { item in
                                card(item)
                            }
                        }
                        .padding(18)
                    }
                }
            }
            .frame(minHeight: 360)

            HStack {
                if let error = model.lastErrorDescription {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(Color.junoDanger)
                        .lineLimit(2)
                } else {
                    Text("\(model.selection.count) of \(capacity) selected")
                        .font(.caption)
                        .junoSecondaryInk()
                }
                Spacer()
                Button("Cancel", action: cancel)
                Button {
                    Task { await attach() }
                } label: {
                    if model.isAttaching {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Attach")
                    }
                }
                // Untinted, `.borderedProminent` fills with the system accent —
                // system blue beside the coral selection stroke this same grid
                // draws two dozen points away.
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .disabled(model.selection.isEmpty || model.isAttaching)
            }
            .padding(16)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
        }
        // A fixed size, and deliberately **no ideal size**. A sheet that reports
        // an ideal has to be re-solved whenever its presenter's frame moves, and
        // when AppKit moves that frame inside an animation SwiftUI traps in
        // `SheetBridge.sheetSize(presentationID:presenterSize:currentSize:)` —
        // the crash a real .ips from this app pinned on the old voice sheet,
        // which was the other view in this file declaring one. Nothing here
        // needs to grow, so nothing here asks to.
        .frame(width: 740, height: 560)
        // Sheet contract: the warm ground inside the content, the platter left to
        // the system. `.fitted` rather than `.form` precisely because the frame
        // above is deliberate — see the note on it.
        .junoSheetSurface(.fitted)
        .task {
            model.selection = []
            await model.refresh()
        }
    }
}

private struct DesktopAttachmentChip: View {
    let attachment: NativeComposerAttachment
    let remove: () -> Void
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 7) {
            stateIcon
            Text(attachment.fileName)
                .font(.caption)
                .lineLimit(1)
            if case .failed(_, let retryable) = attachment.state, retryable {
                Button("Retry", action: retry)
                    .buttonStyle(.plain)
                    .font(.caption.weight(.medium))
            }
            Button(action: remove) {
                JunoIconView(systemImage: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.fileName)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            Capsule(style: .continuous)
                .fill(Color.junoMuted)
        )
        .help(failureMessage ?? attachment.fileName)
    }

    @ViewBuilder
    private var stateIcon: some View {
        switch attachment.state {
        case .preparing, .uploading:
            ProgressView()
                .controlSize(.mini)
        case .uploaded:
            JunoIconView(systemImage: "checkmark.circle.fill")
                .foregroundStyle(Color.junoSuccess)
        case .failed:
            JunoIconView(systemImage: "exclamationmark.circle.fill")
                .foregroundStyle(Color.junoDanger)
        }
    }

    private var failureMessage: String? {
        guard case .failed(let message, _) = attachment.state else { return nil }
        return message
    }
}

private extension NativeConversationBucket {
    var desktopTitle: String {
        switch self {
        case .pinned: "Pinned"
        case .today: "Today"
        case .yesterday: "Yesterday"
        case .previous7Days: "Previous 7 days"
        case .previous30Days: "Previous 30 days"
        case .older: "Older"
        // Unreachable on the desktop: `DesktopChatSidebar.groups` drops the
        // archive bucket. The case stays because the bucket is shared with the
        // phone app and the switch has to be exhaustive.
        case .archived: "Archived"
        }
    }
}

// MARK: - The composer's "+" menu

/// What the "+" adds to a message, and the tools it arms.
///
/// **A hand-drawn popover rather than a `Menu`, and that is AppKit's decision.**
/// A SwiftUI `Menu` on this OS renders its rows title-only — measured with a Juno
/// mark, with an SF Symbol, and with `.labelStyle(.titleAndIcon)` forced on, all
/// three produce plain text. The phone can use a real `Menu` and does
/// (`JunoMobileComposerActions`); the Mac cannot draw a marked, stateful row
/// inside one, so it draws its own.
///
/// **Drawing our own is not licence to invent one.** It is a menu, so it is
/// shaped like a menu: single-line rows, rules between groups, and no captions.
/// Two earlier passes each drifted the other way. The first spent three `Toggle`s
/// on the tools, and at `.controlSize(.mini)` in the dark a switch track is the
/// highest-contrast object on the surface — the eye read three switches before
/// any of the six labels. The second replaced them with uppercase monospaced
/// group headings and a line of explanatory text under every tool, which is a
/// settings pane wearing a menu's anchor: "Real-time search results" under "Web
/// search" tells a reader nothing they did not get from the two words above it,
/// and it cost the row twice its height to say so.
///
/// **The ellipsis is what separates an action from a toggle**, which is the job
/// the headings had been hired for. It is the platform's own signal and it costs
/// no line: `Attach files…` opens something, `Deep research` does not — it is a
/// state, and it carries a tick when it is on, exactly as a checked `NSMenuItem`
/// does. Nothing here has to be captioned to be understood.
///
/// The marks are the website's own — Files is `FileUp`, Deep research is
/// `Telescope`, Connectors is `Plug` — so the three clients name one thing with
/// one glyph.
private struct JunoAddMenuContent: View {
    let voiceActive: Bool
    let voiceCanSeeImages: Bool
    let canAttachInVoice: Bool
    let hasCapacity: Bool
    let showFileImporter: () -> Void
    let showLibrary: () -> Void
    let fixedProjectID: String?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    @Binding var selectedProjectID: String?
    let isConversationStarted: Bool
    let selectedProjectName: String?
    @Binding var deepResearch: Bool
    @Binding var webSearch: Bool
    let supportsWebSearch: Bool
    @Binding var canvasEnabled: Bool
    @Binding var documentContext: Bool
    /// How many documents this Mac has indexed, or **nil when there is no index
    /// at all** — a composition root that could not open the local store.
    ///
    /// Absent is not zero, and the row treats them differently: nil hides it,
    /// because a switch for a feature this build cannot perform is a switch that
    /// does nothing, while `0` shows it disabled with the reason beside it, which
    /// is how somebody learns the Library is where documents come from.
    let indexedDocumentCount: Int?
    let connectorModel: NativeConnectorModel?
    let connectedConnectors: [NativeConnector]
    @Binding var selectedConnectors: Set<String>
    let toggleConnector: (String) -> Void
    let close: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Which drawer is open, if either. One at a time, as before.
    @State private var openDrawer: Drawer?

    private enum Drawer { case projects, connectors }

    /// The most connected apps one message may act through.
    private static let connectorLimit = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            addRows
            rule
            toolRows
            if connectorModel != nil {
                rule
                connectorRows
            }
        }
        .padding(JunoSpace.tight)
        .frame(width: 238)
        // The frame is fixed, so type needs a ceiling — the bargain
        // `JunoModelSelector` strikes, for the same reason. Everything inside
        // scales up to the clamp, which is what makes it a ceiling rather than a
        // fiction: every label here is a `junoFont`, none a fixed `.system`.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        // Escape closes the drawer before it closes the menu. Left to the system
        // one press dismissed the whole popover from inside a submenu, which is
        // not how a nested menu on this OS behaves.
        .onExitCommand {
            if openDrawer == nil { close() } else { setDrawer(nil) }
        }
        .accessibilityIdentifier("juno.desktop.chat.add-menu")
    }

    /// What separates the groups: a rule, at the weight the rest of the app draws
    /// one. Not a heading — a menu that has to label its own sections is a menu
    /// whose rows are not carrying their meaning.
    private var rule: some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(height: 0.5)
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.hairline + 1)
    }

    // MARK: Sources

    @ViewBuilder
    private var addRows: some View {
        JunoAddMenuRow(
            icon: .attach,
            title: voiceActive ? "Attach images…" : "Attach files…",
            note: attachNote,
            disabled: voiceActive ? !canAttachInVoice : !hasCapacity,
            identifier: "juno.desktop.chat.add.files"
        ) {
            close()
            showFileImporter()
        }

        JunoAddMenuRow(
            icon: .library,
            // The reason a row is off belongs beside it, not inside its name.
            // This title used to *become* "Choose from Library — chat only"
            // during a call: a sentence where a label should be, and long enough
            // to truncate at any width this popover could reasonably take. The
            // web spells the same thing as a note on the row — "not on this
            // model", "paid plan", "private" — and so does this.
            title: "Choose from Library…",
            note: voiceActive ? "chat only" : (hasCapacity ? nil : "full"),
            disabled: voiceActive || !hasCapacity,
            identifier: "juno.desktop.chat.add.library"
        ) {
            close()
            showLibrary()
        }

        if fixedProjectID == nil, let projectModel {
            JunoAddMenuRow(
                icon: .projects,
                title: selectedProjectName ?? "Add to project",
                note: isConversationStarted ? "already filed" : nil,
                accessory: .drawer(openDrawer == .projects),
                disabled: isConversationStarted,
                identifier: "juno.desktop.chat.add.projects"
            ) {
                setDrawer(openDrawer == .projects ? nil : .projects)
            }

            if openDrawer == .projects {
                drawer { projectRows(projectModel) }
            }
        }
    }

    /// Why the attach row is off, in the web's words rather than in its title.
    ///
    /// This is what `voiceCanSeeImages` is for. It has been a parameter of this
    /// view since the view existed and was read by nothing: `canAttachInVoice` is
    /// `voiceCanSeeImages && count < limit`, so a call that cannot see images at
    /// all and a call that is merely full produced the same dimmed row with the
    /// same silence about which one it was.
    private var attachNote: String? {
        guard voiceActive else { return hasCapacity ? nil : "full" }
        if !voiceCanSeeImages { return "no vision" }
        return canAttachInVoice ? nil : "full"
    }

    @ViewBuilder
    private func projectRows(_ projectModel: NativeProjectModel<SQLiteAccountRepository>) -> some View {
        let rows = VStack(alignment: .leading, spacing: 1) {
            JunoAddMenuRow(
                icon: .projects,
                title: "No project",
                accessory: .state(selectedProjectID == nil),
                identifier: "juno.desktop.chat.add.project.none"
            ) {
                selectedProjectID = nil
                close()
            }

            ForEach(projectModel.projects) { project in
                JunoAddMenuRow(
                    icon: .projects,
                    title: project.name,
                    accessory: .state(selectedProjectID == project.id),
                    identifier: "juno.desktop.chat.add.project.\(project.id)"
                ) {
                    selectedProjectID = project.id
                    close()
                }
            }
        }

        // A drawer that holds an account's whole project list is a drawer that
        // can make this popover taller than the window it is anchored in. Past
        // six it scrolls, so the menu's height stops being a function of how many
        // projects somebody happens to have.
        if projectModel.projects.count > 6 {
            ScrollView { rows }
                .frame(height: 156)
                .scrollIndicators(.automatic)
        } else {
            rows
        }
    }

    // MARK: Tools

    @ViewBuilder
    private var toolRows: some View {
        JunoAddMenuRow(
            icon: .research,
            title: "Deep research",
            accessory: .state(deepResearch),
            identifier: "juno.desktop.chat.add.research"
        ) {
            arm($deepResearch)
        }

        JunoAddMenuRow(
            icon: .web,
            title: "Web search",
            note: supportsWebSearch ? nil : "not on this model",
            // A flag the server would refuse is not "on", whatever the sticky
            // value behind it says. Switching to a model that cannot search used
            // to leave a lit switch sitting in a dimmed row.
            accessory: .state(webSearch && supportsWebSearch),
            disabled: !supportsWebSearch,
            identifier: "juno.desktop.chat.add.web"
        ) {
            arm($webSearch)
        }

        JunoAddMenuRow(
            icon: .artifactsTool,
            title: "Canvas & artifacts",
            accessory: .state(canvasEnabled),
            identifier: "juno.desktop.chat.add.canvas"
        ) {
            arm($canvasEnabled)
        }

        if let indexedDocumentCount {
            JunoAddMenuRow(
                icon: .files,
                // "My documents", not "Documents": the files are the reader's own
                // and they are on their own Mac, and the two words that say so
                // are the difference between a tool and a place.
                title: "My documents",
                // Why it is off, beside it rather than inside its name — the rule
                // the Library row above already follows. A spoken turn goes over
                // the realtime socket and never through the text this grounding
                // extends, so during a call the switch genuinely cannot act.
                note: voiceActive
                    ? "chat only"
                    : (indexedDocumentCount == 0 ? "none on this Mac" : "\(indexedDocumentCount)"),
                // The same rule the Web search row follows for a model that
                // cannot search: a lit switch over an empty index promises
                // something that cannot happen.
                accessory: .state(documentContext && indexedDocumentCount > 0 && !voiceActive),
                disabled: voiceActive || indexedDocumentCount == 0,
                identifier: "juno.desktop.chat.add.documents"
            ) {
                arm($documentContext)
            }
        }
    }

    /// Arms or disarms a tool, and deliberately leaves the menu open: these are
    /// the rows somebody switches two of at once.
    ///
    /// `.tint` because nothing moves — a tick fades in and the mark crosses to
    /// the accent, both on the spot. Reduce Motion asks for less movement, not
    /// for less feedback, so this rung survives the preference intact.
    private func arm(_ flag: Binding<Bool>) {
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
            flag.wrappedValue.toggle()
        }
    }

    // MARK: Apps

    @ViewBuilder
    private var connectorRows: some View {
        JunoAddMenuRow(
            // Always the connections mark. This row used to swap to the pull
            // request glyph whenever *any* connected app happened to be GitHub —
            // a group naming itself after one of its members.
            icon: .connections,
            title: "Connectors",
            note: selectedConnectors.isEmpty ? nil : "\(selectedConnectors.count)",
            accessory: .drawer(openDrawer == .connectors),
            identifier: "juno.desktop.chat.add.connectors"
        ) {
            setDrawer(openDrawer == .connectors ? nil : .connectors)
        }

        if openDrawer == .connectors {
            if connectedConnectors.isEmpty {
                // Bare, not in a drawer. A container drawn around one line of
                // grey text is a filled box the width of the menu holding
                // nothing, and in the dark it lands brighter than any row above
                // it — the eye goes to the emptiest thing on the surface.
                Text("No connected apps")
                    .junoFont(size: 11, relativeTo: .footnote)
                    .junoSecondaryInk()
                    .padding(.horizontal, JunoSpace.snug)
                    .padding(.vertical, JunoSpace.tight)
                    .padding(.leading, 26)
                    .transition(.junoInline)
            } else {
                drawer {
                    ForEach(connectedConnectors) { connector in
                        connectorRow(connector)
                    }
                }
            }
        }
    }

    private func connectorRow(_ connector: NativeConnector) -> some View {
        let on = selectedConnectors.contains(connector.id)
        let capped = !on && selectedConnectors.count >= Self.connectorLimit

        return JunoAddMenuRow(
            icon: connector.id.lowercased().contains("github") ? .pulls : .connections,
            title: connector.label,
            // The cap used to be a row that dimmed for no stated reason once the
            // fifth app went on.
            note: capped ? "max \(Self.connectorLimit)" : nil,
            accessory: .state(on),
            disabled: capped,
            identifier: "juno.desktop.chat.add.connector.\(connector.id)"
        ) {
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                toggleConnector(connector.id)
            }
        }
    }

    // MARK: Drawers

    /// The recess a drawer's rows sit in.
    ///
    /// A fill and no outline: with a hairline of its own, a chosen row inside a
    /// drawer put an accent border a few points inside a grey one — two nested
    /// rectangles saying the same thing, and only the inner one carries
    /// information.
    ///
    /// `.junoInline` rather than the `.move(edge: .top)` this used to carry. The
    /// popover is *already* animating its own frame taller to make room, and a
    /// body that slides down inside a panel that is simultaneously growing is two
    /// motions, two owners, two curves. The design system names a transition for
    /// exactly this case — "a disclosure body… no scale — it must not push the
    /// text around it sideways" — and letting the popover's growth be the only
    /// movement is what makes opening a drawer read as one gesture.
    @ViewBuilder
    private func drawer<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            content()
        }
        .padding(2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(Color.junoForeground.opacity(0.05))
        )
        .transition(.junoInline)
    }

    private func setDrawer(_ drawer: Drawer?) {
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
            openDrawer = drawer
        }
    }
}

/// What a row shows at its trailing edge — which is also what kind of row it is.
private enum JunoAddMenuAccessory: Equatable {
    /// An action. Its title carries the ellipsis; nothing trails it.
    case none
    /// A capability or a choice, on or off.
    case state(Bool)
    /// A drawer, open or closed.
    case drawer(Bool)
}

/// One row of the "+" menu: a mark, a name, optionally a short reason it is
/// unavailable, and a trailing accessory.
///
/// One type for what used to be three near-identical ones
/// (`JunoPopoverRowButton`, `JunoPopoverSubmenuHeaderRow`, `JunoPopoverToggleRow`),
/// which between them carried three copies of the hover fill, three of the
/// padding, and three slightly different ideas of what a disabled row looks like.
private struct JunoAddMenuRow: View {
    let icon: JunoIcon
    let title: String
    var note: String? = nil
    var accessory: JunoAddMenuAccessory = .none
    var disabled: Bool = false
    let identifier: String
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isHovered = false

    private var isArmed: Bool {
        if case .state(true) = accessory { return true }
        return false
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(icon, size: 15)
                    .foregroundStyle(isArmed ? Color.junoAccent : Color.junoMutedForeground)
                    .frame(width: 18)

                Text(title)
                    .junoFont(size: 13, relativeTo: .subheadline)
                    .foregroundStyle(disabled ? Color.junoMutedForeground : Color.junoForeground)
                    .lineLimit(1)

                Spacer(minLength: JunoSpace.hairline)

                if let note {
                    Text(note)
                        .junoFont(size: 10, relativeTo: .caption2)
                        .junoSecondaryInk()
                        .lineLimit(1)
                        .layoutPriority(-1)
                }

                accessoryView
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, 5)
            .background(fill)
            .contentShape(.rect)
        }
        // Not `.plain`. `.plain` on macOS gives no press feedback whatsoever, so
        // every row in this menu was silent under the pointer between the hover
        // fill and whatever the click did.
        .buttonStyle(.junoPress)
        .disabled(disabled)
        // No blanket `.opacity(0.45)`. That dimmed the *label* along with
        // everything else, dropping a row that still has to be read below the
        // contrast floor — and the palette's own note is that a token already at
        // the floor and scaled by hand is not a quieter grey, it is an illegible
        // one. A disabled row is stated in ink and in words instead.
        .onHover { isHovered = $0 }
        .help(note ?? "")
        .accessibilityLabel(Text(title))
        .accessibilityValue(Text(accessibilityValue))
        .accessibilityAddTraits(isArmed ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }

    private var fill: some View {
        RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
            .fill(fillColor)
            .animation(
                JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
                value: fillColor
            )
    }

    /// An armed row keeps answering the pointer. Letting the accent fill win
    /// outright made the rows most likely to be clicked twice the only ones with
    /// no hover state. No border on it either: at this row height an outline is a
    /// second rectangle inside a menu that already has one.
    private var fillColor: Color {
        if isArmed { return Color.junoAccent.opacity(isHovered ? 0.16 : 0.10) }
        return isHovered && !disabled ? Color.junoRowHover : .clear
    }

    @ViewBuilder
    private var accessoryView: some View {
        switch accessory {
        case .none:
            EmptyView()
        case .state(let on):
            JunoIconView(systemImage: "checkmark")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.junoAccent)
                .opacity(on ? 1 : 0)
                .animation(
                    JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
                    value: on
                )
                .frame(width: 10)
        case .drawer(let open):
            // Rotated, not swapped. `chevron.right` → `chevron.down` is a hard
            // cut dropped into the middle of a spring that is continuous either
            // side of it, and the two glyphs are not even the same width.
            JunoIconView(systemImage: "chevron.right")
                .junoFont(size: 9, relativeTo: .caption, weight: .bold)
                .junoSecondaryInk()
                .rotationEffect(.degrees(open ? 90 : 0))
                .animation(
                    JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
                    value: open
                )
                .frame(width: 10)
        }
    }

    private var accessibilityValue: String {
        switch accessory {
        case .none: ""
        case .state(let on): on ? "On" : "Off"
        case .drawer(let open): open ? "Expanded" : "Collapsed"
        }
    }
}

/// The composer's native menu trigger. The system owns its pressed, hover and
/// open states; Juno only adds a badge when one or more tools are armed.
private struct DesktopAddMenuMark: View {
    let isArmed: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        JunoIconView(systemImage: "plus")
            // Scales with Dynamic Type like the mic and send glyphs beside it,
            // whose `.callout` faces already move — a frozen 13pt here would
            // make this the one control in the bar that ignores the setting.
            .junoFont(size: 13, relativeTo: .body, weight: .semibold)
            .junoInk()
            .frame(width: 30, height: 30)
            .junoGlass(in: Circle(), interactive: true)
            .overlay(alignment: .topTrailing) { badge }
            .contentShape(.circle)
            .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: isArmed)
    }

    /// The dot used to light for deep research and connectors only, so a chat
    /// armed with web search or with canvas looked from the outside exactly like
    /// a chat armed with nothing — two of the four states this menu can leave
    /// behind were invisible once it closed.
    @ViewBuilder
    private var badge: some View {
        if isArmed {
            Circle()
                .fill(Color.junoAccent)
                .stroke(Color.junoSurface, lineWidth: 1.5)
                .frame(width: 8, height: 8)
                .offset(x: 1, y: -1)
                .transition(.junoOverlay)
        }
    }
}
