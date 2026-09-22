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
    @State private var plan: DesktopUsagePlan?
    @State private var planReadAt: Date?
    @State private var registry = DesktopWorkbenchRegistry.shared
    @Environment(\.openWindow) private var openWindow
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let planReadFloor: TimeInterval = 60

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
            get: { panelVisible && controller != nil && selectedSessionID != nil },
            set: { panelVisible = $0 }
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
            var parts: [String] = []
            if controller.context != nil { parts.append(controller.workspaceDisplayName) }
            if let branch = controller.gitStatus?.branch ?? controller.session.gitBranch { parts.append(branch) }
            if controller.session.executionRootPath != nil { parts.append("worktree") }
            return parts.joined(separator: " · ")
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
                session: session,
                avatarModel: configuration?.avatarModel,
                syncModel: configuration?.syncModel,
                plan: plan,
                openRepository: { isChoosingRepository = true },
                newSession: { id in selection.wrappedValue = id.map { .repository($0) } ?? .draft },
                rename: beginRename,
                openSettings: openSettings
            )
            .junoSidebarColumn()
        } detail: {
            canvas
                .background(Studio.Surface.canvas)
                .navigationTitle(title)
                .navigationSubtitle(subtitle)
                .toolbar { toolbar }
        }
        .inspector(isPresented: panelPresentation) {
            Group {
                if let controller {
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
        .fileDialogMessage(Text("Choose the folder Juno may read and write in."))
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
            Text(voiceUnavailable ?? "Juno could not start voice mode.")
        }
        .task { await bootstrap() }
        .task(id: liveRunCount) { await readPlan() }
        .task(id: selectedSessionID) { await resolveController() }
        .task(id: selectedTask?.id) { followSelectedTask() }
        .task(id: remoteDeviceID) { await loadRemoteSessions() }
        .task(id: selection.wrappedValue) { await followSelectedRemoteSession() }
        .onChange(of: workbenchModel.sessions.map(\.monitorKey), initial: true) { _, _ in
            StudioRunMonitor.shared.observe(workbenchModel.sessions)
        }
        .onReceive(NotificationCenter.default.publisher(for: StudioRunMonitor.openSessionNotification)) { note in
            guard let id = note.object as? CodeSessionID else { return }
            selection.wrappedValue = .session(id)
        }
        .onReceive(NotificationCenter.default.publisher(for: .junoCodePreviewOpenRequested)) { notification in
            guard let target = notification.object as? CodePreviewTarget,
                  target.sessionID == controller?.sessionID,
                  target.workspaceRootPath == controller?.context?.access.rootURL.path,
                  previewTarget == nil
            else { return }
            withAnimation(JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)) {
                simulatorHost.closePane()
                previewTarget = target
            }
        }
        .onChange(of: selectedSessionID) { _, _ in
            simulatorHost.tearDown()
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
            StudioRunMonitor.shared.install()
            if storedColumnVisibility == "detailOnly" { columnVisibility = .detailOnly }
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
                        ?? "Juno could not reopen the folder this session works in.",
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
            selectProject: { id in selection.wrappedValue = id.map { .repository($0) } ?? .draft },
            addProject: { isChoosingRepository = true },
            startLocal: start,
            openTask: { task in selection.wrappedValue = .task(task.id) }
        )
        .junoVoiceColumn(voiceColumn)
    }

    private func session(_ controller: SessionController) -> some View {
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
                : nil
        )
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
            if controller.computerUseActive {
                HStack(spacing: JunoSpace.snug) {
                    Circle().fill(Studio.Ink.danger).frame(width: 7, height: 7)
                    Text("Juno is controlling the screen")
                        .font(Studio.Font.label)
                    Button("Stop") { Task { await controller.stopComputerUse() } }
                        .buttonStyle(StudioSecondaryButtonStyle())
                        .accessibilityIdentifier("juno.code.computer-use.stop")
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .background(Capsule().fill(Studio.Surface.raised))
                .overlay(Capsule().strokeBorder(Studio.Surface.hairline))
                .padding(.top, JunoSpace.snug)
                .transition(.junoOverlay)
            }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            if let controller {
                DesktopCodeRunClock(controller: controller)
            } else {
                Color.clear.frame(width: 1, height: 1)
            }
        }

        ToolbarItemGroup(placement: .primaryAction) {
            Button(action: newSession) {
                Label("New session", systemImage: "square.and.pencil")
            }
            .help("New session (⌘N)")
            .accessibilityIdentifier("juno.code.new-session")

            Button { togglePanel(.changes) } label: {
                Label("Changes", systemImage: "plusminus")
            }
            .disabled(controller == nil)
            .help("Changes (⌥⌘R)")
            .accessibilityIdentifier("juno.code.review.toggle")

            Button { togglePanel(.terminal) } label: {
                Label("Terminal", systemImage: "terminal")
            }
            .disabled(controller?.context == nil)
            .help("Terminal (⌥⌘T)")
            .accessibilityIdentifier("juno.code.terminal.toggle")

            Menu {
                Button("Preview", action: openPreview)
                    .disabled(controller?.context == nil)
                Button("Run in Simulator", action: openSimulator)
                    .disabled(targetRepository == nil)
                Button("Open File…") { isOpeningQuickly = true }
                    .disabled(controller?.context == nil)
                Divider()
                Button("Create Pull Request…") { isCreatingPullRequest = true }
                    .disabled(controller?.pullRequestUnavailableReason != nil)
                Button("Compact Context") {
                    Task { await controller?.compactConversation() }
                }
                .disabled(controller == nil)
                Divider()
                Button(controller?.computerUseActive == true ? "Stop Screen Control" : "Start Screen Control",
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
                Label("More", systemImage: "ellipsis")
            }
            .accessibilityIdentifier("juno.code.more")
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
                CodePaletteItem(id: "action.terminal", kind: .action, title: "Terminal", icon: .terminal, shortcut: "⌥⌘T"),
                CodePaletteItem(id: "action.preview", kind: .action, title: previewTarget == nil ? "Preview" : "Hide preview", icon: .canvas),
                CodePaletteItem(id: "action.open-file", kind: .action, title: "Open file…", icon: .fileSearch),
            ]
            if controller.pullRequestUnavailableReason == nil {
                items.append(CodePaletteItem(id: "action.pull-request", kind: .action, title: "Create pull request…", icon: .pulls))
            }
            if controller.session.status.isActive {
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
    private var isStoppable: Bool {
        if let controller { return controller.session.status.isActive }
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
        if panelVisible, panelTab.wrappedValue == tab {
            panelVisible = false
        } else {
            panelTab.wrappedValue = tab
            panelVisible = true
        }
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

    private func openPreview() {
        guard let root = controller?.context?.access.rootURL else { return }
        if previewTarget != nil {
            previewTarget = nil
            return
        }
        simulatorHost.closePane()
        previewTarget = CodePreviewTarget(workspaceRoot: root, sessionID: controller?.sessionID)
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
                if !controller.session.configuration.computerUseEnabled {
                    await controller.setComputerUseEnabled(true)
                }
                await controller.activateComputerUse()
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

    private var liveRunCount: Int {
        workbenchModel.sessions.filter(\.status.isActive).count
            + codeModel.tasks.filter(\.status.isActive).count
    }

    private func readPlan() async {
        guard let sender = configuration?.requestSender, let session else { return }
        if plan != nil, let planReadAt, Date().timeIntervalSince(planReadAt) < Self.planReadFloor {
            return
        }
        let snapshot = await NativeUsageClient(sender: sender).load(range: .month, for: session.profile.id)
        guard let loaded = snapshot.plan else { return }
        planReadAt = Date()
        withAnimation(JunoMotion.standard) { plan = loaded }
    }

    private func selectDefaultRemoteDevice(from devices: [NativeCodeDevice]) {
        guard remoteDeviceID.isEmpty || !devices.contains(where: { $0.id == remoteDeviceID }) else { return }
        remoteDeviceID = devices.first(where: \.online)?.id ?? devices.first?.id ?? ""
    }
}

/// The title bar's quiet run status: "Working 1m 12s" while a run is live,
/// "Needs you" while it waits. Nothing at rest.
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

private extension CodeSession {
    /// What the run monitor needs to notice a change.
    var monitorKey: String { "\(id.value):\(status.rawValue):\(hasPendingApproval)" }
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
                title: value(["text", "message"]) ?? "Juno replied",
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

            VStack(alignment: .leading, spacing: 3) {
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
                    .padding(.vertical, 3)
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
                    .buttonStyle(.bordered)
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
            JunoIconView(presentation.icon, size: 13)
                // Scaled against the callout row title it marks, for the same
                // reason as the session header's laptop glyph above.
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
