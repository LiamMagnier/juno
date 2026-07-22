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
    public let sessionID: CodeSessionID
    public let context: WorkspaceContext

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

    private let store: CodeSessionStore
    private let permissions: PermissionCoordinator
    private let orchestrator: AgentOrchestrator
    private var storeObserver: UUID?
    private var terminalLineCounter = 0
    private var reviewStates: [String: TrackedChange.ReviewState] = [:]

    public init(
        session: CodeSession,
        context: WorkspaceContext,
        store: CodeSessionStore,
        modelClient: any AgentModelClient
    ) {
        self.sessionID = session.id
        self.session = session
        self.context = context
        self.store = store
        let permissions = PermissionCoordinator(
            sessionID: session.id,
            mode: session.configuration.permissionMode
        )
        self.permissions = permissions
        self.orchestrator = AgentOrchestrator(
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
    public func attach() async {
        guard storeObserver == nil else { return }
        let sessionID = self.sessionID
        storeObserver = await store.addObserver { [weak self] update in
            Task { @MainActor [weak self] in
                self?.apply(update, own: sessionID)
            }
        }
        let restored = await store.events(for: sessionID)
        events = restored
        rebuildDerivedState()
        if let current = try? await store.session(id: sessionID) {
            session = current
        }
        pendingApprovals = await permissions.pendingApprovals
        await refreshWorkspacePanels()
    }

    public func detach() async {
        if let token = storeObserver {
            await store.removeObserver(token)
            storeObserver = nil
        }
    }

    // MARK: - Agent actions

    public func send() async {
        let prompt = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        composerText = ""
        transientError = nil
        runStartedAt = Date()
        do {
            try await orchestrator.submit(prompt: prompt)
        } catch OrchestratorError.sessionAlreadyRunning {
            transientError = "The agent is already running; stop it first."
        } catch {
            transientError = "Could not start the run: \(error)"
        }
    }

    public func stop() async {
        await orchestrator.stop()
    }

    public func approve(_ approvalID: String) async {
        await permissions.resolve(approvalID: approvalID, decision: .approved)
    }

    public func deny(_ approvalID: String) async {
        await permissions.resolve(approvalID: approvalID, decision: .denied)
    }

    public func setPermissionMode(_ mode: PermissionMode) async {
        await permissions.setMode(mode)
        _ = try? await store.updateSession(id: sessionID) { session in
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
        for checkpointID in change.checkpointIDs.reversed() {
            do {
                try await context.checkpoints.restore(id: checkpointID, force: false)
            } catch {
                do {
                    try await context.checkpoints.restore(id: checkpointID, force: true)
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
        guard let change = changes.first(where: { $0.path == path }),
              let oldestID = change.checkpointIDs.first,
              let checkpoint = await context.checkpoints.checkpoint(id: oldestID),
              let workspacePath = try? WorkspacePath(path)
        else { return nil }
        let before = checkpoint.preContent ?? ""
        let after: String
        if let url = try? context.access.resolveForReading(workspacePath),
           let current = try? String(contentsOf: url, encoding: .utf8)
        {
            after = current
        } else {
            after = ""
        }
        return try? DiffEngine.diff(old: before, new: after)
    }

    // MARK: - Inspector data

    public func refreshWorkspacePanels() async {
        testSuggestions = await context.tests.detectSuggestions()
        instructionFiles = await context.instructionFiles()
        rootEntries = (try? await context.index.listDirectory(nil)) ?? []
        if context.record.descriptor.isGitRepository {
            gitStatus = try? await context.git.status()
            gitHistory = (try? await context.git.log(limit: 20)) ?? []
        }
    }

    public func listDirectory(_ path: WorkspacePath?) async -> [FileEntry] {
        (try? await context.index.listDirectory(path)) ?? []
    }

    public func runTest(command: String) async {
        transientError = nil
        do {
            _ = try await context.registry.invoke(
                toolName: "run_tests",
                input: ["command": .string(command)],
                context: ToolContext(
                    sessionID: sessionID,
                    toolCallID: "manual-test-\(UUID().uuidString.prefix(8))",
                    emitOutput: { [weak self] channel, text in
                        await self?.appendManualTerminal(channel: channel, text: text)
                    }
                ),
                permissions: permissions
            )
        } catch {
            transientError = "Test run failed: \(error)"
        }
        await refreshWorkspacePanels()
    }

    public func commit(message: String) async -> Bool {
        transientError = nil
        do {
            let status = try await context.git.status()
            let paths = status.files.map(\.path)
            guard !paths.isEmpty else {
                transientError = "Nothing to commit."
                return false
            }
            try await context.git.stage(paths: paths)
            _ = try await context.git.commit(message: message)
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
}
