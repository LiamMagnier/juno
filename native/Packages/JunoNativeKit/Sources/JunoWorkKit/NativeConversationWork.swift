import Foundation
import JunoAuth
import JunoCore
import Observation

/// One open chat's tasks: the one it follows live, the ones before it, and
/// everything the chat does to them — answer, steer, decide, stop.
///
/// The Swift twin of the web's `useConversationWork`
/// (`src/components/chat/use-conversation-work.ts`). One per open, saved
/// conversation; the transcript's card, the composer's steering and the Task
/// panel all read the same object, so there is exactly one cursor on a run.
///
/// **Separate from ``NativeWorkModel``'s open session**, on purpose. That one
/// belongs to the legacy Tasks window; when the chat borrowed it, opening a
/// task there took the chat's card away and a chat switch closed the window's
/// task. The chat never touches it now.
///
/// How it finds its task, in the web's order:
/// 1. **Adopt** the session a reply's `work` frame carries (``adopt(_:)``).
///    Drafts are refused; the same id keeps the object it has; each adoption
///    bumps a counter that makes an in-flight discovery answer stale.
/// 2. **Discover** with the conversation's session list — when it opens, after
///    an adoption, after each reply, and every 4s while the window is visible
///    (``isVisible``: the Mac feeds it from the window's occlusion; the web
///    polls regardless, register #64). Never in a private chat, which has no
///    follower at all.
/// 3. **Follow** the newest by `createdAt` through its event stream,
///    reconnecting at once when the server closes its window and backing off
///    1s × n up to 15s on errors; a new run id resets the cursor.
@MainActor
@Observable
public final class NativeConversationWork {
    /// A decision a task waits on, from whichever side raised it: a cloud
    /// run's arrives on the stream, a run on this Mac is suspended in this
    /// process and only this Mac can answer it.
    public struct Approval: Identifiable, Equatable, Sendable {
        public let request: WorkApprovalRequest
        public let isLocal: Bool
        public var id: String { request.id }

        public init(request: WorkApprovalRequest, isLocal: Bool) {
            self.request = request
            self.isLocal = isLocal
        }
    }

    /// What the composer does with Return while this task is live.
    public enum ComposerMode: Equatable, Sendable {
        /// The run asked something: the text answers it.
        case answer(WorkQuestionPrompt)
        /// The run is working: the text is a new instruction.
        case instruction
    }

    /// What an action came to, in the web's words, for the window's toast.
    public struct Outcome: Equatable, Sendable {
        public let succeeded: Bool
        /// The sentence to show, if any: the server's explanation of a steer,
        /// or why an action did not land.
        public let message: String?

        public static func ok(_ message: String? = nil) -> Outcome {
            Outcome(succeeded: true, message: message)
        }

        public static func failed(_ message: String) -> Outcome {
            Outcome(succeeded: false, message: message)
        }
    }

    public let conversationID: String

    /// The task the card follows: the newest composed, not the most recently
    /// active, so an older task that wakes up does not take the card from the
    /// one just started.
    public private(set) var current: WorkSessionSummary?
    /// Every earlier task of this conversation, oldest first — the settled rows
    /// (register #53).
    public private(set) var history: [WorkSessionSummary] = []
    public private(set) var run: WorkRunSummary?
    public private(set) var events: [WorkEvent] = []
    /// The server's pending approvals for the current run.
    public private(set) var serverApprovals: [WorkApprovalRequest] = []
    public private(set) var artifacts: [WorkArtifactSummary] = []
    /// A send is in flight; the card's buttons dim with it.
    public private(set) var isBusy = false
    /// Whether discovery has answered at least once, so a chat that has no
    /// task is told apart from one not read yet.
    public private(set) var hasDiscovered = false

    /// Whether the conversation is on screen in a visible window. Discovery
    /// polls only while it is; becoming visible again looks at once.
    public var isVisible = true {
        didSet {
            guard isVisible, !oldValue else { return }
            Task { await discover() }
        }
    }

