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
    /// Text the request asked the draft to open with — from ⌥Space, or the
    /// menu bar item. Nil for an ordinary New Chat.
    var unscopedChatPrompt: String? = nil
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
    /// Why the last ⇧⌘1 screenshot did not land in the composer.
    @State private var screenshotFailure: String?

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
                openSettingsModal: { showingSettingsModal = true },
                signOut: { Task { await configuration.authModel.signOut() } }
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
        .focusedSceneValue(\.junoWorkspaceActions, workspaceActions)
        .alert("Screenshot unavailable", isPresented: screenshotFailurePresented) {
            Button("OK", role: .cancel) { screenshotFailure = nil }
        } message: {
            Text(screenshotFailure ?? "Juno could not take a screenshot.")
        }
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
                Label("New chat", icon: .compose)
            }
            .help("Start a new chat (⌘N)")
            .accessibilityIdentifier("New chat")
        }

        ToolbarItem(placement: .primaryAction) {
            Button {
                destination.wrappedValue = .search
            } label: {
                Label("Search", icon: .search)
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
                    Label("Share", icon: .share)
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

    /// What the menu bar can do to this window while it is focused.
    private var workspaceActions: DesktopWorkspaceActions {
        var screenshot: (() -> Void)?
        if configuration.attachmentModel != nil {
            screenshot = { attachScreenshot() }
        }
        return DesktopWorkspaceActions(
            newItem: beginDraft,
            newChat: beginDraft,
            openSearch: { destination.wrappedValue = .search },
            switchProduct: { product = $0 },
            currentProduct: product,
            attachScreenshot: screenshot
        )
    }

    private var screenshotFailurePresented: Binding<Bool> {
        Binding(
            get: { screenshotFailure != nil },
            set: { if !$0 { screenshotFailure = nil } }
        )
    }

    /// ⇧⌘1. The system picker chooses the window or display; the frame lands
    /// in the composer as a picture attachment on the open conversation, or on
    /// the draft when there is none.
    private func attachScreenshot() {
        guard let attachmentModel = configuration.attachmentModel else { return }
        let conversationID = model.selectedConversationID
        DesktopScreenshotCapture.shared.capture(
            completion: { data in
                let stamp = Int(Date().timeIntervalSince1970)
                attachmentModel.add(
                    data: data,
                    fileName: "Screenshot \(stamp).png",
                    mimeType: "image/png",
                    conversationID: conversationID,
                    isImage: true
                )
            },
            failure: { message in screenshotFailure = message }
        )
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
        if let prompt = unscopedChatPrompt, !prompt.isEmpty {
            draftPrompt = prompt
        }
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
    /// Signs the account out from the footer's menu. Nil hides the item.
    var signOut: (() -> Void)? = nil
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
            JunoIconView(item.junoIcon, size: 16)
                .foregroundStyle(ink)
        }
        .foregroundStyle(ink)
        // A selection changing is `standard`'s documented brief; the inline
        // 0.22 it replaces was the base rung's own duration living off the
        // ladder. The lift is a colour crossfade in place — tint-tier motion,
        // which Reduce Motion leaves alone — so it is deliberately not gated
        // behind the preference.
        .animation(JunoMotion.standard, value: selected)
        .junoSidebarRowSelection(selected)
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
        .junoSidebarRowSelection(selection == .conversation(conversation.id))
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
                },
                signOut: signOut
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
    /// What Juno remembers about the reader, as a page of its own rather than
    /// a sheet three clicks into Settings. Memory is something a reader
    /// *reads* — what was kept, what is proposed — and a page in the column is
    /// where a Mac keeps things to read.
    case memory
    case usage
    case settings

    var id: Self { self }

    static let sidebarCases: [Self] = [
        .library, .artifacts, .connections, .projects, .tasks, .memory, .usage,
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
        case .memory: "Memory"
        case .usage: "Usage"
        case .settings: "Settings"
        }
    }

    /// The website's mark for this destination — `src/lib/app-icons.ts`, via
    /// the generated catalog. Design is the pen nib the web draws for it.
    var junoIcon: JunoIcon {
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
        case .design: .penTool
        case .memory: .memory
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
                    JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)
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
            openArtifact: open(artifact:),
            share: configuration.shareClient == nil ? nil : { Task { await shareConversation() } }
        )
        .safeAreaInset(edge: .bottom, spacing: 0) {
            composer
        }
        .junoVoiceField(voiceColumn)
    }

    private func open(artifact: NativeMessageContent.ArtifactReference) {
        withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
            openArtifact = DesktopChatArtifact(reference: artifact)
        }
    }

    /// The row's Share: publish and copy the link, exactly as the toolbar does.
    private func shareConversation() async {
        guard let client = configuration.shareClient,
              let conversationID = model.selectedConversationID,
              case .signedIn(let signedIn) = configuration.authModel.phase
        else { return }
        do {
            let share = try await client.share(conversationID: conversationID, for: signedIn.profile.id)
            JunoPasteboard.copy(share.url.absoluteString)
        } catch {
            // The toolbar's Share reports the failure in its own notice; the
            // row's stays quiet rather than adding a second surface for it.
        }
    }

    private func closeArtifact() {
        withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)) {
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
    /// The web's `max-w-3xl` — the one reading measure every product shares.
    static let reading: CGFloat = JunoReadingMeasure.reading
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
    /// Publishes the conversation and copies its link; nil when the account
    /// has no share service. Reached from every reply's action row, as on the
    /// web, not only from the toolbar.
    let share: (() -> Void)?
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
        // The catalog's name when it knows the id; otherwise the shared
        // humanizer rather than the raw routing key — "Claude Sonnet 4.6",
        // never "anthropic:claude-sonnet-4-6", under the most-read line in
        // the product.
        model.model(withID: id)?.displayName ?? junoDisplayModelName(id)
    }

    /// The regenerate menu's "Switch model" list: every model this account can
    /// send to, by its human name.
    private var switchableModels: [DesktopRegenerateModel] {
        model.selectableModels.map { DesktopRegenerateModel(id: $0.id, name: $0.displayName) }
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
                            regenerate: { modelID in
                                guard let conversationID = model.selectedConversationID else {
                                    return
                                }
                                model.retryLastMessage(
                                    conversationID: conversationID,
                                    modelID: modelID
                                )
                            },
                            switchableModels: switchableModels,
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
                            share: share,
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
                            switchableModels: [],
                            continueResponse: nil,
                            branch: nil,
                            setFeedback: nil,
                            readAloud: nil,
                            share: nil,
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
            .offset(y: risen ? 0 : DesktopChoreography.riseDistance)
            .onAppear {
                guard rises, !reduceMotion else {
                    risen = true
                    return
                }
                withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion)) {
                    risen = true
                }
            }
    }
}

