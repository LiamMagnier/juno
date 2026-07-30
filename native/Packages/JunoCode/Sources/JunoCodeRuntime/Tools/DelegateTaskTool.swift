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
    private let reasoningEffort: ReasoningEffort?
    private let parentSystemPrompt: String

    /// How long a single delegation may run before it is stopped.
    ///
    /// A sub-agent blocks the parent's turn for its whole life, so "no limit" means
    /// one unproductive child can hold the reader's session open forever. Generous
    /// enough that a real investigation finishes well inside it; short enough that a
    /// stuck one gives the turn back.
    private static let budget: Duration = .seconds(10 * 60)

    public init(
        model: any AgentModelClient,
        registry: ToolRegistry,
        store: CodeSessionStore,
        workspaceID: WorkspaceID,
        workspaceName: String,
        modelID: String,
        reasoningEffort: ReasoningEffort?,
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
            // The stored record needs a concrete depth — it is what the inspector
            // shows for the child and what a resume would restore. The *wire*
            // decision stays optional and is passed to the orchestrator below, so
            // a model that takes no thinking parameter still gets none.
            reasoningEffort: reasoningEffort ?? .medium,
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
            // Stop has to be able to reach the child, and the child needs an outer
            // bound.
            //
            // `AgentOrchestrator.submit` runs its loop in an *unstructured* `Task`,
            // which does not inherit cancellation from whoever created it. So the
            // parent's `stop()` — which cancels the parent's run task and then waits
            // on `await task.value` — was waiting on a tool call that was itself
            // waiting on a child nothing had told to stop. Pressing Stop during a
            // delegation therefore did nothing at all until the sub-agent finished
            // on its own, however long that took.
            //
            // The cancellation handler closes that, and the watchdog covers the case
            // nobody is watching: a sub-agent had no budget of any kind beyond its
            // 18-iteration cap, so one that made no progress could hold the parent
            // open indefinitely.
            try await withTaskCancellationHandler {
                try await orchestrator.submit(prompt: task)
                let watchdog = Task {
                    try? await Task.sleep(for: Self.budget)
                    await orchestrator.stop()
                }
                await orchestrator.awaitCompletion()
                watchdog.cancel()
            } onCancel: {
                // Detached because `onCancel` is synchronous and the actor hop is
                // not; the orchestrator's own `stop()` denies pending approvals and
                // cancels its loop, which is what releases `awaitCompletion` above.
                Task { await orchestrator.stop() }
            }
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
