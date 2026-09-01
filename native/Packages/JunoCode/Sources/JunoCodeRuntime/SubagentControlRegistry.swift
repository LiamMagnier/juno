import Foundation
import JunoCodeCore

/// The live controls for child agents that are currently executing.
///
/// A delegated agent is intentionally not a second conversation, but it still
/// owns a real permission coordinator and a real orchestrator. Keeping those
/// two capabilities in one short-lived registry lets the parent UI stop a
/// child or resolve one of its approvals without manufacturing a second
/// session controller or weakening the child's policy.
///
/// Entries exist only while the child is running. A missing entry therefore
/// means "the child is no longer controllable", not "try to reconstruct a
/// capability from the transcript".
public actor SubagentControlRegistry {
    private struct Entry: Sendable {
        let parentSessionID: CodeSessionID
        let permissions: PermissionCoordinator
        let orchestrator: AgentOrchestrator
    }

    private var entries: [CodeSessionID: Entry] = [:]

    public init() {}

    public func register(
        childSessionID: CodeSessionID,
        parentSessionID: CodeSessionID,
        permissions: PermissionCoordinator,
        orchestrator: AgentOrchestrator
    ) {
        entries[childSessionID] = Entry(
            parentSessionID: parentSessionID,
            permissions: permissions,
            orchestrator: orchestrator
        )
    }

    public func unregister(childSessionID: CodeSessionID) {
        entries.removeValue(forKey: childSessionID)
    }

    public func pendingApprovals(for childSessionID: CodeSessionID) async -> [ApprovalRequest] {
        guard let entry = entries[childSessionID] else { return [] }
        return await entry.permissions.pendingApprovals
    }

    /// Read controls only through the parent that delegated the child. Session
    /// ids are not authority: this prevents a stale inspector or future remote
    /// client from resolving an unrelated child's approval by guessing its id.
    public func pendingApprovals(
        for childSessionID: CodeSessionID, ownedBy parentSessionID: CodeSessionID
    ) async -> [ApprovalRequest] {
        guard let entry = entries[childSessionID], entry.parentSessionID == parentSessionID else { return [] }
        return await entry.permissions.pendingApprovals
    }

    public func resolve(
        childSessionID: CodeSessionID,
        approvalID: String,
        decision: ApprovalDecision
    ) async {
        guard let entry = entries[childSessionID] else { return }
        await entry.permissions.resolve(approvalID: approvalID, decision: decision)
    }

    public func sweepExpiredApprovals(for childSessionID: CodeSessionID) async {
        guard let entry = entries[childSessionID] else { return }
        await entry.permissions.sweepExpired()
    }

    /// Stop is idempotent. The child orchestrator denies its pending approvals
    /// before awaiting its run task, so the parent never remains blocked on a
    /// child approval after the reader presses Stop.
    public func stop(childSessionID: CodeSessionID) async {
        guard let entry = entries[childSessionID] else { return }
        await entry.orchestrator.stop()
    }

    @discardableResult
    public func stop(
        childSessionID: CodeSessionID, ownedBy parentSessionID: CodeSessionID
    ) async -> Bool {
        guard let entry = entries[childSessionID], entry.parentSessionID == parentSessionID else { return false }
        await entry.orchestrator.stop()
        return true
    }

    public func hasControl(for childSessionID: CodeSessionID) -> Bool {
        entries[childSessionID] != nil
    }
}