/// A model the regenerate menu can switch to. The catalog row, reduced to what
/// a menu item needs.
struct DesktopRegenerateModel: Identifiable, Equatable {
    let id: String
    let name: String
}

/// One turn of the transcript, laid out as the website lays it out
/// (`message-item.tsx`).
///
/// The reader's turn is a quiet inset bubble on the right — secondary fill,
/// `rounded-card` with the bottom-trailing corner tucked, a hairline, **no
/// shadow** (SOFT_UI §1.4: the transcript stays flat). The reply is prose on
/// the page: no card, no plate. Under either sits **one** action row that
/// appears on hover, in the website's own marks — copy that morphs to a
/// check, thumbs, read aloud, regenerate with its model submenu, branch,
/// share; edit on the reader's turn. The model/cost line is a mono caption
/// under the reply, exactly where the web puts it.
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
    let modelDisplayName: String?
    let isLastAssistant: Bool
    let copy: () -> Void
    /// Re-asks the prompt. `nil` is "the same model"; an id switches to it.
    /// Nil altogether where there is nothing on the server to regenerate.
    let regenerate: ((String?) -> Void)?
    /// What the regenerate menu's "Switch model" submenu lists.
    let switchableModels: [DesktopRegenerateModel]
    /// Nil unless the last answer ended at a resumable boundary. Continue is a
    /// new user turn; unlike regenerate it leaves the partial answer visible.
    let continueResponse: (() -> Void)?
    let branch: (() -> Void)?
    let setFeedback: ((NativeChatFeedback?) -> Void)?
    let readAloud: (() -> Void)?
    /// Publishes the conversation and copies its link — the toolbar's Share,
    /// reachable from the row as it is on the web.
    let share: (() -> Void)?
    /// Hands an artifact up to the conversation column, which owns the canvas.
    let openArtifact: (NativeMessageContent.ArtifactReference) -> Void
    /// Where this message sits among its revisions, or nil when it has none.
    let branchPosition: NativeMessageBranchPosition?
    let stepBranch: ((Int) -> Void)?
    /// Re-asks this prompt with new wording, as a **new branch**. Nil on
    /// answers and on spoken lines, neither of which can be re-asked.
    let editMessage: ((String) -> Void)?
    /// Whether a generation is running. Greys the pager and withholds Edit.
    let isGenerating: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The pointer is over the turn: the web's `group-hover`.
    @State private var hovered = false
    /// Copy just happened; the copy mark is a check for two seconds.
    @State private var copied = false
    @State private var copiedReset: Task<Void, Never>?
    /// Whether a long prompt is showing in full. Collapsed is the resting
    /// state, as it is on the web.
    @State private var promptExpanded = false
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

    private var reasoningLines: [String]? {
        guard let reasoning = message.reasoning, !reasoning.isEmpty else { return nil }
        return JunoAIcssReasoningLines.lines(text: reasoning)
    }

    /// `rounded-card rounded-br-md`: the card rung with one tucked corner.
    private static let bubbleShape = UnevenRoundedRectangle(
        topLeadingRadius: JunoRadius.card,
        bottomLeadingRadius: JunoRadius.card,
        bottomTrailingRadius: JunoRadius.row,
        topTrailingRadius: JunoRadius.card,
        style: .continuous
    )

    /// The web's mono line: model, then cost. One string, "·" separated.
    private var footerLine: String? {
        var fields: [String] = []
        if let modelDisplayName { fields.append(modelDisplayName) }
        if let cost = message.costUSD, cost > 0 {
            fields.append(cost.formatted(.currency(code: "USD").precision(.fractionLength(2...4))))
        }
        return fields.isEmpty ? nil : fields.joined(separator: " · ")
    }

    private var isLongPrompt: Bool {
        message.role == .user && NativePromptLimits.isLongMessage(plainText)
    }

    private var hasTextContent: Bool {
        !plainText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: Body

    var body: some View {
        Group {
            switch message.role {
            case .user: userTurn
            case .assistant: assistantTurn
            case .system, .tool:
                Text(message.content)
                    .junoFont(size: 13, relativeTo: .callout)
                    .junoSecondaryInk()
                    .textSelection(.enabled)
            }
        }
        .onHover { hovered = $0 }
    }

    // MARK: The reader's turn

    private var userTurn: some View {
        HStack(alignment: .top, spacing: 0) {
            Spacer(minLength: 90)
            VStack(alignment: .trailing, spacing: JunoSpace.hairline) {
                if editing {
                    promptEditor
                } else {
                    userBubble
                    if isLongPrompt { expandControl }
                }
                if !editing, !isVoice, !message.isPending {
                    HStack(spacing: 2) {
                        branchNavigator
                        actionRow {
                            copyAction
                            if editMessage != nil {
                                DesktopMessageAction("Edit", icon: .pencil) {
                                    draft = plainText
                                    editing = true
                                }
                                .disabled(isGenerating)
                                .accessibilityIdentifier("juno.desktop.chat.message-edit")
                            }
                            if let branch {
                                DesktopMessageAction("Fork from here", icon: .fork, action: branch)
                            }
                        }
                    }
                }
            }
        }
    }

    /// The bubble: the one inset well in the transcript. Fill, hairline, and
    /// nothing else — a reading surface that casts a shadow is a card.
    private var userBubble: some View {
        Text(plainText)
            .junoFont(size: 15, relativeTo: .body)
            .lineSpacing(4)
            .junoInk()
            .textSelection(.enabled)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, 10)
            .frame(
                maxHeight: isLongPrompt && !promptExpanded
                    ? NativePromptLimits.collapsedMessageHeight : nil,
                alignment: .top
            )
            .clipped()
            .overlay(alignment: .bottom) {
                if isLongPrompt, !promptExpanded {
                    LinearGradient(
                        colors: [Color.junoMuted, Color.junoMuted.opacity(0)],
                        startPoint: .bottom,
                        endPoint: .top
                    )
                    .frame(height: 64)
                    .allowsHitTesting(false)
                }
            }
            .background(Self.bubbleShape.fill(Color.junoMuted))
            .overlay(Self.bubbleShape.strokeBorder(Color.junoHairline, lineWidth: 1))
            .frame(maxWidth: 640, alignment: .trailing)
    }

    /// "Show more · 22 lines", in the web's monospaced metadata voice.
    private var expandControl: some View {
        Button {
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                promptExpanded.toggle()
            }
        } label: {
            Text(
                promptExpanded
                    ? "Show less"
                    : "Show more · \(NativePromptLimits.collapsedSummary(for: plainText))"
            )
            .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
            .junoSecondaryInk()
            .contentShape(.rect)
        }
        .buttonStyle(.junoPress)
        .accessibilityIdentifier("juno.desktop.chat.message-expand")
    }

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
    private var promptEditor: some View {
        VStack(alignment: .trailing, spacing: JunoSpace.snug) {
            TextEditor(text: $draft)
                .junoFont(size: 15, relativeTo: .body)
                .textEditorStyle(.plain)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 64, maxHeight: 240)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .background(Self.bubbleShape.fill(Color.junoMuted))
                .overlay(Self.bubbleShape.strokeBorder(Color.junoFocusRing, lineWidth: 1))
                .frame(maxWidth: 640)
                .accessibilityLabel("Edit message")
                .accessibilityIdentifier("juno.desktop.chat.message-editor")

            HStack(spacing: JunoSpace.snug) {
                Button("Cancel") { editing = false }
                    .buttonStyle(.bordered)
                Button("Save & resend") { submitEdit() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSubmitEdit)
                    .junoProminentAction()
            }
            .controlSize(.small)
        }
    }

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

    // MARK: The reply

    private var assistantTurn: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
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
                NativeMediaGenerationView(progress: progress)
            } else if message.content.isEmpty, message.isPending {
                HStack(spacing: 10) {
                    JunoThinkingMatrix()
                    JunoAIcssThinkingLabel("Thinking about your request", size: 15)
                }
                .frame(minHeight: 22)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Thinking about your request")
                .accessibilityAddTraits(.updatesFrequently)
            } else {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                        switch part {
                        case .text(let text):
                            JunoLessonText(text, streaming: message.isPending)
                        case .artifact(let artifact):
                            DesktopInlineArtifactCard(
                                artifact: artifact,
                                open: artifact.streaming ? nil : { openArtifact(artifact) }
                            )
                        }
                    }
                }
            }

            if !message.sources.isEmpty {
                DesktopMessageSources(sources: message.sources)
            }

            if let error = message.errorDescription {
                Text(error)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoDanger)
                    .textSelection(.enabled)
            }

            if !message.isPending, !isVoice {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    if let footerLine {
                        Text(footerLine)
                            .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                            .junoSecondaryInk()
                            .textSelection(.enabled)
                    }
                    HStack(spacing: 2) {
                        branchNavigator
                        actionRow {
                            if hasTextContent { copyAction }
                            if let setFeedback {
                                DesktopMessageAction(
                                    "Good response", icon: .thumbsUp, active: message.feedback == .up
                                ) {
                                    setFeedback(message.feedback == .up ? nil : .up)
                                }
                                DesktopMessageAction(
                                    "Bad response", icon: .thumbsDown, active: message.feedback == .down
                                ) {
                                    setFeedback(message.feedback == .down ? nil : .down)
                                }
                            }
                            if let readAloud, hasTextContent {
                                DesktopMessageAction("Read aloud", icon: .volume, action: readAloud)
                            }
                            if isLastAssistant, let regenerate, !isGenerating {
                                regenerateMenu(regenerate)
                            }
                            if isLastAssistant, let continueResponse,
                                message.finishReason == .length
                                    || message.finishReason == .networkError
                            {
                                DesktopMessageAction("Continue", icon: .arrowDown, action: continueResponse)
                            }
                            if let branch {
                                DesktopMessageAction("Branch from here", icon: .branch, action: branch)
                            }
                            if let share {
                                DesktopMessageAction("Share", icon: .share, action: share)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: Actions

    /// The row itself: present in the tree always, visible under the pointer
    /// (or keyboard focus) — the web's `opacity-0 group-hover:opacity-100`.
    private func actionRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 2) { content() }
            .opacity(hovered || copied ? 1 : 0)
            .animation(
                JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
                value: hovered
            )
            .accessibilityElement(children: .contain)
    }

    /// Copy, with the check morphing in as the confirmation — the web's
    /// `.check-morph`. No toast: the mark is the whole feedback.
    private var copyAction: some View {
        DesktopMessageAction(
            copied ? "Copied" : "Copy",
            icon: copied ? .check : .copy,
            tint: copied ? Color.junoSuccess : nil
        ) {
            copy()
            copiedReset?.cancel()
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                copied = true
            }
            copiedReset = Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)) {
                    copied = false
                }
            }
        }
    }

    /// Regenerate: try again, or the same prompt of a different model.
    private func regenerateMenu(_ regenerate: @escaping (String?) -> Void) -> some View {
        Menu {
            Button {
                regenerate(nil)
            } label: {
                Label("Try again", icon: .refresh)
            }
            if !switchableModels.isEmpty {
                Menu("Switch model") {
                    ForEach(switchableModels) { option in
                        Button(option.name) { regenerate(option.id) }
                    }
                }
            }
        } label: {
            DesktopMessageActionMark(icon: .refresh, active: false, tint: nil)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Regenerate")
        .accessibilityLabel("Regenerate")
    }
}

