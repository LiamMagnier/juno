import Foundation
import JunoCodeCore

public enum AuthorizationOutcome: Equatable, Sendable {
    case allowed
    /// The user approved; the returned request binds the digest and expiry
    /// that must be re-verified immediately before execution.
    case approved(ApprovalRequest)
    case denied(reason: String)
}

/// Per-session permission gate. `authorize` truly suspends while an approval
/// is pending: the tool has not started, and both approve and deny resume the
/// agent loop cleanly. Requests expire closed and cancellation denies
/// everything pending.
public actor PermissionCoordinator {
    public static let approvalTimeToLiveSeconds: Double = 15 * 60

    private enum PendingResolution: Sendable {
        case decided(ApprovalDecision)
        case revoked(reason: String)
    }

    private let sessionID: CodeSessionID
    private var mode: PermissionMode
    /// The reader's standing rules, consulted before the mode ladder.
    private var rules: PermissionRuleSet = .empty
    private var authorityRevision: UInt64 = 0
    private var pending: [String: CheckedContinuation<PendingResolution, Never>] = [:]
    private var pendingRequests: [String: ApprovalRequest] = [:]
    private var observers: [UUID: @Sendable (ApprovalUpdate) -> Void] = [:]

    public enum ApprovalUpdate: Sendable {
        case requested(ApprovalRequest)
        case resolved(id: String, decision: ApprovalDecision)
    }

    public init(sessionID: CodeSessionID, mode: PermissionMode) {
        self.sessionID = sessionID
        self.mode = mode
    }

    public var permissionMode: PermissionMode { mode }

    public var permissionRules: PermissionRuleSet { rules }

    /// Replaces the standing rules — the settings files, re-read per run.
    public func setRules(_ newRules: PermissionRuleSet) {
        rules = newRules
    }

    /// Adds one allow rule for the rest of this session, on top of whatever
    /// the files say. What "Always allow" does before it is also written down.
    public func addAllowRule(_ rule: PermissionRule) {
        rules = rules.merging(PermissionRuleSet(allow: [rule]))
    }

    public func setMode(_ newMode: PermissionMode) {
        let previousMode = mode
        mode = newMode
        guard newMode.authorityRank < previousMode.authorityRank else { return }

        // An approval is a decision inside the authority envelope that existed
        // when it was requested. Lowering that envelope revokes every suspended
        // decision, even when the action would still be approval-gated in the
        // new mode (critical actions, for example). This also closes the race in
        // which an approval click and a Code → Ask/Plan transition arrive
        // together: the resumed authorization observes the changed revision.
        authorityRevision &+= 1
        denyAll(reason: "The permission mode changed before the action ran.")
    }

    public var pendingApprovals: [ApprovalRequest] {
        Array(pendingRequests.values).sorted { $0.requestedAt < $1.requestedAt }
    }

    /// Registers an observer for approval lifecycle updates (UI binding).
    @discardableResult
    public func addObserver(
        _ observer: @escaping @Sendable (ApprovalUpdate) -> Void
    ) -> UUID {
        let id = UUID()
        observers[id] = observer
        return id
    }

    public func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }

    // MARK: - Authorization

    /// - Parameter hookPermission: what a `PreToolUse` hook said about this
    ///   call's prompt, weighed below the reader's own rules.
    public func authorize(
        toolName: String,
        actionDigest: String,
        risk: ActionRisk,
        summary: String,
        approvalPolicy: ApprovalPolicy = .byRisk,
        subject: PermissionRuleSubject? = nil,
        hookPermission: AgentHookPermission? = nil
    ) async -> AuthorizationOutcome {
        let ruling = Self.ruling(
            mode: mode,
            risk: risk,
            approvalPolicy: approvalPolicy,
            rule: rules.evaluate(toolName: toolName, subject: subject),
            hook: hookPermission,
            toolName: toolName
        )
        switch ruling {
        case .allow:
            return .allowed
        case let .deny(reason):
            return .denied(reason: reason)
        case .requireApproval:
            // A stopped run asks nothing more. `stop()` cancels the run and then
            // denies what is pending, so a request raised after that denial —
            // by a call that was already on its way here — would wait for an
            // answer to a run the reader has ended, and `stop()` with it. The
            // check and the registration below run without a suspension in
            // between, so a request is either refused here or pending when
            // the denial comes.
            guard !Task.isCancelled else {
                return .denied(reason: "The run was stopped.")
            }
            let now = Date()
            let request = ApprovalRequest(
                sessionID: sessionID,
                actionDigest: actionDigest,
                toolName: toolName,
                summary: summary,
                risk: risk,
                approvalPolicy: approvalPolicy,
                requestedAt: now,
                expiresAt: now.addingTimeInterval(Self.approvalTimeToLiveSeconds),
                // Nothing to offer where no saved rule would ever apply:
                // allow rules never silence a destructive action, nor a
                // command line whose substitutions they cannot see into.
                suggestedRule: risk == .destructive || !PermissionRuleSet.patternsCanVouch(for: subject)
                    ? nil
                    : PermissionRuleSet.suggestedRule(toolName: toolName, subject: subject)
            )
            pendingRequests[request.id] = request
            notify(.requested(request))
            let requestAuthorityRevision = authorityRevision

            let resolution = await withCheckedContinuation { continuation in
                pending[request.id] = continuation
            }

            switch resolution {
            case let .revoked(reason):
                return .denied(reason: reason)
            case .decided(.denied):
                return .denied(reason: "The user declined this action.")
            case .decided(.approved):
                break
            }
            guard requestAuthorityRevision == authorityRevision else {
                return .denied(reason: "The permission mode changed before the action ran.")
            }
            if case let .deny(reason) = Self.ruling(
                mode: mode,
                risk: risk,
                approvalPolicy: approvalPolicy,
                rule: rules.evaluate(toolName: toolName, subject: subject)
            ) {
                return .denied(reason: reason)
            }
            guard request.authorizes(digest: actionDigest, at: Date()) else {
                return .denied(reason: "The approval expired before the action ran.")
            }
            return .approved(request)
        }
    }

    /// The mode ladder with the reader's rules applied on top.
    ///
    /// - A deny rule refuses, whatever the mode.
    /// - An ask rule prompts, even in Full Access — but cannot turn a
    ///   read-only session's refusal into an offer.
    /// - An allow rule proceeds without asking, including past a pinned tool,
    ///   because saving the rule *was* the reader seeing it. It never silences
    ///   a destructive action: leaving the granted folder always asks.
    ///
    /// - Parameter toolName: the tool being ruled on, which decides how much
    ///   a hook's word counts (see ``hookRuling(_:hook:risk:approvalPolicy:toolName:)``).
    static func ruling(
        mode: PermissionMode,
        risk: ActionRisk,
        approvalPolicy: ApprovalPolicy,
        rule: PermissionRuleDecision?,
        hook: AgentHookPermission? = nil,
        toolName: String? = nil
    ) -> PermissionRuling {
        let ladder = PermissionPolicy.ruling(mode: mode, risk: risk, approvalPolicy: approvalPolicy)
        let ruled: PermissionRuling
        switch rule {
        case nil:
            ruled = ladder
        case let .deny(rule)?:
            return .deny(reason: "Blocked by the permission rule \(rule).")
        case .ask?:
            if case .deny = ladder { return ladder }
            return .requireApproval
        case .allow?:
            if case .deny = ladder { return ladder }
            ruled = risk == .destructive ? .requireApproval : .allow
        }
        return hookRuling(ruled, hook: hook, risk: risk, approvalPolicy: approvalPolicy, toolName: toolName)
    }

    /// A hook's word on the prompt, applied after the reader's own rules.
    ///
    /// A hook is the project's automation, not the reader, so it gets less
    /// say than a rule the reader saved. `ask` can only add a prompt, never
    /// turn a refusal into one. `allow` can only remove a prompt the mode
    /// itself would have asked for: an ask rule has already returned above,
    /// a read-only mode still refuses, a destructive action still asks, and
    /// so does a tool pinned to always asking — pinning means the reader sees
    /// that exact call, and a hook is not the reader.
    ///
    /// Nor does a hook's `allow` reach screen input. Clicks, keystrokes and
    /// scrolls act on the reader's whole Mac, and only the reader's own
    /// `~/.juno/settings.json` may let them run without asking — a project
    /// file cannot, even approved (see `CodeSettings`). A hook is very often
    /// a project file's: a repository entry the reader allowed by ID, running
    /// a script in the workspace the agent can edit, and its command may be
    /// covered by a Bash rule saved in the project. Honouring its `allow`
    /// would hand every click to the repository the settings layer keeps them
    /// from. It may still ask, and still block.
    private static func hookRuling(
        _ ruling: PermissionRuling,
        hook: AgentHookPermission?,
        risk: ActionRisk,
        approvalPolicy: ApprovalPolicy,
        toolName: String?
    ) -> PermissionRuling {
        let actsOnTheScreen = toolName.map(ComputerUseToolName.input.contains) ?? false
        switch (hook, ruling) {
        case (.ask?, .allow):
            return .requireApproval
        case (.allow?, .requireApproval)
            where risk != .destructive && approvalPolicy == .byRisk && !actsOnTheScreen:
            return .allow
        default:
            return ruling
        }
    }

    /// Resolves one pending approval. Unknown ids are ignored (idempotent).
    public func resolve(approvalID: String, decision: ApprovalDecision) {
        resolve(
            approvalID: approvalID,
            resolution: .decided(decision),
            observerDecision: decision
        )
    }

    private func resolve(
        approvalID: String,
        resolution: PendingResolution,
        observerDecision: ApprovalDecision
    ) {
        guard let continuation = pending.removeValue(forKey: approvalID) else { return }
        pendingRequests.removeValue(forKey: approvalID)
        notify(.resolved(id: approvalID, decision: observerDecision))
        continuation.resume(returning: resolution)
    }

    /// Denies every pending approval (session stop, cancellation, expiry
    /// sweep, or app termination). Approvals always fail closed.
    public func denyAll(reason: String = "Cancelled") {
        let ids = Array(pending.keys)
        for id in ids {
            resolve(
                approvalID: id,
                resolution: .revoked(reason: reason),
                observerDecision: .denied
            )
        }
    }

    /// Denies pending approvals that have outlived their expiry.
    public func sweepExpired(now: Date = Date()) {
        let expired = pendingRequests.values.filter { $0.expiresAt <= now }
        for request in expired {
            resolve(
                approvalID: request.id,
                resolution: .revoked(reason: "The approval expired before the action ran."),
                observerDecision: .denied
            )
        }
    }

    private func notify(_ update: ApprovalUpdate) {
        for observer in observers.values {
            observer(update)
        }
    }
}

