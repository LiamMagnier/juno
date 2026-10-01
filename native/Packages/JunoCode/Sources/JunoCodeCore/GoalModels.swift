import Foundation

// A goal: a persistent objective with completion criteria that survives turns,
// relaunch and compaction (CODE_AGENT_SPEC §2). After every turn a
// deterministic gate, then a small-model judge, decide whether the agent keeps
// working toward it. A goal never changes the permission mode; the judge can
// only say keep working, met or impossible, never "allowed".
//
// `GoalStatus`, `GoalVerdictKind`, `GoalOrigin` and `CriterionCheck` live in
// SessionEvents.swift beside the events that carry them.

/// What a goal has spent, children included: minutes while active,
/// continuation turns, tokens and cost.
public typealias GoalUsage = BudgetUsage

/// One thing that must hold for the goal to be met.
public struct GoalCriterion: Hashable, Codable, Sendable, Identifiable {
    /// `c1`, `c2` …
    public var id: String
    public var text: String
    public var check: CriterionCheck
    /// Ledger record ids, or `path:line` for a judged criterion, that the
    /// agent or the runtime cited for it.
    public var evidence: [String]

    public init(id: String, text: String, check: CriterionCheck = .judged, evidence: [String] = []) {
        self.id = id
        self.text = text
        self.check = check
        self.evidence = evidence
    }

    public func snapshot(met: Bool? = nil) -> GoalCriterionSnapshot {
        GoalCriterionSnapshot(id: id, text: text, check: check, met: met)
    }

    /// How the criterion is checked, in the reader's words: "the `web-test`
    /// check", "the Preview at /settings", "judged from the conversation".
    public var checkDescription: String {
        switch check {
        case let .command(checkID): "the `\(checkID)` check"
        case let .ui(surface, target):
            switch surface {
            case .web: "the Preview at \(target)"
            case .ios: "the Simulator: \(target)"
            case .mac: "the running app: \(target)"
            }
        case .judged: "judged from the conversation"
        }
    }

    /// How the criterion is checked, as a sentence: "Checked by the
    /// `web-test` check", "Checked in the Preview at /settings", "Judged from
    /// the conversation".
    public var checkSentence: String {
        switch check {
        case .command: "Checked by \(checkDescription)"
        case .ui: "Checked in \(checkDescription)"
        case .judged: "Judged from the conversation"
        }
    }

    /// The tag the `<goal>` section shows: `check web-test`, `ui web /settings`,
    /// `judged`.
    public var checkTag: String {
        switch check {
        case let .command(checkID): "check \(checkID)"
        case let .ui(surface, target): "ui \(surface.rawValue) \(target)"
        case .judged: "judged"
        }
    }
}

/// One check of the goal: what the deterministic gate or the judge concluded.
public struct GoalVerdict: Hashable, Codable, Sendable {
    public var kind: GoalVerdictKind
    /// At most 300 characters, shown in the thread.
    public var reason: String
    public var unmetCriteria: [String]
    /// The workspace revision the goal was checked at.
    public var revision: Int
    public var at: Date

    public init(kind: GoalVerdictKind, reason: String, unmetCriteria: [String] = [], revision: Int, at: Date = Date()) {
        self.kind = kind
        self.reason = String(reason.prefix(GoalVerdictEvent.maximumReasonCharacters))
        self.unmetCriteria = unmetCriteria
        self.revision = revision
        self.at = at
    }
}

/// Permission to run one exact command without asking, for as long as one
/// goal is active, in one worktree (D-012, §1.8).
///
/// A grant is an exact rule subject, not a pattern: `swift test` covers
/// `swift test` and nothing longer. It is evaluated after the reader's deny
/// and ask rules and before the mode ladder, and it can never cover the
/// always-confirm floor, a destructive or network-reaching command, `git
/// push`, a pinned tool, or anything outside the workspace.
public struct TaskGrant: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    /// The exact command line.
    public var command: String
    public var goalID: String
    /// The checkout the grant is bound to.
    public var worktreePath: String

    public init(id: String = UUID().uuidString.lowercased(), command: String, goalID: String, worktreePath: String) {
        self.id = id
        self.command = command.trimmingCharacters(in: .whitespacesAndNewlines)
        self.goalID = goalID
        self.worktreePath = worktreePath
    }

    /// What the start card offers: "May run `swift test` without asking
    /// while this goal is active".
    public var label: String {
        "May run `\(command)` without asking while this goal is active"
    }
}

