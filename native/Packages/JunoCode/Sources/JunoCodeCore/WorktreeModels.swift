import Foundation

/// The only owner currently allowed to create and remove a native Juno
/// worktree. Ownership is metadata, not a filesystem capability: callers must
/// still re-check canonical containment before every operation.
public enum WorktreeOwner: String, Codable, Hashable, Sendable {
    case juno
}

/// Durable state for a managed checkout. The states are intentionally small;
/// a manager can recover an interrupted operation without guessing whether a
/// path is safe to touch.
public enum WorktreeLifecycleState: String, Codable, CaseIterable, Hashable, Sendable {
    case creating
    case active
    case blocked
    case finalized
    case applied
    case removing
    case removed
    case recoveryRequired

    public func canTransition(to next: WorktreeLifecycleState) -> Bool {
        switch (self, next) {
        case (.creating, .active),
             (.creating, .blocked),
             (.creating, .recoveryRequired),
             (.active, .blocked),
             (.active, .finalized),
             (.active, .removing),
             (.active, .recoveryRequired),
             (.blocked, .active),
             (.blocked, .removing),
             (.blocked, .recoveryRequired),
             (.finalized, .active),
             (.finalized, .applied),
             (.finalized, .removing),
             (.finalized, .blocked),
             (.finalized, .recoveryRequired),
             (.applied, .removing),
             (.applied, .recoveryRequired),
             (.removing, .removed),
             (.removing, .recoveryRequired),
             (.recoveryRequired, .active),
             (.recoveryRequired, .removing),
             (.recoveryRequired, .removed),
             (.removed, .removed):
            return true
        case (.creating, .creating),
             (.active, .active),
             (.blocked, .blocked),
             (.finalized, .finalized),
             (.applied, .applied),
             (.removing, .removing),
             (.recoveryRequired, .recoveryRequired):
            return true
        default:
            return false
        }
    }
}

public enum WorktreeLifecycleError: Error, Equatable, Sendable {
    case invalidTransition(from: WorktreeLifecycleState, to: WorktreeLifecycleState)
}

/// Persisted metadata for a real Git worktree. `rootPath` is absolute by
/// contract, but the manager treats decoded metadata as untrusted and checks
/// it again before using it.
public struct WorktreeMetadata: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let rootPath: String
    public let branch: String
    public let baseRevision: String
    public let owner: WorktreeOwner
    public let createdAt: Date
    public var lifecycle: WorktreeLifecycleState
    public var updatedAt: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        rootPath: String,
        branch: String,
        baseRevision: String,
        owner: WorktreeOwner = .juno,
        lifecycle: WorktreeLifecycleState = .active,
        createdAt: Date = Date(),
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.rootPath = rootPath
        self.branch = branch
        self.baseRevision = baseRevision
        self.owner = owner
        self.lifecycle = lifecycle
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }

    public var rootURL: URL { URL(fileURLWithPath: rootPath, isDirectory: true) }

    public func transitioning(
        to next: WorktreeLifecycleState,
        at timestamp: Date = Date()
    ) throws -> WorktreeMetadata {
        guard lifecycle.canTransition(to: next) else {
            throw WorktreeLifecycleError.invalidTransition(from: lifecycle, to: next)
        }
        var result = self
        result.lifecycle = next
        result.updatedAt = timestamp
        return result
    }

    private enum CodingKeys: String, CodingKey {
        case id, rootPath, branch, baseRevision, owner, lifecycle, createdAt, updatedAt
    }

    /// Older Juno snapshots had no owner, lifecycle, or updated timestamp.
    /// They are safe to load as active Juno records and are still subject to
    /// the manager's live path and Git registration checks.
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        rootPath = try values.decode(String.self, forKey: .rootPath)
        branch = try values.decode(String.self, forKey: .branch)
        baseRevision = try values.decode(String.self, forKey: .baseRevision)
        owner = try values.decodeIfPresent(WorktreeOwner.self, forKey: .owner) ?? .juno
        lifecycle = try values.decodeIfPresent(
            WorktreeLifecycleState.self,
            forKey: .lifecycle
        ) ?? .active
        createdAt = try values.decode(Date.self, forKey: .createdAt)
        updatedAt = try values.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
    }
}
