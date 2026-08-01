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
        public var maximumToolImageBytes: Int
        public var maximumToolImages: Int
        public var systemPrompt: String

        public init(
            maximumIterations: Int = 40,
            maximumToolResultBytes: Int = 512 * 1_024,
            maximumToolImageBytes: Int = 8 * 1_024 * 1_024,
            maximumToolImages: Int = 4,
            systemPrompt: String
        ) {
            self.maximumIterations = maximumIterations
            self.maximumToolResultBytes = maximumToolResultBytes
            self.maximumToolImageBytes = maximumToolImageBytes
            self.maximumToolImages = maximumToolImages
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
    private let reasoningEffort: ReasoningEffort?

    private var conversation: [ModelMessage] = []
    private var runTask: Task<Void, Never>?
    private var approvalObserverToken: UUID?
    private var restored = false
    private var liveTextObserver: (@Sendable (String) -> Void)?
    private var lastLiveTextEmit = Date.distantPast
    /// The size of the prompt the provider last billed — system prompt, tool
    /// schemas and the whole conversation — which is what a context meter shows.
    private var contextTokens: Int?
    private var lastOutputTokens: Int?
    private var usageObserver: (@Sendable (Int?, Int?) -> Void)?

    public init(
        sessionID: CodeSessionID,
        model: any AgentModelClient,
        registry: ToolRegistry,
        permissions: PermissionCoordinator,
        store: CodeSessionStore,
        configuration: Configuration,
        modelID: String,
        reasoningEffort: ReasoningEffort?
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

    /// Observes the assistant text as it accumulates within the current turn.
    ///
    /// Deliberately not persisted: `assistantMessage` is the record of what the
    /// agent said, and writing a transcript line per token would make the
    /// append-only store the bottleneck for every reply. The observer is handed
    /// the whole accumulated turn text rather than each delta, so a subscriber
    /// that attaches mid-turn is never left holding a fragment, and an empty
    /// string at the start of every turn so the previous turn's text is dropped
    /// instead of concatenated.
    public func observeLiveText(_ observer: (@Sendable (String) -> Void)?) {
        liveTextObserver = observer
    }

    /// Observes token accounting as the provider reports it: the prompt size that
    /// is the session's current context, and the last turn's completion size.
    ///
    /// Not persisted, for the same reason live text is not: it is a property of the
    /// turn in flight, and the store is not the place to keep a number that changes
    /// on every request.
    public func observeUsage(_ observer: (@Sendable (Int?, Int?) -> Void)?) {
        usageObserver = observer
        if usageObserver != nil, contextTokens != nil {
            observer?(contextTokens, lastOutputTokens)
        }
    }

    /// Releases the observer this orchestrator holds on the shared permission
    /// coordinator.
    ///
    /// A session whose turn contract changes — a different mode, model or
    /// reasoning effort — is served by a new orchestrator, because the tool
    /// registry, system prompt and model are fixed at construction. The
    /// abandoned instance would otherwise keep observing approvals and write a
    /// second `approvalRequested` event for every one of them.
    public func release() async {
        if let token = approvalObserverToken {
            await permissions.removeObserver(token)
            approvalObserverToken = nil
        }
        liveTextObserver = nil
        usageObserver = nil
    }

    /// Publishes the turn's text so far, at most twenty times a second.
    ///
    /// A model streams tokens far faster than a reader reads or a display
    /// refreshes, and every notification costs a hop to whichever actor the
    /// observer belongs to. Throttling here rather than in the observer keeps
    /// that cost off every subscriber.
    private func emitLiveText(_ text: String, force: Bool = false) {
        guard let liveTextObserver else { return }
        let now = Date()
        guard force || now.timeIntervalSince(lastLiveTextEmit) >= 0.05 else { return }
        lastLiveTextEmit = now
        liveTextObserver(text)
    }

    // MARK: - Entry points

    /// Starts one agent run for a user prompt. Throws when a run is already
    /// in flight.
    public func submit(
        prompt: String,
        modelPrompt: String? = nil,
        images: [ModelImage] = []
    ) async throws {
        guard runTask == nil else {
            throw OrchestratorError.sessionAlreadyRunning
        }
        try await prepare()
        // The transcript stays faithful to what the reader typed while callers
        // may enrich the model-only turn with explicitly selected, bounded
        // workspace context. Keeping those two representations separate avoids
        // dumping source files into the visible conversation.
        let turnText = modelPrompt ?? prompt
        conversation.append(images.isEmpty ? .user(turnText) : .userWithImages(turnText, images))
        try await store.appendEvent(
            sessionID: sessionID,
            payload: .userPrompt(UserPromptEvent(text: prompt))
        )
        // Persist the model history before the asynchronous run begins. If the
        // process exits while the transport is connecting, the transcript and
        // resumable context still agree that this prompt was submitted.
        try await store.saveConversation(sessionID: sessionID, messages: conversation)
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
            // Bound as a local for the same reason `store` and `sessionID` are: the
            // observer must not capture the actor.
            let permissions = self.permissions
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
                        // Only clear the waiting state once nothing is still waiting.
                        //
                        // Several tool calls in one turn can each be gated, and this
                        // used to clear `hasPendingApproval` and flip the status back
                        // to `.running` on the *first* resolution. The remaining
                        // requests were still suspended and their cards still drawn,
                        // but the session claimed to be running and the sidebar's
                        // "waiting for approval" marker went out — so a run that was
                        // blocked on the reader looked like a run that was working.
                        let stillPending = await permissions.pendingApprovals.isEmpty == false
                        _ = try? await store.updateSession(id: sessionID) { session in
                            session.hasPendingApproval = stillPending
                            if !stillPending, session.status == .waitingForApproval {
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
            var turnReasoningSummary = ""
            var toolCalls: [(id: String, name: String, input: JSONValue)] = []
            var stopReason: ModelStopReason?
            lastLiveTextEmit = .distantPast
            emitLiveText("", force: true)

            do {
                for try await event in model.streamTurn(request) {
                    if Task.isCancelled { break }
                    switch event {
                    case let .textDelta(delta):
                        turnText += delta
                        emitLiveText(turnText)
                    case let .reasoningSummary(summary):
                        // Providers stream reasoning summaries as token-sized
                        // deltas. Keep those private to the active turn and
                        // persist one bounded, readable summary instead of one
                        // transcript event per delta.
                        turnReasoningSummary += summary
                    case let .toolCallRequested(id, name, input):
                        toolCalls.append((id, name, input))
                    case let .usage(inputTokens, outputTokens):
                        // Replaced, not accumulated: `inputTokens` is the whole
                        // billed prompt for this turn, so the newest report *is*
                        // the current context size. Summing them would count the
                        // conversation once per turn and race past the window.
                        if let inputTokens {
                            contextTokens = inputTokens
                        }
                        if let outputTokens {
                            lastOutputTokens = outputTokens
                        }
                        usageObserver?(contextTokens, lastOutputTokens)
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
            modelRetriesLeft = 1
            // Images are intentionally one-turn context. Once a successful
            // model turn has consumed them, retain only the redacted tool
            // result so subsequent turns do not resend screenshots.
            conversation = conversation.map(\.persistenceSafe)

            let normalizedReasoning = turnReasoningSummary.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            if !normalizedReasoning.isEmpty {
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .reasoningSummary(
                        ReasoningSummaryEvent(summary: normalizedReasoning)
                    )
                )
            }

            if !turnText.isEmpty {
                lastAssistantText = turnText
                conversation.append(.assistant(turnText))
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .assistantMessage(AssistantMessageEvent(text: turnText))
                )
            }

            if stopReason == .maxTokens {
                try? await store.saveConversation(sessionID: sessionID, messages: conversation)
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .errorOccurred(
                        ErrorEvent(
                            message: "The model reached its output limit before finishing.",
                            isRecoverable: true
                        )
                    )
                )
                await finish(
                    status: .failed,
                    summary: "The model reached its output limit before finishing. Continue to resume.",
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }

            guard let stopReason else {
                try? await store.saveConversation(sessionID: sessionID, messages: conversation)
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .errorOccurred(
                        ErrorEvent(
                            message: "The model stream ended without a completion reason.",
                            isRecoverable: true
                        )
                    )
                )
                await finish(
                    status: .failed,
                    summary: "The model stream ended unexpectedly. Continue to retry.",
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }

            if stopReason == .toolUse, toolCalls.isEmpty {
                try? await store.saveConversation(sessionID: sessionID, messages: conversation)
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .errorOccurred(
                        ErrorEvent(
                            message: "The model requested tool execution without a valid tool call.",
                            isRecoverable: true
                        )
                    )
                )
                await finish(
                    status: .failed,
                    summary: "The model returned an incomplete tool request. Continue to retry.",
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }

            guard stopReason == .toolUse else {
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

            var terminalGoalLifecycle: GoalLifecycle?
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
                        if run.passed {
                            let summary: String
                            if let testsRun = run.testsRun {
                                summary =
                                    "\(testsRun) test\(testsRun == 1 ? "" : "s") passed."
                            } else {
                                summary = "Verification command passed."
                            }
                            // Verification evidence is minted only from the
                            // successful runtime event itself. The model-facing
                            // goal tool cannot self-attest completion.
                            _ = try? await store.updateGoal(
                                sessionID: sessionID,
                                mutation: .addVerificationEvidence(
                                    summary: summary,
                                    source: run.command
                                )
                            )
                        }
                    }
                }
                let bounded = OutputLimiter.apply(
                    OutputLimit(maximumBytes: configuration.maximumToolResultBytes),
                    to: execution.content
                )
                if execution.images.isEmpty {
                    conversation.append(
                        .toolResult(id: call.id, content: bounded.text, isError: execution.isError)
                    )
                } else {
                    conversation.append(
                        .toolResultWithImages(
                            id: call.id,
                            content: bounded.text,
                            isError: execution.isError,
                            images: execution.images
                        )
                    )
                }
                if let lifecycle = try? await store.session(id: sessionID).goal?.lifecycle,
                   lifecycle != .active
                {
                    // A model-authored pause, block, or completion is an
                    // execution boundary, not merely metadata. Do not execute
                    // later tool calls from the same model response or begin
                    // another iteration after the goal has stopped.
                    terminalGoalLifecycle = lifecycle
                    break
                }
            }
            try? await store.saveConversation(sessionID: sessionID, messages: conversation)
            if let terminalGoalLifecycle {
                let status: SessionStatus =
                    terminalGoalLifecycle == .completed ? .completed : .cancelled
                let summary: String
                switch terminalGoalLifecycle {
                case .active:
                    summary = "Run completed."
                case .paused:
                    summary = "Goal paused."
                case .blocked:
                    summary = "Goal blocked."
                case .completed:
                    summary = "Goal completed."
                }
                await finish(
                    status: status,
                    summary: summary,
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }
        }
    }

    private struct ToolExecutionRecord {
        let content: String
        let isError: Bool
        let images: [ModelImage]
        let sideEffects: [SessionEventPayload]
    }

    private func executeToolCall(
        _ call: (id: String, name: String, input: JSONValue)
    ) async -> ToolExecutionRecord {
        let tool = registry.tool(named: call.name)
        // A name the registry does not know gets the highest risk, not merely a
        // high one: `critical` is now waived by full access, so defaulting there
        // would let an unrecognised tool call through unreviewed.
        let risk = tool?.assessRisk(input: call.input) ?? .destructive
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
                images: [],
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
            let imageBytes = result.images.reduce(into: 0) { total, image in
                total += image.data.count
            }
            guard result.images.count <= configuration.maximumToolImages,
                  imageBytes <= configuration.maximumToolImageBytes
            else {
                let message = "Tool image output exceeded the safe request limit."
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
                    content: message,
                    isError: true,
                    images: [],
                    sideEffects: []
                )
            }
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
                images: result.images,
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
            return ToolExecutionRecord(
                content: "Cancelled.",
                isError: true,
                images: [],
                sideEffects: []
            )
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
                images: [],
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
        // Image payloads are one-turn capabilities. Redact the reusable
        // in-memory history on every terminal path as well as successful model
        // turns, so a transport failure or cancellation cannot resend a stale
        // screenshot when this orchestrator is reused.
        conversation = conversation.map(\.persistenceSafe)
        emitLiveText("", force: true)
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