/// Where the session's spend stood when a goal started, so the goal's own
/// spend is what was added since.
public struct GoalUsageBaseline: Hashable, Codable, Sendable {
    public var tokens: Int
    public var costUSD: Double?

    public init(tokens: Int = 0, costUSD: Double? = nil) {
        self.tokens = tokens
        self.costUSD = costUSD
    }
}

/// A persistent objective with criteria.
public struct GoalRun: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var objective: String
    public var criteria: [GoalCriterion]
    /// "No other test file is modified."
    public var constraints: [String]
    /// The ceilings now in force, raised by each Keep going.
    public var budget: Budget
    /// The budget the goal started with: what Keep going adds again.
    public var originalBudget: Budget
    public var usage: GoalUsage
    public var status: GoalStatus
    /// Why, in words, for `needsYou`, `budgetReached`, `impossible` and
    /// `paused`: "Waiting for you to allow `npm install`".
    public var statusReason: String?
    /// The newest verdicts, at most `keptVerdicts`.
    public var verdicts: [GoalVerdict]
    /// Verdicts older than those kept, folded into a count.
    public var olderVerdictCount: Int
    public var grants: [TaskGrant]
    public var origin: GoalOrigin
    public var createdAt: Date
    public var updatedAt: Date
    /// When the goal last became active, for counting its minutes.
    public var activeSince: Date?
    /// The revision at which the reviewer last ran for this goal. A reviewer
    /// pass is needed once per goal before it can be achieved.
    public var reviewedAtRevision: Int?
    /// Judge calls in a row that failed. Two make the goal need the reader.
    public var consecutiveJudgeFailures: Int
    public var usageBaseline: GoalUsageBaseline

    /// Why a goal that was active when Juno quit is paused.
    public static let interruptedReason = "Juno quit while this goal was running. Resume it to carry on."

    public static let maximumObjectiveCharacters = 4_000
    public static let maximumCriteria = 8
    public static let keptVerdicts = 20

    public init(
        id: String = "g-" + String(UUID().uuidString.lowercased().prefix(8)),
        objective: String,
        criteria: [GoalCriterion] = [],
        constraints: [String] = [],
        budget: Budget = AutonomySettings.standard.goalBudget,
        usage: GoalUsage = GoalUsage(),
        status: GoalStatus = .active,
        statusReason: String? = nil,
        verdicts: [GoalVerdict] = [],
        olderVerdictCount: Int = 0,
        grants: [TaskGrant] = [],
        origin: GoalOrigin = .reader,
        createdAt: Date = Date(),
        updatedAt: Date? = nil,
        activeSince: Date? = nil,
        reviewedAtRevision: Int? = nil,
        consecutiveJudgeFailures: Int = 0,
        usageBaseline: GoalUsageBaseline = GoalUsageBaseline()
    ) {
        let trimmed = objective.trimmingCharacters(in: .whitespacesAndNewlines)
        self.id = id
        self.objective = String(trimmed.prefix(Self.maximumObjectiveCharacters))
        // A goal always has at least one criterion: the objective itself,
        // judged from the conversation, when nothing more specific was drafted.
        let kept = Array(criteria.prefix(Self.maximumCriteria))
        self.criteria = kept.isEmpty
            ? [GoalCriterion(id: "c1", text: self.objective, check: .judged)]
            : kept
        self.constraints = constraints
        self.budget = budget
        self.originalBudget = budget
        self.usage = usage
        self.status = status
        self.statusReason = statusReason
        self.verdicts = verdicts
        self.olderVerdictCount = olderVerdictCount
        self.grants = grants
        self.origin = origin
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.activeSince = activeSince ?? (status == .active ? createdAt : nil)
        self.reviewedAtRevision = reviewedAtRevision
        self.consecutiveJudgeFailures = consecutiveJudgeFailures
        self.usageBaseline = usageBaseline
    }

    public var isActive: Bool { status == .active }

    /// The newest verdict, if any.
    public var lastVerdict: GoalVerdict? { verdicts.last }

    public func criterion(_ id: String) -> GoalCriterion? {
        criteria.first { $0.id == id }
    }

    /// Records a verdict, keeping the newest `keptVerdicts`.
    public mutating func record(_ verdict: GoalVerdict) {
        verdicts.append(verdict)
        if verdicts.count > Self.keptVerdicts {
            let excess = verdicts.count - Self.keptVerdicts
            verdicts.removeFirst(excess)
            olderVerdictCount += excess
        }
        updatedAt = verdict.at
    }

    /// Moves the goal to `next`, keeping its minutes honest: time counts only
    /// while it is active.
    ///
    /// - Throws: ``GoalTransitionError`` for a move the state machine in §2.2
    ///   does not have, such as an achieved goal becoming active again.
    public mutating func transition(to next: GoalStatus, reason: String? = nil, at date: Date = Date()) throws {
        guard status.canTransition(to: next) else {
            throw GoalTransitionError.invalidTransition(from: status, to: next)
        }
        accrueMinutes(until: date)
        status = next
        statusReason = next == .active ? nil : reason
        activeSince = next == .active ? date : nil
        updatedAt = date
    }

    /// Adds the minutes since the goal became active to its usage.
    public mutating func accrueMinutes(until date: Date) {
        guard let since = activeSince, date > since else { return }
        usage.minutes += date.timeIntervalSince(since) / 60
        activeSince = status == .active ? date : nil
    }

    /// The first ceiling of the budget its usage has reached, or nil.
    public func budgetReached(now: Date? = nil) -> BudgetLimit? {
        var current = usage
        if let now, let since = activeSince, now > since {
            current.minutes += now.timeIntervalSince(since) / 60
        }
        return current.reached(budget)
    }

    /// Keep going after a budget: the original budget is added again and the
    /// goal is active.
    public mutating func keepGoing(at date: Date = Date()) throws {
        budget = budget.adding(originalBudget)
        try transition(to: .active, at: date)
    }

    /// The goal as `goal.set` records it.
    public var setEvent: GoalSetEvent {
        GoalSetEvent(
            goalID: id,
            objective: objective,
            criteria: criteria.map { $0.snapshot() },
            constraints: constraints,
            budget: budget,
            origin: origin
        )
    }

    /// The goal as `goal.updated` records it after an edit.
    public var editedEvent: GoalEditedEvent {
        GoalEditedEvent(
            goalID: id,
            objective: objective,
            criteria: criteria.map { $0.snapshot() },
            constraints: constraints,
            budget: budget
        )
    }

    /// The goal as `goal.status` records it.
    public var statusEvent: GoalStatusEvent {
        GoalStatusEvent(goalID: id, status: status, reason: statusReason, usage: usage, budget: budget)
    }
}

