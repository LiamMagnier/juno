import Foundation
import JunoCodeCore

// The verification ledger: evidence the runtime minted this session, and where
// the workspace stands (CODE_AGENT_SPEC §1.2, §1.8–§1.10).
//
// It is a fold over the session's own transcript, never over model text:
//
// - every `fileChanged` event bumps the workspace revision, including changes
//   a command made, and a rewind bumps it too;
// - `verificationRecorded`, `uiVerificationRecorded` and `reviewCompleted`
//   add evidence, each once by id, describing the workspace where they sit
//   in the transcript (a record never claims a revision from after it);
// - a `git_diff` call that succeeded marks the diff read at the revision it
//   ran at, when it could have shown the whole change: unfiltered, or
//   filtered to paths that together cover every file the run changed, and
//   not an empty staged diff;
// - a reader's message starts a run.
//
// Because it is a fold, what a session restored from disk knows is exactly
// what it knew before, and the revision a record was stamped with means the
// same thing after a relaunch. Recorders (the command tools, `run_checks`,
// the review pass, the Preview and Simulator lanes) add evidence by appending
// those events to the store, through `VerificationLedgerWriting` or as a
// tool's side effects; the gate reads it through `VerificationLedgerReading`.
//
// A class with a lock rather than an actor: the store tells its observers on
// its own executor as each event is appended, and the ledger takes the event
// there and then. A tool that runs after a file change therefore always reads
// the revision that change made, with no hop in between to race.

/// One session's evidence, kept up to date from its transcript.
public final class VerificationLedger: VerificationLedgerReading, VerificationLedgerWriting, @unchecked Sendable {
    public let sessionID: CodeSessionID
    private let store: CodeSessionStore?
    private let lock = NSLock()
    private var state = State()
    private var observer: UUID?
    /// Events delivered while the history was being read, applied after it.
    private var buffered: [SessionEvent] = []
    private var folding = false

    /// The evidence, the revision and the run boundary.
    public struct State: Hashable, Sendable {
        public var workspaceRevision = 0
        public var verifications: [VerificationRecord] = []
        public var uiVerifications: [UIVerificationRecord] = []
        public var reviews: [ReviewRecord] = []
        public var lastDiffReadRevision: Int?
        /// The sequence of the last event folded in.
        public var lastSequence = -1
        /// The revision when the reader's latest message started this run.
        public var runStartRevision = 0
        /// Files changed since then, in the order first changed.
        public var filesChangedThisRun: [String] = []
        /// Lines added and removed since then, by the structured file tools.
        public var linesChangedThisRun = 0
        /// Review passes since then.
        public var reviewRoundsThisRun = 0
        /// Reviewer runs started since then, including those that failed or
        /// answered nothing readable: what bounds the review rounds when no
        /// review gets recorded. Not in the transcript, so a relaunch starts
        /// it again from the recorded rounds.
        public var reviewAttemptsThisRun = 0
        /// Paths a filtered `git_diff` showed since the last edit.
        var diffPathsRead: Set<String> = []
        /// What each `git_diff` call in flight asked for, by call id.
        var diffCalls: [String: DiffCall] = [:]
        /// Ids of the records minted since then.
        public var recordIDsThisRun: Set<String> = []
        /// The tool each call in flight belongs to, by call id.
        var toolNames: [String: String] = [:]
        var recordIDs: Set<String> = []

        public init() {}
    }

    /// One `git_diff` call's input: the path it was narrowed to, if any, and
    /// whether it showed the staged changes.
    struct DiffCall: Hashable, Sendable {
        var path: String?
        var staged: Bool

        init(input: JSONValue) {
            var raw = input["path"]?.stringValue?.trimmingCharacters(in: .whitespaces) ?? ""
            while raw.hasPrefix("./") { raw.removeFirst(2) }
            while raw.hasSuffix("/") { raw.removeLast() }
            path = raw.isEmpty || raw == "." ? nil : raw
            staged = input["staged"]?.boolValue ?? (input["staged"]?.stringValue == "true")
        }
    }

    /// A ledger over `events`, observing nothing: for tests, projections and
    /// anything that holds a transcript rather than a store.
    public init(sessionID: CodeSessionID, events: [SessionEvent] = []) {
        self.sessionID = sessionID
        self.store = nil
        for event in events { Self.apply(event, to: &state) }
    }

