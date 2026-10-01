import Foundation
import JunoCodeCore

// The run ledger: a per-run, persisted record the stop check reads
// (CODE_AGENT_SPEC §1.2). It is filled from tool side effects and from what
// the runtime itself ran, never from model text, so a check the model claims
// but never ran cannot count.

/// One item of the agent's checklist as the stop check sees it.
public struct TodoItemRef: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var content: String
    public var status: TodoStatus
    public var reason: String?

    public init(id: String, content: String, status: TodoStatus, reason: String? = nil) {
        self.id = id
        self.content = content
        self.status = status
        self.reason = reason
    }

    public init(_ item: TodoItem) {
        self.init(id: item.id, content: item.content, status: item.status, reason: item.reason)
    }
}

/// One time the stop check sent the agent back to work.
public struct ContinuationRecord: Hashable, Codable, Sendable {
    public var reason: GateReason
    /// The fact the continuation named: "2 todos were still open".
    public var detail: String
    /// The workspace revision it was decided at. A reason never fires twice
    /// at the same revision.
    public var revision: Int
    /// The model step it followed.
    public var turnIndex: Int
    /// For `checks_failing`: the check and its first failing line. The same
    /// signature twice in a row does not send the agent back again.
    public var signature: String?

    public init(reason: GateReason, detail: String, revision: Int, turnIndex: Int, signature: String? = nil) {
        self.reason = reason
        self.detail = detail
        self.revision = revision
        self.turnIndex = turnIndex
        self.signature = signature
    }
}

/// What one run did, as the runtime saw it.
public struct RunLedger: Hashable, Codable, Sendable, VerificationLedgerReading {
    public var runID: String
    public var startedAt: Date
    /// One more on every file change, including changes a command made.
    public var workspaceRevision: Int
    public var filesChanged: Set<String>
    /// Lines added and removed across the run's file changes.
    public var linesChanged: Int
    public var lastEditRevision: Int?
    /// Every check, pass or fail, stamped with the revision it ran at.
    public var verifications: [VerificationRecord]
    public var uiVerifications: [UIVerificationRecord]
    public var lastDiffReadRevision: Int?
    public var review: ReviewRecord?
    /// Reviewer passes this run; at most two.
    public var reviewRounds: Int
    /// Checklist items still to do: pending or in progress.
    public var openTodos: [TodoItemRef]
    /// Checklist items the agent marked blocked, each with its reason.
    public var blockedTodos: [TodoItemRef]
    public var continuations: [ContinuationRecord]
    /// Continuation turns in a row that made no tool call.
    public var turnsSinceToolCall: Int
    /// Model steps this run.
    public var steps: Int
    /// Steps the run may take before the wrap-up turn; Keep going adds
    /// another block.
    public var stepAllowance: Int
    /// What the run has spent: minutes, turns, tokens, cost.
    public var usage: BudgetUsage
    /// How many times Keep going raised the run's budget.
    public var budgetGrants: Int
    /// Revisions at which the runtime ran recipe checks itself, so it never
    /// runs the same checks twice for the same state.
    public var autoCheckRevisions: [Int]
    public var endReason: RunEndReason?

    public init(
        runID: String = UUID().uuidString.lowercased(),
        startedAt: Date = Date(),
        stepAllowance: Int = AutonomySettings.standard.stepLimit
    ) {
        self.runID = runID
        self.startedAt = startedAt
        self.workspaceRevision = 0
        self.filesChanged = []
        self.linesChanged = 0
        self.lastEditRevision = nil
        self.verifications = []
        self.uiVerifications = []
        self.lastDiffReadRevision = nil
        self.review = nil
        self.reviewRounds = 0
        self.openTodos = []
        self.blockedTodos = []
        self.continuations = []
        self.turnsSinceToolCall = 0
        self.steps = 0
        self.stepAllowance = stepAllowance
        self.usage = BudgetUsage()
        self.budgetGrants = 0
        self.autoCheckRevisions = []
        self.endReason = nil
    }

    // MARK: - Recording