    /// This Mac's own approvals for a run, by run id (nil off the Mac).
    public var localApprovals: (@MainActor (String) -> [WorkApprovalRequest])?
    /// Answers one of those through the coordinator holding the run.
    public var localApprovalDecider: (@MainActor (WorkApprovalRequest, JunoWorkApprovalDecision) -> Void)?
    /// The web's `juno:work-sync`: re-reads the account's task list after an
    /// action, so the sidebar and the Dock hear of it.
    public var didAct: (@MainActor () async -> Void)?

    private let client: NativeWorkClient
    private let accountID: AccountID
    private var adoptions = 0
    private var cursor: (runID: String?, after: Int) = (nil, 0)
    private var streamTask: Task<Void, Never>?
    private var followedSessionID: String?
    private var artifactCount = -1
    /// The steer whose last send failed and the key it went under, so the
    /// obvious second press is recognised by the route rather than queued
    /// twice. Cleared on any answer from the server.
    private var retriableSteer: (text: String, key: String)?
    private var retriableAnswer: (questionID: String, text: String, key: String)?

    /// How often a visible conversation re-asks whether it has a task. The
    /// web's interval (`DISCOVERY_POLL_MS`).
    public static let discoveryInterval = Duration.seconds(4)
    /// The longest wait between reconnects after errors.
    static let maximumBackoff = 15

    public init(conversationID: String, client: NativeWorkClient, accountID: AccountID) {
        self.conversationID = conversationID
        self.client = client
        self.accountID = accountID
    }

    // MARK: Lifecycle

    /// Discovers now and then every ``discoveryInterval`` while visible, until
    /// the calling task is cancelled — the conversation's `.task` owns it.
    public func run() async {
        while !Task.isCancelled {
            if isVisible { await discover() }
            try? await Task.sleep(for: Self.discoveryInterval)
        }
    }

    /// Lets go of the stream. The owner calls it when the conversation closes.
    public func close() {
        streamTask?.cancel()
        streamTask = nil
        followedSessionID = nil
    }

    // MARK: Finding the task

    /// Takes the session a reply's `work` frame carried. Refuses a draft and
    /// another conversation's; the same id keeps what is already followed.
    @discardableResult
    public func adopt(_ session: WorkSessionSummary) -> Bool {
        guard session.conversationID == nil || session.conversationID == conversationID else {
            return false
        }
        guard session.status != JunoWorkStatus.draft.rawValue else { return false }
        if current?.sessionID == session.sessionID { return false }
        adoptions += 1
        if let previous = current { fileInHistory(previous) }
        history.removeAll { $0.sessionID == session.sessionID }
        setCurrent(session)
        Task { await discover() }
        return true
    }

    /// Asks the server for this conversation's tasks and follows the newest.
    public func discover() async {
        let asked = adoptions
        let listed: [WorkSessionSummary]
        do {
            listed = try await client.sessions(
                conversationID: conversationID, limit: 10, for: accountID
            )
        } catch {
            return
        }
        // An adoption landed while the list was on its way: the list cannot
        // know about it, and its answer would take the card back.
        guard asked == adoptions, !Task.isCancelled else { return }
        hasDiscovered = true
        apply(discovered: listed)
    }

    /// The list's answer, by the web's rules: drafts never adopted, the
    /// newest composed is current, the rest are history, oldest first.
    func apply(discovered listed: [WorkSessionSummary]) {
        let mine = listed.filter {
            ($0.conversationID ?? conversationID) == conversationID
                && $0.status != JunoWorkStatus.draft.rawValue
        }
        let ordered = Self.byCreation(mine)
        if let newest = ordered.last {
            if let current, Self.created(current) > Self.created(newest) {
                // The adopted task is newer than anything listed yet.
                history = ordered.filter { $0.sessionID != current.sessionID }
            } else if current?.sessionID == newest.sessionID {
                current = newest
                history = Array(ordered.dropLast())
            } else {
                history = Array(ordered.dropLast())
                setCurrent(newest)
            }
        } else if current == nil {
            history = []
        }
    }

    private static func created(_ session: WorkSessionSummary) -> Date {
        session.createdAt ?? session.lastActivityAt
    }

    /// Oldest first by when each was composed.
    nonisolated static func byCreation(_ sessions: [WorkSessionSummary]) -> [WorkSessionSummary] {
        sessions.sorted { ($0.createdAt ?? $0.lastActivityAt) < ($1.createdAt ?? $1.lastActivityAt) }
    }

