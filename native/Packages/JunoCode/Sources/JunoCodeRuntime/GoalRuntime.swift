import Foundation
import JunoCodeCore

// Goal mode's runtime (CODE_AGENT_SPEC §2.4–§2.7): the deterministic part of
// the goal check, the judge, the verdicts and status changes they cause, the
// goal's spend, and the check-in cadence for background work. The goal never
// changes the permission mode, and the judge can only decide whether the
// agent keeps working.

/// What the goal's deterministic part found.
public struct GoalDeterministicResult: Equatable, Sendable {
    /// What is missing, in words: "c2 has no Preview evidence since the last edit".
    public var misses: [String]
    /// The criteria the misses concern.
    public var unmetCriteria: [String]
    /// Criteria with fresh evidence.
    public var metCriteria: [String]
    /// Recipe checks the runtime can run itself to settle a criterion.
    public var checksToRun: [String]
    /// The goal still needs its one reviewer pass.
    public var needsReview: Bool

    public init(
        misses: [String] = [],
        unmetCriteria: [String] = [],
        metCriteria: [String] = [],
        checksToRun: [String] = [],
        needsReview: Bool = false
    ) {
        self.misses = misses
        self.unmetCriteria = unmetCriteria
        self.metCriteria = metCriteria
        self.checksToRun = checksToRun
        self.needsReview = needsReview
    }
}

/// When to check in on background work that keeps a goal waiting: after
/// `checkInMinutes`, then twice as long each time up to four times the first
/// interval, and at most three idle check-ins between the reader's messages.
public struct CheckInSchedule: Equatable, Sendable {
    public var firstInterval: TimeInterval
    public static let maximumIdleCheckIns = 3

    public init(checkInMinutes: Int) {
        firstInterval = TimeInterval(max(1, checkInMinutes)) * 60
    }

    /// The wait before check-in number `index` (0 for the first).
    public func interval(forCheckIn index: Int) -> TimeInterval {
        let factor = min(pow(2, Double(max(0, index))), 4)
        return firstInterval * factor
    }

    /// When the next check-in is due, or nil once the idle ones are spent.
    public func nextDue(waitingSince start: Date, idleCheckIns: Int) -> Date? {
        guard idleCheckIns < Self.maximumIdleCheckIns else { return nil }
        var due = start
        for index in 0...idleCheckIns {
            due = due.addingTimeInterval(interval(forCheckIn: index))
        }
        return due
    }
}

