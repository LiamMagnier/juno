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

/// Which model a composer or a re-asked turn goes to.
enum DesktopChatSelection {
    /// The current pick while it is still selectable, then the conversation's
    /// own model, then **Auto** — so there is always a model (§5.3). Before the
    /// catalog has loaded (or when it failed) nothing is selectable yet; the
    /// conversation's model, or Auto, is sent as-is and the store accepts an
    /// unknown id only while it has no catalog to check it against.
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
        if let auto = selectable.first(where: \.isJunoAuto) {
            return auto.id
        }
        if let first = selectable.first {
            return first.id
        }
        return conversationModel.isEmpty ? ChatComposerModels.autoModelID : conversationModel
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
    /// A pinned project's own row, which opens that project's page.
    case project(String)
}

/// The Chat product's window: the one live `NavigationSplitView` while Chat is
/// showing (crash rule 1), the column, and ``ChatDetail`` — the stable
/// container that owns the title, the title menu and the toolbar.
///
/// It also owns the few things more than one surface reaches: the delete
/// confirmation, the share popover's state and the new-project sheet, so the
/// sidebar row, its hover menu and the title menu all present the same one.
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
    /// A one-shot request made from another product, the menu bar or Quick
    /// Entry to start an ordinary Chat conversation that is not scoped to any
    /// local repository.
    var unscopedChatRequestID: UUID?
    /// Text the request asked the draft to open with — from ⌥Space, or the
    /// menu bar item. Nil for an ordinary New Chat.
    var unscopedChatPrompt: String? = nil
    /// The request asked for a private draft: ⇧⌘N from Code, the legacy
    /// workspace, or with no window focused.
    var unscopedChatIsPrivate = false
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
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    /// Set by Projects immediately before it opens a new draft. The composer
    /// consumes it once so an ordinary New Chat never inherits an old project's
    /// scope.
    @State private var draftProjectID: String?
    /// Optional text entered on a project overview before opening Chat. The
    /// composer consumes this once, so the project page never presents a fake
    /// prompt field.
    @State private var draftPrompt: String?
    /// A deep link into one project. The Projects row opens the index; a pinned
    /// project's row — or Open Project in the title menu — writes this.
    @State private var requestedProjectID: String?
    /// Why the last ⇧⌘U screenshot did not land in the composer.
    @State private var screenshotFailure: String?
    /// True while the chat route is a private chat (§5.8): nothing saved,
    /// synced or remembered, and the window titled "Incognito chat". The
    /// toolbar's Private toggle and ⇧⌘N set it; any navigation clears it, and
    /// clearing it is what erases the chat — see `erasePrivateChat()`. The
    /// column draws it with the same composer as any draft, sending to the
    /// in-memory ``NativePrivateChatModel``.
    @State private var isPrivateChat = false
    @State private var confirmingLeavePrivate = false
    /// A call is live on the chat route. The Private toggle steps aside while
    /// it is: a call's transcript is filed as a conversation.
    @State private var isInCall = false
    /// The conversation whose sidebar row is showing its rename field.
    @State private var renamingConversationID: String?
    /// The conversation Delete… is asking about.
    @State private var pendingDeletion: NativeConversation?
    @State private var newProjectRequest: DesktopNewProjectRequest?
    @State private var share = DesktopShareState()
    /// ⌘U from the menu bar, or a file dropped on the chat column, on its way
    /// to the composer — which owns the importer and the attachment rules.
    @State private var composerRequest: ChatComposerRequest?

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

    /// The pinned project whose row should read as selected: only while its
    /// page is up, and only if the column actually draws a row for it.
    private var openPinnedProjectID: String? {
        guard let requestedProjectID,
              configuration.projectModel?.projects.contains(where: {
                  $0.id == requestedProjectID && $0.starred
              }) == true
        else { return nil }
        return requestedProjectID
    }

    /// Projects the underlying pieces of state into the column's single
    /// selection, and back. The rules themselves are in
    /// ``DesktopNavigationState`` so they can be tested; this only moves values.
    private var selection: Binding<DesktopSidebarItem?> {
        Binding(
            get: {
                DesktopNavigationState.selection(
                    destination: currentDestination,
                    selectedConversationID: model.selectedConversationID,
                    openProjectID: openPinnedProjectID
                )
            },
            set: { item in
                // Only a pinned project's row deep-links into a project; every
                // other selection opens its destination's root.
                if case .project(let id) = item {
                    requestedProjectID = id
                } else {
                    requestedProjectID = nil
                }
                let resolved = DesktopNavigationState.resolve(
                    selection: item,
                    current: (currentDestination, model.selectedConversationID)
                )
                overrideDestination = nil
                storedDestination = resolved.destination.rawValue
                model.selectedConversationID = resolved.conversationID
                model.isDraftingNewConversation = resolved.isDrafting
                // Choosing anything in the column leaves a private chat — and
                // leaving it is what erases it.
                if item != nil { isPrivateChat = false }
            }
        )
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            DesktopChatSidebar(
                model: model,
                projectModel: configuration.projectModel,
                configuration: configuration,
                session: session,
                product: $product,
                destination: destination,
                selection: selection,
                renamingConversationID: $renamingConversationID,
                openProjectID: openPinnedProjectID,
                actions: conversationActions,
                newChat: beginDraft,
                newChatInProject: startConversation(in:),
                openSearch: openSearch
            )
            .junoSidebarColumn()
        } detail: {
            detail
        }
        .focusedSceneValue(\.junoWorkspaceActions, workspaceActions)
        // Opener and actions on one line: the targets gate reads a dialog's
        // buttons as system-drawn only when its brace opens on that line.
        .confirmationDialog("Delete this conversation?", isPresented: isConfirmingDeletion, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { deletePendingConversation() }
            Button("Cancel", role: .cancel) { pendingDeletion = nil }
        } message: {
            // The web's copy, verbatim (`app-sidebar.tsx`).
            Text("This permanently removes the conversation and its messages. This can't be undone.")
        }
        .confirmationDialog("Leave this private chat?", isPresented: $confirmingLeavePrivate, titleVisibility: .visible) {
            Button("Leave", role: .destructive) { isPrivateChat = false }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It won't be saved.")
        }
        .sheet(item: $newProjectRequest) { request in
            if let projectModel = configuration.projectModel {
                DesktopNewProjectForm(model: projectModel) { projectID in
                    projectCreated(projectID, for: request)
                }
            }
        }
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
        // The share popover belongs to the chat it was opened for; switching
        // chats or leaving the route closes it rather than leaving it pointing
        // at a conversation that is no longer on screen. Not when the chat now
        // selected *is* that chat: a row's Share… selects its chat and shares
        // it in one gesture, and whichever of the two lands first, the popover
        // it opened must stay open (see ``DesktopShareState/conversationID``).
        .onChange(of: model.selectedConversationID) { _, selected in
            guard DesktopShareState.selectionClosesPopover(sharing: share.conversationID, selected: selected)
            else { return }
            share.isPresented = false
        }
        .onChange(of: currentDestination) { _, value in
            guard value != .chat else { return }
            share.isPresented = false
            isPrivateChat = false
        }
        // Leaving private mode IS the erase. Nothing else holds these turns,
        // so dropping them here is what makes "not saved" true rather than
        // merely stated — on the toggle, on navigation, and when the window's
        // Chat workspace goes away with a product switch.
        .onChange(of: isPrivateChat) { _, isOn in
            if !isOn { erasePrivateChat() }
        }
        .onDisappear { erasePrivateChat() }
    }

    // MARK: Detail

    /// The detail column: ``ChatDetail`` — the one owner of the title, the
    /// title menu and the toolbar — around whichever destination is open.
    ///
    /// Split out of `body`, and its arguments computed one per property, so
    /// the type checker solves each on its own: inline in the split view's
    /// `detail:` closure, the generic container, its trailing builder and a
    /// dozen arguments were one expression, and one the compiler gave up on.
    private var detail: some View {
        ChatDetail(
            title: windowTitle,
            subtitle: windowSubtitle,
            titleMenuConversation: titleMenuConversation,
            projects: configuration.projectModel?.projects ?? [],
            actions: conversationActions,
            isChatRoute: currentDestination == .chat,
            offline: offlineState,
            retryConnection: retryConnection,
            toolbar: toolbar
        ) {
            destinationContent
        }
    }

    private var destinationContent: some View {
        DesktopDestinationView(
            destination: destination,
            configuration: configuration,
            session: session,
            conversationModel: model,
            draftProjectID: $draftProjectID,
            draftPrompt: $draftPrompt,
            requestedProjectID: $requestedProjectID,
            composerRequest: $composerRequest,
            isPrivateChat: isPrivateChat,
            callActiveChanged: { isInCall = $0 },
            shareConversation: replyShare
        )
    }

    /// A reply's Share, which opens the same popover the toolbar's does. Nil
    /// without a share service, which leaves the action off every reply.
    private var replyShare: (() -> Void)? {
        guard configuration.shareClient != nil else { return nil }
        return { shareSelectedConversation() }
    }

    private var offlineState: DesktopOfflineState? {
        DesktopOfflineState.resolve(
            connectivity: configuration.authModel.connectivity,
            syncPhase: configuration.syncModel?.phase
        )
    }

    private func retryConnection() {
        Task { await configuration.authModel.retryRestore() }
    }

    // MARK: Title

    private var windowTitle: String {
        DesktopNavigationState.windowTitle(
            destination: currentDestination,
            conversationTitle: model.selectedConversation?.title,
            isPrivate: isPrivateChat
        )
    }

    /// The project a saved chat belongs to — the web's floating project pill,
    /// as the system's subtitle. Empty everywhere else.
    private var windowSubtitle: String {
        guard currentDestination == .chat, !isPrivateChat,
              let projectID = model.selectedConversation?.projectId
        else { return "" }
        return configuration.projectModel?.projects.first { $0.id == projectID }?.name ?? ""
    }

    /// The chat the title menu acts on: a saved one, on the chat route, not
    /// private.
    private var titleMenuConversation: NativeConversation? {
        guard currentDestination == .chat, !isPrivateChat else { return nil }
        return model.selectedConversation
    }

    // MARK: Toolbar

    private var toolbar: ChatToolbar {
        ChatToolbar(
            isChatRoute: currentDestination == .chat,
            isSidebarCollapsed: columnVisibility == .detailOnly,
            canShare: canShareSelectedConversation,
            isPrivate: isPrivateChat,
            canGoPrivate: configuration.privateChatModel != nil && !isInCall,
            share: share,
            newChat: beginDraft,
            startShare: shareSelectedConversation,
            togglePrivate: togglePrivateChat
        )
    }

    private var canShareSelectedConversation: Bool {
        configuration.shareClient != nil
            && !isPrivateChat
            && model.selectedConversationID != nil
            && !model.selectedMessages.isEmpty
    }

    /// Publishes the open conversation, puts the link on the pasteboard, and
    /// says so in the popover.
    ///
    /// The Mac copies rather than opening a share sheet: a link is going into a
    /// message or a document the reader is already writing. The route is
    /// idempotent per conversation, so sharing twice yields the same link.
    private func shareSelectedConversation() {
        guard let client = configuration.shareClient,
              let conversationID = model.selectedConversationID,
              share.phase != .working || share.conversationID != conversationID
        else { return }
        share.conversationID = conversationID
        share.phase = .working
        share.isPresented = true
        let accountID = session.profile.id
        Task {
            do {
                let published = try await client.share(conversationID: conversationID, for: accountID)
                // A share started for another chat since then owns the popover
                // and the pasteboard: copying this link over that one would
                // leave the popover describing a link that is not the one
                // pasted.
                guard share.conversationID == conversationID else { return }
                JunoPasteboard.copy(published.url.absoluteString)
                share.phase = .copied(published.url)
            } catch {
                guard share.conversationID == conversationID else { return }
                share.phase = .failed("The conversation couldn’t be published. Try again in a moment.")
            }
        }
    }

    // MARK: Private chat

    /// Drops the private chat's turns and stops its reply. The model itself
    /// stays started for the account — the root owns its lifetime — so the
    /// next private chat can send at once.
    private func erasePrivateChat() {
        configuration.privateChatModel?.reset()
    }

    /// On a draft, switches that draft to private. On a saved chat or a page,
    /// starts a new private chat. Turning it off with messages on screen asks
    /// first, because turning it off is what erases them.
    private func togglePrivateChat() {
        if isPrivateChat {
            if let privateModel = configuration.privateChatModel, !privateModel.isEmpty {
                confirmingLeavePrivate = true
            } else {
                isPrivateChat = false
            }
            return
        }
        guard !isInCall else { return }
        if currentDestination != .chat || model.selectedConversationID != nil {
            beginDraft()
        }
        // A private turn carries only its words, so anything already attached
        // to the draft stays behind rather than riding along unsent.
        configuration.attachmentModel?.clear()
        configuration.privateChatModel?.reset()
        isPrivateChat = configuration.privateChatModel != nil
    }

    /// ⇧⌘N: a new private chat, whatever was on screen — except over a live
    /// call, whose transcript is filed as a conversation. The system's beep
    /// says the command did nothing, as it does for any unavailable key.
    private func beginPrivateDraft() {
        guard !isInCall else {
            NSSound.beep()
            return
        }
        beginDraft()
        configuration.privateChatModel?.reset()
        isPrivateChat = configuration.privateChatModel != nil
    }

    // MARK: Conversation actions

    private var conversationActions: DesktopConversationActions {
        DesktopConversationActions(
            rename: { conversation in
                // The row holds the field, so the row has to be on screen.
                if columnVisibility == .detailOnly { columnVisibility = .all }
                renamingConversationID = conversation.id
            },
            commitRename: { conversation, name in
                Task { await model.renameConversation(id: conversation.id, title: name) }
            },
            togglePin: { conversation in
                Task { await model.setPinned(id: conversation.id, pinned: !conversation.pinned) }
            },
            move: { conversation, projectID in
                Task { await model.setProject(id: conversation.id, projectID: projectID) }
            },
            newProject: { conversation in
                guard configuration.projectModel != nil else { return }
                newProjectRequest = DesktopNewProjectRequest(conversationID: conversation?.id)
            },
            openProject: openProject,
            share: { conversation in
                // The menus disable Share… for an empty chat; this is the
                // guard for a caller that did not ask.
                guard !model.messages(for: conversation.id).isEmpty else { return }
                openConversation(conversation.id)
                // A turn later, so the toolbar has unhidden Share for this
                // chat before the popover anchors to it.
                Task { shareSelectedConversation() }
            },
            canShare: { conversation in
                configuration.shareClient != nil && !model.messages(for: conversation.id).isEmpty
            },
            archive: { conversation, undoManager in
                setArchived(conversation.id, archived: true, undoManager: undoManager)
            },
            delete: { conversation in pendingDeletion = conversation }
        )
    }

    /// Archives or restores a chat, and registers the opposite with the
    /// window's undo manager — so Edit › Undo Archive Chat (⌘Z) brings it
    /// back, and Redo sends it away again.
    ///
    /// The toast that also offers Undo (§2.4, "Chat archived.") needs the
    /// window-level toast host, which lands in Phase 3; until then the undo
    /// manager is the way back, alongside the web's archive.
    private func setArchived(_ id: String, archived: Bool, undoManager: UndoManager?) {
        if archived, model.selectedConversationID == id {
            beginDraft()
        }
        Self.applyArchive(id, archived: archived, model: model, undoManager: undoManager)
    }

    /// Writes the archive flag and registers its inverse. Static, over the
    /// model alone, because the undo stack outlives any one render of this
    /// view: the handler must not reach back into view state to run.
    private static func applyArchive(
        _ id: String,
        archived: Bool,
        model: NativeConversationModel<SQLiteAccountRepository>,
        undoManager: UndoManager?
    ) {
        Task { await model.setArchived(id: id, archived: archived) }
        guard let undoManager else { return }
        undoManager.registerUndo(withTarget: model) { model in
            MainActor.assumeIsolated {
                applyArchive(id, archived: !archived, model: model, undoManager: undoManager)
            }
        }
        undoManager.setActionName("Archive Chat")
    }

    private var isConfirmingDeletion: Binding<Bool> {
        Binding(
            get: { pendingDeletion != nil },
            set: { if !$0 { pendingDeletion = nil } }
        )
    }

    /// Deletes the conversation Delete… asked about. A real delete — the
    /// store enqueues `conversation.delete` — which is why it asks first.
    private func deletePendingConversation() {
        guard let conversation = pendingDeletion else { return }
        pendingDeletion = nil
        if model.selectedConversationID == conversation.id {
            beginDraft()
        }
        Task { await model.deleteConversation(id: conversation.id) }
    }

    private func projectCreated(_ projectID: String, for request: DesktopNewProjectRequest) {
        if let conversationID = request.conversationID {
            // Add to Project ▸ New Project…: the chat moves into what it made.
            Task { await model.setProject(id: conversationID, projectID: projectID) }
        } else {
            // The Pinned projects header: straight into the new project, as the
            // web's `/projects?new=1` does.
            openProject(projectID)
        }
    }

    // MARK: Navigation

    private func openProject(_ projectID: String) {
        requestedProjectID = projectID
        destination.wrappedValue = .projects
    }

    private func openSearch() {
        destination.wrappedValue = .search
    }

    /// Opens a conversation some other surface points at.
    private func openConversation(_ id: String) {
        draftProjectID = nil
        draftPrompt = nil
        requestedProjectID = nil
        isPrivateChat = false
        model.isDraftingNewConversation = false
        model.selectedConversationID = id
        destination.wrappedValue = .chat
    }

    /// "New Chat in Project": a draft already scoped to the project.
    private func startConversation(in projectID: String) {
        beginDraft()
        draftProjectID = projectID
    }

    /// What the menu bar can do to this window while it is focused.
    private var workspaceActions: DesktopWorkspaceActions {
        var screenshot: (() -> Void)?
        var attachFiles: (() -> Void)?
        // Not in private mode, whose turns carry only words: a screenshot
        // taken there would wait in the attachment tray for a chat it cannot
        // be sent in.
        if configuration.attachmentModel != nil, !isPrivateChat {
            screenshot = { attachScreenshot() }
            // Only where the composer is on screen to receive it.
            if currentDestination == .chat {
                attachFiles = { composerRequest = ChatComposerRequest(kind: .chooseFiles) }
            }
        }
        return DesktopWorkspaceActions(
            newItem: beginDraft,
            newChat: beginDraft,
            openSearch: openSearch,
            switchProduct: { product = $0 },
            currentProduct: product,
            attachScreenshot: screenshot,
            attachFiles: attachFiles
        )
    }

    private var screenshotFailurePresented: Binding<Bool> {
        Binding(
            get: { screenshotFailure != nil },
            set: { if !$0 { screenshotFailure = nil } }
        )
    }

    /// ⇧⌘U. The system picker chooses the window or display; the frame lands
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

    /// A new, empty, saved-when-sent draft. It selects nothing in the column.
    private func beginDraft() {
        draftProjectID = nil
        draftPrompt = nil
        requestedProjectID = nil
        overrideDestination = nil
        storedDestination = DesktopDestination.chat.rawValue
        model.isDraftingNewConversation = true
        model.selectedConversationID = nil
        configuration.attachmentModel?.clear()
        isPrivateChat = false
    }

    private func consumePendingUnscopedChatRequest() {
        guard unscopedChatRequestID != nil else { return }
        overrideDestination = nil
        if unscopedChatIsPrivate {
            beginPrivateDraft()
        } else {
            beginDraft()
            if let prompt = unscopedChatPrompt, !prompt.isEmpty {
                draftPrompt = prompt
            }
        }
        consumeUnscopedChatRequest()
    }
}