    private init(sessionID: CodeSessionID, store: CodeSessionStore) {
        self.sessionID = sessionID
        self.store = store
    }

    /// Opens a ledger on a live session: watches the store first, then reads
    /// the history, so no event appended in between is missed or counted
    /// twice (events carry a strictly increasing sequence).
    public static func open(sessionID: CodeSessionID, store: CodeSessionStore) async -> VerificationLedger {
        let ledger = VerificationLedger(sessionID: sessionID, store: store)
        ledger.lock.withLock { ledger.folding = true }
        let token = await store.addObserver { [weak ledger] update in
            guard case let .eventAppended(event) = update else { return }
            ledger?.take(event)
        }
        ledger.lock.withLock { ledger.observer = token }
        let history = await store.events(for: sessionID)
        ledger.lock.withLock {
            for event in history { Self.apply(event, to: &ledger.state) }
            for event in ledger.buffered { Self.apply(event, to: &ledger.state) }
            ledger.buffered.removeAll()
            ledger.folding = false
        }
        return ledger
    }

    /// Stops watching the store.
    public func close() async {
        let token = lock.withLock { () -> UUID? in
            defer { observer = nil }
            return observer
        }
        if let token, let store { await store.removeObserver(token) }
    }

    private func take(_ event: SessionEvent) {
        guard event.sessionID == sessionID else { return }
        var refold = false
        lock.withLock {
            if folding {
                buffered.append(event)
            } else {
                Self.apply(event, to: &state)
                refold = event.payload.isTranscriptRewound
            }
        }
        // A rewind cut events from the transcript; the revision is counted
        // again over what is left, so it means what it will mean after a
        // relaunch.
        if refold { scheduleRefold(attempt: 0) }
    }

    /// Reads the history again and folds it from scratch. An event appended
    /// between the read and the fold makes the read stale; it is read again
    /// then, a few times at most, rather than left counting what the rewind
    /// cut.
    private func scheduleRefold(attempt: Int) {
        guard let store else { return }
        let sessionID = sessionID
        Task { [weak self] in
            let history = await store.events(for: sessionID)
            guard let self else { return }
            if !self.refold(history), attempt < 3 {
                self.scheduleRefold(attempt: attempt + 1)
            }
        }
    }

    /// Whether `history` was current enough to replace the state.
    private func refold(_ history: [SessionEvent]) -> Bool {
        lock.withLock {
            var fresh = State()
            for event in history { Self.apply(event, to: &fresh) }
            // Anything appended after the read stays counted.
            guard fresh.lastSequence >= state.lastSequence else { return false }
            // Attempts are not in the transcript; the run's count carries over.
            fresh.reviewAttemptsThisRun = max(fresh.reviewAttemptsThisRun, state.reviewAttemptsThisRun)
            state = fresh
            return true
        }
    }

    // MARK: - The fold

    /// Applies one event. Events at or before the last sequence are skipped,
    /// so the same event delivered twice counts once.
    static func apply(_ event: SessionEvent, to state: inout State) {
        guard event.sequence > state.lastSequence else { return }
        state.lastSequence = event.sequence
        switch event.payload {
        case .userPrompt:
            state.runStartRevision = state.workspaceRevision
            state.filesChangedThisRun = []
            state.linesChangedThisRun = 0
            state.reviewRoundsThisRun = 0
            state.reviewAttemptsThisRun = 0
            state.recordIDsThisRun = []
        case let .fileChanged(change):
            state.workspaceRevision += 1
            state.diffPathsRead = []
            if !state.filesChangedThisRun.contains(change.path.value) {
                state.filesChangedThisRun.append(change.path.value)
            }
            state.linesChangedThisRun += change.linesAdded + change.linesRemoved
        case .transcriptRewound:
            state.workspaceRevision += 1
            state.diffPathsRead = []
        case let .toolProposed(proposed):
            state.toolNames[proposed.toolCallID] = proposed.toolName
            if proposed.toolName == "git_diff" {
                state.diffCalls[proposed.toolCallID] = DiffCall(input: proposed.input)
            }
        case let .toolCompleted(completed):
            let name = state.toolNames.removeValue(forKey: completed.toolCallID)
            let call = state.diffCalls.removeValue(forKey: completed.toolCallID)
            if name == "git_diff", completed.status == .succeeded {
                noteDiffRead(call, summary: completed.resultSummary, in: &state)
            }
        case var .verificationRecorded(record):
            guard state.recordIDs.insert(record.id).inserted else { return }
            // A record describes the workspace where it sits in the
            // transcript. Its own file changes come before it, so a correct
            // stamp is exactly this revision; a higher one (stamped from a
            // count a rewind then cut back) would turn fresh later, when the
            // count caught up with a workspace it never saw.
            record.workspaceRevision = min(record.workspaceRevision, state.workspaceRevision)
            state.verifications.append(record)
            state.recordIDsThisRun.insert(record.id)
        case var .uiVerificationRecorded(record):
            guard state.recordIDs.insert(record.id).inserted else { return }
            record.workspaceRevision = min(record.workspaceRevision, state.workspaceRevision)
            state.uiVerifications.append(record)
            state.recordIDsThisRun.insert(record.id)
        case var .reviewCompleted(record):
            guard state.recordIDs.insert(record.id).inserted else { return }
            record.workspaceRevision = min(record.workspaceRevision, state.workspaceRevision)
            state.reviews.append(record)
            state.recordIDsThisRun.insert(record.id)
            state.reviewRoundsThisRun += 1
            // A review pass read the diff at the revision it reviewed.
            state.lastDiffReadRevision = max(state.lastDiffReadRevision ?? record.workspaceRevision, record.workspaceRevision)
        default:
            break
        }
    }