/// One action on a message row: a 28pt flat icon button in the website's mark,
/// hover fill, nothing else. `active` is a pressed thumb.
private struct DesktopMessageAction: View {
    let label: String
    let icon: JunoIcon
    var active = false
    var tint: Color? = nil
    let action: () -> Void

    init(
        _ label: String,
        icon: JunoIcon,
        active: Bool = false,
        tint: Color? = nil,
        action: @escaping () -> Void
    ) {
        self.label = label
        self.icon = icon
        self.active = active
        self.tint = tint
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            DesktopMessageActionMark(icon: icon, active: active, tint: tint)
        }
        .buttonStyle(.junoPress)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

/// The mark and its hover plate, shared by the plain buttons and the menu
/// trigger so the two cannot differ by a point.
private struct DesktopMessageActionMark: View {
    let icon: JunoIcon
    let active: Bool
    let tint: Color?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false

    var body: some View {
        JunoIconView(icon, size: 16)
            .foregroundStyle(
                tint ?? (active || hovered ? Color.junoForeground : Color.junoMutedForeground)
            )
            .frame(width: 28, height: 28)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(
                        active
                            ? Color.junoAccent.opacity(0.12)
                            : (hovered ? Color.junoRowHover : Color.clear)
                    )
            )
            .contentShape(.rect)
            .animation(
                JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
                value: hovered
            )
            .onHover { hovered = $0 }
    }
}