public enum GoalTransitionError: Error, Equatable, Sendable {
    case invalidTransition(from: GoalStatus, to: GoalStatus)

    public var message: String {
        switch self {
        case let .invalidTransition(from, to):
            "A goal that is \(from.words) cannot become \(to.words)."
        }
    }
}

public extension GoalStatus {
    /// The state machine in §2.2. Moving to the state a goal is already in is
    /// always allowed, so a repeated command is harmless.
    func canTransition(to next: GoalStatus) -> Bool {
        if self == next { return true }
        switch (self, next) {
        case (.cleared, _):
            return false
        case (_, .cleared):
            return true
        case (.achieved, _), (.impossible, _):
            return false
        case (.active, _):
            return true
        case (.paused, .active), (.paused, .needsYou):
            return true
        case (.needsYou, .active), (.needsYou, .paused), (.needsYou, .budgetReached):
            return true
        case (.budgetReached, .active), (.budgetReached, .paused), (.budgetReached, .needsYou):
            return true
        default:
            return false
        }
    }

    /// "active", "paused", "waiting for you" …
    var words: String {
        switch self {
        case .active: "active"
        case .paused: "paused"
        case .needsYou: "waiting for you"
        case .budgetReached: "out of budget"
        case .achieved: "met"
        case .impossible: "judged impossible"
        case .cleared: "cleared"
        }
    }
}

