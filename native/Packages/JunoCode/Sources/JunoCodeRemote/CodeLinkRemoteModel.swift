import Foundation
import JunoCodeCore
import JunoCodeKit
import JunoCore
import JunoSync
import Observation

/// A Mac this iPhone may drive, and what it said about itself.
public struct CodeLinkMac: Identifiable, Equatable, Sendable {
    public enum Reachability: Equatable, Sendable {
        case unknown
        case online
        case offline(String)
        case notPaired(String)
    }

    public var pair: RemotePair
    public var info: CodeV2.HostInfo?
    public var reachability: Reachability

    public init(pair: RemotePair, info: CodeV2.HostInfo? = nil, reachability: Reachability = .unknown) {
        self.pair = pair
        self.info = info
        self.reachability = reachability
    }

    public var id: String { pair.deviceId }
    public var name: String { info?.name ?? pair.deviceName ?? "Your Mac" }
    public var sharesTerminal: Bool { info?.terminal ?? false }
    public var captures: [CodeV2.RemoteCaptureTarget] { info?.captures ?? [] }

    /// One line under the name, in words.
    public var stateLine: String {
        switch reachability {
        case .unknown: return "Checking in"
        case .online:
            let count = info?.sharedFolders.count ?? 0
            return count == 1 ? "Online, sharing 1 folder" : "Online, sharing \(count) folders"
        case .offline: return "Offline. Open Alevr on it to reach it."
        case .notPaired: return "Not paired with this iPhone"
        }
    }
}

/// Everything the iPhone remote shows and does for paired Macs, over the v2
/// device link (docs/code-v2/REMOTE-CONTROL.md).
@MainActor
@Observable
public final class CodeLinkRemoteModel {
    public enum Phase: Equatable, Sendable { case idle, loading, ready, failed }

    // MARK: Macs

    public internal(set) var phase: Phase = .idle
    public internal(set) var macs: [CodeLinkMac] = []
    public internal(set) var selectedDeviceID: String?
    /// The selected Mac refused this iPhone, or is gone: shown with a way out.
    public internal(set) var linkError: CodeLinkError?

    // MARK: Sessions

    public internal(set) var remote = CodeLinkRemoteState()
    public internal(set) var isLoadingSessions = false
    public internal(set) var openSessionID: String?

    // MARK: Composer

    public internal(set) var providers: [CodeV2.ProviderInstance] = []
    public internal(set) var skills: [CodeV2.LocalSkillSummary] = []
    public var composer = CodeLinkComposerState() {
        didSet { if composer != oldValue, !applyingRemote { composerChanged() } }
    }
    public var draft = "" {
        didSet { if draft != oldValue, !applyingRemote { draftChanged() } }
    }
    public internal(set) var isSending = false

    // MARK: Surfaces

    public internal(set) var threadDiff: [CodeV2DiffFile] = []
    public internal(set) var turnDiff: [CodeV2DiffFile] = []
    public internal(set) var diffCheckpointID: String?
    public internal(set) var isLoadingDiff = false
    public internal(set) var revertingHunk: String?
    public internal(set) var terminalID: String?
    public internal(set) var captures: [CodeV2.RemoteCaptureTarget: CodeV2.HostCapture] = [:]
    public internal(set) var capturing: CodeV2.RemoteCaptureTarget?
    public internal(set) var git: CodeV2.GitStatusResult?
    public internal(set) var gitBusy: String?
    public internal(set) var lastCommit: CodeLinkClient.CommitResult?
    public internal(set) var lastPush: CodeLinkClient.PushResult?
    public internal(set) var pullRequestURL: String?
    public internal(set) var browser: CodeLinkFolderBrowser?
    public internal(set) var isBrowsing = false
    /// The last action's failure, in words.
    public internal(set) var lastError: String?

    // MARK: Plumbing

