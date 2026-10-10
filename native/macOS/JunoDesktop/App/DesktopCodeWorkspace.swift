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

/// The Code window: the session column, the thread, and one side panel.
///
/// Three regions and no more. The column lists sessions by project; the
/// centre is the landing composer or a session's thread; the side panel holds
/// the session's changes and a terminal, and is the window's inspector so the
/// platform draws its divider and remembers its width.
///
/// Two stability rules from `MACOS_ARCHITECTURE.md` hold here: every toolbar
/// item is always present and disables rather than disappears, and every
/// anchored popover declares an explicit frame.
struct DesktopCodeWorkspace: View {
    let workbenchModel: WorkbenchModel
    let codeModel: NativeCodeModel
    let remoteModel: CodeRemoteBrowserModel
    let pullsClient: NativeGitHubPullsClient?
    let accountID: AccountID?
    var configuration: JunoDesktopConfiguration?
    var session: NativeAuthenticatedSession?
    @Binding var product: DesktopProductMode
    /// Starts a normal Juno conversation, independent of a repository.
    let newChat: () -> Void

    @SceneStorage("juno.desktop.code.selection") private var storedSelection = ""
    @SceneStorage("juno.desktop.code.columns") private var storedColumnVisibility = ""
    @SceneStorage("juno.desktop.code.panel") private var panelVisible = false
    @SceneStorage("juno.desktop.code.panel-tab") private var storedPanelTab = StudioPanelTab.changes.rawValue
    @SceneStorage("juno.desktop.code.remote-device") private var remoteDeviceID = ""

    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var controller: SessionController?
    @State private var isBootstrapping = true
    @State private var isStartingSession = false
    @State private var isChoosingRepository = false
    @State private var renamingSession: CodeSession?
    @State private var renameText = ""
    @State private var isOpeningQuickly = false
    @State private var showingPalette = false
    @State private var isCreatingPullRequest = false
    /// A prompt handed in from the quick-entry panel or the menu bar item,
    /// consumed by the next landing screen.
    @State private var pendingPrompt: String?
    @State private var pendingEnvironment: CodeEnvironmentChoice?
    @State private var simulatorHost = DesktopSimulatorHost()
    @State private var isDictating = false
    @State private var previewTarget: CodePreviewTarget?
    @State private var voiceSession: DesktopVoiceSession?
    @State private var voiceUnavailable: String?
    @State private var registry = DesktopWorkbenchRegistry.shared
    // Code v2: the composer's shared choices, the env server for
    // subscriptions, which threads it runs, and its dock.
    @State private var v2Composer = CodeV2ComposerModel(
        selection: CodeV2.ModelSelection(instanceId: "alevr", model: ""),
        defaultsKey: "juno.code.v2.composer"
    )
    @State private var envHub = EnvServerHub.shared
    @State private var envBindings = CodeV2SessionBindings.shared
    @State private var envDock = CodeV2DockController()
    @State private var v2Keys = CodeV2KeysModel()
    @Environment(\.openWindow) private var openWindow
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // MARK: - Selection

    private var selection: Binding<DesktopCodeSidebarItem?> {
        Binding(
            get: {
                if let previewSessionID { return .session(previewSessionID) }
                return DesktopCodeNavigationState.decode(storedSelection)
            },
            set: { storedSelection = DesktopCodeNavigationState.encode($0) }
        )
    }

    private var previewSessionID: CodeSessionID? {
        #if DEBUG
        guard CommandLine.arguments.contains("--juno-preview-code-session") else { return nil }
        return workbenchModel.selectedSessionID ?? workbenchModel.sessions.first?.id
        #else
        return nil
        #endif
    }

    private var panelTab: Binding<StudioPanelTab> {
        Binding(
            get: { StudioPanelTab(rawValue: storedPanelTab) ?? .changes },
            set: { storedPanelTab = $0.rawValue }
        )
    }

    private var panelPresentation: Binding<Bool> {
        Binding(
            get: {
                if envBinding != nil { return envDock.isOpen }
                return panelVisible && controller != nil && selectedSessionID != nil
            },
            set: { open in
                if envBinding != nil { envDock.isOpen = open } else { panelVisible = open }
            }
        )
    }

    /// Every place a model can run: Alevr, the subscriptions the env server
    /// reports, and the user's own keys.
    private var v2Directory: CodeV2ProviderDirectory {
        CodeV2ProviderDirectory.build(
            alevr: CodeV2AlevrCatalog.instance(from: workbenchModel.availableModels),
            envInstances: envHub.instances,
            byokKeys: v2Keys.providers,
            antigravityEnabled: true
        )
    }

    /// The selected thread's env-server binding, when a subscription runs it.
    private var envBinding: CodeV2SessionBindings.Binding? {
        selectedSessionID.flatMap { envBindings.binding(for: $0.value) }
    }

    private func envSession(_ binding: CodeV2SessionBindings.Binding) -> CodeV2EnvSession {
        envHub.session(id: binding.envSessionId, cwd: binding.cwd, selection: binding.selection)
    }

    /// Orchestrate on the Alevr engine: roles on Alevr models and BYOK keys
    /// go through the backend proxy with their own billing and tier, roles on
    /// a subscription run as env-server turns in the thread's folder.
    private func subagentProviders(for controller: SessionController) -> CodeV2SubagentProviders {
        let instances: [CodeV2.ProviderInstance] = v2Directory.instances
        let backend = CodeV2SubagentProviders.backendFactory(from: workbenchModel.dependencies.modelClient)
        let env = CodeV2SubagentProviders.envConnector(envHub)
        return CodeV2SubagentProviders(
            instances: instances,
            backend: backend,
            env: env,
            cwd: controller.context?.access.rootURL.path,
            runtimeMode: v2Composer.runtimeMode,
            approvals: CodeV2ConnectedApprovalSink.shared
        )
    }

