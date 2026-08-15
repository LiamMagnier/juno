import Foundation
import JunoAuth
import JunoChatKit
import JunoCodeCore
import JunoCodeKit
import JunoCodeUI
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoVoiceKit
import SwiftUI
import UniformTypeIdentifiers

/// The Code inspector shares the trailing toolbar with the session search
/// field. Keep its narrowest state wide enough for that field, with the same
/// 12-point shoulder on both sides, so resizing never clips or crowds Search
/// sessions.
private enum DesktopCodeInspectorMetrics {
    // Search lives in the detail toolbar, not inside the inspector. Tying the
    // inspector's minimum to that field made the trailing pane open at 332pt
    // even though its content is readable at the design-system minimum.
    static let minimum = JunoInspectorMetrics.minimum
    static let ideal: CGFloat = 348
    static let maximum = JunoInspectorMetrics.maximum
}

/// The Code window: one layout owner, two columns, one optional trailing
/// inspector.
///
/// This is byte-for-byte the shell ``DesktopChatWorkspace`` uses — a
/// `NavigationSplitView` whose sidebar is `.junoSidebarColumn()` and whose detail
/// is `.junoReadingCanvas()` plus `.navigationTitle`, `.toolbar` and
/// `.inspector(isPresented:)` — so Chat and Code stop being two different
/// applications sharing a window.
///
/// Three stability constraints are honoured deliberately, because `.inspector`
/// and the window toolbar are both `NSSplitViewItem`-backed and that is the
/// surface an earlier build crashed in:
///
/// 1. Every `ToolbarItem` is always present and uses `.disabled()`. A toolbar item
///    that appears and disappears makes SwiftUI rebuild the AppKit toolbar under a
///    live window, and that rebuild is what drove the split-view constraint loop.
/// 2. Column visibility is restored by hand, because
///    `NavigationSplitViewVisibility` is not `RawRepresentable` and cannot be put
///    in `@SceneStorage` directly.
/// 3. The detail column has exactly two mutually exclusive contents — the
///    transcript or the review canvas — and nothing else ever occupies it.
struct DesktopCodeWorkspace: View {
    let workbenchModel: WorkbenchModel
    let codeModel: NativeCodeModel
    let remoteModel: CodeRemoteBrowserModel
    /// The pull request list's transport, and the account it lists for. Both are
    /// account-level rather than workspace-level, so they arrive from the window
    /// that already holds the configuration and the session instead of being
    /// derived from anything in the workbench.
    let pullsClient: NativeGitHubPullsClient?
    let accountID: AccountID?
    /// The account chrome's inputs: who is signed in, and the models the two
    /// account pages this window now hosts are built from.
    ///
    /// Optional so that a composition without a signed-in session simply has no
    /// account chrome rather than a half-drawn one — the same shape every other
    /// model on ``JunoDesktopConfiguration`` already has. They are declared
    /// together because they are useless apart.
    var configuration: JunoDesktopConfiguration?
    var session: NativeAuthenticatedSession?
    @Binding var product: DesktopProductMode
    /// Starts a normal Juno conversation, independent of a repository.
    let newChat: () -> Void

    @SceneStorage("juno.desktop.code.selection") private var storedSelection = ""
    @SceneStorage("juno.desktop.code.columns") private var storedColumnVisibility = ""
    // The inspector is secondary chrome. Opening Code into a blank “Nothing to
    // inspect” rail made the product feel like two competing canvases; it opens
    // on demand from the toolbar and remembers the reader's choice thereafter.
    @SceneStorage("juno.desktop.code.inspector.v3") private var inspectorVisible = false
    @SceneStorage("juno.desktop.code.console") private var consoleVisible = false
    @SceneStorage("juno.desktop.code.review") private var reviewVisible = false
    @SceneStorage("juno.desktop.code.remote-device") private var remoteDeviceID = ""

    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var controller: SessionController?
    @State private var isBootstrapping = true
    @State private var isStartingSession = false
    @State private var isChoosingRepository = false
    @State private var renamingSession: CodeSession?
    @State private var renameText = ""
    @State private var isOpeningQuickly = false
    /// Owns the simulator session for the selected workspace. Created lazily —
    /// discovery spawns `xcodebuild`, which is not something to do for every
    /// Code session on every Mac.
    @State private var simulatorHost = DesktopSimulatorHost()
    /// Whether the dictation capsule is up over the Code canvas.
    @State private var isDictating = false
    /// The web preview is a sibling of the transcript, not an inspector tab.
    /// Keeping the target here lets the dock and its optional pop-out share one
    /// `CodePreviewModel` and one dev-server process.
    @State private var previewTarget: CodePreviewTarget?
    /// The Code composer can host the same realtime voice dock as Chat. The
    /// transcript is saved as a normal conversation when the call ends.
    @State private var voiceSession: DesktopVoiceSession?
    @State private var voiceUnavailable: String?
    /// The account's plan meters, for the column's footer.
    ///
    /// Held by the window rather than by the sidebar so the read survives the
    /// column being collapsed, and so there is one copy of the number rather than
    /// one per surface that wants to show it.
    @State private var plan: DesktopUsagePlan?
    @State private var planReadAt: Date?
    @FocusState private var sidebarSearchFocused: Bool
    @Environment(\.openWindow) private var openWindow
    /// The docks' enter/exit animations are spatial travel, so they go through
    /// ``JunoMotion/reduced(_:when:tier:)`` and collapse to a cross-fade when
    /// the reader has asked for less motion.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// How long a plan read stays fresh. Several runs finishing within a few
    /// seconds of each other would otherwise be several identical requests.
    private static let planReadFloor: TimeInterval = 60

    /// `workbenchModel` arrives as a `let`, so there is no `$` projection to hand
    /// to `.searchable`. It is `@Observable`, so reading and writing the property
    /// through a plain `Binding` registers the dependency exactly the same way.
    private var sessionSearchText: Binding<String> {
        Binding(
            get: { workbenchModel.sessionSearchText },
            set: { workbenchModel.sessionSearchText = $0 }
        )
    }

    // MARK: - Selection

    /// Restored from scene storage rather than kept in `@State`, so reopening a
    /// window returns the reader to the run they were reading.
    private var selection: Binding<DesktopCodeSidebarItem?> {
        Binding(
            get: {
                // SceneStorage is intentionally restored for real windows, but
                // a named DEBUG fixture must win over whatever the last manual
                // preview selected. Otherwise `--juno-preview-code-session`
                // intermittently opened a repository draft and the inspector
                // fixture became impossible to verify.
                if let previewSessionID {
                    return .session(previewSessionID)
                }
                return DesktopCodeNavigationState.decode(storedSelection)
            },
            set: { storedSelection = DesktopCodeNavigationState.encode($0) }
        )
    }

    private var previewSessionID: CodeSessionID? {
        #if DEBUG
        guard CommandLine.arguments.contains("--juno-preview-code-session") else {
            return nil
        }
        return workbenchModel.selectedSessionID ?? workbenchModel.sessions.first?.id
        #else
        return nil
        #endif
    }

    private var inspectorPresentation: Binding<Bool> {
        Binding(
            get: {
                // The launchpad has no session-scoped evidence to inspect. Do
                // not preserve a stale trailing pane from the last run and
                // make a blank first screen look like missing product content.
                guard case .session = selection.wrappedValue else {
                    return false
                }
                #if DEBUG
                if CommandLine.arguments.contains("--juno-preview-inspector") {
                    return true
                }
                #endif
                return inspectorVisible
            },
            set: { inspectorVisible = $0 }
        )
    }

    private var selectedSessionID: CodeSessionID? {
        guard case .session(let id) = selection.wrappedValue else { return nil }
        return id
    }

    private var selectedTask: NativeCodeTask? {
        guard case .task(let id) = selection.wrappedValue else { return nil }
        return codeModel.tasks.first { $0.id == id }
    }

    private var selectedRemote: (deviceID: String, sessionID: String)? {
        guard case .remote(let deviceID, let sessionID) = selection.wrappedValue else {
            return nil
        }
        return (deviceID, sessionID)
    }

    private var selectedRemoteSummary: CodeRemoteSessionSummary? {
        guard let selectedRemote else { return nil }
        return remoteModel.sessions.first { $0.sessionID == selectedRemote.sessionID }
    }

    /// The repository the next session belongs in: the one the reader is looking
    /// at, or failing that the most recently opened one. `workspaces` is ordered
    /// by last use, so `first` is a real answer rather than an arbitrary one.
    private var targetRepository: WorkspaceRecord? {
        switch selection.wrappedValue {
        case .repository(let id):
            return workbenchModel.workspaces.first { $0.id == id }
        case .session(let id):
            guard let session = workbenchModel.sessions.first(where: { $0.id == id }) else {
                break
            }
            return workbenchModel.workspaces.first { $0.id == session.workspaceID }
        default:
            break
        }
        return workbenchModel.workspaces.first
    }

