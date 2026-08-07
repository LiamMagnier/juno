import Foundation
import JunoCodeCore

/// Runs bounded read-only investigations as sub-agents of the current session,
/// and streams each one's life back into the *delegating* transcript.
///
/// A sub-agent is still a real session — it keeps its own transcript, reasoning
/// summaries, tool calls and final answer, which is what makes it inspectable
/// rather than an opaque background call. What changed is that it is now a
/// *child* session (`CodeSession.parentSessionID`), so no list surface shows it
/// as a conversation of its own, and a `subagentUpdated` event is written into
/// the parent on every transition, so the parent conversation can show it
/// working without anyone navigating away from it.
///
/// Several investigations run at once, bounded at ``maximumConcurrent``. That
/// bound is the cloud runner's (`runner/agent-core/src/subagents.ts`), and the
/// per-call ceiling is its `maxPerTurn`: the two runtimes are read through the
/// same panel, and a panel that can only ever hold one row on one of them would
/// be describing the tool rather than the work.
public struct DelegateTaskTool: CodeTool {
    private let model: any AgentModelClient
    private let registry: ToolRegistry
    private let store: CodeSessionStore
    private let workspaceID: WorkspaceID
    private let workspaceName: String
    private let modelID: String
    private let reasoningEffort: ReasoningEffort?
    private let parentSystemPrompt: String
    /// Optional host-owned live controls. The runtime remains embeddable without
    /// a UI, while Desktop Code can expose the child's real approval and stop
    /// capabilities in its inspector.
    private let controls: SubagentControlRegistry?
    /// Supplied by a host that can create a real isolated checkout. Without it
    /// delegation remains read-only, even if the model asks for writes.
    private let executionFactory: SubagentExecutionFactory?

    /// How long one `delegate_task` call may run before its agents are stopped.
    ///
    /// Sub-agents block the parent's turn for their whole life, so "no limit"
    /// means one unproductive child can hold the reader's session open forever.
    /// Generous enough that a real investigation finishes well inside it; short
    /// enough that a stuck one gives the turn back.
    ///
    /// It is a budget for the *call*, not for each agent: the deadline is
    /// computed once and shared, so delegating four tasks cannot quietly buy
    /// four times the parent's patience.
    private static let budget: Duration = .seconds(10 * 60)

    /// How many sub-agents run at the same time, and how many one call may ask
    /// for. Both match the cloud runner (`maxConcurrent` clamped 1…3,
    /// `maxPerTurn` 4).
    public static let maximumConcurrent = 3
    public static let maximumPerCall = 4

    public init(
        model: any AgentModelClient,
        registry: ToolRegistry,
        store: CodeSessionStore,
        workspaceID: WorkspaceID,
        workspaceName: String,
        modelID: String,
        reasoningEffort: ReasoningEffort?,
        parentSystemPrompt: String,
        executionFactory: SubagentExecutionFactory? = nil,
        controls: SubagentControlRegistry? = nil
    ) {
        self.model = model
        self.registry = registry
        self.store = store
        self.workspaceID = workspaceID
        self.workspaceName = workspaceName
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.parentSystemPrompt = parentSystemPrompt
        self.executionFactory = executionFactory
        self.controls = controls
    }

    public let name = "delegate_task"
    public let description = """
       Delegate bounded, inspectable work to sub-agents. Read-only investigation is \
       the default; an implementation task may request `workspace_write` only when \
       the host can provide an isolated Git worktree. The parent checkout is never \
       used for delegated writes. \
        Each task may choose a model and thinking depth; omitted values inherit \
        the parent session. \
       Pass `tasks` with up to \(DelegateTaskTool.maximumPerCall) genuinely independent \
       investigations to run them concurrently (\(DelegateTaskTool.maximumConcurrent) at a \
       time) and get every answer back in one call; pass `task` for a single one. Each \
       sub-agent starts with a fresh context, so its instruction must be self-contained, \
       and it cannot delegate further.
       """

