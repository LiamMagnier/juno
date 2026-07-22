import Foundation
import Observation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

/// One tracked file change in the Changes/Diff tabs, aggregated from
/// transcript events.
public struct TrackedChange: Identifiable, Sendable, Equatable {
    public enum ReviewState: String, Sendable {
        case pending
        case accepted
        case rejected
    }

    public var id: String { path }
    public let path: String
    public var kind: FileChangeKind
    public var linesAdded: Int
    public var linesRemoved: Int
    public var checkpointIDs: [String]
    public var reviewState: ReviewState

    public init(
        path: String,
        kind: FileChangeKind,
        linesAdded: Int,
        linesRemoved: Int,
        checkpointIDs: [String],
        reviewState: ReviewState = .pending
    ) {
        self.path = path
        self.kind = kind
        self.linesAdded = linesAdded
        self.linesRemoved = linesRemoved
        self.checkpointIDs = checkpointIDs
        self.reviewState = reviewState
    }
}

public struct TerminalLine: Identifiable, Sendable, Equatable {
    public let id: Int
    public let channel: ToolOutputChannel
    public let text: String
}

/// Live state and actions for one code session. Bridges the actor-based
/// runtime into MainActor-observable UI state.
@MainActor
@Observable
public final class SessionController {
    /// Everything that can touch the machine: the opened workspace and the
    /// actors driving it. Bundling it in one optional is what makes the DEBUG
    /// preview harness inert *by construction* — with no `Live`, there is no
    /// executor, checkpoint store, Git service or model transport to reach,
    /// rather than a live one the UI merely declines to call.
    struct Live {
        let context: WorkspaceContext
        let store: CodeSessionStore
        let permissions: PermissionCoordinator
        let orchestrator: AgentOrchestrator
    }

    public let sessionID: CodeSessionID
    let live: Live?

    /// The opened workspace, or `nil` in the preview harness. Views must not
    /// reach through this; use the surface accessors below so preview mode
    /// stays renderable without a workspace.
    public var context: WorkspaceContext? { live?.context }

    public private(set) var session: CodeSession
    public private(set) var events: [SessionEvent] = []
    public private(set) var pendingApprovals: [ApprovalRequest] = []
    public private(set) var changes: [TrackedChange] = []
    public private(set) var terminal: [TerminalLine] = []
    public private(set) var lastTestRun: TestRunCompletedEvent?
    public private(set) var gitStatus: GitStatusSummary?
    public private(set) var gitHistory: [GitCommitInfo] = []
    public private(set) var testSuggestions: [TestSuggestion] = []
    public private(set) var rootEntries: [FileEntry] = []
    public private(set) var instructionFiles: [FileEntry] = []
    public private(set) var runStartedAt: Date?
    public var composerText = ""
    public private(set) var transientError: String?

    private var storeObserver: UUID?
    private var terminalLineCounter = 0
    private var reviewStates: [String: TrackedChange.ReviewState] = [:]
    /// Workspace facts the views render. Stored rather than read through
    /// `context` so the inspector and canvas need no workspace in preview.
    private let workspaceSurface: WorkspaceSurface
    #if DEBUG
    /// Diffs and file listings the preview serves instead of reading disk.
    private var previewFixture: CodePreviewFixture?
    #endif

    /// The workspace facts the UI displays: never a capability, only text.
    struct WorkspaceSurface {
        var displayName: String
        var localPathHint: String
        var isGitRepository: Bool
    }

    public init(
        session: CodeSession,
        context: WorkspaceContext,
        store: CodeSessionStore,
        modelClient: any AgentModelClient
    ) {
        self.sessionID = session.id
        self.session = session
        let permissions = PermissionCoordinator(
            sessionID: session.id,
            mode: session.configuration.permissionMode
        )
        self.live = Live(
            context: context,
            store: store,
            permissions: permissions,
            orchestrator: AgentOrchestrator(
                sessionID: session.id,
                model: modelClient,
                registry: context.registry,
                permissions: permissions,
                store: store,
                configuration: AgentOrchestrator.Configuration(
                    systemPrompt: context.systemPrompt()
                ),
                modelID: session.configuration.modelID,
                reasoningEffort: session.configuration.reasoningEffort
            )
        )
        self.workspaceSurface = WorkspaceSurface(
            displayName: context.record.descriptor.displayName,
            localPathHint: context.record.descriptor.localPathHint,
            isGitRepository: context.record.descriptor.isGitRepository
        )
    }

