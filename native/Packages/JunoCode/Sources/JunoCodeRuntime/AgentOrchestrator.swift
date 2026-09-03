import Foundation
import JunoCodeCore

/// Resolves a fallback model when the primary model is unavailable.
///
/// The production implementation queries the real model catalog for an
/// available alternative with tool-calling support. This replaces the
/// previous hardcoded map (Gemini→Claude, Claude→OpenAI, OpenAI→Qwen)
/// which fails when the target model does not exist or is not available.
public protocol ModelFallbackResolver: Sendable {
    /// Returns an available model ID to use as fallback for `currentModelID`,
    /// or nil when no suitable alternative exists.
    func resolveFallback(for currentModelID: String) async -> String?
}

public enum OrchestratorError: Error, Equatable, Sendable {
    case sessionAlreadyRunning
    case sessionNotRunning
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
        /// The provider's advertised context window. When usage reaches the
        /// trigger fraction, older turns are compacted before the next request.
        /// Nil keeps the byte guard as the fallback for incomplete manifests.
        public var contextWindowTokens: Int?
        public var contextCompactionTriggerFraction: Double
        /// A provider-independent safety net for models that do not report
        /// usage, or whose manifest has no context-window metadata.
        public var maximumConversationBytes: Int
        public var systemPrompt: String

        public init(
            maximumIterations: Int = 40,
            maximumToolResultBytes: Int = 512 * 1_024,
            maximumToolImageBytes: Int = 8 * 1_024 * 1_024,
            maximumToolImages: Int = 4,
            contextWindowTokens: Int? = nil,
            contextCompactionTriggerFraction: Double = 0.80,
            maximumConversationBytes: Int = 4 * 1_024 * 1_024,
            systemPrompt: String
        ) {
            self.maximumIterations = maximumIterations
            self.maximumToolResultBytes = maximumToolResultBytes
            self.maximumToolImageBytes = maximumToolImageBytes
            self.maximumToolImages = maximumToolImages
            self.contextWindowTokens = contextWindowTokens
            self.contextCompactionTriggerFraction = min(
                max(contextCompactionTriggerFraction, 0.50),
                0.95
            )
            self.maximumConversationBytes = max(maximumConversationBytes, 16_384)
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
    private var activeModelID: String
    private let reasoningEffort: ReasoningEffort?
    private let lifecycleHooks: (any AgentLifecycleHooks)?
    private let fallbackResolver: (any ModelFallbackResolver)?
    private let verificationEngine: VerificationEngine

    private var conversation: [ModelMessage] = []
    private var runTask: Task<Void, Never>?
    private struct PendingInstruction: Sendable {
        let event: UserInstructionEvent
        let modelPrompt: String
        let images: [ModelImage]
    }
    /// Instructions accepted while a run is active. The transcript persists
    /// acceptance and application separately; this in-memory queue is rebuilt
    /// from those events when a runtime is recreated after interruption.
    private var pendingInstructions: [PendingInstruction] = []
    private let toolScheduler = ToolScheduler()
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
        reasoningEffort: ReasoningEffort?,
        lifecycleHooks: (any AgentLifecycleHooks)? = nil,
        fallbackResolver: (any ModelFallbackResolver)? = nil
    ) {
        self.sessionID = sessionID
        self.model = model
        self.registry = registry
        self.permissions = permissions
        self.store = store
        self.configuration = configuration
        self.modelID = modelID
        self.activeModelID = modelID
        self.reasoningEffort = reasoningEffort
        self.lifecycleHooks = lifecycleHooks
        self.fallbackResolver = fallbackResolver
        self.verificationEngine = VerificationEngine(store: store)
    }

