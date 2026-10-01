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

    public init(
        sessionID: CodeSessionID,
        steps: Int,
        filesChanged: Set<String>,
        testsPassed: Bool?,
        lastAssistantText: String,
        continuations: [GateReason],
        turnsSinceToolCall: Int
    ) {
        self.sessionID = sessionID
        self.steps = steps
        self.filesChanged = filesChanged
        self.testsPassed = testsPassed
        self.lastAssistantText = lastAssistantText
        self.continuations = continuations
        self.turnsSinceToolCall = turnsSinceToolCall
    }

    /// The verdict from what this context knows, with nothing enforced: what
    /// a run that is allowed to end ends as.
    public var reportedVerdict: RunEndReason {
        switch testsPassed {
        case true?: .doneChecked
        case false?: .checksFailing
        case nil: .doneUnchecked
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