    // MARK: - Workspace surface for views

    /// The workspace name shown in the header, canvas and Context tab.
    public var workspaceDisplayName: String { workspaceSurface.displayName }

    /// The workspace location, abbreviated with a tilde for display. The raw
    /// absolute path never reaches the UI.
    public var workspacePathDisplay: String {
        (workspaceSurface.localPathHint as NSString).abbreviatingWithTildeInPath
    }

    public var isGitRepository: Bool { workspaceSurface.isGitRepository }

    /// Name search for the Files tab. Routed through the controller so views
    /// never hold the workspace index directly.
    public func findFiles(nameContains fragment: String, limit: Int) async -> [FileEntry] {
        guard let live else {
            #if DEBUG
            let needle = fragment.lowercased()
            return (previewFixture?.allEntries ?? [])
                .filter { !$0.isDirectory && $0.path.value.lowercased().contains(needle) }
                .prefix(limit)
                .map { $0 }
            #else
            return []
            #endif
        }
        return (try? await live.context.index.findFiles(
            nameContains: fragment,
            limit: limit
        )) ?? []
    }

    public var isRunning: Bool {
        session.status.isActive
    }

    public var elapsedSeconds: Double? {
        guard let runStartedAt, session.status.isActive else { return nil }
        return Date().timeIntervalSince(runStartedAt)
    }

    // MARK: - Lifecycle

    /// Loads the persisted transcript and wires live observation. Idempotent.
    /// A preview controller is already fully seeded, so this is a no-op there.
    public func attach() async {
        guard let live else { return }
        guard storeObserver == nil else { return }
        let sessionID = self.sessionID
        storeObserver = await live.store.addObserver { [weak self] update in
            Task { @MainActor [weak self] in
                self?.apply(update, own: sessionID)
            }
        }
        let restored = await live.store.events(for: sessionID)
        events = restored
        rebuildDerivedState()
        if let current = try? await live.store.session(id: sessionID) {
            session = current
        }
        pendingApprovals = await live.permissions.pendingApprovals
        await refreshWorkspacePanels()
    }

    public func detach() async {
        guard let live else { return }
        if let token = storeObserver {
            await live.store.removeObserver(token)
            storeObserver = nil
        }
    }

    // MARK: - Agent actions

    public func send() async {
        let prompt = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        composerText = ""
        transientError = nil
        guard let live else {
            #if DEBUG
            previewSend(prompt)
            #endif
            return
        }
        runStartedAt = Date()
        do {
            try await live.orchestrator.submit(prompt: prompt)
        } catch OrchestratorError.sessionAlreadyRunning {
            transientError = "The agent is already running; stop it first."
        } catch {
            transientError = "Could not start the run: \(error)"
        }
    }

    public func stop() async {
        guard let live else {
            #if DEBUG
            previewStop()
            #endif
            return
        }
        await live.orchestrator.stop()
    }

    public func approve(_ approvalID: String) async {
        guard let live else {
            #if DEBUG
            previewResolve(approvalID, decision: .approved)
            #endif
            return
        }
        await live.permissions.resolve(approvalID: approvalID, decision: .approved)
    }

    public func deny(_ approvalID: String) async {
        guard let live else {
            #if DEBUG
            previewResolve(approvalID, decision: .denied)
            #endif
            return
        }
        await live.permissions.resolve(approvalID: approvalID, decision: .denied)
    }

    public func setPermissionMode(_ mode: PermissionMode) async {
        guard let live else {
            session.configuration.permissionMode = mode
            return
        }
        await live.permissions.setMode(mode)
        _ = try? await live.store.updateSession(id: sessionID) { session in
            session.configuration.permissionMode = mode
        }
    }

    // MARK: - Changes review

    public func acceptChange(path: String) {
        reviewStates[path] = .accepted
        rebuildDerivedState()
    }

    public func acceptAll() {
        for change in changes where change.reviewState == .pending {
            reviewStates[change.path] = .accepted
        }
        rebuildDerivedState()
    }

    /// Rejects a change by restoring its checkpoints, newest first.
    public func rejectChange(path: String) async {
        guard let change = changes.first(where: { $0.path == path }) else { return }
        guard let live else {
            // No checkpoint store in preview: record the review state only.
            reviewStates[path] = .rejected
            rebuildDerivedState()
            return
        }
        for checkpointID in change.checkpointIDs.reversed() {
            do {
                try await live.context.checkpoints.restore(id: checkpointID, force: false)
            } catch {
                do {
                    try await live.context.checkpoints.restore(id: checkpointID, force: true)
                } catch {
                    transientError = "Could not undo \(path): \(error)"
                    return
                }
            }
        }
        reviewStates[path] = .rejected
        rebuildDerivedState()
    }