/// Everything a session knows about goals: the current one, a goal the model
/// proposed that the reader has not started, and past goals, readable in the
/// goal sheet. Stored at `sessions/<id>/goal.json`.
public struct GoalFile: Hashable, Codable, Sendable {
    public var current: GoalRun?
    public var proposal: GoalRun?
    public var history: [GoalRun]

    public static let keptHistory = 20

    public init(current: GoalRun? = nil, proposal: GoalRun? = nil, history: [GoalRun] = []) {
        self.current = current
        self.proposal = proposal
        self.history = history
    }

    /// Moves the current goal to history, keeping the newest `keptHistory`.
    public mutating func retireCurrent() {
        guard let current else { return }
        history.append(current)
        if history.count > Self.keptHistory {
            history.removeFirst(history.count - Self.keptHistory)
        }
        self.current = nil
    }
}

/// What the start card holds before the reader presses Start: the objective,
/// the criteria drafted from it, the budget and the grants offered.
public struct GoalDraft: Hashable, Codable, Sendable {
    public var objective: String
    public var criteria: [GoalCriterion]
    public var constraints: [String]
    public var budget: Budget
    /// Commands the start card offers to run without asking, each unticked
    /// until the reader ticks it.
    public var offeredGrants: [String]
    public var selectedGrants: Set<String>
    public var origin: GoalOrigin

    public init(
        objective: String,
        criteria: [GoalCriterion] = [],
        constraints: [String] = [],
        budget: Budget = AutonomySettings.standard.goalBudget,
        offeredGrants: [String] = [],
        selectedGrants: Set<String> = [],
        origin: GoalOrigin = .reader
    ) {
        self.objective = objective
        self.criteria = criteria
        self.constraints = constraints
        self.budget = budget
        self.offeredGrants = offeredGrants
        self.selectedGrants = selectedGrants
        self.origin = origin
    }

    /// The goal Start creates, active, with grants for the ticked commands
    /// bound to its id and `worktreePath`.
    public func goal(worktreePath: String, at date: Date = Date(), baseline: GoalUsageBaseline = GoalUsageBaseline()) -> GoalRun {
        var goal = GoalRun(
            objective: objective,
            criteria: criteria.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
            constraints: constraints,
            budget: budget,
            origin: origin,
            createdAt: date,
            usageBaseline: baseline
        )
        goal.grants = offeredGrants
            .filter { selectedGrants.contains($0) }
            .map { TaskGrant(command: $0, goalID: goal.id, worktreePath: worktreePath) }
        return goal
    }
}

// MARK: - Migration from the step-based goal

public extension GoalRun {
    /// A goal stored by an earlier build, as a `GoalRun`: its objective is the
    /// goal, achieved when it was complete and paused otherwise, so nothing
    /// starts working on its own after an update.
    static func migrated(from legacy: SessionGoal) -> GoalRun {
        let status: GoalStatus = legacy.lifecycle == .completed ? .achieved : .paused
        let criteria = legacy.verificationEvidence.isEmpty
            ? []
            : [GoalCriterion(
                id: "c1",
                text: legacy.objective,
                check: .judged,
                evidence: legacy.verificationEvidence.map(\.summary)
            )]
        return GoalRun(
            id: legacy.id,
            objective: legacy.objective,
            criteria: criteria,
            budget: Budget(),
            status: status,
            statusReason: status == .paused ? "Carried over from an earlier version of Juno. Resume it to keep working." : nil,
            origin: .reader,
            createdAt: legacy.createdAt,
            updatedAt: legacy.updatedAt
        )
    }

    /// The step-based goal's steps as the checklist the agent keeps with
    /// `todo_write`.
    static func todos(from legacy: SessionGoal) -> [TodoItem] {
        legacy.steps.map { step in
            let status: TodoStatus
            switch step.status {
            case .pending: status = .pending
            case .inProgress: status = .inProgress
            case .completed: status = .completed
            case .blocked: status = .blocked
            }
            return TodoItem(id: step.id, content: step.title, status: status)
        }
    }
}
