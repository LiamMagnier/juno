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

/// The Code window: one navigation split view, a thread, and one optional
/// trailing context rail.
///
/// Two stability constraints are honoured deliberately:
///
/// 1. Every `ToolbarItem` is always present and uses `.disabled()`. A toolbar item
///    that appears and disappears makes SwiftUI rebuild the AppKit toolbar under a
///    live window.
/// 2. Column visibility is restored by hand, because
///    `NavigationSplitViewVisibility` is not `RawRepresentable` and cannot be put
///    in `@SceneStorage` directly.
///
/// **Review is the session's, not the window's.** This shell used to keep a
/// `@SceneStorage` flag for the review and mirror it against
/// `ReviewModel.isPresented` in both directions; the two disagreed, and the audit
/// found it. There is one flag now, on the review the whole session shares, and
/// the toolbar toggle, ⌥⌘R, the Changes list, the completion card and Open
/// Quickly all write it. The review opens *beside* the thread as a resizable
/// pane — see ``CodeSessionCanvas`` — never in place of it.
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
    @SceneStorage("juno.desktop.code.inspector.v4") private var inspectorVisible = true
    @SceneStorage("juno.desktop.code.console") private var consoleVisible = false
    @SceneStorage("juno.desktop.code.remote-device") private var remoteDeviceID = ""
    @SceneStorage("juno.desktop.code.filter") private var storedFilter =
        DesktopCodeSessionFilter.all.rawValue

    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var controller: SessionController?
    @State private var inspectorReady = false
    @State private var isBootstrapping = true
    @State private var isStartingSession = false
    @State private var isChoosingRepository = false
    @State private var renamingSession: CodeSession?
    @State private var renameText = ""
    @State private var isOpeningQuickly = false
    @State private var showingPalette = false
    @State private var isCreatingPullRequest = false
    /// A prompt handed in from the quick-entry panel or the menu bar item,
    /// consumed by the next New task screen.
    @State private var pendingPrompt: String?
    @State private var simulatorHost = DesktopSimulatorHost()
    @State private var isDictating = false
    @State private var previewTarget: CodePreviewTarget?
    @State private var voiceSession: DesktopVoiceSession?
    @State private var voiceUnavailable: String?
    @State private var plan: DesktopUsagePlan?
    @State private var planReadAt: Date?
    @State private var registry = DesktopWorkbenchRegistry.shared
    @FocusState private var sidebarSearchFocused: Bool
    @Environment(\.openWindow) private var openWindow
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let planReadFloor: TimeInterval = 60

    private var sessionSearchText: Binding<String> {
        Binding(
            get: { workbenchModel.sessionSearchText },
            set: { workbenchModel.sessionSearchText = $0 }
        )
    }

    private var filter: Binding<DesktopCodeSessionFilter> {
        Binding(
            get: { DesktopCodeSessionFilter(rawValue: storedFilter) ?? .all },
            set: { storedFilter = $0.rawValue }
        )
    }

    // MARK: - Selection

    private var selection: Binding<DesktopCodeSidebarItem?> {
        Binding(
            get: {
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
                guard case .session = selection.wrappedValue else {
                    return false
                }
                return inspectorVisible && inspectorReady && controller != nil
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

    private var detailTitle: String {
        switch selection.wrappedValue {
        case .session(let id):
            return workbenchModel.sessions.first { $0.id == id }?.title ?? "Code"
        case .repository, .draft, .none:
            return "New task"
        case .task(let id):
            return codeModel.tasks.first { $0.id == id }?.title ?? "Cloud task"
        case .remote(_, let id):
            return remoteModel.sessions.first { $0.sessionID == id }?.title ?? "Remote session"
        case .allProjects: return "Projects"
        case .pulls: return "Pull requests"
        case .design: return "Design"
        }
    }

    /// The repository the next session belongs in: the one the reader is looking
    /// at, or failing that the most recently opened one.
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

    /// Whether the review pane is open on the selected session.
    private var reviewPresented: Bool {
        controller?.review.isPresented ?? false
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
                filter: filter,
                isBootstrapping: isBootstrapping,
                session: session,
                avatarModel: configuration?.avatarModel,
                syncModel: configuration?.syncModel,
                plan: plan,
                openRepository: { isChoosingRepository = true },
                newSession: { selection.wrappedValue = .repository($0) },
                rename: beginRename,
                searchText: sessionSearchText,
                openPalette: { showingPalette = true }
            )
            .junoSidebarColumn()
        } detail: {
            editorCanvas
                .junoReadingCanvas()
                .navigationTitle(detailTitle)
                .toolbar { detailToolbar }
        }
        .inspector(isPresented: inspectorPresentation) {
            if inspectorPresentation.wrappedValue {
                inspector
                    .frame(width: JunoInspectorMetrics.ideal)
                    .background(Color.junoCanvas)
            }
        }
        .overlay {
            if showingPalette {
                palette
                    .transition(.junoOverlay)
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
        .fileDialogMessage(
            Text(
                "Choose the folder Juno Code may read and write in — or make a new one."
            )
        )
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
        .alert("Rename Session", isPresented: renameBinding) {
            TextField("Title", text: $renameText)
            Button("Rename") { commitRename() }
            Button("Cancel", role: .cancel) { renamingSession = nil }
        }
        .task { await bootstrap() }
        .task(id: liveRunCount) { await readPlan() }
        .task(id: selectedSessionID) {
            inspectorReady = false
            await resolveController()
            guard controller != nil else { return }
            await Task.yield()
            inspectorReady = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .junoCodePreviewOpenRequested)) { notification in
            guard let target = notification.object as? CodePreviewTarget,
                  target.sessionID == controller?.sessionID,
                  target.workspaceRootPath == controller?.context?.access.rootURL.path,
                  previewTarget == nil
            else { return }
            withAnimation(
                JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)
            ) {
                simulatorHost.closePane()
                previewTarget = target
            }
        }
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
        // Requests from outside the window: the menu bar item, the quick-entry
        // panel. Consumed exactly once, on the next frame after they land.
        .onChange(of: registry.pendingRequest, initial: true) { _, request in
            guard let request else { return }
            consume(request)
        }
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
            threadHeader

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
                        withAnimation(
                            JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)
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

    /// The compact strip above the thread: title, project · branch, status,
    /// elapsed, context, stop. One line for every transport.
    @ViewBuilder
    private var threadHeader: some View {
        switch selection.wrappedValue {
        case .session:
            if let controller {
                CodeThreadHeader(controller: controller, stop: stop)
            }
        case .task:
            if let task = selectedTask {
                CodeThreadHeader(
                    CodeThreadHeader.Context(
                        title: task.title,
                        project: task.whereItRuns,
                        branch: task.baseRef,
                        environment: task.target == .cloud ? "Cloud" : "Device",
                        status: CodeRunStatus(task.status)
                    ),
                    stop: stop
                )
            }
        case .remote:
            if let summary = selectedRemoteSummary {
                CodeThreadHeader(
                    CodeThreadHeader.Context(
                        title: summary.title,
                        project: summary.workspaceName ?? "Connected computer",
                        branch: summary.activeBranch,
                        environment: "Remote",
                        status: CodeRunStatus(summary)
                    ),
                    stop: stop
                )
            }
        default:
            EmptyView()
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
            NativePullsView(
                client: pullsClient,
                accountID: accountID,
                openConnections: openConnections
            )

        case .design:
            designPage

        case .repository(let id):
            draft(workbenchModel.workspaces.first { $0.id == id })

        case nil:
            if isBootstrapping {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                draft(workbenchModel.workspaces.first)
            }
        }
    }

    /// Connections lives in the Settings window now; the pull request list's
    /// "connect GitHub" button opens it there.
    private var openConnections: (() -> Void)? {
        guard configuration?.connectorModel != nil else { return nil }
        return { DesktopSettingsRouter.open(.connections) }
    }

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
            JunoEmptyState(title: "Design", message: "The synchronized artifact store is unavailable.", icon: .error)
        }
    }

    private func draft(_ record: WorkspaceRecord?) -> some View {
        DesktopCodeNewTaskScreen(
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
                consoleVisible = false
                selection.wrappedValue = id.map { .repository($0) } ?? .draft
            },
            beginVoice: { modelID in
                startVoice(modelID: modelID, projectID: record?.id.value)
            },
            voiceDock: voiceColumn.map { AnyView(DesktopVoiceDock(column: $0)) },
            initialPrompt: pendingPrompt
        )
        .junoVoiceField(voiceColumn)
    }

    // MARK: - The session surface

    private func localSession(_ controller: SessionController) -> some View {
        CodeSessionCanvas(
            controller: controller,
            model: workbenchModel,
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
        .overlay(alignment: .topTrailing) {
            if controller.computerUseActive {
                JunoDesktopGlass(spacing: JunoSpace.snug) {
                    computerUseIndicator(controller)
                }
                .padding(JunoSpace.regular)
            }
        }
    }

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
        Task { await started.controller.start(provider: initialProvider) }
    }

    @ViewBuilder
    private var inspector: some View {
        Group {
            if let controller {
                CodeSessionInspector(
                    controller: controller,
                    openPreview: openPreview,
                    openSources: { isOpeningQuickly = true },
                    openWorkspace: {
                        guard let root = controller.context?.access.rootURL else { return }
                        NSWorkspace.shared.activateFileViewerSelecting([root])
                    },
                    createPullRequest: { isCreatingPullRequest = true }
                )
            } else {
                JunoEmptyState(
                    title: "Nothing to inspect",
                    message: """
                        Select a session on this Mac to see its changes, activity \
                        and repository.
                        """,
                    icon: .code
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Command palette

    private var palette: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.18)
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

    /// Everything ⌘K can reach, assembled from what the window knows.
    private var paletteItems: [CodePaletteItem] {
        var items: [CodePaletteItem] = []
        items.append(CodePaletteItem(id: "action.new-task", kind: .action, title: "New task", icon: .new, shortcut: "⌘N"))
        items.append(CodePaletteItem(id: "action.open-folder", kind: .action, title: "Open folder…", icon: .projects, shortcut: "⌘O"))
        items.append(CodePaletteItem(id: "action.pulls", kind: .action, title: "Pull requests", icon: .pulls))
        items.append(CodePaletteItem(id: "action.projects", kind: .action, title: "All projects", icon: .projects))
        items.append(CodePaletteItem(id: "action.settings", kind: .action, title: "Code settings…", icon: .settings, shortcut: "⌘,"))
        if controller != nil {
            items.append(CodePaletteItem(id: "action.review", kind: .action, title: reviewPresented ? "Close review" : "Review changes", icon: .branch, shortcut: "⌥⌘R"))
            items.append(CodePaletteItem(id: "action.console", kind: .action, title: consoleVisible ? "Hide console" : "Show console", icon: .terminal, shortcut: "⌥⌘C"))
            items.append(CodePaletteItem(id: "action.inspector", kind: .action, title: inspectorVisible ? "Hide context rail" : "Show context rail", icon: .sliders, shortcut: "⌥⌘I"))
            items.append(CodePaletteItem(id: "action.preview", kind: .action, title: previewTarget == nil ? "Open preview" : "Hide preview", icon: .canvas, shortcut: "⌥⌘P"))
            items.append(CodePaletteItem(id: "action.open-file", kind: .action, title: "Open file…", icon: .search, shortcut: "⇧⌘O"))
            if controller?.pullRequestUnavailableReason == nil {
                items.append(CodePaletteItem(id: "action.pull-request", kind: .action, title: "Create pull request…", icon: .pulls))
            }
            if controller?.session.status.isActive == true {
                items.append(CodePaletteItem(id: "action.stop", kind: .action, title: "Stop the run", icon: .stop, shortcut: "⌘."))
            }
            for mode in PermissionMode.allCases {
                items.append(
                    CodePaletteItem(
                        id: "permission.\(mode.rawValue)",
                        kind: .permission,
                        title: PermissionModeLabel.text(for: mode),
                        subtitle: PermissionModeLabel.explanation(for: mode),
                        icon: PermissionModeLabel.junoIcon(for: mode)
                    )
                )
            }
            for model in workbenchModel.availableModels {
                items.append(
                    CodePaletteItem(
                        id: "model.\(model.modelID)",
                        kind: .model,
                        title: model.displayName,
                        subtitle: model.modelID,
                        icon: .models
                    )
                )
            }
            for command in CodeSlashCommandLibrary.builtIn.commands {
                items.append(
                    CodePaletteItem(
                        id: "slash.\(command.name)",
                        kind: .slashCommand,
                        title: "/\(command.name)",
                        subtitle: command.summary,
                        icon: .terminal
                    )
                )
            }
        }
        for record in workbenchModel.workspaces {
            items.append(
                CodePaletteItem(
                    id: "project.\(record.id.value)",
                    kind: .project,
                    title: record.descriptor.displayName,
                    subtitle: (record.descriptor.localPathHint as NSString).abbreviatingWithTildeInPath,
                    icon: record.descriptor.isGitRepository ? .branch : .projects
                )
            )
        }
        for session in workbenchModel.visibleSessions.sorted(by: { $0.updatedAt > $1.updatedAt }) {
            items.append(
                CodePaletteItem(
                    id: "session.\(session.id.value)",
                    kind: .session,
                    title: session.title,
                    subtitle: [
                        workbenchModel.workspaceName(for: session.workspaceID),
                        session.gitBranch,
                        CodeRunStatus(session.status, hasPendingApproval: session.hasPendingApproval).label,
                    ].compactMap { $0 }.joined(separator: " · "),
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
        case ("action", "projects"): selection.wrappedValue = .allProjects
        case ("action", "settings"): DesktopSettingsRouter.open(.code)
        case ("action", "review"): toggleReview()
        case ("action", "console"): toggleConsole()
        case ("action", "inspector"): inspectorPresentation.wrappedValue.toggle()
        case ("action", "preview"): openPreview()
        case ("action", "open-file"): isOpeningQuickly = true
        case ("action", "pull-request"): isCreatingPullRequest = true
        case ("action", "stop"): stop()
        case ("permission", let raw):
            guard let mode = PermissionMode(rawValue: raw), let controller else { return }
            Task { await controller.setPermissionMode(mode) }
        case ("model", let id):
            guard let controller else { return }
            Task { await controller.setModelID(id) }
        case ("slash", let name):
            guard let controller,
                  let command = CodeSlashCommandLibrary.builtIn.command(named: name)
            else { return }
            if let action = command.action {
                switch action {
                case .compact: Task { await controller.compactConversation() }
                case .review: controller.review.present()
                }
            } else {
                controller.composerText = command.expanded(argument: "")
                if let behavior = command.behavior {
                    Task { await controller.setBehavior(behavior) }
                }
            }
        case ("project", let id):
            selection.wrappedValue = .repository(WorkspaceID(value: id))
        case ("session", let id):
            selection.wrappedValue = .session(CodeSessionID(value: id))
        default:
            break
        }
    }

    // MARK: - Floating status controls

    @ViewBuilder
    private func computerUseIndicator(_ controller: SessionController) -> some View {
        if controller.computerUseActive {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.permission, size: 15)
                    .foregroundStyle(Color.junoDanger)
                Text("Screen control active").junoRowLabel()
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

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button(action: newSession) {
                JunoIconLabel(verbatim: "New task", icon: .new, size: 15)
            }
            .help("Start a new task (⌘N)")
            .accessibilityIdentifier("juno.code.new-session")
        }

        ToolbarSpacer(.fixed, placement: .primaryAction)

        ToolbarItem(placement: .primaryAction) {
            Button(action: toggleReview) {
                JunoIconLabel(
                    verbatim: "Review",
                    icon: .branch,
                    size: 15
                )
            }
            .disabled(controller == nil)
            .help(reviewPresented ? "Close the review pane (⌥⌘R)" : "Review the changes beside the thread (⌥⌘R)")
            .accessibilityIdentifier("juno.code.review.toggle")
            .accessibilityValue(reviewPresented ? "Open" : "Closed")
        }

        ToolbarSpacer(.fixed, placement: .primaryAction)

        ToolbarItem(placement: .primaryAction) {
            Button {
                showingPalette = true
            } label: {
                JunoIconLabel(verbatim: "Commands", icon: .search, size: 15)
            }
            .help("Command palette (⌘K)")
            .accessibilityIdentifier("juno.code.palette")
        }

        ToolbarSpacer(.fixed, placement: .primaryAction)

        ToolbarItem(placement: .primaryAction) {
            Menu {
                Section("Session") {
                    Button(action: openPreview) {
                        JunoIconLabel(
                            verbatim: previewTarget == nil ? "Preview" : "Hide preview",
                            icon: .canvas,
                            size: 14
                        )
                    }
                    .disabled(controller == nil)

                    Button {
                        inspectorPresentation.wrappedValue.toggle()
                    } label: {
                        JunoIconLabel(
                            verbatim: inspectorPresentation.wrappedValue ? "Hide context rail" : "Show context rail",
                            icon: .sliders,
                            size: 14
                        )
                    }
                    .disabled(controller == nil)

                    Button(action: toggleConsole) {
                        JunoIconLabel(
                            verbatim: consoleVisible ? "Hide console" : "Show console",
                            icon: .terminal,
                            size: 14
                        )
                    }
                    .disabled(controller == nil)

                    Button {
                        isCreatingPullRequest = true
                    } label: {
                        JunoIconLabel(verbatim: "Create pull request…", icon: .pulls, size: 14)
                    }
                    .disabled(controller?.pullRequestUnavailableReason != nil)
                }

                Section("Workspace") {
                    Button(action: openSimulator) {
                        JunoIconLabel(verbatim: "Run in Simulator", icon: .device, size: 14)
                    }
                    .disabled(targetRepository == nil)

                    Button { isChoosingRepository = true } label: {
                        JunoIconLabel(verbatim: "Open folder…", icon: .projects, size: 14)
                    }

                    Button { isOpeningQuickly = true } label: {
                        JunoIconLabel(verbatim: "Open file…", icon: .search, size: 14)
                    }
                    .disabled(controller?.context == nil)
                }

                Divider()

                Button(action: toggleComputerUse) {
                    JunoIconLabel(
                        verbatim: controller?.computerUseActive == true
                            ? "Stop screen control" : "Start screen control",
                        icon: .permission,
                        size: 14
                    )
                }
                .disabled(!supportsComputerUse)
                .help(computerUseHelp)
            } label: {
                JunoIconLabel(verbatim: "Task actions", icon: .ellipsis, size: 15)
            }
            .accessibilityIdentifier("juno.code.more")
            .accessibilityLabel("Task actions")
            .accessibilityRepresentation {
                HStack(spacing: 0) {
                    Button(
                        previewTarget == nil ? "Open preview" : "Hide preview",
                        action: openPreview
                    )
                    .disabled(controller == nil)
                    .accessibilityIdentifier("juno.code.preview.toggle")

                    Button(
                        inspectorPresentation.wrappedValue ? "Hide context rail" : "Show context rail",
                        action: { inspectorPresentation.wrappedValue.toggle() }
                    )
                    .disabled(controller == nil)
                    .accessibilityIdentifier("juno.code.inspector.toggle")

                    Button(
                        consoleVisible ? "Hide console" : "Show console",
                        action: toggleConsole
                    )
                    .disabled(controller == nil)
                    .accessibilityIdentifier("juno.code.console.toggle")
                }
            }
        }
    }

    private func openSimulator() {
        guard let repository = targetRepository else { return }
        withAnimation(
            JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)
        ) {
            closePreview()
            simulatorHost.open(
                workspaceKey: repository.id.value,
                workspaceRoot: URL(fileURLWithPath: repository.descriptor.localPathHint)
            )
        }
    }

    private var supportsComputerUse: Bool {
        controller?.computerUseUnavailableReason == nil
    }

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

    // MARK: - Menu bar

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

    private var codeActions: DesktopCodeActions {
        DesktopCodeActions(
            openPalette: { showingPalette = true },
            previousSession: { step(-1) },
            nextSession: { step(1) },
            toggleReview: toggleReview,
            toggleConsole: toggleConsole,
            toggleInspector: { inspectorPresentation.wrappedValue.toggle() },
            openFile: { isOpeningQuickly = true },
            createPullRequest: controller?.pullRequestUnavailableReason == nil
                ? { isCreatingPullRequest = true }
                : nil,
            hasSession: controller != nil
        )
    }

    /// ⌘⇧[ and ⌘⇧]: the session before or after the selected one, in the
    /// column's own order. Wraps.
    private func step(_ delta: Int) {
        let ordered = workbenchModel.visibleSessions.sorted { $0.updatedAt > $1.updatedAt }
        guard !ordered.isEmpty else { return }
        let current = ordered.firstIndex { $0.id == selectedSessionID } ?? -1
        let next = ((current + delta) % ordered.count + ordered.count) % ordered.count
        selection.wrappedValue = .session(ordered[next].id)
    }

    private func toggleReview() {
        guard let controller else { return }
        if controller.review.isPresented {
            controller.review.dismiss()
        } else {
            controller.review.present()
        }
    }

    private func toggleConsole() {
        withAnimation(
            JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion)
        ) {
            consoleVisible.toggle()
        }
    }

    // MARK: - Actions

    private func newSession() {
        consoleVisible = false
        if let record = targetRepository {
            selection.wrappedValue = .repository(record.id)
        } else {
            selection.wrappedValue = .draft
        }
    }

    /// A request from the menu bar item or the quick-entry panel.
    private func consume(_ request: DesktopWorkbenchRegistry.Request) {
        switch request.kind {
        case .newCodeTask(let prompt):
            pendingPrompt = prompt
            newSession()
        case .openSession(let id):
            selection.wrappedValue = .session(id)
        case .newChat:
            // Chat's, not ours. `JunoDesktopWorkspaceView` switches product
            // and hands the prompt across; this window only sees the request
            // because it was on screen when it landed.
            return
        }
        registry.consume(request)
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

    /// Creates and starts the local run described by the New task screen.
    private func start(_ draft: DesktopLocalCodeDraft) {
        guard !isStartingSession else { return }
        isStartingSession = true
        pendingPrompt = nil
        Task {
            defer { isStartingSession = false }
            guard let session = await workbenchModel.createSession(
                workspaceID: draft.workspaceID,
                configuration: draft.configuration,
                isolatedWorktree: draft.usesIsolatedWorktree
            ) else { return }
            await workbenchModel.renameSession(
                id: session.id,
                title: DesktopLocalCodeDraft.title(from: draft.prompt)
            )
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
        selectDefaultRemoteDevice(from: codeModel.devices)

        #if DEBUG
        if CommandLine.arguments.contains("--juno-preview-inspector") {
            inspectorVisible = true
        }
        if previewSessionID != nil {
            await resolveController()
            inspectorReady = controller != nil
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
        await remoteModel.watchEvents(
            deviceID: selectedRemote.deviceID,
            sessionID: selectedRemote.sessionID
        )
    }

    // MARK: - Plan meters

    private var liveRunCount: Int {
        workbenchModel.sessions.filter(\.status.isActive).count
            + codeModel.tasks.filter(\.status.isActive).count
    }

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
                    .keyboardShortcut(".", modifiers: .command)
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