    private func openConnections() {
        StudioSettingsRouter.shared.requested = .connections
        openSettings()
    }

    /// Hands the selected thread to the env server: a subscription was chosen
    /// in its composer. The thread keeps its place in the sidebar; from here
    /// on the vendor's own agent runs it.
    private func handOff(_ controller: SessionController, text: String) {
        guard let cwd = controller.context?.access.rootURL.path else { return }
        let binding = CodeV2SessionBindings.Binding(
            envSessionId: "draft-" + UUID().uuidString.lowercased(),
            cwd: cwd,
            selection: v2Composer.selection
        )
        envBindings.bind(controller.sessionID.value, to: binding)
        let session = envSession(binding)
        Task {
            await session.open()
            if session.sessionId != binding.envSessionId {
                var opened = binding
                opened.envSessionId = session.sessionId
                envBindings.bind(controller.sessionID.value, to: opened)
            }
            await session.send(
                text, selection: v2Composer.selection, routing: v2Composer.routing,
                runtimeMode: v2Composer.runtimeMode, interactionMode: v2Composer.interactionMode
            )
        }
    }

    private func adoptV2Selection(from controller: SessionController) {
        guard envBindings.binding(for: controller.sessionID.value) == nil else { return }
        let configuration = controller.session.configuration
        v2Composer.selection = CodeV2EngineMapping.selection(
            modelID: configuration.modelID,
            effort: configuration.reasoningEffort,
            contextTokens: controller.contextWindowTokens
        )
        v2Composer.runtimeMode = CodeV2EngineMapping.runtimeMode(for: configuration.permissionMode)
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
        guard case .remote(let deviceID, let sessionID) = selection.wrappedValue else { return nil }
        return (deviceID, sessionID)
    }

    private var selectedRemoteSummary: CodeRemoteSessionSummary? {
        guard let selectedRemote else { return nil }
        return remoteModel.sessions.first { $0.sessionID == selectedRemote.sessionID }
    }

    /// The repository the next session belongs in: the one the reader is
    /// looking at, or the most recently opened one.
    private var targetRepository: WorkspaceRecord? {
        switch selection.wrappedValue {
        case .repository(let id):
            return workbenchModel.workspaces.first { $0.id == id }
        case .session(let id):
            guard let session = workbenchModel.sessions.first(where: { $0.id == id }) else { break }
            return workbenchModel.workspaces.first { $0.id == session.workspaceID }
        default:
            break
        }
        return workbenchModel.workspaces.first
    }

    private var title: String {
        switch selection.wrappedValue {
        case .session(let id):
            return workbenchModel.sessions.first { $0.id == id }?.title ?? "Code"
        case .task(let id):
            return codeModel.tasks.first { $0.id == id }?.title ?? "Cloud run"
        case .remote(_, let id):
            return remoteModel.sessions.first { $0.sessionID == id }?.title ?? "Remote session"
        case .pulls:
            return "Pull requests"
        default:
            return "New session"
        }
    }

