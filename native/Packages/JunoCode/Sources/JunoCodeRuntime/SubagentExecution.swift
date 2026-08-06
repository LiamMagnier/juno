import Foundation
import JunoCodeCore

/// A narrow request from the runtime to the host application. The runtime does
/// not know how a local workspace is bookmarked or how Git worktrees are
/// created; it asks the host for a bounded execution environment instead.
public struct SubagentExecutionRequest: Sendable {
    public let taskID: String
    public let parentSessionID: CodeSessionID
    public let title: String
    public let branch: String
    public let mode: SubagentExecutionMode

    public init(
        taskID: String,
        parentSessionID: CodeSessionID,
        title: String,
        branch: String,
        mode: SubagentExecutionMode
    ) {
        self.taskID = taskID
        self.parentSessionID = parentSessionID
        self.title = title
        self.branch = branch
        self.mode = mode
    }
}

/// The complete, already-bounded tool environment for one child. Returning a
/// registry rather than a path prevents the child from manufacturing a second
/// executor with weaker containment.
public struct SubagentExecutionEnvironment: Sendable {
    public let registry: ToolRegistry
    public let workspaceName: String
    public let executionRootPath: String?
    public let gitBranch: String?
    public let permissionMode: PermissionMode
    /// Host-owned finalization, normally an isolated snapshot commit. It is
    /// never exposed as a child tool and therefore cannot bypass the child's
    /// permission contract for the parent checkout.
    public let finalize: SubagentExecutionFinalizer?

    public init(
        registry: ToolRegistry,
        workspaceName: String,
        executionRootPath: String? = nil,
        gitBranch: String? = nil,
        permissionMode: PermissionMode,
        finalize: SubagentExecutionFinalizer? = nil
    ) {
        self.registry = registry
        self.workspaceName = workspaceName
        self.executionRootPath = executionRootPath
        self.gitBranch = gitBranch
        self.permissionMode = permissionMode
        self.finalize = finalize
    }

    public static func readOnly(
        registry: ToolRegistry,
        workspaceName: String
    ) -> SubagentExecutionEnvironment {
        SubagentExecutionEnvironment(
            registry: registry,
            workspaceName: workspaceName,
            permissionMode: .readOnly
        )
    }
}

public typealias SubagentExecutionFinalizer = @Sendable () async throws -> String?

/// Host-owned capability for creating an execution environment. The closure is
/// intentionally optional: existing embedders keep read-only delegation and
/// must explicitly compose isolated writes before a model can request them.
public typealias SubagentExecutionFactory = @Sendable (
    SubagentExecutionRequest
) async throws -> SubagentExecutionEnvironment
