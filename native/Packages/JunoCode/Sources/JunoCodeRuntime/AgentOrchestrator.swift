import Foundation
import JunoCodeCore

public enum OrchestratorError: Error, Equatable, Sendable {
    case sessionAlreadyRunning
    case sessionTerminated
    case iterationLimitReached(limit: Int)
}

/// The per-session agent loop: sends model turns, executes gated tool calls,
/// records every step as transcript events, and supports stop, error
/// recovery, and resume with the persisted conversation.
public actor AgentOrchestrator {
    public struct Configuration: Sendable {
        public var maximumIterations: Int
        public var maximumToolResultBytes: Int
        public var systemPrompt: String

        public init(
            maximumIterations: Int = 40,
            maximumToolResultBytes: Int = 64 * 1_024,
            systemPrompt: String
        ) {
            self.maximumIterations = maximumIterations
            self.maximumToolResultBytes = maximumToolResultBytes
            self.systemPrompt = systemPrompt
        }
    }

    private let sessionID: CodeSessionID
    private let model: any AgentModelClient
    private let registry: ToolRegistry
    private let permissions: PermissionCoordinator
    private let store: CodeSessionStore
    private let configuration: Configuration
    private let modelID: String
    private let reasoningEffort: ReasoningEffort

    private var conversation: [ModelMessage] = []
    private var runTask: Task<Void, Never>?
    private var approvalObserverToken: UUID?
    private var restored = false

    public init(
        sessionID: CodeSessionID,
        model: any AgentModelClient,
        registry: ToolRegistry,
        permissions: PermissionCoordinator,
        store: CodeSessionStore,
        configuration: Configuration,
        modelID: String,
        reasoningEffort: ReasoningEffort
    ) {
        self.sessionID = sessionID
        self.model = model
        self.registry = registry
        self.permissions = permissions
        self.store = store
        self.configuration = configuration
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
    }

    public var isRunning: Bool { runTask != nil }

    // MARK: - Entry points

    /// Starts one agent run for a user prompt. Throws when a run is already
    /// in flight.
    public func submit(prompt: String) async throws {
        guard runTask == nil else {
            throw OrchestratorError.sessionAlreadyRunning
        }
        try await prepare()
        conversation.append(.user(prompt))
        try await store.appendEvent(
            sessionID: sessionID,
            payload: .userPrompt(UserPromptEvent(text: prompt))
        )
        try await store.setStatus(id: sessionID, status: .running)
        let task = Task { [weak self] in
            guard let self else { return }
            await self.runLoop()
        }
        runTask = task
    }

    /// Requests an immediate stop: cancels the loop and denies every pending
    /// approval so suspended tools resume with a denial and exit.
    public func stop() async {
        guard let task = runTask else { return }
        try? await store.setStatus(id: sessionID, status: .stopping)
        task.cancel()
        await permissions.denyAll()
        await task.value
    }

    /// Waits for the current run to finish (test and shutdown support).
    public func awaitCompletion() async {
        await runTask?.value
    }

    // MARK: - Preparation

    private func prepare() async throws {
        if !restored {
            restored = true
            conversation = await store.loadConversation(sessionID: sessionID)
        }
        if approvalObserverToken == nil {
            let store = self.store
            let sessionID = self.sessionID
            approvalObserverToken = await permissions.addObserver { update in
                Task {
                    switch update {
                    case let .requested(request):
                        _ = try? await store.appendEvent(
                            sessionID: sessionID,
                            payload: .approvalRequested(request)
                        )
                        _ = try? await store.updateSession(id: sessionID) { session in
                            session.hasPendingApproval = true
                            session.status = .waitingForApproval
                        }
                    case let .resolved(id, decision):
                        _ = try? await store.appendEvent(
                            sessionID: sessionID,
                            payload: .approvalResolved(
                                ApprovalResolvedEvent(approvalID: id, decision: decision)
                            )
                        )
                        _ = try? await store.updateSession(id: sessionID) { session in
                            session.hasPendingApproval = false
                            if session.status == .waitingForApproval {
                                session.status = .running
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - The loop

    private func runLoop() async {
        let startedAt = Date()
        var filesChanged = Set<String>()
        var lastAssistantText = ""
        var testsPassed: Bool?
        var modelRetriesLeft = 1

        defer {
            runTask = nil
        }

        var iteration = 0
        while true {
            iteration += 1
            if iteration > configuration.maximumIterations {
                await finish(
                    status: .failed,
                    summary: "Stopped after \(configuration.maximumIterations) iterations.",
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }
            if Task.isCancelled {
                await finish(
                    status: .cancelled,
                    summary: "Stopped by the user.",
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }

            let request = ModelTurnRequest(
                sessionID: sessionID,
                systemPrompt: configuration.systemPrompt,
                messages: conversation,
                tools: registry.allTools.map {
                    ModelToolDescriptor(
                        name: $0.name,
                        description: $0.description,
                        inputSchema: $0.inputSchema
                    )
                },
                modelID: modelID,
                reasoningEffort: reasoningEffort
            )

            var turnText = ""
            var toolCalls: [(id: String, name: String, input: JSONValue)] = []
            var stopReason: ModelStopReason?

            do {
                for try await event in model.streamTurn(request) {
                    if Task.isCancelled { break }
                    switch event {
                    case let .textDelta(delta):
                        turnText += delta
                    case let .reasoningSummary(summary):
                        _ = try? await store.appendEvent(
                            sessionID: sessionID,
                            payload: .reasoningSummary(ReasoningSummaryEvent(summary: summary))
                        )
                    case let .toolCallRequested(id, name, input):
                        toolCalls.append((id, name, input))
                    case let .turnCompleted(reason):
                        stopReason = reason
                    }
                }
            } catch {
                if Task.isCancelled {
                    continue
                }
                if modelRetriesLeft > 0 {
                    modelRetriesLeft -= 1
                    _ = try? await store.appendEvent(
                        sessionID: sessionID,
                        payload: .errorOccurred(
                            ErrorEvent(
                                message: "Model turn failed, retrying: \(shortDescription(error))",
                                isRecoverable: true
                            )
                        )
                    )
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    continue
                }
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .errorOccurred(
                        ErrorEvent(
                            message: "Model turn failed: \(shortDescription(error))",
                            isRecoverable: false
                        )
                    )
                )
                await finish(
                    status: .failed,
                    summary: "The model transport failed.",
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }

            // A cancelled consumer ends the stream without an error; route
            // through the top-of-loop cancellation branch instead of
            // mistaking it for a completed turn.
            if Task.isCancelled { continue }

            if !turnText.isEmpty {
                lastAssistantText = turnText
                conversation.append(.assistant(turnText))
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .assistantMessage(AssistantMessageEvent(text: turnText))
                )
            }

            guard stopReason == .toolUse, !toolCalls.isEmpty else {
                try? await store.saveConversation(sessionID: sessionID, messages: conversation)
                await finish(
                    status: .completed,
                    summary: lastAssistantText.isEmpty ? "Run completed." : lastAssistantText,
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }

            for call in toolCalls {
                if Task.isCancelled { break }
                conversation.append(.toolCall(id: call.id, name: call.name, input: call.input))
                let execution = await executeToolCall(call)
                for sideEffect in execution.sideEffects {
                    if case let .fileChanged(change) = sideEffect {
                        filesChanged.insert(change.path.value)
                    }
                    if case let .testRunCompleted(run) = sideEffect {
                        testsPassed = run.passed
                    }
                }
                let bounded = OutputLimiter.apply(
                    OutputLimit(maximumBytes: configuration.maximumToolResultBytes),
                    to: execution.content
                )
                conversation.append(
                    .toolResult(id: call.id, content: bounded.text, isError: execution.isError)
                )
            }
            try? await store.saveConversation(sessionID: sessionID, messages: conversation)
        }
    }

    private struct ToolExecutionRecord {
        let content: String
        let isError: Bool
        let sideEffects: [SessionEventPayload]
    }

    private func executeToolCall(
        _ call: (id: String, name: String, input: JSONValue)
    ) async -> ToolExecutionRecord {
        let tool = registry.tool(named: call.name)
        let risk = tool?.assessRisk(input: call.input) ?? .critical
        let summary = tool?.summary(input: call.input) ?? call.name
        _ = try? await store.appendEvent(
            sessionID: sessionID,
            payload: .toolProposed(
                ToolProposedEvent(
                    toolCallID: call.id,
                    toolName: call.name,
                    input: call.input,
                    risk: risk,
                    summary: summary
                )
            )
        )
        let startedAt = Date()

        do {
            try await registry.authorizeInvocation(
                toolName: call.name,
                input: call.input,
                permissions: permissions
            )
        } catch {
            let reason = deniedReason(from: error)
            _ = try? await store.appendEvent(
                sessionID: sessionID,
                payload: .toolCompleted(
                    ToolCompletedEvent(
                        toolCallID: call.id,
                        status: .denied,
                        resultSummary: reason,
                        durationSeconds: Date().timeIntervalSince(startedAt)
                    )
                )
            )
            return ToolExecutionRecord(
                content: "Action not permitted: \(reason)",
                isError: true,
                sideEffects: []
            )
        }

        _ = try? await store.appendEvent(
            sessionID: sessionID,
            payload: .toolStarted(ToolStartedEvent(toolCallID: call.id))
        )

        let store = self.store
        let sessionID = self.sessionID
        let callID = call.id
        let context = ToolContext(
            sessionID: sessionID,
            toolCallID: callID,
            emitOutput: { channel, text in
                let limited = OutputLimiter.apply(.streamChunk, to: text)
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .toolOutput(
                        ToolOutputEvent(toolCallID: callID, channel: channel, text: limited.text)
                    )
                )
            }
        )

        do {
            let result = try await registry.executeAuthorized(
                toolName: call.name,
                input: call.input,
                context: context
            )
            for sideEffect in result.sideEffects {
                _ = try? await store.appendEvent(sessionID: sessionID, payload: sideEffect)
            }
            _ = try? await store.appendEvent(
                sessionID: sessionID,
                payload: .toolCompleted(
                    ToolCompletedEvent(
                        toolCallID: call.id,
                        status: result.isError ? .failed : .succeeded,
                        resultSummary: firstLine(of: result.content),
                        durationSeconds: Date().timeIntervalSince(startedAt)
                    )
                )
            )
            return ToolExecutionRecord(
                content: result.content,
                isError: result.isError,
                sideEffects: result.sideEffects
            )
        } catch is CancellationError {
            _ = try? await store.appendEvent(
                sessionID: sessionID,
                payload: .toolCompleted(
                    ToolCompletedEvent(
                        toolCallID: call.id,
                        status: .cancelled,
                        resultSummary: "Cancelled",
                        durationSeconds: Date().timeIntervalSince(startedAt)
                    )
                )
            )
            return ToolExecutionRecord(content: "Cancelled.", isError: true, sideEffects: [])
        } catch {
            let message = shortDescription(error)
            _ = try? await store.appendEvent(
                sessionID: sessionID,
                payload: .toolCompleted(
                    ToolCompletedEvent(
                        toolCallID: call.id,
                        status: .failed,
                        resultSummary: message,
                        durationSeconds: Date().timeIntervalSince(startedAt)
                    )
                )
            )
            return ToolExecutionRecord(
                content: "Tool failed: \(message)",
                isError: true,
                sideEffects: []
            )
        }
    }

    private func finish(
        status: SessionStatus,
        summary: String,
        filesChanged: Int,
        testsPassed: Bool?,
        startedAt: Date
    ) async {
        _ = try? await store.appendEvent(
            sessionID: sessionID,
            payload: .runCompleted(
                RunCompletedEvent(
                    summary: firstLine(of: summary, maximumCharacters: 500),
                    filesChanged: filesChanged,
                    testsPassed: testsPassed,
                    durationSeconds: Date().timeIntervalSince(startedAt)
                )
            )
        )
        try? await store.setStatus(id: sessionID, status: status)
        try? await store.saveConversation(sessionID: sessionID, messages: conversation)
    }

    private func deniedReason(from error: Error) -> String {
        if case let ToolError.denied(reason) = error {
            return reason
        }
        if case let ToolError.invalidInput(message) = error {
            return message
        }
        return shortDescription(error)
    }

    private func shortDescription(_ error: Error) -> String {
        let text = String(describing: error)
        return text.count > 300 ? String(text.prefix(300)) + "…" : text
    }

    private func firstLine(of text: String, maximumCharacters: Int = 200) -> String {
        let line = text.components(separatedBy: "\n").first ?? text
        return line.count > maximumCharacters
            ? String(line.prefix(maximumCharacters)) + "…"
            : line
    }
}
