import Foundation
import JunoWorkCore

// MARK: - The request

/// One question put to a person: may Juno do this exact thing.
///
/// ``actionDigest`` travels with the request and must be echoed back with the
/// decision. That is what stops an approval shown for one action from
/// authorising a different one — a decision without the digest is a decision
/// about a description, not about an action.
public struct WorkApprovalRequest: Hashable, Sendable, Identifiable {
    public let id: String
    /// The run this belongs to, so stopping a task takes its unanswered
    /// questions off the person's phone with it.
    public let runID: String
    /// The tool name, or the identifier of a ``WorkIrreversibleAction``.
    public let action: String
    public let actionDigest: String
    public let risk: WorkRiskLevel
    /// Exactly the sentence the person is shown, so an audit can prove what was
    /// on screen rather than what today's code would render.
    public let summary: String
    public let requestedAt: Date
    public let expiresAt: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        runID: String,
        action: String,
        actionDigest: String,
        risk: WorkRiskLevel,
        summary: String,
        requestedAt: Date,
        expiresAt: Date
    ) {
        self.id = id
        self.runID = runID
        self.action = action
        self.actionDigest = actionDigest
        self.risk = risk
        self.summary = summary
        self.requestedAt = requestedAt
        self.expiresAt = expiresAt
    }

    public func isAnswerable(at now: Date) -> Bool { now < expiresAt }
}

// MARK: - The proof

/// A person's yes, in a form nothing outside this file can manufacture.
///
/// The initializer is `fileprivate` and ``WorkApprovalCoordinator`` is the only
/// thing in the file that calls it, so the sole way to hold one is to have asked
/// and been answered. That is the structural half of "permanent delete has no
/// code path that does not stop and ask": the tool demands a receipt, and no
/// amount of calling the wrong method produces one.
public struct WorkApprovalReceipt: Hashable, Sendable {
    public let request: WorkApprovalRequest
    public let decidedAt: Date

    fileprivate init(request: WorkApprovalRequest, decidedAt: Date) {
        self.request = request
        self.decidedAt = decidedAt
    }

    /// Whether this receipt authorises the action with this digest, right now.
    ///
    /// Callers pass a digest they recomputed from the arguments they are about
    /// to execute, never the one they asked with. Recomputing is the whole
    /// check: an approval that was granted while the arguments were one thing
    /// must not survive them becoming another.
    public func authorizes(digest: String, at date: Date) -> Bool {
        request.actionDigest == digest && date < request.expiresAt
    }
}

extension WorkApprovalReceipt {
    /// The Core value ``WorkBatchExecutor`` re-verifies a plan against.
    ///
    /// Only a receipt can produce one, which keeps the batch path honest: the
    /// executor's own digest, grant and expiry checks then run against an
    /// approval that a person actually gave.
    public func batchApproval(grantID: WorkGrantID) -> WorkBatchApproval {
        WorkBatchApproval(
            id: request.id,
            grantID: grantID,
            planDigest: request.actionDigest,
            decidedAt: decidedAt,
            expiresAt: request.expiresAt
        )
    }
}

// MARK: - Outcomes

public enum WorkApprovalDecision: String, Hashable, Codable, Sendable {
    case approved
    case denied
}

/// What ``WorkApprovalCoordinator/authorize(action:runID:actionDigest:risk:mode:summary:)``
/// concluded.
public enum WorkAuthorizationOutcome: Hashable, Sendable {
    /// The standing policy covers this; nobody was asked.
    case allowed
    /// The person said yes. The receipt binds the digest and the expiry that
    /// must be re-verified immediately before the action runs.
    case approved(WorkApprovalReceipt)
    case denied(reason: String)
}

/// The authority one tool call runs under.
public enum WorkAuthorization: Hashable, Sendable {
    case allowedByPolicy
    case approved(WorkApprovalReceipt)
    /// The registry handed the gate to the tool, because what a person would be
    /// approving is not knowable from the arguments. See
    /// ``WorkApprovalBinding/aPlanTheToolBuilds``.
    case deferredToTheTool
}

