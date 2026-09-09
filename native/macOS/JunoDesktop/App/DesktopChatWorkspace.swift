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
        // Manual-QA hook for the capture path: `--juno-debug-screenshot-picker`
        // opens the system picker a beat after the window appears, so the
        // picker's own states — its prompt, the cancel path, the failure alert
        // — can be exercised without reaching for the ⇧⌘1 shortcut while also
        // driving the app. DEBUG-only, like every other launch flag here.
        #if DEBUG
        .task {
            if CommandLine.arguments.contains("--juno-debug-screenshot-picker"),
                configuration.attachmentModel != nil
            {
                try? await Task.sleep(nanoseconds: 800_000_000)
                attachScreenshot()
            }
        }
        #endif
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
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                beginDraft()
            } label: {
                Label("New chat", icon: .compose)
            }
            .junoToolbarMetrics()
            .help("Start a new chat (⌘N)")
            .accessibilityIdentifier("New chat")

            Button {
                destination.wrappedValue = .search
            } label: {
                Label("Search", icon: .search)
            }
            .junoToolbarMetrics()
            .help("Search chats, projects and files (⌘⇧F)")
            .accessibilityIdentifier("Search")
        }

        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await createShare() }
                } label: {
                    Label("Share", icon: .share)
                }
                .junoToolbarMetrics()
                .disabled(
                    sharing || configuration.shareClient == nil
                        || model.selectedConversationID == nil
                )
                .help("Create a public link to this conversation")
                .accessibilityIdentifier("Share")
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
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            HStack(spacing: 0) { content() }
        }
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
        .junoGlassButton()
        .controlSize(.small)
        .fixedSize()
        .help("Regenerate")
        .accessibilityLabel("Regenerate")
    }
}

/// One native glass action on a message row. `active` is a pressed thumb.
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
        .junoGlassButton()
        .controlSize(.small)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

/// The Lucide mark shared by the native buttons and menu trigger.
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