    @ObservationIgnored private let sender: (any NativeAuthenticatedRequestSending)?
    @ObservationIgnored private var accountID: AccountID?
    @ObservationIgnored private var client: CodeLinkClient?
    @ObservationIgnored private var pollTask: Task<[CodeV2.ServerEventEnvelope], Error>?
    @ObservationIgnored private var reopening = Set<String>()
    @ObservationIgnored private var lastListAt = Date.distantPast
    @ObservationIgnored private var applyingRemote = false
    @ObservationIgnored private var prefsChangedAt: Date?
    @ObservationIgnored private var draftSyncer: ThreadDraftSyncer?
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private let now: @Sendable () -> Date
    /// Device name for the draft echo guard.
    public static let syncDevice = "iphone"

    public init(
        sender: (any NativeAuthenticatedRequestSending)?,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.sender = sender
        self.sleep = sleep
        self.now = now
    }

    // MARK: Lifecycle

    public func start(for accountID: AccountID) {
        guard self.accountID != accountID else { return }
        stop()
        self.accountID = accountID
        if let sender {
            client = CodeLinkClient(sender: sender, accountID: accountID)
            let threads = ThreadSyncClient(sender: sender)
            draftSyncer = ThreadDraftSyncer(device: Self.syncDevice) { key, update in
                try await threads.write(key, update, for: accountID)
            }
        }
    }

    public func stop() {
        pollTask?.cancel()
        accountID = nil
        client = nil
        draftSyncer = nil
        macs = []
        selectedDeviceID = nil
        remote.reset()
        openSessionID = nil
        phase = .idle
        linkError = nil
    }

    public var hasPairedMacs: Bool { !macs.isEmpty }
    public var selectedMac: CodeLinkMac? { macs.first { $0.id == selectedDeviceID } }

    /// The Macs this iPhone may drive, each asked `host.info`.
    public func refreshMacs() async {
        guard let sender, let accountID else { return }
        if macs.isEmpty { phase = .loading }
        do {
            let pairs = try await RemotePairingClient(sender: sender).myPairs(for: accountID)
                .filter { $0.kind == .phone }
            macs = pairs.map { pair in macs.first { $0.id == pair.deviceId }.map { var m = $0; m.pair = pair; return m } ?? CodeLinkMac(pair: pair) }
            phase = .ready
        } catch {
            if macs.isEmpty { phase = .failed }
            lastError = Self.describe(error)
            return
        }
        if selectedDeviceID == nil || !macs.contains(where: { $0.id == selectedDeviceID }) {
            selectedDeviceID = macs.first?.id
        }
        await withTaskGroup(of: Void.self) { group in
            for mac in macs {
                group.addTask { await self.refreshInfo(mac.id) }
            }
        }
    }

    func refreshInfo(_ deviceID: String) async {
        guard let client else { return }
        do {
            let info = try await client.hostInfo(deviceID)
            update(deviceID) { $0.info = info; $0.reachability = .online }
        } catch let error as CodeLinkError {
            update(deviceID) { mac in
                switch error {
                case let .notPaired(message): mac.reachability = .notPaired(message)
                case let .offline(message): mac.reachability = .offline(message)
                default: mac.reachability = .offline(error.errorDescription ?? "")
                }
            }
        } catch {
            update(deviceID) { $0.reachability = .offline(Self.describe(error)) }
        }
    }

    private func update(_ deviceID: String, _ change: (inout CodeLinkMac) -> Void) {
        guard let index = macs.firstIndex(where: { $0.id == deviceID }) else { return }
        change(&macs[index])
    }

    /// Switches Mac: its sessions, models and skills.
    public func select(_ deviceID: String) async {
        if selectedDeviceID != deviceID {
            selectedDeviceID = deviceID
            remote.reset()
            openSessionID = nil
            providers = []
            skills = []
            linkError = nil
            restartPoll()
        }
        await loadSessions()
        await loadComposerSources()
    }

    // MARK: Sessions

    public func loadSessions() async {
        guard let client, let deviceID = selectedDeviceID else { return }
        isLoadingSessions = true
        defer { isLoadingSessions = false }
        do {
            let list = try await client.sessionList(deviceID, limit: 100)
            guard deviceID == selectedDeviceID else { return }
            remote.setSessions(list)
            lastListAt = now()
            linkError = nil
            update(deviceID) { if $0.reachability != .online, $0.info != nil { $0.reachability = .online } }
        } catch {
            note(error, deviceID: deviceID)
        }
    }