    // MARK: - Body

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            DesktopCodeSidebar(
                workbench: workbenchModel,
                code: codeModel,
                remote: remoteModel,
                selection: selection,
                remoteDeviceID: $remoteDeviceID,
                product: $product,
                isBootstrapping: isBootstrapping,
                session: session,
                avatarModel: configuration?.avatarModel,
                syncModel: configuration?.syncModel,
                plan: plan,
                openRepository: { isChoosingRepository = true },
                newSession: { selection.wrappedValue = .repository($0) },
                rename: beginRename
            )
            .junoSidebarColumn()
        } detail: {
            VStack(spacing: 0) {
                editorCanvas

                // The persistent shell terminal is a sibling of the reading
                // canvas, so it can be resized or dismissed without changing
                // the transcript's own layout contract.
                if consoleVisible {
                    DesktopTerminalView(host: DesktopTerminalHost.shared)
                        .frame(height: 250)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .junoReadingCanvas()
            .navigationTitle("")
            .toolbar { detailToolbar }
            .searchable(
                text: sessionSearchText,
                placement: .toolbar,
                prompt: "Search sessions"
            )
            .searchFocused($sidebarSearchFocused)
        }
        // `.inspector` goes on the split view, **not** on the detail column.
        //
        // This is not a style choice, it is the fix for a hard crash. Applied to
        // the detail column, the inspector makes SwiftUI's `NSHostingView`
        // call `setNeedsUpdateConstraints:` from inside its own
        // `updateConstraints`, while the window's constraint pass is already
        // running for that display cycle. AppKit throws from
        // `-[NSWindow _postWindowNeedsUpdateConstraints]` and the process takes
        // SIGTRAP — reproducibly, on every Chat -> Code switch, on macOS 27.0
        // (26A5388g).
        //
        // Bisected: with `.inspector` on the detail column the switch always
        // crashes; removing it entirely fixes the switch; moving it here fixes the
        // switch and keeps the native inspector. An earlier revision of
        // `MACOS_ARCHITECTURE_V2.md` read this crash as proof that
        // `NavigationSplitView` and `.inspector` cannot coexist and replaced both
        // with a hand-rolled `HStack`. They can coexist; the placement is what
        // matters.
        .inspector(isPresented: inspectorPresentation) { inspector }
        .focusedSceneValue(\.junoWorkspaceActions, workspaceActions)
        .fileImporter(
            isPresented: $isChoosingRepository,
            allowedContentTypes: [.folder],
            allowsMultipleSelection: false,
            onCompletion: grantRepository
        )
        // The panel is an NSOpenPanel, so New Folder is right there — but
        // nothing said so, and "choose" reads as "pick one that already
        // exists". Starting a project from nothing is a real path.
        .fileDialogMessage(
            Text(
                "Choose the folder Juno Code may read and write in — or make a new one."
            )
        )
        .fileDialogConfirmationLabel(Text("Open Project"))
        .sheet(isPresented: $isOpeningQuickly) {
            if let controller {
                OpenQuicklySheet(controller: controller) { path in
                    // Straight into the review's document editor, and the review has
                    // to be showing for it to be seen — `ReviewModel.open` sets its
                    // own `isPresented`, but this window owns whether the review
                    // occupies the detail column at all.
                    reviewVisible = true
                    Task { await controller.review.open(path, using: controller) }
                }
                // Sheet contract, applied at the presentation site because the
                // sheet's root lives in the JunoCode package. Open Quickly is a
                // file browser over a list, so it read as the coldest of the
                // eight groundless sheets — a grey pane over a warm workspace.
                // The platter, its material and its radius stay the system's.
                .junoSheetSurface(.fitted)
            }
        }
        .alert("Rename Session", isPresented: renameBinding) {
            TextField("Title", text: $renameText)
            Button("Rename") { commitRename() }
            Button("Cancel", role: .cancel) { renamingSession = nil }
        }
        .task { await bootstrap() }
        .task(id: liveRunCount) { await readPlan() }
        .task(id: selectedSessionID) { await resolveController() }
        // `open_preview` is an agent action, but the selected Code workbench
        // remains the authority that presents a pane. Bind it to both the
        // session and the granted root so a request from another window cannot
        // surface the wrong repository here.
        .onReceive(NotificationCenter.default.publisher(for: .junoCodePreviewOpenRequested)) { notification in
            guard let target = notification.object as? CodePreviewTarget,
                  target.sessionID == controller?.sessionID,
                  target.workspaceRootPath == controller?.context?.access.rootURL.path,
                  previewTarget == nil
            else { return }
            // The docks' insertion transition is the canvas-slide keyframe, so
            // it runs on the beat that keyframe was designed for: the pane
            // *arrives* on `canvasEnter`, exactly as Chat's artifact canvas
            // does. `JunoMotion.fast` here truncated a 16pt slide into a
            // 120ms tap-feedback blink.
            withAnimation(
                JunoMotion.reduced(DesktopChatMotion.canvasEnter, when: reduceMotion)
            ) {
                simulatorHost.closePane()
                previewTarget = target
            }
        }
        // A simulator belongs to one workspace. Changing workspace or session ends
        // the previous build, log stream and capture before anything new starts.
        .onChange(of: targetRepository?.id) { _, _ in
            simulatorHost.tearDown()
            closePreview()
        }
        .onChange(of: selectedSessionID) { _, _ in
            simulatorHost.tearDown()
            closePreview()
        }
        .task(id: selectedTask?.id) { followSelectedTask() }
        .task(id: remoteDeviceID) { await loadRemoteSessions() }
        .task(id: selection.wrappedValue) { await followSelectedRemoteSession() }
        .alert(
            "Voice unavailable",
            isPresented: Binding(
                get: { voiceUnavailable != nil },
                set: { if !$0 { voiceUnavailable = nil } }
            )
        ) {
            Button("OK", role: .cancel) { voiceUnavailable = nil }
        } message: {
            Text(voiceUnavailable ?? "Juno could not start voice mode.")
        }
        .onChange(of: codeModel.devices) { _, devices in
            selectDefaultRemoteDevice(from: devices)
        }
        // Deleting the selected session leaves the window pointing at nothing.
        // Without this the title stayed on a run that no longer exists, which
        // reads as a failure rather than as "that run is gone".
        .onChange(of: workbenchModel.sessions.count) { _, _ in
            guard case .session(let id) = selection.wrappedValue,
                !workbenchModel.sessions.contains(where: { $0.id == id })
            else { return }
            selection.wrappedValue = nil
        }
        .onAppear {
            if storedColumnVisibility == "detailOnly" {
                columnVisibility = .detailOnly
            }
        }
        // Leaving Code has to take screen control with it.
        //
        // Switching to Chat tears this whole view down — `JunoDesktopWorkspaceView`
        // instantiates one product at a time — but nothing detached the controller,
        // so an active capture kept running with both the "Screen control active"
        // indicator and its Stop button gone from the window. The capability stayed
        // live and unrevokable from the UI until the reader happened to come back.
        //
        // `detach()` is the same teardown used when moving between sessions: it
        // deactivates this session's capture and drops the store observer.
        // Re-entering re-attaches, because `WorkbenchModel.controller(for:)` now
        // re-attaches a cached controller.
        .onDisappear {
            simulatorHost.tearDown()
            previewTarget = nil
            guard let controller else { return }
            Task { await controller.detach() }
        }
        .onChange(of: columnVisibility) { _, visibility in
            storedColumnVisibility = visibility == .detailOnly ? "detailOnly" : "all"
        }
    }

    private var editorCanvas: some View {
        VStack(spacing: 0) {
            if shouldShowContextStrip {
                DesktopCodeContextStrip(
                    title: contextTitle,
                    subtitle: contextSubtitle,
                    status: currentStatus,
                    showsPreview: previewTarget != nil
                )
                Divider()
                    .overlay(Color.junoSeparator)
            }

            DesktopCodePreviewDock(
                target: previewTarget,
                close: closePreview,
                openInWindow: {
                    guard let previewTarget else { return }
                    openPreviewWindow(previewTarget)
                }
            ) {
                DesktopSimulatorDock(
                    model: simulatorHost.isOpen ? simulatorHost.model : nil,
                    close: {
                        // The exit half of the canvas choreography Chat's
                        // artifact canvas already runs: a pane you asked to
                        // close should be gone before you have looked away
                        // from the button. The ad-hoc 0.4s spring this
                        // replaces sat on no rung of the motion ladder and
                        // made closing the pane slower than opening it.
                        withAnimation(
                            JunoMotion.reduced(DesktopChatMotion.canvasExit, when: reduceMotion)
                        ) {
                            simulatorHost.closePane()
                        }
                    }
                ) {
                    detail
                }
            }
        }
    }

    private var shouldShowContextStrip: Bool {
        switch selection.wrappedValue {
        case .session, .task, .remote:
            true
        default:
            false
        }
    }

    private var contextTitle: String {
        switch selection.wrappedValue {
        case .session(let id):
            return workbenchModel.sessions.first { $0.id == id }?.title ?? "Code session"
        case .task:
            return selectedTask?.title ?? "Remote task"
        case .remote:
            return selectedRemoteSummary?.title ?? "Remote session"
        default:
            return "Juno Code"
        }
    }

    private var contextSubtitle: String {
        switch selection.wrappedValue {
        case .session(let id):
            guard let session = workbenchModel.sessions.first(where: { $0.id == id }) else {
                return "Local workspace"
            }
            guard let workspaceID = session.workspaceID,
                  let workspace = workbenchModel.workspaces.first(where: { $0.id == workspaceID })
            else { return "Local workspace" }
            return workspace.descriptor.displayName
        case .task:
            return selectedTask?.whereItRuns ?? "Cloud or connected device"
        case .remote:
            return selectedRemoteSummary?.workspaceName ?? "Connected computer"
        default:
            return ""
        }
    }

    // MARK: - Detail column

    @ViewBuilder
    private var detail: some View {
        switch selection.wrappedValue {
        case .session:
            if let controller {
                localSession(controller)
            } else if isBootstrapping {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // The bookmark could not be reopened, so there is genuinely no
                // session to show. `lastError` carries the real reason.
                JunoEmptyState(
                    title: "This session cannot be opened",
                    message: workbenchModel.lastError
                        ?? "Juno could not reopen the folder this session works in.",
                    icon: .error,
                    actionLabel: "Open Repository…",
                    action: { isChoosingRepository = true }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

        case .task(let id):
            if let task = codeModel.tasks.first(where: { $0.id == id }) {
                DesktopCodeTaskCanvas(task: task, code: codeModel)
            } else {
                JunoEmptyState(
                    title: "That run is no longer listed",
                    message: "It may have been removed from your account's recent runs.",
                    symbol: "bolt.horizontal.circle"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

        case .remote(let deviceID, let sessionID):
            DesktopCodeRemoteCanvas(
                summary: selectedRemoteSummary,
                deviceID: deviceID,
                sessionID: sessionID,
                remote: remoteModel
            )

        case .allProjects:
            DesktopCodeAllProjects(
                workbench: workbenchModel,
                isLoading: isBootstrapping,
                open: { selection.wrappedValue = .repository($0) },
                newSession: { selection.wrappedValue = .repository($0) },
                addProject: { isChoosingRepository = true },
                revealInFinder: { path in
                    NSWorkspace.shared.activateFileViewerSelecting([
                        URL(fileURLWithPath: path)
                    ])
                }
            )

        case .draft:
            draft(nil)

        case .pulls:
            // The button is back. This used to pass no `openConnections`, because
            // Connections was a Chat destination and switching product would have
            // landed the reader on whatever Chat happened to be showing. Code now
            // owns the page, so the one empty state a first-time Cloud user hits —
            // "GitHub isn't connected" — can finally do something about it.
            NativePullsView(
                client: pullsClient,
                accountID: accountID,
                openConnections: openConnections
            )

        // The three account pages are one branch each, built below rather than
        // written inline: each needs an availability ladder, and three more of
        // those inside this `@ViewBuilder` switch is how a detail column becomes
        // an expression the type checker gives up on.
        //
        // They bring toolbars of their own, and that is safe here for the same
        // reason it is safe in Chat: `DesktopChatWorkspace` also carries
        // `.inspector` on its split view and also swaps between destination
        // screens that declare toolbar items (Usage, Connections, Tasks). What
        // the crash note above forbids is *this file's* toolbar gaining and
        // losing items while the window stays put — a page swapping wholesale
        // for another page is a different thing, and it already ships.
        case .connections:
            connectionsPage

        case .usage:
            usagePage

        case .settings:
            settingsPage

        case .design:
            designPage

        case .repository(let id):
            // A repository that is no longer granted is exactly the state a
            // projectless conversation serves: the reader still has something
            // to say, and now has one fewer thing to say it about.
            draft(workbenchModel.workspaces.first { $0.id == id })

        case nil:
            if isBootstrapping {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // Opens on the most recent project when there is one, and on a
                // projectless conversation when there is not — never on a wall.
                draft(workbenchModel.workspaces.first)
            }
        }
    }

    // MARK: - The account pages
    //
    // Usage and Settings are the same two screens Chat shows, rendered here
    // rather than navigated to. That is not a shortcut around the product
    // switch — `JunoDesktopWorkspaceView` instantiates one product at a time
    // precisely so two `NavigationSplitView`s never negotiate against one
    // window, so "go to Chat's Usage page" is not a thing this window can do.
    // Rendering the screens themselves is what keeps there being one ledger
    // reader and one settings page instead of a Code-flavoured second copy of
    // each.

    /// The route to the connected-accounts page, or nothing when this window has
    /// no connector service to offer. `NativePullsView` drops its button rather
    /// than showing one that cannot act.
    private var openConnections: (() -> Void)? {
        guard configuration?.connectorModel != nil else { return nil }
        return { selection.wrappedValue = .connections }
    }

    @ViewBuilder
    private var connectionsPage: some View {
        if let model = configuration?.connectorModel {
            DesktopConnectionsScreen(model: model)
        } else {
            accountPageUnavailable("Connections", "The connector service is unavailable.")
        }
    }

    @ViewBuilder
    private var usagePage: some View {
        if let session {
            DesktopUsageScreen(
                session: session,
                requestSender: configuration?.requestSender,
                modelCatalog: configuration?.conversationModel?.selectableModels ?? []
            )
        } else {
            accountPageUnavailable("Usage", "Juno is not signed in on this window.")
        }
    }

    @ViewBuilder
    private var settingsPage: some View {
        if let session, let configuration, let model = configuration.memorySettingsModel {
            DesktopSettingsScreen(
                model: model,
                authModel: configuration.authModel,
                session: session,
                accountDataClient: configuration.accountDataClient,
                shareClient: configuration.shareClient,
                modelCatalog: configuration.conversationModel?.selectableModels ?? [],
                avatarData: configuration.avatarModel?.imageData,
                syncModel: configuration.syncModel,
                outbox: configuration.outbox,
                // Unlike the ⌘, window, this one has a column to navigate, so the
                // settings page's Usage tile finally has somewhere to go.
                openUsage: { selection.wrappedValue = .usage },
                codeHostModel: configuration.codeHostModel,
                workHostModel: configuration.workHostModel
            )
        } else {
            accountPageUnavailable("Settings", "Account settings could not be loaded.")
        }
    }

    /// Juno Design, the same one screen Chat's window shows.
    ///
    /// Rendered here rather than navigated to, exactly as Usage and Settings
    /// above are, and for the reason stated at the top of this section: one split
    /// view is alive at a time, so crossing to Chat to show a page is not
    /// something this window can do. A design is also the most natural thing in
    /// the app to want *while* looking at code — it is what the reader is about
    /// to ask Juno Code to build — so bouncing them out of the product to see it
    /// would be the wrong answer even if it were available.
    @ViewBuilder
    private var designPage: some View {
        if let session, let configuration, let model = configuration.artifactModel {
            DesktopDesignScreen(
                model: model,
                accountID: session.profile.id,
                requestSender: configuration.requestSender,
                syncModel: configuration.syncModel
            )
        } else {
            accountPageUnavailable("Design", "The synchronized artifact store is unavailable.")
        }
    }

    /// A destination this window can name but this composition cannot serve.
    ///
    /// Answered the same way Chat answers a missing model — by saying which
    /// screen is unavailable and why — rather than by dropping the row, which
    /// would leave a reader whose scene storage still points at it looking at a
    /// blank column.
    private func accountPageUnavailable(_ title: String, _ description: String) -> some View {
        ContentUnavailableView(
            title,
            systemImage: "exclamationmark.triangle",
            description: Text(description)
        )
    }

    private func draft(_ record: WorkspaceRecord?) -> some View {
        DesktopCodeDraftDetail(
            record: record,
            workbench: workbenchModel,
            code: codeModel,
            isStartingLocal: isStartingSession,
            startLocal: start,
            openTask: { task in
                selection.wrappedValue = .task(task.id)
            },
            addProject: { isChoosingRepository = true },
            selectProject: { id in
                // The window's selection is the single source of truth for
                // which project is open, so the menu writes there rather than
                // holding its own copy — that is what keeps the sidebar and the
                // composer from disagreeing about where you are.
                reviewVisible = false
                consoleVisible = false
                selection.wrappedValue = id.map { .repository($0) } ?? .draft
            },
            beginVoice: { modelID in
                startVoice(modelID: modelID, projectID: record?.id.value)
            },
            connectorModel: configuration?.connectorModel,
            voiceDock: voiceColumn.map { AnyView(DesktopVoiceDock(column: $0)) }
        )
        // Applied to the draft view itself, not around it.
        //
        // The single reading canvas this window owns is on the detail column
        // above, and `.junoReadingCanvas()` is an opaque `.background` — so a
        // field mounted anywhere outside that canvas stacks behind an opaque
        // fill and draws nothing. Here it is a descendant of the canvas rather
        // than a sibling of it, which is the arrangement Chat gets for free.
        .junoVoiceField(voiceColumn)
    }

    // MARK: - The session surface
    //
    // Two `JunoCodeUI` views are the whole boundary between this window shell and
    // the session surface, and they are the only cross-package view symbols this
    // file uses:
    //
    //     public struct CodeSessionCanvas: View {
    //         public init(
    //             controller: SessionController,
    //             model: WorkbenchModel,
    //             showsReview: Binding<Bool>,
    //             showsConsole: Binding<Bool>
    //         )
    //     }
    //     public struct CodeSessionInspector: View {
    //         public init(controller: SessionController)
    //     }
    //
    // The shell owns the window — columns, toolbar, titles, selection, session
    // lifecycle, repository grants — and owns nothing inside the canvas.
    // `CodeSessionCanvas` owns the transcript, the review editor, the console
    // drawer, the approval card and the composer, because their layout relative to
    // one another is a property of the session surface: the approval card sits
    // above the composer, the drawer sits between the content and the composer,
    // and the composer stays visible in both the transcript and the review.
    // `CodeSessionInspector` owns the three list-shaped segments.
    //
    // The two disclosure flags cross as bindings rather than as values so the
    // toolbar's toggles and the canvas's own affordances — clicking a changed file
    // opens Review — cannot disagree about what is showing.
    //
    // **Both halves of voice cross as erased views**, and for one reason:
    // `JunoCodeUI` depends on neither this target nor `JunoVoiceKit`, so it
    // cannot name a `DesktopVoiceColumn` or a `JunoRealtimeVoiceController`.
    // The dock has always crossed that way; the field now crosses beside it.
    //
    // The field could not simply be wrapped around `CodeSessionCanvas(…)` from
    // out here, which is the obvious thing and the thing that draws nothing at
    // all: the canvas paints `junoReadingCanvas()` — an opaque background —
    // inside its own body, and successive `.background` layers stack further
    // back, so a field written outside it lands behind an opaque fill. Handed in
    // through the initialiser it is mounted between that fill and the transcript,
    // which is where the light belongs. Chat never had to solve this because its
    // canvas sits on an ancestor of the column it lights, not on the column.

    private func localSession(_ controller: SessionController) -> some View {
        CodeSessionCanvas(
            controller: controller,
            model: workbenchModel,
            showsReview: $reviewVisible,
            showsConsole: $consoleVisible,
            beginDictation: JunoSpeechService.isSupported
                ? {
                    withAnimation(JunoMotion.fast) { isDictating = true }
                }
                : nil,
            beginVoice: {
                startVoice(for: controller)
            },
            voiceDock: voiceColumn.map { AnyView(DesktopVoiceDock(column: $0)) },
            voiceField: voiceColumn?.erasedField
        )
        // The same capsule the Chat composer uses, over the Code canvas.
        //
        // The recording UI and the speech service both live outside `JunoCodeUI`
        // — in this target and in `JunoVoiceKit` — and that package deliberately
        // depends on neither, so the composer asks for dictation through a closure
        // and the window supplies the surface. Pulling the voice stack into the
        // Code UI package to avoid one closure would have been the worse trade.
        .overlay(alignment: .bottom) {
            if isDictating {
                DesktopDictation(
                    onCancel: {
                        withAnimation(JunoMotion.fast) { isDictating = false }
                    },
                    onStop: { transcript in
                        appendDictated(transcript, to: controller)
                        withAnimation(JunoMotion.fast) { isDictating = false }
                    },
                    onSend: { transcript in
                        appendDictated(transcript, to: controller)
                        withAnimation(JunoMotion.fast) { isDictating = false }
                        Task { await controller.send() }
                    }
                )
                .padding(JunoSpace.regular)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        // The only glass in this window besides the composer: two transient
        // status controls, grouped in one container so they refract a shared
        // sample and blend instead of seaming where they meet.
        //
        // Grouped at the top trailing edge rather than split top and bottom: the
        // composer already floats along the bottom edge, and a second floating
        // control there would overlap it.
        .overlay(alignment: .topTrailing) {
            let waiting = sessionsWaitingForApproval(excluding: controller.sessionID)
            // The container is only built when something actually floats: an
            // empty `GlassEffectContainer` with padding would still reserve a box
            // over the canvas.
            if controller.computerUseActive || !waiting.isEmpty {
                JunoDesktopGlass(spacing: JunoSpace.snug) {
                    VStack(alignment: .trailing, spacing: JunoSpace.snug) {
                        computerUseIndicator(controller)
                        approvalJumpControl(waiting)
                    }
                }
                .padding(JunoSpace.regular)
            }
        }
    }

    /// The Code call uses the same account-authenticated relay and transcript
    /// route as Chat. Code has no chat thread to append to, so the server creates
    /// a normal conversation when the call is saved.
    private var voiceColumn: DesktopVoiceColumn? {
        guard let voiceSession,
            let configuration,
            let session
        else { return nil }
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
                return saved.conversationID
            },
            close: { self.voiceSession = nil }
        )
    }

    private func startVoice(for controller: SessionController) {
        startVoice(
            modelID: controller.session.configuration.modelID,
            projectID: controller.session.workspaceID?.value
        )
    }

    /// Starts the same realtime call from either a running Code session or the
    /// first-turn composer. A draft has no `SessionController` yet, but voice
    /// still has the same account-authenticated relay and can be saved against
    /// the selected project when the call ends.
    private func startVoice(modelID: String, projectID: String?) {
        guard voiceSession == nil else { return }
        guard let configuration, let session, let sender = configuration.requestSender else {
            voiceUnavailable = "Juno is not signed in, so it cannot start a voice conversation."
            return
        }
        guard configuration.voiceTranscriptClient != nil else {
            voiceUnavailable = "Voice is unavailable for this account."
            return
        }
        guard !modelID.isEmpty else {
            voiceUnavailable = "Choose a model before starting voice mode."
            return
        }

        let started = DesktopVoiceSession(
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
        voiceSession = started
        Task { await started.controller.start() }
    }

    @ViewBuilder
    private var inspector: some View {
        Group {
            if let controller {
                CodeSessionInspector(controller: controller, openPreview: openPreview)
            } else {
                // Compact rather than a full-height placeholder: with no local
                // session there is genuinely nothing to inspect, and cloud and
                // device runs report no structured changes at all.
                JunoEmptyState(
                    title: "Nothing to inspect",
                    message: """
                        Select a session on this Mac to see its changes, activity \
                        and repository.
                        """,
                    symbol: "sidebar.trailing"
                )
            }
        }
        .inspectorColumnWidth(
            min: DesktopCodeInspectorMetrics.minimum,
            ideal: DesktopCodeInspectorMetrics.ideal,
            max: DesktopCodeInspectorMetrics.maximum
        )
    }

    // MARK: - Floating status controls

    /// Screen control is a standing, dangerous grant, so its live indicator is
    /// read from the coordinator's own snapshot rather than assumed from the
    /// setting that enabled it.
    @ViewBuilder
    private func computerUseIndicator(_ controller: SessionController) -> some View {
        if controller.computerUseActive {
            HStack(spacing: JunoSpace.snug) {
                Image(systemName: "display.trianglebadge.exclamationmark")
                    .foregroundStyle(Color.junoDanger)
                Text("Screen control active").junoRowLabel()
                // Plain inside glass. Real glass carries its own rim light; a
                // second glass control inside a glass pill flattens both back
                // into translucent rounded rectangles.
                Button("Stop") {
                    Task { await controller.stopComputerUse() }
                }
                .buttonStyle(.borderless)
                .tint(Color.junoDanger)
                .accessibilityLabel("Stop screen control")
                .accessibilityIdentifier("juno.code.computer-use.stop")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .junoFloatingChrome(cornerRadius: JunoRadius.well)
            .accessibilityElement(children: .contain)
        }
    }

    /// Every run blocked on the reader, named by the session they can actually
    /// act in.
    ///
    /// A sub-agent has no sidebar row, so pointing "Show" at one would select a
    /// session the reader cannot otherwise reach — the "it just opened another
    /// chat" this pass removes, arrived at from the other direction. Filtering
    /// children out instead would be worse: an approval nobody can reach is a run
    /// that hangs forever. So a waiting child is reported as its parent, which is
    /// where its approval is surfaced and where answering it unblocks the work.
    /// Deduplicated, because two children of one parent are one place to go.
    private func sessionsWaitingForApproval(
        excluding current: CodeSessionID?
    ) -> [CodeSession] {
        var seen: Set<CodeSessionID> = []
        return workbenchModel.sessions
            .filter(\.hasPendingApproval)
            .compactMap { waiting in
                guard let parentID = waiting.parentSessionID else { return waiting }
                return workbenchModel.sessions.first { $0.id == parentID } ?? waiting
            }
            .filter { $0.id != current && seen.insert($0.id).inserted }
    }

    /// A run blocked on the reader that is not the one on screen.
    @ViewBuilder
    private func approvalJumpControl(_ waiting: [CodeSession]) -> some View {
        if let first = waiting.first {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.permission, size: 15)
                    .foregroundStyle(Color.junoCaution)
                Text(
                    waiting.count == 1
                        ? "1 run is waiting for approval"
                        : "\(waiting.count) runs are waiting for approval"
                )
                .junoRowLabel()
                // Explicitly tinted, and tinted the accent. A borderless button
                // with no tint resolves to the *system* accent asset — a hotter
                // orange than the brand's, and the one thing this pass is
                // removing — and the web draws exactly this shape, a text-only
                // action inside a notice, as `text-primary`.
                Button("Show") { selection.wrappedValue = .session(first.id) }
                    .buttonStyle(.borderless)
                    .tint(Color.junoAccent)
                    .accessibilityIdentifier("juno.code.show-approval")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .junoFloatingChrome(cornerRadius: JunoRadius.well)
            .accessibilityElement(children: .contain)
        }
    }

    // MARK: - Toolbar

    /// **Three groups, separated by the system's own spacer.**
    ///
    /// This bar used to be eight unlabelled icons in an unbroken row, then a
    /// hand-rolled `ellipsis.circle` menu that re-listed two of them, then a
    /// lone Stop. Nine controls with no separators is not a toolbar; it is a
    /// strip of icons the eye has to parse one at a time, and it was the worst
    /// single element in the window.
    ///
    /// What it is now:
    ///
    /// 1. **Make** — start a session. The only thing here that creates.
    /// 2. **Show** — the four panes this window can put beside the transcript.
    ///    Every one of them is a toggle, every one keeps its position and
    ///    disables rather than vanishing, and they read as one cluster because
    ///    `ToolbarSpacer(.fixed)` puts real air on both sides of them.
    /// 3. **Stop** — the trailing edge, and the bar's **one** tinted control.
    ///
    /// Everything else — add a project, open a file by name, build to a
    /// simulator, hand over the screen — is a *command* rather than a pane, and
    /// commands go to `.secondaryAction`, where the system collects them into
    /// its own overflow. That is the same set of items the `ellipsis.circle`
    /// menu held, minus the two it duplicated, and now the platform decides
    /// when and how to fold them rather than this file drawing a chevron.
    ///
    /// Every item is present in every state and disables rather than
    /// vanishing — both because a rebuilt AppKit toolbar is the documented crash
    /// surface here, and because a control that keeps its position is one the
    /// pointer does not have to re-find.
    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        // **No product switch here.** It is the first thing in the sidebar now —
        // `DesktopSidebarProductHeader`, drawn identically by both columns.
        //
        // It was in the toolbar because the first sidebar version was a bare
        // `safeAreaInset` with nothing painted behind it, so scrolled rows slid
        // under the switch and on under the traffic lights. That failure was the
        // missing backing, not the placement, and the header fixes it there. What
        // the toolbar cost in exchange was real: `.principal` shares the leading
        // half of the bar with the window's title block — the reason
        // `.navigationSubtitle` had to go was that a two-line titlebar shoved this
        // item off centre — and a control that changes what the *navigation*
        // column lists is a strange thing to have to reach for at the top of the
        // *content* column. `.navigation` was never an option: in a
        // `NavigationSplitView` it lands in the sidebar's titlebar, beside the
        // traffic lights.
        //
        // Both windows still move together: the header is one view, so the switch
        // cannot sit in one place in Chat and another in Code.

        ToolbarItem(placement: .principal) {
            DesktopChatWorkSwitcher(selection: $product)
        }
        .sharedBackgroundVisibility(.hidden)

        // Trailing, not `.navigation`: that placement draws into the *sidebar's*
        // titlebar beside the traffic lights, which is how a window action ended up
        // sitting inside the navigation column.
        ToolbarItem(placement: .primaryAction) {
            Button(action: newSession) {
                Label("New session", systemImage: "square.and.pencil")
            }
            .help("Start a new session in this repository (⌘N)")
            .accessibilityIdentifier("juno.code.new-session")
        }

        ToolbarSpacer(.fixed, placement: .primaryAction)

        // The panes. All four are toggles, so all four carry a symbol that
        // states which way the toggle currently sits — never a tint, because
        // the bar has exactly one tinted control and it is Stop. A row of
        // accent-filled toggles is four primary actions and therefore none.
        ToolbarItemGroup(placement: .primaryAction) {
            Button { openPreview() } label: {
                Label(
                    previewTarget == nil ? "Preview" : "Hide preview",
                    systemImage: previewTarget == nil
                        ? "rectangle.on.rectangle"
                        : "rectangle.on.rectangle.slash"
                )
                .symbolVariant(previewTarget == nil ? .none : .fill)
            }
            .keyboardShortcut("p", modifiers: [.command, .option])
            .help(previewTarget == nil ? "Open the live workspace preview (⌥⌘P)" : "Hide the live workspace preview (⌥⌘P)")
            .accessibilityIdentifier("juno.code.preview.primary")
            .disabled(controller?.context == nil)

            Button { consoleVisible.toggle() } label: {
                Label(
                    consoleVisible ? "Hide console" : "Show console",
                    systemImage: "apple.terminal"
                )
                .symbolVariant(consoleVisible ? .fill : .none)
            }
            .keyboardShortcut("c", modifiers: [.command, .option])
            .help(consoleVisible ? "Hide the console (⌥⌘C)" : "Show the console (⌥⌘C)")
            .accessibilityIdentifier("juno.code.console.toggle")
            .disabled(controller == nil)

            Button { reviewVisible.toggle() } label: {
                Label(
                    reviewVisible ? "Close review" : "Open review",
                    systemImage: "plusminus.circle"
                )
                .symbolVariant(reviewVisible ? .fill : .none)
            }
            .keyboardShortcut("r", modifiers: [.command, .option])
            .help(reviewVisible ? "Close the review pane (⌥⌘R)" : "Review this session's changes (⌥⌘R)")
            .accessibilityIdentifier("juno.code.review.toggle")
            .disabled(controller == nil)

            Button { inspectorVisible.toggle() } label: {
                Label(
                    inspectorVisible ? "Hide Code panels" : "Show Code panels",
                    systemImage: "sidebar.trailing"
                )
                .symbolVariant(inspectorVisible ? .fill : .none)
            }
            .keyboardShortcut("i", modifiers: [.command, .option])
            .help(inspectorVisible ? "Hide the Code panels (⌥⌘I)" : "Show the Code panels (⌥⌘I)")
            .accessibilityIdentifier("juno.code.inspector.toggle")
        }

        ToolbarSpacer(.fixed, placement: .primaryAction)

        ToolbarItem(placement: .primaryAction) {
            // Not `role: .destructive`.
            //
            // A destructive toolbar button is drawn in the system's red on macOS 26
            // whether or not it is enabled, which put a permanently red control in
            // the titlebar — a saturated blob sitting in empty space for the entire
            // time nothing was running, reading as an error indicator rather than as
            // a disabled action. Stop is also not destructive in the sense the role
            // means: it ends a run, it does not discard the reader's work.
            //
            // The colour now says something true instead. Red only while there is a
            // run to stop; otherwise the control keeps its place and greys out like
            // any other unavailable action.
            // `stop.circle`, not `stop.fill`.
            //
            // `stop.fill` is a solid square, and a solid square alone in a
            // toolbar capsule is not a control — it is the "lone square in a
            // grey box" the audit photographed, indistinguishable from a
            // rendering failure. Every other mark in this window is a circle
            // carrying a glyph, and Stop now joins that family.
            //
            // The colour is on the symbol rather than on `.tint`, which in a
            // macOS 26 toolbar addresses a prominent button's *background* and
            // therefore did nothing here: the control claimed to be red while a
            // run was live and drew black. Red only while there is a run to
            // stop; otherwise it greys out like any other unavailable action.
            // Not `role: .destructive`, which draws red whether or not the
            // control is enabled — a permanently saturated blob in empty
            // titlebar reads as an error indicator, and Stop is not destructive
            // in the sense the role means: it ends a run, it does not discard
            // the reader's work.
            Button(action: stop) {
                Label("Stop", systemImage: "stop.circle")
                    .foregroundStyle(
                        isRunning ? Color.junoDanger : Color.junoMutedForeground
                    )
            }
            .keyboardShortcut(".", modifiers: .command)
            .disabled(!isRunning)
            .help("Stop this run immediately (⌘.)")
            .accessibilityIdentifier("juno.code.stop")
        }

        // The commands. `.secondaryAction` is the system's own overflow: macOS
        // decides when the bar has room for these and folds them itself when it
        // does not. That is the whole reason the hand-rolled `ellipsis.circle`
        // is gone — an app that draws its own overflow chevron is guessing at a
        // decision the window server can actually make.
        ToolbarItemGroup(placement: .secondaryAction) {
            Button { isChoosingRepository = true } label: {
                Label("Add Project…", systemImage: "folder.badge.plus")
            }
            .keyboardShortcut("o", modifiers: .command)
            .accessibilityIdentifier("juno.code.add-project")

            // `OpenQuicklySheet` is a complete file browser that had zero call
            // sites: nothing in the app or the package ever presented it, so
            // the documented way to open a workspace file by name did not exist
            // in the shipping product. ⌘⇧O because plain ⌘O is already
            // "Add project…".
            Button { isOpeningQuickly = true } label: {
                Label("Open Quickly…", systemImage: "magnifyingglass")
            }
            .keyboardShortcut("o", modifiers: [.command, .shift])
            .disabled(controller?.context == nil)
            .accessibilityIdentifier("juno.code.open-quickly")

            Button(action: toggleComputerUse) {
                Label(
                    controller?.computerUseActive == true
                        ? "Stop Screen Control" : "Start Screen Control",
                    systemImage: controller?.computerUseActive == true
                        ? "display.trianglebadge.exclamationmark"
                        : "display"
                )
            }
            .disabled(!supportsComputerUse)
            // The reason, not just the dimming: the commonest one is "this model
            // can't see a screenshot", which is fixed by the model selector two
            // controls away, and a disabled control that will not say why reads
            // as broken rather than as unavailable.
            .help(computerUseHelp)
            .accessibilityIdentifier("juno.code.computer-use")
        }
    }

    /// Build and run the selected repository's iOS app.
    ///
    /// Lifted out of the toolbar so the item holding it can be unconditional:
    /// a `ToolbarItem` that appears and disappears makes SwiftUI rebuild the
    /// AppKit toolbar under a live window, which is the documented crash
    /// surface this file opens by warning about. The button is now always
    /// present and disables when there is no project.
    private func openSimulator() {
        guard let repository = targetRepository else { return }
        // Same beat as the preview dock opening: the pane's insertion is the
        // canvas-slide keyframe, and that keyframe belongs on `canvasEnter`.
        withAnimation(
            JunoMotion.reduced(DesktopChatMotion.canvasEnter, when: reduceMotion)
        ) {
            closePreview()
            simulatorHost.open(
                workspaceKey: repository.id.value,
                workspaceRoot: URL(fileURLWithPath: repository.descriptor.localPathHint)
            )
        }
    }

    private var currentStatus: CodeRunStatus? {
        if let controller {
            return CodeRunStatus(
                controller.session.status,
                hasPendingApproval: !controller.pendingApprovals.isEmpty
            )
        }
        if let selectedTask { return CodeRunStatus(selectedTask.status) }
        if let selectedRemoteSummary { return CodeRunStatus(selectedRemoteSummary) }
        return nil
    }

    private var isRunning: Bool {
        currentStatus?.isActive == true
    }

    /// Whether this session can control the screen at all.
    ///
    /// Delegates to `SessionController.computerUseUnavailableReason`, which is the
    /// only thing that knows the full set of conditions — local session, Code
    /// behavior, a live driver, **and a model that advertises vision**. This used
    /// to test `behavior == .code` and nothing else, so the menu item was enabled
    /// for a model that cannot see a screenshot; choosing it enabled the setting
    /// and then activation failed, which reads as the feature being broken rather
    /// than as the model being wrong for it.
    private var supportsComputerUse: Bool {
        controller?.computerUseUnavailableReason == nil
    }

    /// The reason, when there is one, so the menu explains itself instead of just
    /// being dimmed.
    private var computerUseHelp: String {
        guard let controller else {
            return "Screen control is only available for a session running on this Mac."
        }
        if let reason = controller.computerUseUnavailableReason {
            return reason
        }
        return controller.computerUseActive
            ? "Immediately stop screen capture and input control"
            : "Let this session capture and control the main display"
    }

    private func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    // MARK: - Menu bar

    /// The focused window publishes what the menu bar may do to it. Without this
    /// the Code window left ⌘N and ⌘⇧F permanently disabled, because only the Chat
    /// window ever published these actions.
    private var workspaceActions: DesktopWorkspaceActions {
        DesktopWorkspaceActions(
            newItem: newSession,
            newChat: newChat,
            openSearch: {
                columnVisibility = .all
                sidebarSearchFocused = true
            },
            switchProduct: { product = $0 },
            currentProduct: product
        )
    }

    // MARK: - Actions

    /// "New" means a new draft, as it does in Chat. Creating a persisted
    /// session before the reader has written anything filled Projects and
    /// Recents with abandoned "New session" rows and made ⌘N destructive to the
    /// reader's place in the current transcript.
    ///
    /// With no project granted this used to open the folder picker instead —
    /// ⌘N answered with a file dialog. It now opens the composer, and the
    /// project is offered from inside it.
    private func newSession() {
        reviewVisible = false
        consoleVisible = false
        if let record = targetRepository {
            selection.wrappedValue = .repository(record.id)
        } else {
            selection.wrappedValue = .draft
        }
    }

    private func openPreview() {
        guard let root = controller?.context?.access.rootURL else { return }
        if previewTarget != nil {
            closePreview()
            return
        }
        simulatorHost.closePane()
        previewTarget = CodePreviewTarget(
            workspaceRoot: root,
            sessionID: controller?.sessionID
        )
    }

    private func closePreview() {
        previewTarget = nil
    }

    private func openPreviewWindow(_ target: CodePreviewTarget) {
        openWindow(id: CodePreviewScene.windowID, value: target)
    }

    /// Creates and starts the local run described by the launch composer.
    ///
    /// The old path hard-coded Code / Ask Before Changes / first model and made
    /// the reader click a second composer to actually start. One draft value now
    /// crosses the boundary intact, and its first send is the first transcript
    /// turn—matching Juno Chat, Codex, and Claude Code.
    private func start(_ draft: DesktopLocalCodeDraft) {
        guard !isStartingSession else { return }
        isStartingSession = true
        Task {
            defer { isStartingSession = false }
            guard let session = await workbenchModel.createSession(
                workspaceID: draft.workspaceID,
                configuration: draft.configuration
            ) else { return }
            await workbenchModel.renameSession(
                id: session.id,
                title: DesktopLocalCodeDraft.title(from: draft.prompt)
            )
            reviewVisible = false
            consoleVisible = false
            selection.wrappedValue = .session(session.id)
            guard let created = await workbenchModel.controller(for: session.id) else {
                return
            }
            for path in draft.fileReferences {
                created.registerComposerFileReference(path)
            }
            for attachment in draft.attachments {
                created.attach(attachment)
            }
            created.composerText = draft.prompt
            await created.send()
        }
    }

    private func stop() {
        if let controller {
            Task { await controller.stop() }
        } else if selectedTask != nil {
            Task { await codeModel.cancelOpenTask() }
        } else if let selectedRemote {
            Task {
                await remoteModel.stopGeneration(
                    deviceID: selectedRemote.deviceID,
                    sessionID: selectedRemote.sessionID
                )
            }
        }
    }

    /// Enabling the capability and activating capture are one gesture here, but
    /// two steps in the coordinator: the session's stored setting is the standing
    /// grant, and activation is the consent boundary that actually starts capture.
    private func toggleComputerUse() {
        guard let controller else { return }
        Task {
            if controller.computerUseActive {
                await controller.stopComputerUse()
            } else {
                if !controller.session.configuration.computerUseEnabled {
                    await controller.setComputerUseEnabled(true)
                }
                await controller.activateComputerUse()
            }
        }
    }

    private func grantRepository(_ result: Result<[URL], any Error>) {
        guard case .success(let urls) = result, let url = urls.first else { return }
        Task {
            guard let record = await workbenchModel.addWorkspace(grantedURL: url) else {
                return
            }
            selection.wrappedValue = .repository(record.id)
        }
    }

    /// Appends a dictated passage to whatever is already in the composer.
    ///
    /// Appended rather than assigned: dictation is a way of adding to a message,
    /// and replacing a half-typed draft with a transcript would silently discard it.
    private func appendDictated(_ transcript: String, to controller: SessionController) {
        let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return }
        let existing = controller.composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        controller.composerText = existing.isEmpty ? spoken : "\(existing) \(spoken)"
    }

    private func beginRename(_ session: CodeSession) {
        renameText = session.title
        renamingSession = session
    }

    private var renameBinding: Binding<Bool> {
        Binding(
            get: { renamingSession != nil },
            set: { if !$0 { renamingSession = nil } }
        )
    }

    private func commitRename() {
        guard let session = renamingSession else { return }
        let title = renameText
        renamingSession = nil
        Task { await workbenchModel.renameSession(id: session.id, title: title) }
    }

    // MARK: - Lifecycle

    private func bootstrap() async {
        await workbenchModel.bootstrap()
        isBootstrapping = false
        // The device list may already be loaded when the reader switches product,
        // in which case `onChange` never fires.
        selectDefaultRemoteDevice(from: codeModel.devices)

        #if DEBUG
        // Responsive QA has to be able to screenshot both inspector states, and
        // `@SceneStorage` is restored by AppKit before any of our code runs.
        if CommandLine.arguments.contains("--juno-preview-inspector") {
            inspectorVisible = true
        }
        if previewSessionID != nil {
            return
        }
        #endif

        // Scene storage outlives the runs it names. A window that reopened onto a
        // deleted session showed a title over an empty canvas, which reads as a
        // failure rather than as "that run is gone".
        let validated = DesktopCodeNavigationState.validate(
            selection.wrappedValue,
            // Visible ones only: a stored selection naming a sub-agent would
            // otherwise validate and reopen the window onto a session that has no
            // row to return to.
            sessions: workbenchModel.visibleSessions.map(\.id),
            tasks: codeModel.tasks.map(\.id),
            repositories: workbenchModel.workspaces.map(\.id)
        )
        storedSelection = DesktopCodeNavigationState.encode(validated)
    }

    /// Resolves the selected session's live controller.
    ///
    /// The previous controller is detached on the way out. That is not just
    /// tidiness: `detach()` is what deactivates that session's screen capture, and
    /// capture must not keep running on a session the reader has navigated away
    /// from. The run itself continues — the orchestrator is independent of this
    /// view — and re-selecting replays the whole transcript from the store.
    private func resolveController() async {
        if let previous = controller, previous.sessionID != selectedSessionID {
            await previous.detach()
        }
        guard let selectedSessionID else {
            controller = nil
            return
        }
        workbenchModel.selectedSessionID = selectedSessionID
        controller = await workbenchModel.controller(for: selectedSessionID)
    }

    private func followSelectedTask() {
        guard let selectedTask else { return }
        codeModel.open(selectedTask)
    }

    private func loadRemoteSessions() async {
        guard !remoteDeviceID.isEmpty else { return }
        await remoteModel.loadSessions(deviceID: remoteDeviceID)
    }

    /// The relay has no push channel, so a watched session is polled. The loop is
    /// bound to the selection through `.task(id:)`, which cancels it the moment
    /// the reader looks at something else.
    private func followSelectedRemoteSession() async {
        guard let selectedRemote else { return }
        remoteModel.openSession(selectedRemote.sessionID)
        while !Task.isCancelled {
            await remoteModel.pollEvents(
                deviceID: selectedRemote.deviceID,
                sessionID: selectedRemote.sessionID
            )
            try? await Task.sleep(for: .seconds(2))
        }
    }

    // MARK: - Plan meters

    /// How many runs are live, across every transport this window lists.
    ///
    /// It is the read trigger rather than a timer: a run starting or finishing is
    /// the only thing this window does that can move the meter, and polling the
    /// ledger once a minute would spend a request to redraw a bar that had not
    /// changed. The explicit Refresh lives on the Usage page the meter opens.
    private var liveRunCount: Int {
        workbenchModel.sessions.filter(\.status.isActive).count
            + codeModel.tasks.filter(\.status.isActive).count
    }

    /// One read of the account's plan meters.
    ///
    /// `NativeUsageClient.load` fetches the meters and the ledger breakdown
    /// together — the two routes fail independently and every screen that shows
    /// usage shows both — so this asks for the client's shortest window and keeps
    /// only the half the footer draws. A failed read leaves the last known plan
    /// standing rather than blanking the meter, because a bar that disappears
    /// reads as a quota that vanished.
    private func readPlan() async {
        guard let sender = configuration?.requestSender, let session else { return }
        if plan != nil, let planReadAt,
            Date().timeIntervalSince(planReadAt) < Self.planReadFloor
        {
            return
        }
        let snapshot = await NativeUsageClient(sender: sender)
            .load(range: .month, for: session.profile.id)
        guard let loaded = snapshot.plan else { return }
        planReadAt = Date()
        withAnimation(JunoMotion.standard) { plan = loaded }
    }

    private func selectDefaultRemoteDevice(from devices: [NativeCodeDevice]) {
        guard remoteDeviceID.isEmpty || !devices.contains(where: { $0.id == remoteDeviceID })
        else { return }
        remoteDeviceID = devices.first(where: \.online)?.id ?? devices.first?.id ?? ""
    }
}

// MARK: - Cloud and device runs

/// A run on Juno's cloud runner or on another computer, followed over the task
/// relay. The detail view is shared with the account-level remote task monitor,
/// so opening a task from the integrated Code sidebar keeps the same live
/// reconnect state, approvals, cancellation, pull-request link and follow-up
/// controls instead of falling into a reduced event-only view.
private struct DesktopCodeTaskCanvas: View {
    let task: NativeCodeTask
    let code: NativeCodeModel
    @State private var selection: String?

    init(task: NativeCodeTask, code: NativeCodeModel) {
        self.task = task
        self.code = code
        _selection = State(initialValue: task.id)
    }

    var body: some View {
        CodeRemoteTaskDetailView(
            model: code,
            taskID: task.id,
            selection: $selection
        )
        .id(task.id)
    }
}

// MARK: - Relay-watched sessions

/// A reader-facing projection of the relay protocol.
///
/// The relay deliberately transports a small, forward-compatible `(kind,
/// payload)` envelope. That is useful at the protocol boundary, but showing the
/// envelope in the product makes Remote Code feel like a log viewer rather than
/// the same agent experience running on another Mac. Keep the wire shape loose
/// and make the presentation typed here, with a graceful fallback for newer
/// event kinds this binary does not know yet.
private struct DesktopRemoteEventPresentation {
    let title: String
    let detail: String?
    let symbol: String
    let tint: Color
    let usesMonoDetail: Bool

    static func make(_ event: CodeRemoteSessionEvent) -> Self {
        let payload = event.payload
        let value: ([String]) -> String? = { keys in
            for key in keys {
                if let value = payload[key]?.stringValue,
                   !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                {
                    return value
                }
            }
            return nil
        }

        switch event.kind {
        case "message", "user", "user_message":
            return Self(
                title: value(["text", "message"]) ?? "Message sent",
                detail: nil,
                symbol: "person.crop.circle",
                tint: .secondary,
                usesMonoDetail: false
            )
        case "text", "assistant", "assistant_text", "response":
            return Self(
                title: value(["text", "message"]) ?? "Juno replied",
                detail: nil,
                symbol: "sparkles",
                tint: .junoAccent,
                usesMonoDetail: false
            )
        case "tool", "tool_call", "tool_started":
            return Self(
                title: value(["summary", "name", "toolName"]) ?? "Running a tool",
                detail: value(["command", "detail"]),
                symbol: "terminal",
                tint: .secondary,
                usesMonoDetail: true
            )
        case "tool_output", "terminal", "command_output":
            return Self(
                title: value(["summary", "name"]) ?? "Command output",
                detail: value(["text", "output", "detail"]),
                symbol: "chevron.left.forwardslash.chevron.right",
                tint: .secondary,
                usesMonoDetail: true
            )
        case "file_change", "file_changed":
            let path = value(["path", "file"]) ?? "A file"
            let added = payload["added"]?.numberValue.map { Int($0) }
            let removed = payload["removed"]?.numberValue.map { Int($0) }
            let counts = if let added, let removed {
                "+\(added)  −\(removed)"
            } else {
                value(["detail", "changeKind"])
            }
            return Self(
                title: "Changed \(path)",
                detail: counts,
                symbol: "doc.text",
                tint: .junoAccent,
                usesMonoDetail: true
            )
        case "approval_request":
            return Self(
                title: "Approval required",
                detail: value(["summary", "text", "detail"]),
                symbol: "hand.raised.fill",
                tint: .junoCaution,
                usesMonoDetail: false
            )
        case "approval_response":
            let approved = payload["approve"]?.boolValue
                ?? payload["approved"]?.boolValue
                ?? false
            return Self(
                title: approved ? "Approval granted" : "Approval denied",
                detail: value(["summary", "detail"]),
                symbol: approved ? "checkmark.circle" : "xmark.circle",
                tint: approved ? .junoSuccess : .junoDanger,
                usesMonoDetail: false
            )
        case "subagent_update", "agent":
            let agent: [String: JunoJSONValue]? = if case .object(let object)? = payload["agent"] {
                object
            } else {
                nil
            }
            let title = agent?["title"]?.stringValue
                ?? value(["title", "summary"])
                ?? "Sub-agent update"
            let status = agent?["status"]?.stringValue
                ?? value(["status", "detail"])
            return Self(
                title: title,
                detail: status,
                symbol: "person.2",
                tint: .junoAccent,
                usesMonoDetail: false
            )
        case "status", "status_changed":
            return Self(
                title: value(["status", "title", "text"]) ?? "Session status changed",
                detail: value(["detail", "summary"]),
                symbol: "waveform.path.ecg",
                tint: .secondary,
                usesMonoDetail: false
            )
        case "error", "failed":
            return Self(
                title: value(["message", "error", "text"]) ?? "Remote session error",
                detail: value(["detail", "summary"]),
                symbol: "exclamationmark.triangle.fill",
                tint: .junoDanger,
                usesMonoDetail: false
            )
        case "done", "completed", "session_completed":
            return Self(
                title: "Session finished",
                detail: value(["summary", "detail"]),
                symbol: "checkmark.circle.fill",
                tint: .junoSuccess,
                usesMonoDetail: false
            )
        default:
            let fallback = value(["text", "detail", "summary", "title", "message"])
                ?? encodedPayload(payload)
            return Self(
                title: humanize(event.kind),
                detail: fallback,
                symbol: "circle.dotted",
                tint: .secondary,
                usesMonoDetail: true
            )
        }
    }

    private static func humanize(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    private static func encodedPayload(_ payload: [String: JunoJSONValue]) -> String? {
        guard let data = try? JSONEncoder().encode(payload),
              let encoded = String(data: data, encoding: .utf8)
        else { return nil }
        return encoded.count > 1_200 ? String(encoded.prefix(1_200)) + "…" : encoded
    }
}

/// A session running on another Mac, driven through the relay.
///
/// Unlike a cloud task this transport *does* accept messages
/// (`CodeRemoteBrowserModel.send`), so it gets a composer.
private struct DesktopCodeRemoteCanvas: View {
    let summary: CodeRemoteSessionSummary?
    let deviceID: String
    let sessionID: String
    let remote: CodeRemoteBrowserModel

    @State private var message = ""

    private static let measure: CGFloat = 720

    var body: some View {
        VStack(spacing: 0) {
            if let summary {
                sessionHeader(summary)
            }
            ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: JunoSpace.snug) {
                    ForEach(remote.events, id: \.seq) { event in
                        eventRow(event).id(event.seq)
                    }
                    if let error = remote.lastErrorDescription {
                        errorRow(error)
                    }
                }
                .frame(maxWidth: Self.measure, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(JunoSpace.region)
            }
            .onChange(of: remote.cursor) { _, cursor in
                withAnimation(JunoMotion.fast) { proxy.scrollTo(cursor, anchor: .bottom) }
            }
            }
        }
        .overlay {
            if remote.events.isEmpty && remote.lastErrorDescription == nil {
                JunoEmptyState(
                    title: summary == nil ? "That session is not listed" : "Nothing yet",
                    message: summary == nil
                        ? "The computer that owns it may have gone offline."
                        : "This computer has not reported any activity for this session yet.",
                    symbol: "laptopcomputer.and.arrow.down"
                )
                .allowsHitTesting(false)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: JunoSpace.snug) {
                if let request = pendingApproval {
                    DesktopCodeRelayApproval(
                        summary: request.summary,
                        risk: request.risk,
                        detail: nil,
                        toolName: request.toolName,
                        isBusy: remote.isSendingCommand,
                        respond: { approved in
                            Task {
                                await remote.respondToApproval(
                                    deviceID: deviceID,
                                    sessionID: sessionID,
                                    requestID: request.id,
                                    approved: approved
                                )
                            }
                        }
                    )
                }
                composer
            }
            .frame(maxWidth: Self.measure, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, JunoSpace.region)
            .padding(.bottom, JunoSpace.regular)
        }
    }

    private func sessionHeader(_ summary: CodeRemoteSessionSummary) -> some View {
        let status = CodeRunStatus(summary)
        return HStack(alignment: .top, spacing: JunoSpace.snug) {
            Image(systemName: "laptopcomputer")
                // Scaled against the callout title it marks, so the pair grows
                // together under Dynamic Type instead of the glyph staying a
                // fixed 15pt beside enlarged text.
                .junoFont(size: 15, relativeTo: .callout, weight: .semibold)
                .foregroundStyle(Color.junoAccent)
                .frame(width: 28, height: 28)
                .background(Color.junoAccent.opacity(0.12), in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: JunoSpace.snug) {
                    Text(summary.title)
                        .junoRowLabel()
                        .lineLimit(1)
                    Spacer(minLength: JunoSpace.hairline)
                    HStack(spacing: JunoSpace.hairline) {
                        Image(systemName: status.symbol)
                        Text(status.label)
                    }
                    .font(.caption)
                    .foregroundStyle(status.tint)
                    .padding(.horizontal, JunoSpace.snug)
                    .padding(.vertical, 3)
                    .background(Capsule(style: .continuous).fill(status.tint.opacity(0.13)))
                }

                HStack(spacing: JunoSpace.snug) {
                    Text(summary.workspaceName ?? "Remote workspace")
                        .junoCaption()
                        .lineLimit(1)
                    if let branch = summary.activeBranch, !branch.isEmpty {
                        Label(branch, systemImage: "arrow.triangle.branch")
                            .junoCaption()
                            .lineLimit(1)
                    }
                    if summary.pendingChangeCount > 0 {
                        Label(
                            "\(summary.pendingChangeCount) change\(summary.pendingChangeCount == 1 ? "" : "s")",
                            systemImage: "doc.badge.gearshape"
                        )
                        .junoCaption()
                        .foregroundStyle(Color.junoAccent)
                    }
                    Spacer(minLength: JunoSpace.hairline)
                    Text(summary.updatedAt, style: .relative)
                        .junoCaption()
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, JunoSpace.region)
        .padding(.vertical, JunoSpace.snug)
        .background(Color.primary.opacity(0.035))
        // The palette's own separator, as the context strip above the canvas
        // already draws it — not a hand-faded system divider, which was a
        // second, slightly different hairline in the same window.
        .overlay(alignment: .bottom) { Divider().overlay(Color.junoSeparator) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(summary.title), \(summary.workspaceName ?? "remote workspace"), \(status.label)"
        )
    }

    /// A deliberately minimal composer. The next-turn contract — mode, model,
    /// reasoning — belongs to the host that owns the session; the relay exposes no
    /// route to change any of it, so this surface offers only what it can do.
    private var composer: some View {
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            HStack(alignment: .bottom, spacing: JunoSpace.snug) {
                TextField(placeholder, text: $message, axis: .vertical)
                    .textFieldStyle(.plain)
                    .junoBody()
                    .lineLimit(1...8)
                    .disabled(!canSend)
                    .onSubmit(send)
                    .accessibilityIdentifier("juno.code.remote-composer")
                if summary?.isRunning == true {
                    Button {
                        Task {
                            await remote.stopGeneration(deviceID: deviceID, sessionID: sessionID)
                        }
                    } label: {
                        Image(systemName: "stop.fill")
                            .frame(width: 22, height: 22)
                    }
                    .buttonStyle(.bordered)
                    .tint(Color.junoDanger)
                    .disabled(remote.isSendingCommand)
                    .keyboardShortcut(".", modifiers: .command)
                    .accessibilityLabel("Stop this session")
                }
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .frame(width: 22, height: 22)
                }
                .junoProminentGlassButton()
                .disabled(!canSend || trimmed.isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel("Send to this computer")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .junoFloatingChrome(cornerRadius: CGFloat(JunoRadius.composer))
        }
    }

    private var trimmed: String {
        message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSend: Bool {
        guard let summary else { return false }
        return summary.fresh != false && !remote.isSendingCommand
    }

    private var placeholder: String {
        guard let summary else { return "This session is not available" }
        if summary.fresh == false { return "That computer has stopped checking in" }
        if summary.isRunning { return "Juno is working — your message is queued" }
        return "Send a message to this session"
    }

    /// The relay reports approvals as events rather than as state, so the pending
    /// one is the newest request the transcript has not seen answered.
    private var pendingApproval: (id: String, summary: String, risk: String, toolName: String?)? {
        var answered: Set<String> = []
        var latest: (id: String, summary: String, risk: String, toolName: String?)?
        for event in remote.events {
            switch event.kind {
            case "approval_response":
                if let id = event.payload["requestId"]?.stringValue { answered.insert(id) }
            case "approval_request":
                guard let id = event.payload["requestId"]?.stringValue else { continue }
                latest = (
                    id: id,
                    summary: event.payload["summary"]?.stringValue
                        ?? event.payload["text"]?.stringValue
                        ?? "Juno is asking to run a tool on that computer.",
                    risk: event.payload["risk"]?.stringValue ?? "write",
                    toolName: event.payload["toolName"]?.stringValue
                )
            default:
                continue
            }
        }
        guard let latest, !answered.contains(latest.id) else { return nil }
        return latest
    }

    private func eventRow(_ event: CodeRemoteSessionEvent) -> some View {
        let presentation = DesktopRemoteEventPresentation.make(event)
        return HStack(alignment: .top, spacing: JunoSpace.snug) {
            Image(systemName: presentation.symbol)
                // Scaled against the callout row title it marks, for the same
                // reason as the session header's laptop glyph above.
                .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                .foregroundStyle(presentation.tint)
                .frame(width: 24, height: 24)
                .background(presentation.tint.opacity(0.12), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text(presentation.title)
                        .junoRowLabel()
                        .lineLimit(2)
                    Spacer(minLength: JunoSpace.hairline)
                    Text(event.createdAt, style: .time)
                        .junoCaption()
                        .monospacedDigit()
                }
                if let detail = presentation.detail {
                    Text(detail)
                        .lineLimit(6)
                        .textSelection(.enabled)
                        .modifier(DesktopRemoteDetailStyle(usesMono: presentation.usesMonoDetail))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: CGFloat(JunoRadius.row), style: .continuous)
                .fill(Color.primary.opacity(0.035))
        )
        .overlay {
            RoundedRectangle(cornerRadius: CGFloat(JunoRadius.row), style: .continuous)
                .stroke(presentation.tint.opacity(0.14), lineWidth: 0.7)
        }
    }

    private func errorRow(_ message: String) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(Color.junoDanger)
            Text(message)
                .junoCaption()
                .foregroundStyle(Color.junoDanger)
                .textSelection(.enabled)
            Spacer(minLength: JunoSpace.snug)
            Button("Retry") {
                Task { await remote.pollEvents(deviceID: deviceID, sessionID: sessionID) }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: CGFloat(JunoRadius.row), style: .continuous)
                .fill(Color.junoDanger.opacity(0.08))
        )
    }

    private func send() {
        let text = trimmed
        guard canSend, !text.isEmpty else { return }
        message = ""
        Task { await remote.send(deviceID: deviceID, sessionID: sessionID, text: text) }
    }
}

/// A quiet context strip for an active Code surface.
///
/// The toolbar owns actions; this strip owns orientation. Keeping the project,
/// session and run state beside the transcript prevents the reader from having
/// to infer which of several local, cloud or device rows is currently open.
private struct DesktopCodeContextStrip: View {
    let title: String
    let subtitle: String
    let status: CodeRunStatus?
    let showsPreview: Bool

    var body: some View {
        // `CodePageHeader` owns the strip's anatomy — the mark, the 52pt, the
        // canvas ground, the path in the code face. What used to be here was a
        // fourth hand-built header with its own metrics and, worse, a *seventh*
        // rendering of run status: a bare tinted `Circle` beside a label, in a
        // card, agreeing with nothing else in the window.
        //
        // The "JUNO CODE" overline is gone with it. The product's name above
        // the session's own name, inside the product, is chrome that says
        // nothing the sidebar's product switch has not already said.
        CodePageHeader(
            icon: .code,
            title: title,
            subtitle: subtitle.isEmpty ? nil : subtitle
        ) {
            if showsPreview {
                Label("Preview live", systemImage: "dot.radiowaves.left.and.right")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Color.junoSuccess)
                    .labelStyle(.titleAndIcon)
            }

            if let status {
                HStack(spacing: JunoSpace.tight) {
                    CodeStatusGlyph(status)
                    Text(status.label)
                        .junoCaption()
                        .contentTransition(.identity)
                }
                .help(status.state.meaning)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Status: \(status.label)")
            }
        }
        .accessibilityIdentifier("juno.code.context-strip")
    }
}

private struct DesktopRemoteDetailStyle: ViewModifier {
    let usesMono: Bool

    func body(content: Content) -> some View {
        if usesMono {
            content.junoMono().junoSecondaryInk()
        } else {
            content.junoCaption().junoSecondaryInk()
        }
    }
}

// MARK: - Approval, relay transports

/// The approval card for the two transports that are not this Mac.
///
/// Opaque, pinned above the composer, never a sheet: a modal would cover the
/// transcript the reader needs in order to answer. It carries no countdown
/// because neither relay payload carries an expiry — the local session's card
/// does, from `ApprovalRequest.expiresAt`, and inventing one here would be a
/// deadline the server does not actually enforce.
private struct DesktopCodeRelayApproval: View {
    let summary: String
    let risk: String
    let detail: String?
    let toolName: String?
    let isBusy: Bool
    let respond: (Bool) -> Void

    private var isCritical: Bool { risk.lowercased() == "critical" }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.permission, size: 16)
                    .foregroundStyle(isCritical ? Color.junoDanger : Color.junoCaution)
                Text("Approval required").junoTitle()
                Spacer(minLength: 0)
                Text(risk.capitalized)
                    .junoCaption()
                    .foregroundStyle(isCritical ? Color.junoDanger : Color.junoCaution)
            }

            Text(summary).junoBody()

            if let toolName {
                Text(toolName).junoMono().junoSecondaryInk()
            }
            if let detail {
                Text(detail).junoCaption().textSelection(.enabled)
            }

            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Deny", role: .destructive) { respond(false) }
                    .keyboardShortcut(.escape, modifiers: .shift)
                // The one primary action on the card, so it keeps the accent —
                // `code-session-view.tsx` gives its own Allow button the default
                // `bg-primary` variant for the same reason. The accent stays
                // where the web puts it; it left the places the web does not.
                Button("Approve") { respond(true) }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .keyboardShortcut(.return, modifiers: .shift)
            }
            .disabled(isBusy)
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoPanel()
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(isCritical ? Color.junoDanger : Color.junoCaution)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Approval required: \(summary)")
    }
}
