import Foundation

/// High-level execution state for a coding task, providing clear visibility
/// into what the agent is doing right now and why.
public enum TaskExecutionState: Hashable, Codable, Sendable {
    /// The session is idle and waiting for user instruction.
    case idle

    /// The agent is actively analyzing requirements or formulating a structured plan.
    case planning(objective: String)

    /// The agent is actively executing turns or tools.
    case executing(summary: String)

    /// Execution is safely suspended waiting for user authorization.
    case awaitingApproval(approvalID: String, summary: String, risk: ActionRisk)

    /// The agent has finished modifications and is actively running verification
    /// (builds, tests, linters, or previews).
    case verifying(command: String?)

    /// The task completed with verifiable evidence.
    case completed(outcome: VerificationOutcome)

    /// The task failed with a structured, actionable error.
    case failed(error: CodeExecutionError)

    /// The task execution was cancelled by the user.
    case cancelled
}

/// Structured outcome of task verification.
public enum VerificationOutcome: Hashable, Codable, Sendable {
    case passed(summary: String)
    case passedWithWarnings(summary: String)
    case failedVerification(reason: String)
    case unverified(reason: String)

    public var isSuccess: Bool {
        switch self {
        case .passed, .passedWithWarnings:
            return true
        case .failedVerification, .unverified:
            return false
        }
    }
}

/// Error category taxonomy for mapping technical failures into actionable UI.
public enum CodeErrorCategory: String, Hashable, Codable, Sendable {
    case quotaExhausted = "QUOTA_EXHAUSTED"
    case rateLimited = "RATE_LIMITED"
    case authRequired = "AUTH_REQUIRED"
    case providerUnavailable = "PROVIDER_UNAVAILABLE"
    case transportTimeout = "TRANSPORT_TIMEOUT"
    case toolFailed = "TOOL_FAILED"
    case permissionDenied = "PERMISSION_DENIED"
    case worktreeConflict = "WORKTREE_CONFLICT"
    case buildFailed = "BUILD_FAILED"
    case testFailed = "TEST_FAILED"
    case contextLimitExceeded = "CONTEXT_LIMIT_EXCEEDED"
    case remoteHostOffline = "REMOTE_HOST_OFFLINE"
    case unknown = "UNKNOWN"
}

/// Suggested next action for error recovery in the user interface.
public enum ErrorRecoveryAction: String, Hashable, Codable, Sendable {
    case retry = "RETRY"
    case switchModel = "SWITCH_MODEL"
    case reviewApproval = "REVIEW_APPROVAL"
    case reconnect = "RECONNECT"
    case inspectDetails = "INSPECT_DETAILS"
    case dismiss = "DISMISS"
}

/// A structured error that maps technical agent/transport/tool failures
/// into honest, human-readable UI with clear recovery options.
public struct CodeExecutionError: Hashable, Codable, Sendable {
    public let category: CodeErrorCategory
    public let message: String
    public let providerOrModelID: String?
    public let isRecoverable: Bool
    public let recommendedAction: ErrorRecoveryAction
    public let technicalDetails: String?

    public init(
        category: CodeErrorCategory,
        message: String,
        providerOrModelID: String? = nil,
        isRecoverable: Bool = true,
        recommendedAction: ErrorRecoveryAction = .retry,
        technicalDetails: String? = nil
    ) {
        self.category = category
        self.message = message
        self.providerOrModelID = providerOrModelID
        self.isRecoverable = isRecoverable
        self.recommendedAction = recommendedAction
        self.technicalDetails = technicalDetails
    }
}
