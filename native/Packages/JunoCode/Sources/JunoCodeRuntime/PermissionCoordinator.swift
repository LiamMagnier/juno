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

    public func authorize(
        toolName: String,
        actionDigest: String,
        risk: ActionRisk,
        summary: String,
        approvalPolicy: ApprovalPolicy = .byRisk
    ) async -> AuthorizationOutcome {
        switch PermissionPolicy.ruling(mode: mode, risk: risk, approvalPolicy: approvalPolicy) {
        case .allow:
            return .allowed
        case let .deny(reason):
            return .denied(reason: reason)
        case .requireApproval:
            let now = Date()
            let request = ApprovalRequest(
                sessionID: sessionID,
                actionDigest: actionDigest,
                toolName: toolName,
                summary: summary,
                risk: risk,
                approvalPolicy: approvalPolicy,
                requestedAt: now,
                expiresAt: now.addingTimeInterval(Self.approvalTimeToLiveSeconds)
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
            if case let .deny(reason) = PermissionPolicy.ruling(
                mode: mode,
                risk: risk,
                approvalPolicy: approvalPolicy
            ) {
                return .denied(reason: reason)
            }
            guard request.authorizes(digest: actionDigest, at: Date()) else {
                return .denied(reason: "The approval expired before the action ran.")
            }
            return .approved(request)
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

private extension PermissionMode {
    var authorityRank: Int {
        switch self {
        case .readOnly: 0
        case .askBeforeChanges: 1
        case .workspaceWrite: 2
        case .fullAccess: 3
        }
    }
}