/// An artifact referenced inline in an answer — the web's
/// `artifact-inline-card.tsx`.
///
/// An opaque tile on the card rung with a hairline: a 40pt icon tile, the title
/// in the UI face, the kind on a mono caption, and an "Open" ghost button with
/// the external mark. Never glass, never a neumorphic throw — a card in a
/// transcript is content, and the coral is spent nowhere on it.
private struct DesktopInlineArtifactCard: View {
    let artifact: NativeMessageContent.ArtifactReference
    let open: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false

    private var kindLabel: String {
        DesktopArtifactKindLabel.title(forWireKind: artifact.kind)
    }

    /// The web's mono line: the kind, then the language when the model named
    /// one. "Writing" replaces both while the source is still arriving.
    private var metadata: String {
        if artifact.streaming { return "Writing" }
        guard let language = artifact.language, !language.isEmpty else { return kindLabel }
        return "\(kindLabel) · \(language.uppercased())"
    }

    var body: some View {
        Button {
            open?()
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                JunoIconView(DesktopArtifactKindLabel.icon(forWireKind: artifact.kind), size: 18)
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 40, height: 40)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                            .fill(Color.junoMuted)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(artifact.title.isEmpty ? "Untitled artifact" : artifact.title)
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                        .junoInk()
                        .lineLimit(1)
                    Text(metadata)
                        .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                        .junoSecondaryInk()
                        .lineLimit(1)
                }