    public func loadComposerSources() async {
        guard let client, let deviceID = selectedDeviceID else { return }
        if let instances = try? await client.providerList(deviceID), deviceID == selectedDeviceID {
            providers = instances
            applyingRemote = true
            composer.fillDefault(from: catalogue)
            applyingRemote = false
        }
        if let list = try? await client.skillsList(deviceID, sessionId: openSessionID), deviceID == selectedDeviceID {
            skills = list
        }
    }

    /// The Model menu: provider updates on the global stream win over `provider.list`.
    public var catalogue: [CodeLinkModelGroup] {
        let merged = providers.map { remote.providerUpdates[$0.id] ?? $0 }
            + remote.providerUpdates.values.filter { update in !providers.contains { $0.id == update.id } }
        return CodeLinkComposerState.catalogue(merged)
    }

    public var orderedSessions: [CodeV2.SessionSummary] { remote.orderedSessions }

    public var openThread: CodeV2SessionState? { openSessionID.flatMap { remote.threads[$0] } }
    public var openSnapshot: CodeV2.SessionSnapshot? { openThread?.snapshot }
    public var isRunning: Bool { openSnapshot.map { $0.state == .running || $0.state == .waiting } ?? false }
    public var turns: [CodeV2Turn] {
        guard let snapshot = openSnapshot else { return [] }
        return CodeV2TurnFolding.turns(from: snapshot.items, activeTurnId: snapshot.activeTurnId)
    }
    public var pendingRequests: [CodeV2.TurnItem] { openSnapshot.map { CodeV2TurnFolding.pendingRequests(in: $0.items) } ?? [] }
    public var canSteer: Bool {
        let instance = catalogue.first { $0.instance.id == openSnapshot?.selection.instanceId }?.instance
        return (instance?.capabilities?.steering ?? true) && openSnapshot?.activeTurnId != nil
    }

    /// Opens a session: follow it, `session.open`, and let the link loop stream it.
    public func open(_ sessionID: String) async {
        guard let client, let deviceID = selectedDeviceID else { return }
        let summary = remote.sessions[sessionID] ?? CodeV2.SessionSummary(
            id: sessionID, cwd: "/", state: .idle,
            selection: composer.selection ?? CodeV2.ModelSelection(instanceId: "alevr", model: ""),
            updatedAt: CodeV2Dates.string(now()), lastSequence: 0
        )
        remote.follow(summary)
        openSessionID = sessionID
        threadDiff = []
        turnDiff = []
        git = nil
        pullRequestURL = nil
        lastCommit = nil
        lastPush = nil
        restartPoll()
        do {
            try await client.sessionOpen(deviceID, sessionId: sessionID, cwd: summary.cwd, afterSequence: remote.threads[sessionID]?.cursor)
            lastError = nil
        } catch {
            note(error, deviceID: deviceID)
        }
        await loadThreadPrefs()
        if let list = try? await client.skillsList(deviceID, sessionId: sessionID) { skills = list }
    }

    public func close() {
        if let key = threadKey, let syncer = draftSyncer { Task { await syncer.flush(key) } }
        openSessionID = nil
        draftApplied = ""
        applyingRemote = true
        draft = ""
        applyingRemote = false
        prefsChangedAt = nil
    }

    // MARK: The link loop

    /// Polls for as long as the caller's task lives: immediately again after
    /// each reply (low latency), backing off 1, 2, 4… 15 s after errors, and
    /// stopping for good when the pair is gone.
    public func runLink() async {
        var backoff: Duration = .seconds(1)
        while !Task.isCancelled {
            guard let client, let deviceID = selectedDeviceID else {
                try? await sleep(.milliseconds(500))
                continue
            }
            if now().timeIntervalSince(lastListAt) > 15 { Task { await loadSessions() } }
            let cursors = remote.cursors
            let global = remote.globalCursor
            let task = Task { try await client.poll(deviceID, cursors: cursors, globalCursor: global) }
            pollTask = task
            let result = await task.result
            if Task.isCancelled { return }
            if task.isCancelled { continue } // restarted: new cursors
            guard deviceID == selectedDeviceID else { continue }
            switch result {
            case let .success(events):
                backoff = .seconds(1)
                if linkError != nil { linkError = nil }
                receive(events, deviceID: deviceID)
            case let .failure(error):
                note(error, deviceID: deviceID)
                if case .notPaired? = error as? CodeLinkError { return }
                if case .unpairedMac? = error as? CodeLinkError { return }
                try? await sleep(backoff)
                backoff = min(backoff * 2, .seconds(15))
            }
        }
    }

