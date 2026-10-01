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
/// agent loop cleanly. Cancellation denies everything pending.
///
/// An approval nobody answers is never turned into a denial the model reads as
/// "declined" (CODE_AGENT_SPEC §1.11). After `approvalTimeToLiveSeconds` the
/// run *parks*: the call stays pending and bound to its digest, the reader is
/// reminded at 15, 60 and 240 minutes, and their decision may arrive whenever
/// it comes.
public actor PermissionCoordinator {
    public static let approvalTimeToLiveSeconds: Double = 15 * 60
    /// When a waiting approval reminds the reader, in minutes after it was
    /// asked.
    public static let parkingReminderMinutes: [Double] = [15, 60, 240]

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
    /// How many reminders each parked approval has had.
    private var reminders: [String: Int] = [:]
    /// The timers that park each pending approval, cancelled when it is
    /// answered.
    private var parkingTimers: [String: Task<Void, Never>] = [:]
    /// Exact commands one active goal may run without asking (D-012).
    private var taskGrants: [TaskGrant] = []
    /// The goal the grants belong to, while it is active.
    private var activeGrantGoalID: String?
    /// The checkout this coordinator's session works in; a grant applies only
    /// in its own.
    private var workspaceRoot: String?
    /// Asks whether the goal with this id still lets its grants apply, from
    /// the goal as it is stored now. The goal runtime moves a goal out of
    /// `active` on its own — met, judged impossible, out of budget, blocked,
    /// stopped — without telling this coordinator, so a grant is honoured
    /// only after this says yes at the moment of the call. Nil trusts the
    /// grants as set (tests, and sessions with no goal store).
    private var taskGrantCheck: (@Sendable (_ goalID: String) async -> Bool)?

    public enum ApprovalUpdate: Sendable {
        case requested(ApprovalRequest)
        case resolved(id: String, decision: ApprovalDecision)
        /// Nobody has answered for a while: the run waits, the request stays
        /// pending, and the reader is reminded. `reminder` counts from 1.
        case parked(ApprovalRequest, reminder: Int)
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

    /// Approvals that have waited past their reminder time.
    public var parkedApprovals: [ApprovalRequest] {
        pendingApprovals.filter { (reminders[$0.id] ?? 0) > 0 }
    }

    // MARK: - Task grants

    /// The exact commands `goalID` may run without asking while it is active,
    /// in the checkout at `workspaceRoot`. Replaces any grants before them.
    public func setTaskGrants(_ grants: [TaskGrant], goalID: String, workspaceRoot: String) {
        self.workspaceRoot = workspaceRoot
        activeGrantGoalID = goalID
        taskGrants = grants.filter { $0.goalID == goalID }
    }

    /// The goal ended, paused or was replaced: its grants stop applying.
    /// With `goalID`, only that goal's grants go.
    public func clearTaskGrants(goalID: String? = nil) {
        guard goalID == nil || goalID == activeGrantGoalID else { return }
        taskGrants = []
        activeGrantGoalID = nil
    }

    /// Installs the check that confirms, at each call a grant would allow,
    /// that its goal is still in force (see `taskGrantCheck`).
    public func setTaskGrantCheck(_ check: (@Sendable (_ goalID: String) async -> Bool)?) {
        taskGrantCheck = check
    }

    /// The grants in force now.
    public var activeTaskGrants: [TaskGrant] {
        guard activeGrantGoalID != nil else { return [] }
        return taskGrants
    }

    /// Whether `grant` lets this exact call run without asking.
    ///
    /// Only a command line identical to the grant's, through the shell tools,
    /// in the grant's own checkout, while its goal is active. Never anything
    /// the always-confirm floor covers: a destructive or network-reaching
    /// command (`critical`), `git push`, a tool pinned to always asking, or
    /// screen input.
    static func grant(
        _ grant: TaskGrant,
        covers toolName: String,
        subject: PermissionRuleSubject?,
        risk: ActionRisk,
        approvalPolicy: ApprovalPolicy,
        activeGoalID: String?,
        workspaceRoot: String?
    ) -> Bool {
        guard grant.goalID == activeGoalID,
              let workspaceRoot,
              Self.samePath(grant.worktreePath, workspaceRoot),
              approvalPolicy == .byRisk,
              risk != .destructive, risk != .critical,
              Self.grantableTools.contains(toolName),
              !ComputerUseToolName.input.contains(toolName),
              case let .command(command)? = subject
        else { return false }
        let line = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, line == grant.command else { return false }
        let lowered = line.lowercased()
        return !lowered.contains("git push") && !lowered.hasPrefix("push ")
    }

    /// The tools a task grant can reach: the ones that run a command line.
    static let grantableTools: Set<String> = ["run_command", "run_tests", "shell_start"]

    private static func samePath(_ lhs: String, _ rhs: String) -> Bool {
        URL(fileURLWithPath: lhs).standardizedFileURL.path == URL(fileURLWithPath: rhs).standardizedFileURL.path
    }

    private func grantCovers(
        toolName: String,
        subject: PermissionRuleSubject?,
        risk: ActionRisk,
        approvalPolicy: ApprovalPolicy
    ) -> Bool {
        taskGrants.contains {
            Self.grant(
                $0,
                covers: toolName,
                subject: subject,
                risk: risk,
                approvalPolicy: approvalPolicy,
                activeGoalID: activeGrantGoalID,
                workspaceRoot: workspaceRoot
            )
        }
    }

    /// Whether a task grant covers this call *and* its goal is still in
    /// force, asked of the stored goal at this moment. Everything after the
    /// one suspension is read afresh, so a grant cleared or replaced while
    /// the goal was being read does not count.
    private func grantConfirmed(
        toolName: String,
        subject: PermissionRuleSubject?,
        risk: ActionRisk,
        approvalPolicy: ApprovalPolicy
    ) async -> Bool {
        guard rules.evaluate(toolName: toolName, subject: subject) == nil,
              grantCovers(toolName: toolName, subject: subject, risk: risk, approvalPolicy: approvalPolicy),
              let goalID = activeGrantGoalID
        else { return false }
        if let check = taskGrantCheck {
            guard await check(goalID) else { return false }
        }
        return activeGrantGoalID == goalID
            && grantCovers(toolName: toolName, subject: subject, risk: risk, approvalPolicy: approvalPolicy)
    }

    /// Whether this call would run without a prompt as things stand: the
    /// mode, the reader's rules and the active task grants. A dry run that
    /// asks nothing, for the stop check deciding whether the runtime may run a
    /// check itself.
    public func allowsWithoutPrompt(
        toolName: String,
        subject: PermissionRuleSubject?,
        risk: ActionRisk,
        approvalPolicy: ApprovalPolicy = .byRisk
    ) async -> Bool {
        let granted = await grantConfirmed(toolName: toolName, subject: subject, risk: risk, approvalPolicy: approvalPolicy)
        let ruling = Self.ruling(
            mode: mode,
            risk: risk,
            approvalPolicy: approvalPolicy,
            rule: effectiveRule(toolName: toolName, subject: subject, granted: granted),
            toolName: toolName
        )
        if case .allow = ruling { return true }
        return false
    }

    /// The reader's rule for this call, or, when no rule speaks to it, an
    /// allow from a task grant `grantConfirmed` vouched for. Grants come
    /// after deny and ask rules and before the mode ladder.
    private func effectiveRule(
        toolName: String,
        subject: PermissionRuleSubject?,
        granted: Bool
    ) -> PermissionRuleDecision? {
        if let rule = rules.evaluate(toolName: toolName, subject: subject) {
            return rule
        }
        guard granted else {
            return nil
        }
        return .allow(PermissionRule(tool: "Bash", specifier: (subject.flatMap {
            if case let .command(line) = $0 { return line }
            return nil
        }) ?? ""))
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
        // The only suspension before the ruling: whether a task grant's goal
        // is still in force. Everything from the ruling to the request's
        // registration below runs without another.
        let granted = await grantConfirmed(toolName: toolName, subject: subject, risk: risk, approvalPolicy: approvalPolicy)
        let ruling = Self.ruling(
            mode: mode,
            risk: risk,
            approvalPolicy: approvalPolicy,
            rule: effectiveRule(toolName: toolName, subject: subject, granted: granted),
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
            scheduleParking(request)
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
            // The reader's yes binds this exact action, however long they
            // took to give it: a parked approval is approved fresh from the
            // moment they decided, for the same digest and nothing else.
            let decided = ApprovalRequest(
                id: request.id,
                sessionID: request.sessionID,
                actionDigest: request.actionDigest,
                toolName: request.toolName,
                summary: request.summary,
                risk: request.risk,
                approvalPolicy: request.approvalPolicy,
                requestedAt: request.requestedAt,
                expiresAt: max(request.expiresAt, Date().addingTimeInterval(Self.approvalTimeToLiveSeconds)),
                suggestedRule: request.suggestedRule
            )
            guard decided.authorizes(digest: actionDigest, at: Date()) else {
                return .denied(reason: "The approval no longer matches the action.")
            }
            return .approved(decided)
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
        reminders.removeValue(forKey: approvalID)
        parkingTimers.removeValue(forKey: approvalID)?.cancel()
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

    /// Parks pending approvals that have waited past a reminder time: the
    /// call stays pending and bound to its digest, and the reader is reminded
    /// once per threshold (15, 60 and 240 minutes). Nothing is denied — an
    /// unanswered approval is a run waiting on the reader, not a "no".
    public func sweepExpired(now: Date = Date()) {
        for request in pendingApprovals {
            let waited = now.timeIntervalSince(request.requestedAt) / 60
            let due = Self.parkingReminderMinutes.filter { waited >= $0 }.count
            let sent = reminders[request.id] ?? 0
            guard due > sent else { continue }
            reminders[request.id] = due
            notify(.parked(request, reminder: due))
        }
    }

    /// Wakes at each reminder time for one request, while it is pending.
    private func scheduleParking(_ request: ApprovalRequest) {
        let thresholds = Self.parkingReminderMinutes
        let requestedAt = request.requestedAt
        parkingTimers[request.id] = Task { [weak self] in
            for minutes in thresholds {
                let wake = requestedAt.addingTimeInterval(minutes * 60)
                let delay = wake.timeIntervalSinceNow
                if delay > 0 {
                    do {
                        try await Task.sleep(for: .seconds(delay))
                    } catch {
                        return
                    }
                }
                guard let self else { return }
                await self.sweepExpired(now: Date())
            }
        }
    }

    private func notify(_ update: ApprovalUpdate) {
        for observer in observers.values {
            observer(update)
        }
    }
}