    /// A `git_diff` that succeeded: the diff counts as read when the call
    /// could have shown the whole change. An unfiltered diff can; an empty
    /// staged diff shows nothing of unstaged edits; a diff narrowed to one
    /// path counts once the paths read since the last edit cover every file
    /// this run changed.
    private static func noteDiffRead(_ call: DiffCall?, summary: String, in state: inout State) {
        let call = call ?? DiffCall(input: .object([:]))
        let empty = summary.trimmingCharacters(in: .whitespacesAndNewlines) == "No changes."
        if call.staged, empty { return }
        guard let path = call.path else {
            state.lastDiffReadRevision = state.workspaceRevision
            return
        }
        state.diffPathsRead.insert(path)
        let changed = state.filesChangedThisRun
        let covered = !changed.isEmpty && changed.allSatisfy { file in
            state.diffPathsRead.contains { file == $0 || file.hasPrefix($0 + "/") }
        }
        if covered { state.lastDiffReadRevision = state.workspaceRevision }
    }

    // MARK: - Reading

    public var current: State { lock.withLock { state } }

    public var workspaceRevision: Int { lock.withLock { state.workspaceRevision } }
    public var verifications: [VerificationRecord] { lock.withLock { state.verifications } }
    public var uiVerifications: [UIVerificationRecord] { lock.withLock { state.uiVerifications } }
    public var review: ReviewRecord? { lock.withLock { state.reviews.last } }
    public var lastDiffReadRevision: Int? { lock.withLock { state.lastDiffReadRevision } }

    /// The files this run changed, in the order first changed.
    public var filesChangedThisRun: [String] { lock.withLock { state.filesChangedThisRun } }
    /// Review passes this run; at most `ReviewPass.maximumRounds`.
    public var reviewRoundsThisRun: Int { lock.withLock { state.reviewRoundsThisRun } }
    /// Reviewer runs started this run, recorded or not.
    public var reviewAttemptsThisRun: Int { lock.withLock { state.reviewAttemptsThisRun } }

    /// Counts one reviewer run against this run's rounds before it starts,
    /// so a reviewer that keeps failing cannot be started again and again.
    /// Answers the round it is, or nil when `maximum` rounds were already
    /// used (checked and counted in one step).
    public func beginReviewAttempt(maximum: Int) -> Int? {
        lock.withLock {
            let used = max(state.reviewAttemptsThisRun, state.reviewRoundsThisRun)
            guard used < maximum else { return nil }
            state.reviewAttemptsThisRun = used + 1
            return used + 1
        }
    }

    /// A value copy, for the gate and the report.
    public var snapshot: VerificationSnapshot {
        lock.withLock {
            VerificationSnapshot(
                workspaceRevision: state.workspaceRevision,
                verifications: state.verifications,
                uiVerifications: state.uiVerifications,
                review: state.reviews.last,
                lastDiffReadRevision: state.lastDiffReadRevision
            )
        }
    }

