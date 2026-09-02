import Foundation
import JunoAuth
import JunoCodeBridge
import JunoCodeCore
import JunoCore
import JunoCodeKit
import JunoCodeUI
import JunoCodeRuntime
import JunoSync
import Observation

private struct DesktopQueuedCodeSnapshot: Sendable {
    let events: [SessionEvent]
    let status: SessionStatus
}

/// The local Workbench adapter used by the server-owned `/api/code/tasks`
/// queue. Device tasks deliberately reuse the same controller as a task typed
/// on this Mac: one permission model, one checkpoint store and one transcript.
@MainActor
private final class DesktopQueuedCodeExecutor {
    private let workbench: WorkbenchModel

    init(workbench: WorkbenchModel) {
        self.workbench = workbench
    }

    func start(_ task: NativeCodeAgentTask) async throws -> String {
        guard let workspace = workbench.workspaces.first(where: { record in
            if let key = task.workspaceKey, !key.isEmpty {
                return record.descriptor.id.value == key
            }
            return record.descriptor.localPathHint == task.workspacePath
        }) else {
            throw DesktopQueuedCodeError.workspaceUnavailable(task.workspaceName)
        }

        let selectedModel = task.modelId.flatMap { requested in
            workbench.availableModels.first(where: { $0.modelID == requested })?.modelID
        } ?? workbench.availableModels.first?.modelID
        guard let selectedModel else { throw DesktopQueuedCodeError.noModelAvailable }

        let behavior: AgentBehavior = task.permissionMode == .plan ? .plan : .code
        let permission: PermissionMode = switch task.permissionMode {
        case .plan: .readOnly
        case .ask: .askBeforeChanges
        case .autoEdit: .workspaceWrite
        case .full: .fullAccess
        }
        let configuration = AgentConfiguration(
            modelID: selectedModel,
            reasoningEffort: task.reasoningEffort.flatMap(ReasoningEffort.init(rawValue:)),
            behavior: behavior,
            permissionMode: permission,
            location: .local,
            // A remote device may ask for Computer Use, but starting screen and
            // accessibility capture on a Mac with nobody present is a separate
            // consent boundary. It remains off for queued work.
            computerUseEnabled: false
        )
        guard let session = await workbench.createSession(
            workspaceID: workspace.id,
            configuration: configuration
        ), let controller = await workbench.controller(for: session.id) else {
            throw DesktopQueuedCodeError.sessionUnavailable
        }
        await workbench.renameSession(id: session.id, title: task.title)
        controller.composerText = task.prompt
        await controller.send()
        if let error = controller.transientError {
            throw DesktopQueuedCodeError.startFailed(error)
        }
        return session.id.value
    }

    func snapshot(sessionID: String, after sequence: Int) async throws
        -> DesktopQueuedCodeSnapshot
    {
        guard let controller = await workbench.controller(
            for: CodeSessionID(value: sessionID)
        ) else { throw DesktopQueuedCodeError.sessionUnavailable }
        return DesktopQueuedCodeSnapshot(
            events: controller.events.filter { $0.sequence > sequence },
            status: controller.session.status
        )
    }

    func resolveApproval(sessionID: String, requestID: String, approve: Bool) async throws {
        guard let controller = await workbench.controller(
            for: CodeSessionID(value: sessionID)
        ) else { throw DesktopQueuedCodeError.sessionUnavailable }
        if approve {
            await controller.approve(requestID)
        } else {
            await controller.deny(requestID)
        }
    }

    func stop(sessionID: String) async {
        await workbench.controller(for: CodeSessionID(value: sessionID))?.stop()
    }
}

private enum DesktopQueuedCodeError: LocalizedError {
    case workspaceUnavailable(String)
    case noModelAvailable
    case sessionUnavailable
    case startFailed(String)

    var errorDescription: String? {
        switch self {
        case .workspaceUnavailable(let name):
            "This Mac can no longer open \(name). Re-share the folder in Juno Code."
        case .noModelAvailable:
            "No coding model is available for this account."
        case .sessionUnavailable:
            "Juno could not create a local session for this remote task."
        case .startFailed(let message): message
        }
    }
}