                Spacer(minLength: JunoSpace.snug)

                if artifact.streaming {
                    JunoThinkingMatrix(dot: 3, spacing: 2)
                        .junoSecondaryInk()
                } else if open != nil {
                    HStack(spacing: JunoSpace.hairline) {
                        Text("Open")
                        JunoIconView(.external, size: 12)
                    }
                    .junoFont(size: 12, relativeTo: .caption, weight: .medium)
                    .foregroundStyle(hovered ? Color.junoForeground : Color.junoMutedForeground)
                    .padding(.horizontal, JunoSpace.snug)
                    .frame(height: 28)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                            .fill(hovered ? Color.junoRowHover : Color.clear)
                    )
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(Color.junoSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 0.5)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.junoPress)
        .disabled(open == nil)
        .onHover { hovered = $0 }
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
            value: hovered
        )
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
                JunoIconView(.web, size: 13)
                    .junoSecondaryInk()
                Text("Sources")
                    .font(.system(.caption, design: .monospaced))
                    .junoInk()
                Text(sources.count.formatted())
                    .font(.system(.caption2, design: .monospaced))
                    .junoSecondaryInk()
                    .monospacedDigit()
                JunoIconView(.chevronDown, size: 12)
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

                JunoIconView(.external, size: 12)
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
            JunoIconView(.triangleAlert, size: 16)
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
            Label(verbatim: groundingNote, icon: .fileSearch)
                .junoCaption()
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("juno.desktop.chat.document-context-note")
        } else if documentGroundingArmed {
            Label(
                verbatim: indexedDocumentCount == 1
                    ? "Juno will search 1 document on this Mac and quote what it finds in your message."
                    : "Juno will search \(indexedDocumentCount) documents on this Mac and quote what it finds in your message.",
                icon: .fileSearch
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
                    .lineLimit(1...8)
                    .junoFont(size: 15, relativeTo: .body)
                    .lineSpacing(4)
                    .junoInk()
                    .focused($focused)
                    .padding(.horizontal, JunoSpace.tight)
                    .padding(.top, JunoSpace.tight)
                    .padding(.bottom, 2)
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

                // One controls row, the web's (`composer-shell.tsx`): `+` on
                // the left; model chip · effort chip · mic · a thin rule · send
                // on the right. Streaming fades everything but the primary
                // action to 60%, because Stop is the one thing left to press.
                HStack(spacing: JunoSpace.hairline) {
                    addMenu
                    Spacer(minLength: JunoSpace.snug)
                    HStack(spacing: JunoSpace.hairline) {
                        modelControl
                        if let scale = thinkingScale, scale.isPresentable {
                            thinkingControl(scale)
                        }
                        if JunoSpeechService.isSupported {
                            dictateButton
                        }
                    }
                    .opacity(model.isGenerating ? 0.6 : 1)
                    .disabled(model.isGenerating)
                    Rectangle()
                        .fill(Color.junoBorder)
                        .frame(width: 1, height: 16)
                        .padding(.horizontal, JunoSpace.hairline)
                        .accessibilityHidden(true)
                    primaryAction
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, JunoSpace.snug)
        .padding(.bottom, 10)
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
                Label("Attach as file", icon: .files)
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
                    JunoIconView(.close, size: 14)
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
                    Label("Edit", icon: .pencil)
                }
                .accessibilityIdentifier("juno.desktop.chat.expand-draft")

                if canAttachDraft {
                    Button(action: attachDraftAsFile) {
                        Label("Attach as file", icon: .files)
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
    /// The composer's one menu: Attach · Tools · Context, the web's `+` menu
    /// (`composer.tsx`) as a native `Menu` so the platform owns the glass, the
    /// hover states and the submenus. Every row's mark is the website's.
    private var addMenu: some View {
        Menu {
            Section("Attach") {
                Button {
                    showingFileImporter = true
                } label: {
                    Label(verbatim: voiceActive ? "Attach images…" : "Attach files…", icon: .attach)
                }
                .disabled(voiceActive ? !canAttachInVoice : !(attachmentModel?.hasCapacity ?? false))

                Button {
                    showingLibrary = true
                } label: {
                    Label("Choose from Library…", icon: .library)
                }
                .disabled(voiceActive || !(attachmentModel?.hasCapacity ?? false))
            }

            Section("Tools") {
                Toggle(isOn: $webSearch) {
                    Label("Web search", icon: .web)
                }
                .disabled(selectedModel?.supportsWebSearch != true)

                Toggle(isOn: $canvasEnabled) {
                    Label("Canvas & artifacts", icon: .artifactsTool)
                }

                Toggle(isOn: $deepResearch) {
                    Label("Deep research", icon: .research)
                }

                if documentIndex != nil {
                    Toggle(isOn: $documentContext) {
                        Label(
                            verbatim: indexedDocumentCount == 0
                                ? "My documents — none on this Mac" : "My documents",
                            icon: .fileSearch
                        )
                    }
                    .disabled(voiceActive || indexedDocumentCount == 0)
                }
            }

            if (fixedProjectID == nil && projectModel != nil) || connectorModel != nil {
                Section("Context") {
                    if fixedProjectID == nil, let projectModel {
                        Menu {
                            Button {
                                selectedProjectID = nil
                            } label: {
                                if selectedProjectID == nil {
                                    Label("No project", icon: .check)
                                } else {
                                    Text("No project")
                                }
                            }
                            ForEach(projectModel.projects) { project in
                                Button {
                                    selectedProjectID = project.id
                                } label: {
                                    if selectedProjectID == project.id {
                                        Label(verbatim: project.name, icon: .check)
                                    } else {
                                        Text(project.name)
                                    }
                                }
                            }
                        } label: {
                            Label(verbatim: selectedProjectName ?? "Project", icon: .projects)
                        }
                        .disabled(model.selectedConversationID != nil)
                    }

                    if connectorModel != nil {
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
                                verbatim: selectedConnectors.isEmpty
                                    ? "Connectors" : "Connectors (\(selectedConnectors.count))",
                                icon: .connections
                            )
                        }
                    }
                }
            }
        } label: {
            DesktopAddMenuMark(isArmed: hasArmedTools)
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
        DesktopComposerChip(
            label: selectedModel?.displayName ?? "Choose model",
            open: showingModelSelector,
            leading: {
                JunoProviderMark(
                    providerID: selectedModel?.providerID ?? "juno",
                    providerName: selectedModel?.providerName ?? "Juno",
                    size: 14
                )
            },
            chevron: true
        ) {
            showingModelSelector = true
        }
        .help("Choose model")
        .accessibilityLabel("Model")
        .accessibilityValue(selectedModel?.displayName ?? "Not selected")
        .accessibilityIdentifier("juno.desktop.chat-model")
        .popover(
            isPresented: $showingModelSelector,
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .bottom
        ) {
            let metrics = JunoModelSelectorMetrics.fitted
            JunoModelSelector(
                models: model.modelCatalog.map(\.junoDescriptor),
                selectedModelID: selectedModelID,
                metrics: metrics,
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
            .frame(width: metrics.width, height: metrics.height)
        }
        .desktopPreviewOverlays(popover: { showingModelSelector = true })
    }

    @ViewBuilder
    private func thinkingControl(_ scale: NativeThinkingScale) -> some View {
        if scale.isAutomatic {
            // Nothing, which is what the web does: Auto picks thinking
            // server-side, and a chip that reads "Auto" beside a model chip
            // that also reads "Auto" is two controls for one word.
            EmptyView()
        } else {
            // Label only — no chevron. The effort chip is a word on the row
            // (SOFT_UI §3); the model chip beside it already carries the one
            // disclosure the row needs.
            DesktopComposerChip(
                label: currentThinkingLabel(in: scale),
                open: showingThinking,
                leading: { EmptyView() },
                chevron: false
            ) {
                showingThinking = true
            }
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
        DesktopComposerIconButton(
            "Dictate",
            icon: .mic,
            active: dictating
        ) {
            focused = false
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                dictating = true
            }
        }
        .accessibilityIdentifier("juno.desktop.chat-dictate")
    }

    /// Whether the draft is empty of anything sendable — the state in which
    /// the primary action offers voice instead of send, as on the web.
    private var draftIsEmpty: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (attachmentModel?.attachments.isEmpty ?? true)
    }

    /// The composer's single morphing action: stop while generating, voice on
    /// an empty prompt, send otherwise — the web's `ComposerPrimaryAction`.
    ///
    /// A 32pt **flat** coral circle. No glass, no raised throw, no halo: a
    /// tinted glow under the send button is the one thing the Soft UI brief
    /// names as reading like an AI demo. The face cross-fades (scale .9→1 +
    /// opacity over `fast`) between send, stop and the voice wave; the disc
    /// itself never moves, so the pointer does not have to re-find it.
    private var primaryAction: some View {
        DesktopComposerPrimaryAction(
            face: model.isGenerating ? .stop : (draftIsEmpty ? .voice : .send),
            enabled: model.isGenerating || canSend || (draftIsEmpty && !selectedModelID.isEmpty)
        ) {
            if model.isGenerating {
                model.stopGeneration()
            } else if draftIsEmpty {
                openVoiceMode(selectedModelID)
            } else {
                send()
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
                JunoIconView(selected ? .circleCheck : .circle, size: 16)
                    .foregroundStyle(selected ? Color.junoAccent : Color.white)
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
                    JunoEmptyState(
                        title: "No matching files",
                        message: "Files and images you share in conversations appear here.",
                        icon: .library
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
                JunoIconView(.close, size: 12)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.fileName)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .fill(Color.junoMuted)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
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
            JunoIconView(.circleCheck, size: 14)
                .foregroundStyle(Color.junoSuccess)
        case .failed:
            JunoIconView(.error, size: 14)
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

// MARK: - The composer's controls

/// The `+` that opens the menu: a 32pt flat icon button with a coral dot when
/// a tool is armed — the web's `+` exactly. No raised circle, no glass: the
/// button is content on the composer's chrome, and the only thing the bar
/// says about tool state is the dot.
private struct DesktopAddMenuMark: View {
    let isArmed: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false

    var body: some View {
        JunoIconView(.plus, size: 16)
            .foregroundStyle(hovered ? Color.junoForeground : Color.junoMutedForeground)
            .frame(width: 32, height: 32)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(hovered ? Color.junoRowHover : Color.clear)
            )
            .overlay(alignment: .topTrailing) {
                if isArmed {
                    Circle()
                        .fill(Color.junoAccent)
                        .stroke(Color.junoSurface, lineWidth: 1.5)
                        .frame(width: 7, height: 7)
                        .offset(x: -5, y: 5)
                        .transition(.junoOverlay)
                }
            }
            .contentShape(.rect)
            .onHover { hovered = $0 }
            .animation(
                JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
                value: hovered
            )
            .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: isArmed)
    }
}

/// A flat text chip on the controls row — the web's `composerChipClass`: 32pt
/// tall, `text-ui` medium, ink at 80%, an accent-fill on hover, the same fill
/// with full ink while open. Never raised, never pressed.
private struct DesktopComposerChip<Leading: View>: View {
    let label: String
    let open: Bool
    @ViewBuilder let leading: () -> Leading
    let chevron: Bool
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false

    private var lit: Bool { hovered || open }

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.tight) {
                leading()
                Text(label)
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if chevron {
                    JunoIconView(.chevronDown, size: 12)
                        .opacity(0.6)
                        .rotationEffect(.degrees(open ? 180 : 0))
                }
            }
            .foregroundStyle(lit ? Color.junoForeground : Color.junoForeground.opacity(0.8))
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(lit ? Color.junoRowHover : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.junoPress)
        .fixedSize(horizontal: true, vertical: false)
        .onHover { hovered = $0 }
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
            value: lit
        )
    }
}