    public func rejectAll() async {
        for change in changes where change.reviewState == .pending {
            await rejectChange(path: change.path)
        }
    }

    /// Current diff for one tracked change, computed against its oldest
    /// checkpoint's pre-content.
    public func diff(for path: String) async -> TextDiff? {
        guard let live else {
            #if DEBUG
            return previewFixture?.diffs[path]
            #else
            return nil
            #endif
        }
        guard let change = changes.first(where: { $0.path == path }),
              let oldestID = change.checkpointIDs.first,
              let checkpoint = await live.context.checkpoints.checkpoint(id: oldestID),
              let workspacePath = try? WorkspacePath(path)
        else { return nil }
        let before = checkpoint.preContent ?? ""
        let after: String
        if let url = try? live.context.access.resolveForReading(workspacePath),
           let current = try? String(contentsOf: url, encoding: .utf8)
        {
            after = current
        } else {
            after = ""
        }
        return try? DiffEngine.diff(old: before, new: after)
    }

    // MARK: - Inspector data

    /// Refreshes the inspector panels from the workspace. A preview controller
    /// carries its panels as fixtures, so there is nothing to reload.
    public func refreshWorkspacePanels() async {
        guard let live else { return }
        testSuggestions = await live.context.tests.detectSuggestions()
        instructionFiles = await live.context.instructionFiles()
        rootEntries = (try? await live.context.index.listDirectory(nil)) ?? []
        if live.context.record.descriptor.isGitRepository {
            gitStatus = try? await live.context.git.status()
            gitHistory = (try? await live.context.git.log(limit: 20)) ?? []
        }
    }

    public func listDirectory(_ path: WorkspacePath?) async -> [FileEntry] {
        guard let live else {
            #if DEBUG
            return previewFixture?.children(of: path) ?? []
            #else
            return []
            #endif
        }
        return (try? await live.context.index.listDirectory(path)) ?? []
    }

    public func runTest(command: String) async {
        transientError = nil
        guard let live else {
            transientError = "Preview mode does not run tests: no command executor is attached."
            return
        }
        do {
            _ = try await live.context.registry.invoke(
                toolName: "run_tests",
                input: ["command": .string(command)],
                context: ToolContext(
                    sessionID: sessionID,
                    toolCallID: "manual-test-\(UUID().uuidString.prefix(8))",
                    emitOutput: { [weak self] channel, text in
                        await self?.appendManualTerminal(channel: channel, text: text)
                    }
                ),
                permissions: live.permissions
            )
        } catch {
            transientError = "Test run failed: \(error)"
        }
        await refreshWorkspacePanels()
    }

    public func commit(message: String) async -> Bool {
        transientError = nil
        guard let live else {
            transientError = "Preview mode does not run Git: no repository is attached."
            return false
        }
        do {
            let status = try await live.context.git.status()
            let paths = status.files.map(\.path)
            guard !paths.isEmpty else {
                transientError = "Nothing to commit."
                return false
            }
            try await live.context.git.stage(paths: paths)
            _ = try await live.context.git.commit(message: message)
            await refreshWorkspacePanels()
            return true
        } catch {
            transientError = "Commit failed: \(error)"
            return false
        }
    }

    // MARK: - Event application

    private func apply(_ update: CodeSessionStore.StoreUpdate, own sessionID: CodeSessionID) {
        switch update {
        case let .sessionChanged(changed) where changed.id == sessionID:
            session = changed
            if !changed.status.isActive {
                runStartedAt = nil
            }
        case let .eventAppended(event) where event.sessionID == sessionID:
            events.append(event)
            integrate(event)
        default:
            break
        }
    }

    private func integrate(_ event: SessionEvent) {
        switch event.payload {
        case let .approvalRequested(request):
            pendingApprovals.append(request)
        case let .approvalResolved(resolved):
            pendingApprovals.removeAll { $0.id == resolved.approvalID }
        case let .toolOutput(output):
            terminalLineCounter += 1
            terminal.append(
                TerminalLine(id: terminalLineCounter, channel: output.channel, text: output.text)
            )
            if terminal.count > 2_000 {
                terminal.removeFirst(terminal.count - 2_000)
            }
        case let .fileChanged(change):
            reviewStates[change.path.value] = nil
            rebuildDerivedState()
        case let .testRunCompleted(run):
            lastTestRun = run
        case .runCompleted:
            Task { await refreshWorkspacePanels() }
        default:
            break
        }
    }

