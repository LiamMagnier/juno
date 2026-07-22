import Foundation

/// The four user-selectable permission modes for a session.
public enum PermissionMode: String, Codable, CaseIterable, Sendable {
    /// The agent may only read and search; every mutation is refused.
    case readOnly
    /// Every edit and every command requires an explicit approval.
    case askBeforeChanges
    /// Edits inside the workspace proceed; risky actions still require approval.
    case workspaceWrite
    /// Most actions proceed; critical actions always require approval.
    case fullAccess
}

/// Risk classification attached to every proposed tool action.
public enum ActionRisk: String, Codable, CaseIterable, Sendable, Comparable {
    /// Reading or searching inside the workspace.
    case read
    /// Creating or modifying files inside the workspace.
    case write
    /// Running a command whose effects are bounded to the workspace.
    case execute
    /// Destructive, escaping, networked, or privilege-elevating actions.
    /// These always require explicit approval, in every mode.
    case critical

    private var rank: Int {
        switch self {
        case .read: return 0
        case .write: return 1
        case .execute: return 2
        case .critical: return 3
        }
    }

    public static func < (lhs: ActionRisk, rhs: ActionRisk) -> Bool {
        lhs.rank < rhs.rank
    }
}

public enum PermissionRuling: Equatable, Sendable {
    /// The action may proceed without asking.
    case allow
    /// The action must be approved by the user before proceeding.
    case requireApproval
    /// The action is refused outright in this mode.
    case deny(reason: String)
}

/// Pure policy: maps a session permission mode and an action risk to a ruling.
/// Critical actions require approval in every mode, including full access.
public enum PermissionPolicy {
    public static func ruling(mode: PermissionMode, risk: ActionRisk) -> PermissionRuling {
        switch (mode, risk) {
        case (_, .critical):
            return .requireApproval
        case (.readOnly, .read):
            return .allow
        case (.readOnly, _):
            return .deny(reason: "The session is read-only.")
        case (.askBeforeChanges, .read):
            return .allow
        case (.askBeforeChanges, _):
            return .requireApproval
        case (.workspaceWrite, .read), (.workspaceWrite, .write):
            return .allow
        case (.workspaceWrite, .execute):
            return .requireApproval
        case (.fullAccess, _):
            return .allow
        }
    }
}

public enum ApprovalDecision: String, Codable, Sendable {
    case approved
    case denied
}

/// A pending approval binding the user's answer to one exact action.
public struct ApprovalRequest: Hashable, Codable, Sendable {
    public let id: String
    public let sessionID: CodeSessionID
    /// SHA-256 hex digest of the canonical action payload.
    public let actionDigest: String
    public let toolName: String
    public let summary: String
    public let risk: ActionRisk
    public let requestedAt: Date
    public let expiresAt: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        actionDigest: String,
        toolName: String,
        summary: String,
        risk: ActionRisk,
        requestedAt: Date,
        expiresAt: Date
    ) {
        self.id = id
        self.sessionID = sessionID
        self.actionDigest = actionDigest
        self.toolName = toolName
        self.summary = summary
        self.risk = risk
        self.requestedAt = requestedAt
        self.expiresAt = expiresAt
    }

    public func authorizes(digest: String, at date: Date) -> Bool {
        digest == actionDigest && date < expiresAt
    }
}