// MARK: - The gate

/// The one place a run finds out whether it may act.
///
/// ``authorize(action:runID:actionDigest:risk:mode:summary:)`` truly suspends
/// while a question is unanswered: the tool has not started, so a refusal costs
/// nothing and a "no" resumes the run cleanly rather than unwinding a half-done
/// change. Four rules hold, and each one exists because the version without it
/// has a name:
///
/// - **The policy is re-evaluated after the answer arrives, not only before the
///   question was asked.** Somebody who narrows Juno's permissions while an
///   approval sheet is on screen has narrowed them; an approval that lands
///   afterwards authorises nothing.
/// - **The decision must echo the digest it was shown.** A yes that names a
///   different action than the one pending is refused rather than applied to
///   whatever happens to be waiting under that identifier.
/// - **Approvals expire closed, and something sweeps them.** Each pending
///   request arms its own expiry, so an unanswered question resolves itself
///   instead of parking a run for ever on a phone somebody put down.
/// - **Cancellation denies everything pending.** A stopped run leaves no
///   question behind that could be answered into a run that no longer exists.
public actor WorkApprovalCoordinator {
    /// Matches `APPROVAL_TTL_MS` in `src/lib/work/domain.ts` and
    /// ``WorkBatchApproval/timeToLive``. An unanswered question is not a
    /// standing yes.
    public static let approvalTimeToLive: TimeInterval = 15 * 60

    public enum Update: Sendable {
        case requested(WorkApprovalRequest)
        case resolved(id: String, decision: WorkApprovalDecision)
    }

    private enum Resolution: Sendable {
        case decided(WorkApprovalDecision)
        /// Taken off the table without the person answering: stopped, expired,
        /// or the permissions moved underneath it.
        case revoked(reason: String)
    }

    private var policy: WorkPermissionPolicy
    /// The mode one dispatched run was told to enforce, narrower than or equal
    /// to ``policy``. See ``setRunPolicy(_:for:)``.
    private var runPolicies: [String: WorkPermissionPolicy] = [:]
    private var allowance: WorkAlwaysAllowance?
    private var unattended: WorkRisk.UnattendedPolicy?
    /// Bumped whenever the authority a pending question was asked under shrinks.
    /// A suspended `authorize` compares the revision it recorded against this
    /// one after it resumes, which also closes the race where a tap on Approve
    /// and a flick of a settings switch arrive together.
    private var authorityRevision: UInt64 = 0
    private var pending: [String: CheckedContinuation<Resolution, Never>] = [:]
    private var pendingRequests: [String: WorkApprovalRequest] = [:]
    private var observers: [UUID: @Sendable (Update) -> Void] = [:]

    private let now: @Sendable () -> Date
    private let sleep: @Sendable (Duration) async throws -> Void

    /// - Parameters:
    ///   - sleep: how a pending request waits for its own expiry. Injected so a
    ///     test can pin the sweep rather than wait a quarter of an hour for it.
    public init(
        policy: WorkPermissionPolicy,
        allowance: WorkAlwaysAllowance? = nil,
        unattended: WorkRisk.UnattendedPolicy? = nil,
        now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
        }
    ) {
        self.policy = policy
        self.allowance = allowance
        self.unattended = unattended
        self.now = now
        self.sleep = sleep
    }

    // MARK: - Reading and changing the authority

    public var permissionPolicy: WorkPermissionPolicy { policy }
    public var standingAllowance: WorkAlwaysAllowance? { allowance }
    public var unattendedPolicy: WorkRisk.UnattendedPolicy? { unattended }

    public var pendingApprovals: [WorkApprovalRequest] {
        pendingRequests.values.sorted { $0.requestedAt < $1.requestedAt }
    }

    /// Replaces the standing policy.
    ///
    /// Narrowing revokes every unanswered question, even ones that would still
    /// be merely approval-gated under the new policy. An approval is a decision
    /// made inside the envelope that existed when it was asked for, and lowering
    /// that envelope invalidates the decision rather than shrinking it.
    public func setPolicy(_ newPolicy: WorkPermissionPolicy) {
        let previous = policy
        policy = newPolicy
        guard newPolicy < previous else { return }
        authorityRevision &+= 1
        denyAll(reason: "Juno's permissions on this Mac changed before that could run.")
    }

    /// The mode this Mac will enforce for one dispatched run.
    ///
    /// One coordinator serves every run on this Mac, and until this existed the
    /// only authority it had was ``policy`` — the switch in this Mac's own
    /// settings. So a task composed as Manual and a task composed as Skip were
    /// gated identically the moment they landed here: the narrowing was
    /// computed by the dispatch route, written onto the run and digested into
    /// every approval, and then had nowhere to be applied.
    ///
    /// Only ever narrowing. The effective mode is the `min` of this and the
    /// Mac's own, so a task cannot buy itself more licence than the person
    /// sitting at the machine granted — the run says how *little* it wants to
    /// be trusted, never how much. `resolveApprovalMode` on the server has
    /// already intersected the two, and doing it again here is the point rather
    /// than duplication: this side must not depend on the sender having done it.
    ///
    /// Narrowing revokes that run's unanswered questions, for the reason
    /// ``setPolicy(_:)`` gives — a decision is made inside the envelope that
    /// existed when it was asked for. Only that run's, though: another run's
    /// pending question was asked under an authority nothing here has touched,
    /// and denying it would be this run's setting reaching into a task it has
    /// nothing to do with.
    public func setRunPolicy(_ newPolicy: WorkPermissionPolicy, for runID: String) {
        let previous = effectivePolicy(forRun: runID)
        runPolicies[runID] = newPolicy
        guard effectivePolicy(forRun: runID) < previous else { return }
        denyPending(
            forRun: runID,
            reason: "This task's approval mode changed before that could run."
        )
    }

    /// Forgets a finished run's mode.
    ///
    /// Widening by construction — it can only ever return that run to the Mac's
    /// own policy — so nothing pending is revoked. Called when the run retires,
    /// because a map keyed by run id on a process that stays open for weeks is
    /// otherwise a map that only grows.
    public func clearRunPolicy(for runID: String) {
        runPolicies.removeValue(forKey: runID)
    }

    /// The mode one run is actually gated on: the stricter of its own and this
    /// Mac's.
    public func permissionPolicy(forRun runID: String) -> WorkPermissionPolicy {
        effectivePolicy(forRun: runID)
    }

    private func effectivePolicy(forRun runID: String) -> WorkPermissionPolicy {
        WorkPermissionPolicy.narrowest([policy, runPolicies[runID]])
    }

    /// Replaces the standing "always allow" answer.
    ///
    /// Removing one, or lowering the risk it covers, narrows the authority and
    /// therefore revokes pending questions for the same reason ``setPolicy(_:)``
    /// does.
    public func setAllowance(_ newAllowance: WorkAlwaysAllowance?) {
        let previous = allowance
        allowance = newAllowance
        let narrowed: Bool
        switch (previous, newAllowance) {
        case (nil, _): narrowed = false
        case (_, nil): narrowed = true
        case (let old?, let new?): narrowed = new.highestRiskCovered < old.highestRiskCovered
        }
        guard narrowed else { return }
        authorityRevision &+= 1
        denyAll(reason: "Juno's permissions on this Mac changed before that could run.")
    }

    /// Sets what happens when something needs a person and nobody is there.
    ///
    /// Nil means somebody is watching. The narrowing to watch for is not "was it
    /// set" but "can a pending question still be answered at all": under
    /// `pauseForApproval` it can, and under the other two it cannot. Moving from
    /// either of the answerable states to either of the others turns a question
    /// somebody could have said yes to into one that is already refused, which
    /// is a change of authority and invalidates decisions made under the old one.
    public func setUnattendedPolicy(_ newPolicy: WorkRisk.UnattendedPolicy?) {
        let previous = unattended
        unattended = newPolicy
        let leavesQuestionsAnswerable: (WorkRisk.UnattendedPolicy?) -> Bool = { policy in
            policy == nil || policy == .pauseForApproval
        }
        guard leavesQuestionsAnswerable(previous), !leavesQuestionsAnswerable(newPolicy) else {
            return
        }
        authorityRevision &+= 1
        denyAll(reason: "Nobody is at this Mac any more, so Juno stopped rather than assume an answer.")
    }

    @discardableResult
    public func addObserver(_ observer: @escaping @Sendable (Update) -> Void) -> UUID {
        let id = UUID()
        observers[id] = observer
        return id
    }

    public func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }

    // MARK: - Authorizing

    /// Decides whether one action may proceed, suspending while a person is
    /// asked.
    ///
    /// - Parameter mode: the access mode of the grant the action touches.
    ///   Consulted ahead of the risk ladder so that a refusal beats a prompt:
    ///   offering an Allow button for a change to a folder somebody shared
    ///   read-only would let one tap undo the choice they made when they shared
    ///   it.
    public func authorize(
        action: String,
        runID: String,
        actionDigest: String,
        risk: WorkRiskLevel,
        mode: WorkAccessMode,
        summary: String
    ) async -> WorkAuthorizationOutcome {
        switch ruling(risk: risk, mode: mode, runID: runID) {
        case .allow:
            return .allowed
        case .deny(let reason):
            return .denied(reason: reason)
        case .requireApproval:
            break
        }

        let requestedAt = now()
        let request = WorkApprovalRequest(
            runID: runID,
            action: action,
            actionDigest: actionDigest,
            risk: risk,
            summary: summary,
            requestedAt: requestedAt,
            expiresAt: requestedAt.addingTimeInterval(Self.approvalTimeToLive)
        )
        pendingRequests[request.id] = request
        notify(.requested(request))
        let revisionWhenAsked = authorityRevision

        let resolution = await withCheckedContinuation { continuation in
            pending[request.id] = continuation
            // Armed only once the continuation is registered, so the expiry can
            // never resolve a question that is not yet waiting to be resolved.
            armExpiry(of: request)
        }

        switch resolution {
        case .revoked(let reason):
            return .denied(reason: reason)
        case .decided(.denied):
            return .denied(reason: "You said no to this.")
        case .decided(.approved):
            break
        }

        guard revisionWhenAsked == authorityRevision else {
            return .denied(reason: "Juno's permissions on this Mac changed before that could run.")
        }
        // Re-evaluated against the policy as it stands now, not as it stood when
        // the question was asked. `denyAll` covers the narrowing this process
        // saw; this covers a policy that was replaced wholesale, and costs one
        // comparison.
        if case .deny(let reason) = ruling(risk: risk, mode: mode, runID: runID) {
            return .denied(reason: reason)
        }
        let receipt = WorkApprovalReceipt(request: request, decidedAt: now())
        // The expiry, checked once more on this side of the suspension. The
        // digest comparison that matters is the caller's — it recomputes the
        // digest from the arguments it is about to execute — and this one only
        // proves the receipt was not assembled from a different request.
        guard receipt.authorizes(digest: actionDigest, at: now()) else {
            return .denied(reason: "That approval expired before Juno could act on it.")
        }
        return .approved(receipt)
    }

    /// The ruling for a risk under the current authority, for one run.
    ///
    /// `nonisolated` is deliberately *not* used here — unlike the host loop's
    /// refusal check this reads mutable state — but the mode gate is kept ahead
    /// of ``WorkRisk/ruling(policy:risk:allowance:)`` for the same reason that
    /// function puts irreversible above the policy ladder: a rule that can be
    /// reached by a prompt is a rule one tap can undo.
    ///
    /// The policy passed down is ``effectivePolicy(forRun:)`` and never
    /// ``policy`` alone, which is what makes a task's own mode mean something
    /// on this Mac. It is a `min`, so this can only ever ask about more.
    private func ruling(
        risk: WorkRiskLevel, mode: WorkAccessMode, runID: String
    ) -> WorkApprovalRuling {
        guard risk == .safe || mode.allowsWrite else {
            return .deny(reason: "This folder was shared with Juno for reading only.")
        }
        let base = WorkRisk.ruling(
            policy: effectivePolicy(forRun: runID), risk: risk, allowance: allowance
        )
        guard let unattended else { return base }
        return WorkRisk.unattendedRuling(base, policy: unattended)
    }

    // MARK: - Answering

    /// Records a person's answer to one pending question.
    ///
    /// - Parameter actionDigest: the digest the person was shown. A decision
    ///   that echoes a different one is refused rather than applied to whatever
    ///   is waiting under that identifier — the two ways that happens are a
    ///   stale sheet on a phone that reconnected, and a replayed relay message,
    ///   and applying either would authorise something nobody read.
    ///
    /// Unknown identifiers are ignored, so a re-delivered answer is harmless.
    public func resolve(
        approvalID: String,
        decision: WorkApprovalDecision,
        actionDigest: String
    ) {
        guard let request = pendingRequests[approvalID] else { return }
        guard request.actionDigest == actionDigest else {
            resolve(
                approvalID: approvalID,
                resolution: .revoked(
                    reason: "That answer was about a different action than the one Juno was waiting on, so Juno stopped."
                ),
                observed: .denied
            )
            return
        }
        resolve(approvalID: approvalID, resolution: .decided(decision), observed: decision)
    }

    private func resolve(
        approvalID: String,
        resolution: Resolution,
        observed: WorkApprovalDecision
    ) {
        guard let continuation = pending.removeValue(forKey: approvalID) else { return }
        pendingRequests.removeValue(forKey: approvalID)
        notify(.resolved(id: approvalID, decision: observed))
        continuation.resume(returning: resolution)
    }

    /// Denies every pending question. Sign-out, cancellation, app termination.
    public func denyAll(reason: String = "Juno stopped before that could run.") {
        for id in Array(pending.keys) {
            resolve(approvalID: id, resolution: .revoked(reason: reason), observed: .denied)
        }
    }

    /// Denies the pending questions belonging to one run.
    ///
    /// Stopping a task has to take its unanswered questions with it. Left
    /// standing they are answerable into a run that no longer exists, and the
    /// person is looking at an approval sheet for work they already cancelled.
    public func denyPending(
        forRun runID: String,
        reason: String = "That task was stopped before this could run."
    ) {
        for request in pendingRequests.values where request.runID == runID {
            resolve(approvalID: request.id, resolution: .revoked(reason: reason), observed: .denied)
        }
    }

    /// Denies pending questions that have outlived their expiry.
    ///
    /// Public as well as armed per request, because whoever owns this
    /// coordinator may also want to sweep on a schedule of its own — and because
    /// a sweep that can only be triggered by waiting is a sweep no test can pin.
    public func sweepExpired(at date: Date? = nil) {
        let moment = date ?? now()
        for request in pendingRequests.values where !request.isAnswerable(at: moment) {
            resolve(
                approvalID: request.id,
                resolution: .revoked(reason: "That approval expired before Juno could act on it."),
                observed: .denied
            )
        }
    }

    /// Wakes once at this request's expiry and sweeps.
    ///
    /// Weakly captured: a coordinator whose owner has gone away must not be kept
    /// alive by a timer, and while an `authorize` is genuinely suspended the
    /// awaiting call frame holds the actor anyway, so the sweep is always there
    /// when it is needed and never when it is not.
    private func armExpiry(of request: WorkApprovalRequest) {
        let delay = request.expiresAt.timeIntervalSince(now())
        let sleep = self.sleep
        Task { [weak self] in
            if delay > 0 { try? await sleep(.seconds(delay)) }
            await self?.sweepExpired()
        }
    }

    private func notify(_ update: Update) {
        for observer in observers.values { observer(update) }
    }
}