/// One session's goal runtime.
public actor GoalRuntime {
    private let sessionID: CodeSessionID
    private let store: CodeSessionStore
    private let judge: (any CompletionJudging)?
    /// The injected clock, so tests decide what time it is.
    public nonisolated let clock: @Sendable () -> Date
    /// The session's spend so far, for the goal's own: tokens and cost.
    private let spend: @Sendable () async -> GoalUsageBaseline

    public init(
        sessionID: CodeSessionID,
        store: CodeSessionStore,
        judge: (any CompletionJudging)?,
        clock: @escaping @Sendable () -> Date = { Date() },
        spend: @escaping @Sendable () async -> GoalUsageBaseline = { GoalUsageBaseline() }
    ) {
        self.sessionID = sessionID
        self.store = store
        self.judge = judge
        self.clock = clock
        self.spend = spend
    }

    // MARK: - The deterministic part

    /// Every `.command` criterion needs a fresh passing check, every `.ui`
    /// criterion a fresh UI check, no todo may be open, and the goal needs one
    /// reviewer pass when a reviewer exists. Pure: the judge is never asked
    /// while anything here is missing.
    public static func evaluateDeterministic(
        goal: GoalRun,
        ledger: RunLedger,
        recipe: GateRecipe?,
        situation: GateSituation,
        runChecksAutomatically: Bool
    ) -> GoalDeterministicResult {
        var result = GoalDeterministicResult()
        for criterion in goal.criteria {
            switch criterion.check {
            case let .command(checkID):
                let fresh = ledger.freshVerifications.last { record in
                    record.checkID == checkID || recipe?.check(for: record)?.id == checkID
                }
                if let fresh, fresh.passed {
                    result.metCriteria.append(criterion.id)
                    continue
                }
                let check = recipe?.check(id: checkID)
                if fresh == nil,
                   let check,
                   runChecksAutomatically,
                   situation.checkRunnerAvailable,
                   check.runsWithoutPrompt,
                   !ledger.autoCheckRevisions.contains(ledger.workspaceRevision)
                {
                    result.checksToRun.append(checkID)
                    continue
                }
                result.unmetCriteria.append(criterion.id)
                let command = check.map { "`\($0.command)`" } ?? "`\(checkID)`"
                result.misses.append(fresh == nil
                    ? "\(criterion.id) needs a passing \(command) since the last edit"
                    : "\(criterion.id): \(command) failed")
            case let .ui(surface, target):
                let records = ledger.freshUIVerifications(surface: surface, target: target)
                if records.contains(where: \.passed) {
                    result.metCriteria.append(criterion.id)
                } else {
                    result.unmetCriteria.append(criterion.id)
                    let place: String
                    switch surface {
                    case .web: place = "Preview"
                    case .ios: place = "Simulator"
                    case .mac: place = "running-app"
                    }
                    result.misses.append(records.isEmpty
                        ? "\(criterion.id) has no \(place) evidence for \(target) since the last edit"
                        : "\(criterion.id): the \(place) check of \(target) failed")
                }
            case .judged:
                continue
            }
        }
        if !ledger.openTodos.isEmpty {
            let count = ledger.openTodos.count
            result.misses.append("\(count) todo\(count == 1 ? " is" : "s are") still open")
        }
        result.checksToRun = Array(Set(result.checksToRun)).sorted()
        result.needsReview = situation.reviewerAvailable
            && !ledger.filesChanged.isEmpty
            && goal.reviewedAtRevision == nil
            && ledger.reviewRounds < CompletionGate.maximumReviewRounds
        return result
    }

    // MARK: - Reading and writing the goal

    public func currentGoal() async -> GoalRun? {
        await store.goalFile(for: sessionID).current
    }

    /// Applies `change` to the current goal and records what changed.
    @discardableResult
    func updateCurrent(
        _ record: GoalChangeRecord,
        _ change: @Sendable (inout GoalRun) throws -> Void
    ) async -> GoalRun? {
        try? await store.updateCurrentGoal(for: sessionID, record: record, change)
    }

    /// The goal's spend brought up to now: minutes while active, tokens and
    /// cost since it started.
    public func accrueUsage() async {
        let now = clock()
        let spent = await spend()
        await updateCurrent(.silent) { goal in
            goal.accrueMinutes(until: now)
            goal.usage.tokens = max(0, spent.tokens - goal.usageBaseline.tokens)
            if let cost = spent.costUSD {
                goal.usage.costUSD = max(0, cost - (goal.usageBaseline.costUSD ?? 0))
            }
        }
    }

    /// One more continuation turn toward the goal.
    public func noteTurn() async {
        await updateCurrent(.silent) { goal in
            goal.usage.turns += 1
        }
    }

    /// The first ceiling of the goal's budget it has reached, or nil.
    public func budgetReached() async -> (limit: BudgetLimit, budget: Budget, goalID: String, usage: GoalUsage)? {
        await accrueUsage()
        guard let goal = await currentGoal(), goal.isActive,
              let limit = goal.budgetReached(now: clock())
        else { return nil }
        return (limit, goal.budget, goal.id, goal.usage)
    }

    /// The goal ran out of budget after its wrap-up turn.
    public func markBudgetReached(limit: BudgetLimit) async {
        let now = clock()
        await updateCurrent(.status) { goal in
            guard goal.isActive else { return }
            try goal.transition(to: .budgetReached, reason: "Used the goal's \(RunEndWords.budgetWords(limit, goal.budget)) budget", at: now)
        }
    }

    /// The goal waits on the reader, for `reason`, in words.
    public func markNeedsYou(_ reason: String) async {
        let now = clock()
        await updateCurrent(.status) { goal in
            guard goal.status == .active || goal.status == .needsYou else { return }
            try goal.transition(to: .needsYou, reason: reason, at: now)
        }
    }

    /// How a goal waiting on an approval says so.
    public static let approvalWaitPrefix = GoalRun.approvalWaitPrefix

    /// The run asked the reader for an approval: an active goal waits on
    /// them, and says what for. A goal already waiting on the reader for
    /// another reason — blocked, stalled, a failed judge — keeps that reason,
    /// so answering this approval never makes it active again.
    public func markWaitingOnApproval(_ summary: String) async {
        let now = clock()
        await updateCurrent(.status) { goal in
            guard goal.isActive || goal.isWaitingOnApproval else { return }
            try goal.transition(to: .needsYou, reason: Self.approvalWaitPrefix + summary, at: now)
        }
    }

    /// The reader answered what the goal was waiting on: it is active again.
    /// With a prefix, only a wait whose reason starts with it is cleared, so
    /// answering an approval never clears a goal blocked for another reason.
    public func clearNeedsYou(ifReasonHasPrefix prefix: String? = nil) async {
        let now = clock()
        await updateCurrent(.status) { goal in
            guard goal.status == .needsYou else { return }
            if let prefix, !(goal.statusReason ?? "").hasPrefix(prefix) { return }
            try goal.transition(to: .active, at: now)
        }
    }

    /// The reader pressed Stop: the goal pauses, it is not cleared.
    public func pauseForStop() async {
        let now = clock()
        await updateCurrent(.status) { goal in
            guard goal.isActive || goal.status == .needsYou else { return }
            try goal.transition(to: .paused, reason: "Stopped by you", at: now)
        }
    }

    /// The reviewer ran while the goal was active.
    public func noteReviewed(atRevision revision: Int) async {
        await updateCurrent(.silent) { goal in
            goal.reviewedAtRevision = revision
        }
    }

    /// A `gate_blocked` verdict: the deterministic part found misses.
    public func recordGateBlocked(reason: String, unmet: [String], revision: Int) async {
        let verdict = GoalVerdict(kind: .gateBlocked, reason: reason, unmetCriteria: unmet, revision: revision, at: clock())
        await updateCurrent(.verdict(verdict)) { goal in
            goal.record(verdict)
        }
    }

    /// How the run ending affects the goal (§2.6): a reader Stop pauses it,
    /// an error or a stall makes it wait on the reader, a step limit too.
    public func runEnded(_ reason: RunEndReason, detail: String?) async {
        switch reason {
        case .stopped:
            await pauseForStop()
        case .error:
            await markNeedsYou(detail.map { "Stopped on an error: \($0)" } ?? "Stopped on an error")
        case .stalled:
            await markNeedsYou("Stopped after two turns without progress")
        case .stepLimit:
            await markNeedsYou(detail ?? "Stopped at the step limit")
        case .blocked:
            guard let goal = await currentGoal(), goal.isActive else { return }
            await markNeedsYou(detail ?? "Blocked")
        case .doneChecked, .doneUnchecked, .checksFailing, .needsYou, .budget,
             .waitingOnBackground, .interrupted:
            break
        }
        await accrueUsage()
    }

    // MARK: - The judge

    /// Asks the judge, records its verdict and moves the goal: met ends the run
    /// checked, impossible ends it blocked, not met sends the agent back with
    /// the goal audit. A failed call is tried once more; after that the
    /// deterministic result stands alone for this turn, and two failed turns
    /// in a row make the goal wait on the reader.
    public func judge(goal: GoalRun, ledger: RunLedger, recipe: GateRecipe?, recentMessages: [ModelMessage], lastReport: String?) async -> GateDecision {
        let input = Self.judgeInput(goal: goal, ledger: ledger, recipe: recipe, recentMessages: recentMessages, lastReport: lastReport)
        var verdict: GoalVerdict?
        if let judge {
            for _ in 0..<2 {
                if let answer = try? await judge.judge(input) {
                    verdict = answer
                    break
                }
                if Task.isCancelled { break }
            }
        }
        let now = clock()
        guard var verdict else {
            let failures = goal.consecutiveJudgeFailures + 1
            if failures >= 2 {
                let reason = "Juno could not check the goal twice in a row"
                await updateCurrent(.status) { current in
                    current.consecutiveJudgeFailures = failures
                    current.record(GoalVerdict(kind: .notMet, reason: reason, revision: ledger.workspaceRevision, at: now))
                    try current.transition(to: .needsYou, reason: reason, at: now)
                }
                return .finish(.needsYou)
            }
            let reason = "Juno could not check the goal this turn"
            let fallback = GoalVerdict(kind: .notMet, reason: reason, revision: ledger.workspaceRevision, at: now)
            await updateCurrent(.verdict(fallback)) { current in
                current.consecutiveJudgeFailures = failures
                current.record(fallback)
            }
            return .continueWith(.goalNotMet, detail: reason + "; audit each criterion against the evidence yourself")
        }
        verdict.revision = ledger.workspaceRevision
        verdict.at = now
        let recorded = verdict
        switch verdict.kind {
        case .met:
            await updateCurrent(.verdictAndStatus(recorded)) { current in
                current.consecutiveJudgeFailures = 0
                current.record(recorded)
                try current.transition(to: .achieved, at: now)
            }
            return .finish(.doneChecked)
        case .impossible:
            await updateCurrent(.verdictAndStatus(recorded)) { current in
                current.consecutiveJudgeFailures = 0
                current.record(recorded)
                try current.transition(to: .impossible, reason: recorded.reason, at: now)
            }
            return .finish(.blocked)
        case .notMet, .gateBlocked:
            await updateCurrent(.verdict(recorded)) { current in
                current.consecutiveJudgeFailures = 0
                current.record(recorded)
            }
            let unmet = recorded.unmetCriteria.isEmpty ? "" : " (unmet: \(recorded.unmetCriteria.joined(separator: ", ")))"
            // The judge read the transcript, tool output and all: its reason
            // reaches the agent quoted, as data inside Juno's note.
            let said = recorded.reason.isEmpty
                ? "the judge found it not met"
                : "the judge said \(RuntimeContinuation.quoted(recorded.reason, limit: GoalVerdictEvent.maximumReasonCharacters))"
            return .continueWith(.goalNotMet, detail: said + unmet)
        }
    }

    /// What the judge reads: the goal, the evidence and the end of the
    /// conversation, escaped like a compaction transcript.
    static func judgeInput(goal: GoalRun, ledger: RunLedger, recipe: GateRecipe?, recentMessages: [ModelMessage], lastReport: String?) -> JudgeInput {
        let criteria = goal.criteria.map { criterion -> GoalCriterion in
            var resolved = criterion
            // What the agent cited with `update_goal` is its own claim, kept
            // apart from what Juno recorded so the judge never reads one as
            // the other.
            resolved.evidence = criterion.evidence.map { "cited by the agent, not verified by Juno: \($0)" }
            switch criterion.check {
            case let .command(checkID):
                resolved.evidence += ledger.freshVerifications
                    .filter { $0.checkID == checkID || recipe?.check(for: $0)?.id == checkID }
                    .map { "recorded by Juno: \($0.command) \($0.passed ? "passed" : "failed") at revision \($0.workspaceRevision) (\($0.id))" }
            case let .ui(surface, target):
                resolved.evidence += ledger.freshUIVerifications(surface: surface, target: target)
                    .map { "recorded by Juno: \($0.target) \($0.passed ? "passed" : "failed") \($0.checks.map(\.name).joined(separator: ", ")) (\($0.id))" }
            case .judged:
                break
            }
            return resolved
        }
        return JudgeInput(
            objective: goal.objective,
            criteria: criteria,
            constraints: goal.constraints,
            ledgerSummary: ledgerSummary(ledger),
            transcriptTail: CompactionSummarizer.transcript(
                of: recentMessages,
                maximumCharacters: JudgeInput.maximumTranscriptCharacters
            ),
            lastReport: lastReport
        )
    }

    /// The ledger in a few lines.
    static func ledgerSummary(_ ledger: RunLedger) -> String {
        var lines = ["Workspace revision \(ledger.workspaceRevision); \(ledger.filesChanged.count) files changed this run."]
        if ledger.verifications.isEmpty {
            lines.append("No checks ran this run.")
        }
        for record in ledger.verifications.suffix(8) {
            let freshness = ledger.isFresh(record) ? "after the last edit" : "before the last edit"
            lines.append("- \(record.command): \(record.passed ? "passed" : "failed") at revision \(record.workspaceRevision), \(freshness)")
        }
        for record in ledger.uiVerifications.suffix(4) {
            lines.append("- UI \(record.surface.rawValue) \(record.target): \(record.passed ? "passed" : "failed") at revision \(record.workspaceRevision)")
        }
        if let review = ledger.review {
            lines.append("- Review round \(review.round): \(review.blockingFindings.count) blocking findings at revision \(review.workspaceRevision)")
        }
        if !ledger.openTodos.isEmpty {
            lines.append("- \(ledger.openTodos.count) todos open")
        }
        return lines.joined(separator: "\n")
    }
}

