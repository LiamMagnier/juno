import Foundation
import JunoCodeCore

// The seam between the agent loop and the stop check.
//
// The model's end of turn is a proposal; the runtime decides whether the run
// ends (CODE_AGENT_SPEC §1.1). `AgentOrchestrator` asks an injected
// `CompletionGating` every time the model tries to finish, after queued
// instructions drain and before reader-authored Stop hooks. Lane A's
// `CompletionGate` (CompletionGate.swift) is the real one; until it lands the
// orchestrator uses `ReportOnlyCompletionGate`, which is today's behaviour.

/// What the stop check decided.
public enum GateDecision: Equatable, Sendable {
    /// The run may end, for this reason.
    case finish(RunEndReason)
    /// Send the model back to work with a runtime note naming `detail`.
    case continueWith(GateReason, detail: String)
    /// The runtime runs these recipe checks itself, then asks again.
    case runCheck(checkIDs: [String])
    /// The runtime runs the reviewer pass, then asks again.
    case runReview
    /// Background work still runs; the run waits for it.
    case wait
}

/// What the orchestrator knows when the model tries to finish.
///
/// Lane A widens this with the run ledger, the verify recipe and the goal as
/// they land; a gate reads what it needs and ignores the rest.
public struct CompletionGateContext: Sendable {
    public var sessionID: CodeSessionID
    /// Model steps this run, the one that just ended included.
    public var steps: Int
    /// Workspace paths the run's tools changed.
    public var filesChanged: Set<String>
    /// The last test run's outcome this run, when one ran.
    public var testsPassed: Bool?
    /// The model's last reply, which it means as its report.
    public var lastAssistantText: String
    /// The gate continuations this run has already had, in order.
    public var continuations: [GateReason]
    /// Gate continuations in a row, ending with the one that just finished,
    /// that made no tool call.
    public var turnsSinceToolCall: Int
    /// The run ledger: every edit, check, UI check, review and todo the run's
    /// tools recorded. Nil only for a caller that keeps none.
    public var ledger: RunLedger?
    /// What is waiting on the reader, the mode, background work and which
    /// runners exist.
    public var situation: GateSituation
    /// The end of the conversation, for a goal judge.
    public var recentMessages: [ModelMessage]

    public init(
        sessionID: CodeSessionID,
        steps: Int,
        filesChanged: Set<String>,
        testsPassed: Bool?,
        lastAssistantText: String,
        continuations: [GateReason],
        turnsSinceToolCall: Int,
        ledger: RunLedger? = nil,
        situation: GateSituation = GateSituation(),
        recentMessages: [ModelMessage] = []
    ) {
        self.sessionID = sessionID
        self.steps = steps
        self.filesChanged = filesChanged
        self.testsPassed = testsPassed
        self.lastAssistantText = lastAssistantText
        self.continuations = continuations
        self.turnsSinceToolCall = turnsSinceToolCall
        self.ledger = ledger
        self.situation = situation
        self.recentMessages = recentMessages
    }

    /// The verdict from what this context knows, with nothing enforced: what
    /// a run that is allowed to end ends as.
    public var reportedVerdict: RunEndReason {
        if let ledger { return ledger.verdict }
        switch testsPassed {
        case true?: return .doneChecked
        case false?: return .checksFailing
        case nil: return .doneUnchecked
        }
    }
}

/// Decides whether a run that the model means to end may end.
///
/// A gate never changes permissions: a check it wants run still goes through
/// `PermissionCoordinator`, and it can only keep the agent working inside what
/// is already allowed.
public protocol CompletionGating: Sendable {
    func evaluate(_ context: CompletionGateContext) async -> GateDecision
}

/// Today's behaviour: report, never enforce. Every end of turn finishes, with
/// the verdict the context supports (autonomy level `off`).
public struct ReportOnlyCompletionGate: CompletionGating {
    public init() {}

    public func evaluate(_ context: CompletionGateContext) async -> GateDecision {
        .finish(context.reportedVerdict)
    }
}