    private func fileInHistory(_ session: WorkSessionSummary) {
        history.removeAll { $0.sessionID == session.sessionID }
        history.append(session)
        history = Self.byCreation(history)
    }

    private func setCurrent(_ session: WorkSessionSummary) {
        let changed = current?.sessionID != session.sessionID
        current = session
        guard changed else { return }
        run = nil
        events = []
        serverApprovals = []
        artifacts = []
        artifactCount = -1
        cursor = (nil, 0)
        retriableSteer = nil
        retriableAnswer = nil
        follow(session.sessionID)
    }

    // MARK: Following

    private func follow(_ sessionID: String) {
        streamTask?.cancel()
        followedSessionID = sessionID
        streamTask = Task { [weak self] in
            var failures = 0
            while !Task.isCancelled {
                guard let self, self.followedSessionID == sessionID else { return }
                do {
                    let frames = try await self.client.streamEvents(
                        sessionID: sessionID, afterSeq: self.cursor.after, for: self.accountID
                    )
                    for try await frame in frames {
                        guard !Task.isCancelled, self.followedSessionID == sessionID else { return }
                        failures = 0
                        switch frame {
                        case .snapshot(let update):
                            self.apply(update, isSnapshot: true)
                        case .events(let update):
                            self.apply(update, isSnapshot: false)
                        case .done(let update):
                            self.apply(update, isSnapshot: false)
                            if self.isFinished { return }
                        }
                    }
                    // The server closes its window every four minutes: a clean
                    // end on a run still going is a reconnect, at once.
                    if self.isFinished { return }
                } catch is CancellationError {
                    return
                } catch {
                    failures += 1
                    let wait = min(Self.maximumBackoff, failures)
                    try? await Task.sleep(for: .seconds(wait))
                }
            }
        }
    }

    /// One frame. A snapshot for a different run than the cursor's starts the
    /// log again: a retried task is a new attempt with its own sequence.
    func apply(_ update: WorkStreamUpdate, isSnapshot: Bool) {
        if let session = update.session, session.sessionID == current?.sessionID {
            current = session
        }
        if let run = update.run, run.sessionID == current?.sessionID {
            if isSnapshot, run.runID != cursor.runID {
                cursor = (run.runID, 0)
                events = []
                serverApprovals = []
            }
            cursor.runID = run.runID
            self.run = run
        }
        merge(update.events)
        merge(update.approvals)
        let produced = WorkEventLog.producedArtifactCount(in: events)
        if produced != artifactCount {
            artifactCount = produced
            Task { await refreshArtifacts() }
        }
    }

    /// Deduplicated by sequence: a reconnect may replay the frame in flight.
    private func merge(_ incoming: [WorkEvent]) {
        guard !incoming.isEmpty else { return }
        let known = Set(events.map(\.seq))
        let fresh = incoming.filter { !known.contains($0.seq) }
        guard !fresh.isEmpty else { return }
        events.append(contentsOf: fresh)
        events.sort { $0.seq < $1.seq }
        cursor.after = max(cursor.after, events.last?.seq ?? cursor.after)
    }

    /// A decided approval removes its card: the answer may have come from
    /// another device.
    private func merge(_ incoming: [WorkApprovalRequest]) {
        for approval in incoming {
            let index = serverApprovals.firstIndex { $0.approvalID == approval.approvalID }
            if approval.isPending {
                if let index { serverApprovals[index] = approval } else { serverApprovals.append(approval) }
            } else if let index {
                serverApprovals.remove(at: index)
            }
        }
    }

    private func refreshArtifacts() async {
        guard let sessionID = current?.sessionID else { return }
        guard let listed = try? await client.artifacts(for: sessionID, accountID: accountID),
            current?.sessionID == sessionID
        else { return }
        artifacts = listed
    }

    // MARK: Derived

    /// The status to draw: the run's when it is fresher than the session's.
    public var status: JunoWorkStatus? {
        guard let current else { return nil }
        if let run, let status = JunoWorkStatus(rawValue: run.status), run.sessionID == current.sessionID {
            // A run response is fresher right after a start or a stop.
            return status
        }
        return JunoWorkStatus(rawValue: current.status) ?? .interrupted
    }