/// What a goal change records in the transcript.
public enum GoalChangeRecord: Sendable {
    /// Nothing: spend and bookkeeping the progress row reads from the file,
    /// or a change whose event the caller records itself.
    case silent
    /// `goal.status`.
    case status
    /// `goal.verdict`.
    case verdict(GoalVerdict)
    /// `goal.verdict`, then `goal.status`.
    case verdictAndStatus(GoalVerdict)
    /// `goal.updated`.
    case edited
}

// MARK: - The gate with the goal

/// The stop check the app runs: the rules (``CompletionGate``), then the goal
/// runtime's judge when every rule passes and a goal is active.
public actor AutonomyGate: CompletionGating {
    private let settings: AutonomySettings
    private let recipe: @Sendable () async -> GateRecipe?
    private let goals: GoalRuntime?

    public init(
        settings: AutonomySettings,
        recipe: @escaping @Sendable () async -> GateRecipe? = { nil },
        goals: GoalRuntime? = nil
    ) {
        self.settings = settings
        self.recipe = recipe
        self.goals = goals
    }

    public func evaluate(_ context: CompletionGateContext) async -> GateDecision {
        guard let ledger = context.ledger else {
            return .finish(context.reportedVerdict)
        }
        let recipe = await recipe()
        let goal = await goals?.currentGoal()
        let step = CompletionGate(settings: settings).evaluate(
            ledger,
            recipe: recipe,
            goal: goal,
            situation: context.situation
        )
        switch step {
        case let .decided(decision):
            return decision
        case let .goalBlocked(decision, unmet, reason):
            await goals?.recordGateBlocked(reason: reason, unmet: unmet, revision: ledger.workspaceRevision)
            return decision
        case .judge:
            guard let goals, let goal else { return .finish(ledger.verdict) }
            return await goals.judge(
                goal: goal,
                ledger: ledger,
                recipe: recipe,
                recentMessages: context.recentMessages,
                lastReport: context.lastAssistantText
            )
        }
    }
}