    /// Takes in one side effect a tool returned, in the order the calls were
    /// made.
    ///
    /// Evidence is stamped with the ledger's revision as it is taken in: a
    /// check made after the batch's edits counts against them, one made
    /// before an edit later in the batch does not.
    public mutating func absorb(_ payload: SessionEventPayload, at date: Date = Date()) {
        switch payload {
        case let .fileChanged(change):
            workspaceRevision += 1
            filesChanged.insert(change.path.value)
            linesChanged += change.linesAdded + change.linesRemoved
            lastEditRevision = workspaceRevision
        case let .testRunCompleted(run):
            verifications.append(
                VerificationRecord(
                    command: run.command,
                    kind: .test,
                    exitCode: run.passed ? 0 : 1,
                    passed: run.passed,
                    workspaceRevision: workspaceRevision,
                    durationMs: Int(run.durationSeconds * 1_000),
                    excerpt: Self.testExcerpt(run),
                    at: date
                )
            )
        case let .verificationRecorded(record):
            recordVerification(record)
        case let .uiVerificationRecorded(record):
            recordUIVerification(record)
        case let .reviewCompleted(record):
            recordReview(record)
        case let .todosUpdated(list):
            openTodos = list.items.filter { $0.status.isOpen }.map(TodoItemRef.init)
            blockedTodos = list.items.filter { $0.status == .blocked }.map(TodoItemRef.init)
        default:
            break
        }
    }

    /// A check result, stamped with the current revision. Idempotent on id.
    public mutating func recordVerification(_ record: VerificationRecord) {
        guard !verifications.contains(where: { $0.id == record.id }) else { return }
        var stamped = record
        stamped.workspaceRevision = workspaceRevision
        verifications.append(stamped)
    }

    public mutating func recordUIVerification(_ record: UIVerificationRecord) {
        guard !uiVerifications.contains(where: { $0.id == record.id }) else { return }
        var stamped = record
        stamped.workspaceRevision = workspaceRevision
        uiVerifications.append(stamped)
    }

    /// A review reads the whole diff, so it counts as a diff read too.
    public mutating func recordReview(_ record: ReviewRecord) {
        var stamped = record
        stamped.workspaceRevision = workspaceRevision
        review = stamped
        reviewRounds = max(reviewRounds + 1, record.round)
        lastDiffReadRevision = workspaceRevision
    }

    /// The model read the diff (`git_diff`).
    public mutating func recordDiffRead() {
        lastDiffReadRevision = workspaceRevision
    }

    /// Notes a tool call the model made that bears on the stop check.
    public mutating func recordToolCall(named name: String, succeeded: Bool) {
        guard succeeded else { return }
        if name == "git_diff" {
            recordDiffRead()
        }
    }

    // MARK: - Reading

    /// Whether `reason` already sent the agent back at the current revision.
    public func hasFired(_ reason: GateReason) -> Bool {
        continuations.contains { $0.reason == reason && $0.revision == workspaceRevision }
    }

    /// The most recent continuation for `reason`, if any.
    public func lastContinuation(for reason: GateReason) -> ContinuationRecord? {
        continuations.last { $0.reason == reason }
    }

    /// The newest fresh result for each check, by recipe id or command.
    public var latestFreshPerCheck: [VerificationRecord] {
        var order: [String] = []
        var latest: [String: VerificationRecord] = [:]
        for record in freshVerifications {
            let key = record.checkID ?? record.command
            if latest[key] == nil { order.append(key) }
            latest[key] = record
        }
        return order.compactMap { latest[$0] }
    }

    /// How a run that is allowed to end ends, from the evidence alone:
    /// blocked when the remaining work was marked blocked, checks failing when
    /// the newest result of a check since the last edit failed, checked when
    /// fresh passing checks cover the state, unchecked otherwise.
    public var verdict: RunEndReason {
        if openTodos.isEmpty, !blockedTodos.isEmpty {
            return .blocked
        }
        let latest = latestFreshPerCheck
        if latest.contains(where: { !$0.passed }) {
            return .checksFailing
        }
        if !latest.isEmpty {
            return .doneChecked
        }
        return .doneUnchecked
    }

