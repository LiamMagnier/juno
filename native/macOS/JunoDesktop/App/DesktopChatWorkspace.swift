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
import QuickLook
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
    /// One agent's page — a row in the column's Agents fold.
    case agent(String)
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
    /// Where a tapped notification asked Chat to go — an agent's page or a
    /// thread. Consumed once, the way the unscoped request above is.
    var route: DesktopWorkbenchRegistry.RouteRequest? = nil
    var consumeRoute: (() -> Void)? = nil
    @SceneStorage("juno.desktop.destination") private var storedDestination =
        DesktopDestination.chat.rawValue
    /// The agent whose page is open on the Agents destination; empty for the
    /// roster. The window's rather than the screen's, because the column
    /// selects it — an agent's row, and the notification that names one — and
    /// highlights the row of whichever is open. Scene storage for the reason
    /// the destination is: coming back from Code returns to the same page.
    @SceneStorage("juno.desktop.agent") private var storedAgentID = ""
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
    /// A task with no conversation, open in its sheet (register #63).
    @State private var taskRecord: DesktopTaskRecordPresentation?
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
    /// Delete…, asking first in the web's words (Phase 3 B6).
    @State private var deleteConfirmation: JunoConfirmation?
    @State private var newProjectRequest: DesktopNewProjectRequest?
    @State private var share = DesktopShareState()
    /// The ⌘K / Search panel (Phase 3 B1): one per window, over the split
    /// view, centred on the detail column that `ChatDetail` measures.
    @State private var searchPanel = DesktopSearchPanelModel()
    @State private var panelAnchor = DesktopPanelAnchor()
    /// Archived Chats (Phase 3 B5). Nothing on this base opens it yet: the
    /// sidebar's More reaches it at integration (seam 8).
    @State private var showingArchivedChats = false
    /// The sidebar's Notifications popover, held here so ⌘K's "Open
    /// notifications" opens the same one (Phase 3 seam 3).
    @State private var showingNotifications = false
    /// The toolbar's Outputs popover (Phase 3 B3).
    @State private var isOutputsPresented = false
    /// Artifact and Quick Look requests from the toolbar and the panel, on
    /// their way to the conversation column that owns both.
    @State private var outputRequests = DesktopChatOutputRequests()
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openSettings) private var openSettings
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openURL) private var openURL
    /// ⌘U from the menu bar, or a file dropped on the chat column, on its way
    /// to the composer — which owns the importer and the attachment rules.
    @State private var composerRequest: ChatComposerRequest?
    /// ⌘F, ⌘G and ⇧⌘G from the menu bar, on their way to the conversation
    /// column's find bar.
    @State private var findCommand: DesktopFindCommand?
    /// The window's toasts (§7.7): one host, drawn over the detail column by
    /// ``ChatDetail``, posted to from the sidebar, the transcript and every
    /// page through `@Environment(\.junoToast)`.
    @State private var toasts = JunoToastCenter()
    /// Whether this window is the key one, so a rise in tasks needing the
    /// reader is toasted here and not in a window behind it.
    @Environment(\.appearsActive) private var appearsActive
    /// The account's task signals (Phase 5 C1–C2), read by the column.
    @State private var needsYouSignals = DesktopNeedsYouSignals.shared

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
                store(value)
            }
        )
    }

    /// Writes a destination to scene storage as the destination it really
    /// means (``DesktopNavigationState/normalized(_:)``): `.design` is stored
    /// as Artifacts and asks the Artifacts page for its Designs filter.
    private func store(_ value: DesktopDestination) {
        let normalized = DesktopNavigationState.normalized(value)
        storedDestination = normalized.destination.rawValue
        if normalized.artifactsType != nil {
            pageRouter.open(value)
        }
    }

    private var pageRouter: DesktopPageRouter { .shared }

    /// A request from outside the window (``DesktopPageRouter``): switch to
    /// its destination and leave the push to that destination's stack. Chat
    /// has no stack, so a request for it is done once the switch is.
    private func followPageRequest() {
        guard let request = pageRouter.pending else { return }
        overrideDestination = nil
        storedDestination = request.destination.rawValue
        if request.destination == .chat {
            pageRouter.consume(request)
        }
    }

    /// Open in Conversation: the chat, then the canvas on that row by id.
    private func followCanvasRequest() {
        guard let request = pageRouter.pendingCanvas else { return }
        openConversation(request.conversationID)
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
                    openProjectID: openPinnedProjectID,
                    selectedAgentID: selectedAgentID
                )
            },
            set: { item in
                // Only a pinned project's row deep-links into a project; every
                // other selection opens its destination's root.
                if case .project(let id) = item {
                    requestedProjectID = id
                    // Pushed on the Projects stack (Phase 4 A5), not swapped in.
                    pageRouter.open(.projects, route: .project(id))
                } else {
                    requestedProjectID = nil
                }
                let resolved = DesktopNavigationState.resolve(
                    selection: item,
                    current: (currentDestination, model.selectedConversationID, selectedAgentID)
                )
                overrideDestination = nil
                store(resolved.destination)
                storedAgentID = resolved.agentID ?? ""
                model.selectedConversationID = resolved.conversationID
                model.isDraftingNewConversation = resolved.isDrafting
                // Choosing anything in the column leaves a private chat — and
                // leaving it is what erases it.
                if item != nil { isPrivateChat = false }
            }
        )
    }

    private var selectedAgentID: String? {
        storedAgentID.isEmpty ? nil : storedAgentID
    }

    /// The open agent, as the Agents screen reads and writes it. The page's
    /// back control writes nil, which hands the highlight back to the Agents
    /// row.
    private var agentSelection: Binding<String?> {
        Binding(
            get: { selectedAgentID },
            set: { storedAgentID = $0 ?? "" }
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
                openSearch: openSearch,
                agentsModel: configuration.agentsModel,
                messageAgent: messageAgent,
                hireAgent: configuration.agentsModel == nil
                    ? nil
                    : { pageRouter.open(.agents, route: .newAgent(template: nil)) },
                runs: needsYouSignals.runs,
                notificationsModel: configuration.notificationsModel,
                showingNotifications: $showingNotifications,
                openArchivedChats: { showingArchivedChats = true }
            )
            .junoSidebarColumn()
        } detail: {
            detail
        }
        // The ⌘K / Search panel, over the whole window (Phase 3 B1).
        .desktopSearchPanel(
            searchPanel,
            anchor: panelAnchor,
            hooks: panelHooks,
            projects: configuration.projectModel?.projects ?? [],
            commands: { panelCommandContext },
            perform: performPanelAction
        )
        .focusedSceneValue(\.junoWorkspaceActions, workspaceActions)
        .junoChatCommands(chatCommands)
        // Every part of the window posts to the one host: the sidebar's
        // archive, the transcript's failed actions, the pages.
        .junoToastNotifier(toasts)
        // The web's words (`app-sidebar.tsx`), "Delete Chat" on the button.
        .junoConfirmation($deleteConfirmation)
        .confirmationDialog("Leave incognito?", isPresented: $confirmingLeavePrivate, titleVisibility: .visible) {
            Button("Leave", role: .destructive) { isPrivateChat = false }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It won't be saved.")
        }
        // The key window hosts the toast a rise in waiting tasks posts.
        .onChange(of: appearsActive, initial: true) { _, active in
            if active { needsYouSignals.adoptToastHost(toasts) }
        }
        .sheet(isPresented: $showingArchivedChats) {
            archivedChatsSheet
        }
        .sheet(item: $newProjectRequest) { request in
            if let projectModel = configuration.projectModel {
                DesktopNewProjectForm(model: projectModel) { projectID in
                    projectCreated(projectID, for: request)
                }
            }
        }
        .sheet(item: $taskRecord) { presentation in
            DesktopTaskRecordSheet(
                work: presentation.work,
                files: presentation.files,
                pairedHostID: configuration.workHostModel?.pairedHostID,
                close: { taskRecord = nil }
            )
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
            // After the launch seed above, which clears the conversation: a
            // notification that launched the app is followed rather than
            // overwritten by the launch surface.
            followPendingRoute()
            // A window restored on the retired Design page, or one the legacy
            // tasks window sent to Design: Artifacts with the Designs filter.
            if storedDestination == DesktopDestination.design.rawValue {
                store(.design)
            }
            followPageRequest()
            followCanvasRequest()
        }
        .onChange(of: pageRouter.pending) { _, _ in followPageRequest() }
        .onChange(of: pageRouter.pendingCanvas) { _, _ in followCanvasRequest() }
        .onChange(of: unscopedChatRequestID) { _, _ in
            consumePendingUnscopedChatRequest()
        }
        .onChange(of: route) { _, _ in
            followPendingRoute()
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
            isOutputsPresented = false
            guard DesktopShareState.selectionClosesPopover(sharing: share.conversationID, selected: selected)
            else { return }
            share.close()
        }
        .onChange(of: currentDestination) { _, value in
            guard value != .chat else { return }
            share.close()
            isOutputsPresented = false
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
            toolbar: toolbar,
            toasts: toasts,
            panelAnchorChanged: { panelAnchor = $0 }
        ) {
            destinationContent
                // The toolbar's popovers and the panel ask the conversation
                // column to open an artifact or a file through this.
                .environment(outputRequests)
                // One media loader per signed-in account, for the transcript
                // and the composer that seeds it. A different account is a
                // new loader with an empty cache.
                .modifier(
                    TranscriptMediaScope(sender: configuration.requestSender, accountID: session.profile.id)
                )
                // And one design-preview loader, for the pictures of the
                // designs replies carry.
                .modifier(
                    DesignPreviewScope(sender: configuration.requestSender, accountID: session.profile.id)
                )
                .id(session.profile.id)
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
            selectedAgentID: agentSelection,
            composerRequest: $composerRequest,
            findCommand: $findCommand,
            isPrivateChat: isPrivateChat,
            callActiveChanged: { isInCall = $0 },
            shareConversation: replyShare,
            forkPrivately: replyFork
        )
    }

    /// A turn's Fork Privately. Nil without a private chat to start, which
    /// leaves the action off every turn.
    private var replyFork: (([NativePrivateChatModel.Turn]) -> Void)? {
        guard configuration.privateChatModel != nil else { return nil }
        return { turns in forkPrivately(turns) }
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
            outputs: outputsContext,
            isOutputsPresented: $isOutputsPresented,
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

    /// Opens the Share popover on the open conversation (Phase 3 B2), which
    /// makes its link. The route is idempotent per conversation, so sharing
    /// twice yields the same link; nothing reaches the pasteboard until Copy.
    private func shareSelectedConversation() {
        guard let client = configuration.shareClient,
              let conversationID = model.selectedConversationID
        else { return }
        isOutputsPresented = false
        share.start(
            .chat(conversationID),
            service: DesktopNativeShareService(client: client, accountID: session.profile.id)
        )
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

    /// Fork Privately (§3.2 of the Phase 2 brief): a new private chat that
    /// starts from the turns up to the message it was chosen on — the web's
    /// `handleFork`. Refused over a live call, whose transcript is filed as a
    /// conversation, as ⇧⌘N is.
    private func forkPrivately(_ turns: [NativePrivateChatModel.Turn]) {
        guard let privateModel = configuration.privateChatModel, !isInCall else {
            NSSound.beep()
            return
        }
        beginDraft()
        // A private turn carries only its words: nothing attached rides along.
        configuration.attachmentModel?.clear()
        privateModel.reset()
        guard privateModel.seed(turns) else { return }
        isPrivateChat = true
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
                columnVisibility = DesktopChatRename.columns(forRenameFrom: columnVisibility)
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
            delete: { conversation in
                deleteConfirmation = DesktopChatDeletion.confirmation { deleteConversation(conversation) }
            }
        )
    }

    /// Archives or restores a chat, and registers the opposite with the
    /// window's undo manager — so Edit › Undo Archive Chat (⌘Z) brings it
    /// back, and Redo sends it away again.
    ///
    /// An archive also says so, as the web does (`app-sidebar.tsx`): "Chat
    /// archived." with Undo, in the window's toast host (§2.4, §7.7).
    private func setArchived(_ id: String, archived: Bool, undoManager: UndoManager?) {
        if archived, model.selectedConversationID == id {
            beginDraft()
        }
        Self.applyArchive(id, archived: archived, model: model, undoManager: undoManager)
        guard archived else { return }
        let model = model
        toasts.post(
            .success(
                "Chat archived.",
                action: JunoToast.Action("Undo") {
                    Task { await model.setArchived(id: id, archived: false) }
                }
            )
        )
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

    /// Deletes a conversation Delete… asked about. A real delete — the
    /// store enqueues `conversation.delete` — which is why it asks first. A
    /// delete the store could not take leaves the row where it was and says
    /// "Delete failed.", as the web does.
    private func deleteConversation(_ conversation: NativeConversation) {
        if model.selectedConversationID == conversation.id {
            beginDraft()
        }
        let model = model
        let toasts = toasts
        Task {
            await model.deleteConversation(id: conversation.id)
            if !DesktopChatDeletion.succeeded(id: conversation.id, in: model.conversations) {
                toasts.post(.error(DesktopChatDeletion.failure))
            }
        }
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
        pageRouter.open(.projects, route: .project(projectID))
    }

    /// The sidebar's Search and ⇧⌘F: the panel, in Search.
    private func openSearch() {
        presentSearchPanel(.search)
    }

    /// Opens the ⌘K / Search panel in `mode`. Any popover anchored below is
    /// closed first (crash rule 4). Seam 1 wires ⌘K to `.commands` here.
    private func presentSearchPanel(_ mode: DesktopSearchPanelModel.Mode) {
        share.close()
        isOutputsPresented = false
        searchPanel.services = panelServices
        searchPanel.present(mode)
    }

    // MARK: The panel (Phase 3 B1)

    /// The seams (Phase 3 brief §2.3, rows 3–6), wired to the pages and
    /// sheets the other lanes built. A row whose hook is nil stays absent.
    private var panelHooks: DesktopCommandCatalog.Hooks {
        var hooks = DesktopCommandCatalog.Hooks()
        if configuration.notificationsModel != nil {
            hooks.openNotifications = openNotifications
        }
        // Always, as the web's "Plans & upgrade" row is; the sheet itself
        // says what the reader's plan is.
        hooks.openUpgrade = { DesktopUpgradePresenter.shared.present(in: .chat) }
        hooks.openPage = openPanelPage
        if configuration.workModel != nil {
            hooks.openTaskRecord = { sessionID in Task { await openWorkSession(sessionID) } }
        }
        return hooks
    }

    /// The Notifications popover, from ⌘K: on its row, so the column is shown
    /// first when it was hidden.
    private func openNotifications() {
        if columnVisibility == .detailOnly { columnVisibility = .all }
        showingNotifications = true
    }

    /// A page ⌘K names (seam 5), through the Phase 4 router: the destination,
    /// and the route its stack pushes.
    private func openPanelPage(_ page: DesktopPanelPage) {
        switch page {
        case .skills: pageRouter.open(.skills)
        case .automations: pageRouter.open(.automations)
        case .newAutomation: pageRouter.open(.automations, route: .newAutomation)
        case .assistants: pageRouter.open(.assistants)
        case .newAssistant: pageRouter.openNewAssistant()
        case .permissions: pageRouter.open(.permissions)
        // Design is a type in Artifacts (Phase 4 A2): the Designs filter, and
        // for New design its size menu, as the web's `?new=design`.
        case .designs: pageRouter.open(.design)
        case .newDesign: pageRouter.open(.design, opensNewMenu: true)
        case .newAgent: pageRouter.open(.agents, route: .newAgent(template: nil))
        }
    }

    /// What Search searches with: this Mac's encrypted store, the server's
    /// unified search for what only it holds, and the Recent list.
    private var panelServices: DesktopSearchPanelModel.Services {
        var services = DesktopSearchPanelModel.Services()
        let accountID = session.profile.id
        if let store = configuration.localStore {
            let index = NativeSearchStore(repository: store)
            services.localSearch = { query in
                try await index.search(accountID: StorageAccountID(accountID.rawValue), query: query)
            }
        }
        if let sender = configuration.requestSender {
            let client = NativeUnifiedSearchClient(sender: sender)
            services.serverSearch = { query, types, projectID, window in
                try await client.search(query: query, types: types, projectID: projectID, window: window, for: accountID)
            }
            services.recents = { try await client.recents(limit: 8, for: accountID) }
        }
        let model = model
        let projectModel = configuration.projectModel
        services.localRecents = {
            DesktopSearchPanelModel.localRecents(
                conversations: model.conversations,
                projects: projectModel?.projects ?? [],
                codeSessions: DesktopPanelCodeSession.fromWorkbench()
            )
        }
        let authModel = configuration.authModel
        let syncModel = configuration.syncModel
        services.isOffline = {
            DesktopOfflineState.resolve(connectivity: authModel.connectivity, syncPhase: syncModel?.phase) != nil
        }
        services.projectOfConversation = { id in
            model.conversations.first { $0.id == id }?.projectId
        }
        let workModel = configuration.workModel
        services.localTasks = { workModel?.sessions ?? [] }
        return services
    }

    /// What the Command menu lists besides its fixed rows.
    private var panelCommandContext: DesktopCommandCatalog.Context {
        DesktopCommandCatalog.Context(
            conversations: model.conversations,
            codeSessions: DesktopPanelCodeSession.fromWorkbench(),
            projects: configuration.projectModel?.projects ?? [],
            isDark: isDarkNow
        )
    }

    /// The theme as drawn: the account's choice, or the system's.
    private var isDarkNow: Bool {
        DesktopThemeToggle.isDark(theme: configuration.memorySettingsModel?.settings?.theme, drawn: colorScheme)
    }

    /// Runs a row the panel handed back. Each case lands on an action this
    /// window already has.
    private func performPanelAction(_ action: DesktopPanelAction) {
        switch action {
        case .newChat:
            beginDraft()
        case .newPrivateChat:
            beginPrivateDraft()
        case .newCodeSession:
            DesktopWorkbenchRegistry.shared.request(.newCodeTask(prompt: nil))
        case .page(let page):
            openPanelPage(page)
        case .searchEverything:
            presentSearchPanel(.search)
        case .toggleSidebar:
            columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
        case .openNotifications:
            panelHooks.openNotifications?()
        case .openCode:
            product = .code
        case .destination(let target):
            if target == .projects { requestedProjectID = nil }
            selection.wrappedValue = .destination(target)
        case .roadmap:
            openWebPath("/roadmap")
        case .conversation(let id, _):
            Task { await openThread(id) }
        case .codeSession(let id):
            DesktopWorkbenchRegistry.shared.request(.openSession(id))
        case .project(let id):
            openProject(id)
        case .settings:
            DesktopSettingsRouter.open(.general, using: openSettings)
        case .upgrade:
            panelHooks.openUpgrade?()
        case .toggleTheme:
            toggleAccountTheme()
        case .keyboardShortcuts:
            openWindow(id: JunoDesktopWindow.shortcutsID)
        case .artifact(let id, let conversationID):
            openArtifact(id: id, conversationID: conversationID)
        case .taskRecord(let sessionID):
            panelHooks.openTaskRecord?(sessionID)
        case .web(let path):
            openWebPath(path)
        }
    }

    /// ⌘K's Switch to Dark/Light Mode: the same toggle as the menu bar's
    /// ⇧⌘L (``DesktopThemeToggle``, seam 13).
    private func toggleAccountTheme() {
        DesktopThemeToggle.action(settingsModel: configuration.memorySettingsModel, drawn: colorScheme)?.perform()
    }

    private func openWebPath(_ path: String) {
        guard let url = URL(string: JunoBackend.productionURLString + path) else { return }
        openURL(url)
    }

    /// An artifact from Search: its conversation with the canvas open when
    /// this Mac holds it, the Artifacts page otherwise.
    private func openArtifact(id: String, conversationID: String?) {
        guard let artifact = configuration.artifactModel?.artifacts.first(where: { $0.id == id }) else {
            selection.wrappedValue = .destination(.artifacts)
            return
        }
        let conversation = conversationID ?? artifact.conversationID
        openConversation(conversation)
        outputRequests.post(
            .artifact(DesktopChatOutputRequests.reference(for: artifact), conversationID: conversation)
        )
    }

    // MARK: Outputs (Phase 3 B3)

    /// What the open chat made and used, for the toolbar's Outputs chip.
    private var outputsContext: DesktopOutputsContext {
        guard currentDestination == .chat, !isPrivateChat,
            let conversationID = model.selectedConversationID
        else { return DesktopOutputsContext() }
        let artifacts = ChatSessionOutputs.conversationArtifacts(
            configuration.artifactModel?.artifacts ?? [],
            conversationID: conversationID
        )
        let model = model
        let outputRequests = outputRequests
        return DesktopOutputsContext(
            outputs: ChatSessionOutputs.read(
                artifacts: artifacts,
                messages: model.selectedMessages,
                modelName: { id in model.model(withID: id)?.displayName ?? junoDisplayModelName(id) }
            ),
            sender: configuration.requestSender,
            accountID: session.profile.id,
            openArtifact: { tile in
                guard let artifact = artifacts.first(where: { $0.id == tile.id }) else { return }
                outputRequests.post(
                    .artifact(DesktopChatOutputRequests.reference(for: artifact), conversationID: conversationID)
                )
            },
            quickLook: { attachment in outputRequests.post(.quickLook(attachment)) }
        )
    }

    // MARK: Archived Chats (Phase 3 B5)

    private var archivedChatsSheet: some View {
        let model = model
        return DesktopArchivedChatsSheet(
            load: DesktopArchivedChats.load(phase: model.phase, conversations: model.conversations),
            restore: { conversation in
                await model.setArchived(id: conversation.id, archived: false)
                return model.conversations.first { $0.id == conversation.id }?.isArchived == false
            },
            delete: { conversation in
                await model.deleteConversation(id: conversation.id)
                return DesktopChatDeletion.succeeded(id: conversation.id, in: model.conversations)
            },
            open: { id in openConversation(id) },
            done: { showingArchivedChats = false }
        )
        .presentationSizing(.fitted)
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

    /// Opens a thread this Mac may not have synced yet — an agent's, created on
    /// the server the first time it is asked for, or one a notification names.
    /// `NativeConversationModel.reload()` drops a selection its store does not
    /// contain, so the store is brought up to date before the thread is
    /// selected, as the agent page's Message does.
    private func openThread(_ id: String) async {
        if !model.conversations.contains(where: { $0.id == id }) {
            await configuration.syncModel?.refresh()
            await model.reload()
        }
        openConversation(id)
    }

    /// The apps an agent may be given: only the connected ones, by name.
    private var agentApps: [NativeAgentAppChoice] {
        (configuration.connectorModel?.linked ?? [])
            .filter(\.connected)
            .map { NativeAgentAppChoice(id: $0.id, label: $0.label) }
    }

    /// The Agents fold's Message: the agent's thread, created if it has none.
    private func messageAgent(_ agentID: String) {
        guard let agentsModel = configuration.agentsModel else { return }
        Task {
            guard let id = await agentsModel.threadConversationID(for: agentID) else { return }
            await openThread(id)
        }
    }

    /// A notification's destination, once.
    private func followPendingRoute() {
        guard let route else { return }
        consumeRoute?()
        switch route.route {
        case .agent(let id):
            selection.wrappedValue = .agent(id)
        case .conversation(let id):
            Task { await openThread(id) }
        case .workSession(let id):
            Task { await openWorkSession(id) }
        }
    }

    /// A task's notification opens the task's chat, as the web redirects
    /// `/work/{id}` to `/chat/{conversationId}`; a task with no conversation
    /// opens its sheet (register #63).
    ///
    /// A task newer than the model's last poll is not in its list yet, and an
    /// archived one never is, so a missing id refreshes the list once and
    /// then asks for the task itself. One that still cannot be read opens the
    /// sheet by id, which says so and offers Try Again.
    private func openWorkSession(_ id: String) async {
        guard let workModel = configuration.workModel else { return }
        var task = workModel.sessions.first { $0.sessionID == id }
        if task == nil {
            await workModel.refresh()
            task = workModel.sessions.first { $0.sessionID == id }
        }
        if task == nil {
            task = try? await workModel.transport.session(id: id, for: session.profile.id).session
        }
        if let conversationID = task?.conversationID {
            await openThread(conversationID)
        } else {
            presentTaskRecord(id, session: task)
        }
    }

    /// Opens a task's sheet with a follower keyed on it.
    private func presentTaskRecord(_ sessionID: String, session task: WorkSessionSummary?) {
        guard let workModel = configuration.workModel else { return }
        let work = NativeConversationWork(
            sessionID: sessionID, session: task, client: workModel.transport, accountID: session.profile.id
        )
        work.isVisible = true
        if let host = configuration.workHostModel {
            work.localApprovals = { runID in host.localApprovals(forRun: runID) }
            work.localApprovalDecider = { approval, decision in
                host.localApprovalDecider?(approval.id, decision, approval.actionDigest)
            }
        }
        // The web's `juno:work-sync`: the account's list hears of it.
        work.didAct = { [weak workModel] in await workModel?.refresh() }
        taskRecord = DesktopTaskRecordPresentation(
            work: work,
            files: ChatWorkFiles(client: workModel.transport, accountID: session.profile.id)
        )
    }

    /// What the menu bar can do to this window while it is focused.
    private var workspaceActions: DesktopWorkspaceActions {
        // Find in this conversation: wherever a conversation is on screen —
        // a saved one, or a private chat with turns in it.
        var findInConversation: ((DesktopFindCommand.Kind) -> Void)?
        if currentDestination == .chat,
            model.selectedConversationID != nil || (isPrivateChat && configuration.privateChatModel?.isEmpty == false)
        {
            findInConversation = { kind in findCommand = DesktopFindCommand(kind: kind) }
        }
        return DesktopWorkspaceActions(
            newItem: beginDraft,
            newChat: beginDraft,
            openSearch: openSearch,
            switchProduct: { product = $0 },
            currentProduct: product,
            // ⌘K: the command panel in Commands (Phase 3 seam 1).
            openCommandMenu: { presentSearchPanel(.commands) },
            findInConversation: findInConversation,
            openPage: { page in performPanelAction(.destination(page)) }
        )
    }

    /// The Chat menu's actions for this window (Phase 3 A2, A3). The rules
    /// are ``ChatCommands``'; this only says what is on screen.
    private var chatCommands: DesktopChatCommandActions {
        var commands = DesktopChatCommandActions()
        // Not in private mode, whose turns carry only words: a screenshot
        // taken there would wait in the attachment tray for a chat it cannot
        // be sent in.
        if configuration.attachmentModel != nil, !isPrivateChat {
            commands.attachScreenshot = { attachScreenshot() }
            // Only where the composer is on screen to receive it.
            if currentDestination == .chat {
                commands.attachFiles = { composerRequest = ChatComposerRequest(kind: .chooseFiles) }
            }
        }
        guard currentDestination == .chat else { return commands }
        commands.focusComposer = { composerRequest = ChatComposerRequest(kind: .focus) }
        // The conversation items: a saved chat, as the title menu has it.
        if let conversation = titleMenuConversation {
            commands.conversation = conversation
            commands.projects = configuration.projectModel?.projects ?? []
            commands.conversationActions = conversationActions
        }
        // Read when chosen, not now: the transcript moves on every token.
        let model = model
        let privateModel = isPrivateChat ? configuration.privateChatModel : nil
        let toasts = toasts
        let turns: () -> [ChatCommandTurn] = {
            if let privateModel { return privateModel.turns.map(ChatCommandTurn.init) }
            return model.selectedMessages.map(ChatCommandTurn.init)
        }
        commands.copyLastResponse = { toasts.post(ChatCommands.copyLastResponse(from: turns())) }
        commands.copyLastCodeBlock = { toasts.post(ChatCommands.copyLastCodeBlock(from: turns())) }
        if let conversationID = model.selectedConversationID, privateModel == nil,
            ChatCommands.canRegenerate(
                turns: model.selectedMessages.suffix(1).map(ChatCommandTurn.init),
                isGenerating: model.isGenerating,
                isPrivate: false
            ),
            let newest = model.selectedMessages.last
        {
            // The reply's own Try Again: the store's one regenerate path.
            commands.regenerate = ChatRegenerateCommand(artifactCount: ChatCommands.artifactCount(of: newest)) {
                model.retryLastMessage(conversationID: conversationID, modelID: nil, instruction: nil)
            }
        }
        return commands
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

/// The reply the Activity panel is open on, and the call it was opened at.
struct DesktopActivityTarget: Equatable {
    var messageID: String
    var focusCallID: String?
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
                    .buttonStyle(.junoProminent)
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
    /// ⌘F, ⌘G and ⇧⌘G, for the find bar.
    @Binding var findCommand: DesktopFindCommand?
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
    /// Fork Privately: the window starts a private chat from these turns.
    /// Nil where there is no private chat to start.
    var forkPrivately: (([NativePrivateChatModel.Turn]) -> Void)? = nil
    /// Opens an agent's page by id, from the header its thread carries.
    var openAgent: ((String) -> Void)? = nil
    /// Opens an agent's thread by id: a duplicate's new thread, from the
    /// header's More.
    var openAgentThread: ((String) -> Void)? = nil
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
    /// The reply whose run the Activity panel shows, or nil when it is
    /// closed. The canvas and the panel share the dock: opening one closes
    /// the other.
    @State private var openActivity: DesktopActivityTarget?
    /// The research run the Research panel shows (`message:<id>` for research
    /// answered in the chat), or nil. It shares the dock with the canvas and
    /// Activity: the newest opener wins (SPEC §8.5).
    @State private var openResearch: String?
    /// The view the Research panel opens on — Sources, from a recap.
    @State private var openResearchTab: DesktopResearchPanel.Tab?
    /// The research receipts hidden on this Mac, for this account.
    @State private var dismissedRecaps: Set<String> = []
    @Environment(\.openWindow) private var openWindow
    /// ⌘F in this conversation.
    @State private var find = TranscriptFindModel()
    /// Sources' logos, fetched once per site for this window.
    @State private var favicons = SourceFaviconLoader()
    /// The same rule for the shared research views (Deep Field, reports).
    @State private var sourceFavicons = NativeSourceFavicons()
    /// Whether the composer's draft is empty, for the follow-up chips.
    @State private var draftIsEmpty = true
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
    /// The file Quick Look is showing, or nil. Held **here**, not in the row
    /// that asked: `.quickLookPreview` on a lazily built row loses its panel
    /// when the row scrolls away — the same reason the canvas lives here.
    @State private var quickLookURL: URL?
    /// The picture the edit sheet is open on.
    @State private var imageEditTarget: NativeChatAttachment?
    /// Why a file could not be opened or saved, for the alert.
    @State private var mediaFailure: String?
    @Environment(\.junoTranscriptMedia) private var transcriptMedia
    /// The window's toast host, for what a task action came to.
    @Environment(\.junoToast) private var toast
    /// This chat's tasks (Phase 5 A2): one follower per open, saved
    /// conversation, which the card, the composer and the Task panel all
    /// read. Never the legacy window's open session.
    @State private var conversationWork: NativeConversationWork?
    /// The task the Task panel shows, by session id, or nil when it is closed.
    @State private var openTask: String?
    /// Earlier tasks read once for the Task panel.
    @State private var taskPanelReader = ChatWorkPanelReader()
    /// Whether the window is on screen at all: discovery polls only then.
    @State private var windowVisible = true
    /// The files this account's tasks made, downloaded once and kept in the
    /// Caches directory until sign-out (Phase 5 B1).
    @State private var workFiles: ChatWorkFiles?
    /// "Save this task as a skill", open on a draft (B3).
    @State private var skillCapture: ChatSkillCaptureDraft?
    /// A task file whose bytes the validator never opened, waiting on the
    /// reader's word before it is saved.
    @State private var pendingUnvalidatedSave: NativeChatAttachment?
    /// The macOS permissions a run on this Mac needs, re-read whenever Juno
    /// comes to the front (B4).
    @State private var systemPermissions = DesktopWorkSystemPermissions.current

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
                openActivity = nil
                openResearch = nil
                openTask = nil
                find.close()
                followCanvasRequest()
            }
            // The chat's tasks, followed while it is open (Phase 5 A2). A
            // draft or a private chat follows none; switching drops the
            // follower with the chat it belonged to.
            .task(id: workFollowerKey) {
                guard let work = makeConversationWork() else {
                    conversationWork = nil
                    return
                }
                conversationWork = work
                if workFiles?.accountID != session.profile.id {
                    workFiles = ChatWorkFiles(client: configuration.workModel?.transport, accountID: session.profile.id)
                }
                adoptWorkStart()
                await work.run()
                work.close()
                if conversationWork === work { conversationWork = nil }
            }
            // A reply's `work` frame: the model started a task from this turn.
            .onChange(of: pendingWorkStartID) { _, _ in adoptWorkStart() }
            // After each reply, look again: the web discovers on `done` too.
            .onChange(of: model.isGenerating) { wasGenerating, isGenerating in
                guard wasGenerating, !isGenerating, let work = conversationWork else { return }
                Task { await work.discover() }
            }
            .onChange(of: windowVisible) { _, visible in conversationWork?.isVisible = visible }
            .background(DesktopWindowVisibilityReader { windowVisible = $0 })
            // Open in Conversation from the Artifacts page: once this chat is
            // the one on screen, the canvas opens on that row by id.
            .onAppear(perform: followCanvasRequest)
            .onChange(of: DesktopPageRouter.shared.pendingCanvas) { _, _ in followCanvasRequest() }
            .onChange(of: configuration.artifactModel?.artifacts.count) { _, _ in followCanvasRequest() }
            // The conversation's research runs, followed while it is open —
            // and again whenever a hand-off adds one.
            .task(id: session.profile.id.rawValue) {
                dismissedRecaps = Set(UserDefaults.standard.stringArray(forKey: dismissedRecapsKey) ?? [])
            }
            .task(id: "\(session.profile.id.rawValue):\(model.selectedConversationID ?? ""):\(openResearchRunKey)") {
                guard privateChat == nil, let conversationID = model.selectedConversationID else { return }
                await model.followResearch(conversationID: conversationID)
            }
            .task(id: "\(session.profile.id.rawValue):\(model.selectedConversationID ?? "")") {
                await model.refreshChatApprovals(
                    conversationID: model.selectedConversationID,
                    includeRecent: true
                )
                // What sync does not carry — each reply's sources and run —
                // and a generation still running that this Mac is not
                // streaming (reopened mid-answer).
                guard privateChat == nil, let conversationID = model.selectedConversationID else { return }
                await model.hydrateThread(conversationID: conversationID)
                await model.resumeActiveGeneration(conversationID: conversationID)
            }
            // The network is back: pick up a generation that kept running.
            .onChange(of: isOnline) { _, online in
                guard online, privateChat == nil, let conversationID = model.selectedConversationID else { return }
                Task { await model.resumeActiveGeneration(conversationID: conversationID) }
            }
            // A reply's id changes when it lands (the placeholder's becomes
            // the server's): the Activity panel follows it rather than closing.
            .onChange(of: model.selectedMessages.map(\.id)) { _, ids in
                guard let target = openActivity, !ids.contains(target.messageID) else { return }
                if target.messageID.hasPrefix("local-"),
                    let landed = model.selectedMessages.last(where: { $0.role == .assistant })
                {
                    openActivity = DesktopActivityTarget(messageID: landed.id, focusCallID: target.focusCallID)
                } else {
                    openActivity = nil
                }
            }
            .onChange(of: findCommand?.id) { _, _ in
                guard let command = findCommand else { return }
                findCommand = nil
                switch command.kind {
                case .open: find.open()
                case .next: find.isOpen ? find.next() : find.open()
                case .previous: find.isOpen ? find.previous() : find.open()
                }
                find.update(messages: findableMessages)
            }
            .onChange(of: find.query) { _, _ in find.recount() }
            .onChange(of: model.selectedMessages) { _, _ in
                if find.isOpen { find.update(messages: findableMessages) }
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
                guard started != nil, openArtifact != nil || openActivity != nil || openResearch != nil else { return }
                withAnimation(
                    JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)
                ) {
                    openArtifact = nil
                    openActivity = nil
                    openResearch = nil
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
            .quickLookPreview($quickLookURL)
            .modifier(ChatWorkPresentations(
                skillCapture: $skillCapture,
                pendingUnvalidatedSave: $pendingUnvalidatedSave,
                systemPermissions: $systemPermissions,
                saveSkill: { draft in await saveSkill(draft) },
                saveUnvalidated: { attachment in
                    guard let workFiles else { return }
                    ChatWorkFileSaving.save(attachment, from: workFiles) { mediaFailure = $0 }
                }
            ))
            // The toolbar's Outputs and the ⌘K panel open an artifact's canvas
            // or a file's Quick Look here, where both are owned.
            .desktopOutputRequests(
                conversationID: privateChat == nil ? model.selectedConversationID : nil,
                openArtifact: { open(artifact: $0) },
                quickLook: { attachment in withFile(attachment) { quickLookURL = $0 } }
            )
            .sheet(item: $imageEditTarget) { target in
                imageEditSheet(target)
            }
            // Opener and action on one line: the targets gate reads a dialog's
            // buttons as system-drawn only when its brace opens on that line.
            .alert("Couldn’t open the file", isPresented: mediaFailurePresented, presenting: mediaFailure) { _ in
                Button("OK") { mediaFailure = nil }
            } message: { reason in
                Text(reason)
            }
    }

    private var mediaFailurePresented: Binding<Bool> {
        Binding(
            get: { mediaFailure != nil },
            set: { if !$0 { mediaFailure = nil } }
        )
    }

    // MARK: Files and pictures

    /// What a tile, a context menu or a picture's hover controls do. Each one
    /// fetches the file through the transcript's loader first — once; after
    /// that it is on disk — and the column presents the result.
    private var mediaActions: TranscriptMediaActions {
        var actions = TranscriptMediaActions()
        actions.quickLook = { attachment in
            withFile(attachment) { url in quickLookURL = url }
        }
        actions.openWithDefaultApp = { attachment in
            withFile(attachment) { url in _ = NSWorkspace.shared.open(url) }
        }
        actions.saveAs = { attachment in saveAs(attachment) }
        if canEditImages {
            actions.editImage = { attachment in imageEditTarget = attachment }
        }
        return actions
    }

    /// An edit needs a saved conversation to land in, a client to run it and
    /// an image model that edits — the Library's own test.
    private var canEditImages: Bool {
        privateChat == nil
            && model.selectedConversationID != nil
            && configuration.requestSender != nil
            && model.modelCatalog.contains { $0.modality == "image" && $0.imageEditSupport != .none }
    }

    private func withFile(_ attachment: NativeChatAttachment, _ use: @escaping @MainActor (URL) -> Void) {
        guard let transcriptMedia else {
            mediaFailure = NativeTranscriptFileError.signedOut.localizedDescription
            return
        }
        Task {
            do {
                use(try await transcriptMedia.fileURL(for: attachment))
            } catch {
                mediaFailure = NativeFailureMessage.presentable(error)
            }
        }
    }

    /// Save As…: the panel opens at once, with the download already running
    /// behind it, and the copy lands when both are done.
    private func saveAs(_ attachment: NativeChatAttachment) {
        guard let transcriptMedia else {
            mediaFailure = NativeTranscriptFileError.signedOut.localizedDescription
            return
        }
        let download = Task { try await transcriptMedia.fileURL(for: attachment) }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = attachment.fileName
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let destination = panel.url else { return }
            Task { @MainActor in
                do {
                    let source = try await download.value
                    let manager = FileManager.default
                    if manager.fileExists(atPath: destination.path) {
                        _ = try manager.replaceItemAt(destination, withItemAt: Self.stagedCopy(of: source))
                    } else {
                        try manager.copyItem(at: source, to: destination)
                    }
                } catch {
                    mediaFailure = NativeFailureMessage.presentable(error)
                }
            }
        }
    }

    /// A copy of a cached file to swap in over an existing one: `replaceItemAt`
    /// moves its argument, and the cache must keep its own.
    private static func stagedCopy(of source: URL) throws -> URL {
        let staged = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-save-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent(source.lastPathComponent)
        try FileManager.default.createDirectory(
            at: staged.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try FileManager.default.copyItem(at: source, to: staged)
        return staged
    }

    /// The region editor, on the picture it was opened from. The edit runs as
    /// a turn in this conversation — instructions as the reader's question,
    /// the edited picture streaming in as the answer — as the web's does.
    @ViewBuilder
    private func imageEditSheet(_ target: NativeChatAttachment) -> some View {
        if let sender = configuration.requestSender {
            NativeImageEditView(
                attachmentID: target.id,
                fileName: target.fileName,
                accountID: session.profile.id,
                attachments: NativeAttachmentAPIClient(sender: sender),
                models: model.modelCatalog,
                submit: { request in startImageEdit(request) },
                close: { imageEditTarget = nil }
            )
            .frame(minWidth: 560, minHeight: 640)
            // A system sheet: its own ground and edge, no fill of Juno's
            // (Phase 3 B6).
            .presentationSizing(.fitted)
        }
    }

    private func startImageEdit(_ request: NativeMediaGenerationRequest) {
        guard let conversationID = model.selectedConversationID, let edit = request.edit else { return }
        let started = model.sendImageEdit(
            conversationID: conversationID,
            prompt: request.prompt,
            modelID: request.modelID,
            edit: edit
        )
        if !started {
            mediaFailure = model.chatErrorDescription ?? "Juno couldn’t start the edit. Try again in a moment."
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
        TrailingDock(panel: dockPanel) { panel in
            switch panel {
            case .canvas(let artifact):
                DesktopArtifactCanvas(
                    artifact: artifact,
                    close: closeArtifact,
                    requestEdit: { prompt in
                        draftPrompt = prompt
                        closeArtifact()
                    },
                    save: saveArtifact
                )
            case .activity(let messageID, let focusCallID):
                if let message = findableMessages.first(where: { $0.id == messageID }) {
                    DesktopActivityPanel(
                        message: message,
                        live: message.isPending,
                        recovering: message.isPending && model.chatPhase == .reconnecting,
                        focusCallID: focusCallID,
                        approvals: panelApprovals(for: message),
                        contextWindow: message.model.flatMap { model.model(withID: $0)?.contextWindowTokens },
                        seedDraft: { text in composerRequest = ChatComposerRequest(kind: .seed(text)) },
                        forgetMemory: configuration.memorySettingsModel.map { memory in
                            { id in await memory.deleteMemory(id: id) }
                        },
                        close: closeActivity
                    )
                }
            case .research(let runID):
                researchPanel(runID)
            case .task(let sessionID):
                taskPanel(sessionID)
            }
        } content: {
            chatColumn
        }
        .environment(\.junoActivityPanelMessageID, openActivity.flatMap { target in
            findableMessages.first { $0.id == target.messageID && $0.isPending }?.id
        })
        .environment(\.junoArtifactResolver, artifactResolver)
        .environment(\.junoWorkFiles, workFiles)
        .environment(\.junoWorkFileActions, workFileActions)
        .environment(\.junoTranscriptViewportHeight, columnHeight)
        .environment(\.junoFavicons, favicons)
        .environment(\.nativeSourceFavicons, sourceFavicons)
    }

    /// Every turn on screen, store and local, in order: what the find bar and
    /// the Activity panel look messages up in.
    private var findableMessages: [NativeChatMessage] {
        model.selectedMessages + localMessages
    }

    /// Whether the account can reach the server: no offline banner.
    private var isOnline: Bool {
        DesktopOfflineState.resolve(
            connectivity: configuration.authModel.connectivity,
            syncPhase: configuration.syncModel?.phase
        ) == nil
    }

    /// The panel the dock shows: the open artifact, with the stored row behind
    /// it as the artifact store has it *now* — so a revision a later reply
    /// wrote, a sync, or the canvas's own Save is what the canvas shows.
    private var dockPanel: DesktopDockPanel? {
        if let open = openArtifact {
            return .canvas(open.current(in: artifactResolver))
        }
        if let openActivity {
            return .activity(messageID: openActivity.messageID, focusCallID: openActivity.focusCallID)
        }
        if let openTask { return .task(sessionID: openTask) }
        return openResearch.map { .research(runID: $0) }
    }

    /// The runs still to follow in this conversation, as a key: a hand-off
    /// changes it, which restarts the follower.
    private var openResearchRunKey: String {
        model.researchRuns(for: model.selectedConversationID)
            .filter { !$0.phase.isTerminal }
            .map(\.id)
            .joined(separator: ",")
    }

    /// The Research panel on a run: a background run from the store, or a
    /// research turn a profile-1 server answered in the chat, read from its
    /// rows.
    @ViewBuilder
    private func researchPanel(_ runID: String) -> some View {
        if runID.hasPrefix("message:") {
            let messageID = String(runID.dropFirst("message:".count))
            if let message = findableMessages.first(where: { $0.id == messageID }) {
                DesktopResearchPanel(
                    run: NativeResearchRun.inChat(
                        message: message, live: message.isPending,
                        question: findableMessages.last { $0.role == .user && $0.createdAt <= message.createdAt }
                            .map { NativeMessageContent.plainText(of: $0.content) }
                    ),
                    inChat: true,
                    close: closeResearch
                )
            }
        } else if model.researchRun(id: runID) == nil, let conversationID = model.selectedConversationID {
            // A completion message's run, not followed this session: read it.
            Color.clear
                .task(id: runID) { await model.refreshResearchRun(id: runID, conversationID: conversationID) }
        } else if let run = model.researchRun(id: runID), let conversationID = model.selectedConversationID {
            DesktopResearchPanel(
                run: run,
                busy: model.researchBusyRunIDs.contains(runID),
                error: model.researchErrors[runID],
                unreachable: model.researchUnreachableRunIDs.contains(runID),
                control: { action in
                    Task { await model.controlResearch(runID: runID, action: action, conversationID: conversationID) }
                },
                steer: { text in
                    let result = await model.steerResearch(runID: runID, input: text, conversationID: conversationID)
                    return result.accepted ? nil : (result.notice ?? "That guidance could not be added. Try again.")
                },
                retry: { Task { await model.refreshResearchRun(id: runID, conversationID: conversationID) } },
                // Today's server answers "Finish now" with a 400: hide it
                // where the server derives no phase, or once it has refused.
                canFinish: run.derivesPhase && !model.researchFinishUnsupported,
                initialTab: openResearchTab,
                openInWindow: run.reportBody == nil ? nil : { openReport(runID) },
                close: closeResearch
            )
            .id("\(runID):\(openResearchTab?.rawValue ?? "")")
        }
    }

    /// The approvals the Activity panel can answer from a pending call's row:
    /// the newest reply's, as its row has them.
    private func panelApprovals(for message: NativeChatMessage) -> MessageRowApprovals {
        guard privateChat == nil, let conversationID = model.selectedConversationID,
            message.id == model.selectedMessages.last?.id
        else { return MessageRowApprovals() }
        let approvals = model.chatApprovals(for: conversationID).filter(\.isPending)
        guard !approvals.isEmpty else { return MessageRowApprovals() }
        return MessageRowApprovals(
            approvals: approvals,
            inFlightID: model.chatApprovalInFlightID,
            error: { model.chatApprovalError(for: $0) },
            canAllowScope: { model.canAllowChatApprovalScope($0) },
            decide: { approval, decision in
                Task { await model.decideChatApproval(approval, decision: decision) }
            }
        )
    }

    /// This conversation's stored artifacts, by identifier — the web's
    /// `artifactsByIdentifier`. Nothing in a draft or a private chat.
    private var artifactResolver: ChatArtifactResolver {
        guard privateChat == nil, let artifactModel = configuration.artifactModel else { return .empty }
        return ChatArtifactResolver(
            artifacts: artifactModel.artifacts,
            conversationID: model.selectedConversationID
        )
    }

    /// Saves an edit made in the canvas as a new version on top of the version
    /// it was made against. Nil in a private chat, whose artifacts are never
    /// stored.
    private var saveArtifact: DesktopArtifactSave? {
        guard privateChat == nil, let artifactModel = configuration.artifactModel else { return nil }
        return { id, content, baseVersion in
            let landed = await artifactModel.saveArtifact(id: id, content: content, baseVersion: baseVersion)
            return landed ? nil : (artifactModel.lastErrorDescription ?? "Juno couldn’t save this artifact. Try again in a moment.")
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

    /// An agent's thread with nothing in it yet: laid out as a draft is, with
    /// the agent's own greeting in Juno's place (Phase 5 C2). The web's
    /// `hasMessages` is false there too — no message, no call, no research
    /// run and no task — so the landing composer greets rather than an empty
    /// transcript sitting under a header.
    private var isAgentLanding: Bool {
        guard privateChat == nil, voiceSession == nil, handoffTurn == nil, threadAgent != nil,
            let conversation = model.selectedConversation, !conversation.isPending
        else { return false }
        return model.selectedMessages.isEmpty
            && model.researchRuns(for: conversation.id).isEmpty
            && conversationWork?.current == nil
    }

    /// The column greets and centres its composer: a draft, or an agent's
    /// empty thread.
    private var isLanding: Bool { isDraft || isAgentLanding }

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
        case .began(let content, let attachments):
            handoffTurn = NativeChatMessage(
                id: "handoff-\(UUID().uuidString.lowercased())",
                conversationID: "",
                clientID: nil,
                role: .user,
                content: content,
                reasoning: nil,
                model: nil,
                createdAt: Date(),
                revision: 0,
                attachments: attachments
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
        VStack(spacing: 0) {
            // An agent's thread gains one row above the transcript (AGENTS.md
            // §5.3): the agent, what it is doing, and its page. Above rather
            // than an inset over it, so the composer's bar stays the
            // transcript's alone.
            if privateChat == nil, let agent = threadAgent {
                threadHeader(agent)
            }
            transcriptGroup
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // ⌘F: a glass capsule over the top of the column (§6.14).
        .safeAreaBar(edge: .top, spacing: 0) {
            if find.isOpen, !isDraft {
                DesktopFindBar(
                    query: $find.query,
                    current: find.current,
                    total: find.matches.count,
                    next: find.next,
                    previous: find.previous,
                    done: find.close,
                    focusRequest: find.focusRequest
                )
                .padding(.top, JunoSpace.snug)
                .padding(.horizontal, DesktopChatMeasure.gutter(forColumnWidth: columnWidth))
                .frame(maxWidth: .infinity)
                .transition(.opacity)
            }
        }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            ChatComposerDock(
                lift: composerLift,
                gutter: DesktopChatMeasure.gutter(forColumnWidth: columnWidth),
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
                    isShown: isLanding,
                    agent: isAgentLanding ? threadAgent : nil
                )
                .padding(.bottom, JunoSpace.region)
            } composer: {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    followUps
                    composer
                }
            } footer: {
                // Nothing under the composer: the empty chat is the greeting
                // and the composer (premium voice pass). No starting points.
                EmptyView()
            }
            // The toast host sits 12pt above a docked composer (§7.7). A
            // draft's composer is lifted to the middle of the column, so a
            // toast there sits at the foot like any page's.
            .junoToastAnchor(!isLanding)
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
        .onChange(of: model.latestCompletedAgentConfigMessageID, initial: false) { oldID, newID in
            guard let newID, newID != oldID, let agentsModel = configuration.agentsModel else { return }
            let activeAgentID = threadAgent?.id
            Task {
                await agentsModel.refresh()
                if let activeAgentID {
                    await agentsModel.loadDetail(id: activeAgentID)
                }
            }
        }
    }

    /// The agent whose thread is open, if it is one.
    private var threadAgent: NativeAgent? {
        guard let conversationID = model.selectedConversationID else { return nil }
        return configuration.agentsModel?.agents.first { $0.conversationID == conversationID }
    }

    /// What the face in the header shows when the thread knows better than the
    /// roster: listening while a call is open in this thread, thinking while a
    /// reply streams. Nil leaves the roster's state, which is what the agent's
    /// tasks are doing. The web's `threadAgentState`, in that precedence.
    private var threadAgentState: JunoAgentState? {
        if let voiceSession, voiceSession.conversationID == model.selectedConversationID {
            switch voiceSession.controller.phase {
            case .connecting, .live, .reconnecting:
                return .listening
            case .idle, .ended, .error:
                break
            }
        }
        let streaming = model.isGenerating
            && model.activeChatConversationID == model.selectedConversationID
        return streaming ? .thinking : nil
    }

    /// Chrome, so it carries the hairline; the transcript under it stays flat.
    /// The face and Profile open the agent's profile as a sheet over the
    /// thread; More pauses, pins, duplicates or retires it.
    private func threadHeader(_ agent: NativeAgent) -> some View {
        VStack(spacing: 0) {
            DesktopAgentVoiceLevel(controller: threadAgentState == .listening ? voiceSession?.controller : nil) { level in
                DesktopAgentThreadHeader(
                    agent: agent,
                    state: threadAgentState,
                    level: level,
                    model: configuration.agentsModel,
                    apps: (configuration.connectorModel?.linked ?? [])
                        .filter(\.connected)
                        .map { NativeAgentAppChoice(id: $0.id, label: $0.label) },
                    openThread: openAgentThread,
                    focusComposer: { composerRequest = ChatComposerRequest(kind: .focus) },
                    retired: { openDestination(.agents) },
                    drawsWash: false,
                    openAgent: { openAgent?(agent.id) }
                )
            }
            .frame(maxWidth: DesktopChatMeasure.reading)
            .padding(.horizontal, DesktopChatMeasure.gutter(forColumnWidth: columnWidth))
            .padding(.vertical, JunoSpace.hairline)
            .frame(maxWidth: .infinity)
            // The wash runs the whole column, as the web bar's does.
            .background { NativeAgentBarWash(avatar: agent.avatar) }
            Rectangle()
                .fill(Color.junoHairline)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
    }

    private var transcriptGroup: some View {
        Group {
            if isLanding {
                Color.clear
            } else {
                DesktopTranscript(
                    model: model,
                    localMessages: localMessages,
                    localTurnsArePrivate: privateChat != nil,
                    localError: privateChat?.lastErrorDescription,
                    // Not while a first turn is on its way: with nothing selected
                    // yet, the store's errors and approvals describe some other
                    // chat, and a refusal is reported by the composer.
                    showsStoreState: privateChat == nil && model.selectedConversationID != nil,
                    voiceMessages: voiceMessages,
                    messageActions: configuration.messageActionsClient,
                    accountID: session.profile.id,
                    syncModel: configuration.syncModel,
                    openArtifact: open(artifact:message:),
                    share: shareConversation,
                    // Not from inside a private chat: its turns are already
                    // private, and the web offers no fork there either.
                    forkPrivately: privateChat == nil ? forkPrivately : nil,
                    quote: { text in composerRequest = ChatComposerRequest(kind: .quote(text)) },
                    editLastRequest: editLastRequest,
                    find: find,
                    openActivity: { messageID, callID in openActivityPanel(messageID: messageID, callID: callID) },
                    openResearch: { runID in openResearchPanel(runID) },
                    researchActions: ChatResearchActions(
                        openReport: { runID in openReport(runID) },
                        inspect: { runID in openResearchPanel(runID, tab: .sources) },
                        dismissRecap: { runID in dismissRecap(runID) },
                        dismissed: dismissedRecaps
                    ),
                    researchThis: privateChat == nil
                        ? { question in composerRequest = ChatComposerRequest(kind: .research(question)) }
                        : nil,
                    workRun: privateChat == nil ? workRunState : nil,
                    workRuns: privateChat == nil ? workRunEntries : [],
                    workActions: workActions,
                    openTask: { sessionID in openTaskPanel(sessionID) }
                )
                .environment(\.junoTranscriptMediaActions, mediaActions)
                // A Live UI view's prompt button sends the way a follow-up
                // chip does (docs/design/LIVE_UI.md).
                .environment(
                    \.junoLiveUIHost,
                    JunoLiveUIHost(onPrompt: { text in composerRequest = ChatComposerRequest(kind: .send(text)) })
                )
                // In an agent's thread its replies speak as the agent.
                .environment(
                    \.desktopAgentThread,
                    privateChat == nil ? threadAgent.map(DesktopAgentThreadIdentity.init) : nil
                )
            }
        }
    }

    /// The composer group's bottom padding: centred on the optical middle in a
    /// draft, at rest in a conversation. The empty state animates the change.
    private var composerLift: CGFloat {
        isLanding
            ? ChatComposerLift.draft(
                columnHeight: columnHeight,
                groupHeight: dockGroupHeight,
                footerHeight: dockFooterHeight
            )
            : ChatComposerLift.resting
    }

    private func open(artifact: NativeMessageContent.ArtifactReference, message: NativeChatMessage) {
        withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
            openActivity = nil
            openResearch = nil
            openTask = nil
            openArtifact = DesktopChatArtifact(
                reference: artifact,
                stored: artifactResolver.artifact(
                    for: artifact,
                    messageID: message.id,
                    messageCreatedAt: message.createdAt
                ),
                messageID: message.id,
                messageCreatedAt: message.createdAt
            )
        }
    }

    /// A reference with no message of its own — the toolbar's Outputs and the
    /// ⌘K panel, both made from a stored row: opened on that row, by id, or
    /// on the reference's own body while this Mac has no row for it yet.
    private func open(artifact: NativeMessageContent.ArtifactReference) {
        if let row = artifactResolver.artifact(identifier: artifact.identifier) {
            open(row: row)
            return
        }
        withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
            openActivity = nil
            openResearch = nil
            openTask = nil
            openArtifact = DesktopChatArtifact(reference: artifact)
        }
    }

    /// Takes the router's Open in Conversation request once its chat is on
    /// screen and its row is in the store.
    private func followCanvasRequest() {
        let router = DesktopPageRouter.shared
        guard let request = router.pendingCanvas,
              privateChat == nil,
              request.conversationID == model.selectedConversationID,
              let row = artifactResolver.artifact(id: request.artifactID)
        else { return }
        router.consumeCanvas(request)
        open(row: row)
    }

    /// Opens the canvas on one stored row by id — the Artifacts page's Open in
    /// Conversation (`DesktopPageRouter.openArtifactInConversation`).
    private func open(row: NativeArtifact) {
        withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
            openActivity = nil
            openResearch = nil
            openTask = nil
            openArtifact = DesktopChatArtifact(row: row)
        }
    }

    /// The Activity panel on a reply's run — the newest opener wins the dock.
    private func openActivityPanel(messageID: String, callID: String?) {
        withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
            openArtifact = nil
            openResearch = nil
            openTask = nil
            openActivity = DesktopActivityTarget(messageID: messageID, focusCallID: callID)
        }
    }

    /// The Research panel on a run — the newest opener wins the dock.
    private func openResearchPanel(_ runID: String, tab: DesktopResearchPanel.Tab? = nil) {
        openResearchTab = tab
        withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
            openArtifact = nil
            openActivity = nil
            openTask = nil
            openResearch = runID
        }
    }

    /// A research report in its own window (register #65).
    private func openReport(_ runID: String) {
        openWindow(id: JunoDesktopWindow.researchReportID, value: runID)
    }

    /// Where this account's hidden research receipts are remembered.
    private var dismissedRecapsKey: String { "juno.research.recap.dismissed.\(session.profile.id.rawValue)" }

    /// Hides a run's recap on this Mac, for good (the web's ✕ lasts the page).
    private func dismissRecap(_ runID: String) {
        _ = withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)) {
            dismissedRecaps.insert(runID)
        }
        UserDefaults.standard.set(Array(dismissedRecaps).sorted(), forKey: dismissedRecapsKey)
    }

    /// The Task panel on one of this chat's tasks — the newest opener wins the
    /// dock. An earlier task is read once as it opens.
    private func openTaskPanel(_ sessionID: String) {
        withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
            openArtifact = nil
            openActivity = nil
            openResearch = nil
            openTask = sessionID
        }
        if conversationWork?.current?.sessionID != sessionID {
            readTask(sessionID)
        }
    }

    private func readTask(_ sessionID: String) {
        let client = configuration.workModel?.transport
        let accountID = session.profile.id
        Task { await taskPanelReader.read(sessionID: sessionID, client: client, accountID: accountID) }
    }

    private func closeTask() {
        withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)) {
            openTask = nil
        }
    }

    private func closeResearch() {
        withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)) {
            openResearch = nil
        }
    }

    private func closeActivity() {
        withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)) {
            openActivity = nil
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
                    accountID: session.profile.id,
                    conversationID: model.selectedConversationID
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

    /// What to ask next, above the composer (§6.12): only under a settled
    /// answer in a saved chat, and only while the draft is empty.
    @ViewBuilder
    private var followUps: some View {
        if privateChat == nil, !isDraft, let conversationID = model.selectedConversationID {
            let last = model.selectedMessages.last
            DesktopFollowUpChips(
                conversationID: conversationID,
                replyID: last?.id,
                accountID: session.profile.id,
                client: configuration.followUpClient,
                ready: !model.isGenerating && voiceSession == nil
                    && last?.role == .assistant && last?.isPending == false
                    && last?.errorDescription == nil
                    && !(last?.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true),
                draftIsEmpty: draftIsEmpty,
                send: { text in composerRequest = ChatComposerRequest(kind: .send(text)) }
            )
        }
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
            steering: composerSteering,
            customPlaceholder: privateChat == nil ? threadAgent.map { "Message \($0.name)\u{2026}" } : nil,
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
            // Use a Skill and a typed `/slug` (Phase 4 B's library).
            skillLibrary: configuration.skillLibraryModel,
            manageSkills: configuration.skillLibraryModel == nil ? nil : { openDestination(.skills) },
            // The Upgrade sheet over this window (Phase 3 seam 12).
            openUpgrade: { DesktopUpgradePresenter.shared.present(in: .chat) },
            draftIsEmptyChanged: { draftIsEmpty = $0 }
        )
        // The call is drawn inside the composer's own shell (§5.8): announced
        // here, it turns the controls row into the call bar.
        .junoVoiceCall(voiceColumn)
    }

    // MARK: Tasks (Phase 5)

    /// Which follower this column needs: one per account and saved
    /// conversation, none for a draft or a private chat.
    private var workFollowerKey: String {
        let id = privateChat == nil && model.selectedConversation.map { !$0.isPending } == true
            ? model.selectedConversationID ?? "" : ""
        return "work:\(session.profile.id.rawValue):\(id)"
    }

    private func makeConversationWork() -> NativeConversationWork? {
        guard privateChat == nil,
            let conversation = model.selectedConversation, !conversation.isPending,
            let workModel = configuration.workModel
        else { return nil }
        let work = NativeConversationWork(
            conversationID: conversation.id, client: workModel.transport, accountID: session.profile.id
        )
        work.isVisible = windowVisible
        if let host = configuration.workHostModel {
            work.localApprovals = { runID in host.localApprovals(forRun: runID) }
            work.localApprovalDecider = { approval, decision in
                host.localApprovalDecider?(approval.id, decision, approval.actionDigest)
            }
        }
        // The web's `juno:work-sync`: the account's list hears of it.
        work.didAct = { [weak workModel] in await workModel?.refresh() }
        return work
    }

    /// The newest `work` frame for this conversation, by session id.
    private var pendingWorkStartID: String? {
        model.selectedConversationID.flatMap { model.workStarts[$0]?.sessionID }
    }

    /// Hands the reply's `work` frame to the follower (the web's `adopt`).
    private func adoptWorkStart() {
        guard let work = conversationWork,
            let start = model.workStarts[work.conversationID],
            let session = try? NativeWorkClient.decodeSessionSummary(start.sessionJSON)
        else { return }
        // The first task started in this Mac's chat is the moment to ask
        // whether Juno may notify (spec §7.11); the account's list hears of
        // it at once, as the web's `juno:work-sync` does.
        if work.adopt(session) {
            DesktopNeedsYouSignals.shared.noteTaskStarted()
        }
    }

    /// The agent working in this thread, whose name re-voices the card.
    private var workActor: String? {
        threadAgent?.name
    }

    /// The task the card draws, from the follower.
    private var workRunState: ChatWorkRunState? {
        guard let work = conversationWork else { return nil }
        return ChatWorkRunState.read(
            work, actor: workActor, files: workFiles, blockers: localBlockers(for: work.run)
        )
    }

    /// The permissions a run on this Mac is missing: only for a run this
    /// Mac's host is carrying, read from the run (sessions carry no host).
    private func localBlockers(for run: WorkRunSummary?) -> [ChatWorkLocalBlocker] {
        guard let run, let hostID = configuration.workHostModel?.pairedHostID else { return [] }
        let runsHere = run.hostID == hostID && run.effectiveTarget != JunoWorkTarget.cloud.rawValue
        return ChatWorkLocalBlocker.of(systemPermissions, runsHere: runsHere)
    }

    /// What a task file's click, menu and drag do: the column's Quick Look,
    /// Open With and Save As, reading the file through ``ChatWorkFiles``. A
    /// file the validator never opened asks before it is saved.
    private var workFileActions: TranscriptMediaActions {
        var actions = TranscriptMediaActions()
        guard let workFiles else { return actions }
        actions.quickLook = { attachment in
            Task {
                do { quickLookURL = try await workFiles.fileURL(for: attachment) } catch {
                    mediaFailure = NativeFailureMessage.presentable(error)
                }
            }
        }
        actions.openWithDefaultApp = { attachment in
            Task {
                do { _ = NSWorkspace.shared.open(try await workFiles.fileURL(for: attachment)) } catch {
                    mediaFailure = NativeFailureMessage.presentable(error)
                }
            }
        }
        actions.saveAs = { attachment in
            Task {
                do {
                    _ = try await workFiles.fileURL(for: attachment)
                } catch {
                    mediaFailure = NativeFailureMessage.presentable(error)
                    return
                }
                if workFiles.isUnvalidated(attachment) {
                    pendingUnvalidatedSave = attachment
                } else {
                    ChatWorkFileSaving.save(attachment, from: workFiles) { mediaFailure = $0 }
                }
            }
        }
        return actions
    }

    /// Opens "Save this task as a skill" on the followed task, drafted from
    /// the run as it stands at the press.
    private func captureSkill() {
        guard let work = conversationWork, let current = work.current else { return }
        let performed = WorkEventLog.performedActions(
            in: work.events, toolPresent: DesktopWorkVocabulary.toolPresent, toolPast: DesktopWorkVocabulary.toolPast
        )
        skillCapture = .from(session: current, plan: work.plan, performed: performed)
    }

    /// Saves a captured skill; nil on success, or the sentence to show.
    private func saveSkill(_ draft: ChatSkillCaptureDraft) async -> String? {
        guard let sender = configuration.requestSender else { return WorkSkillDraft.unreachable }
        let outcome = await NativeWorkSkillsClient(sender: sender).createSkill(
            name: draft.name, description: draft.description, instructions: draft.instructions,
            projectID: draft.projectID, for: session.profile.id
        )
        if case .created(let skill) = outcome {
            toast(.success("Saved as /\(skill.slug)."))
            return nil
        }
        return outcome.message
    }

    /// Every task of this chat, placed by the transcript: the current one and
    /// each earlier one (register #53).
    private var workRunEntries: [ChatWorkRunEntry] {
        guard let work = conversationWork else { return [] }
        var entries = work.history.map { session in
            ChatWorkRunEntry(
                session: session,
                status: JunoWorkStatus(rawValue: session.status) ?? .interrupted,
                isCurrent: false
            )
        }
        if let current = work.current, let status = work.status {
            entries.append(ChatWorkRunEntry(session: current, status: status, isCurrent: true))
        }
        return entries
    }

    /// The card's controls, each followed by a toast when it did not land.
    private var workActions: ChatWorkRunActions {
        guard let work = conversationWork else { return ChatWorkRunActions() }
        let say = toast
        func report(_ outcome: NativeConversationWork.Outcome) {
            if !outcome.succeeded, let message = outcome.message { say(.error(message)) }
        }
        return ChatWorkRunActions(
            decide: { approval, decision, reason in
                Task { report(await work.decide(approval, decision, reason: reason)) }
            },
            decideAll: { approvals in Task { report(await work.decideAll(approvals)) } },
            saveSkill: { captureSkill() },
            answer: { questionID, text in
                Task { report(await work.answer(questionID: questionID, text: text)) }
            },
            focusComposer: { composerRequest = ChatComposerRequest(kind: .focus) },
            stop: {
                let outcome = await work.stop()
                report(outcome)
                return outcome.succeeded
            },
            pause: { Task { report(await work.pause()) } },
            resume: { Task { report(await work.resume()) } },
            tryAgain: { Task { report(await work.tryAgain()) } },
            showDetails: work.current.map { current in { openTaskPanel(current.sessionID) } }
        )
    }

    /// The Task panel: the current task from the follower, an earlier one read
    /// once.
    @ViewBuilder
    private func taskPanel(_ sessionID: String) -> some View {
        let details = ChatWorkPanelDetails(
            pairedHostID: configuration.workHostModel?.pairedHostID,
            connectedApps: ChatWorkPanelDetails.appsLine(
                taskPanelReader.contexts[sessionID]?.connectorIDs,
                name: { id in
                    configuration.connectorModel?.linked.first { $0.id == id }?.label
                        ?? WorkApprovalWords.humanize(id)
                }
            )
        )
        Group {
            if let work = conversationWork, work.current?.sessionID == sessionID,
                let state = workRunState
            {
                ChatWorkPanel(title: taskTitle(state.session), source: .live(state), close: closeTask, details: details)
            } else {
                let earlier = conversationWork?.history.first { $0.sessionID == sessionID }
                ChatWorkPanel(
                    title: earlier.map(taskTitle) ?? "Task",
                    source: .snapshot(taskPanelReader.snapshot(for: sessionID)),
                    close: closeTask,
                    retry: { readTask(sessionID) },
                    details: details
                )
            }
        }
        .task(id: sessionID) {
            await taskPanelReader.readContext(
                sessionID: sessionID, client: configuration.workModel?.transport, accountID: session.profile.id
            )
        }
    }

    private func taskTitle(_ session: WorkSessionSummary) -> String {
        let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? session.goal : title
    }

    // MARK: Steering (Phase 5 A6)

    /// The newest research run of this chat that is accepting input.
    private var acceptingResearchRun: NativeResearchRun? {
        model.researchRuns(for: model.selectedConversationID).last { !$0.phase.isTerminal && $0.phase.isWorking }
    }

    /// What the composer steers, built as `chat-view.tsx` builds the web's
    /// prop: research while it is accepting input, otherwise the chat's task.
    private var composerSteering: ChatComposerSteering? {
        guard privateChat == nil, let conversationID = model.selectedConversationID else { return nil }
        if let run = acceptingResearchRun {
            return .research(
                steer: { text in await steerResearch(runID: run.id, text: text, conversationID: conversationID) },
                stop: {
                    // The run first, so the money stops even if tearing the
                    // stream down goes wrong; then the stream.
                    Task { await model.controlResearch(runID: run.id, action: .cancel, conversationID: conversationID) }
                    model.stopGeneration()
                }
            )
        }
        guard let work = conversationWork, let mode = work.composerMode else { return nil }
        let isGenerating = model.isGenerating && model.activeChatConversationID == conversationID
        return .task(
            answering: { if case .answer = mode { true } else { false } }(),
            isGenerating: isGenerating,
            pending: work.pendingSteers.map { ChatPendingSteer(id: $0.id, text: $0.text, at: $0.at) },
            steer: { text in await steerTask(work, text: text) },
            stop: {
                // A streaming reply wins: it is the thing moving on screen.
                if model.isGenerating { model.stopGeneration() } else {
                    Task {
                        let outcome = await work.stop()
                        if !outcome.succeeded, let message = outcome.message { toast(.error(message)) }
                    }
                }
            }
        )
    }

    /// Return in the composer while a task is live: the open question's answer,
    /// or a new instruction, with the web's toasts.
    private func steerTask(_ work: NativeConversationWork, text: String) async -> Bool {
        switch work.composerMode {
        case .answer(let question):
            let outcome = await work.answer(questionID: question.questionID, text: text)
            if !outcome.succeeded, let message = outcome.message { toast(.error(message)) }
            return outcome.succeeded
        case .instruction:
            let outcome = await work.steer(text)
            if let message = outcome.message {
                toast(outcome.succeeded ? .success(message) : .error(message))
            }
            return outcome.succeeded
        case nil:
            return false
        }
    }

    /// Return in the composer while a research run accepts input: a source
    /// when it is a link, otherwise a constraint.
    private func steerResearch(runID: String, text: String, conversationID: String) async -> Bool {
        let result = await model.steerResearch(runID: runID, input: text, conversationID: conversationID)
        if result.accepted {
            toast(.success("Added to this research run"))
        } else {
            toast(.error(result.notice ?? "That could not be added to the run."))
        }
        return result.accepted
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
        DesktopPlanGate.shared.update(planID: loaded.planID)
    }
}