// MARK: - Runners the stop check can call on

/// Runs the project's checks for the stop check (`runCheck`). Lane B's
/// `run_checks` provides the real one. It must authorize every command through
/// `PermissionCoordinator` like any other: a gate that wants a check run never
/// gets to skip an approval.
public protocol GateCheckRunning: Sendable {
    /// Runs the recipe checks with these ids and returns what ran, pass or
    /// fail. A check that was refused or could not start returns nothing.
    func runChecks(ids: [String], sessionID: CodeSessionID) async -> [VerificationRecord]
    /// Whether the runner already wrote its records (and the file changes
    /// its commands made) to the transcript, stamped with the transcript's
    /// revision, as Lane B's `CheckRunner.runAndRecord` does. The loop then
    /// only takes them into the run ledger; otherwise it records them too.
    var recordsEvidence: Bool { get }
}

public extension GateCheckRunning {
    var recordsEvidence: Bool { false }
}

/// Runs the read-only reviewer sub-agent over the diff for the stop check
/// (`runReview`, §1.9). Lane B provides the real one.
public protocol GateReviewRunning: Sendable {
    func review(sessionID: CodeSessionID, ledger: RunLedger, goal: GoalRun?) async -> ReviewRecord?
    /// Whether the runner already wrote the review to the transcript (Lane
    /// B's `ReviewPass` does).
    var recordsEvidence: Bool { get }
}

public extension GateReviewRunning {
    var recordsEvidence: Bool { false }
}

/// Everything the loop needs to run autonomously: the settings, the ledger
/// shared with the recorders, the goal runtime and the runners. Nil in an
/// orchestrator's configuration means none of it: the stop check alone
/// decides, the step limit is still soft, and nothing is budgeted.
public struct AutonomyConfiguration: Sendable {
    public var settings: AutonomySettings
    /// The session's behaviour. Only Code continues; Plan, Ask and Survey
    /// promise that nothing runs, so the stop check only reports for them.
    public var behavior: AgentBehavior
    /// The session's ledger, which recorders write through too. Nil makes the
    /// orchestrator keep its own.
    public var ledger: RunLedgerRecorder?
    public var goals: GoalRuntime?
    public var recipe: @Sendable () async -> GateRecipe?
    public var checkRunner: (any GateCheckRunning)?
    public var reviewRunner: (any GateReviewRunning)?
    public var reportBuilder: any RunReportBuilding
    /// Background shells and sub-agents the run should wait on, in words.
    public var backgroundWork: @Sendable () async -> [String]
    /// A model's rates, for the run's cost.
    public var pricing: @Sendable (String) -> CodeUsagePricing?
    /// Whether the workspace is a Git repository, so the agent can read its
    /// diff. The stop check asks for a diff read only where one is possible.
    public var diffAvailable: Bool
    public var clock: @Sendable () -> Date

    public init(
        settings: AutonomySettings = .standard,
        behavior: AgentBehavior = .code,
        ledger: RunLedgerRecorder? = nil,
        goals: GoalRuntime? = nil,
        recipe: @escaping @Sendable () async -> GateRecipe? = { nil },
        checkRunner: (any GateCheckRunning)? = nil,
        reviewRunner: (any GateReviewRunning)? = nil,
        reportBuilder: any RunReportBuilding = LedgerRunReportBuilder(),
        backgroundWork: @escaping @Sendable () async -> [String] = { [] },
        pricing: @escaping @Sendable (String) -> CodeUsagePricing? = { _ in nil },
        diffAvailable: Bool = true,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.settings = settings
        self.behavior = behavior
        self.ledger = ledger
        self.goals = goals
        self.recipe = recipe
        self.checkRunner = checkRunner
        self.reviewRunner = reviewRunner
        self.reportBuilder = reportBuilder
        self.backgroundWork = backgroundWork
        self.pricing = pricing
        self.diffAvailable = diffAvailable
        self.clock = clock
    }
}
