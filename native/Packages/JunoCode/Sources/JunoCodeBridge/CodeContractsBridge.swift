import Foundation
import JunoCodeCore
import JunoCodeKit

/// Adapters between the standalone Juno Code domain types and the shared
/// `JunoCodeKit` contracts owned by the main native integration. This is the
/// single composition seam: nothing else in the JunoCode package depends on
/// JunoNativeKit.
public enum CodeContractsBridge {
    // MARK: - Locations

    public static func executionLocation(
        from location: SessionLocation
    ) -> CodeExecutionLocation {
        switch location {
        case .local: return .local
        case .cloud: return .cloud
        case .remote: return .remote
        }
    }

    public static func sessionLocation(
        from location: CodeExecutionLocation
    ) -> SessionLocation {
        switch location {
        case .local: return .local
        case .cloud: return .cloud
        case .remote: return .remote
        }
    }

    // MARK: - Permission modes

    /// The local model has four tiers; the shared contract has three. The
    /// two interactive local tiers collapse onto `acceptEdits`, and the
    /// distinction is preserved locally in the session configuration.
    public static func contractPermission(
        from mode: JunoCodeCore.PermissionMode
    ) -> CodePermissionMode {
        switch mode {
        case .readOnly: return .readOnly
        case .askBeforeChanges, .workspaceWrite: return .acceptEdits
        case .fullAccess: return .fullAccess
        }
    }

    public static func localPermission(
        from mode: CodePermissionMode
    ) -> JunoCodeCore.PermissionMode {
        switch mode {
        case .readOnly: return .readOnly
        case .acceptEdits: return .askBeforeChanges
        case .fullAccess: return .fullAccess
        }
    }

    // MARK: - Paths

    public static func contractPath(
        from path: JunoCodeCore.WorkspacePath
    ) throws -> WorkspaceRelativePath {
        try WorkspaceRelativePath(path.value)
    }

    public static func localPath(
        from path: WorkspaceRelativePath
    ) throws -> JunoCodeCore.WorkspacePath {
        try JunoCodeCore.WorkspacePath(path.value)
    }

    // MARK: - Approvals

    public static func contractApproval(
        from request: JunoCodeCore.ApprovalRequest
    ) throws -> CodeApprovalRequest {
        CodeApprovalRequest(
            id: request.id,
            actionDigest: try ActionDigest(request.actionDigest),
            summary: request.summary,
            expiresAt: request.expiresAt
        )
    }

    // MARK: - Task configuration

    /// Builds the shared cloud/remote task configuration from a local
    /// session's configuration and prompt.
    public static func taskConfiguration(
        repositoryID: String,
        baseBranch: String,
        prompt: String,
        configuration: AgentConfiguration
    ) throws -> CodeTaskConfiguration {
        try CodeTaskConfiguration(
            repositoryID: repositoryID,
            baseBranch: baseBranch,
            prompt: prompt,
            location: executionLocation(from: configuration.location),
            mode: .code,
            permission: contractPermission(from: configuration.permissionMode),
            modelID: configuration.modelID,
            reasoningEffort: configuration.reasoningEffort.rawValue
        )
    }
}
