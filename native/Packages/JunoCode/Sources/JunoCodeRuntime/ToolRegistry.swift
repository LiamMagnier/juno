import Foundation
import JunoCodeCore

/// The set of tools available to one session, with input validation and the
/// permission gate applied before any execution.
public struct ToolRegistry: Sendable {
    private let tools: [String: any CodeTool]
    /// Adds what a call earned by reaching somewhere new — a folder's
    /// instruction file — to its result. Nil adds nothing.
    private let contextProvider: (any ToolResultContextProviding)?

    /// Tools that can inspect a workspace without mutating it or starting a
    /// process. Ask and Plan sessions expose exactly this set.
    ///
    /// The session tools are here too — the todo list, a question for the
    /// reader, a skill's instructions and the plan handoff change no file and
    /// start nothing — though a session adds them itself, with its own
    /// coordinators, rather than finding them in a workspace's registry.
    public static let inspectionToolNames: Set<String> = [
        "read_file", "list_directory", "find_files", "glob", "grep",
        "git_status", "git_diff", "git_log", "web_search",
        "todo_write", "ask_user", "exit_plan", "use_skill",
    ]

    public init(tools: [any CodeTool], contextProvider: (any ToolResultContextProviding)? = nil) {
        var byName: [String: any CodeTool] = [:]
        for tool in tools {
            byName[tool.name] = tool
        }
        self.tools = byName
        self.contextProvider = contextProvider
    }

    /// The same tools, with `provider` adding context to their results.
    public func withContextProvider(_ provider: (any ToolResultContextProviding)?) -> ToolRegistry {
        ToolRegistry(tools: allTools, contextProvider: provider)
    }

    /// The standard local tool set over the injected service protocols.
    public static func standard(
        files: any FileOperating,
        index: any WorkspaceIndexing,
        executor: any CommandExecuting,
        git: any GitServicing,
        tests: any TestRunning,
        goalStore: CodeSessionStore? = nil,
        changes: (any WorkspaceChangeDetecting)? = nil,
        webSearch: (any CodeWebSearching)? = nil,
        shells: (any ShellSessionManaging)? = nil,
        workingDirectories: SessionWorkingDirectories? = nil,
        workspaceRoot: String = "",
        additionalTools: [any CodeTool] = []
    ) -> ToolRegistry {
        var tools: [any CodeTool] = [
            ReadFileTool(files: files),
            ListDirectoryTool(index: index),
            FindFilesTool(index: index),
            GlobTool(index: index),
            GrepTool(index: index),
            CreateFileTool(files: files),
            WriteFileTool(files: files),
            ApplyPatchTool(files: files),
            MultiEditTool(files: files),
            DeleteFileTool(files: files),
            MoveFileTool(files: files),
            RunCommandTool(
                executor: executor,
                changes: changes,
                directories: workingDirectories,
                workspaceRoot: workspaceRoot
            ),
            GitStatusTool(git: git),
            GitDiffTool(git: git),
            GitLogTool(git: git),
            GitCommitTool(git: git),
            RunTestsTool(tests: tests),
        ]
        if let shells {
            tools.append(ShellStartTool(shells: shells, directories: workingDirectories))
            tools.append(ShellOutputTool(shells: shells))
            tools.append(ShellWriteTool(shells: shells))
            tools.append(ShellKillTool(shells: shells))
        }
        if let goalStore {
            tools.append(UpdateGoalTool(store: goalStore))
        }
        if let webSearch {
            tools.append(WebSearchTool(service: webSearch))
        }
        tools.append(WebFetchTool())
        tools.append(contentsOf: additionalTools)
        return ToolRegistry(tools: tools)
    }

    public var allTools: [any CodeTool] {
        tools.values.sorted { $0.name < $1.name }
    }

    public func tool(named name: String) -> (any CodeTool)? {
        tools[name]
    }

    public func inspectionOnly() -> ToolRegistry {
        ToolRegistry(
            tools: allTools.filter { Self.inspectionToolNames.contains($0.name) },
            contextProvider: contextProvider
        )
    }

    /// Adds the tools advertised by configured MCP servers to this registry.
    /// Discovery is explicit and asynchronous because it may start a server;
    /// the returned registry still uses the normal validation and Juno
    /// permission path for every invocation.
    public func includingMCPTools(from mcpRegistry: MCPToolRegistry) async throws -> ToolRegistry {
        let mcpTools = try await mcpRegistry.allTools().map {
            MCPCodeTool(registry: mcpRegistry, reference: $0)
        }
        return ToolRegistry(tools: allTools + mcpTools, contextProvider: contextProvider)
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
    ///
    /// - Parameter hookPermission: a `PreToolUse` hook's answer about the
    ///   prompt. The coordinator weighs it below the reader's own rules.
    public func authorizeInvocation(
        toolName: String,
        input: JSONValue,
        permissions: PermissionCoordinator,
        hookPermission: AgentHookPermission? = nil
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
            summary: tool.summary(input: input),
            approvalPolicy: tool.approvalPolicy,
            subject: ToolRuleSubjects.subject(toolName: toolName, input: input),
            hookPermission: hookPermission
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
        let result = try await tool.execute(input: input, context: context)
        guard !result.isError,
              let contextProvider,
              let added = await contextProvider.context(
                  forTouchedPaths: ToolTouchedPaths.paths(toolName: toolName, input: input),
                  sessionID: context.sessionID
              )
        else { return result }
        return ToolResult(
            content: result.content,
            isError: result.isError,
            images: result.images,
            sideEffects: result.sideEffects,
            endsRun: result.endsRun,
            appendedContext: result.appendedContext.map { $0 + "\n\n" + added } ?? added
        )
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
