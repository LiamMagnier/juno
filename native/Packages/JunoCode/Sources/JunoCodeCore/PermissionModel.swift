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
///
/// The top two tiers exist because one bucket could not answer two different
/// questions. `critical` used to mean both "reaches the network or runs
/// arbitrary code" *and* "could wreck the machine", and because the policy
/// gated the whole bucket in every mode, a full-access session still stopped to
/// ask before `npm install`, `git push`, `./scripts/test.sh`, `python -m pytest`
/// and every executable not on the bounded allowlist. That is most of what a
/// coding agent does, so "full access" asked for permission constantly — the
/// mode did not mean what it said.
///
/// The line between the two is **whether Juno can bound the effect to the
/// workspace it was granted**:
///
/// - `critical` reaches the network or runs arbitrary code, but lands inside the
///   granted folder. Ordinary development. Full access proceeds; every lower
///   mode still asks.
/// - `destructive` leaves that boundary — the machine's configuration, other
///   processes, other hosts, raw devices, privileges, or a path outside the
///   grant. No mode proceeds silently, including full access.
public enum ActionRisk: String, Codable, CaseIterable, Sendable, Comparable {
    /// Reading or searching inside the workspace.
    case read
    /// Creating or modifying files inside the workspace.
    case write
    /// Running a command whose effects are bounded to the workspace.
    case execute
    /// Reaches the network or runs arbitrary code, but stays inside the granted
    /// workspace: a dependency install, a fetch, a push, a test runner, a script
    /// in the repository. Approval-gated in every mode *except* full access.
    case critical
    /// Escapes the workspace or cannot be undone: privilege and ownership
    /// changes, disk utilities, killing processes, system configuration, remote
    /// shells, infrastructure control, history rewrites, or any path outside the
    /// grant. **Always requires explicit approval, in every mode.**
    case destructive

    private var rank: Int {
        switch self {
        case .read: return 0
        case .write: return 1
        case .execute: return 2
        case .critical: return 3
        case .destructive: return 4
        }
    }

    public static func < (lhs: ActionRisk, rhs: ActionRisk) -> Bool {
        lhs.rank < rhs.rank
    }
}

/// Whether a tool's authorization is decided by the risk ladder alone, or is
/// pinned to always asking regardless of mode.
///
/// Separate from `ActionRisk` on purpose. Risk answers "how far can the effect
/// reach", and the mode ladder is the user's standing answer to it. Some tools
/// need a different question answered — "should the user see this exact
/// invocation before it runs" — and that is not a statement about blast radius.
///
/// `run_tests` is the case that forced the distinction. Its description said
/// every exact command always requires approval, and it returned `.critical`
/// to try to achieve that; but `.critical` is precisely the tier Full Access
/// exists to let through, so the promise was false in the one mode where it
/// mattered most. Raising it to `.destructive` would have been a lie of a
/// different kind — a test command does not escape the workspace — and would
/// have dragged unrelated policy along with it.
public enum ApprovalPolicy: String, Codable, CaseIterable, Sendable {
    /// The mode-and-risk ladder decides. The default for every tool.
    case byRisk
    /// Always requires an explicit approval, in every mode that permits the
    /// action at all — including Full Access.
    ///
    /// It does not *raise* authority: a mode that refuses the action outright
    /// still refuses it, rather than offering a prompt that would carry it out.
    case alwaysRequiresApproval
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
///
/// One rule sits above the mode ladder — `destructive` always asks, so no
/// setting anywhere in the app can grant silent permission to step outside the
/// granted workspace. Everything else is the ladder the four modes describe, and
/// full access genuinely means full access within that boundary.
public enum PermissionPolicy {
    public static func ruling(
        mode: PermissionMode,
        risk: ActionRisk,
        approvalPolicy: ApprovalPolicy = .byRisk
    ) -> PermissionRuling {
        let ladder = ladderRuling(mode: mode, risk: risk)
        guard approvalPolicy == .alwaysRequiresApproval else { return ladder }
        switch ladder {
        // A refusal outranks the pin. Read-only promises that nothing executes;
        // turning its denial into a prompt would offer the user a button that
        // breaks that promise, which is the opposite of what pinning is for.
        case .deny:
            return ladder
        case .allow, .requireApproval:
            return .requireApproval
        }
    }

    private static func ladderRuling(mode: PermissionMode, risk: ActionRisk) -> PermissionRuling {
        switch (mode, risk) {
        // Read-only comes first so that it *refuses* rather than asks.
        //
        // With the top-tier rule above it — as the equivalent `critical` rule
        // used to be — a read-only session offered an approval prompt for the
        // most dangerous class of action, and answering it would have carried the
        // action out. That contradicts the one thing the mode promises, so the
        // stricter ruling wins.
        case (.readOnly, .read):
            return .allow
        case (.readOnly, _):
            return .deny(reason: "The session is read-only.")
        // Above every other mode: there is no way to turn this off, because the
        // workspace grant is the one promise Juno makes about a folder it was
        // pointed at.
        case (_, .destructive):
            return .requireApproval
        case (.askBeforeChanges, .read):
            return .allow
        case (.askBeforeChanges, _):
            return .requireApproval
        case (.workspaceWrite, .read), (.workspaceWrite, .write):
            return .allow
        case (.workspaceWrite, .execute), (.workspaceWrite, .critical):
            return .requireApproval
        // Reads, edits, commands, installs, fetches and pushes all proceed. Only
        // the `destructive` case above interrupts, which is what the mode's own
        // description promises.
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
    /// Why this is being asked. The UI needs it to describe the prompt
    /// truthfully: a pinned action is asked about even in Full Access, so copy
    /// derived from the risk tier alone would tell the reader the opposite.
    public let approvalPolicy: ApprovalPolicy
    public let requestedAt: Date
    public let expiresAt: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        actionDigest: String,
        toolName: String,
        summary: String,
        risk: ActionRisk,
        approvalPolicy: ApprovalPolicy = .byRisk,
        requestedAt: Date,
        expiresAt: Date
    ) {
        self.id = id
        self.sessionID = sessionID
        self.actionDigest = actionDigest
        self.toolName = toolName
        self.summary = summary
        self.risk = risk
        self.approvalPolicy = approvalPolicy
        self.requestedAt = requestedAt
        self.expiresAt = expiresAt
    }

    public func authorizes(digest: String, at date: Date) -> Bool {
        digest == actionDigest && date < expiresAt
    }
}
