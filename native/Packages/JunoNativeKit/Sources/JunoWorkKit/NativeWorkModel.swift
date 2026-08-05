import Foundation
import JunoCore
import JunoSync
import Observation

/// Drives the Juno Work screens: the task list, the Macs it can run on, and the
/// live log of whichever task is open.
///
/// One model for both apps. The iPhone and the Mac show the same tasks from the
/// same relay, and two models would be two places for the "is this still
/// running" question to be answered differently.
@MainActor
@Observable
public final class NativeWorkModel {
    /// The same offline-versus-failed split as `NativeSyncModel.Phase`, for the
    /// same reason.
    ///
    /// `offline` is anything a retry could fix — no signal, a relay that is
    /// briefly unavailable. `failed` is a server that was reached and refused,
    /// or answered something this build cannot use. Collapsing the two hands
    /// the reader a Retry button that can never succeed; keeping them apart is
    /// the difference between "try again in a moment" and "this Mac's access
    /// was revoked".
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case offline
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var sessions: [WorkSessionSummary] = []
    public private(set) var hosts: [WorkHostSummary] = []
    public private(set) var isMutating = false
    public private(set) var lastErrorDescription: String?

    /// The open task's thread.
    public private(set) var openSession: WorkSessionSummary?
    public private(set) var openRun: WorkRunSummary?
    public private(set) var events: [WorkEvent] = []
    public private(set) var pendingApprovals: [WorkApprovalRequest] = []
    public private(set) var isStreaming = false

    /// The highest event sequence this model has applied.
    ///
    /// Public because it is the thing the screen resumes from, and because a
    /// cursor nobody can inspect is a cursor nobody can prove is advancing. A
    /// reconnect asks for events strictly after this rather than refetching the
    /// transcript, so a phone that loses signal mid-run rejoins where it left
    /// off instead of replaying an hour of tool calls.
    public private(set) var resumeCursor = 0

    /// How often the task and Mac lists are re-read.
    ///
    /// Thirty seconds because host reachability is a *heartbeat* fact and not a
    /// pushed one: a Mac that signs in is not announced to the phone, and a Mac
    /// that closes its lid is only noticed when its heartbeat lapses. Polling
    /// at half the heartbeat cadence means the list is at most one beat stale.
    private static let pollInterval = Duration.seconds(30)

    /// Where the backoff stops. Long enough that a phone with no signal costs
    /// almost nothing, short enough that coming back into coverage is noticed
    /// without the reader having to do anything.
    private static let maximumPollInterval = Duration.seconds(300)

    /// How many consecutive stream failures to absorb before giving up and
    /// telling the reader. Five because the common case is a window closing
    /// under a flaky connection, and the uncommon case — a run whose host was
    /// revoked — must not spin forever pretending to reconnect.
    private static let maximumStreamAttempts = 5

    private let client: NativeWorkClient
    private var accountID: AccountID?
    private var streamTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    /// Whether the last `refresh()` reached the server at all. Distinct from
    /// `lastErrorDescription`, which a refused approval also writes to —
    /// backing the poll off because a *decision* was refused would be reacting
    /// to the wrong fact.
    private var lastRefreshReachedNothing = false

    public init(client: NativeWorkClient) {
        self.client = client
    }

    // MARK: - Derived state

    /// The status to render for a task, corrected by what this client knows
    /// about the Mac it is running on.
    ///
    /// This is the one piece of judgement the model applies to a server answer,
    /// and it exists because of a specific lie the screen would otherwise tell.
    /// A local run's status is written by its host; a host that has closed its
    /// lid writes nothing, so the last thing the server heard is `running` and
    /// it stays `running` until the relay's reaper notices the missing
    /// heartbeats. In that window the phone shows a spinner for a task that is
    /// not executing anywhere, and the user waits on it.
    ///
    /// The correction is deliberately narrow. It applies only when the model
    /// has actually *seen* the host and been told it cannot serve work — a host
    /// missing from the list is not evidence of anything, because the host list
    /// may simply not have loaded yet, and downgrading on absence would flash
    /// every local task to "Mac offline" on launch.
    public func displayStatus(of session: WorkSessionSummary) -> JunoWorkStatus {
        // An unreadable status is `interrupted`: terminal, so it cannot render
        // as a spinner that never resolves, and it is the one status that
        // claims nothing about who decided. This matches the server's own
        // fallback in `serializers.ts`.
        let reported = JunoWorkStatus(rawValue: session.status) ?? .interrupted
        guard !reported.isTerminal else { return reported }
        guard let hostID = session.hostID,
            let host = hosts.first(where: { $0.hostID == hostID })
        else { return reported }
        return host.canServeWork ? reported : .hostOffline
    }