/// A request for the New Project sheet. The conversation, when there is one,
/// moves into the project the sheet creates.
struct DesktopNewProjectRequest: Identifiable {
    let id = UUID()
    let conversationID: String?
}

/// New Project, as a form sheet (§7.1): one field, Cancel and Create Project.
///
/// The system's sheet presentation — glass on macOS 26 — with no fill of
/// Juno's own, a grouped `Form`, and one `.borderedProminent` default action in
/// the account's accent. Instructions are the project page's to edit; asking
/// for them here made naming a project a two-field chore.
struct DesktopNewProjectForm: View {
    @Bindable var model: NativeProjectModel<SQLiteAccountRepository>
    let created: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var creationError: String?
    @FocusState private var nameFocused: Bool

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .focused($nameFocused)
                        .onSubmit(create)
                        .accessibilityIdentifier("New project name")
                } header: {
                    Text("New project")
                        .junoType(.heading)
                        .junoInk()
                        .textCase(nil)
                        .accessibilityAddTraits(.isHeader)
                } footer: {
                    // Only an error this sheet's own attempt produced.
                    if let creationError {
                        Text(creationError)
                            .junoFont(size: 12, relativeTo: .footnote)
                            .foregroundStyle(Color.junoDestructiveInk)
                    } else {
                        Text("A project keeps one topic's chats, files and instructions together.")
                            .junoFont(size: 12, relativeTo: .footnote)
                            .junoSecondaryInk()
                    }
                }
            }
            .formStyle(.grouped)

            HStack(spacing: JunoSpace.cozy) {
                Spacer(minLength: 0)
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
                Button("Create Project", action: create)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(trimmedName.isEmpty || model.isMutating)
                    .contentShape(.rect)
                    .accessibilityIdentifier("Create project")
            }
            .junoDialogActions()
        }
        .frame(width: 420)
        .presentationSizing(.form)
        // A sheet is presented from the split view, above the detail's tint,
        // so the one prominent button states the accent itself.
        .junoAccentTint()
        .task { nameFocused = true }
    }

    private func create() {
        guard !trimmedName.isEmpty else { return }
        Task {
            creationError = nil
            guard let id = await model.createProject(name: trimmedName) else {
                creationError = model.lastErrorDescription ?? "Juno could not create this project."
                return
            }
            created(id)
            dismiss()
        }
    }
}