    /// Finished, however it finished.
    public var isFinished: Bool { status?.isTerminal ?? false }

    public var plan: [WorkEventLog.PlanStep] { WorkEventLog.plan(from: events) }
    public var openQuestions: [WorkQuestionPrompt] { WorkEventLog.openQuestions(in: events) }
    public var pendingSteers: [WorkEventLog.PendingSteer] { WorkEventLog.pendingSteers(in: events) }
    public var turns: [WorkEventLog.Turn] { WorkEventLog.turns(in: events) }

    /// What the run is doing now; only while it is live.
    public var currentAction: WorkEventLog.CurrentAction? {
        guard let status, !status.isTerminal else { return nil }
        return WorkEventLog.currentAction(in: events)
    }

    /// Local first — the coordinator holding a suspended tool is the one to
    /// answer — then the server's still pending, each once.
    public var approvals: [Approval] {
        let runID = run?.runID ?? current?.currentRunID
        return Self.mergedApprovals(
            local: runID.flatMap { localApprovals?($0) } ?? [],
            server: serverApprovals
        )
    }

    nonisolated static func mergedApprovals(
        local: [WorkApprovalRequest], server: [WorkApprovalRequest]
    ) -> [Approval] {
        let local = local.map { Approval(request: $0, isLocal: true) }
        let localIDs = Set(local.map(\.id))
        let remote = server
            .filter { $0.isPending && !localIDs.contains($0.id) }
            .map { Approval(request: $0, isLocal: false) }
        return local + remote
    }

    /// What Return does in the composer, or nil when the task takes nothing.
    public var composerMode: ComposerMode? {
        Self.composerMode(status: status, openQuestion: openQuestions.first)
    }

    /// The web's `delegatedComposerMode`, with one change (register #54): an
    /// open question answers only while the run is not finished. On the web a
    /// finished run with a question still asks for an answer the route
    /// refuses, and its empty-field Stop then cancels a finished run.
    public nonisolated static func composerMode(
        status: JunoWorkStatus?, openQuestion: WorkQuestionPrompt?
    ) -> ComposerMode? {
        guard let status, !status.isTerminal, status != .draft else { return nil }
        if let openQuestion { return .answer(openQuestion) }
        return .instruction
    }

    // MARK: Acting

    /// Answers a question — with one of its offered replies, or typed.
    public func answer(questionID: String, text: String) async -> Outcome {
        guard let sessionID = current?.sessionID else {
            return .failed(Self.answerFailed)
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failed(Self.answerFailed) }
        let held = retriableAnswer
        let key = held.flatMap { $0.questionID == questionID && $0.text == trimmed ? $0.key : nil }
            ?? UUID().uuidString
        retriableAnswer = (questionID, trimmed, key)
        isBusy = true
        defer { isBusy = false }
        do {
            try await client.answer(
                sessionID: sessionID, questionID: questionID, text: trimmed,
                idempotencyKey: key, for: accountID
            )
            retriableAnswer = nil
            await didAct?()
            return .ok()
        } catch {
            return .failed(Self.blockedExplanation(error) ?? Self.answerFailed)
        }
    }