    /// Whether a task is genuinely executing somewhere right now.
    ///
    /// Answered through `displayStatus` rather than from the raw status, so
    /// there is no path by which a caller can render a spinner for a run on a
    /// Mac this model already knows is gone.
    public func isRunning(_ session: WorkSessionSummary) -> Bool {
        switch displayStatus(of: session) {
        case .preparing, .running: true
        default: false
        }
    }

    /// The tasks that cannot move without the user.
    ///
    /// The union of the server's stored flag and the correction above: the
    /// server decides what "waiting on you" means so every client agrees, and
    /// this adds the case the server cannot yet see, which is a local run whose
    /// Mac went away since the last heartbeat. `host_offline` counts as needing
    /// attention in the contract for exactly that reason — the run being over
    /// does not mean the decision is made.
    public var sessionsNeedingAttention: [WorkSessionSummary] {
        sessions.filter { $0.needsAttention || displayStatus(of: $0).needsAttention }
    }

    /// The Macs that can serve local work right now.
    public var availableHosts: [WorkHostSummary] {
        hosts.filter(\.canServeWork)
    }

    /// The approval the open task is blocked on, if any.
    ///
    /// The oldest pending one, because a run asks in the order it needs
    /// answers and showing the newest first makes the user answer backwards.
    public var currentApproval: WorkApprovalRequest? {
        pendingApprovals.first
    }

    /// The question the open task has stopped to ask, derived from the log.
    ///
    /// Derived rather than stored because the log is the only authority: an
    /// answer given on another device arrives as a `question_answered` event,
    /// and a model holding its own copy would keep the prompt on screen after
    /// the run had already moved on. The payload keys match the `answer`
    /// command's in `serializers.ts`, which is the shape the reply must take.
    public var pendingQuestion: WorkQuestionPrompt? {
        var asked: [String: String] = [:]
        var order: [String] = []
        for event in events {
            guard let kind = JunoWorkEventKind(rawValue: event.kind) else { continue }
            guard let questionID = event.payload["questionId"]?.stringValue else { continue }
            switch kind {
            case .questionAsked:
                if asked.updateValue(
                    event.payload["text"]?.stringValue ?? "", forKey: questionID
                ) == nil {
                    order.append(questionID)
                }
            case .questionAnswered:
                asked.removeValue(forKey: questionID)
            default:
                continue
            }
        }
        guard let questionID = order.last(where: { asked[$0] != nil }),
            let text = asked[questionID]
        else { return nil }
        return WorkQuestionPrompt(questionID: questionID, text: text)
    }