    /// New cursors: drop the waiting poll so the next one asks for them.
    func restartPoll() {
        pollTask?.cancel()
    }

    func receive(_ events: [CodeV2.ServerEventEnvelope], deviceID: String) {
        guard !events.isEmpty else { return }
        let effects = remote.apply(events, now: now())
        for case let .reopen(sessionId, cwd, afterSequence) in effects where !reopening.contains(sessionId) {
            reopening.insert(sessionId)
            Task {
                defer { reopening.remove(sessionId) }
                _ = try? await client?.sessionOpen(deviceID, sessionId: sessionId, cwd: cwd, afterSequence: afterSequence)
            }
        }
    }

    // MARK: Composer actions

    /// Send: a new turn when idle, queued while one runs.
    public func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let sessionID = openSessionID else { return }
        if isRunning {
            await queue(trimmed)
        } else {
            await perform { client, deviceID in
                guard let params = self.composer.turnStart(sessionId: sessionID, text: trimmed, skills: self.skills) else {
                    throw CodeLinkError.refused(code: .badRequest, message: "Choose a model first.")
                }
                try await client.turnStart(deviceID, params)
            }
        }
        if lastError == nil { await clearedDraft() }
    }

    public func queue(_ text: String) async {
        guard let sessionID = openSessionID else { return }
        await perform { client, deviceID in
            try await client.turnQueue(deviceID, sessionId: sessionID, input: CodeV2.UserInput(text: text, skills: self.composer.activations(from: self.skills)))
        }
        if lastError == nil { await clearedDraft() }
    }

    /// Steers the running turn; queues when the runtime declines or nothing runs.
    public func steer(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let sessionID = openSessionID else { return }
        await perform { client, deviceID in
            let input = CodeV2.UserInput(text: trimmed)
            if let turnID = self.openSnapshot?.activeTurnId,
               try await client.turnSteer(deviceID, sessionId: sessionID, turnId: turnID, input: input) {
                return
            }
            try await client.turnQueue(deviceID, sessionId: sessionID, input: input)
        }
        if lastError == nil { await clearedDraft() }
    }

    public func interrupt() async {
        guard let sessionID = openSessionID else { return }
        await perform { client, deviceID in
            try await client.turnInterrupt(deviceID, sessionId: sessionID, turnId: self.openSnapshot?.activeTurnId)
        }
    }

    public func respond(to requestID: String, decision: CodeV2.ApprovalDecision, sessionID: String? = nil) async {
        guard let sessionID = sessionID ?? openSessionID else { return }
        await perform { client, deviceID in
            try await client.approvalRespond(deviceID, sessionId: sessionID, requestId: requestID, decision: decision)
        }
    }

    public func answer(_ requestID: String, answers: [String: [String]]) async {
        guard let sessionID = openSessionID else { return }
        await perform { client, deviceID in
            try await client.approvalRespond(deviceID, sessionId: sessionID, requestId: requestID, decision: .accept, answers: answers)
        }
    }

    // MARK: Changes

    /// The whole thread (`checkpointID` nil) or one turn.
    public func loadDiff(checkpointID: String? = nil) async {
        guard let sessionID = openSessionID else { return }
        isLoadingDiff = true
        defer { isLoadingDiff = false }
        await perform { client, deviceID in
            let result = try await client.checkpointDiff(deviceID, sessionId: sessionID, checkpointId: checkpointID)
            let files = CodeV2UnifiedDiff.parse(result.diff)
            self.diffCheckpointID = checkpointID
            if checkpointID == nil { self.threadDiff = files } else { self.turnDiff = files }
        }
    }

    /// Reverts one hunk on the Mac: checked first, then applied in reverse.
    @discardableResult
    public func revert(_ hunk: DiffHunk, in file: CodeV2DiffFile) async -> Bool {
        guard let sessionID = openSessionID else { return false }
        revertingHunk = hunk.reviewIdentifier
        defer { revertingHunk = nil }
        let patch = CodeLinkHunkRevert.patch(for: hunk, in: file)
        await perform { client, deviceID in
            try await client.checkpointApplyPatch(deviceID, sessionId: sessionID, patch: patch, reverse: true, checkOnly: true)
            try await client.checkpointApplyPatch(deviceID, sessionId: sessionID, patch: patch, reverse: true)
            self.threadDiff = CodeLinkHunkRevert.removing(hunk, from: self.threadDiff, path: file.path)
            self.turnDiff = CodeLinkHunkRevert.removing(hunk, from: self.turnDiff, path: file.path)
        }
        return lastError == nil
    }

    // MARK: Terminal

    public var terminalText: String { terminalID.flatMap { remote.terminals[$0]?.text } ?? "" }
    public var terminalExited: Bool { terminalID.map { remote.exitedTerminals[$0] != nil } ?? false }

    /// A shell in the session's folder, when the Mac shares its terminal.
    public func openTerminal(cols: Int = 60, rows: Int = 30) async {
        guard selectedMac?.sharesTerminal == true, let cwd = openSnapshot?.cwd else { return }
        await perform { client, deviceID in
            let id = try await client.terminalOpen(deviceID, cwd: cwd, cols: cols, rows: rows)
            self.terminalID = id
            self.remote.openedTerminal(id)
        }
    }

    public func writeTerminal(_ text: String) async {
        guard let terminalID else { return }
        await perform { client, deviceID in
            try await client.terminalWrite(deviceID, terminalId: terminalID, data: text)
        }
    }

    public func resizeTerminal(cols: Int, rows: Int) async {
        guard let terminalID else { return }
        await perform { client, deviceID in
            try await client.terminalResize(deviceID, terminalId: terminalID, cols: cols, rows: rows)
        }
    }

    // MARK: Screens

    public func capture(_ target: CodeV2.RemoteCaptureTarget) async {
        capturing = target
        defer { capturing = nil }
        await perform { client, deviceID in
            self.captures[target] = try await client.hostCapture(deviceID, target: target)
        }
    }

    // MARK: Ship

    public func refreshGit() async {
        guard let sessionID = openSessionID else { return }
        await perform { client, deviceID in
            self.git = try await client.gitStatus(deviceID, sessionId: sessionID)
        }
    }

    public func commit(_ message: String) async {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let sessionID = openSessionID else { return }
        gitBusy = "commit"
        defer { gitBusy = nil }
        await perform { client, deviceID in
            self.lastCommit = try await client.gitCommit(deviceID, sessionId: sessionID, message: trimmed)
            self.git = try? await client.gitStatus(deviceID, sessionId: sessionID)
        }
    }

    public func push() async {
        guard let sessionID = openSessionID else { return }
        gitBusy = "push"
        defer { gitBusy = nil }
        await perform { client, deviceID in
            self.lastPush = try await client.gitPush(deviceID, sessionId: sessionID)
            self.git = try? await client.gitStatus(deviceID, sessionId: sessionID)
        }
    }

    @discardableResult
    public func openPullRequest(title: String, body: String? = nil) async -> String? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let sessionID = openSessionID else { return nil }
        gitBusy = "pr"
        defer { gitBusy = nil }
        await perform { client, deviceID in
            self.pullRequestURL = try await client.gitPullRequest(deviceID, sessionId: sessionID, title: trimmed, body: body).url
        }
        return pullRequestURL
    }

    // MARK: New session

    public func beginNewSession() {
        browser = CodeLinkFolderBrowser(sharedFolders: selectedMac?.info?.sharedFolders ?? [])
    }

    public func browse(_ path: String) async {
        guard browser?.allows(path) == true else { return }
        isBrowsing = true
        defer { isBrowsing = false }
        await perform { client, deviceID in
            let listing = try await client.fsList(deviceID, path: path)
            self.browser?.show(listing)
        }
    }

    public func browseUp() async {
        guard let parent = browser?.parent else { return }
        if let path = parent { await browse(path) } else { browser?.goToRoot() }
    }

    /// A session in `cwd` (in its own worktree when asked) with its first prompt.
    @discardableResult
    public func createSession(cwd: String, worktree: Bool, prompt: String) async -> String? {
        guard let client, let deviceID = selectedDeviceID, let selection = composer.selection else {
            lastError = "Choose a model first."
            return nil
        }
        isSending = true
        defer { isSending = false }
        do {
            let id = try await client.sessionOpen(deviceID, sessionId: nil, cwd: cwd, selection: selection, worktree: worktree ? true : nil)
            let summary = CodeV2.SessionSummary(
                id: id, cwd: cwd, title: String(prompt.prefix(80)), state: .running, selection: selection,
                updatedAt: CodeV2Dates.string(now()), lastSequence: 0
            )
            remote.follow(summary)
            openSessionID = id
            restartPoll()
            if let params = composer.turnStart(sessionId: id, text: prompt, skills: skills) {
                try await client.turnStart(deviceID, params)
            }
            browser = nil
            lastError = nil
            writePrefs()
            return id
        } catch {
            note(error, deviceID: deviceID)
            return nil
        }
    }

    // MARK: Routing seam

    /// A notification or Handoff named a session on a Mac.
    public func openRouted(deviceID: String, sessionID: String) async {
        if macs.isEmpty { await refreshMacs() }
        if selectedDeviceID != deviceID { await select(deviceID) }
        await open(sessionID)
    }

    /// An approval answered from a notification.
    public func answerRouted(deviceID: String, sessionID: String, requestID: String, approved: Bool) async {
        guard let client else { return }
        do {
            try await client.approvalRespond(deviceID, sessionId: sessionID, requestId: requestID, decision: approved ? .accept : .decline)
            lastError = nil
        } catch {
            note(error, deviceID: deviceID)
        }
    }

    // MARK: Thread sync

    @ObservationIgnored private var draftApplied = ""

    public var threadKey: String? {
        guard let deviceID = selectedDeviceID, let sessionID = openSessionID else { return nil }
        return ThreadSyncKey.code(deviceID: deviceID, sessionID: sessionID)
    }

    func loadThreadPrefs() async {
        if let snapshot = openSnapshot, openThread?.cursor != nil {
            applyingRemote = true
            composer.adopt(snapshot)
            applyingRemote = false
        }
        guard let sender, let accountID, let key = threadKey else { return }
        if let state = try? await ThreadSyncClient(sender: sender).thread(key, for: accountID) {
            await applyRemote(state)
        }
    }

    /// Long-polls this thread's shared state while the thread is open.
    public func runThreadSync() async {
        guard let sender, let accountID else { return }
        let client = ThreadSyncClient(sender: sender)
        var cursor: String?
        var backoff: Duration = .seconds(2)
        while !Task.isCancelled {
            guard let key = threadKey else { return }
            do {
                let page = try await client.changes(after: cursor, waitMs: 20_000, keys: [key], for: accountID)
                cursor = page.cursor ?? cursor
                for state in page.threads where state.key == threadKey { await applyRemote(state) }
                backoff = .seconds(2)
            } catch {
                if Task.isCancelled { return }
                try? await sleep(backoff)
                backoff = min(backoff * 2, .seconds(30))
            }
        }
    }

    /// Another device's prefs win only when newer; its draft only when this
    /// device has nothing unsent and it is not our own echo.
    func applyRemote(_ state: ThreadSyncState) async {
        if let stamp = state.prefsUpdatedAt, !state.prefs.isEmpty, prefsChangedAt.map({ stamp > $0 }) ?? true {
            applyingRemote = true
            composer.apply(state.prefs, catalogue: catalogue)
            applyingRemote = false
            prefsChangedAt = stamp
        }
        if let syncer = draftSyncer, await syncer.shouldApply(state), state.draft != draft {
            applyingRemote = true
            draft = state.draft
            draftApplied = state.draft
            applyingRemote = false
        }
    }

    private func composerChanged() {
        writePrefs()
    }

    private func writePrefs() {
        guard let sender, let accountID, let key = threadKey else { return }
        let stamp = now()
        prefsChangedAt = stamp
        let update = ThreadSyncUpdate(prefs: composer.prefs, prefsUpdatedAt: stamp, device: Self.syncDevice)
        Task { try? await ThreadSyncClient(sender: sender).write(key, update, for: accountID) }
    }

    private func draftChanged() {
        guard let key = threadKey, let syncer = draftSyncer else { return }
        let text = draft
        let stamp = now()
        Task { await syncer.draftChanged(key, text: text, at: stamp) }
    }

    private func clearedDraft() async {
        applyingRemote = true
        draft = ""
        applyingRemote = false
        if let key = threadKey, let syncer = draftSyncer { await syncer.cleared(key, at: now()) }
    }

    // MARK: Errors

    private func perform(_ body: @escaping (CodeLinkClient, String) async throws -> Void) async {
        guard let client, let deviceID = selectedDeviceID else { return }
        isSending = true
        defer { isSending = false }
        do {
            try await body(client, deviceID)
            lastError = nil
        } catch {
            note(error, deviceID: deviceID)
        }
    }

    private func note(_ error: Error, deviceID: String) {
        if let link = error as? CodeLinkError {
            switch link {
            case let .notPaired(message):
                linkError = link
                update(deviceID) { $0.reachability = .notPaired(message) }
            case .unpairedMac:
                linkError = link
            case let .offline(message):
                update(deviceID) { $0.reachability = .offline(message) }
            default:
                break
            }
        }
        if error is CancellationError { return }
        lastError = Self.describe(error)
    }

    static func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