    private func appendManualTerminal(channel: ToolOutputChannel, text: String) {
        terminalLineCounter += 1
        terminal.append(TerminalLine(id: terminalLineCounter, channel: channel, text: text))
    }

    /// Aggregates fileChanged events into per-path tracked changes.
    private func rebuildDerivedState() {
        var byPath: [String: TrackedChange] = [:]
        var order: [String] = []
        for event in events {
            guard case let .fileChanged(change) = event.payload else { continue }
            let key = change.path.value
            if var existing = byPath[key] {
                existing.kind = change.kind
                existing.linesAdded += change.linesAdded
                existing.linesRemoved += change.linesRemoved
                if let checkpointID = change.checkpointID {
                    existing.checkpointIDs.append(checkpointID)
                }
                byPath[key] = existing
            } else {
                order.append(key)
                byPath[key] = TrackedChange(
                    path: key,
                    kind: change.kind,
                    linesAdded: change.linesAdded,
                    linesRemoved: change.linesRemoved,
                    checkpointIDs: change.checkpointID.map { [$0] } ?? []
                )
            }
        }
        changes = order.compactMap { key in
            guard var change = byPath[key] else { return nil }
            change.reviewState = reviewStates[key] ?? .pending
            return change
        }
    }

    #if DEBUG
    // MARK: - DEBUG preview harness

    /// A controller backed entirely by a local fixture, for `--juno-code-ui-preview`.
    ///
    /// It is built without a `Live` bundle, so there is no `WorkspaceContext`,
    /// no `CommandExecutionService`, no `GitService`, no `CheckpointStore`, no
    /// `CodeSessionStore` and no model transport anywhere in the object graph.
    /// Preview inertness is therefore a property of the type, not a set of call
    /// sites that remembered to check a flag — and no production security check
    /// is relaxed to achieve it.
    init(previewFixture fixture: CodePreviewFixture) {
        self.sessionID = fixture.session.id
        self.live = nil
        self.session = fixture.session
        self.workspaceSurface = WorkspaceSurface(
            displayName: fixture.workspaceDisplayName,
            localPathHint: fixture.workspacePathHint,
            isGitRepository: fixture.isGitRepository
        )
        self.previewFixture = fixture
        self.events = fixture.events
        self.pendingApprovals = fixture.pendingApprovals
        self.terminal = fixture.terminal
        self.terminalLineCounter = fixture.terminal.last?.id ?? 0
        self.lastTestRun = fixture.lastTestRun
        self.gitStatus = fixture.gitStatus
        self.gitHistory = fixture.gitHistory
        self.testSuggestions = fixture.testSuggestions
        self.rootEntries = fixture.rootEntries
        self.instructionFiles = fixture.instructionFiles
        self.transientError = fixture.transientError
        self.composerText = fixture.composerText
        self.runStartedAt = fixture.runStartedAt
        rebuildDerivedState()
    }

    /// Appends the prompt so the transcript and scroll behaviour can be
    /// inspected, then says plainly that no agent will answer it.
    private func previewSend(_ prompt: String) {
        appendPreviewEvent(.userPrompt(UserPromptEvent(text: prompt)))
        transientError = "Preview mode does not run the agent: no model transport is attached."
    }

    private func previewStop() {
        session.status = .cancelled
        runStartedAt = nil
    }

    private func previewResolve(_ approvalID: String, decision: ApprovalDecision) {
        guard pendingApprovals.contains(where: { $0.id == approvalID }) else { return }
        pendingApprovals.removeAll { $0.id == approvalID }
        appendPreviewEvent(
            .approvalResolved(ApprovalResolvedEvent(approvalID: approvalID, decision: decision))
        )
        if pendingApprovals.isEmpty, session.status == .waitingForApproval {
            session.status = decision == .approved ? .running : .cancelled
        }
    }

    /// Appends to the in-memory transcript only. There is no store to write to.
    private func appendPreviewEvent(_ payload: SessionEventPayload) {
        let next = (events.last?.sequence ?? 0) + 1
        events.append(
            SessionEvent(
                id: "preview-event-\(sessionID.value)-\(next)",
                sessionID: sessionID,
                sequence: next,
                timestamp: Date(),
                payload: payload
            )
        )
        rebuildDerivedState()
    }
    #endif
}
