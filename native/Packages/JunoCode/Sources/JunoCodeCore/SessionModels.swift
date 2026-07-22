import Foundation

/// Where a code session executes. The UI renders all three through the same
/// event model; only the local runtime is implemented in this package.
public enum SessionLocation: String, Codable, CaseIterable, Sendable {
    case local
    case cloud
    case remote
}

public enum SessionStatus: String, Codable, CaseIterable, Sendable {
    case idle
    case running
    case waitingForApproval
    case stopping
    case completed
    case failed
    case cancelled

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled: return true
        case .idle, .running, .waitingForApproval, .stopping: return false
        }
    }

    public var isActive: Bool {
        switch self {
        case .running, .waitingForApproval, .stopping: return true
        case .idle, .completed, .failed, .cancelled: return false
        }
    }
}

public struct CodeSessionID: Hashable, Codable, Sendable, CustomStringConvertible {
    public let value: String

    public init(value: String = UUID().uuidString.lowercased()) {
        self.value = value
    }

    public var description: String { value }
}

public struct WorkspaceID: Hashable, Codable, Sendable, CustomStringConvertible {
    public let value: String

    public init(value: String = UUID().uuidString.lowercased()) {
        self.value = value
    }

    public var description: String { value }
}

/// A workspace as known to the session layer. The bookmark data that grants
/// filesystem access is stored separately by the workspace access service and
/// never crosses into transcripts or sync records.
public struct WorkspaceDescriptor: Hashable, Codable, Sendable {
    public let id: WorkspaceID
    public var displayName: String
    /// Absolute path for local display and reopening; never sent off-device.
    public var localPathHint: String
    public var isGitRepository: Bool
    public var lastOpenedAt: Date

    public init(
        id: WorkspaceID = WorkspaceID(),
        displayName: String,
        localPathHint: String,
        isGitRepository: Bool,
        lastOpenedAt: Date
    ) {
        self.id = id
        self.displayName = displayName
        self.localPathHint = localPathHint
        self.isGitRepository = isGitRepository
        self.lastOpenedAt = lastOpenedAt
    }
}

/// Agent launch configuration chosen in the composer before a run.
public struct AgentConfiguration: Hashable, Codable, Sendable {
    public var modelID: String
    public var reasoningEffort: ReasoningEffort
    public var role: AgentRole
    public var permissionMode: PermissionMode
    public var location: SessionLocation
    public var computerUseEnabled: Bool

    public init(
        modelID: String,
        reasoningEffort: ReasoningEffort = .medium,
        role: AgentRole = .engineer,
        permissionMode: PermissionMode = .askBeforeChanges,
        location: SessionLocation = .local,
        computerUseEnabled: Bool = false
    ) {
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.role = role
        self.permissionMode = permissionMode
        self.location = location
        self.computerUseEnabled = computerUseEnabled
    }
}

public enum ReasoningEffort: String, Codable, CaseIterable, Sendable {
    case low
    case medium
    case high
}

public enum AgentRole: String, Codable, CaseIterable, Sendable {
    case engineer
    case reviewer
    case explainer
}

public struct CodeSession: Hashable, Codable, Sendable {
    public let id: CodeSessionID
    public let workspaceID: WorkspaceID
    public var title: String
    public var status: SessionStatus
    public var configuration: AgentConfiguration
    public var isFavorite: Bool
    public var gitBranch: String?
    public var hasPendingApproval: Bool
    public var lastErrorSummary: String?
    public let createdAt: Date
    public var updatedAt: Date

    public init(
        id: CodeSessionID = CodeSessionID(),
        workspaceID: WorkspaceID,
        title: String,
        status: SessionStatus = .idle,
        configuration: AgentConfiguration,
        isFavorite: Bool = false,
        gitBranch: String? = nil,
        hasPendingApproval: Bool = false,
        lastErrorSummary: String? = nil,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.workspaceID = workspaceID
        self.title = title
        self.status = status
        self.configuration = configuration
        self.isFavorite = isFavorite
        self.gitBranch = gitBranch
        self.hasPendingApproval = hasPendingApproval
        self.lastErrorSummary = lastErrorSummary
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
