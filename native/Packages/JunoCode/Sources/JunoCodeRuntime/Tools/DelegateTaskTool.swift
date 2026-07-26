import Foundation
import JunoCodeCore

/// Creates an inspectable, read-only child session for a bounded task and waits
/// for its result. Child sessions use the same event store as normal work, so
/// they appear in the sidebar and retain their reasoning summaries, tool calls
/// and final answer instead of disappearing into an opaque background call.
public struct DelegateTaskTool: CodeTool {
    private let model: any AgentModelClient
    private let registry: ToolRegistry
    private let store: CodeSessionStore
    private let workspaceID: WorkspaceID
    private let workspaceName: String
    private let modelID: String
    private let reasoningEffort: ReasoningEffort
    private let parentSystemPrompt: String

    public init(
        model: any AgentModelClient,
        registry: ToolRegistry,
        store: CodeSessionStore,
        workspaceID: WorkspaceID,
        workspaceName: String,
        modelID: String,
        reasoningEffort: ReasoningEffort,
        parentSystemPrompt: String
    ) {
        self.model = model
        self.registry = registry
        self.store = store
        self.workspaceID = workspaceID
        self.workspaceName = workspaceName
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.parentSystemPrompt = parentSystemPrompt
    }

    public let name = "delegate_task"
    public let description =
        "Delegate a bounded read-only investigation to an inspectable sub-agent. Use for codebase exploration, review, or explanation that can proceed independently."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "task": ["type": "string"],
                "role": [
                    "type": "string",
                    "enum": ["engineer", "reviewer", "explainer"],
                ],
                "title": ["type": "string"],
            ],
            "required": ["task"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        "Delegate: \(input["title"]?.stringValue ?? input["task"]?.stringValue ?? "task")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let task = input["task"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !task.isEmpty
        else {
            throw ToolError.invalidInput(message: "task is required.")
        }
        let role = AgentRole(rawValue: input["role"]?.stringValue ?? "") ?? .engineer
        let requestedTitle = input["title"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let titleSource = requestedTitle.flatMap { $0.isEmpty ? nil : $0 } ?? task
        let title = String(titleSource.prefix(80))
        let configuration = AgentConfiguration(
            modelID: modelID,
            reasoningEffort: reasoningEffort,
            role: role,
            permissionMode: .readOnly,
            location: .local,
            computerUseEnabled: false
        )
        let child = try await store.createSession(
            workspaceID: workspaceID,
            workspaceName: workspaceName,
            title: "Sub-agent · \(title)",
            configuration: configuration,
            gitBranch: nil
        )
        let permissions = PermissionCoordinator(sessionID: child.id, mode: .readOnly)
        let orchestrator = AgentOrchestrator(
            sessionID: child.id,
            model: model,
            registry: registry,
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(
                maximumIterations: 18,
                systemPrompt: """
                \(parentSystemPrompt)

                You are a read-only Juno Code sub-agent. Complete only the
                delegated investigation. Do not modify files or run commands
                with side effects. Return a concise result with concrete file
                references and uncertainties. You cannot delegate further.
                """
            ),
            modelID: modelID,
            reasoningEffort: reasoningEffort
        )
        do {
            try await orchestrator.submit(prompt: task)
            await orchestrator.awaitCompletion()
        } catch {
            try? await store.setStatus(id: child.id, status: .failed)
            throw error
        }

        let events = await store.events(for: child.id)
        let answer = events.reversed().compactMap { event -> String? in
            if case .assistantMessage(let message) = event.payload {
                return message.text
            }
            return nil
        }.first ?? "The sub-agent completed without a written result."
        return ToolResult(
            content: """
            Sub-agent session: \(child.id.value)
            \(answer)
            """
        )
    }
}