    public var inputSchema: JSONValue {
        let taskSchema: JSONValue = [
            "type": "object",
            "properties": [
                "task": ["type": "string", "description": "Complete, self-contained instructions"],
                "role": [
                    "type": "string",
                    "enum": ["engineer", "reviewer", "explainer"],
                ],
                "model_id": [
                    "type": "string",
                    "description": "Optional model id for this sub-agent; defaults to the parent model",
                ],
                "reasoning_effort": [
                    "type": "string",
                    "enum": .array(ReasoningEffort.allCases.map { .string($0.rawValue) }),
                    "description": "Optional thinking depth for this sub-agent; defaults to the parent setting",
                ],
                "mode": [
                    "type": "string",
                    "enum": .array(SubagentExecutionMode.allCases.map { .string($0.rawValue) }),
                    "description": "read_only (default) or workspace_write in an isolated worktree",
                ],
                "title": ["type": "string", "description": "Short imperative title"],
            ],
            "required": ["task"],
        ]
        return [
            "type": "object",
            "properties": [
                "task": ["type": "string"],
                "role": [
                    "type": "string",
                    "enum": ["engineer", "reviewer", "explainer"],
                ],
                "model_id": ["type": "string"],
                "reasoning_effort": [
                    "type": "string",
                    "enum": .array(ReasoningEffort.allCases.map { .string($0.rawValue) }),
                ],
                "mode": [
                    "type": "string",
                    "enum": .array(SubagentExecutionMode.allCases.map { .string($0.rawValue) }),
                ],
                "title": ["type": "string"],
                "tasks": [
                    "type": "array",
                    "description":
                        "Independent investigations to run concurrently. Use instead of `task`.",
                    "items": taskSchema,
                ],
            ],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        let specs = (try? Self.specs(from: input, toolCallID: "")) ?? []
        switch specs.count {
        case 0: return "Delegate: task"
        case 1: return "Delegate: \(specs[0].title)"
        default:
            return "Delegate \(specs.count) tasks: "
                + specs.map(\.title).joined(separator: ", ")
        }
    }

    // MARK: - Specs

    /// One delegated investigation, exactly as the model asked for it.
    struct Spec: Sendable {
        /// Unique within the session and stable for this agent's whole life:
        /// the panel keys its rows on it, so it must not be re-derived from
        /// anything that changes (a title, a session id that does not exist
        /// yet).
        let agentID: String
        let title: String
        let task: String
        let role: AgentRole
        let modelID: String?
        let reasoningEffort: ReasoningEffort?
        let mode: SubagentExecutionMode
    }

    static func specs(from input: JSONValue, toolCallID: String) throws -> [Spec] {
        var raw: [JSONValue] = []
        if let array = input["tasks"]?.arrayValue, !array.isEmpty {
            raw = array
        }
        if input["task"]?.stringValue != nil {
            // Both shapes in one call is not an error worth refusing: the
            // singular is appended so nothing the model asked for is silently
            // dropped.
            raw.append(input)
        }
        guard !raw.isEmpty else {
            throw ToolError.invalidInput(message: "task is required.")
        }
        guard raw.count <= maximumPerCall else {
            throw ToolError.invalidInput(
                message:
                    "At most \(maximumPerCall) tasks may be delegated in one call; \(raw.count) were requested."
            )
        }
        return try raw.enumerated().map { index, entry in
            guard let task = entry["task"]?.stringValue?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !task.isEmpty
            else {
                throw ToolError.invalidInput(message: "task is required.")
            }
            let requested = entry["title"]?.stringValue?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let source = requested.flatMap { $0.isEmpty ? nil : $0 }
                ?? (task.split(separator: "\n").first.map(String.init) ?? task)
            return Spec(
                agentID: "\(toolCallID)#\(index)",
                title: String(source.prefix(80)),
                task: task,
                role: AgentRole(rawValue: entry["role"]?.stringValue ?? "") ?? .engineer,
                modelID: entry["model_id"]?.stringValue.flatMap { raw in
                    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                    return trimmed.isEmpty ? nil : trimmed
                },
                reasoningEffort: entry["reasoning_effort"]?.stringValue.flatMap(ReasoningEffort.init(rawValue:)),
                mode: SubagentExecutionMode(
                    rawValue: entry["mode"]?.stringValue ?? SubagentExecutionMode.readOnly.rawValue
                ) ?? .readOnly
            )
        }
    }

    // MARK: - Execution

    /// What one sub-agent left behind, for the report handed back to the model.
    private struct Outcome: Sendable {
        let index: Int
        let title: String
        let status: SubagentStatus
        let answer: String
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let specs = try Self.specs(from: input, toolCallID: context.toolCallID)
        let parentSessionID = context.sessionID
        let deadline = ContinuousClock.now.advanced(by: Self.budget)

        // Announced before any of them starts, so the panel has a row for every
        // agent the model asked for rather than only for the ones that won a
        // slot. No activity line here: `queued` already says what it is, and a
        // phrase like "waiting for a slot" would be wrong for the first three,
        // which start immediately.
        for spec in specs {
            await publish(
                spec,
                toolCallID: context.toolCallID,
                parentSessionID: parentSessionID,
                status: .queued
            )
        }

        // Bounded rather than "all at once": a task group started with every
        // spec would run four full agent loops against one provider account and
        // one workspace index, which is where a delegated turn stops being
        // faster than doing the work in the parent.
        var outcomes = await withTaskGroup(of: Outcome.self) { group in
            var results: [Outcome] = []
            var next = 0
            func start() {
                guard next < specs.count else { return }
                let spec = specs[next]
                let index = next
                next += 1
                group.addTask {
                    await self.run(
                        spec,
                        index: index,
                        toolCallID: context.toolCallID,
                        parentSessionID: parentSessionID,
                        deadline: deadline
                    )
                }
            }
            for _ in 0..<min(Self.maximumConcurrent, specs.count) { start() }
            while let outcome = await group.next() {
                results.append(outcome)
                start()
            }
            return results
        }
        outcomes.sort { $0.index < $1.index }

        // A cancelled turn must reach the orchestrator as a cancellation, not as
        // a report of agents that "finished" the moment Stop was pressed.
        try Task.checkCancellation()

        // The first line becomes the call's `resultSummary` in the transcript —
        // the orchestrator records only that much — so it has to be the sentence
        // a reader wants there. Everything below it is for the model, which is
        // told elsewhere to reconcile these reports rather than paste them.
        let completed = outcomes.filter { $0.status == .completed }.count
        let content: String
        if let only = outcomes.first, outcomes.count == 1 {
            content = "Sub-agent \(only.status.rawValue): \(only.title)\n\n\(only.answer)"
        } else {
            let headline = "\(outcomes.count) sub-agents finished — \(completed) completed, "
                + "\(outcomes.count - completed) did not."
            let body = outcomes
                .map { "## \($0.title) (\($0.status.rawValue))\n\($0.answer)" }
                .joined(separator: "\n\n")
            content = "\(headline)\n\n\(body)"
        }
        return ToolResult(content: content, isError: completed == 0)
    }

    /// One sub-agent, from its own session to its own answer.
    ///
    /// Every exit publishes a terminal update. A row that stayed "Running"
    /// because the one path that failed forgot to say so is worse than no panel
    /// at all — it is a panel that lies about what the machine is doing.
    private func run(
        _ spec: Spec,
        index: Int,
        toolCallID: String,
        parentSessionID: CodeSessionID,
        deadline: ContinuousClock.Instant
    ) async -> Outcome {
        let childModelID = spec.modelID ?? modelID
        let childReasoningEffort = spec.reasoningEffort ?? reasoningEffort
        await publish(
            spec,
            toolCallID: toolCallID,
            parentSessionID: parentSessionID,
            status: .preparing,
            currentActivity: "Opening a session"
        )

        let environment: SubagentExecutionEnvironment
        do {
            if spec.mode == .workspaceWrite {
                guard let executionFactory else {
                    throw ToolError.denied(
                        reason: "Write-capable sub-agents are unavailable because no isolated worktree factory is configured."
                    )
                }
                let request = SubagentExecutionRequest(
                    taskID: spec.agentID,
                    parentSessionID: parentSessionID,
                    title: spec.title,
                    branch: Self.branchName(for: spec),
                    mode: spec.mode
                )
                environment = try await executionFactory(request)
            } else {
                environment = .readOnly(
                    registry: registry,
                    workspaceName: workspaceName
                )
            }
        } catch {
            let message = "The sub-agent's execution environment could not be created: \(error)"
            await publish(
                spec,
                toolCallID: toolCallID,
                parentSessionID: parentSessionID,
                status: .failed,
                completedAt: Date(),
                error: message
            )
            return Outcome(index: index, title: spec.title, status: .failed, answer: message)
        }

        let configuration = AgentConfiguration(
            modelID: childModelID,
            // The stored record needs a concrete depth — it is what the panel
            // shows for the child and what a resume would restore. The *wire*
            // decision stays optional and is passed to the orchestrator below,
            // so a model that takes no thinking parameter still gets none.
            reasoningEffort: childReasoningEffort ?? .medium,
            role: spec.role,
            permissionMode: environment.permissionMode,
            location: .local,
            computerUseEnabled: false
        )

        let child: CodeSession
        do {
            child = try await store.createSession(
                workspaceID: workspaceID,
                executionRootPath: environment.executionRootPath,
                workspaceName: environment.workspaceName,
                title: spec.title,
                configuration: configuration,
                gitBranch: environment.gitBranch,
                parentSessionID: parentSessionID
            )
        } catch {
            let message = "The sub-agent's session could not be created: \(error)"
            await publish(
                spec,
                toolCallID: toolCallID,
                parentSessionID: parentSessionID,
                status: .failed,
                completedAt: Date(),
                error: message
            )
            return Outcome(index: index, title: spec.title, status: .failed, answer: message)
        }

        let startedAt = Date()
        await publish(
            spec,
            toolCallID: toolCallID,
            parentSessionID: parentSessionID,
            childSessionID: child.id,
            status: .running,
            currentActivity: "Reading the project",
            startedAt: startedAt
        )

        let permissions = PermissionCoordinator(
            sessionID: child.id,
            mode: environment.permissionMode
        )
        let childInstruction: String
        switch spec.mode {
        case .readOnly:
            childInstruction = "You are a read-only Juno Code sub-agent. Do not modify files, run commands with side effects, commit, or control the computer."
        case .workspaceWrite:
            childInstruction = "You are a write-capable Juno Code sub-agent working only in an isolated Git worktree. Implement the delegated task there, run appropriate verification, and do not merge or modify the parent checkout."
        }
        let orchestrator = AgentOrchestrator(
            sessionID: child.id,
            model: model,
            registry: environment.registry,
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(
                maximumIterations: 18,
                systemPrompt: """
                \(parentSystemPrompt)

                \(childInstruction) Complete only the delegated task. Return a
                concise result with concrete file references, verification
                evidence, and uncertainties. You cannot delegate further.
                """
            ),
            modelID: childModelID,
            reasoningEffort: childReasoningEffort
        )
        await controls?.register(
            childSessionID: child.id,
            parentSessionID: parentSessionID,
            permissions: permissions,
            orchestrator: orchestrator
        )
        let usage = UsageTally()
        await orchestrator.observeUsage { input, output in
            Task { await usage.record(input: input, output: output) }
        }

        do {
            // Stop has to be able to reach the child, and the child needs an
            // outer bound.
            //
            // `AgentOrchestrator.submit` runs its loop in an *unstructured*
            // `Task`, which does not inherit cancellation from whoever created
            // it. So the parent's `stop()` — which cancels the parent's run task
            // and then waits on `await task.value` — was waiting on a tool call
            // that was itself waiting on a child nothing had told to stop.
            // Pressing Stop during a delegation therefore did nothing at all
            // until the sub-agent finished on its own, however long that took.
            //
            // The cancellation handler closes that, and the watchdog covers the
            // case nobody is watching: a sub-agent had no budget of any kind
            // beyond its 18-iteration cap, so one that made no progress could
            // hold the parent open indefinitely.
            try await withTaskCancellationHandler {
                try await orchestrator.submit(prompt: spec.task)
                let watchdog = Task {
                    try? await Task.sleep(until: deadline, clock: .continuous)
                    await orchestrator.stop()
                }
                await orchestrator.awaitCompletion()
                watchdog.cancel()
            } onCancel: {
                // Detached because `onCancel` is synchronous and the actor hop
                // is not; the orchestrator's own `stop()` denies pending
                // approvals and cancels its loop, which is what releases
                // `awaitCompletion` above.
                Task { await orchestrator.stop() }
            }
        } catch {
            let message = "The sub-agent could not start: \(error)"
            try? await store.setStatus(id: child.id, status: .failed)
            await orchestrator.release()
            await publish(
                spec,
                toolCallID: toolCallID,
                parentSessionID: parentSessionID,
                childSessionID: child.id,
                status: .failed,
                startedAt: startedAt,
                completedAt: Date(),
                error: message
            )
            await controls?.unregister(childSessionID: child.id)
            return Outcome(index: index, title: spec.title, status: .failed, answer: message)
        }
        await orchestrator.release()
        await controls?.unregister(childSessionID: child.id)

        var finalizationError: String?
        if let finalize = environment.finalize {
            do {
                _ = try await finalize()
            } catch {
                // Keep the child result visible even when snapshotting fails;
                // the parent must not be told that the work is safely
                // reviewable when the host could not create that snapshot.
                finalizationError = "The isolated result could not be finalized: \(error)"
            }
        }

        let events = await store.events(for: child.id)
        let recordedAnswer = events.reversed().compactMap { event -> String? in
            if case .assistantMessage(let message) = event.payload {
                return message.text
            }
            return nil
        }.first ?? "The sub-agent completed without a written result."
        let answer = [recordedAnswer, finalizationError]
            .compactMap { $0 }
            .joined(separator: "\n\n")
        // The child's own record decides the outcome, rather than this call
        // assuming success because it returned: a watchdog stop, an iteration
        // cap and a transport failure all end here.
        let childStatus = (try? await store.session(id: child.id).status) ?? .completed
        let childOutcomeStatus = Self.status(of: childStatus)
        let status = finalizationError == nil ? childOutcomeStatus : .failed
        let tokens = await usage.snapshot()
        await publish(
            spec,
            toolCallID: toolCallID,
            parentSessionID: parentSessionID,
            childSessionID: child.id,
            status: status,
            startedAt: startedAt,
            completedAt: Date(),
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            summary: answer,
            error: finalizationError ?? (status == .completed ? nil : lastError(in: events))
        )
        return Outcome(index: index, title: spec.title, status: status, answer: answer)
    }

    // MARK: - Publishing

    private func publish(
        _ spec: Spec,
        toolCallID: String,
        parentSessionID: CodeSessionID,
        childSessionID: CodeSessionID? = nil,
        status: SubagentStatus,
        currentActivity: String = "",
        startedAt: Date? = nil,
        completedAt: Date? = nil,
        inputTokens: Int? = nil,
        outputTokens: Int? = nil,
        summary: String? = nil,
        error: String? = nil
    ) async {
        _ = try? await store.appendEvent(
            sessionID: parentSessionID,
            payload: .subagentUpdated(
                SubagentUpdateEvent(
                    agentID: spec.agentID,
                    toolCallID: toolCallID,
                    childSessionID: childSessionID,
                    title: spec.title,
                    task: spec.task,
                    role: spec.role,
                    executionMode: spec.mode,
                    status: status,
                    currentActivity: currentActivity,
                    startedAt: startedAt,
                    completedAt: completedAt,
                    inputTokens: inputTokens,
                    outputTokens: outputTokens,
                    summary: summary,
                    error: error
                )
            )
        )
    }

    private static func branchName(for spec: Spec) -> String {
        let title = spec.title
            .lowercased()
            .map { character in
                character.isLetter || character.isNumber || character == "-" || character == "_"
                    ? character
                    : "-"
            }
        let slug = String(title).trimmingCharacters(in: CharacterSet(charactersIn: "-_."))
        let digest = Digests.sha256Hex(spec.agentID).prefix(8)
        return "juno/agent/\(String(slug.prefix(48)))\(slug.isEmpty ? "task" : "")-\(digest)"
    }

    /// The child session's terminal status, in the vocabulary both runtimes
    /// share. `.stopping` and `.waitingForApproval` cannot be observed here —
    /// the loop has already returned — but they are mapped rather than defaulted
    /// so a future path that can reach them does not silently read as completed.
    private static func status(of sessionStatus: SessionStatus) -> SubagentStatus {
        switch sessionStatus {
        case .completed: .completed
        case .failed: .failed
        case .cancelled, .stopping: .cancelled
        case .waitingForApproval: .waitingForApproval
        case .idle, .running: .interrupted
        }
    }

    private func lastError(in events: [SessionEvent]) -> String? {
        events.reversed().compactMap { event -> String? in
            if case let .errorOccurred(error) = event.payload { return error.message }
            return nil
        }.first
    }
}

/// The provider's own token counts for one sub-agent's turns.
///
/// An actor rather than a captured variable because `observeUsage` hands its
/// reports to a `@Sendable` closure that can be called from the orchestrator's
/// executor while this call is suspended awaiting completion.
private actor UsageTally {
    private var input: Int?
    private var output: Int?

    func record(input: Int?, output: Int?) {
        if let input { self.input = input }
        if let output { self.output = output }
    }

    func snapshot() -> (input: Int?, output: Int?) { (input, output) }
}