// MARK: - Previews and snapshot tests

public extension CodeLinkRemoteModel {
    /// A detached model filled with fixtures: no network, nothing polls.
    static func preview(
        macs: [CodeLinkMac],
        selected: String? = nil,
        sessions: [CodeV2.SessionSummary] = [],
        open snapshot: CodeV2.SessionSnapshot? = nil,
        providers: [CodeV2.ProviderInstance] = [],
        skills: [CodeV2.LocalSkillSummary] = [],
        diff: [CodeV2DiffFile] = [],
        terminal: String? = nil,
        git: CodeV2.GitStatusResult? = nil,
        linkError: CodeLinkError? = nil
    ) -> CodeLinkRemoteModel {
        let model = CodeLinkRemoteModel(sender: nil)
        model.macs = macs
        model.phase = .ready
        model.selectedDeviceID = selected ?? macs.first?.id
        model.remote.setSessions(sessions)
        model.providers = providers
        model.skills = skills
        model.threadDiff = diff
        model.git = git
        model.linkError = linkError
        if let snapshot {
            let summary = sessions.first { $0.id == snapshot.id } ?? CodeV2.SessionSummary(
                id: snapshot.id, cwd: snapshot.cwd, title: snapshot.title, state: snapshot.state,
                selection: snapshot.selection, updatedAt: "2026-10-10T09:00:00Z", lastSequence: 1
            )
            model.remote.follow(summary)
            model.remote.apply([CodeV2.ServerEventEnvelope(
                sessionId: snapshot.id, sequence: 1, at: "2026-10-10T09:00:00Z",
                event: .sessionSnapshot(snapshotSequence: 1, session: snapshot)
            )])
            model.openSessionID = snapshot.id
            model.applyingRemote = true
            model.composer.adopt(snapshot)
            model.applyingRemote = false
        }
        if let terminal {
            model.terminalID = "preview-terminal"
            model.remote.openedTerminal("preview-terminal")
            model.remote.apply([CodeV2.ServerEventEnvelope(
                stream: .global, sessionId: nil, sequence: 1, at: "2026-10-10T09:00:00Z",
                event: .terminalOutput(terminalId: "preview-terminal", data: terminal)
            )])
        }
        return model
    }

    /// Snapshot tests: what the composer has typed.
    func setPreviewDraft(_ text: String) {
        applyingRemote = true
        draft = text
        applyingRemote = false
    }
}
