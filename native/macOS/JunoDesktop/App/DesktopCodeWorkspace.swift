import Foundation
import JunoCodeCore
import JunoCodeKit
import JunoCodeUI
import JunoCore
import JunoDesignSystem
import SwiftUI
import UniformTypeIdentifiers

/// The Code window: one layout owner, two columns, one optional trailing
/// inspector.
///
/// This is byte-for-byte the shell ``DesktopChatWorkspace`` uses — a
/// `NavigationSplitView` whose sidebar is `.junoSidebarColumn()` and whose detail
/// is `.junoReadingCanvas()` plus `.navigationTitle`, `.navigationSubtitle`,
/// `.toolbar` and `.inspector(isPresented:)` — so Chat and Code stop being two
/// different applications sharing a window.
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
    @Binding var product: DesktopProductMode
    /// Starts a normal Juno conversation, independent of a repository.
    let newChat: () -> Void

    @SceneStorage("juno.desktop.code.selection") private var storedSelection = ""
    @SceneStorage("juno.desktop.code.columns") private var storedColumnVisibility = ""
    @SceneStorage("juno.desktop.code.inspector") private var inspectorVisible = false
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
    /// Whether the dictation capsule is up over the Code canvas.
    @State private var isDictating = false
    @FocusState private var sidebarSearchFocused: Bool
    @Environment(\.openWindow) private var openWindow

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
                isBootstrapping: isBootstrapping,
                openRepository: { isChoosingRepository = true },
                newSession: { selection.wrappedValue = .repository($0) },
                rename: beginRename
            )
            .junoSidebarColumn()
        } detail: {
            detail
                .junoReadingCanvas()
                .navigationTitle(windowTitle)
                // No `.navigationSubtitle`.
                //
                // It restated what the detail column already shows in its own header
                // one line below — the same path, the same "Folder"/"Git repository"
                // — so the window said it twice. It also made the titlebar two lines
                // tall, which is what pushed the leading title block wide enough to
                // shove the `.principal` product switcher off centre.
                .toolbar { detailToolbar }
                // The search field belongs to the **detail** column, not to the
                // split view and not to the sidebar.
                //
                // Attached to either of those, macOS 27 gives the search field
                // the leading column's titlebar safe area — the source list then
                // starts at the very top of the window and its first rows are
                // drawn behind the toolbar and under the traffic lights, which
                // is exactly what the Code sidebar was doing. The Chat window has
                // never had a `.searchable` of its own and has never had the
                // problem; this puts Code on the same footing. `placement:
                // .toolbar` still renders it in the same place on screen, and the
                // text it drives is the workbench's, so what it filters is
                // unchanged.
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
            }
        }
        .alert("Rename Session", isPresented: renameBinding) {
            TextField("Title", text: $renameText)
            Button("Rename") { commitRename() }
            Button("Cancel", role: .cancel) { renamingSession = nil }
        }
        .task { await bootstrap() }
        .task(id: selectedSessionID) { await resolveController() }
        .task(id: selectedTask?.id) { followSelectedTask() }
        .task(id: remoteDeviceID) { await loadRemoteSessions() }
        .task(id: selection.wrappedValue) { await followSelectedRemoteSession() }
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
            guard let controller else { return }
            Task { await controller.detach() }
        }
        .onChange(of: columnVisibility) { _, visibility in
            storedColumnVisibility = visibility == .detailOnly ? "detailOnly" : "all"
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
            // No `openConnections`: Connections is a Chat destination, and there
            // is no honest channel from this window to a specific Chat page —
            // only the product switch, which would land the reader on whatever
            // Chat was last showing. `NativePullsView` drops the button when it
            // has nowhere to send them, so the empty state still explains itself.
            NativePullsView(client: pullsClient, accountID: accountID)

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
            }
        )
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

    private func localSession(_ controller: SessionController) -> some View {
        CodeSessionCanvas(
            controller: controller,
            model: workbenchModel,
            showsReview: $reviewVisible,
            showsConsole: $consoleVisible,
            beginDictation: {
                withAnimation(JunoMotion.fast) { isDictating = true }
            }
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

    @ViewBuilder
    private var inspector: some View {
        Group {
            if let controller {
                CodeSessionInspector(controller: controller)
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
            min: JunoInspectorMetrics.minimum,
            ideal: JunoInspectorMetrics.ideal,
            max: JunoInspectorMetrics.maximum
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
            .junoFloatingChrome(cornerRadius: JunoRadius.panel)
            .accessibilityElement(children: .contain)
        }
    }

    private func sessionsWaitingForApproval(
        excluding current: CodeSessionID?
    ) -> [CodeSession] {
        workbenchModel.sessions.filter { $0.hasPendingApproval && $0.id != current }
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
                Button("Show") { selection.wrappedValue = .session(first.id) }
                    .buttonStyle(.borderless)
                    .tint(Color.junoAccent)
                    .accessibilityIdentifier("juno.code.show-approval")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .junoFloatingChrome(cornerRadius: JunoRadius.panel)
            .accessibilityElement(children: .contain)
        }
    }

    // MARK: - Title

    private var windowTitle: String {
        switch selection.wrappedValue {
        case .session(let id):
            return workbenchModel.sessions.first { $0.id == id }?.title ?? "Session"
        case .task(let id):
            return codeModel.tasks.first { $0.id == id }?.title ?? "Run"
        case .remote:
            return selectedRemoteSummary?.title ?? "Remote session"
        case .allProjects:
            return "All Projects"
        case .draft:
            return "New conversation"
        case .pulls:
            return "Pull requests"
        case .repository(let id):
            return workbenchModel.workspaces.first { $0.id == id }?
                .descriptor.displayName ?? "New conversation"
        case nil:
            return workbenchModel.workspaces.first?.descriptor.displayName ?? "New conversation"
        }
    }

    /// Session identity, as text.
    ///
    /// Repository, branch and execution environment are all fixed for the life of
    /// a session — `CodeSession.workspaceID` is already `let`, and Local, Cloud,
    /// Device and Remote each select a different engine — so they are stated here
    /// and are deliberately not controls anywhere in the window.
    private var windowSubtitle: String {
        var parts: [String] = []
        switch selection.wrappedValue {
        case .session(let id):
            guard let session = workbenchModel.sessions.first(where: { $0.id == id }) else {
                return ""
            }
            parts = [workbenchModel.workspaceName(for: session.workspaceID)]
            if let branch = session.gitBranch { parts.append(branch) }
            parts.append(CodeRunEnvironment.local.rawValue)
        case .task(let id):
            guard let task = codeModel.tasks.first(where: { $0.id == id }) else { return "" }
            parts = [task.whereItRuns]
            if let base = task.baseRef { parts.append(base) }
            parts.append(
                (task.target == .cloud ? CodeRunEnvironment.cloud : .device).rawValue
            )
        case .remote:
            guard let summary = selectedRemoteSummary else { return "" }
            parts = [summary.workspaceName ?? "Remote workspace"]
            if let branch = summary.activeBranch { parts.append(branch) }
            parts.append(CodeRunEnvironment.remote.rawValue)
        case .allProjects:
            let count = workbenchModel.workspaces.count
            return count == 1 ? "1 project" : "\(count) projects"
        case .draft:
            return "No project"
        case .pulls:
            // Deliberately empty: the count is the list's own business, and a
            // subtitle here would be stale for as long as it took to load.
            return ""
        case .repository(let id):
            guard let record = workbenchModel.workspaces.first(where: { $0.id == id }) else {
                // The grant is gone, so this is a projectless composer now.
                return "No project"
            }
            parts = repositoryFacts(record)
        case nil:
            // A window with no selection shows the most recent repository as a
            // draft, so the subtitle describes that repository rather than the
            // absence of a selection.
            guard let record = workbenchModel.workspaces.first else { return "" }
            parts = repositoryFacts(record)
        }
        return parts.joined(separator: " · ")
    }

    private func repositoryFacts(_ record: WorkspaceRecord) -> [String] {
        [
            (record.descriptor.localPathHint as NSString).abbreviatingWithTildeInPath,
            record.descriptor.isGitRepository ? "Git repository" : "Folder",
        ]
    }

    // MARK: - Toolbar

    /// A fixed set. Every item is present in every state and disables rather than
    /// vanishing — both because a rebuilt AppKit toolbar is the documented crash
    /// surface here, and because a control that keeps its position is one the
    /// pointer does not have to re-find.
    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        // In the toolbar rather than at the top of the sidebar: as a
        // `safeAreaInset` on the column the switch had no opaque backing, so a
        // scrolled source list slid its rows under both the switch and the
        // window's traffic lights. It also stays reachable here when the sidebar
        // is collapsed.
        // `.principal`, not `.navigation`.
        //
        // `.navigation` placement in a `NavigationSplitView` puts an item in the
        // **sidebar's** titlebar, alongside the traffic lights — so the top-level
        // Chat/Code switch sat inside the navigation column, crowding the window
        // controls and reading as though it belonged to the project list under it.
        // It is a window-level control, not a sidebar one. `.principal` places it in
        // the content area's toolbar, where it is still always visible with the
        // sidebar collapsed.
        //
        // Both windows move together: this is the one control that occupies the same
        // spot in Chat and Code, and a different placement in each would make it jump
        // on every mode change.
        ToolbarItem(placement: .principal) {
            // No width imposed here: the switcher owns its own metrics (see
            // `DesktopProductSwitcher`). A flat width from the toolbar is what
            // squeezed the two labels against their segment edges and stopped the
            // control growing with Dynamic Type.
            DesktopProductSwitcher(selection: $product)
        }

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

        ToolbarItem(placement: .status) {
            statusIndicator
        }

        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button(action: openPreview) {
                    Label("Open Preview", systemImage: "rectangle.on.rectangle")
                }
                .keyboardShortcut("p", modifiers: [.command, .option])
                .disabled(controller?.context == nil)
                .accessibilityIdentifier("juno.code.preview")

                Button { consoleVisible.toggle() } label: {
                    Label("Console", systemImage: "terminal")
                }
                .keyboardShortcut("c", modifiers: [.command, .option])
                .disabled(controller == nil)
                .accessibilityIdentifier("juno.code.console")

                Button { reviewVisible.toggle() } label: {
                    Label(reviewTitle, systemImage: "plusminus.circle")
                }
                .keyboardShortcut("r", modifiers: [.command, .option])
                .disabled(controller == nil)
                .accessibilityIdentifier("juno.code.review")

                Button { inspectorVisible.toggle() } label: {
                    Label("Inspector", systemImage: "sidebar.trailing")
                }
                .keyboardShortcut("i", modifiers: [.command, .option])
                .disabled(controller == nil)
                .accessibilityIdentifier("juno.code.inspector")

                // `OpenQuicklySheet` is a complete 163-line file browser that had
                // zero call sites: nothing in the app or the package ever presented
                // it, so the documented way to open a workspace file by name did not
                // exist in the shipping product. ⌘⇧O because plain ⌘O is already
                // "Add project…" in the sidebar.
                Button { isChoosingRepository = true } label: {
                    Label("Add Project…", systemImage: "folder.badge.plus")
                }
                .keyboardShortcut("o", modifiers: .command)
                .accessibilityIdentifier("juno.code.add-project")

                Button { isOpeningQuickly = true } label: {
                    Label("Open Quickly…", systemImage: "magnifyingglass")
                }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(controller?.context == nil)
                .accessibilityIdentifier("juno.code.open-quickly")

                Divider()

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
                // `computerUseHelp` was computed and never attached to anything,
                // so a dimmed item gave no reason for being dimmed.
                .help(computerUseHelp)
                .accessibilityIdentifier("juno.code.computer-use")
            } label: {
                Label("Session tools", systemImage: "ellipsis.circle")
            }
            .help("Preview, review, console, inspector, and screen control")
            .accessibilityIdentifier("juno.code.session-tools")
        }

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
            Button(action: stop) {
                Label("Stop", systemImage: "stop.fill")
            }
            .tint(isRunning ? Color.junoDanger : nil)
            .keyboardShortcut(".", modifiers: .command)
            .disabled(!isRunning)
            .help("Stop this run immediately (⌘.)")
            .accessibilityIdentifier("juno.code.stop")
        }
    }

    /// Real elapsed time while a run is live, the run's own status otherwise.
    /// The ticking clock only exists while something is actually running.
    @ViewBuilder
    private var statusIndicator: some View {
        if let status = currentStatus {
            if status.isActive, let startedAt = controller?.runStartedAt {
                TimelineView(.periodic(from: startedAt, by: 1)) { context in
                    Label(
                        "\(status.label) · \(elapsed(from: startedAt, to: context.date))",
                        systemImage: status.symbol
                    )
                    .foregroundStyle(status.tint)
                    .monospacedDigit()
                }
                .accessibilityLabel("\(status.label), running")
            } else {
                Label(status.label, systemImage: status.symbol)
                    .foregroundStyle(status.tint)
            }
        } else {
            // Not `square.and.pencil`: that is the New-session button's glyph, and
            // a toolbar drawing the same icon twice a few points apart reads as two
            // of the same control rather than as an action and a status.
            Label("Draft", systemImage: "circle.dashed")
                .foregroundStyle(.secondary)
                .accessibilityLabel("New session draft")
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

    private var reviewTitle: String {
        let pending = controller?.changes.filter { $0.reviewState == .pending }.count ?? 0
        return pending == 0 ? "Review" : "Review (\(pending))"
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
        openWindow(
            id: CodePreviewScene.windowID,
            value: CodePreviewTarget(workspaceRoot: root)
        )
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
            sessions: workbenchModel.sessions.map(\.id),
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

    private func selectDefaultRemoteDevice(from devices: [NativeCodeDevice]) {
        guard remoteDeviceID.isEmpty || !devices.contains(where: { $0.id == remoteDeviceID })
        else { return }
        remoteDeviceID = devices.first(where: \.online)?.id ?? devices.first?.id ?? ""
    }
}

// MARK: - Cloud and device runs

/// A run on Juno's cloud runner or on another computer, followed over the task
/// relay.
///
/// It is a separate surface from the local canvas for a structural reason, not a
/// stylistic one: `NativeCodeTaskStore` flattens every wire payload into
/// `title`/`detail` strings, so there is no `SessionEvent`, no `TrackedChange`, no
/// diff and no terminal output to render. The window says so by disabling Review,
/// Console and the Inspector rather than by showing empty versions of them.
private struct DesktopCodeTaskCanvas: View {
    let task: NativeCodeTask
    let code: NativeCodeModel

    private static let measure: CGFloat = 720

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
                    ForEach(code.events) { event in
                        eventRow(event).id(event.seq)
                    }
                    if code.isStreaming {
                        HStack(spacing: JunoSpace.snug) {
                            ProgressView().controlSize(.small)
                            Text("Following this run").junoCaption()
                        }
                    }
                    if let error = code.lastErrorDescription {
                        Text(error)
                            .junoCaption()
                            .foregroundStyle(Color.junoDanger)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: Self.measure, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(JunoSpace.region)
            }
            .onChange(of: code.events.count) { _, _ in
                guard let last = code.events.last?.seq else { return }
                withAnimation(JunoMotion.fast) { proxy.scrollTo(last, anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: JunoSpace.snug) {
                if let approval = code.pendingApproval {
                    DesktopCodeRelayApproval(
                        summary: approval.summary,
                        risk: approval.risk,
                        detail: approval.detail,
                        toolName: nil,
                        isBusy: false,
                        respond: { approved in
                            Task { await code.respondToApproval(approve: approved) }
                        }
                    )
                }
                // No send field: the cloud task API has no message route, so a
                // composer here would be a control that cannot work. Stop is the
                // only thing this transport can do to a run in flight.
                if let url = task.pullRequestURL {
                    HStack(spacing: JunoSpace.cozy) {
                        Link(destination: url) {
                            JunoIconLabel(verbatim: "Open pull request", icon: .pulls, size: 14)
                        }
                        Spacer(minLength: 0)
                    }
                }
                Text("This run is driven by Juno. Follow-up messages are not available for cloud and device runs.")
                    .junoCaption()
            }
            .frame(maxWidth: Self.measure, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, JunoSpace.region)
            .padding(.bottom, JunoSpace.regular)
        }
    }

    private func eventRow(_ event: NativeCodeEvent) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            Group {
                if let icon = junoIcon(event.kind) {
                    JunoIconView(icon, size: 13)
                } else {
                    Image(systemName: symbol(event.kind)).font(.caption)
                }
            }
            .foregroundStyle(event.kind == .error ? Color.junoDanger : Color.junoAccent)
            .frame(width: 18)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(event.title).junoRowLabel()
                if let detail = event.detail {
                    Group {
                        if isTechnical(event.kind) {
                            Text(detail).junoMono()
                        } else {
                            Text(detail).junoBody()
                        }
                    }
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                }
            }
            Spacer(minLength: JunoSpace.snug)
            Text(event.createdAt, style: .time)
                .junoCaption()
                .monospacedDigit()
        }
    }

    private func symbol(_ kind: NativeCodeEvent.Kind) -> String {
        switch kind {
        case .status: "circle.dotted"
        case .user: "person"
        case .text: "text.alignleft"
        case .tool: "wrench.and.screwdriver"
        case .fileChange: "doc.badge.gearshape"
        case .approvalRequest, .approvalResponse: "hand.raised"
        case .cancelRequest: "stop.circle"
        case .error: "exclamationmark.triangle"
        case .done: "checkmark.circle"
        case .agent: "person.2"
        }
    }

    /// The two event kinds the website has its own mark for.
    ///
    /// A transcript is mostly native vocabulary — the web renders tool calls
    /// and file changes as typed blocks, not as icons — but a permission
    /// request is a shield everywhere else in Juno and a failure is a circle,
    /// and a reader who has just seen those marks in the sidebar should not
    /// meet different ones three inches away.
    private func junoIcon(_ kind: NativeCodeEvent.Kind) -> JunoIcon? {
        switch kind {
        case .approvalRequest, .approvalResponse: .permission
        case .error: .error
        default: nil
        }
    }

    private func isTechnical(_ kind: NativeCodeEvent.Kind) -> Bool {
        kind == .tool || kind == .fileChange || kind == .error
    }
}