    /// The run's minutes so far.
    public func minutes(at date: Date) -> Double {
        max(0, date.timeIntervalSince(startedAt) / 60)
    }

    /// The first ceiling of the run budget, raised by each Keep going, that
    /// the run has reached.
    public func budgetReached(_ budget: Budget, at date: Date) -> BudgetLimit? {
        guard !budget.isUnlimited else { return nil }
        var granted = budget
        for _ in 0..<budgetGrants {
            granted = granted.adding(budget)
        }
        var current = usage
        current.minutes = minutes(at: date)
        return current.reached(granted)
    }

    /// A test run's outcome as an excerpt: what passed or failed.
    static func testExcerpt(_ run: TestRunCompletedEvent) -> String {
        if run.passed {
            if let count = run.testsRun {
                return "\(count) test\(count == 1 ? "" : "s") passed"
            }
            return "passed"
        }
        if let failures = run.failures, failures > 0 {
            return "\(failures) failure\(failures == 1 ? "" : "s")"
        }
        return "failed"
    }
}

/// The run ledger and whether its run is still going, saved at every step
/// boundary at `sessions/<id>/run.json` so a run Juno quit in the middle of
/// can be resumed (§1.12).
public struct RunJournal: Hashable, Codable, Sendable {
    public var ledger: RunLedger
    /// True from the run's first step until it ends. A journal still active
    /// when Juno opens belongs to a run that was interrupted.
    public var active: Bool
    public var updatedAt: Date

    public init(ledger: RunLedger, active: Bool, updatedAt: Date = Date()) {
        self.ledger = ledger
        self.active = active
        self.updatedAt = updatedAt
    }
}

// MARK: - The recorder

/// One session's run ledger, shared by the loop and the recorders.
///
/// The loop takes in each tool batch's side effects; Lane B's checks, Lane C's
/// screen and Simulator evidence and Lane D's Preview checks write through
/// ``VerificationLedgerWriting``. Every record is stamped with the revision it
/// was taken in at, and recorded in the transcript, so evidence is always the
/// runtime's own.
public actor RunLedgerRecorder: VerificationLedgerWriting {
    private let sessionID: CodeSessionID
    private let store: CodeSessionStore?
    public private(set) var ledger: RunLedger
    /// Whether a run is under way, which is what the journal says on disk.
    public private(set) var isActive = false

    public init(sessionID: CodeSessionID, store: CodeSessionStore?, ledger: RunLedger = RunLedger()) {
        self.sessionID = sessionID
        self.store = store
        self.ledger = ledger
    }

    public func snapshot() -> RunLedger { ledger }

    public func currentRevision() -> Int { ledger.workspaceRevision }

    /// Starts a new run's ledger: a new message from the reader is a new task.
    @discardableResult
    public func begin(stepAllowance: Int, at date: Date = Date()) async -> RunLedger {
        ledger = RunLedger(startedAt: date, stepAllowance: stepAllowance)
        isActive = true
        await persist()
        return ledger
    }

    /// Carries the current ledger on for a resumed run: Retry, Keep going,
    /// Resume after quit. Reads the journal when this recorder has nothing
    /// yet, as after a relaunch.
    public func resumeRun(stepAllowance: Int) async {
        let fresh = ledger.steps == 0 && ledger.verifications.isEmpty && ledger.filesChanged.isEmpty
        if fresh, let store, let journal = await store.runJournal(for: sessionID) {
            ledger = journal.ledger
        } else if fresh {
            ledger.stepAllowance = stepAllowance
        }
        ledger.endReason = nil
        isActive = true
        await persist()
    }

    public func update(_ mutate: @Sendable (inout RunLedger) -> Void) {
        mutate(&ledger)
    }

    public func absorb(_ payloads: [SessionEventPayload], at date: Date = Date()) {
        for payload in payloads {
            ledger.absorb(payload, at: date)
        }
    }

    /// The run ended: the journal says so and keeps the ledger for the report
    /// and for a later Keep going.
    public func end(_ reason: RunEndReason) async {
        ledger.endReason = reason
        isActive = false
        await persist()
    }

    /// Writes the journal. Called at every step boundary.
    public func persist() async {
        guard let store else { return }
        try? await store.saveRunJournal(RunJournal(ledger: ledger, active: isActive), for: sessionID)
    }

    // MARK: VerificationLedgerWriting

    public func recordVerification(_ record: VerificationRecord) async {
        guard !ledger.verifications.contains(where: { $0.id == record.id }) else { return }
        ledger.recordVerification(record)
        if let stamped = ledger.verifications.last {
            _ = try? await store?.appendEvent(sessionID: sessionID, payload: .verificationRecorded(stamped))
        }
    }

    public func recordUIVerification(_ record: UIVerificationRecord) async {
        guard !ledger.uiVerifications.contains(where: { $0.id == record.id }) else { return }
        ledger.recordUIVerification(record)
        if let stamped = ledger.uiVerifications.last {
            _ = try? await store?.appendEvent(sessionID: sessionID, payload: .uiVerificationRecorded(stamped))
        }
    }

    public func recordReview(_ record: ReviewRecord) async {
        ledger.recordReview(record)
        if let stamped = ledger.review {
            _ = try? await store?.appendEvent(sessionID: sessionID, payload: .reviewCompleted(stamped))
        }
    }

    public func recordDiffRead(atRevision revision: Int) async {
        ledger.lastDiffReadRevision = max(ledger.lastDiffReadRevision ?? revision, revision)
    }
}