    /// "project · branch", under the title.
    private var subtitle: String {
        switch selection.wrappedValue {
        case .session:
            guard let controller else { return "" }
            // The project only: the branch and worktree live in the strip
            // under the composer (code-v4 TARGET §2).
            return controller.context != nil ? controller.workspaceDisplayName : ""
        case .task:
            return selectedTask.map { [$0.whereItRuns, $0.baseRef].compactMap { $0 }.joined(separator: " · ") } ?? ""
        case .remote:
            return selectedRemoteSummary?.workspaceName ?? ""
        default:
            return ""
        }
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
                configuration: configuration,
                session: session,
                openRepository: { isChoosingRepository = true },
                newSession: { id in selection.wrappedValue = id.map { .repository($0) } ?? .draft },
                rename: beginRename,
                openSettings: openSettings
            )
            .junoSidebarColumn()
        } detail: {
            canvas
                .background(Studio.Surface.canvas)
                .desktopContentPanel()
                .navigationTitle(title)
                .navigationSubtitle(subtitle)
                .toolbar { toolbar }
        }
        .inspector(isPresented: panelPresentation) {
            Group {
                if let binding = envBinding {
                    CodeV2EnvDockView(
                        session: envSession(binding), dock: envDock, close: { envDock.isOpen = false },
                        workspace: controller.map { CodeV2DockWorkspace(controller: $0, openPreviewWindow: openPreviewWindow) }
                    )
                } else if let controller {
                    StudioSidePanel(
                        controller: controller,
                        tab: panelTab,
                        createPullRequest: { isCreatingPullRequest = true },
                        close: { panelVisible = false }
                    )
                } else {
                    Color.clear
                }
            }
            .inspectorColumnWidth(
                min: Studio.Metrics.panelMinimum,
                ideal: Studio.Metrics.panelIdeal,
                max: Studio.Metrics.panelMaximum
            )
        }
        .overlay {
            if showingPalette {
                palette.transition(.junoOverlay)
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: showingPalette)
        .focusedSceneValue(\.junoWorkspaceActions, workspaceActions)
        .focusedSceneValue(\.junoCodeActions, codeActions)
        .fileImporter(
            isPresented: $isChoosingRepository,
            allowedContentTypes: [.folder],
            allowsMultipleSelection: false,
            onCompletion: grantRepository
        )
        .fileDialogMessage(Text("Choose the folder Alevr may read and write in."))
        .fileDialogConfirmationLabel(Text("Open Project"))
        .sheet(isPresented: $isOpeningQuickly) {
            if let controller {
                OpenQuicklySheet(controller: controller) { path in
                    Task { await controller.review.open(path, using: controller) }
                }
                .junoSheetSurface(.fitted)
            }
        }
        .sheet(isPresented: $isCreatingPullRequest) {
            if let controller {
                CreatePullRequestSheet(controller: controller)
                    .junoSheetSurface(.fitted)
            }
        }
        .sheet(isPresented: Binding(
            get: { controller?.review.openDocument != nil },
            set: { if !$0 { controller?.review.closeDocument() } }
        )) {
            if let controller {
                StudioDocumentSheet(controller: controller)
                    .frame(minWidth: 720, minHeight: 520)
            }
        }
        .alert("Rename Session", isPresented: renameBinding) {
            TextField("Title", text: $renameText)
            Button("Rename") { commitRename() }
            Button("Cancel", role: .cancel) { renamingSession = nil }
        }
        .alert(
            "Voice unavailable",
            isPresented: Binding(get: { voiceUnavailable != nil }, set: { if !$0 { voiceUnavailable = nil } })
        ) {
            Button("OK", role: .cancel) { voiceUnavailable = nil }
        } message: {
            Text(voiceUnavailable ?? "Alevr could not start voice mode.")
        }
        .task { await bootstrap() }
        // The env server lists the subscriptions the model picker's rail
        // shows; started with the Code window, never by the Chat window.
        .task {
            envHub.start()
            await v2Keys.reload()
        }
        .task(id: selectedSessionID) { await resolveController() }
        .task(id: selectedTask?.id) { followSelectedTask() }
        .task(id: remoteDeviceID) { await loadRemoteSessions() }
        .task(id: selection.wrappedValue) { await followSelectedRemoteSession() }
        .onReceive(NotificationCenter.default.publisher(for: .junoCodePreviewOpenRequested)) { notification in
            guard let target = notification.object as? CodePreviewTarget,
                  let controller,
                  target.sessionID == controller.sessionID,
                  Self.samePath(target.workspaceRootPath, controller.context?.access.rootURL.path)
            else { return }
            bindPreviewAnnotations()
            if let name = target.configurationName { controller.previewLease.selectedName = name }
            if envBinding != nil {
                // Env sessions show the Preview as a tab of their dock.
                if !(envDock.isOpen && envDock.tab == .preview) { envDock.show(.preview) }
                return
            }
            guard previewTarget == nil else { return }
            withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
                simulatorHost.closePane()
                previewTarget = target
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .junoCodeSimulatorOpenRequested)) { notification in
            guard let target = notification.object as? CodePreviewTarget,
                  let controller,
                  target.sessionID == controller.sessionID,
                  Self.samePath(target.workspaceRootPath, controller.context?.access.rootURL.path),
                  !simulatorHost.isOpen
            else { return }
            openSimulator()
        }
        .onChange(of: selectedSessionID) { _, _ in
            simulatorHost.tearDown()
            // Hides the pane only: the session's preview server is leased to
            // the session and keeps running (PV-1).
            previewTarget = nil
        }
        .onChange(of: controller?.review.isPresented) { _, presented in
            // The thread's "Review" actions set the review's flag; here that
            // means the side panel, on its Changes tab.
            guard presented == true else { return }
            panelTab.wrappedValue = .changes
            panelVisible = true
            controller?.review.isPresented = false
        }
        .onChange(of: registry.pendingRequest, initial: true) { _, request in
            guard let request else { return }
            consume(request)
        }
        .onChange(of: codeModel.devices) { _, devices in
            selectDefaultRemoteDevice(from: devices)
        }
        .onChange(of: workbenchModel.sessions.count) { _, _ in
            guard case .session(let id) = selection.wrappedValue,
                  !workbenchModel.sessions.contains(where: { $0.id == id })
            else { return }
            selection.wrappedValue = nil
        }
        .onAppear {
            if storedColumnVisibility == "detailOnly" { columnVisibility = .detailOnly }
            PreviewHost.configureForApp()
        }
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

    // MARK: - Canvas

    private var canvas: some View {
        DesktopCodePreviewDock(
            target: previewTarget,
            lease: controller?.previewLease,
            close: { previewTarget = nil },
            openInWindow: {
                guard let previewTarget else { return }
                openPreviewWindow(previewTarget)
            }
        ) {
            DesktopSimulatorDock(
                model: simulatorHost.isOpen ? simulatorHost.model : nil,
                close: {
                    withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)) {
                        simulatorHost.closePane()
                    }
                }
            ) {
                detail
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        switch selection.wrappedValue {
        case .session:
            if let controller {
                session(controller)
            } else if isBootstrapping {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                JunoEmptyState(
                    title: "This session cannot be opened",
                    message: workbenchModel.lastError
                        ?? "Alevr could not reopen the folder this session works in.",
                    icon: .error,
                    actionLabel: "Open Folder…",
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
                    icon: .work
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

        case .pulls:
            NativePullsView(
                client: pullsClient,
                accountID: accountID,
                openConnections: configuration?.connectorModel == nil
                    ? nil
                    : { DesktopSettingsRouter.open(.connections) }
            )

        case .repository(let id):
            landing(workbenchModel.workspaces.first { $0.id == id })

        case .draft:
            landing(nil)

        // Retired destinations from older builds: their pages moved to Code
        // settings or back to Chat, and a restored selection lands here.
        case .allProjects, .explore, .plugins, .security, .scheduled, .design, nil:
            if isBootstrapping {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                landing(workbenchModel.workspaces.first)
            }
        }
    }

    private func landing(_ record: WorkspaceRecord?) -> some View {
        StudioLanding(
            workbench: workbenchModel,
            code: codeModel,
            project: record,
            isStarting: isStartingSession,
            initialPrompt: pendingPrompt,
            initialEnvironment: pendingEnvironment,
            // Let go once the landing has it, so it cannot reappear in a
            // later landing, and so the next hand-off of the same text is a
            // change the landing sees.
            adoptedInitialPrompt: {
                pendingPrompt = nil
                pendingEnvironment = nil
            },
            v2: CodeV2StudioContext(
                composer: v2Composer,
                directory: v2Directory,
                handoff: { _ in },
                openConnections: openConnections,
                setup: { id, action in Task { await envHub.openSetup(for: id, action: action) } }
            ),
            selectProject: { id in selection.wrappedValue = id.map { .repository($0) } ?? .draft },
            addProject: { isChoosingRepository = true },
            startLocal: start,
            openTask: { task in selection.wrappedValue = .task(task.id) }
        )
        .junoVoiceColumn(voiceColumn)
    }

    @ViewBuilder
    private func session(_ controller: SessionController) -> some View {
        if let binding = envBindings.binding(for: controller.sessionID.value) {
            CodeV2EnvSessionView(
                session: envSession(binding),
                composer: v2Composer,
                directory: v2Directory,
                dock: envDock,
                openConnections: openConnections,
                setup: { id, action in Task { await envHub.openSetup(for: id, action: action) } },
                place: CodeV2SessionPlace(
                    project: controller.workspaceDisplayName,
                    branch: controller.gitStatus?.branch ?? controller.session.gitBranch
                )
            )
        } else {
            alevrSession(controller)
        }
    }

    private func alevrSession(_ controller: SessionController) -> some View {
        StudioSessionView(
            controller: controller,
            models: workbenchModel.availableModels,
            openReview: { path in
                panelTab.wrappedValue = .changes
                panelVisible = true
                if let path { controller.review.focusedPath = path }
            },
            beginDictation: JunoSpeechService.isSupported
                ? { withAnimation(JunoMotion.fast) { isDictating = true } }
                : nil,
            v2: CodeV2StudioContext(
                composer: v2Composer,
                directory: v2Directory,
                handoff: { text in handOff(controller, text: text) },
                openConnections: openConnections,
                setup: { id, action in Task { await envHub.openSetup(for: id, action: action) } },
                subagentProviders: { subagentProviders(for: controller) }
            )
        )
        .task(id: controller.sessionID) { adoptV2Selection(from: controller) }
        .junoVoiceColumn(voiceColumn)
        .overlay(alignment: .bottom) {
            if isDictating {
                DesktopDictation(
                    onCancel: { withAnimation(JunoMotion.fast) { isDictating = false } },
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
                .transition(.junoInline)
            }
        }
        .overlay(alignment: .top) {
            // The stop while screen control runs, and the missing macOS grant
            // with its System Settings link when a start could not happen.
            StudioScreenControlBanner(controller: controller)
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        // Chat | Code, centred in the window's bar — the same item, in the
        // same place, as the Chat window declares (see `ChatToolbar`).
        ToolbarItem(placement: .principal) {
            DesktopProductSwitch(product: $product)
        }

        // Chat's rule: New session sits in the toolbar only while the sidebar,
        // and its own New session row, is hidden. Never both at once.
        ToolbarItem(placement: .navigation) {
            Button(action: newSession) {
                Label { Text("New session") } icon: { JunoSymbol(.new) }
            }
            .help("New session (⌘N)")
            .accessibilityIdentifier("juno.code.new-session")
        }
        .hidden(columnVisibility != .detailOnly)

        // Two panel toggles and More (code-v4 TARGET §2, §13): the terminal
        // and the right panel, each an icon in the web set, solid while open.
        // Changes, Files, Agents and Screen are the panel's own tabs.
        ToolbarItemGroup(placement: .primaryAction) {
            Button { togglePanel(.terminal) } label: {
                Label { Text("Terminal") } icon: { JunoSymbol(.terminal, weight: isPanelOn(.terminal) ? .fill : .regular) }
            }
            .disabled(controller?.context == nil)
            .help("Terminal (⌥⌘C)")
            .accessibilityIdentifier("juno.code.terminal.toggle")

            Button { toggleRightPanel() } label: {
                Label { Text("Panel") } icon: { JunoSymbol(.panelRight, weight: panelPresentation.wrappedValue ? .fill : .regular) }
            }
            .disabled(controller == nil)
            .help("Changes, files, agents and screen (⌥⌘R)")
            .accessibilityLabel("Panel")
            .accessibilityValue(changeTotals.map { "\($0.added) lines added, \($0.removed) removed" } ?? "No changes")
            .accessibilityIdentifier("juno.code.review.toggle")

            Button { envDock.toggle(.agents) } label: { EmptyView() }
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .disabled(envBinding == nil)
                .hidden()
                .accessibilityHidden(true)
        }

        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button("Create Pull Request…") { isCreatingPullRequest = true }
                    .disabled(controller?.pullRequestUnavailableReason != nil)
                Button("Pull Requests") { selection.wrappedValue = .pulls }
                Button("Open File…") { isOpeningQuickly = true }
                    .disabled(controller?.context == nil)
                Divider()
                Button("Preview", action: openPreview)
                    .disabled(controller?.context == nil)
                Button("Run in Simulator", action: openSimulator)
                    .disabled(targetRepository == nil)
                Button("Compact Context") {
                    Task { await controller?.compactConversation() }
                }
                // As `/compact`: between runs only, and once at a time.
                .disabled(controller == nil || controller?.isRunning == true || controller?.isCompacting == true)
                Divider()
                Button(controller?.computerUseActive == true ? "Stop Alevr Using Apps" : "Let Alevr Use Apps",
                       action: toggleComputerUse)
                    .disabled(controller?.computerUseUnavailableReason != nil)
                Button("Voice Conversation") {
                    startVoice(
                        modelID: controller?.session.configuration.modelID
                            ?? workbenchModel.availableModels.first?.modelID ?? "",
                        projectID: targetRepository?.id.value
                    )
                }
                Divider()
                Button("Rename…") { if let session = controller?.session { beginRename(session) } }
                    .disabled(controller == nil)
                Button("Reveal in Finder") {
                    guard let root = controller?.context?.access.rootURL else { return }
                    NSWorkspace.shared.activateFileViewerSelecting([root])
                }
                .disabled(controller?.context == nil)
                Button("Copy Transcript", action: copyTranscript)
                    .disabled(controller == nil)
                Divider()
                Button("Delete Session", role: .destructive) {
                    guard let id = controller?.sessionID else { return }
                    selection.wrappedValue = nil
                    Task { await workbenchModel.deleteSession(id: id) }
                }
                .disabled(controller == nil)
            } label: {
                Label { Text("More") } icon: { JunoSymbol(.more) }
            }
            .help("Pull requests, preview, computer use and session actions")
            .accessibilityIdentifier("juno.code.more")
        }
    }

    private func isPanelOn(_ tab: StudioPanelTab) -> Bool {
        if envBinding != nil {
            return envDock.isOpen && envDock.tab == (tab == .changes ? .changes : .terminal)
        }
        return panelPresentation.wrappedValue && panelTab.wrappedValue == tab
    }

    /// The session's diff, summed, or nil while nothing has changed.
    private var changeTotals: (added: Int, removed: Int)? {
        guard let changes = controller?.changes, !changes.isEmpty else { return nil }
        return changes.reduce(into: (added: 0, removed: 0)) { total, change in
            total.added += change.linesAdded
            total.removed += change.linesRemoved
        }
    }

    // MARK: - Command palette

    private var palette: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.12)
                .ignoresSafeArea()
                .onTapGesture { showingPalette = false }
                .accessibilityHidden(true)
            CodeCommandPaletteView(
                items: paletteItems,
                perform: { item in
                    showingPalette = false
                    perform(item)
                },
                dismiss: { showingPalette = false }
            )
            .padding(.top, 96)
        }
    }

    private var paletteItems: [CodePaletteItem] {
        var items: [CodePaletteItem] = [
            CodePaletteItem(id: "action.new-task", kind: .action, title: "New session", icon: .compose, shortcut: "⌘N"),
            CodePaletteItem(id: "action.open-folder", kind: .action, title: "Open project…", icon: .projects, shortcut: "⌘O"),
            CodePaletteItem(id: "action.pulls", kind: .action, title: "Pull requests", icon: .pulls),
            CodePaletteItem(id: "action.settings", kind: .action, title: "Code settings…", icon: .settings),
        ]
        if let controller {
            items += [
                CodePaletteItem(id: "action.review", kind: .action, title: "Changes", icon: .diff, shortcut: "⌥⌘R"),
                CodePaletteItem(id: "action.terminal", kind: .action, title: "Terminal", icon: .terminal, shortcut: "⌥⌘C"),
                CodePaletteItem(id: "action.preview", kind: .action, title: previewTarget == nil ? "Preview" : "Hide preview", icon: .canvas),
                CodePaletteItem(id: "action.open-file", kind: .action, title: "Open file…", icon: .fileSearch),
            ]
            if controller.pullRequestUnavailableReason == nil {
                items.append(CodePaletteItem(id: "action.pull-request", kind: .action, title: "Create pull request…", icon: .pulls))
            }
            if controller.isRunning || controller.isCompacting {
                items.append(CodePaletteItem(id: "action.stop", kind: .action, title: "Stop", icon: .stop, shortcut: "⌘."))
            }
            for mode in StudioMode.ladder {
                items.append(CodePaletteItem(id: "mode.\(mode.rawValue)", kind: .permission, title: mode.title, subtitle: mode.detail, icon: mode.icon))
            }
            for model in workbenchModel.availableModels {
                items.append(CodePaletteItem(id: "model.\(model.modelID)", kind: .model, title: model.displayName, subtitle: model.modelID, icon: .models))
            }
        }
        for record in workbenchModel.workspaces {
            items.append(
                CodePaletteItem(
                    id: "project.\(record.id.value)",
                    kind: .project,
                    title: record.descriptor.displayName,
                    subtitle: (record.descriptor.localPathHint as NSString).abbreviatingWithTildeInPath,
                    icon: .projects
                )
            )
        }
        for session in workbenchModel.visibleSessions.sorted(by: { $0.updatedAt > $1.updatedAt }) {
            items.append(
                CodePaletteItem(
                    id: "session.\(session.id.value)",
                    kind: .session,
                    title: session.title,
                    subtitle: [workbenchModel.workspaceName(for: session.workspaceID), session.gitBranch]
                        .compactMap { $0 }
                        .joined(separator: " · "),
                    icon: .conversation,
                    keywords: [session.gitBranch ?? ""]
                )
            )
        }
        return items
    }

    private func perform(_ item: CodePaletteItem) {
        let parts = item.id.split(separator: ".", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return }
        switch (parts[0], parts[1]) {
        case ("action", "new-task"): newSession()
        case ("action", "open-folder"): isChoosingRepository = true
        case ("action", "pulls"): selection.wrappedValue = .pulls
        case ("action", "settings"): openSettings()
        case ("action", "review"): togglePanel(.changes)
        case ("action", "terminal"): togglePanel(.terminal)
        case ("action", "preview"): openPreview()
        case ("action", "open-file"): isOpeningQuickly = true
        case ("action", "pull-request"): isCreatingPullRequest = true
        case ("action", "stop"): stop()
        case ("mode", let raw):
            guard let mode = StudioMode(rawValue: raw), let controller else { return }
            Task {
                await controller.setBehavior(mode.behavior)
                if mode.behavior == .code { await controller.setPermissionMode(mode.permission) }
            }
        case ("model", let id):
            guard let controller else { return }
            Task { await controller.setModelID(id) }
        case ("project", let id):
            selection.wrappedValue = .repository(WorkspaceID(value: id))
        case ("session", let id):
            selection.wrappedValue = .session(CodeSessionID(value: id))
        default:
            break
        }
    }

    // MARK: - Menu bar

    private var workspaceActions: DesktopWorkspaceActions {
        DesktopWorkspaceActions(
            newItem: newSession,
            newChat: newChat,
            openSearch: { columnVisibility = .all },
            switchProduct: { product = $0 },
            currentProduct: product
        )
    }

    private var codeActions: DesktopCodeActions {
        DesktopCodeActions(
            openPalette: { showingPalette = true },
            previousSession: { step(-1) },
            nextSession: { step(1) },
            toggleReview: { togglePanel(.changes) },
            toggleConsole: { togglePanel(.terminal) },
            toggleInspector: { panelVisible.toggle() },
            togglePreview: openPreview,
            openFile: { isOpeningQuickly = true },
            openFolder: { isChoosingRepository = true },
            createPullRequest: controller?.pullRequestUnavailableReason == nil
                ? { isCreatingPullRequest = true }
                : nil,
            stop: isStoppable ? { stop() } : nil,
            hasSession: controller != nil
        )
    }

    /// Whether the thing on screen is running and can be told to stop.
    ///
    /// For a local session that is more than the recorded status: a prompt
    /// whose hooks are still deciding has no run yet (`isRunning` covers
    /// it), and a `/compact` between runs waits on the model. The composer
    /// offers Stop in both, and Command-period, which is the only other way to
    /// reach it, has to as well.
    private var isStoppable: Bool {
        if let controller { return controller.isRunning || controller.isCompacting }
        if let selectedTask { return selectedTask.status.isActive }
        if selectedRemote != nil { return selectedRemoteSummary?.isRunning == true }
        return false
    }

    private func step(_ delta: Int) {
        let ordered = workbenchModel.visibleSessions.sorted { $0.updatedAt > $1.updatedAt }
        guard !ordered.isEmpty else { return }
        let current = ordered.firstIndex { $0.id == selectedSessionID } ?? -1
        let next = ((current + delta) % ordered.count + ordered.count) % ordered.count
        selection.wrappedValue = .session(ordered[next].id)
    }

    // MARK: - Actions

    private func togglePanel(_ tab: StudioPanelTab) {
        guard controller != nil else { return }
        if envBinding != nil {
            // A subscription thread's dock: Changes, and a shell in the
            // thread's folder run by the env server.
            envDock.toggle(tab == .changes ? .changes : .terminal)
            return
        }
        if panelVisible, panelTab.wrappedValue == tab {
            panelVisible = false
        } else {
            panelTab.wrappedValue = tab
            panelVisible = true
        }
    }

    /// The right panel as a whole: closed, it opens on its last tab.
    private func toggleRightPanel() {
        guard controller != nil else { return }
        if envBinding != nil {
            envDock.isOpen.toggle()
            return
        }
        panelVisible.toggle()
    }

    private func openSettings() {
        openWindow(id: JunoDesktopWindow.codeSettingsID)
    }

    private func newSession() {
        if let record = targetRepository {
            selection.wrappedValue = .repository(record.id)
        } else {
            selection.wrappedValue = .draft
        }
    }

    private func consume(_ request: DesktopWorkbenchRegistry.Request) {
        switch request.kind {
        case .newCodeTask(let prompt):
            pendingPrompt = prompt
            newSession()
        case .openSession(let id):
            selection.wrappedValue = .session(id)
        case .newChat:
            return
        }
        registry.consume(request)
    }

    /// Two spellings of one folder (a trailing slash, a symlink) are one.
    static func samePath(_ left: String?, _ right: String?) -> Bool {
        guard let left, let right else { return false }
        if left == right { return true }
        let resolve = { (path: String) in URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path }
        return resolve(left) == resolve(right)
    }

    private func openPreview() {
        if envBinding != nil, controller?.context != nil {
            bindPreviewAnnotations()
            envDock.toggle(.preview)
            return
        }
        guard let root = controller?.context?.access.rootURL else { return }
        if previewTarget != nil {
            previewTarget = nil
            return
        }
        simulatorHost.closePane()
        bindPreviewAnnotations()
        previewTarget = CodePreviewTarget(workspaceRoot: root, sessionID: controller?.sessionID)
    }

    /// Annotations from the Preview land in this session's composer: the
    /// crop as an image, the element and the note as text (§5.15).
    private func bindPreviewAnnotations() {
        guard let controller else { return }
        // The Preview offers the Simulator for a project that is an app.
        controller.previewLease.simulatorOpener = { openSimulator() }
        controller.previewLease.annotationSink = { [weak controller] annotation in
            guard let controller else { return }
            if let image = annotation.screenshot {
                controller.attach(CodeAttachment(name: annotation.title, image: image))
            }
            let separator = controller.composerText.isEmpty || controller.composerText.hasSuffix("\n") ? "" : "\n\n"
            controller.composerText += separator + annotation.composerText
        }
    }

    private func openPreviewWindow(_ target: CodePreviewTarget) {
        openWindow(id: CodePreviewScene.windowID, value: target)
    }

    private func openSimulator() {
        guard let repository = targetRepository else { return }
        withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
            previewTarget = nil
            simulatorHost.open(
                workspaceKey: repository.id.value,
                workspaceRoot: URL(fileURLWithPath: repository.descriptor.localPathHint)
            )
        }
    }

    private func toggleComputerUse() {
        guard let controller else { return }
        Task {
            if controller.computerUseActive {
                await controller.stopComputerUse()
            } else {
                await controller.startComputerUse()
            }
        }
    }

    private func copyTranscript() {
        guard let controller else { return }
        var lines: [String] = ["# \(controller.session.title)", ""]
        for event in controller.events {
            switch event.payload {
            case let .userPrompt(prompt):
                lines.append("**You:** \(prompt.text)")
                lines.append("")
            case let .assistantMessage(message):
                lines.append(message.text)
                lines.append("")
            default:
                continue
            }
        }
        if let url = controller.lastPullRequestURL {
            lines.append("Pull request: \(url)")
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
    }

    /// Creates and starts the local session the landing screen describes.
    private func start(_ draft: StudioDraft) {
        guard !isStartingSession else { return }
        isStartingSession = true
        pendingPrompt = nil
        pendingEnvironment = nil
        Task {
            defer { isStartingSession = false }
            guard let session = await workbenchModel.createSession(
                workspaceID: draft.workspaceID,
                configuration: draft.configuration,
                isolatedWorktree: draft.isolatedWorktree
            ) else { return }
            await workbenchModel.renameSession(id: session.id, title: draft.title)
            selection.wrappedValue = .session(session.id)
            guard let created = await workbenchModel.controller(for: session.id) else { return }
            for path in draft.fileReferences {
                created.registerComposerFileReference(path)
            }
            for attachment in draft.attachments {
                created.attach(attachment)
            }
            if draft.handsOff {
                // A subscription was chosen on the new-session screen: the
                // vendor's own agent takes the first message.
                handOff(created, text: draft.prompt)
                return
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

    private func grantRepository(_ result: Result<[URL], any Error>) {
        guard case .success(let urls) = result, let url = urls.first else { return }
        Task {
            guard let record = await workbenchModel.addWorkspace(grantedURL: url) else { return }
            selection.wrappedValue = .repository(record.id)
        }
    }

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
        Binding(get: { renamingSession != nil }, set: { if !$0 { renamingSession = nil } })
    }

    private func commitRename() {
        guard let session = renamingSession else { return }
        let title = renameText
        renamingSession = nil
        Task { await workbenchModel.renameSession(id: session.id, title: title) }
    }

    // MARK: - Voice

    private var voiceColumn: DesktopVoiceColumn? {
        guard let voiceSession, let configuration, let session else { return nil }
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

    private func startVoice(modelID: String, projectID: String?) {
        guard voiceSession == nil else { return }
        guard let configuration, let session, let sender = configuration.requestSender else {
            voiceUnavailable = "Alevr is not signed in, so it cannot start a voice conversation."
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
        let provider = JunoVoiceProvider.productionDefault
        let started = DesktopVoiceSession(
            controller: JunoRealtimeVoiceController(
                authorization: JunoDesktopVoiceAuthorization(sender: sender, accountID: session.profile.id),
                provider: provider
            ),
            modelID: modelID,
            conversationID: nil,
            projectID: projectID
        )
        voiceSession = started
        Task { await started.controller.start(provider: provider) }
    }

    // MARK: - Lifecycle

    private func bootstrap() async {
        await workbenchModel.bootstrap()
        isBootstrapping = false
        selectDefaultRemoteDevice(from: codeModel.devices)
        #if DEBUG
        if previewSessionID != nil {
            await resolveController()
            return
        }
        #endif
        let validated = DesktopCodeNavigationState.validate(
            selection.wrappedValue,
            sessions: workbenchModel.visibleSessions.map(\.id),
            tasks: codeModel.tasks.map(\.id),
            repositories: workbenchModel.workspaces.map(\.id)
        )
        storedSelection = DesktopCodeNavigationState.encode(validated)
    }

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

    private func followSelectedRemoteSession() async {
        guard let selectedRemote else { return }
        remoteModel.openSession(selectedRemote.sessionID)
        await remoteModel.watchEvents(deviceID: selectedRemote.deviceID, sessionID: selectedRemote.sessionID)
    }

    private func selectDefaultRemoteDevice(from devices: [NativeCodeDevice]) {
        guard remoteDeviceID.isEmpty || !devices.contains(where: { $0.id == remoteDeviceID }) else { return }
        remoteDeviceID = devices.first(where: \.online)?.id ?? devices.first?.id ?? ""
    }
}

/// The title bar's quiet run status: "Working 1m 12s" while a run is live,
/// "Needs you" while it waits. Nothing at rest.
/// A labelled toolbar toggle: the mark (solid while its panel is open), the
/// word, and for Changes the session's diff in tabular digits. A toolbar of
/// bare glyphs read as four riddles; each item now says what it opens.
private struct DesktopCodeToolbarLabel: View {
    let title: String
    let icon: JunoIcon
    let isOn: Bool
    var stat: (added: Int, removed: Int)? = nil

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            JunoSymbol(icon, weight: isOn ? .fill : .regular)
            Text(title)
                .junoFont(size: 13, relativeTo: .callout, weight: .medium)
            if let stat {
                StudioDiffStat(added: stat.added, removed: stat.removed)
                    .contentTransition(.numericText())
            }
        }
        .padding(.horizontal, JunoSpace.hairline)
        .fixedSize()
        .contentShape(.rect)
    }
}

private struct DesktopCodeRunClock: View {
    let controller: SessionController

    private var status: StudioStatus {
        StudioStatus(controller.session.status, hasPendingApproval: !controller.pendingApprovals.isEmpty)
    }

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            if status != .idle {
                StudioStatusGlyph(status: status, size: 7)
                if status == .working, let started = controller.runStartedAt {
                    TimelineView(.periodic(from: started, by: 1)) { context in
                        Text(StudioFormat.duration(context.date.timeIntervalSince(started)))
                            .font(Studio.Font.metaDigits)
                            .foregroundStyle(Studio.Ink.tertiary)
                    }
                } else {
                    Text(status.label)
                        .font(Studio.Font.meta)
                        .foregroundStyle(status == .failed ? Studio.Ink.danger : Studio.Ink.tertiary)
                }
            }
        }
        .frame(minWidth: 1)
        .animation(JunoMotion.fast, value: status)
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
    let icon: JunoIcon
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
                icon: .user,
                tint: .secondary,
                usesMonoDetail: false
            )
        case "text", "assistant", "assistant_text", "response":
            return Self(
                title: value(["text", "message"]) ?? "Alevr replied",
                detail: nil,
                icon: .conversation,
                tint: .junoAccent,
                usesMonoDetail: false
            )
        case "tool", "tool_call", "tool_started":
            return Self(
                title: value(["summary", "name", "toolName"]) ?? "Running a tool",
                detail: value(["command", "detail"]),
                icon: .terminal,
                tint: .secondary,
                usesMonoDetail: true
            )
        case "tool_output", "terminal", "command_output":
            return Self(
                title: value(["summary", "name"]) ?? "Command output",
                detail: value(["text", "output", "detail"]),
                icon: .code,
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
                icon: .file,
                tint: .junoAccent,
                usesMonoDetail: true
            )
        case "approval_request":
            return Self(
                title: "Approval required",
                detail: value(["summary", "text", "detail"]),
                icon: .permission,
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
                icon: approved ? .check : .close,
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
                icon: .user,
                tint: .junoAccent,
                usesMonoDetail: false
            )
        case "status", "status_changed":
            return Self(
                title: value(["status", "title", "text"]) ?? "Session status changed",
                detail: value(["detail", "summary"]),
                icon: .refresh,
                tint: .secondary,
                usesMonoDetail: false
            )
        case "error", "failed":
            return Self(
                title: value(["message", "error", "text"]) ?? "Remote session error",
                detail: value(["detail", "summary"]),
                icon: .error,
                tint: .junoDanger,
                usesMonoDetail: false
            )
        case "done", "completed", "session_completed":
            return Self(
                title: "Session finished",
                detail: value(["summary", "detail"]),
                icon: .check,
                tint: .junoSuccess,
                usesMonoDetail: false
            )
        default:
            let fallback = value(["text", "detail", "summary", "title", "message"])
                ?? encodedPayload(payload)
            return Self(
                title: humanize(event.kind),
                detail: fallback,
                icon: .ellipsis,
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let measure: CGFloat = JunoReadingMeasure.reading

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
                    icon: .device
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
                    // Resolving an approval is one of the two moments the
                    // product rewards (the other is a run finishing): the
                    // card leaves with the one bouncy curve in the ladder.
                    .transition(.scale(scale: 0.96).combined(with: .opacity))
                }
                composer
            }
            .animation(JunoMotion.reduced(JunoMotion.reward, when: reduceMotion), value: pendingApproval?.id)
            .frame(maxWidth: Self.measure, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, JunoSpace.region)
            .padding(.bottom, JunoSpace.regular)
        }
    }

    private func sessionHeader(_ summary: CodeRemoteSessionSummary) -> some View {
        let status = CodeRunStatus(summary)
        return HStack(alignment: .top, spacing: JunoSpace.snug) {
            JunoIconView(.device, size: 15)
                // Scaled against the callout title it marks, so the pair grows
                // together under Dynamic Type instead of the glyph staying a
                // fixed 15pt beside enlarged text.
                .foregroundStyle(Color.junoAccent)
                .frame(width: 28, height: 28)
                .background(Color.junoAccent.opacity(0.12), in: Circle())

            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                HStack(spacing: JunoSpace.snug) {
                    Text(summary.title)
                        .junoRowLabel()
                        .lineLimit(1)
                    Spacer(minLength: JunoSpace.hairline)
                    HStack(spacing: JunoSpace.hairline) {
                        if let icon = status.junoIcon {
                            JunoIconView(icon, size: 11)
                        } else {
                            JunoIconView(.refresh, size: 11)
                        }
                        Text(status.label)
                    }
                    .junoCaption()
                    .foregroundStyle(status.tint)
                    .padding(.horizontal, JunoSpace.snug)
                    .padding(.vertical, JunoSpace.hairline)
                    .background(Capsule(style: .continuous).fill(status.tint.opacity(0.13)))
                    .contentTransition(.numericText())
                    // The run finishing is the second rewarded moment.
                    .animation(JunoMotion.reduced(JunoMotion.reward, when: reduceMotion), value: status.label)
                }

                HStack(spacing: JunoSpace.snug) {
                    Text(summary.workspaceName ?? "Remote workspace")
                        .junoCaption()
                        .lineLimit(1)
                    if let branch = summary.activeBranch, !branch.isEmpty {
                        HStack(spacing: JunoSpace.hairline) {
                            JunoIconView(.branch, size: 11)
                            Text(branch)
                        }
                        .junoCaption()
                        .lineLimit(1)
                    }
                    if summary.pendingChangeCount > 0 {
                        HStack(spacing: JunoSpace.hairline) {
                            JunoIconView(.file, size: 11)
                            Text("\(summary.pendingChangeCount) change\(summary.pendingChangeCount == 1 ? "" : "s")")
                        }
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
                        JunoIconView(.stop, size: 14)
                            .frame(width: 22, height: 22)
                    }
                    .buttonStyle(.junoGlass)
                    .tint(Color.junoDanger)
                    .disabled(remote.isSendingCommand)
                    // ⌘. is Session › Stop, which stops this session too.
                    .accessibilityLabel("Stop this session")
                }
                Button(action: send) {
                    JunoIconView(.send, size: 14)
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
        if summary.isRunning { return "Alevr is working. Your message is queued." }
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
                        ?? "Alevr is asking to run a tool on that computer.",
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
            JunoIconView(presentation.icon, size: 13)
                // Scaled against the callout row title it marks, for the same
                // reason as the session header's laptop glyph above.
                .foregroundStyle(presentation.tint)
                .frame(width: 24, height: 24)
                .background(presentation.tint.opacity(0.12), in: Circle())

            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
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
            JunoIconView(.error, size: 14)
                .foregroundStyle(Color.junoDanger)
            Text(message)
                .junoCaption()
                .foregroundStyle(Color.junoDanger)
                .textSelection(.enabled)
            Spacer(minLength: JunoSpace.snug)
            Button("Retry") {
                Task { await remote.pollEvents(deviceID: deviceID, sessionID: sessionID) }
            }
            .buttonStyle(.junoGlass)
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
                    .buttonStyle(.junoProminent)
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