    /// Adds an instruction to the running task. Succeeds only when the server
    /// took it; the composer clears its draft only then.
    public func steer(_ text: String) async -> Outcome {
        guard let sessionID = current?.sessionID else { return .failed(Self.steerFailed) }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failed(Self.steerFailed) }
        let key = retriableSteer.flatMap { $0.text == trimmed ? $0.key : nil } ?? UUID().uuidString
        retriableSteer = (trimmed, key)
        isBusy = true
        defer { isBusy = false }
        do {
            let outcome = try await client.sendInstruction(
                sessionID: sessionID, text: trimmed, idempotencyKey: key, for: accountID
            )
            retriableSteer = nil
            await didAct?()
            return .ok(outcome.explanation)
        } catch {
            return .failed(Self.blockedExplanation(error) ?? Self.steerFailed)
        }
    }

    /// Answers one approval: in process for a run on this Mac, otherwise
    /// through the server with the digest that was on screen. A server card is
    /// cleared at once and put back if the answer did not land and it can
    /// still be answered.
    public func decide(_ approval: Approval, _ decision: JunoWorkApprovalDecision) async -> Outcome {
        if approval.isLocal {
            localApprovalDecider?(approval.request, decision)
            return .ok()
        }
        let index = serverApprovals.firstIndex { $0.approvalID == approval.request.approvalID }
        if let index { serverApprovals.remove(at: index) }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await client.decide(on: approval.request, decision: decision, for: accountID)
            await didAct?()
            return .ok()
        } catch {
            if approval.request.isAnswerable(at: Date()), let index {
                serverApprovals.insert(approval.request, at: min(index, serverApprovals.count))
            }
            return .failed(Self.blockedExplanation(error) ?? Self.decisionFailed)
        }
    }

    /// Ends the task (`control cancel`).
    public func stop() async -> Outcome {
        await control(.stop, failure: Self.stopFailed)
    }

    public func pause() async -> Outcome {
        await control(.pause, failure: Self.controlFailed)
    }

    public func resume() async -> Outcome {
        await control(.resume, failure: Self.controlFailed)
    }

    /// A new attempt at a finished task — the card's Try Again.
    public func tryAgain() async -> Outcome {
        guard let current else { return .failed(Self.controlFailed) }
        isBusy = true
        defer { isBusy = false }
        do {
            let target = JunoWorkTarget(rawValue: current.requestedTarget)
            let started = try await client.startRun(
                sessionID: current.sessionID,
                target: target == .automatic ? nil : target,
                idempotencyKey: UUID().uuidString,
                for: accountID
            )
            run = started
            await didAct?()
            return .ok()
        } catch {
            return .failed(Self.blockedExplanation(error) ?? Self.controlFailed)
        }
    }

    private func control(_ kind: JunoWorkCommandKind, failure: String) async -> Outcome {
        guard let runID = run?.runID ?? current?.currentRunID else {
            return .failed(Self.notReportedIn)
        }
        isBusy = true
        defer { isBusy = false }
        do {
            let updated = try await client.control(
                runID: runID, kind, idempotencyKey: UUID().uuidString, for: accountID
            )
            run = updated
            await didAct?()
            return .ok()
        } catch {
            return .failed(Self.blockedExplanation(error) ?? failure)
        }
    }

    /// The server's own sentence for a refusal it explained (a 4xx with a
    /// message) — the web's `blocked` result. Nil for anything else.
    nonisolated static func blockedExplanation(_ error: any Error) -> String? {
        guard case .server(let status, let message, _)? = error as? WorkRemoteError,
            (400..<500).contains(status)
        else { return nil }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: Copy (the web's, verbatim)

    public static let answerFailed = "Couldn’t send that answer, so Juno hasn’t seen it. Try again."
    public static let steerFailed = "Couldn’t add that to the task. Nothing was recorded."
    public static let decisionFailed = "Couldn’t record your decision, so Juno has not acted on it. Try again."
    public static let notReportedIn = "This task hasn’t reported in yet, so there is nothing to stop. Try again in a moment."
    public static let stopFailed = "Couldn’t reach Juno to stop that. The task is still going."
    /// Pause, Resume and Try Again are the Mac's own (register #57).
    public static let controlFailed = "Couldn’t reach Juno to change that. Try again in a moment."

    // MARK: Fixtures

    /// A follower filled in place, for the snapshot harness and tests: no
    /// stream, no discovery.
    public static func preview(
        conversationID: String,
        client: NativeWorkClient,
        accountID: AccountID,
        current: WorkSessionSummary?,
        history: [WorkSessionSummary] = [],
        run: WorkRunSummary? = nil,
        events: [WorkEvent] = [],
        approvals: [WorkApprovalRequest] = []
    ) -> NativeConversationWork {
        let work = NativeConversationWork(conversationID: conversationID, client: client, accountID: accountID)
        work.current = current
        work.history = history
        work.run = run
        work.events = events
        work.serverApprovals = approvals
        work.hasDiscovered = true
        return work
    }
}