// MARK: - The report

/// Builds the run's report from its ledger: the record the divider, the
/// notification, the runs list, the phone and the web read (§1.10). Lane B's
/// `RunReportBuilder` is the full one; ``LedgerRunReportBuilder`` stands in
/// until it lands.
public protocol RunReportBuilding: Sendable {
    func report(
        endReason: RunEndReason,
        ledger: RunLedger,
        recipe: GateRecipe?,
        summary: String,
        endDetail: String?,
        durationSeconds: Double
    ) async -> RunOutcomeEvent
}

/// The report from the ledger alone: the checks it recorded since the last
/// edit, UI checks and the review, and "not checked since the last edit" when
/// the change has no fresh passing check. Only ledger records can appear under
/// "Checked".
public struct LedgerRunReportBuilder: RunReportBuilding {
    public init() {}

    public func report(
        endReason: RunEndReason,
        ledger: RunLedger,
        recipe _: GateRecipe?,
        summary: String,
        endDetail: String?,
        durationSeconds: Double
    ) async -> RunOutcomeEvent {
        var checks: [RunOutcomeCheck] = ledger.latestFreshPerCheck.map { record in
            RunOutcomeCheck(
                label: record.command,
                passed: record.passed,
                detail: [
                    record.passed ? "passed" : "failed",
                    RunEndWords.seconds(record.durationMs),
                    record.excerpt.isEmpty ? nil : record.excerpt,
                ].compactMap { $0 }.joined(separator: " · "),
                recordID: record.id
            )
        }
        for record in ledger.freshUIVerifications() {
            checks.append(RunOutcomeCheck(
                label: [record.target, record.viewport].compactMap { $0 }.joined(separator: ", "),
                passed: record.passed,
                detail: record.checks.map(\.name).joined(separator: " · "),
                recordID: record.id
            ))
        }
        if let review = ledger.review, review.workspaceRevision == ledger.workspaceRevision {
            let blocking = review.blockingFindings.count
            checks.append(RunOutcomeCheck(
                label: "Review",
                passed: blocking == 0,
                detail: blocking == 0 ? "no correctness findings" : "\(blocking) finding\(blocking == 1 ? "" : "s") to fix",
                recordID: review.id
            ))
        }
        var notChecked: [String] = []
        if !ledger.filesChanged.isEmpty, !ledger.latestFreshPerCheck.contains(where: \.passed) {
            notChecked.append("Not checked since the last edit")
        }
        let left = ledger.review?.findings
            .filter { !$0.priority.isBlocking && $0.criterion == nil }
            .map { "\($0.title) (review, \($0.priority.rawValue.uppercased()))" } ?? []
        return RunOutcomeEvent(
            endReason: endReason,
            summary: RunEndWords.outcomeSentence(summary),
            verification: endDetail,
            checks: checks,
            notChecked: notChecked,
            left: left,
            filesChanged: ledger.filesChanged.count,
            durationSeconds: durationSeconds
        )
    }
}