    // MARK: - Lifecycle

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
    /// A backoff rather than a visibility gate: this model is started at
    /// sign-in and stopped at sign-out and is never told whether a Work screen
    /// is on screen, so any gate written here would be a guess dressed as a
    /// fact. What it can honestly do is stop asking a server that is not
    /// answering — every refresh that reaches nothing doubles the wait to a
    /// five-minute ceiling, and the first success drops straight back.
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
        sessions = []
        hosts = []
        openSession = nil
        openRun = nil
        events = []
        pendingApprovals = []
        resumeCursor = 0
        isStreaming = false
        isMutating = false
        lastErrorDescription = nil
        lastRefreshReachedNothing = false
        phase = .idle
    }

    public func refresh() async {
        guard let accountID else { return }
        // The two reads are independent: a host list that fails must not take
        // the task list — the part that works without any Mac at all — down
        // with it.
        async let sessionList = try? client.sessions(for: accountID)
        async let hostList = try? client.hosts(for: accountID)
        let (loadedSessions, loadedHosts) = await (sessionList, hostList)
        guard self.accountID == accountID else { return }

        if let loadedSessions { sessions = loadedSessions }
        if let loadedHosts { hosts = loadedHosts }
        lastRefreshReachedNothing = loadedSessions == nil && loadedHosts == nil
        if lastRefreshReachedNothing {
            lastErrorDescription = NativeFailureMessage.offline
            // Whatever was already read stays on screen: a task list from a
            // minute ago is more use than an empty one, as long as the banner
            // says it may be stale.
            phase = sessions.isEmpty ? .offline : .ready
        } else {
            lastErrorDescription = nil
            phase = .ready
        }
    }

    // MARK: - Composing and dispatching

    /// Composes a task and dispatches its first run.
    ///
    /// Two calls rather than one because the server creates a session in
    /// `draft` — composing costs nothing and holds no executor — and a session
    /// that reached `queued` on creation could not be edited before it ran.
    @discardableResult
    public func startTask(
        goal: String,
        title: String? = nil,
        target: JunoWorkTarget = .automatic,
        preferredHostID: String? = nil
    ) async -> WorkSessionSummary? {
        guard let accountID else { return nil }
        let trimmed = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            // One key for the whole composition, reused if the caller retries,
            // so a phone on a bad connection produces one task rather than two.
            let key = UUID().uuidString
            let session = try await client.createSession(
                goal: trimmed, title: title, target: target,
                preferredHostID: preferredHostID, idempotencyKey: key, for: accountID
            )
            let run = try await client.startRun(
                sessionID: session.sessionID, target: target,
                idempotencyKey: key, for: accountID
            )
            guard self.accountID == accountID else { return nil }
            apply(session)
            lastErrorDescription = nil
            open(session)
            openRun = run
            return session
        } catch {
            guard self.accountID == accountID else { return nil }
            record(error)
            return nil
        }
    }

    public func setPinned(_ pinned: Bool, on session: WorkSessionSummary) async {
        await edit(session, WorkSessionEdit(pinned: pinned))
    }

    public func setArchived(_ archived: Bool, on session: WorkSessionSummary) async {
        await edit(session, WorkSessionEdit(archived: archived))
    }

    private func edit(_ session: WorkSessionSummary, _ change: WorkSessionEdit) async {
        guard let accountID else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            let updated = try await client.updateSession(
                id: session.sessionID, change, for: accountID
            )
            guard self.accountID == accountID else { return }
            apply(updated)
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    public func delete(_ session: WorkSessionSummary) async {
        guard let accountID else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await client.deleteSession(id: session.sessionID, for: accountID)
            guard self.accountID == accountID else { return }
            sessions.removeAll { $0.sessionID == session.sessionID }
            if openSession?.sessionID == session.sessionID { closeOpenSession() }
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    // MARK: - The open task

    /// Opens a task and starts following its log.
    public func open(_ session: WorkSessionSummary) {
        guard openSession?.sessionID != session.sessionID || streamTask == nil else { return }
        closeStream()
        openSession = session
        openRun = nil
        events = []
        pendingApprovals = []
        resumeCursor = 0
        follow(sessionID: session.sessionID)
    }

    public func closeOpenSession() {
        closeStream()
        openSession = nil
        openRun = nil
        events = []
        pendingApprovals = []
        resumeCursor = 0
    }

    public func pauseOpenRun() async { await control(.pause) }
    public func resumeOpenRun() async { await control(.resume) }
    public func stopOpenRun() async { await control(.stop) }

    private func control(_ kind: JunoWorkCommandKind) async {
        guard let accountID, let runID = openRun?.runID ?? openSession?.currentRunID else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            let run = try await client.control(
                runID: runID, kind, idempotencyKey: UUID().uuidString, for: accountID
            )
            guard self.accountID == accountID else { return }
            openRun = run
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    /// Answers an approval the open task is blocked on.
    public func decide(
        _ approval: WorkApprovalRequest,
        _ decision: JunoWorkApprovalDecision
    ) async {
        guard let accountID else { return }
        // Cleared optimistically: the run is blocked on this answer, and a card
        // that stays on screen after the tap reads as the tap not landing.
        let index = pendingApprovals.firstIndex { $0.approvalID == approval.approvalID }
        if let index { pendingApprovals.remove(at: index) }
        do {
            _ = try await client.decide(on: approval, decision: decision, for: accountID)
            guard self.accountID == accountID else { return }
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            // Put it back only if it can still be answered. Restoring an
            // expired card would offer the user a button that cannot work.
            if approval.isAnswerable(at: Date()), let index {
                pendingApprovals.insert(approval, at: min(index, pendingApprovals.count))
            }
            record(error)
        }
    }

    /// Replies to a question the open task asked.
    public func answer(_ text: String) async {
        guard let accountID, let session = openSession, let question = pendingQuestion else {
            return
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await client.answer(
                sessionID: session.sessionID, questionID: question.questionID,
                text: trimmed, for: accountID
            )
            guard self.accountID == accountID else { return }
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    // MARK: - Streaming

    /// Follows the open task's log, reconnecting from the cursor.
    ///
    /// The stream is *designed* to end: the route closes its window after a few
    /// minutes so no proxy holds a connection open forever. A clean finish on a
    /// task that is still going therefore means reconnect, not fail — and the
    /// cursor is what makes that reconnect lossless.
    private func follow(sessionID: String) {
        guard let accountID else { return }
        isStreaming = true
        streamTask = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            // The authoritative read comes first, so the thread is populated
            // even where a proxy refuses `text/event-stream` outright and the
            // stream below never yields a frame.
            await loadOpenSession(sessionID: sessionID, for: accountID)
            while !Task.isCancelled, self.accountID == accountID,
                openSession?.sessionID == sessionID
            {
                do {
                    let stream = try await client.streamEvents(
                        sessionID: sessionID, afterSeq: resumeCursor, for: accountID
                    )
                    for try await frame in stream {
                        guard !Task.isCancelled, openSession?.sessionID == sessionID else { break }
                        attempt = 0
                        switch frame {
                        case .snapshot(let update), .events(let update):
                            apply(update)
                        case .done(let update):
                            apply(update)
                            // The window closed. Whether that is the end
                            // depends on the task, not on the connection.
                            if let session = openSession, !isRunning(session) {
                                isStreaming = false
                                return
                            }
                        }
                    }
                } catch is CancellationError {
                    return
                } catch {
                    attempt += 1
                    guard attempt <= Self.maximumStreamAttempts else {
                        record(error)
                        isStreaming = false
                        return
                    }
                }
                guard !Task.isCancelled, openSession?.sessionID == sessionID else { break }
                if let openSession,
                    JunoWorkStatus(rawValue: openSession.status)?.isTerminal == true
                {
                    isStreaming = false
                    return
                }
                // A short pause before reconnecting. Zero would spin against a
                // server that is refusing, and long would make a live run look
                // stalled.
                try? await Task.sleep(for: .milliseconds(attempt == 0 ? 200 : 1_200))
            }
            isStreaming = false
        }
    }

    private func loadOpenSession(sessionID: String, for accountID: AccountID) async {
        do {
            let detail = try await client.session(id: sessionID, for: accountID)
            guard self.accountID == accountID, openSession?.sessionID == sessionID else { return }
            apply(detail.session)
            openSession = detail.session
            openRun = detail.run
            append(detail.events)
            merge(detail.approvals)
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID, openSession?.sessionID == sessionID else { return }
            record(error)
        }
    }

    private func closeStream() {
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false
    }

    private func apply(_ update: WorkStreamUpdate) {
        if let session = update.session {
            apply(session)
            if openSession?.sessionID == session.sessionID { openSession = session }
        }
        if let run = update.run, run.sessionID == openSession?.sessionID { openRun = run }
        append(update.events)
        merge(update.approvals)
    }

    /// Appends events, ignoring anything already applied and advancing the
    /// cursor.
    ///
    /// Deduplicated by sequence rather than by content: a reconnect can legally
    /// replay the frame that was in flight when the connection dropped, and two
    /// identical `assistant_message` events are a replay while two identical
    /// `tool_started` events might not be.
    private func append(_ incoming: [WorkEvent]) {
        guard !incoming.isEmpty else { return }
        let known = Set(events.map(\.seq))
        let fresh = incoming.filter { !known.contains($0.seq) }
        guard !fresh.isEmpty else { return }
        events.append(contentsOf: fresh)
        events.sort { $0.seq < $1.seq }
        resumeCursor = max(resumeCursor, events.last?.seq ?? resumeCursor)
    }

    /// Folds incoming approvals into the pending list.
    ///
    /// An approval that arrives already decided removes the card, because the
    /// answer may have come from another device and a card the user cannot
    /// answer twice must not be shown twice.
    private func merge(_ incoming: [WorkApprovalRequest]) {
        for approval in incoming {
            let index = pendingApprovals.firstIndex { $0.approvalID == approval.approvalID }
            if approval.isPending {
                if let index { pendingApprovals[index] = approval } else {
                    pendingApprovals.append(approval)
                }
            } else if let index {
                pendingApprovals.remove(at: index)
            }
        }
    }

    private func apply(_ session: WorkSessionSummary) {
        if let index = sessions.firstIndex(where: { $0.sessionID == session.sessionID }) {
            sessions[index] = session
        } else {
            sessions.insert(session, at: 0)
        }
    }

    /// Records a failure as a sentence, and moves the phase only when the whole
    /// screen is unusable.
    ///
    /// A refused approval leaves the list on screen and says why; only a failure
    /// that left nothing to show is allowed to take the phase with it.
    private func record(_ error: any Error) {
        lastErrorDescription = presentable(error)
        guard sessions.isEmpty else { return }
        phase = Self.failurePhase(for: error)
    }

    private func presentable(_ error: any Error) -> String {
        if let work = error as? WorkRemoteError {
            return work.errorDescription ?? NativeFailureMessage.offline
        }
        return NativeFailureMessage.presentable(error)
    }

    /// Which failure phase an error belongs in.
    ///
    /// Retryability decides it, and `WorkRemoteError` already carries that
    /// judgement: a 503 is reachable-but-busy and belongs in `offline` where
    /// the reader is invited to try again, while a revocation or an undecodable
    /// answer belongs in `failed` where they are not.
    private static func failurePhase(for error: any Error) -> Phase {
        if let work = error as? WorkRemoteError { return work.isRetryable ? .offline : .failed }
        return NativeFailureClassification.isConnectivityFailure(error) ? .offline : .failed
    }
}