/// Claims the device task queue, streams Workbench events back to the server,
/// and carries approval/cancel controls in the opposite direction.
private actor DesktopQueuedCodeHost {
    private let deviceID: String
    private let accountID: AccountID
    private let client: NativeCodeAgentClient
    private let executor: DesktopQueuedCodeExecutor
    private var loop: Task<Void, Never>?
    private var activeSessionID: String?

    init(
        deviceID: String,
        accountID: AccountID,
        client: NativeCodeAgentClient,
        executor: DesktopQueuedCodeExecutor
    ) {
        self.deviceID = deviceID
        self.accountID = accountID
        self.client = client
        self.executor = executor
    }

    func activate() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            await self?.runLoop()
        }
    }

    func deactivate() async {
        loop?.cancel()
        loop = nil
        if let activeSessionID {
            await executor.stop(sessionID: activeSessionID)
            self.activeSessionID = nil
        }
    }

    private func runLoop() async {
        while !Task.isCancelled {
            do {
                guard let queued = try await client.queuedTask(
                    deviceID: deviceID,
                    for: accountID
                ) else { continue }
                let task = try await client.claim(
                    taskID: queued.id,
                    deviceID: deviceID,
                    for: accountID
                )
                try await run(task)
            } catch is CancellationError {
                return
            } catch {
                // The queue endpoint is a bounded long poll. A transient bearer
                // refresh or connection loss should retry, but never hot-loop.
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func run(_ task: NativeCodeAgentTask) async throws {
        do {
            let sessionID = try await executor.start(task)
            activeSessionID = sessionID
            defer { activeSessionID = nil }

            var localSequence = 0
            var controlSequence = 0
            var lastStatus: String?
            while !Task.isCancelled {
                let snapshot = try await executor.snapshot(
                    sessionID: sessionID,
                    after: localSequence
                )
                if let last = snapshot.events.last { localSequence = last.sequence }
                let status = Self.taskStatus(snapshot.status)
                var outbound = snapshot.events.compactMap(Self.remoteEvent)
                if status != lastStatus {
                    outbound.insert(
                        NativeCodeTaskEventInput(
                            kind: "status",
                            payload: ["status": .string(status)]
                        ),
                        at: 0
                    )
                    lastStatus = status
                }
                if snapshot.status == .completed,
                    !outbound.contains(where: { $0.kind == "done" })
                {
                    outbound.append(
                        NativeCodeTaskEventInput(
                            kind: "done",
                            payload: ["summary": .string("Completed on this Mac.")]
                        )
                    )
                }
                let ack = try await client.append(
                    taskID: task.id,
                    events: outbound,
                    status: status,
                    afterControlSequence: controlSequence,
                    for: accountID
                )
                for control in ack.control {
                    controlSequence = max(controlSequence, control.seq)
                    try await apply(
                        control,
                        sessionID: sessionID
                    )
                }
                if snapshot.status.isTerminal { return }
                try await Task.sleep(for: .milliseconds(650))
            }
        } catch {
            let message = error.localizedDescription
            _ = try? await client.append(
                taskID: task.id,
                events: [
                    NativeCodeTaskEventInput(
                        kind: "error",
                        payload: ["message": .string(message)]
                    ),
                ],
                status: "failed",
                for: accountID
            )
            throw error
        }
    }

    private func apply(_ control: NativeCodeControlEvent, sessionID: String) async throws {
        switch control.kind {
        case "approval_response":
            guard let requestID = control.payload["requestId"]?.stringValue else { return }
            try await executor.resolveApproval(
                sessionID: sessionID,
                requestID: requestID,
                approve: control.payload["approve"]?.boolValue ?? false
            )
        case "cancel_request":
            await executor.stop(sessionID: sessionID)
        default:
            // Rollback controls are not advertised by this host yet. The web
            // and iOS surfaces therefore do not offer controls this runtime
            // cannot acknowledge truthfully.
            break
        }
    }

    private static func taskStatus(_ status: SessionStatus) -> String {
        switch status {
        case .waitingForApproval: "awaiting_approval"
        case .completed: "done"
        case .failed: "failed"
        case .cancelled: "cancelled"
        case .idle, .planning, .running, .waitingForProvider, .degraded, .stopping:
            "running"
        }
    }

    private static func remoteEvent(_ event: SessionEvent) -> NativeCodeTaskEventInput? {
        switch event.payload {
        case .sessionCreated, .turnConfiguration:
            nil
        case .userPrompt(let prompt):
            .init(kind: "user", payload: ["text": .string(prompt.text)])
        case .userInstruction(let instruction):
            .init(
                kind: "user",
                payload: [
                    "text": .string(instruction.text),
                    "delivery": .string(instruction.kind.rawValue),
                ]
            )
        case .userInstructionApplied:
            nil
        case .assistantMessage(let message):
            .init(kind: "text", payload: ["text": .string(message.text)])
        case .reasoningSummary(let reasoning):
            .init(
                kind: "tool",
                payload: [
                    "name": .string("Reasoning"),
                    "summary": .string(reasoning.summary),
                ]
            )
        case .toolProposed(let tool):
            .init(
                kind: "tool",
                payload: [
                    "name": .string(tool.toolName),
                    "summary": .string(tool.summary),
                    "detail": .string(tool.risk.rawValue),
                ]
            )
        case .toolStarted(let tool):
            .init(
                kind: "status",
                payload: ["status": .string("Running \(tool.toolCallID)")]
            )
        case .toolOutput(let output):
            .init(
                kind: "tool",
                payload: [
                    "name": .string(output.channel.rawValue),
                    "summary": .string(output.text),
                ]
            )
        case .toolCompleted(let tool):
            .init(
                kind: "tool",
                payload: [
                    "name": .string(tool.status.rawValue),
                    "summary": .string(tool.resultSummary),
                ]
            )
        case .approvalRequested(let approval):
            .init(
                kind: "approval_request",
                payload: [
                    "requestId": .string(approval.id),
                    "summary": .string(approval.summary),
                    "risk": .string(approval.risk.rawValue),
                    "detail": .string(approval.toolName),
                ]
            )
        case .approvalResolved(let approval):
            .init(
                kind: "approval_response",
                payload: [
                    "requestId": .string(approval.approvalID),
                    "approve": .bool(approval.decision == .approved),
                ]
            )
        case .fileChanged(let file):
            .init(
                kind: "file_change",
                payload: [
                    "path": .string(file.path.value),
                    "changeKind": .string(file.kind.rawValue),
                    "added": .number(Double(file.linesAdded)),
                    "removed": .number(Double(file.linesRemoved)),
                ]
            )
        case .testRunCompleted(let test):
            .init(
                kind: "tool",
                payload: [
                    "name": .string("Tests"),
                    "summary": .string(test.passed ? "Tests passed" : "Tests failed"),
                    "detail": .string(test.command),
                ]
            )
        case .subagentUpdated(let update):
            .init(
                kind: "agent",
                payload: [
                    "agent": .object([
                        "id": .string(update.agentID),
                        "title": .string(update.title),
                        "status": .string(update.status.rawValue),
                        "activity": .string(update.currentActivity),
                    ]),
                ]
            )
        case .goalUpdated(let goal):
            .init(
                kind: "status",
                payload: ["status": .string(goal.goal.objective)]
            )
        case .statusChanged(let status):
            .init(
                kind: "status",
                payload: ["status": .string(taskStatus(status.status))]
            )
        case .errorOccurred(let error):
            .init(kind: "error", payload: ["message": .string(error.message)])
        case .runCompleted(let run):
            .init(
                kind: "done",
                payload: [
                    "summary": .string(run.summary),
                    "filesChanged": .number(Double(run.filesChanged)),
                ]
            )
        }
    }
}

private extension NativeJSONValue {
    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }
}

/// Announces this Mac to Juno Code as a computer that is signed in — and keeps
/// announcing it, because being listed is a heartbeat and not an event.
///
/// Until this existed, no Swift code anywhere registered the Mac. `GET
/// /api/code/devices` returned an empty list, so the iPhone said "No computers
/// signed in" while JunoDesktop sat open and signed in beside it. The row is
/// created by `POST /api/code/devices`, which writes `lastSeenAt` on every post,
/// and the list route calls a device online only while that timestamp is inside
/// a two-minute window (`ONLINE_WINDOW_MS`, `src/lib/code-remote.ts`). A single
/// registration at launch therefore buys two minutes of visibility and then
/// silently expires — which is why this beats every sixty seconds rather than
/// registering once. The Windows client
/// (`juno-windows/src/lib/code/remoteHost.ts`) is the working reference and uses
/// the same interval and the same persisted-id key.
///
/// **Presence and capability are separate, and the difference is
/// load-bearing.** Registering says this Mac is signed in; ``servesQueuedTasks``
/// says whether it will actually claim and run work sent to it. They were once
/// the same thing by omission — the phone read presence as capability, so a
/// dispatched task sat `queued` forever because nothing here claimed it.
///
/// ``CodeRemoteHost`` is the loop that claims, and it runs only while the
/// switch is on. It is off by default and changed only at this machine: a Mac
/// that began executing instructions from elsewhere the moment someone signed
/// in would be a genuinely dangerous default, because signing in is not consent
/// to hand a phone the shell.
@MainActor
@Observable
final class DesktopCodeHostModel {
    enum Phase: Equatable, Sendable {
        case idle
        /// The first registration of this sign-in has not landed yet.
        case registering
        /// The server has this Mac, and will keep calling it online for as long
        /// as the beats keep arriving.
        case listed
        /// The last registration was refused or could not be sent. The beat
        /// continues; ``lastError`` says what happened.
        case failed
    }

    private(set) var phase: Phase = .idle
    /// The server's own id for this Mac's row, once it has one.
    private(set) var deviceID: String?
    /// When the last registration succeeded. A settings row showing "last seen"
    /// needs this to distinguish "listed" from "listed an hour ago".
    private(set) var lastRegisteredAt: Date?
    private(set) var lastError: String?

    /// The folders this Mac tells the account it can work in.
    ///
    /// Kept in sync by the root view rather than snapshotted at start, because
    /// the workbench loads its grants asynchronously well after sign-in: a copy
    /// taken when the beat starts is always empty, and an empty list is what
    /// makes the phone show this Mac with nothing to run in.
    private(set) var workspaces: [NativeCodeDevice.Workspace] = []

    /// Whether a task dispatched at this Mac would actually be picked up. It
    /// would not — see the note at the top of this file. Stated as a value so
    /// the surface that eventually shows hosting can read the truth from the
    /// model instead of hard-coding a sentence that will rot when this changes.
    /// The claim/execute loop, alive only while hosting is switched on.
    private var remoteHost: CodeRemoteHost?
    /// The task queue used by the iOS Code surface. This is intentionally a
    /// separate protocol from session commands; the server persists these runs
    /// as Code tasks and the phone observes their event stream.
    private var queuedHost: DesktopQueuedCodeHost?
    /// Supplies the executor once the app has a workbench to run against.
    /// Nil until then, which is why hosting cannot start before it is set.
    var remoteExecutorProvider: (@MainActor () -> (any CodeRemoteCommandExecuting)?)?
    private var queuedExecutor: DesktopQueuedCodeExecutor?

    /// Whether this Mac will claim and execute queued remote work.
    ///
    /// Off by default and only ever changed by the person at the machine. A Mac
    /// that began accepting instructions from elsewhere the moment someone
    /// signed in would be a genuinely dangerous default — signing in is not
    /// consent to hand a phone the shell.
    ///
    /// Persisted, because the switch is a standing decision about this machine
    /// rather than a per-launch one, and it is read back on the next launch.
    var servesQueuedTasks: Bool {
        get { defaults.bool(forKey: Self.servesQueuedTasksKey) }
        set {
            defaults.set(newValue, forKey: Self.servesQueuedTasksKey)
            syncRemoteHost()
            // Re-register immediately rather than waiting for the next
            // heartbeat: until the relay knows, the phone still shows this Mac
            // as unavailable (or, worse, as available after it was switched
            // off) for up to a minute.
            Task { await self.register() }
        }
    }

    static let servesQueuedTasksKey = "juno.code.remote.servesQueuedTasks"

    /// The immediate kill switch. Stops serving and tells the relay in one step,
    /// so "off" means off now rather than off at the next heartbeat.
    func stopServingRemoteWork() {
        servesQueuedTasks = false
    }

    /// Starts or stops the claim loop to match the switch.
    ///
    /// Called from the switch, from sign-in and from sign-out, so there is one
    /// place that decides whether this Mac is listening — rather than three
    /// that can disagree, which is how a Mac ends up still serving after the
    /// account it was serving for signed out.
    private func syncRemoteHost() {
        let shouldServe = servesQueuedTasks && accountID != nil && deviceID != nil
        if shouldServe, remoteHost == nil {
            guard let accountID, let deviceID, let relay,
                let executor = remoteExecutorProvider?()
            else { return }
            let host = CodeRemoteHost(
                deviceID: deviceID,
                accountID: accountID,
                relay: relay,
                executor: executor
            )
            remoteHost = host
            Task { await host.activate() }
        } else if !shouldServe, let host = remoteHost {
            remoteHost = nil
            // Cancels an in-flight command rather than letting it acknowledge
            // against an account that may no longer be signed in.
            Task { await host.deactivate(reason: "Remote hosting was switched off") }
        }
        if shouldServe, queuedHost == nil {
            guard let accountID, let deviceID, let agentClient, let queuedExecutor else {
                return
            }
            let host = DesktopQueuedCodeHost(
                deviceID: deviceID,
                accountID: accountID,
                client: agentClient,
                executor: queuedExecutor
            )
            queuedHost = host
            Task { await host.activate() }
        } else if !shouldServe, let host = queuedHost {
            queuedHost = nil
            Task { await host.deactivate() }
        }
    }

    /// Matches the Windows client's `DEVICE_ID_KEY` so the two hosts describe
    /// the same idea with the same name.
    private static let deviceIDKey = "juno.code.deviceId"
    private static let heartbeatInterval = Duration.seconds(60)

    private let client: NativeCodeTaskClient
    /// The relay transport for the claim loop. Separate from `client`, which
    /// only registers — keeping them apart means presence still works on a
    /// build where hosting is unavailable.
    private let relay: (any CodeRemoteRelaying)?
    private let agentClient: NativeCodeAgentClient?
    private let defaults: UserDefaults
    /// Resolved once rather than per beat: `Host.current()` consults the system
    /// configuration store, and the beat runs on the main actor. A Mac renamed
    /// while Juno is open therefore keeps its old label until the next launch —
    /// at which point the replayed device id updates the existing row instead of
    /// stranding the old name as a second, permanently offline computer.
    private let deviceName: String
    private let appVersion: String

    private var accountID: AccountID?
    private var beat: Task<Void, Never>?
    private var isRegistering = false
    /// Set when a workspace change arrives while a registration is in flight, so
    /// the change is folded into the next post instead of being dropped and
    /// waiting a full minute for the following beat.
    private var needsAnotherRegistration = false

    init(
        client: NativeCodeTaskClient,
        relay: (any CodeRemoteRelaying)? = nil,
        agentClient: NativeCodeAgentClient? = nil,
        defaults: UserDefaults = .standard
    ) {
        self.client = client
        self.relay = relay
        self.agentClient = agentClient
        self.defaults = defaults
        // Read exactly as `JunoDesktopConfiguration` reads them, so the computer
        // named in the phone's picker is the computer named everywhere else.
        deviceName = Host.current().localizedName ?? "Mac"
        appVersion = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "0.1.0"
    }

    /// Connects both remote protocols to the authenticated account's real
    /// Workbench. Called after bootstrap composition and cleared before sign-out.
    func connect(workbench: WorkbenchModel) {
        let bridge = WorkbenchRemoteBridge(
            model: workbench,
            sharedWorkspaceIDs: {
                Set(workbench.workspaces.map { $0.id.value })
            },
            defaultModelID: {
                workbench.availableModels.first?.modelID
                    ?? "anthropic:claude-sonnet-5"
            }
        )
        let targetID = ExecutionTargetID(value: "desktop-local-host")
        let target = ExecutionTarget(
            id: targetID,
            kind: .local,
            displayName: "This Mac",
            hostID: targetID.value,
            capabilities: [.workspaceAccess, .shell, .git, .worktrees, .tests, .devServers,
                           .previews, .screenshots, .computerUse, .subagents, .approvals, .sessionResume],
            connectionState: .online,
            supportedModelIDs: workbench.availableModels.map(\.modelID),
            protocolVersion: .current
        )
        let runtimeHost = RuntimeCodeHost(
            targets: { [target] },
            sessions: { await bridge.protocolSessions(defaultTargetID: targetID) },
            events: { cursor in await bridge.protocolEvents(after: cursor) },
            execute: { command in
                try await RemoteCommandAdapter(bridge: bridge).execute(command)
            }
        )
        remoteExecutorProvider = {
            // The relay still delivers its deployed DTO while clients roll
            // forward, but execution now crosses the canonical command
            // envelope before reaching the existing permission-authoritative
            // runtime adapter.
            CanonicalRelayHostExecutor(host: runtimeHost, targetID: targetID)
        }
        queuedExecutor = DesktopQueuedCodeExecutor(workbench: workbench)
        syncRemoteHost()
    }

    func disconnectWorkbench() {
        remoteExecutorProvider = nil
        queuedExecutor = nil
        syncRemoteHost()
    }

    /// Registers immediately, then once a minute until ``stop()``.
    func start(for accountID: AccountID) {
        guard self.accountID != accountID else { return }
        stop()
        self.accountID = accountID
        // Replayed on every post from here on. Without it the route falls back
        // to matching on `(user, name)`, so a rename would leave the old row
        // behind as a computer that is listed, never beats again, and can never
        // be selected.
        deviceID = defaults.string(forKey: Self.deviceIDKey)
        phase = .registering
        beat = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await register()
                guard !Task.isCancelled else { return }
                try? await Task.sleep(for: Self.heartbeatInterval)
            }
        }
    }

    /// Stops beating. There is no route that retires a device, and there does
    /// not need to be: the row simply stops being refreshed, and the list calls
    /// it offline two minutes later. The persisted id deliberately survives, so
    /// signing back in updates this Mac's own row rather than creating another.
    func stop() {
        beat?.cancel()
        beat = nil
        // Before the account is cleared: the loop must be told to stop while
        // it still knows which account it was serving.
        if let host = remoteHost {
            remoteHost = nil
            Task { await host.deactivate(reason: "Signed out") }
        }
        if let host = queuedHost {
            queuedHost = nil
            Task { await host.deactivate() }
        }
        accountID = nil
        deviceID = nil
        workspaces = []
        lastRegisteredAt = nil
        lastError = nil
        isRegistering = false
        needsAnotherRegistration = false
        phase = .idle
    }

    /// Adopts the workbench's granted folders as the set this Mac advertises.
    ///
    /// A change registers straight away instead of waiting for the next beat.
    /// The workbench's `bootstrap()` loads its grants after the view exists, so
    /// the first beat of a sign-in almost always carries none; a minute of the
    /// phone listing this Mac with nothing to run in reads as the Mac being
    /// useless rather than as the app being early.
    func setWorkspaces(from records: [WorkspaceRecord]) {
        let advertisable = records.compactMap(Self.advertisable)
        guard advertisable != workspaces else { return }
        workspaces = advertisable
        guard accountID != nil else { return }
        Task { await register() }
    }

    // MARK: Internals

    private func register() async {
        guard let accountID else { return }
        guard !isRegistering else {
            needsAnotherRegistration = true
            return
        }
        isRegistering = true
        defer { isRegistering = false }
        repeat {
            needsAnotherRegistration = false
            do {
                let id = try await client.registerDevice(
                    deviceID: deviceID,
                    name: deviceName,
                    platform: "macos",
                    appVersion: appVersion,
                    // Zero and zero, not the local session counts: these describe
                    // the *remote* work this host is carrying, and it carries
                    // none. Reporting local sessions here would put a badge on
                    // the phone for work the phone never sent.
                    workspaces: workspaces,
                    sessionCount: 0,
                    activeCount: 0,
                    // The value the rest of the product now reads instead of
                    // inferring capability from presence.
                    servesQueuedTasks: servesQueuedTasks,
                    for: accountID
                )
                guard self.accountID == accountID else { return }
                // The device id only exists after the first registration, so
                // this is the earliest the loop can be started.
                deviceID = id
                defaults.set(id, forKey: Self.deviceIDKey)
                self.syncRemoteHost()
                lastRegisteredAt = Date()
                lastError = nil
                phase = .listed
            } catch {
                guard self.accountID == accountID else { return }
                // Left readable and left beating. A refusal now is very often a
                // token that is about to be refreshed or a network that is about
                // to come back, and the next beat is a minute away — which is
                // both the retry and the reason no backoff is needed here.
                lastError = NativeFailureMessage.presentable(error)
                phase = .failed
            }
        } while needsAnotherRegistration && !Task.isCancelled
    }

    /// One granted folder, as the account should see it — or nothing, when the
    /// grant no longer resolves.
    ///
    /// The filter is the point. A workspace whose bookmark has lapsed still sits
    /// in the directory with a perfectly plausible name and path, so advertising
    /// it puts a folder in the phone's picker that this Mac cannot actually
    /// open: the task would be dispatched, arrive, and fail on a permission the
    /// reader was never asked for. Failing to *offer* it is a smaller lie than
    /// offering it and failing.
    ///
    /// The path does leave the Mac, and `WorkspaceDescriptor.localPathHint` says
    /// it should not — that comment predates remote dispatch. It is required
    /// now: `POST /api/code/tasks` 400s without `workspacePath`, and the picker
    /// has to name the folder for the reader to choose between two. It travels
    /// on the account's own authenticated request, into the account's own row.
    private static func advertisable(_ record: WorkspaceRecord) -> NativeCodeDevice.Workspace? {
        guard resolves(record.bookmarkData) else { return nil }
        return NativeCodeDevice.Workspace(
            name: record.descriptor.displayName,
            path: record.descriptor.localPathHint,
            // The stable identity, so the phone's choice survives the folder
            // being moved or renamed — the path will not.
            key: record.descriptor.id.value
        )
    }

    /// Whether bookmark data still names a real directory.
    ///
    /// Deliberately *not* `WorkspaceAccess(workspaceID:bookmarkData:)`, which is
    /// what a task does on arrival: that starts a security scope this would then
    /// have to balance, and it opens the folder for real on every beat. The
    /// resolution rules are copied from it — scoped first, plain as the
    /// fallback, staleness tolerated — because a check that is stricter than the
    /// open it predicts would hide folders that work.
    private static func resolves(_ bookmarkData: Data) -> Bool {
        var isStale = false
        var resolved = try? URL(
            resolvingBookmarkData: bookmarkData,
            options: [.withSecurityScope],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )
        if resolved == nil {
            resolved = try? URL(
                resolvingBookmarkData: bookmarkData,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
        }
        guard let resolved else { return false }
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(
            atPath: resolved.path, isDirectory: &isDirectory
        )
        return exists && isDirectory.boolValue
    }
}