/// How a run's end is said: in the divider, the report and the notification.
/// Words only, never a status pill.
public enum RunEndWords {
    /// The divider's words after "Worked for …" (§1.3).
    public static func detail(
        for reason: RunEndReason,
        ledger: RunLedger,
        recipe: GateRecipe?,
        stepLimit: Int,
        budget: (limit: BudgetLimit, budget: Budget)? = nil,
        blockedReason: String? = nil,
        waitingOn: [String] = [],
        errorSummary: String? = nil
    ) -> String? {
        switch reason {
        case .doneChecked:
            let passed = ledger.latestFreshPerCheck.filter(\.passed)
            guard let first = passed.first else { return "Checked" }
            let more = passed.count - 1
            return "Checked with `\(first.command)`" + (more > 0 ? " and \(more) more" : "")
        case .doneUnchecked:
            if recipe?.checks.isEmpty ?? true {
                return ledger.filesChanged.isEmpty ? nil : "Not checked: no test command for this project"
            }
            return ledger.filesChanged.isEmpty ? nil : "Not checked since the last edit"
        case .checksFailing:
            guard let failing = ledger.latestFreshPerCheck.last(where: { !$0.passed })
                ?? ledger.verifications.last(where: { !$0.passed })
            else { return "A check still fails" }
            let excerpt = failing.excerpt.isEmpty ? "" : " (\(firstLine(failing.excerpt, limit: 60)))"
            return "`\(failing.command)` still fails\(excerpt)"
        case .blocked:
            if let reason = blockedReason ?? ledger.blockedTodos.first?.reason, !reason.isEmpty {
                return "Blocked: \(firstLine(reason, limit: 120))"
            }
            return "Blocked"
        case .needsYou:
            return "Waiting for you"
        case .stepLimit:
            return "Stopped at \(stepLimit) steps. Keep going?"
        case .budget:
            guard let budget else { return "Used the budget. Keep going?" }
            return "Used the \(budgetWords(budget.limit, budget.budget)) budget. Keep going?"
        case .stalled:
            return "Stopped: no progress in the last two tries"
        case .waitingOnBackground:
            guard let first = waitingOn.first else { return "Waiting for background work to finish" }
            return "Waiting for `\(first)` to finish"
        case .stopped:
            return "Stopped"
        case .interrupted:
            return "Juno quit while this was running"
        case .error:
            return errorSummary.map { firstLine($0, limit: 160) }
        }
    }

    /// "60-minute", "60-turn", "$20".
    static func budgetWords(_ limit: BudgetLimit, _ budget: Budget) -> String {
        switch limit {
        case .minutes: "\(budget.minutes ?? 0)-minute"
        case .turns: "\(budget.turns ?? 0)-turn"
        case .tokens: "\((budget.tokens ?? 0).formatted())-token"
        case .cost: Budget.dollars(budget.costUSD ?? 0)
        }
    }

    /// "11 s", "850 ms", "2m 4s".
    static func seconds(_ milliseconds: Int) -> String {
        if milliseconds < 1_000 { return "\(milliseconds) ms" }
        let seconds = (milliseconds + 500) / 1_000
        if seconds < 60 { return "\(seconds) s" }
        return "\(seconds / 60)m \(seconds % 60)s"
    }

    /// The model's report, cut to its first sentence or line.
    static func outcomeSentence(_ text: String) -> String {
        let line = firstLine(text, limit: 300)
        return line
    }

    static func firstLine(_ text: String, limit: Int) -> String {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n").first ?? ""
        return line.count > limit ? String(line.prefix(limit)) + "…" : line
    }
}