/// A 32pt flat icon button on the controls row — the web's
/// `composerIconButtonClass`: muted mark, accent fill and full ink on hover.
private struct DesktopComposerIconButton: View {
    let label: String
    let icon: JunoIcon
    let active: Bool
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false

    init(_ label: String, icon: JunoIcon, active: Bool = false, action: @escaping () -> Void) {
        self.label = label
        self.icon = icon
        self.active = active
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            JunoIconView(icon, size: 16)
                .foregroundStyle(
                    active ? Color.junoAccent
                        : (hovered ? Color.junoForeground : Color.junoMutedForeground)
                )
                .frame(width: 32, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                        .fill(hovered ? Color.junoRowHover : Color.clear)
                )
                .contentShape(.rect)
        }
        .buttonStyle(.junoPress)
        .onHover { hovered = $0 }
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
            value: hovered
        )
        .help(label)
        .accessibilityLabel(label)
    }
}

/// The 32pt coral circle. Flat — no shadow, no glass — with a face that
/// cross-morphs between send, stop and the voice wave.
private struct DesktopComposerPrimaryAction: View {
    enum Face { case send, stop, voice }

    let face: Face
    let enabled: Bool
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var label: String {
        switch face {
        case .send: "Send message"
        case .stop: "Stop generating"
        case .voice: "Start voice conversation"
        }
    }

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().fill(Color.junoAccent)
                Group {
                    switch face {
                    case .send:
                        JunoIconView(.arrowUp, size: 16)
                    case .stop:
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(.foreground)
                            .frame(width: 11, height: 11)
                    case .voice:
                        DesktopVoiceGlyph()
                    }
                }
                .foregroundStyle(Color.junoOnAccent)
                .transition(.scale(scale: 0.9).combined(with: .opacity))
                .id(face)
            }
            .frame(width: 32, height: 32)
            .contentShape(.circle)
        }
        .buttonStyle(.junoPress)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion),
            value: face
        )
        .help(label)
        .accessibilityLabel(label)
        .accessibilityIdentifier(label)
    }
}
