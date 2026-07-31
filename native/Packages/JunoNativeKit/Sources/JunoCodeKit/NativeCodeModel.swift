import Foundation
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// Drives the Code screen: the session list, the "where does this run" picker,
/// and the live log of whichever session is open.
@MainActor
@Observable
public final class NativeCodeModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed
    }

    /// How the repository list stands. Two of these are dead ends a retry cannot
    /// fix, so the screen must be able to tell them apart from a transient one.
    public enum RepositoryState: Equatable, Sendable {
        case idle
        case loading
        case ready([NativeCodeRepository])
        case unavailable(NativeCodeRepositoryFailure)
    }

    public private(set) var phase: Phase = .idle
    public private(set) var tasks: [NativeCodeTask] = []
    public private(set) var devices: [NativeCodeDevice] = []
    public private(set) var repositories: RepositoryState = .idle
    public private(set) var isMutating = false
    public private(set) var lastErrorDescription: String?

    /// The open session's log.
    public private(set) var openTask: NativeCodeTask?
    public private(set) var events: [NativeCodeEvent] = []
    public private(set) var pendingApproval: NativeCodeApproval?
    public private(set) var isStreaming = false

    /// The composer's target. Persisted so the reader's last choice survives a
    /// relaunch — picking "Cloud" every session because the app forgot is the
    /// kind of small friction that makes a feature feel unfinished.
    public var target: NativeCodeTarget {
        didSet {
            guard target != oldValue else { return }
            UserDefaults.standard.set(target.rawValue, forKey: Self.targetKey)
            if target == .cloud, !isTargetless { loadRepositoriesIfNeeded() }
        }
    }

    public var selectedRepository: NativeCodeRepository?
    public var selectedDeviceID: String?
    public var selectedWorkspaceKey: String?

    /// Whether the composer is deliberately aimed at nothing.
    ///
    /// An explicit mode rather than "no repository happens to be selected",
    /// because the two are not the same state and the difference is what makes
    /// the feature survive a pull-to-refresh: `refresh()` auto-selects a device
    /// and `loadRepositoriesIfNeeded` auto-selects a repository, so an implicit
    /// "nothing chosen" is silently converted back into a cloud target the next
    /// time either runs.
    ///
    /// Persisted alongside the target for the same reason the target is: a
    /// reader who chose No Project should not be put back on Cloud by
    /// relaunching.
    public var isTargetless: Bool {
        didSet {
            guard isTargetless != oldValue else { return }
            UserDefaults.standard.set(isTargetless, forKey: Self.targetlessKey)
            if !isTargetless, target == .cloud { loadRepositoriesIfNeeded() }
        }
    }

    private static let targetKey = "juno.mobile.code.target"
    private static let targetlessKey = "juno.mobile.code.no-project"

    /// How often the session and computer lists are re-read.
    ///
    /// Thirty seconds because the device list is a *heartbeat* view and not a
    /// pushed one: `/api/code/devices` calls a computer online only while its
    /// last beat is inside a two-minute window, and hosts beat every sixty
    /// seconds. Polling at the hosts' own cadence would put a Mac on this list
    /// up to two beats after it signed in; polling at half of it means one.
    private static let pollInterval = Duration.seconds(30)

    /// Where the backoff stops. Long enough that a phone with no signal costs
    /// almost nothing, short enough that coming back into coverage is noticed
    /// without the reader having to do anything.
    private static let maximumPollInterval = Duration.seconds(300)

    private let client: NativeCodeTaskClient
    private var accountID: AccountID?
    private var streamTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    /// Whether the last `refresh()` reached the server at all. Distinct from
    /// `lastErrorDescription`, which a failed dispatch or a failed cancel also
    /// writes to — backing the poll off because a *task* was refused would be
    /// reacting to the wrong fact.
    private var lastRefreshReachedNothing = false

    public init(client: NativeCodeTaskClient) {
        self.client = client
        let stored = UserDefaults.standard.string(forKey: Self.targetKey)
        target = stored.flatMap(NativeCodeTarget.init(rawValue:)) ?? .cloud
        isTargetless = UserDefaults.standard.bool(forKey: Self.targetlessKey)
    }

    public var selectedDevice: NativeCodeDevice? {
        devices.first { $0.id == selectedDeviceID }
    }

    public var selectedWorkspace: NativeCodeDevice.Workspace? {
        guard let selectedDevice else { return nil }
        if let selectedWorkspaceKey,
            let match = selectedDevice.workspaces.first(where: { $0.id == selectedWorkspaceKey }) {
            return match
        }
        return selectedDevice.workspaces.first
    }

    /// Whether the composer can dispatch right now, and why not when it cannot.
    ///
    /// A conversation with no project is never blocked: there is no repository
    /// to pick, no computer to be offline, and no GitHub connector to have
    /// lapsed. Short-circuiting above the switch rather than patching each arm
    /// is deliberate — every one of the six reasons below is a fact about a
    /// target, and this mode has none.
    public var startBlockedReason: String? {
        if isTargetless { return nil }
        switch target {
        case .cloud:
            if case .unavailable(let failure) = repositories {
                return NativeCodeError.repositories(failure).localizedDescription
            }
            if selectedRepository == nil { return String(localized: "code.blocked.pick-repo") }
        case .device:
            if devices.isEmpty { return String(localized: "code.blocked.no-devices") }
            guard let device = selectedDevice else {
                return String(localized: "code.blocked.pick-device")
            }
            if !device.online { return String(localized: "code.blocked.device-offline") }
            if selectedWorkspace == nil { return String(localized: "code.blocked.no-workspace") }
        }
        return nil
    }

    public func start(for accountID: AccountID) async {
        guard self.accountID != accountID else {
            await refresh()
            return
        }
        stop()
        self.accountID = accountID
        phase = .loading
        await refresh()
        startPolling(for: accountID)
    }

    /// Keeps both lists current for as long as the account is signed in.
    ///
    /// Without this the screen shows whatever it read at sign-in — `pollTask`
    /// was declared and cancelled but never assigned — so a reader who opened
    /// Juno before opening their Mac was told "No computers signed in" until
    /// they thought to pull down. Nothing pushes a device's arrival to the
    /// phone, so the app was reporting a two-minute-old fact as a current one.
    ///
    /// **A backoff rather than a visibility gate.** This model is started at
    /// sign-in and stopped at sign-out; it is never told whether the Code screen
    /// is on screen, so any gate written here would be a guess dressed as a
    /// fact. What it can honestly do is stop asking a server that is not
    /// answering: every refresh that reaches nothing doubles the wait to a
    /// five-minute ceiling, and the first success drops straight back to thirty
    /// seconds. A phone in a tunnel then spends a dozen requests an hour on this
    /// rather than a hundred and twenty.
    private func startPolling(for accountID: AccountID) {
        pollTask = Task { [weak self] in
            var interval = Self.pollInterval
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self, self.accountID == accountID else { return }
                await refresh()
                guard !Task.isCancelled, self.accountID == accountID else { return }
                interval = lastRefreshReachedNothing
                    ? min(interval * 2, Self.maximumPollInterval)
                    : Self.pollInterval
            }
        }
    }

    public func stop() {
        streamTask?.cancel()
        pollTask?.cancel()
        streamTask = nil
        pollTask = nil
        accountID = nil
        tasks = []
        devices = []
        repositories = .idle
        openTask = nil
        events = []
        pendingApproval = nil
        isStreaming = false
        selectedRepository = nil
        selectedDeviceID = nil
        selectedWorkspaceKey = nil
        lastErrorDescription = nil
        lastRefreshReachedNothing = false
        phase = .idle
    }

    public func refresh() async {
        guard let accountID else { return }
        // The two reads are independent: a device list that fails must not take
        // the session list — the part that always works — down with it.
        async let taskList = try? client.tasks(limit: 40, for: accountID)
        async let deviceList = try? client.devices(for: accountID)
        let (loadedTasks, loadedDevices) = await (taskList, deviceList)
        guard self.accountID == accountID else { return }

        if let loadedTasks { tasks = loadedTasks }
        if let loadedDevices {
            devices = loadedDevices
            if selectedDeviceID == nil || !devices.contains(where: { $0.id == selectedDeviceID }) {
                selectedDeviceID = devices.first(where: \.online)?.id ?? devices.first?.id
            }
        }
        lastRefreshReachedNothing = loadedTasks == nil && loadedDevices == nil
        if lastRefreshReachedNothing {
            lastErrorDescription = String(localized: "code.error.unreachable")
            phase = tasks.isEmpty ? .failed : .ready
        } else {
            lastErrorDescription = nil
            phase = .ready
        }
        if target == .cloud, !isTargetless { loadRepositoriesIfNeeded() }
    }

    public func loadRepositoriesIfNeeded(force: Bool = false) {
        guard let accountID else { return }
        if !force, case .ready = repositories { return }
        if case .loading = repositories, !force { return }
        repositories = .loading
        Task { [weak self] in
            guard let self else { return }
            do {
                let repos = try await client.repositories(for: accountID)
                guard self.accountID == accountID else { return }
                repositories = .ready(repos)
                // Never while the reader has chosen No Project: this line runs
                // after every refresh, and silently adopting a repository would
                // take the mode away from them without a gesture.
                if selectedRepository == nil, !isTargetless { selectedRepository = repos.first }
            } catch NativeCodeError.repositories(let failure) {
                guard self.accountID == accountID else { return }
                repositories = .unavailable(failure)
            } catch {
                guard self.accountID == accountID else { return }
                repositories = .unavailable(.unreachable)
            }
        }
    }

    /// Dispatches the composed prompt to the selected target and opens the
    /// resulting session.
    @discardableResult
    public func startTask(prompt: String) async -> NativeCodeTask? {
        guard let accountID, !isTargetless, startBlockedReason == nil else { return nil }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let task: NativeCodeTask
            switch target {
            case .cloud:
                guard let repository = selectedRepository else { return nil }
                task = try await client.createCloudTask(
                    prompt: trimmed,
                    repository: repository,
                    baseRef: repository.defaultBranch,
                    for: accountID
                )
            case .device:
                guard let device = selectedDevice, let workspace = selectedWorkspace else {
                    return nil
                }
                task = try await client.createDeviceTask(
                    prompt: trimmed, device: device, workspace: workspace, for: accountID
                )
            }
            guard self.accountID == accountID else { return nil }
            tasks.insert(task, at: 0)
            lastErrorDescription = nil
            open(task)
            return task
        } catch {
            guard self.accountID == accountID else { return nil }
            lastErrorDescription = NativeFailureMessage.presentable(error)
            return nil
        }
    }

    /// Opens a session and starts following its log.
    public func open(_ task: NativeCodeTask) {
        guard openTask?.id != task.id || streamTask == nil else { return }
        closeStream()
        openTask = task
        events = []
        pendingApproval = nil
        follow(taskID: task.id, afterSeq: 0)
    }

    public func closeOpenTask() {
        closeStream()
        openTask = nil
        events = []
        pendingApproval = nil
    }

    public func cancelOpenTask() async {
        guard let accountID, let openTask else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            let updated = try await client.cancel(id: openTask.id, for: accountID)
            guard self.accountID == accountID else { return }
            apply(updated)
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    public func respondToApproval(approve: Bool) async {
        guard let accountID, let openTask, let approval = pendingApproval else { return }
        // Cleared optimistically: the agent is blocked on this answer, and a card
        // that stays on screen after the tap reads as the tap not landing.
        pendingApproval = nil
        do {
            try await client.respond(
                id: openTask.id,
                requestID: approval.requestID,
                approve: approve,
                for: accountID
            )
        } catch {
            guard self.accountID == accountID else { return }
            pendingApproval = approval
            lastErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    // MARK: Streaming

    /// Follows a task's log, reconnecting from the last sequence seen.
    ///
    /// The stream is *designed* to end: the server closes it after a four-minute
    /// window so proxies never hold it open forever. So a clean finish on a task
    /// that is still running means reconnect, not fail — and the cursor makes
    /// that reconnect lossless.
    private func follow(taskID: String, afterSeq: Int) {
        guard let accountID else { return }
        isStreaming = true
        streamTask = Task { [weak self] in
            guard let self else { return }
            var cursor = afterSeq
            var attempt = 0
            while !Task.isCancelled, self.accountID == accountID, openTask?.id == taskID {
                do {
                    let stream = try await client.events(
                        taskID: taskID, afterSeq: cursor, for: accountID
                    )
                    for try await frame in stream {
                        guard !Task.isCancelled, openTask?.id == taskID else { break }
                        attempt = 0
                        switch frame {
                        case .snapshot(let task, let newEvents, let approval),
                            .events(let task, let newEvents, let approval):
                            apply(task)
                            append(newEvents)
                            cursor = max(cursor, newEvents.last?.seq ?? cursor)
                            if let approval { pendingApproval = approval }
                            // An answered request must clear the card even when
                            // the answer came from another client.
                            if newEvents.contains(where: { $0.kind == .approvalResponse }) {
                                pendingApproval = nil
                            }
                        case .done(let task):
                            apply(task)
                            isStreaming = false
                            return
                        }
                    }
                } catch is CancellationError {
                    return
                } catch {
                    attempt += 1
                    guard attempt <= 5 else {
                        lastErrorDescription = NativeFailureMessage.presentable(error)
                        isStreaming = false
                        return
                    }
                }
                if openTask?.status.isTerminal == true {
                    isStreaming = false
                    return
                }
                // A short backoff before reconnecting. Zero would spin against a
                // server that is refusing, and long would make a live run look
                // stalled.
                try? await Task.sleep(for: .milliseconds(attempt == 0 ? 200 : 1_200))
            }
            isStreaming = false
        }
    }

    private func closeStream() {
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false
    }

    private func append(_ incoming: [NativeCodeEvent]) {
        guard !incoming.isEmpty else { return }
        let known = Set(events.map(\.seq))
        events.append(contentsOf: incoming.filter { !known.contains($0.seq) })
        events.sort { $0.seq < $1.seq }
    }

    private func apply(_ task: NativeCodeTask) {
        if openTask?.id == task.id { openTask = task }
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task
        } else {
            tasks.insert(task, at: 0)
        }
    }
}
