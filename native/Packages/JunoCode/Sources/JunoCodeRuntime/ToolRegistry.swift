import Foundation
import JunoCodeCore

/// The set of tools available to one session, with input validation and the
/// permission gate applied before any execution.
public struct ToolRegistry: Sendable {
    private let tools: [String: any CodeTool]

    public init(tools: [any CodeTool]) {
        var byName: [String: any CodeTool] = [:]
        for tool in tools {
            byName[tool.name] = tool
        }
        self.tools = byName
    }

    /// The standard local tool set over the injected service protocols.
    public static func standard(
        files: any FileOperating,
        index: any WorkspaceIndexing,
        executor: any CommandExecuting,
        git: any GitServicing,
        tests: any TestRunning
    ) -> ToolRegistry {
        ToolRegistry(tools: [
            ReadFileTool(files: files),
            ListDirectoryTool(index: index),
            FindFilesTool(index: index),
            GlobTool(index: index),
            GrepTool(index: index),
            CreateFileTool(files: files),
            WriteFileTool(files: files),
            ApplyPatchTool(files: files),
            DeleteFileTool(files: files),
            MoveFileTool(files: files),
            RunCommandTool(executor: executor),
            GitStatusTool(git: git),
            GitDiffTool(git: git),
            GitLogTool(git: git),
            GitCommitTool(git: git),
            RunTestsTool(tests: tests),
        ])
    }

    public var allTools: [any CodeTool] {
        tools.values.sorted { $0.name < $1.name }
    }

    public func tool(named name: String) -> (any CodeTool)? {
        tools[name]
    }

    /// Validates input shape; returns a message when invalid.
    public func validateInput(toolName: String, input: JSONValue) -> String? {
        guard let tool = tools[toolName] else {
            return "Unknown tool '\(toolName)'."
        }
        return SchemaValidator.validate(input: input, against: tool.inputSchema)
    }

    /// Validates and authorizes one invocation, suspending while an approval
    /// is pending. Throws when the action is refused. On success the action
    /// may be executed with `executeAuthorized`.
    public func authorizeInvocation(
        toolName: String,
        input: JSONValue,
        permissions: PermissionCoordinator
    ) async throws {
        guard let tool = tools[toolName] else {
            throw ToolError.unknownTool(name: toolName)
        }
        if let problem = SchemaValidator.validate(input: input, against: tool.inputSchema) {
            throw ToolError.invalidInput(message: problem)
        }
        if let refusal = tool.precheck(input: input) {
            throw refusal
        }
        let risk = tool.assessRisk(input: input)
        let digest = tool.actionDigest(input: input)
        let outcome = await permissions.authorize(
            toolName: toolName,
            actionDigest: digest,
            risk: risk,
            summary: tool.summary(input: input)
        )
        switch outcome {
        case .allowed:
            return
        case let .approved(request):
            // The approval must still bind this exact action, unexpired.
            guard request.authorizes(digest: tool.actionDigest(input: input), at: Date()) else {
                throw ToolError.denied(reason: "The approval no longer matches the action.")
            }
        case let .denied(reason):
            throw ToolError.denied(reason: reason)
        }
    }

    /// Executes a previously authorized invocation.
    public func executeAuthorized(
        toolName: String,
        input: JSONValue,
        context: ToolContext
    ) async throws -> ToolResult {
        guard let tool = tools[toolName] else {
            throw ToolError.unknownTool(name: toolName)
        }
        try Task.checkCancellation()
        return try await tool.execute(input: input, context: context)
    }

    /// Full gated invocation: validate → assess → authorize (suspending when
    /// approval is required) → re-verify the digest → execute.
    public func invoke(
        toolName: String,
        input: JSONValue,
        context: ToolContext,
        permissions: PermissionCoordinator
    ) async throws -> ToolResult {
        try await authorizeInvocation(
            toolName: toolName,
            input: input,
            permissions: permissions
        )
        return try await executeAuthorized(toolName: toolName, input: input, context: context)
    }
}