    /// Only the evidence minted since the reader's latest message.
    public var snapshotThisRun: VerificationSnapshot {
        lock.withLock {
            let ids = state.recordIDsThisRun
            return VerificationSnapshot(
                workspaceRevision: state.workspaceRevision,
                verifications: state.verifications.filter { ids.contains($0.id) },
                uiVerifications: state.uiVerifications.filter { ids.contains($0.id) },
                review: state.reviews.last.flatMap { ids.contains($0.id) ? $0 : nil },
                lastDiffReadRevision: state.lastDiffReadRevision
            )
        }
    }

    // MARK: - Writing

    public func recordVerification(_ record: VerificationRecord) async {
        await append(.verificationRecorded(record), id: record.id)
    }

    public func recordUIVerification(_ record: UIVerificationRecord) async {
        await append(.uiVerificationRecorded(record), id: record.id)
    }

    public func recordReview(_ record: ReviewRecord) async {
        await append(.reviewCompleted(record), id: record.id)
    }

    public func recordDiffRead(atRevision revision: Int) async {
        lock.withLock {
            state.lastDiffReadRevision = max(state.lastDiffReadRevision ?? revision, revision)
        }
    }

    /// Appends events in order, as a tool's side effects would be: the
    /// gate's own check runs use this.
    public func append(_ payloads: [SessionEventPayload]) async {
        for payload in payloads {
            if let store {
                _ = try? await store.appendEvent(sessionID: sessionID, payload: payload)
            } else {
                apply(payload)
            }
        }
    }

    private func append(_ payload: SessionEventPayload, id: String) async {
        guard !lock.withLock({ state.recordIDs.contains(id) }) else { return }
        await append([payload])
    }

    /// For a ledger with no store: fold a payload as the next event.
    private func apply(_ payload: SessionEventPayload) {
        lock.withLock {
            let event = SessionEvent(
                sessionID: sessionID,
                sequence: state.lastSequence + 1,
                timestamp: Date(),
                payload: payload
            )
            Self.apply(event, to: &state)
        }
    }

    /// The revision a check that just finished should carry: the current one,
    /// plus the file changes the same result reports but the store has not
    /// been told yet. A tool's side effects are appended in order after it
    /// returns, so a record listed after `pendingChanges` file changes is
    /// folded at exactly that revision.
    public func revision(afterPendingChanges pendingChanges: Int) -> Int {
        lock.withLock { state.workspaceRevision + max(pendingChanges, 0) }
    }
}

private extension SessionEventPayload {
    var isTranscriptRewound: Bool {
        if case .transcriptRewound = self { return true }
        return false
    }
}

// MARK: - One ledger per session

/// Every open ledger, by session. The tool providers open a session's ledger
/// when they build its Code turn; the command tools, the gate and the UI find
/// the same one here.
public actor VerificationLedgers {
    public static let shared = VerificationLedgers()

    private var ledgers: [CodeSessionID: VerificationLedger] = [:]
    private var opening: [CodeSessionID: Task<VerificationLedger, Never>] = [:]
    /// Stores whose deletions this registry follows, so a deleted session's
    /// ledger stops watching and is let go.
    private var watchedStores: Set<ObjectIdentifier> = []

    public init() {}

    /// The session's ledger, opened on first use.
    public func ledger(for sessionID: CodeSessionID, store: CodeSessionStore) async -> VerificationLedger {
        if let ledger = ledgers[sessionID] { return ledger }
        if let task = opening[sessionID] { return await task.value }
        let task = Task { await VerificationLedger.open(sessionID: sessionID, store: store) }
        opening[sessionID] = task
        let ledger = await task.value
        ledgers[sessionID] = ledger
        opening[sessionID] = nil
        if watchedStores.insert(ObjectIdentifier(store)).inserted {
            await store.addObserver { [weak self] update in
                guard case let .sessionRemoved(removed) = update else { return }
                Task { await self?.release(removed) }
            }
        }
        return ledger
    }

    /// The session's ledger if one is open.
    public func existing(for sessionID: CodeSessionID) -> VerificationLedger? {
        ledgers[sessionID]
    }

    /// Closes and forgets a session's ledger (the session was deleted).
    public func release(_ sessionID: CodeSessionID) async {
        guard let ledger = ledgers.removeValue(forKey: sessionID) else { return }
        await ledger.close()
    }
}