// MARK: - Relay-watched sessions

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
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    ForEach(remote.events, id: \.seq) { event in
                        eventRow(event).id(event.seq)
                    }
                    if let error = remote.lastErrorDescription {
                        Text(error)
                            .junoCaption()
                            .foregroundStyle(Color.junoDanger)
                            .textSelection(.enabled)
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
        .overlay {
            if remote.events.isEmpty {
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
            .junoFloatingChrome(cornerRadius: CGFloat(JunoCornerRadius.composer))
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
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            Text(event.kind.replacingOccurrences(of: "_", with: " "))
                .junoCaption()
                .frame(width: 116, alignment: .leading)
            Text(text(of: event))
                .junoMono()
                .textSelection(.enabled)
            Spacer(minLength: JunoSpace.snug)
        }
    }

    private func text(of event: CodeRemoteSessionEvent) -> String {
        for key in ["text", "detail", "summary", "title"] {
            if let value = event.payload[key]?.stringValue { return value }
        }
        guard let data = try? JSONEncoder().encode(event.payload),
            let encoded = String(data: data, encoding: .utf8)
        else { return "—" }
        return encoded
    }

    private func send() {
        let text = trimmed
        guard canSend, !text.isEmpty else { return }
        message = ""
        Task { await remote.send(deviceID: deviceID, sessionID: sessionID, text: text) }
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
                Text(toolName).junoMono().foregroundStyle(.secondary)
            }
            if let detail {
                Text(detail).junoCaption().textSelection(.enabled)
            }

            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Deny", role: .destructive) { respond(false) }
                    .keyboardShortcut(.escape, modifiers: .shift)
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
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(isCritical ? Color.junoDanger : Color.junoCaution)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Approval required: \(summary)")
    }
}