/// The chat route's column: the transcript — or a draft's empty state — with
/// the one composer in its bottom bar, and the artifact canvas docked beside
/// it.
///
/// Paints **no background**: the window paints `Color.junoCanvas` once, as its
/// container background, so the transcript scrolls under the toolbar and the
/// composer's glass has warm paper to sample (§1.2).
struct DesktopConversationView: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let attachmentModel: NativeComposerAttachmentModel?
    let profileName: String?
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Binding var draftProjectID: String?
    @Binding var draftPrompt: String?
    /// ⌘U from the menu bar, and the drops this column accepts, for the
    /// composer to act on.
    @Binding var composerRequest: ChatComposerRequest?
    /// Moves the window to another destination — the `+` menu's Manage
    /// Connections… goes to the Connections page.
    let openDestination: (DesktopDestination) -> Void
    /// The private chat, while the route is private (§5.8, Private): the same
    /// column and the same composer, with the in-memory model behind them
    /// instead of the store. Nil for an ordinary chat.
    var privateChat: NativePrivateChatModel? = nil
    /// Tells the window whether a call is live, so the toolbar's Private
    /// toggle can step aside while one is — a call's transcript is filed as a
    /// conversation, which is the one thing private mode promises not to do.
    var callActiveChanged: (Bool) -> Void = { _ in }
    /// A reply's Share: the window's, so it opens the same popover the
    /// toolbar's Share does rather than copying a link in silence (§7.3). Nil
    /// when the account has no share service.
    var shareConversation: (() -> Void)? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openSettings) private var openSettings
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
    /// The conversation column's own size: its height is what a draft's
    /// composer group is centred in (§4.1), and its width is what the
    /// greeting's size is fluid against (§4.2).
    @State private var columnHeight: CGFloat = 0
    @State private var columnWidth: CGFloat = 0
    /// A new chat's first turn, from Return until the store has the real one
    /// (§10.1). It is what ends the draft at once — so the handoff runs when
    /// the reader sends, not a network round trip later — and it stands in the
    /// transcript as the reader's bubble until the store's own arrives.
    @State private var handoffTurn: NativeChatMessage?
    /// The draft group's height — greeting, composer and chips — without its
    /// lift, and the part of it hanging below the composer.
    @State private var dockGroupHeight: CGFloat = 0
    @State private var dockFooterHeight: CGFloat = 0
    /// A file is being dragged over the column.
    @State private var isDropTargeted = false
    /// ↑ in the composer's empty field, handed to the last message you sent.
    @State private var editLastRequest: UUID?
    /// The account's budget windows, for the composer's quota line. Nil until
    /// the first read lands, and nil draws nothing — never a guessed limit.
    @State private var plan: NativeUsagePlan?
    @State private var planReadAt: Date?

    var body: some View {
        // Clamped through `Color.clear.overlay { … }`, for the reason
        // ``JunoDetailPage`` spells out: a `ScrollView` propagates its content's
        // ideal height rather than absorbing it, so a long transcript reports an
        // ideal of "every message stacked" — and `NavigationSplitView` answers an
        // ideal it cannot meet by *growing the window's split view*. `Color.clear`
        // takes whatever height it is proposed and an overlay is sized by its
        // base, so the chat can never resize the window it lives in.
        Color.clear
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
                columnHeight = size.height
                columnWidth = size.width
            }
            .overlay { conversationContent }
            // The toolbar's Private toggle steps aside while a call is live.
            .onChange(of: voiceSession != nil, initial: true) { _, active in
                callActiveChanged(active)
            }
            .onDisappear { callActiveChanged(false) }
            // The stand-in for a first turn has done its job once the store
            // holds the real one — or once this is no longer that draft.
            .onChange(of: model.selectedMessages.contains { $0.role == .user }) { _, hasTurn in
                if hasTurn { handoffTurn = nil }
            }
            .onChange(of: privateChat != nil) { _, _ in handoffTurn = nil }
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
            // The budget moves when a turn finishes, so the plan is read when
            // the column appears and again as each reply ends.
            .task(id: model.isGenerating) {
                guard !model.isGenerating else { return }
                await readPlan()
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
    /// Paints **no background**. The window paints the canvas once, as its
    /// container background; painting it a second time here is what flattened
    /// the window into one cream field and boxed the composer in a rectangle of
    /// its own.
    ///
    /// The canvas is a **column**, not a presentation. It sits beside the
    /// conversation exactly as the website's does, so the reply the artifact
    /// came out of stays readable next to it. A draft has no artifact to show,
    /// so the dock is simply closed there — and wrapping both phases in it is
    /// what keeps the composer one view across the first send.
    private var conversationContent: some View {
        DesktopArtifactDock(
            artifact: openArtifact,
            close: closeArtifact,
            requestEdit: { prompt in
                draftPrompt = prompt
                closeArtifact()
            }
        ) {
            chatColumn
        }
    }

    /// A draft: no conversation, no first turn on its way, and no call. A live
    /// call takes the greeting's place before a word is said — the web's
    /// `hasMessages || voiceOpen` — because a draft has no message list to
    /// append the call to. A private chat is a draft until its first turn.
    private var isDraft: Bool {
        guard voiceSession == nil else { return false }
        if let privateChat { return privateChat.isEmpty }
        return model.selectedConversation == nil && handoffTurn == nil
    }

    /// The turns this column shows that have no row in the store: a private
    /// chat's, or the stand-in for a first turn the store has not created yet.
    ///
    /// The stand-in is dropped in the same render the store's own bubble
    /// arrives in, not an update later, so the two never show together.
    private var localMessages: [NativeChatMessage] {
        if let privateChat {
            let streamingID = privateChat.isStreaming ? privateChat.turns.last?.id : nil
            return privateChat.turns.map { turn in
                NativeChatMessage(
                    id: "private-\(turn.id)",
                    conversationID: "",
                    clientID: nil,
                    role: turn.role == .user ? .user : .assistant,
                    content: turn.content,
                    reasoning: turn.reasoning,
                    model: turn.model,
                    // A private turn has no stored moment, and a date that
                    // changed per render would make every row look new.
                    createdAt: .distantPast,
                    revision: 0,
                    isPending: turn.id == streamingID
                )
            }
        }
        guard let handoffTurn, !model.selectedMessages.contains(where: { $0.role == .user }) else {
            return []
        }
        return [handoffTurn]
    }

    /// A new chat's first send, from the composer (§10.1). `.began` arrives
    /// inside the handoff's transaction, so setting the stand-in here is what
    /// ends the draft — the lift falls, the greeting and chips leave, and the
    /// transcript arrives with the bubble — in one animation.
    private func firstTurn(_ event: ChatFirstTurnEvent) {
        switch event {
        case .began(let content):
            handoffTurn = NativeChatMessage(
                id: "handoff-\(UUID().uuidString.lowercased())",
                conversationID: "",
                clientID: nil,
                role: .user,
                content: content,
                reasoning: nil,
                model: nil,
                createdAt: Date(),
                revision: 0
            )
        case .accepted:
            break
        case .refused:
            handoffTurn = nil
        }
    }

    /// The chat column: the transcript, with the composer in its bottom bar.
    ///
    /// **One mount, both phases** (§4.1, §5.1). The composer lives in the
    /// column's `safeAreaBar` whether the column is a draft or a conversation,
    /// so it is the same view — same draft, same focus, same attachments — on
    /// either side of the first send. In a draft the bar also carries the
    /// greeting and is lifted to the optical centre; in a conversation it rests
    /// at the foot, and the transcript scrolls *under* it, which is what gives
    /// the glass something to bend. The bar spans this column alone, so the
    /// canvas docks beside it rather than under it: a composer stretched under
    /// an artifact would be offering to send into it.
    ///
    /// No in-content title strip: the conversation's title is the window's.
    private var chatColumn: some View {
        Group {
            if isDraft {
                Color.clear
            } else {
                DesktopTranscript(
                    model: model,
                    localMessages: localMessages,
                    localError: privateChat?.lastErrorDescription,
                    // Not while a first turn is on its way: with nothing selected
                    // yet, the store's errors and approvals describe some other
                    // chat, and a refusal is reported by the composer.
                    showsStoreState: privateChat == nil && model.selectedConversationID != nil,
                    voiceMessages: voiceMessages,
                    messageActions: configuration.messageActionsClient,
                    followUpClient: configuration.followUpClient,
                    draftPrompt: $draftPrompt,
                    accountID: session.profile.id,
                    syncModel: configuration.syncModel,
                    openArtifact: open(artifact:),
                    share: shareConversation,
                    editLastRequest: editLastRequest
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaBar(edge: .bottom, spacing: 0) {
            ChatComposerDock(
                lift: composerLift,
                gutter: DesktopChatMeasure.gutter,
                groupHeightChanged: { dockGroupHeight = $0 },
                footerHeightChanged: { dockFooterHeight = $0 }
            ) {
                // Mounted for the life of the column and posed rather than
                // removed (``ChatEmptyPose``): inside the handoff's
                // transaction it fades up and away while the composer it hangs
                // from settles to the dock (§10.1).
                ChatGreeting(
                    profileName: profileName,
                    isPrivate: privateChat != nil,
                    columnWidth: columnWidth,
                    isShown: isDraft
                )
                .padding(.bottom, JunoSpace.region)
            } composer: {
                composer
            } footer: {
                // Not in a private chat: incognito carries its own two-line
                // header, and a row of suggestions under it would be asking
                // for the one thing private mode does not keep.
                if privateChat == nil {
                    ChatStarterChips(isShown: isDraft) { opening in
                        composerRequest = ChatComposerRequest(kind: .seed(opening))
                    }
                    .padding(.top, JunoSpace.regular)
                }
            }
        }
        // The whole column takes a drop (§5.8), and the composer draws the
        // target: a file dragged over the transcript is headed for the draft.
        // Not in private mode, whose turns carry only words.
        .dropDestination(for: URL.self) { urls, _ in
            let files = urls.filter(\.isFileURL)
            guard attachmentModel != nil, privateChat == nil, !files.isEmpty else { return false }
            composerRequest = ChatComposerRequest(kind: .attach(files))
            return true
        } isTargeted: { targeted in
            isDropTargeted = targeted && attachmentModel != nil && privateChat == nil
        }
    }

    /// The composer group's bottom padding: centred on the optical middle in a
    /// draft, at rest in a conversation. The empty state animates the change.
    private var composerLift: CGFloat {
        isDraft
            ? ChatComposerLift.draft(
                columnHeight: columnHeight,
                groupHeight: dockGroupHeight,
                footerHeight: dockFooterHeight
            )
            : ChatComposerLift.resting
    }

    private func open(artifact: NativeMessageContent.ArtifactReference) {
        withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
            openArtifact = DesktopChatArtifact(reference: artifact)
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
    /// final lines (``DesktopVoiceHangUp``); a row built here that also persisted
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
    ///
    /// From a draft, dialling is the handoff (§10.1): the call takes the
    /// greeting's place, so the session is set inside the handoff's
    /// transaction and the composer settles to its dock as the call bar
    /// appears in it.
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
        withAnimation(JunoMotion.handoff(reduceMotion: reduceMotion)) {
            voiceSession = started
        }
        // Dialled from here rather than from the call bar's `task`: the bar can
        // be rebuilt over the same session, and `start()` is legal from
        // `ended`, which would make a second appearance silently redial.
        Task { await started.controller.start(provider: initialProvider) }
    }

    private var composer: some View {
        ChatComposer(
            model: model,
            attachmentModel: attachmentModel,
            libraryModel: configuration.libraryModel,
            projectModel: configuration.projectModel,
            workspaceModel: configuration.projectWorkspaceModel,
            documentIndex: configuration.documentIndexModel,
            connectorModel: configuration.connectorModel,
            memorySettings: configuration.memorySettingsModel,
            draftProjectID: $draftProjectID,
            draftPrompt: $draftPrompt,
            openVoiceMode: startVoice,
            privateChat: privateChat,
            onFirstTurn: firstTurn,
            quota: ChatComposerQuota(plan: plan),
            isDropTargeted: isDropTargeted,
            request: composerRequest,
            editLastMessage: canEditLastMessage ? { editLastRequest = UUID() } : nil,
            manageConnections: configuration.connectorModel == nil
                ? nil : { openDestination(.connections) },
            // Settings › Plan & billing until the Upgrade sheet lands
            // (Phase 3): the one place in the app that can change a plan.
            openUpgrade: { DesktopSettingsRouter.open(.billing, using: openSettings) }
        )
        // The call is drawn inside the composer's own shell (§5.8): announced
        // here, it turns the controls row into the call bar.
        .junoVoiceCall(voiceColumn)
    }

    /// Whether ↑ has a message to reopen: one you sent, saved, and not mid-reply.
    private var canEditLastMessage: Bool {
        !isDraft && privateChat == nil && !model.isGenerating
            && model.selectedMessages.contains { $0.role == .user && !$0.isPending }
    }

    /// Re-reading the plan more often than this adds requests and no
    /// information; a reply ending inside the window is not worth a second call.
    private static let planReadFloor: TimeInterval = 15

    private func readPlan() async {
        guard let sender = configuration.requestSender else { return }
        if plan != nil, let planReadAt, Date().timeIntervalSince(planReadAt) < Self.planReadFloor {
            return
        }
        guard let loaded = await NativeUsageClient(sender: sender).loadPlan(for: session.profile.id) else {
            return
        }
        planReadAt = Date()
        plan = loaded
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
    /// Turns this column shows that have no row in the store: a private chat's
    /// (§5.8), or the stand-in for a new chat's first turn while the store is
    /// still creating it (§10.1). Drawn by the same row as everything else,
    /// with no actions — there is nothing on the server to act on.
    var localMessages: [NativeChatMessage] = []
    /// A private chat's failure, where its reply would have been.
    var localError: String? = nil
    /// Whether the store's own state — approvals, follow-ups, research, its
    /// errors — belongs to this column. Not in a private chat, which has no
    /// conversation for any of them to describe.
    var showsStoreState = true
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
    /// The window's Share — publish, copy, and say so in the Share popover;
    /// nil when the account has no share service. Reached from every reply's
    /// action row, as on the web, not only from the toolbar.
    let share: (() -> Void)?
    /// A new value asks the last message you sent to open for editing — ↑ in
    /// the composer's empty field (§5.9). The row owns its editor; this only
    /// says "now".
    var editLastRequest: UUID? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var actionError: String?
    @State private var speechPlayback = DesktopSpeechPlayback()
    /// The index from which rows rise in, so opening a conversation does not
    /// replay every entrance it ever had. See ``noteMessages(from:to:)``.
    @State private var animateFrom = Int.max
    /// The conversation whose count `animateFrom` was last seeded against.
    @State private var settledConversationID: String?
    /// The same gate for ``localMessages``. It starts at zero, because the
    /// transcript is only ever built with local turns in it at the handoff —
    /// and those are the turns that rise, a beat after the greeting leaves.
    @State private var localAnimateFrom = 0

    /// The web's `max-w-3xl` reading column. See ``DesktopChatMeasure``.
    static let readingWidth: CGFloat = DesktopChatMeasure.reading

    private var lastAssistantMessageID: String? {
        model.selectedMessages.last(where: { $0.role == .assistant })?.id
    }

    private var lastUserMessageID: String? {
        model.selectedMessages.last(where: { $0.role == .user && !$0.isPending })?.id
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
                            isGenerating: model.isGenerating,
                            editRequest: message.id == lastUserMessageID ? editLastRequest : nil
                        )
                        .modifier(DesktopMessageRise(rises: index >= animateFrom))
                        .id(message.id)
                    }

                    // A private chat's turns, or a first turn on its way to
                    // the store. Those present when the transcript is built are
                    // the handoff's (§10.1), and rise a beat after it starts.
                    ForEach(Array(localMessages.enumerated()), id: \.element.id) { index, message in
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
                            openArtifact: { _ in },
                            branchPosition: nil,
                            stepBranch: nil,
                            editMessage: nil,
                            isGenerating: message.isPending
                        )
                        .modifier(
                            DesktopMessageRise(
                                rises: index >= localAnimateFrom,
                                delay: localAnimateFrom == 0 ? DesktopChoreography.firstTurnBeat : 0
                            )
                        )
                        .id(message.id)
                    }

                    if let localError {
                        DesktopChatError(message: localError, canRetry: false, retry: {})
                    }

                    // Connector approvals are not prose and must stay above the
                    // pending answer they block. The receipt is recovered from
                    // `/api/approvals` as well as from the live stream, so this
                    // card remains answerable after a cold launch or a missed
                    // SSE frame.
                    if showsStoreState, let conversationID = model.selectedConversationID {
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

                    if showsStoreState, model.isGenerating, !model.researchActivity.isEmpty {
                        DesktopResearchActivity(items: model.researchActivity)
                    }

                    // Under the last reply, once it has settled. Inside the stack
                    // so it scrolls with the transcript rather than floating over
                    // it, and clamped to the reading column like everything else.
                    if showsStoreState, let conversationID = model.selectedConversationID {
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

                    if showsStoreState, let error = model.chatErrorDescription {
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
            // A private turn arriving, or a private reply growing: the same
            // two cases as the store's messages above.
            .onChange(of: localMessages) { previous, current in
                if current.count != previous.count {
                    localAnimateFrom = current.count < previous.count ? current.count : previous.count
                    withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                        proxy.scrollTo("transcript-bottom", anchor: .bottom)
                    }
                } else {
                    proxy.scrollTo("transcript-bottom", anchor: .bottom)
                }
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
    /// How long to wait before rising, in seconds. The handoff's first bubble
    /// waits a beat, so the greeting is visibly leaving before it arrives.
    var delay: TimeInterval = 0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var risen: Bool

    /// A row that is not rising starts *already* risen rather than being set
    /// there by `onAppear`. Seeded the other way it spent its first frame at zero
    /// opacity, which on a lazily-built stack means every old message flickers as
    /// the reader scrolls back through the conversation.
    init(rises: Bool, delay: TimeInterval = 0) {
        self.rises = rises
        self.delay = delay
        _risen = State(initialValue: !rises)
    }

    func body(content: Content) -> some View {
        content
            .opacity(risen ? 1 : 0)
            // Under Reduce Motion the travel is dropped and the fade keeps its
            // timing — the tint tier — so a new turn still arrives rather than
            // appearing.
            .offset(y: risen ? 0 : JunoMotion.shift(DesktopChoreography.riseDistance, reduceMotion: reduceMotion))
            .onAppear {
                guard rises else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion, tier: .tint)?.delay(delay)) {
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
    /// Whether this turn has no row in the store yet: a spoken line from a call
    /// that is still running, a private chat's turn, or a first turn the store
    /// is still creating.
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
    /// The toolbar's Share and its popover, reachable from the row as it is on
    /// the web.
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
    /// A new value opens this message's editor, as its Edit action does. Set
    /// only on the last message you sent, by ↑ in the composer.
    var editRequest: UUID? = nil

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
        .onChange(of: editRequest) { _, request in
            guard request != nil, editMessage != nil, !isGenerating, !editing else { return }
            draft = plainText
            editing = true
        }
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
                // The card's one prominent button, in the accent the column
                // is tinted with — bordered, not glass: the editor is content
                // on the transcript (§0.1).
                Button("Save & resend") { submitEdit() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSubmitEdit)
                    .buttonStyle(.borderedProminent)
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
    ///
    /// A plain row, not a glass container: the actions are content on the
    /// transcript (§0.1), drawn with ``DesktopMessageActionStyle``.
    private func actionRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 0) { content() }
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
        .menuStyle(.button)
        .buttonStyle(DesktopMessageActionStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Regenerate")
        .accessibilityLabel("Regenerate")
    }
}

/// One action on a message row. `active` is a pressed thumb.
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
        .buttonStyle(DesktopMessageActionStyle())
        .help(label)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

/// A message action's hover and press: the opaque content recipe, not glass.
///
/// The actions are content on the transcript (§0.1, §10.2 #1), and they sit
/// below the detail column's accent tint (§1.2) — so the system glass button
/// they used to wear lit up coral under the pointer, spending the accent on a
/// row of icons (§0.4). The hover is the web's neutral `hover:bg-accent` on the
/// canvas; the glyph keeps the ink ``DesktopMessageActionMark`` gives it.
private struct DesktopMessageActionStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Action(configuration: configuration)
    }

    private struct Action: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovered = false
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .opacity(isEnabled ? 1 : 0.5)
                .background {
                    RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous)
                        .fill(Color.junoHover)
                        .opacity(hovered && isEnabled ? 1 : 0)
                }
                .contentShape(.rect)
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1)
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

/// The website's mark shared by the native buttons and menu trigger.
private struct DesktopMessageActionMark: View {
    let icon: JunoIcon
    let active: Bool
    let tint: Color?

    var body: some View {
        JunoIconView(icon, size: 16)
            .foregroundStyle(tint ?? (active ? Color.junoForeground : Color.junoMutedForeground))
            .frame(width: 28, height: 28)
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
            .junoCard(cornerRadius: JunoRadius.card)
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
        DisclosureGroup(isExpanded: $expanded) {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 120), spacing: JunoSpace.tight)],
                alignment: .leading,
                spacing: JunoSpace.tight
            ) {
                ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                    Link(destination: source.url) {
                        HStack(spacing: JunoSpace.hairline) {
                            Text(host(of: source.url))
                                .junoCaption()
                                .lineLimit(1)
                            Text((index + 1).formatted())
                                .junoCodeSmall()
                                .monospacedDigit()
                        }
                        .padding(.horizontal, JunoSpace.snug)
                        .padding(.vertical, JunoSpace.hairline)
                        .background(Capsule().fill(Color.junoMuted))
                        .overlay(Capsule().strokeBorder(Color.junoHairline, lineWidth: 0.5))
                    }
                    .buttonStyle(.plain)
                    .help(source.url.absoluteString)
                }
            }
            .padding(.top, JunoSpace.snug)
        } label: {
            Label("Sources (\(sources.count))", icon: .web)
                .junoRowLabel()
        }
        .padding(JunoSpace.cozy)
        .junoCard(cornerRadius: JunoRadius.card)
        .frame(maxWidth: 576, alignment: .leading)
        .accessibilityElement(children: .contain)
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
            GroupBox("Research activity") {
                JunoAIcssWebSearch(
                    query: query,
                    sites: sites,
                    settled: NativeSearchActivity.settled(in: items)
                )
                .padding(.top, JunoSpace.tight)
            }
            .padding(JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
            .junoCard(cornerRadius: JunoRadius.card)
        }
    }
}

private struct DesktopChatError: View {
    let message: String
    let canRetry: Bool
    let retry: () -> Void

    var body: some View {
        GroupBox {
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