    private func computeFallbackModel(for current: String) async -> String? {
        await fallbackResolver?.resolveFallback(for: current)
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

    /// Amends the active execution at the next safe boundary. If a model turn
    /// has proposed tools but none have started, the proposal is discarded and
    /// the correction is sent to the model before any side effect can begin.
    @discardableResult
    public func steer(
        prompt: String,
        modelPrompt: String? = nil,
        images: [ModelImage] = []
    ) async throws -> String {
        try await acceptInstruction(
            prompt: prompt,
            modelPrompt: modelPrompt,
            images: images,
            kind: .steer
        )
    }

    /// Adds a follow-up that starts only after the active execution reaches a
    /// natural completion boundary.
    @discardableResult
    public func queue(
        prompt: String,
        modelPrompt: String? = nil,
        images: [ModelImage] = []
    ) async throws -> String {
        try await acceptInstruction(
            prompt: prompt,
            modelPrompt: modelPrompt,
            images: images,
            kind: .queue
        )
    }

    private func acceptInstruction(
        prompt: String,
        modelPrompt: String?,
        images: [ModelImage],
        kind: UserInstructionKind
    ) async throws -> String {
        guard runTask != nil else { throw OrchestratorError.sessionNotRunning }
        let visible = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !visible.isEmpty || !images.isEmpty else { return "" }
        try await prepare()
        let event = UserInstructionEvent(text: prompt, kind: kind)
        _ = try await store.appendEvent(
            sessionID: sessionID,
            payload: .userInstruction(event)
        )
        pendingInstructions.append(
            PendingInstruction(
                event: event,
                modelPrompt: modelPrompt ?? prompt,
                images: images
            )
        )
        return event.id
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
            let events = await store.events(for: sessionID)
            let applied = Set(events.compactMap { event -> String? in
                guard case let .userInstructionApplied(value) = event.payload else {
                    return nil
                }
                return value.instructionID
            })
            pendingInstructions = events.compactMap { event in
                guard case let .userInstruction(value) = event.payload,
                      !applied.contains(value.id)
                else { return nil }
                return PendingInstruction(
                    event: value,
                    modelPrompt: value.text,
                    images: []
                )
            }
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

        await lifecycleHooks?.sessionStarted(sessionID: sessionID)

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

            // A correction accepted before the first provider request belongs
            // in that request. Queued work still waits for a natural end-turn.
            _ = await applyPendingInstructions(includeQueued: false)

            await compactConversationIfNeeded()

            var turnText = ""
            var turnReasoningSummary = ""
            var toolCalls: [(id: String, name: String, input: JSONValue, extraContent: JSONValue?)] = []
            var stopReason: ModelStopReason?
            lastLiveTextEmit = .distantPast
            emitLiveText("", force: true)

            var modelRetriesLeft = 1
            var fallbackAttempted = false

            while true {
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
                    modelID: activeModelID,
                    reasoningEffort: reasoningEffort
                )
                turnText = ""
                turnReasoningSummary = ""
                toolCalls.removeAll()
                stopReason = nil

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
                            if turnText.isEmpty {
                                emitLiveText(turnReasoningSummary)
                            }
                        case let .toolCallRequested(id, name, input):
                            toolCalls.append((id, name, input, nil))
                        case let .toolCallRequestedWithExtra(id, name, input, extra):
                            toolCalls.append((id, name, input, extra))
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
                    break
                } catch {
                    if Task.isCancelled {
                        break
                    }
                    let errorDesc = shortDescription(error)

                    // Typed error classification — prefer structured errors over string matching.
                    let isOverload: Bool
                    let isQuotaExhausted: Bool
                    if let clientError = error as? AgentModelClientError {
                        switch clientError {
                        case .rateLimited:
                            isOverload = true
                            isQuotaExhausted = false
                        case .quotaExhausted:
                            isOverload = true
                            isQuotaExhausted = true
                        case let .transport(message):
                            let m = message.lowercased()
                            isQuotaExhausted = m.contains("quota") || m.contains("exceeded your current quota")
                            isOverload = isQuotaExhausted
                                || m.contains("503")
                                || m.contains("504")
                                || m.contains("overloaded")
                                || m.contains("high demand")
                                || m.contains("timed out")
                                || m.contains("timeout")
                                || m.contains("rate limit")
                        case .unauthorized, .invalidResponse:
                            isOverload = false
                            isQuotaExhausted = false
                        }
                    } else {
                        let m = errorDesc.lowercased()
                        isQuotaExhausted = m.contains("quota") || m.contains("exceeded your current quota")
                        isOverload = isQuotaExhausted
                            || m.contains("503")
                            || m.contains("504")
                            || m.contains("overloaded")
                            || m.contains("high demand")
                            || m.contains("timed out")
                            || m.contains("timeout")
                            || m.contains("rate limit")
                    }

                    if isOverload && !fallbackAttempted {
                        if let fallback = await computeFallbackModel(for: activeModelID),
                           fallback != activeModelID
                        {
                            fallbackAttempted = true
                            modelRetriesLeft = 1
                            let reason = isQuotaExhausted ? "quota is exhausted" : "is temporarily unavailable"
                            _ = try? await store.appendEvent(
                                sessionID: sessionID,
                                payload: .errorOccurred(
                                    ErrorEvent(
                                        message: "Model '\(activeModelID)' \(reason). Switching to '\(fallback)' to continue.",
                                        isRecoverable: true
                                    )
                                )
                            )
                            activeModelID = fallback
                            try? await Task.sleep(nanoseconds: 500_000_000)
                            continue
                        }
                    }

                    // On quota exhaustion without fallback, do not do a pointless retry on the exact same model!
                    if isQuotaExhausted {
                        modelRetriesLeft = 0
                    }

                    if modelRetriesLeft > 0 {
                        modelRetriesLeft -= 1
                        _ = try? await store.appendEvent(
                            sessionID: sessionID,
                            payload: .errorOccurred(
                                ErrorEvent(
                                    message: "Model turn failed, retrying: \(errorDesc)",
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
            }

            // A cancelled consumer ends the stream without an error; route
            // through the top-of-loop cancellation branch instead of
            // mistaking it for a completed turn.
            if Task.isCancelled { continue }
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

            if stopReason == .toolUse {
                for call in toolCalls {
                    let tool = registry.tool(named: call.name)
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
                }
            }

            // This is the last boundary before a model-proposed mutation may
            // begin. Steering wins over stale tool calls: keep the readable
            // assistant narrative, discard the unexecuted proposal, and ask
            // the model to revise its plan with the correction in context.
            if stopReason == .toolUse,
               await applyPendingInstructions(includeQueued: false)
            {
                continue
            }

            guard stopReason == .toolUse else {
                // End-turn is the execution boundary queued follow-ups wait
                // for. Applying them continues the same durable session and
                // produces one final completion record after the queue drains.
                if await applyPendingInstructions(includeQueued: true) {
                    continue
                }
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
                if let extra = call.extraContent {
                    conversation.append(.toolCallWithExtra(id: call.id, name: call.name, input: call.input, extraContent: extra))
                } else {
                    conversation.append(.toolCall(id: call.id, name: call.name, input: call.input))
                }
            }

            let scheduledCalls = toolCalls
            var terminalGoalLifecycle: GoalLifecycle?
            var steeringInterruptedTools = false

            let executionResults = await toolScheduler.execute(
                calls: scheduledCalls,
                shouldInterrupt: { [weak self, store, sessionID] in
                    guard let self else { return true }
                    if let lifecycle = try? await store.session(id: sessionID).goal?.lifecycle,
                       lifecycle != .active {
                        return true
                    }
                    return await self.applyPendingInstructions(includeQueued: false)
                },
                executor: { [registry, permissions, lifecycleHooks, store, sessionID, configuration] (id, name, input) in
                    await ToolScheduler.executeCall(
                        id: id,
                        name: name,
                        input: input,
                        sessionID: sessionID,
                        registry: registry,
                        permissions: permissions,
                        lifecycleHooks: lifecycleHooks,
                        store: store,
                        maximumToolImages: configuration.maximumToolImages,
                        maximumToolImageBytes: configuration.maximumToolImageBytes
                    )
                }
            )

            for execution in executionResults {
                for sideEffect in execution.sideEffects {
                    if case let .fileChanged(change) = sideEffect {
                        filesChanged.insert(change.path.value)
                    }
                    if case let .testRunCompleted(run) = sideEffect {
                        testsPassed = run.passed
                        // Verification evidence is minted only from the
                        // successful runtime event itself. The model-facing
                        // goal tool cannot self-attest completion.
                        await verificationEngine.recordTestVerification(
                            sessionID: sessionID,
                            run: run
                        )
                    }
                }
                let bounded = OutputLimiter.apply(
                    OutputLimit(maximumBytes: configuration.maximumToolResultBytes),
                    to: execution.content
                )
                if execution.images.isEmpty {
                    conversation.append(
                        .toolResult(id: execution.callID, content: bounded.text, isError: execution.isError)
                    )
                } else {
                    conversation.append(
                        .toolResultWithImages(
                            id: execution.callID,
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

            if executionResults.count < scheduledCalls.count {
                steeringInterruptedTools = true
            }
            if steeringInterruptedTools { continue }
        }
    }

    /// Moves accepted instructions into model context in their durable event
    /// order. Returning true tells the run loop to request another model turn.
    private func applyPendingInstructions(includeQueued: Bool) async -> Bool {
        let selected = pendingInstructions.filter {
            includeQueued || $0.event.kind == .steer
        }
        guard !selected.isEmpty else { return false }
        let selectedIDs = Set(selected.map(\.event.id))
        pendingInstructions.removeAll { selectedIDs.contains($0.event.id) }

        for instruction in selected {
            let text = instruction.modelPrompt
            if instruction.images.isEmpty {
                conversation.append(.user(text))
            } else {
                conversation.append(.userWithImages(text, instruction.images))
            }
        }
        try? await store.saveConversation(sessionID: sessionID, messages: conversation)
        for instruction in selected {
            _ = try? await store.appendEvent(
                sessionID: sessionID,
                payload: .userInstructionApplied(
                    UserInstructionAppliedEvent(instructionID: instruction.event.id)
                )
            )
        }
        return true
    }

    /// Compacts before a provider request, never in the middle of a tool turn.
    /// This keeps the model-facing history valid while ensuring a resumed app
    /// sees the same bounded memory because the compacted messages are persisted.
    private func compactConversationIfNeeded() async {
        let tokenTrigger: Bool
        if let window = configuration.contextWindowTokens,
           window > 0,
           let contextTokens
        {
            tokenTrigger = Double(contextTokens)
                >= Double(window) * configuration.contextCompactionTriggerFraction
        } else {
            tokenTrigger = false
        }

        let contextSizedMaximum: Int?
        if let window = configuration.contextWindowTokens, window > 0 {
            // JSON is intentionally used only as a conservative local proxy:
            // provider tokenizers differ. Four bytes per token keeps a 128K
            // model's request near its 80% trigger while the explicit byte cap
            // still bounds models with very large windows.
            let estimated = Double(window)
                * configuration.contextCompactionTriggerFraction * 4
            contextSizedMaximum = Int(min(
                Double(configuration.maximumConversationBytes),
                max(16_384, estimated)
            ))
        } else {
            contextSizedMaximum = nil
        }
        let result = ConversationCompactor.compact(
            conversation,
            maximumBytes: contextSizedMaximum ?? configuration.maximumConversationBytes,
            force: tokenTrigger
        )
        guard let result else { return }
        await adopt(result, requestedByUser: false)
    }

    /// Folds the conversation down now, at the reader's request.
    ///
    /// The runtime already compacts on its own ahead of a provider limit; this
    /// is the `/compact` the reader types when they know the early turns are
    /// no longer worth carrying. Refused mid-run — the conversation is being
    /// appended to by the loop that owns it — and answered with nil when there
    /// is nothing safe to fold (a single turn has no "older" half).
    public func compactNow() async -> CompactionEvent? {
        guard runTask == nil else { return nil }
        if !restored {
            try? await prepare()
        }
        guard let result = ConversationCompactor.compact(
            conversation,
            maximumBytes: configuration.maximumConversationBytes,
            force: true
        ) else { return nil }
        return await adopt(result, requestedByUser: true)
    }

    /// Installs a compaction result and records it in the transcript.
    @discardableResult
    private func adopt(
        _ result: ConversationCompactionResult,
        requestedByUser: Bool
    ) async -> CompactionEvent {
        let before = conversation.count
        let event = CompactionEvent(
            summary: result.summary,
            beforeMessageCount: before,
            afterMessageCount: result.messages.count,
            beforeTokens: contextTokens,
            requestedByUser: requestedByUser
        )
        conversation = result.messages
        // The next request will report a new prompt size. Keeping the old
        // number visible would make the UI claim the compacted request is still
        // at the pre-compaction limit.
        contextTokens = nil
        usageObserver?(nil, lastOutputTokens)
        try? await store.saveConversation(sessionID: sessionID, messages: conversation)
        _ = try? await store.appendEvent(sessionID: sessionID, payload: .compaction(event))
        return event
    }

    private func executeToolCall(
        _ call: (id: String, name: String, input: JSONValue)
    ) async -> ToolScheduler.ExecutionResult {
        await ToolScheduler.executeCall(
            id: call.id,
            name: call.name,
            input: call.input,
            sessionID: sessionID,
            registry: registry,
            permissions: permissions,
            lifecycleHooks: lifecycleHooks,
            store: store,
            maximumToolImages: configuration.maximumToolImages,
            maximumToolImageBytes: configuration.maximumToolImageBytes
        )
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
        await lifecycleHooks?.sessionStopped(sessionID: sessionID, status: status)
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
