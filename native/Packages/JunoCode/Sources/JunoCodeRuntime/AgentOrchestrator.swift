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

    /// The thinking setting to send `modelID` in place of `preferred`, which
    /// was chosen for another model: nil when it takes no thinking parameter,
    /// and otherwise the nearest depth it offers.
    ///
    /// The primary's effort sent to a fallback from another lab is a 400 for
    /// a model that takes no parameter or does not offer that depth, and the
    /// fallback exists precisely to keep the run going.
    func reasoningEffort(for modelID: String, preferred: ReasoningEffort?) -> ReasoningEffort?
}

public extension ModelFallbackResolver {
    /// With nothing known about the model, no thinking parameter at all:
    /// omitting one costs a shallower answer, while a wrong one fails the
    /// turn.
    func reasoningEffort(for _: String, preferred _: ReasoningEffort?) -> ReasoningEffort? {
        nil
    }
}

public enum OrchestratorError: Error, Equatable, Sendable {
    case sessionAlreadyRunning
    case sessionNotRunning
    case sessionTerminated
    case iterationLimitReached(limit: Int)
    /// A `UserPromptSubmit` hook refused the prompt, which was not sent. The
    /// thread already says which hook and why.
    case promptBlocked(reason: String)
    /// The reader stopped the session while the prompt's hooks were still
    /// deciding on it. Nothing was sent or recorded.
    case stoppedBeforeSending
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
        /// How the session's own model is asked to write compaction summaries,
        /// or nil to write the structural summary alone.
        public var compactionSummary: CompactionSummarizer.Limits?
        /// Fixed for the orchestrator's life, and kept free of anything that
        /// changes during a session: it heads every request's cached prefix.
        public var systemPrompt: String
        /// The session's volatile facts — date, branch, goal, skills — read
        /// before each request and sent as a `<session_state>` block when
        /// they changed. Nil sends none. See ``SessionState``.
        public var sessionState: (@Sendable () async -> [SessionStateSection])?
        /// How many images, and how many bytes of them, the history may carry
        /// before the oldest are rewritten as text ahead of compaction. See
        /// ``ImageRetention``.
        public var maximumRetainedImages: Int
        /// In the images' own bytes, which travel as base64, a third larger.
        /// The default keeps them, with the text the byte guard allows, well
        /// inside the 16 MB body the agent proxy accepts
        /// (`MAX_AGENT_BODY_BYTES` in `src/lib/agent-proxy.ts`): at 12 MB
        /// they alone filled it, and every request past that was a 413 that
        /// only a forced compaction could clear.
        public var maximumRetainedImageBytes: Int
        /// How a failed model request is tried again. See ``ModelRetryPolicy``.
        public var retryPolicy: ModelRetryPolicy
        /// How the loop waits between retries. Must throw when the task is
        /// cancelled, so Stop is never held up by a backoff; tests replace it
        /// to run without waiting.
        public var retrySleep: @Sendable (Duration) async throws -> Void
        /// A number in 0..<1 that spreads out the retries of sessions that
        /// hit the same limit together.
        public var retryJitter: @Sendable () -> Double

        public init(
            maximumIterations: Int = 200,
            maximumToolResultBytes: Int = 128 * 1_024,
            maximumToolImageBytes: Int = 8 * 1_024 * 1_024,
            maximumToolImages: Int = 4,
            contextWindowTokens: Int? = nil,
            contextCompactionTriggerFraction: Double = 0.80,
            maximumConversationBytes: Int = 4 * 1_024 * 1_024,
            compactionSummary: CompactionSummarizer.Limits? = .standard,
            systemPrompt: String,
            sessionState: (@Sendable () async -> [SessionStateSection])? = nil,
            maximumRetainedImages: Int = 20,
            maximumRetainedImageBytes: Int = 6 * 1_024 * 1_024,
            retryPolicy: ModelRetryPolicy = .standard,
            retrySleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
            retryJitter: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }
        ) {
            self.compactionSummary = compactionSummary
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
            self.sessionState = sessionState
            self.maximumRetainedImages = max(1, maximumRetainedImages)
            self.maximumRetainedImageBytes = max(1, maximumRetainedImageBytes)
            self.retryPolicy = retryPolicy
            self.retrySleep = retrySleep
            self.retryJitter = retryJitter
        }
    }

    private let sessionID: CodeSessionID
    private let model: any AgentModelClient
    private let registry: ToolRegistry
    /// The tool list every request sends, built once so each carries the
    /// same bytes in the same order.
    private let toolDescriptors: [ModelToolDescriptor]
    private let permissions: PermissionCoordinator
    private let store: CodeSessionStore
    private let configuration: Configuration
    private let modelID: String
    private var activeModelID: String
    private let reasoningEffort: ReasoningEffort?
    /// The thinking setting sent with `activeModelID`: the reader's own
    /// until a fallback model answers instead, which gets one of its own.
    private var activeReasoningEffort: ReasoningEffort?
    private let lifecycleHooks: (any AgentLifecycleHooks)?
    private let fallbackResolver: (any ModelFallbackResolver)?
    /// Told when each of the reader's messages opens a turn, so the files the
    /// turn's tools change can be snapshotted against it. Nil where there is no
    /// workspace to snapshot.
    private let turnCheckpoints: (any TurnCheckpointing)?
    private let verificationEngine: VerificationEngine

    private var conversation: [ModelMessage] = []
    private var runTask: Task<Void, Never>?
    /// A `submit` between its guard and its run: the prompt's hooks are
    /// deciding whether it is sent. They can take minutes, and until this
    /// existed nothing marked the session as taken meanwhile — a second
    /// submit passed the `runTask` guard and started a second loop on the
    /// same conversation, one `stop()` could not reach. A task, not a flag,
    /// so `stop()` can cancel the hooks that are running.
    private var admission: Task<PromptHookContext, Error>?
    /// `stop()` arrived while `admission` was in flight.
    private var stoppedDuringAdmission = false
    /// How many times `stop()` has been called. A steer's hooks run in its
    /// caller's task, which Stop neither owns nor cancels, so an instruction
    /// reads this before its hooks and again after them: a change is a Stop
    /// that came while they decided.
    private var stopGeneration = 0
    private struct PendingInstruction: Sendable {
        let event: UserInstructionEvent
        /// The transcript event the reader sees for this instruction. It names
        /// the turn the instruction opens once applied.
        let rowEventID: String
        let modelPrompt: String
        let images: [ModelImage]
    }
    /// Instructions accepted while a run is active. The transcript persists
    /// acceptance and application separately; this in-memory queue is rebuilt
    /// from those events when a runtime is recreated after interruption.
    private var pendingInstructions: [PendingInstruction] = []
    private let toolScheduler = ToolScheduler()
    private var approvalObserverToken: UUID?
    /// Feeds the one task that writes approval updates, in order.
    private var approvalUpdates: AsyncStream<PermissionCoordinator.ApprovalUpdate>.Continuation?
    private var approvalWriter: Task<Void, Never>?
    private var restored = false
    private var liveTextObserver: (@Sendable (String) -> Void)?
    private var liveReasoningObserver: (@Sendable (String) -> Void)?
    private var lastLiveReasoningEmit = Date.distantPast
    private var lastLiveTextEmit = Date.distantPast
    /// The size of the prompt the provider last billed — system prompt, tool
    /// schemas and the whole conversation — which is what a context meter shows.
    private var contextTokens: Int?
    private var lastOutputTokens: Int?
    private var usageObserver: (@Sendable (Int?, Int?) -> Void)?
    /// Every call this orchestrator made, turns and compaction summaries alike.
    public private(set) var usageTotals = ModelUsageTotals()
    /// The same calls by model, which is how they are priced and what a
    /// delegating session adds to its own ledger.
    public private(set) var usageLedger = SessionUsageLedger()
    /// Calls recorded since the store's ledger was last brought up to date.
    private var unsavedUsage = SessionUsageLedger()
    private var callUsageObserver: (@Sendable (ModelCallUsage) -> Void)?

    /// True while a compaction is being written, from the first decision to
    /// the adopted result. A new run waits for it: the fold replaces the very
    /// history a prompt would be appended to.
    public private(set) var isCompacting = false
    private var compactionWaiters: [CheckedContinuation<Void, Never>] = []
    /// The model summary in flight, so Stop can reach one that a `/compact`
    /// between runs started — no run task exists to cancel then.
    private var summaryTask: Task<[CompactionSummarizer.Attempt], Never>?
    private var compactionObserver: (@Sendable (Bool) -> Void)?
    /// Successful model turns since the last compaction. Starts at the
    /// threshold so the first compaction of a session may use the model.
    private var modelTurnsSinceCompaction = AgentOrchestrator.minimumTurnsBetweenModelSummaries
    /// A compaction this soon after the last one writes structural notes
    /// rather than asking the model again. A window that refills within a
    /// turn or two is dominated by its newest steps, which no summary can
    /// shrink, and a summarising call per step would double the cost of every
    /// step while freeing nothing.
    static let minimumTurnsBetweenModelSummaries = 2

    /// Whether this orchestrator has asked the `SessionStart` hooks yet. The
    /// integration also remembers it across orchestrators, since one is
    /// replaced whenever the turn contract changes.
    private var sessionStartHooksRan = false
    /// `SessionStart` context that arrived with a prompt a hook then blocked,
    /// kept for the next prompt that is sent.
    private var pendingHookContext: [String] = []
    /// Set when a tool hook answers `"continue": false`, so the batch stops
    /// between waves and the run ends once every call is answered.
    private var hookHaltReason: String?
    /// The answer for each call in the turn whose arguments did not parse,
    /// by call id. Such a call is answered, never run.
    private var malformedToolResults: [String: String] = [:]

    /// How many times stop hooks may send one run back to work. Hooks are
    /// told when they already have (`stop_hook_active`) and are expected to
    /// let go; this is the bound for one that never does.
    static let maximumStopHookContinuations = 8

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
        fallbackResolver: (any ModelFallbackResolver)? = nil,
        turnCheckpoints: (any TurnCheckpointing)? = nil
    ) {
        self.sessionID = sessionID
        self.model = model
        self.registry = registry
        self.toolDescriptors = registry.allTools.map {
            ModelToolDescriptor(
                name: $0.name,
                description: $0.description,
                inputSchema: $0.inputSchema
            )
        }
        self.permissions = permissions
        self.store = store
        self.configuration = configuration
        self.modelID = modelID
        self.activeModelID = modelID
        self.reasoningEffort = reasoningEffort
        self.activeReasoningEffort = reasoningEffort
        self.lifecycleHooks = lifecycleHooks
        self.fallbackResolver = fallbackResolver
        self.turnCheckpoints = turnCheckpoints
        self.verificationEngine = VerificationEngine(store: store)
    }

    private func computeFallbackModel(for current: String) async -> String? {
        await fallbackResolver?.resolveFallback(for: current)
    }

    /// True from the moment a prompt is accepted for its hooks until its run
    /// ends, so nothing replaces this orchestrator while its hooks decide.
    public var isRunning: Bool { runTask != nil || admission != nil }

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

    /// Provider summaries have their own channel and never become answer text.
    public func observeLiveReasoning(_ observer: (@Sendable (String) -> Void)?) {
        liveReasoningObserver = observer
    }

    private func emitLiveReasoning(_ text: String, force: Bool = false) {
        let now = Date()
        guard force || now.timeIntervalSince(lastLiveReasoningEmit) >= 0.05 else { return }
        lastLiveReasoningEmit = now
        liveReasoningObserver?(text)
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

    /// Observes each model call's billed usage once, when the call ends.
    ///
    /// Separate from ``observeUsage(_:)`` because the two answer different
    /// questions: that one is the size of the context now, this one is what
    /// the session has spent — and a compaction summary adds to the second
    /// without saying anything about the first.
    public func observeCallUsage(_ observer: (@Sendable (ModelCallUsage) -> Void)?) {
        callUsageObserver = observer
    }

    /// Observes when the model is writing a compaction summary, so the surface
    /// can say why nothing else is happening for a while.
    public func observeCompaction(_ observer: (@Sendable (Bool) -> Void)?) {
        compactionObserver = observer
    }

    private func recordCall(_ usage: ModelCallUsage) {
        guard usage.inputTokens != nil || usage.outputTokens != nil else { return }
        let usage = usage.modelID == nil
            ? ModelCallUsage(
                purpose: usage.purpose,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
                modelID: activeModelID
            )
            : usage
        usageTotals.record(usage)
        usageLedger.record(usage)
        unsavedUsage.record(usage)
        callUsageObserver?(usage)
    }

    /// Adds the calls made since the last save to the session's ledger in
    /// the store, which keeps it across launches and tells the window.
    private func saveUsage() async {
        guard !unsavedUsage.isEmpty else { return }
        let batch = unsavedUsage
        unsavedUsage = SessionUsageLedger()
        _ = try? await store.recordUsage(batch, for: sessionID)
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
        // What was already announced is still written; the writer ends after.
        approvalUpdates?.finish()
        approvalUpdates = nil
        approvalWriter = nil
        liveTextObserver = nil
        liveReasoningObserver = nil
        usageObserver = nil
        callUsageObserver = nil
        compactionObserver = nil
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
    ///
    /// - Parameter accepted: told once the session is taken for this prompt,
    ///   before its hooks run. What follows can wait on the reader — a hook
    ///   may need an approval — so a caller that must not wait that long, a
    ///   remote command loop that also carries the approval's answer, learns
    ///   here that the prompt is in hand.
    public func submit(
        prompt: String,
        modelPrompt: String? = nil,
        images: [ModelImage] = [],
        accepted: (@Sendable () -> Void)? = nil
    ) async throws {
        // A `/compact` still being written would replace the history this
        // prompt is about to join; the prompt goes in after the fold instead.
        // Waited for before the guard, so whichever of two waiting prompts
        // resumes first takes the session and the other is refused.
        await waitForCompaction()
        guard runTask == nil, admission == nil else {
            throw OrchestratorError.sessionAlreadyRunning
        }
        // The session is taken here, before the first suspension: everything
        // below can wait, the prompt's hooks for minutes.
        stoppedDuringAdmission = false
        let admission = Task { () async throws -> PromptHookContext in
            try await self.prepare()
            // Before anything is recorded: a blocked prompt was never sent, so
            // it must not appear as a turn in the transcript or the history.
            return try await self.promptHookContext(for: prompt)
        }
        self.admission = admission
        accepted?()
        defer { self.admission = nil }
        let statusBefore = try? await store.session(id: sessionID).status
        let hookContext: PromptHookContext
        do {
            hookContext = try await admission.value
            guard !stoppedDuringAdmission else {
                pendingHookContext = hookContext.session + pendingHookContext
                throw OrchestratorError.stoppedBeforeSending
            }
        } catch {
            await restoreStatus(statusBefore)
            throw error
        }
        // The transcript stays faithful to what the reader typed while callers
        // may enrich the model-only turn with explicitly selected, bounded
        // workspace context. Keeping those two representations separate avoids
        // dumping source files into the visible conversation.
        let turnText = AgentHookContext.appending(hookContext.all, to: modelPrompt ?? prompt)
        let conversationIndex = conversation.count
        conversation.append(images.isEmpty ? .user(turnText) : .userWithImages(turnText, images))
        let promptEvent = try await store.appendEvent(
            sessionID: sessionID,
            payload: .userPrompt(
                UserPromptEvent(text: prompt, conversationIndex: conversationIndex)
            )
        )
        // Persist the model history before the asynchronous run begins. If the
        // process exits while the transport is connecting, the transcript and
        // resumable context still agree that this prompt was submitted.
        try await store.saveConversation(sessionID: sessionID, messages: conversation)
        // Before the run starts, so no tool can write ahead of its turn.
        await turnCheckpoints?.openTurn(
            id: promptEvent.id,
            sessionID: sessionID,
            openedAt: promptEvent.timestamp
        )
        try await store.setStatus(id: sessionID, status: .running)
        let task = Task { [weak self] in
            guard let self else { return }
            await self.runLoop()
        }
        runTask = task
        // `stop()` landed while the prompt was being recorded: the run starts,
        // finds itself cancelled, and ends as stopped by the reader.
        if stoppedDuringAdmission {
            task.cancel()
        }
    }

    /// Amends the active execution at the next safe boundary. If a model turn
    /// has proposed tools but none have started, the proposal is discarded and
    /// the correction is sent to the model before any side effect can begin.
    ///
    /// Throws `stoppedBeforeSending` when `stop()` comes while the
    /// instruction's hooks decide, as ``submit(prompt:modelPrompt:images:accepted:)``
    /// does; nothing is then recorded.
    ///
    /// - Parameter accepted: told once the run has taken the instruction,
    ///   before its hooks run; see ``submit(prompt:modelPrompt:images:accepted:)``.
    @discardableResult
    public func steer(
        prompt: String,
        modelPrompt: String? = nil,
        images: [ModelImage] = [],
        accepted: (@Sendable () -> Void)? = nil
    ) async throws -> String {
        try await acceptInstruction(
            prompt: prompt,
            modelPrompt: modelPrompt,
            images: images,
            kind: .steer,
            accepted: accepted
        )
    }

    /// Adds a follow-up that starts only after the active execution reaches a
    /// natural completion boundary.
    @discardableResult
    public func queue(
        prompt: String,
        modelPrompt: String? = nil,
        images: [ModelImage] = [],
        accepted: (@Sendable () -> Void)? = nil
    ) async throws -> String {
        try await acceptInstruction(
            prompt: prompt,
            modelPrompt: modelPrompt,
            images: images,
            kind: .queue,
            accepted: accepted
        )
    }

    private func acceptInstruction(
        prompt: String,
        modelPrompt: String?,
        images: [ModelImage],
        kind: UserInstructionKind,
        accepted: (@Sendable () -> Void)?
    ) async throws -> String {
        guard let run = runTask else { throw OrchestratorError.sessionNotRunning }
        // Read with the run, before the first suspension, so any `stop()`
        // counted from here on came while this instruction was on its way.
        let stopsBefore = stopGeneration
        let visible = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !visible.isEmpty || !images.isEmpty else { return "" }
        accepted?()
        try await prepare()
        // A steer is a prompt too, and a hook that vets prompts vets it. A
        // blocked one is never recorded as an instruction, so a restored
        // session cannot pick it back up from the transcript.
        let hookContext = try await promptHookContext(for: prompt)
        // Stopped while the hooks decided, the instruction is turned away as
        // a prompt is. Only the count can tell: the hooks run in the caller's
        // task, which Stop does not cancel, and one whose approval Stop
        // refused answers as a non-blocking failure, so they return as if
        // nothing had happened. Recorded, the steer would outlive the Stop —
        // applied by the next run, or, once this one had ended, starting a
        // turn of its own.
        guard stopGeneration == stopsBefore else {
            pendingHookContext = hookContext.session + pendingHookContext
            throw OrchestratorError.stoppedBeforeSending
        }
        // The hooks can outlast the run the instruction was for. Recorded
        // now, it would belong to a run that has ended: nothing would ever
        // apply it, and the reader would be told it had been delivered.
        guard runTask == run else {
            pendingHookContext = hookContext.session + pendingHookContext
            throw OrchestratorError.sessionNotRunning
        }
        let event = UserInstructionEvent(text: prompt, kind: kind)
        let row = try await store.appendEvent(
            sessionID: sessionID,
            payload: .userInstruction(event)
        )
        pendingInstructions.append(
            PendingInstruction(
                event: event,
                rowEventID: row.id,
                modelPrompt: AgentHookContext.appending(hookContext.all, to: modelPrompt ?? prompt),
                images: images
            )
        )
        return event.id
    }

    /// What the hooks in front of a prompt added to the model's context.
    private struct PromptHookContext: Sendable {
        /// `SessionStart`'s, with any an unsent prompt left behind. It is
        /// about the session, so a prompt that does not go passes it on to
        /// the next one that does.
        var session: [String]
        /// `UserPromptSubmit`'s, about this prompt alone.
        var prompt: [String] = []

        var all: [String] { session + prompt }
    }

    /// Runs the hooks that stand between the reader and the model: the
    /// session's start, once, then the prompt itself. Returns what they add
    /// to the model's context, and throws when one blocks the prompt or the
    /// reader stops the session while they run.
    private func promptHookContext(for prompt: String) async throws -> PromptHookContext {
        var context = PromptHookContext(session: pendingHookContext)
        pendingHookContext = []
        if !sessionStartHooksRan {
            sessionStartHooksRan = true
            let source: AgentSessionStartSource = conversation.isEmpty ? .startup : .resume
            if let start = await lifecycleHooks?.sessionStarted(sessionID: sessionID, source: source) {
                try stopIfCancelled(keeping: context)
                await ToolScheduler.record(start.notices, sessionID: sessionID, store: store)
                context.session += start.context
            }
        }
        guard let response = await lifecycleHooks?.promptSubmitted(
            sessionID: sessionID,
            prompt: prompt
        ) else {
            return context
        }
        try stopIfCancelled(keeping: context)
        await ToolScheduler.record(response.notices, sessionID: sessionID, store: store)
        if let reason = response.haltReason ?? response.blockReason {
            // The session did start, so what its start hooks said still
            // belongs in front of the model — with the next prompt that goes.
            pendingHookContext = context.session
            throw OrchestratorError.promptBlocked(reason: reason)
        }
        context.prompt = response.context
        return context
    }

    /// Ends the prompt's hooks early when the reader stopped the session
    /// while they ran. The hooks were killed, so what they returned says
    /// only that, and is not worth a row in the thread.
    private func stopIfCancelled(keeping context: PromptHookContext) throws {
        guard Task.isCancelled else { return }
        pendingHookContext = context.session
        throw OrchestratorError.stoppedBeforeSending
    }

    /// Puts back the status a prompt that was not sent found. An approval
    /// one of its hooks asked for marks the session waiting and then
    /// running, and no run follows to settle it.
    private func restoreStatus(_ status: SessionStatus?) async {
        guard let status,
              let current = try? await store.session(id: sessionID).status,
              current != status,
              current.isActive
        else { return }
        try? await store.setStatus(id: sessionID, status: status)
    }

    /// Requests an immediate stop: cancels the loop and denies every pending
    /// approval so suspended tools resume with a denial and exit.
    public func stop() async {
        // Counted first and in every branch: an instruction whose hooks are
        // still running learns of this Stop from it, whether or not a run is
        // left to cancel by the time they return.
        stopGeneration += 1
        guard let task = runTask else {
            // Between runs Stop can reach two things. A `/compact` waiting on
            // the model: stopping it keeps the structural summary.
            summaryTask?.cancel()
            // And a prompt whose hooks are deciding on a run: they are killed,
            // an approval one of them waits on is refused, and the prompt is
            // not sent.
            if let admission {
                stoppedDuringAdmission = true
                admission.cancel()
                await permissions.denyAll()
                _ = try? await admission.value
            }
            return
        }
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
            let events = await store.events(for: sessionID)
            // A batch is saved before it runs, so a history that ends in calls
            // without results is one the app stopped in the middle of. The
            // transcript says which of them began and which finished, and the
            // model is told each one's truth: a call that started may have
            // done its work, and must not be reported as never run. Sessions
            // saved before the integrity pass existed may carry an unanswered
            // call too; repairing on load is what un-bricks them.
            conversation = ConversationIntegrity.repaired(
                await store.loadConversation(sessionID: sessionID),
                interrupted: ConversationIntegrity.interruptedCalls(in: events)
            )
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
                    rowEventID: event.id,
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
            let hooks = self.lifecycleHooks
            // One writer, in the order the coordinator announced them. A task
            // per update raced its neighbours: a resolution could be written
            // before its request, and the waiting flag set after it was
            // cleared, leaving the session marked as waiting on nothing.
            let (updates, writer) = AsyncStream.makeStream(of: PermissionCoordinator.ApprovalUpdate.self)
            approvalUpdates = writer
            approvalObserverToken = await permissions.addObserver { update in
                writer.yield(update)
            }
            approvalWriter = Task {
                for await update in updates {
                    await Self.record(
                        update,
                        sessionID: sessionID,
                        store: store,
                        permissions: permissions,
                        hooks: hooks
                    )
                }
            }
        }
    }

    /// Writes one approval update to the transcript and the session record.
    private static func record(
        _ update: PermissionCoordinator.ApprovalUpdate,
        sessionID: CodeSessionID,
        store: CodeSessionStore,
        permissions: PermissionCoordinator,
        hooks: (any AgentLifecycleHooks)?
    ) async {
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
            // A `Notification` hook is how a reader who has walked away hears
            // that the run is waiting on them. A hook's own approval is left
            // out: it would announce itself. Its own task, so a slow hook
            // never holds up the next update's record.
            if request.toolName != "hook", let hooks {
                Task {
                    let response = await hooks.notify(
                        sessionID: sessionID,
                        kind: .permissionPrompt,
                        message: "Juno needs your permission: \(request.summary)"
                    )
                    await ToolScheduler.record(response.notices, sessionID: sessionID, store: store)
                }
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
            // Several tool calls in one turn can each be gated, and this used
            // to clear `hasPendingApproval` and flip the status back to
            // `.running` on the *first* resolution. The remaining requests were
            // still suspended and their cards still drawn, but the session
            // claimed to be running and the sidebar's "waiting for approval"
            // marker went out — so a run that was blocked on the reader looked
            // like a run that was working.
            let stillPending = await permissions.pendingApprovals.isEmpty == false
            _ = try? await store.updateSession(id: sessionID) { session in
                session.hasPendingApproval = stillPending
                if !stillPending, session.status == .waitingForApproval {
                    session.status = .running
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
        var stopHookContinuations = 0
        // Whether this step already folded the history after the window
        // overflowed; a second overflow in a row is a failure.
        var overflowRecoveryUsed = false
        hookHaltReason = nil

        defer {
            runTask = nil
        }

        var iteration = 0
        while true {
            iteration += 1
            // The last step's calls, and any summary since, reach the store's
            // ledger before the next step begins.
            await saveUsage()
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
            // A stop that arrived while the summary was being written ends
            // the run here rather than after one more request.
            if Task.isCancelled { continue }

            var turnText = ""
            var turnReasoningSummary = ""
            // The turn's model-authored content in stream order: reasoning
            // blocks, text segments and tool calls. Adaptive thinking may put a
            // reasoning block between two tool calls, and Anthropic checks
            // that it comes back where it was.
            var turnItems: [ModelMessage] = []
            var pendingSegment = ""
            func closeSegment() {
                if !pendingSegment.isEmpty {
                    turnItems.append(.assistant(pendingSegment))
                    pendingSegment = ""
                }
            }
            var toolCalls: [(id: String, name: String, input: JSONValue, extraContent: JSONValue?)] = []
            var stopReason: ModelStopReason?
            lastLiveTextEmit = .distantPast
            emitLiveText("", force: true)
            emitLiveReasoning("", force: true)
            lastLiveTextEmit = .distantPast
            lastLiveReasoningEmit = .distantPast
            var thinkingFilter = LeadingThinkingFilter()
            func consumeText(_ parts: (text: String, reasoning: String)) {
                if !parts.text.isEmpty {
                    turnText += parts.text
                    pendingSegment += parts.text
                    emitLiveText(turnText)
                }
                if !parts.reasoning.isEmpty {
                    turnReasoningSummary = String((turnReasoningSummary + parts.reasoning).suffix(12_000))
                    emitLiveReasoning(turnReasoningSummary)
                }
            }

            // This step's retries of one model, and the waiting they have
            // cost; both start again when a fallback model takes over.
            var retries = 0
            var waited = Duration.zero
            var fallbackAttempted = false

            // Every request goes out valid, whatever path left the history in
            // its current shape.
            conversation = ConversationIntegrity.repaired(conversation)
            // Past the image budget, the oldest answered images become text in
            // one go: one cache break instead of a request no provider takes.
            if let bounded = ImageRetention.withinBudget(
                conversation,
                maximumImages: configuration.maximumRetainedImages,
                maximumBytes: configuration.maximumRetainedImageBytes
            ) {
                conversation = bounded
            }
            await appendSessionStateIfChanged()

            while true {
                let request = ModelTurnRequest(
                    sessionID: sessionID,
                    systemPrompt: configuration.systemPrompt,
                    messages: conversation,
                    tools: toolDescriptors,
                    modelID: activeModelID,
                    reasoningEffort: activeReasoningEffort
                )
                turnText = ""
                turnReasoningSummary = ""
                turnItems.removeAll()
                pendingSegment = ""
                toolCalls.removeAll()
                malformedToolResults.removeAll()
                thinkingFilter = LeadingThinkingFilter()
                stopReason = nil
                // This call's own usage, per field, newest wins; summed into
                // the session's totals once the call ends, however it ends.
                var callInputTokens: Int?
                var callOutputTokens: Int?
                var callCacheReadTokens: Int?
                var callCacheWriteTokens: Int?

                do {
                    defer {
                        recordCall(ModelCallUsage(
                            purpose: .turn,
                            inputTokens: callInputTokens,
                            outputTokens: callOutputTokens,
                            cacheReadTokens: callCacheReadTokens,
                            cacheWriteTokens: callCacheWriteTokens,
                            modelID: activeModelID
                        ))
                    }
                    for try await event in model.streamTurn(request) {
                        if Task.isCancelled { break }
                        switch event {
                        case let .textDelta(delta):
                            consumeText(thinkingFilter.push(delta))
                        case let .thinkingBlock(text, signature):
                            closeSegment()
                            turnItems.append(.assistantThinking(text: text, signature: signature))
                        case let .redactedThinking(data):
                            closeSegment()
                            turnItems.append(.assistantRedactedThinking(data: data))
                        case let .reasoningSummary(summary):
                            // Providers stream reasoning summaries as token-sized
                            // deltas. Keep those private to the active turn and
                            // persist one bounded, readable summary instead of one
                            // transcript event per delta.
                            consumeText(("", summary))
                        case let .toolCallRequested(id, name, input):
                            closeSegment()
                            toolCalls.append((id, name, input, nil))
                            turnItems.append(.toolCall(id: id, name: name, input: input))
                        case let .toolCallRequestedWithExtra(id, name, input, extra):
                            closeSegment()
                            toolCalls.append((id, name, input, extra))
                            turnItems.append(
                                .toolCallWithExtra(id: id, name: name, input: input, extraContent: extra)
                            )
                        case let .toolCallMalformed(id, name, rawArguments, error, extra):
                            // Kept in the history as a call with no arguments,
                            // which every provider replays, and answered with
                            // the parser's complaint instead of being run.
                            closeSegment()
                            toolCalls.append((id, name, .object([:]), extra))
                            turnItems.append(
                                extra.map {
                                    .toolCallWithExtra(id: id, name: name, input: .object([:]), extraContent: $0)
                                } ?? .toolCall(id: id, name: name, input: .object([:]))
                            )
                            malformedToolResults[id] = ToolArguments.malformedResult(
                                toolName: name,
                                rawArguments: rawArguments,
                                error: error
                            )
                        case let .usage(inputTokens, outputTokens):
                            // Replaced, not accumulated: `inputTokens` is the whole
                            // billed prompt for this turn, so the newest report *is*
                            // the current context size. Summing them would count the
                            // conversation once per turn and race past the window.
                            if let inputTokens {
                                contextTokens = inputTokens
                                callInputTokens = inputTokens
                            }
                            if let outputTokens {
                                lastOutputTokens = outputTokens
                                callOutputTokens = outputTokens
                            }
                            usageObserver?(contextTokens, lastOutputTokens)
                        case let .cacheUsage(readTokens, writeTokens):
                            if let readTokens { callCacheReadTokens = readTokens }
                            if let writeTokens { callCacheWriteTokens = writeTokens }
                        case let .turnCompleted(reason):
                            stopReason = reason
                        }
                    }
                    break
                } catch {
                    if Task.isCancelled {
                        break
                    }
                    let failure = ModelFailure(error)

                    // The account's allowance: every model draws on it, so
                    // neither waiting nor another model helps.
                    if case let .planLimit(message) = failure {
                        _ = try? await store.appendEvent(
                            sessionID: sessionID,
                            payload: .errorOccurred(ErrorEvent(message: message, isRecoverable: true))
                        )
                        try? await store.saveConversation(sessionID: sessionID, messages: conversation)
                        await finish(
                            status: .failed,
                            summary: message,
                            filesChanged: filesChanged.count,
                            testsPassed: testsPassed,
                            startedAt: startedAt
                        )
                        return
                    }

                    // Too long for the window: the same request fails the
                    // same way, a folded one may not. Once per step.
                    if case .contextOverflow = failure, !overflowRecoveryUsed {
                        overflowRecoveryUsed = true
                        if await recoverFromContextOverflow() {
                            continue
                        }
                    }

                    // Worth waiting out on the same model: a limit, an
                    // overload, a dropped connection.
                    let retryLimit = failure.retryLimit(configuration.retryPolicy)
                    if retryLimit > retries {
                        retries += 1
                        if let delay = configuration.retryPolicy.delay(
                            forRetry: retries,
                            retryAfter: failure.retryAfter,
                            waited: waited,
                            jitter: configuration.retryJitter()
                        ) {
                            waited += delay
                            _ = try? await store.appendEvent(
                                sessionID: sessionID,
                                payload: .errorOccurred(
                                    ErrorEvent(
                                        message: "\(failure.sentence) Retrying in \(Self.seconds(delay)) (retry \(retries) of \(retryLimit)).",
                                        isRecoverable: true
                                    )
                                )
                            )
                            do {
                                try await configuration.retrySleep(delay)
                            } catch {
                                // Stopped while waiting: the top of the loop
                                // ends the run as stopped.
                                break
                            }
                            if Task.isCancelled { break }
                            continue
                        }
                    }

                    // Waiting is spent or would not help. Another model — only
                    // when the reader opted into fallback, which is when a
                    // resolver exists — may still answer.
                    if failure.warrantsFallback, !fallbackAttempted,
                       let fallback = await computeFallbackModel(for: activeModelID),
                       fallback != activeModelID
                    {
                        fallbackAttempted = true
                        retries = 0
                        waited = .zero
                        _ = try? await store.appendEvent(
                            sessionID: sessionID,
                            payload: .errorOccurred(
                                ErrorEvent(
                                    message: "\(failure.sentence) Switching from '\(activeModelID)' to '\(fallback)' to continue.",
                                    isRecoverable: true
                                )
                            )
                        )
                        // Its own thinking setting: the reader's was chosen for
                        // another model, and may be one this one rejects.
                        activeReasoningEffort = fallbackResolver?.reasoningEffort(
                            for: fallback,
                            preferred: reasoningEffort
                        )
                        activeModelID = fallback
                        continue
                    }

                    _ = try? await store.appendEvent(
                        sessionID: sessionID,
                        payload: .errorOccurred(
                            ErrorEvent(
                                message: "Model turn failed: \(failure.sentence) \(shortDescription(error))",
                                isRecoverable: false
                            )
                        )
                    )
                    try? await store.saveConversation(sessionID: sessionID, messages: conversation)
                    await finish(
                        status: .failed,
                        summary: failure.sentence,
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
            consumeText(thinkingFilter.finish())
            modelTurnsSinceCompaction += 1
            // Images the model has now seen stay exactly as they were sent:
            // rewriting them here would change the prefix of every later
            // request. They become text at compaction, or past the image
            // budget above. The store never keeps their bytes either way.

            let normalizedReasoning = turnReasoningSummary.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            if !normalizedReasoning.isEmpty {
                emitLiveReasoning("", force: true)
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .reasoningSummary(
                        ReasoningSummaryEvent(summary: normalizedReasoning)
                    )
                )
            }

            closeSegment()
            // The model's content goes into history now, minus its tool calls:
            // those are added only once the batch is committed to running, so
            // a steer that discards the proposal leaves no call unanswered.
            let narrative = turnItems.filter { $0.toolCallID == nil }
            conversation.append(contentsOf: narrative)
            if !turnText.isEmpty {
                lastAssistantText = turnText
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .assistantMessage(AssistantMessageEvent(text: turnText))
                )
            }

            // The reply was cut off because the window is full. Nothing it
            // says is kept for the model: the history is folded and the step
            // asked again, once, and only then treated as a failure.
            if stopReason == .contextWindowExceeded {
                conversation.removeLast(narrative.count)
                if !overflowRecoveryUsed {
                    overflowRecoveryUsed = true
                    if await recoverFromContextOverflow() { continue }
                }
                try? await store.saveConversation(sessionID: sessionID, messages: conversation)
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .errorOccurred(
                        ErrorEvent(
                            message: "The conversation no longer fits the model's context window, even compacted.",
                            isRecoverable: true
                        )
                    )
                )
                await finish(
                    status: .failed,
                    summary: "The conversation no longer fits the model's context window. Compact it or start a new session.",
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }
            overflowRecoveryUsed = false

            // The model declined. What it wrote is in the transcript for the
            // reader, but not in its own history: a refused turn left there
            // tends to be refused again when the conversation carries on.
            if stopReason == .refusal {
                conversation.removeLast(narrative.count)
                try? await store.saveConversation(sessionID: sessionID, messages: conversation)
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .errorOccurred(
                        ErrorEvent(
                            message: "The model declined to continue with this request.",
                            isRecoverable: true
                        )
                    )
                )
                await finish(
                    status: .failed,
                    summary: "The model declined to continue. Rephrase the request, or rewind to before it.",
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }

            // A paused turn is resumed by sending the conversation back as it
            // stands, ending in the model's own message. Its calls, if it made
            // any, are a normal tool turn.
            if stopReason == .pauseTurn {
                if toolCalls.isEmpty {
                    try? await store.saveConversation(sessionID: sessionID, messages: conversation)
                    continue
                }
                stopReason = .toolUse
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

            // A valid tool call defines the work even when a compatible
            // provider labels its completion as a normal end of turn.
            if stopReason == .endTurn, !toolCalls.isEmpty { stopReason = .toolUse }
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

            // The calls with the arguments they will run with: the schema's
            // exact conversions applied once, here, so the proposal the reader
            // sees and the waves the batch is cut into read the values the
            // tool will. A `read_file` whose arguments came as one JSON string
            // otherwise read as touching no path and shared a wave with a
            // write to the same file. The history keeps each call as the model
            // wrote it, which is what its replayed reasoning is bound to.
            let proposedCalls = toolCalls.map { call in
                (
                    id: call.id,
                    name: call.name,
                    input: registry.coercedInput(toolName: call.name, input: call.input),
                    extraContent: call.extraContent
                )
            }
            if stopReason == .toolUse {
                for call in proposedCalls {
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
                // The agent means to stop. A stop hook may send it back with a
                // reason, which reaches the model the way Claude Code phrases
                // it, as the next thing to act on. It is a user-role turn the
                // reader did not write, and marked as one: compaction must
                // never quote it as the reader's latest message.
                if let reason = await stopHookFeedback(
                    lastMessage: lastAssistantText,
                    continuations: stopHookContinuations
                ) {
                    stopHookContinuations += 1
                    conversation.append(.user(AgentHookContext.stopFeedback(reason)))
                    try? await store.saveConversation(sessionID: sessionID, messages: conversation)
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

            // Replace the turn's non-call items with the full ordered turn, so
            // a reasoning block that fell between two calls keeps its place.
            conversation.removeLast(turnItems.filter { $0.toolCallID == nil }.count)
            conversation.append(contentsOf: turnItems)
            // Saved before anything runs. Were the app to stop mid-batch, the
            // store would otherwise hold a history without this turn at all,
            // while its commits, installs and edits had happened; a resumed
            // model would not know, and could do them twice. With the calls
            // saved, restore answers each from the transcript: started calls
            // as outcome unknown, the rest as never run.
            try? await store.saveConversation(sessionID: sessionID, messages: conversation)

            let scheduledCalls = proposedCalls
            var terminalGoalLifecycle: GoalLifecycle?
            // The goal as the batch found it, so a goal completed in an
            // earlier run is not mistaken for one completed by this batch.
            let goalAtBatchStart = try? await store.session(id: sessionID).goal

            let executionResults = await toolScheduler.execute(
                calls: scheduledCalls,
                // Only *asks* whether to stop between waves. Applying the steer
                // here used to append the reader's message between the calls
                // and their results, which every provider rejects.
                shouldInterrupt: { [weak self, store, sessionID] in
                    guard let self else { return true }
                    if let goal = try? await store.session(id: sessionID).goal,
                       Self.goalHalts(goal, startedAs: goalAtBatchStart)
                    {
                        return true
                    }
                    if await self.hookHaltReason != nil {
                        return true
                    }
                    return await self.hasPendingSteer
                },
                // Every call goes through `executeToolCall`, the one dispatch
                // path `scripts/check-approval-dispatch.mjs` pins behind the
                // hook → authorize → execute order. The actor is reentrant at
                // the await inside it, so a wave still runs concurrently.
                executor: { [weak self] (id, name, input) in
                    guard let self else {
                        return ToolScheduler.ExecutionResult(
                            callID: id,
                            toolName: name,
                            input: input,
                            content: ConversationIntegrity.notExecutedMessage,
                            isError: true
                        )
                    }
                    return await self.executeToolCall((id, name, input))
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
                let bounded = boundedToolResult(execution)
                if execution.images.isEmpty {
                    conversation.append(
                        .toolResult(id: execution.callID, content: bounded, isError: execution.isError)
                    )
                } else {
                    conversation.append(
                        .toolResultWithImages(
                            id: execution.callID,
                            content: bounded,
                            isError: execution.isError,
                            images: execution.images
                        )
                    )
                }
            }

            // A model-authored pause, block, or completion — or the reader's —
            // is an execution boundary, not merely metadata: no later wave ran
            // (the scheduler's `shouldInterrupt` saw it) and no further
            // iteration begins. It is read once every result is recorded, not
            // between them. Everything in `executionResults` already ran, and
            // stopping partway through recording told the model that calls
            // which had written files or run commands were never executed, so
            // a resumed session repeated them.
            if let goal = try? await store.session(id: sessionID).goal,
               Self.goalHalts(goal, startedAs: goalAtBatchStart)
            {
                terminalGoalLifecycle = goal.lifecycle
            }

            // Answer every call the batch did not reach before anything else
            // enters the history.
            conversation.append(
                contentsOf: ConversationIntegrity.skippedResults(
                    for: scheduledCalls.map(\.id),
                    executed: Set(executionResults.map(\.callID))
                )
            )
            try? await store.saveConversation(sessionID: sessionID, messages: conversation)
            // A hook answered `"continue": false`: the run ends now that every
            // call has its answer. The hook's own row already says why.
            if let halt = hookHaltReason {
                await finish(
                    status: .completed,
                    summary: "Stopped by a hook: \(halt)",
                    filesChanged: filesChanged.count,
                    testsPassed: testsPassed,
                    startedAt: startedAt
                )
                return
            }
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

            // A steer that arrived during the batch is applied at the next
            // boundary: the top of the loop, now that every call is answered.
        }
    }

    private var hasPendingSteer: Bool {
        pendingInstructions.contains { $0.event.kind == .steer }
    }

    /// Whether the session's goal is an execution boundary for a batch that
    /// began with `start`: paused, blocked or completed.
    ///
    /// Except the goal that was already complete when the batch began. That
    /// one is the session's history, not a stop: the check used to read any
    /// goal that was not active as one, so once a goal was complete every
    /// later batch in the session — the `update_goal` that would start the
    /// next goal included — stopped before its first call ran, and the run
    /// ended as "Goal completed." A goal this batch completes, a new one
    /// included, still ends the run.
    static func goalHalts(_ goal: SessionGoal, startedAs start: SessionGoal?) -> Bool {
        switch goal.lifecycle {
        case .active:
            return false
        case .completed:
            return !(start?.id == goal.id && start?.lifecycle == .completed)
        case .paused, .blocked:
            return true
        }
    }

    /// Folds the history after the provider found it longer than the window,
    /// so the step can be asked again. False when there was nothing safe to
    /// fold, and the failure stands.
    private func recoverFromContextOverflow() async -> Bool {
        _ = try? await store.appendEvent(
            sessionID: sessionID,
            payload: .errorOccurred(
                ErrorEvent(
                    message: "The conversation is longer than the model's context window. Compacting it, then trying again.",
                    isRecoverable: true
                )
            )
        )
        guard await compactConversationIfNeeded(overflowed: true) else { return false }
        conversation = ConversationIntegrity.repaired(conversation)
        // The fold may have taken the last state block with it.
        await appendSessionStateIfChanged()
        return true
    }

    /// A wait, as the transcript says it: "800 ms", "4 s".
    static func seconds(_ duration: Duration) -> String {
        let milliseconds = duration.components.seconds * 1_000
            + duration.components.attoseconds / 1_000_000_000_000_000
        guard milliseconds >= 1_000 else { return "\(milliseconds) ms" }
        return "\((milliseconds + 500) / 1_000) s"
    }

    /// Tells the model what changed about the session since it was last told:
    /// a `<session_state>` block holding only the sections whose facts moved,
    /// appended after the history and kept in it. See ``SessionState``.
    ///
    /// Skipped when the model wrote last — a turn it paused continues from
    /// its own message — and the facts are simply read again next time.
    private func appendSessionStateIfChanged() async {
        guard let provider = configuration.sessionState,
              let last = conversation.last,
              !last.isAssistantSide
        else { return }
        let changed = SessionState.changedSections(await provider(), since: conversation)
        guard let block = SessionState.render(changed) else { return }
        conversation.append(.user(block))
        try? await store.saveConversation(sessionID: sessionID, messages: conversation)
    }

    /// A tool result within the configured cap.
    ///
    /// Command output keeps both ends, because the error a build prints last
    /// is the part that matters. A read cannot be cut that way: its header
    /// vouches for the lines and the fingerprint of what follows, so a cut
    /// through the middle would hand over a base_sha256 for a file the model
    /// never saw whole. read_file bounds itself well under the cap; when a
    /// lower cap still has to cut one, it is cut head-first with the header
    /// rewritten to match.
    private func boundedToolResult(_ execution: ToolScheduler.ExecutionResult) -> String {
        if execution.toolName == "read_file" {
            return ReadFileTool.bounded(
                execution.content,
                maximumBytes: configuration.maximumToolResultBytes
            )
        }
        return OutputLimiter.applyKeepingEnds(
            OutputLimit(maximumBytes: configuration.maximumToolResultBytes),
            to: execution.content
        ).text
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

        var conversationIndexes: [Int] = []
        for instruction in selected {
            let text = instruction.modelPrompt
            conversationIndexes.append(conversation.count)
            if instruction.images.isEmpty {
                conversation.append(.user(text))
            } else {
                conversation.append(.userWithImages(text, instruction.images))
            }
        }
        try? await store.saveConversation(sessionID: sessionID, messages: conversation)
        // Each applied instruction is a turn of its own, so a rewind can
        // return to any one of them. The last one opened is the one this
        // batch's tools write under.
        for (instruction, conversationIndex) in zip(selected, conversationIndexes) {
            let applied = try? await store.appendEvent(
                sessionID: sessionID,
                payload: .userInstructionApplied(
                    UserInstructionAppliedEvent(
                        instructionID: instruction.event.id,
                        conversationIndex: conversationIndex
                    )
                )
            )
            await turnCheckpoints?.openTurn(
                id: instruction.rowEventID,
                sessionID: sessionID,
                openedAt: applied?.timestamp ?? Date()
            )
        }
        return true
    }

    /// Compacts before a provider request, never in the middle of a tool turn.
    /// This keeps the model-facing history valid while ensuring a resumed app
    /// sees the same bounded memory because the compacted messages are persisted.
    ///
    /// - Parameter overflowed: the provider just refused the history as too
    ///   long for the window. The fold is forced, and the summary is not asked
    ///   as a continuation of that same history.
    /// - Returns: whether the history was folded.
    @discardableResult
    private func compactConversationIfNeeded(overflowed: Bool = false) async -> Bool {
        let tokenTrigger: Bool
        if overflowed {
            tokenTrigger = true
        } else if let window = configuration.contextWindowTokens,
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
        guard let plan = ConversationCompactor.plan(
            conversation,
            maximumBytes: contextSizedMaximum ?? configuration.maximumConversationBytes,
            force: tokenTrigger
        ) else { return false }
        isCompacting = true
        defer { finishCompacting() }
        let event = await fold(
            plan,
            focus: nil,
            requestedByUser: false,
            allowModel: modelTurnsSinceCompaction >= Self.minimumTurnsBetweenModelSummaries,
            allowContinuation: !overflowed
        )
        return event != nil
    }

    /// Folds the conversation down now, at the reader's request.
    ///
    /// The runtime already compacts on its own ahead of a provider limit; this
    /// is the `/compact` the reader types when they know the early turns are
    /// no longer worth carrying, with `focus` saying what the summary should
    /// keep. Refused mid-run — the conversation is being appended to by the
    /// loop that owns it, or about to be by a prompt whose hooks are still
    /// deciding — and answered with nil when there is nothing safe to fold (a
    /// single turn has no "older" half).
    public func compactNow(focus: String? = nil) async -> CompactionEvent? {
        guard !isRunning, !isCompacting else { return nil }
        // Set before the first suspension, so a prompt sent meanwhile waits
        // for the fold instead of joining the history it is about to replace.
        isCompacting = true
        defer { finishCompacting() }
        if !restored {
            try? await prepare()
        }
        guard let plan = ConversationCompactor.plan(
            conversation,
            maximumBytes: configuration.maximumConversationBytes,
            force: true
        ) else { return nil }
        // The reader asked, so the model is asked too, however recently the
        // last compaction ran.
        let event = await fold(
            plan,
            focus: focus,
            requestedByUser: true,
            allowModel: true,
            allowContinuation: true
        )
        // Between runs nothing else saves the summary's cost.
        await saveUsage()
        return event
    }

    private func finishCompacting() {
        isCompacting = false
        let waiters = compactionWaiters
        compactionWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func waitForCompaction() async {
        while isCompacting {
            await withCheckedContinuation { compactionWaiters.append($0) }
        }
    }

    /// The configured summary limits, with the transcript sized to this
    /// model's window when it is known: about half the window at four
    /// characters a token, which leaves the instructions, the earlier summary
    /// and the reply their room.
    private var summaryLimits: CompactionSummarizer.Limits? {
        guard var limits = configuration.compactionSummary else { return nil }
        if let window = configuration.contextWindowTokens, window > 0 {
            limits.maximumTranscriptCharacters = min(
                limits.maximumTranscriptCharacters,
                max(16_000, window * 2)
            )
        }
        return limits
    }

    private struct CompactionOutcome {
        let result: ConversationCompactionResult
        let source: CompactionEvent.SummarySource
        let fallbackReason: String?
        let usage: ModelCallUsage?
    }

    /// Writes the summary for `plan` — the model's when it is configured,
    /// allowed and answers with one, the structural notes otherwise — and
    /// installs the result.
    @discardableResult
    private func fold(
        _ plan: ConversationCompactionPlan,
        focus: String?,
        requestedByUser: Bool,
        allowModel: Bool,
        allowContinuation: Bool
    ) async -> CompactionEvent? {
        let planned = conversation.count
        let outcome = await summarize(
            plan,
            focus: focus,
            allowModel: allowModel,
            allowContinuation: allowContinuation
        )
        // Nothing appends to the history while it is being folded: a new run
        // waits for the fold and a steer waits for the next boundary. Should
        // that ever stop holding, installing this result would silently drop
        // whatever arrived, so the fold is skipped and the next boundary
        // plans again from the history as it now is.
        guard conversation.count == planned else { return nil }
        return await adopt(outcome, requestedByUser: requestedByUser, focus: focus)
    }

    private func summarize(
        _ plan: ConversationCompactionPlan,
        focus: String?,
        allowModel: Bool,
        allowContinuation: Bool
    ) async -> CompactionOutcome {
        guard allowModel, let limits = summaryLimits else {
            return CompactionOutcome(result: plan.structural, source: .structural, fallbackReason: nil, usage: nil)
        }
        compactionObserver?(true)
        let model = self.model
        let sessionID = self.sessionID
        let modelID = activeModelID
        // Asked as the session's own next request where the provider caches
        // it and it fits the window; otherwise, or when that answer is not a
        // summary, from the escaped transcript.
        let prefix: CompactionSummarizer.CachedPrefix? =
            allowContinuation && model.cachesPromptPrefix(for: modelID) && continuationFits(limits)
                ? CompactionSummarizer.CachedPrefix(
                    systemPrompt: configuration.systemPrompt,
                    tools: toolDescriptors,
                    messages: conversation,
                    reasoningEffort: activeReasoningEffort
                )
                : nil
        // Its own task so Stop can reach it between runs; inside a run the
        // cancellation handler carries the run's own stop through to it.
        let task = Task { () -> [CompactionSummarizer.Attempt] in
            var attempts: [CompactionSummarizer.Attempt] = []
            if let prefix {
                let continued = await CompactionSummarizer.summarize(
                    request: CompactionSummarizer.continuationRequest(
                        prefix: prefix,
                        focus: focus,
                        sessionID: sessionID,
                        modelID: modelID,
                        limits: limits
                    ),
                    model: model,
                    limits: limits
                )
                attempts.append(continued)
                // A stop or a deadline is not something a second request
                // would change.
                if continued.summary != nil
                    || continued.failure == .cancelled
                    || continued.failure == .timedOut
                {
                    return attempts
                }
            }
            attempts.append(await CompactionSummarizer.summarize(
                plan: plan,
                focus: focus,
                model: model,
                sessionID: sessionID,
                modelID: modelID,
                limits: limits
            ))
            return attempts
        }
        summaryTask = task
        let attempts = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        summaryTask = nil
        compactionObserver?(false)
        // Billed whether or not the summary was usable.
        attempts.forEach { recordCall($0.usage) }
        let usage = Self.combined(attempts.map(\.usage))
        if let summary = attempts.last?.summary {
            return CompactionOutcome(
                result: plan.result(modelSummary: summary),
                source: .model,
                fallbackReason: nil,
                usage: usage
            )
        }
        return CompactionOutcome(
            result: plan.structural,
            source: .structural,
            fallbackReason: attempts.last?.failure?.reason,
            usage: usage
        )
    }

    /// Whether the session's own request, with the summary instruction and
    /// its reply, still fits the window. Estimated from the larger of the last
    /// reported prompt and the history's weight, since what was added since
    /// that report is not in it.
    private func continuationFits(_ limits: CompactionSummarizer.Limits) -> Bool {
        guard let window = configuration.contextWindowTokens, window > 0 else { return false }
        let estimated = max(contextTokens ?? 0, ConversationCompactor.encodedByteCount(conversation) / 4)
        return estimated + limits.maximumOutputTokens + 4_096 <= window
    }

    /// Several calls' usage as one, for the record that names one summary.
    private static func combined(_ usages: [ModelCallUsage]) -> ModelCallUsage? {
        guard let first = usages.first else { return nil }
        guard usages.count > 1 else { return first }
        func sum(_ field: (ModelCallUsage) -> Int?) -> Int? {
            let values = usages.compactMap(field)
            return values.isEmpty ? nil : values.reduce(0, +)
        }
        return ModelCallUsage(
            purpose: first.purpose,
            inputTokens: sum(\.inputTokens),
            outputTokens: sum(\.outputTokens),
            cacheReadTokens: sum(\.cacheReadTokens),
            cacheWriteTokens: sum(\.cacheWriteTokens),
            modelID: first.modelID
        )
    }

    /// Installs a compaction result and records it in the transcript.
    private func adopt(
        _ outcome: CompactionOutcome,
        requestedByUser: Bool,
        focus: String?
    ) async -> CompactionEvent {
        let before = conversation.count
        let trimmedFocus = focus?.trimmingCharacters(in: .whitespacesAndNewlines)
        let event = CompactionEvent(
            summary: outcome.result.summary,
            beforeMessageCount: before,
            afterMessageCount: outcome.result.messages.count,
            beforeTokens: contextTokens,
            requestedByUser: requestedByUser,
            summarySource: outcome.source,
            focus: trimmedFocus?.isEmpty == false ? trimmedFocus : nil,
            fallbackReason: outcome.fallbackReason,
            summaryInputTokens: outcome.usage?.inputTokens,
            summaryOutputTokens: outcome.usage?.outputTokens
        )
        // The history is rewritten here anyway, so this is when the images
        // the model has already answered become text. Any it has not seen
        // yet stay for the request that follows.
        conversation = ImageRetention.redactingAnswered(outcome.result.messages)
        modelTurnsSinceCompaction = 0
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
        if let message = malformedToolResults[call.id] {
            _ = try? await store.appendEvent(
                sessionID: sessionID,
                payload: .toolCompleted(
                    ToolCompletedEvent(
                        toolCallID: call.id,
                        status: .failed,
                        resultSummary: "Not run: its arguments were not valid JSON.",
                        durationSeconds: 0
                    )
                )
            )
            return ToolScheduler.ExecutionResult(
                callID: call.id,
                toolName: call.name,
                input: call.input,
                content: message,
                isError: true
            )
        }
        let result = await ToolScheduler.executeCall(
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
        if let halt = result.haltReason, hookHaltReason == nil {
            hookHaltReason = halt
        }
        return result
    }

    /// Asks the stop hooks whether the agent may finish. Returns the reason to
    /// keep working, or nil to stop.
    private func stopHookFeedback(lastMessage: String, continuations: Int) async -> String? {
        guard let lifecycleHooks else { return nil }
        guard continuations < Self.maximumStopHookContinuations else {
            await ToolScheduler.record(
                [
                    HookActivityEvent(
                        hookEvent: "Stop",
                        hookName: "",
                        outcome: .stopped,
                        message: "Stop hooks sent Juno back to work \(continuations) times in one run, so it stopped here."
                    ),
                ],
                sessionID: sessionID,
                store: store
            )
            return nil
        }
        let response = await lifecycleHooks.agentStopping(
            sessionID: sessionID,
            stopHookActive: continuations > 0,
            lastMessage: lastMessage
        )
        await ToolScheduler.record(response.notices, sessionID: sessionID, store: store)
        // `"continue": false` outranks a block here too: the agent was
        // stopping anyway, and that is what it was told to do.
        guard response.haltReason == nil else { return nil }
        return response.blockReason
    }

    private func finish(
        status: SessionStatus,
        summary: String,
        filesChanged: Int,
        testsPassed: Bool?,
        startedAt: Date
    ) async {
        // Images stay in the in-memory history across runs, as sent, so the
        // next prompt in this session reads the same prefix from the cache;
        // the store keeps only their text. See ``ImageRetention``.
        conversation = ConversationIntegrity.repaired(conversation)
        await saveUsage()
        emitLiveText("", force: true)
        emitLiveReasoning("", force: true)
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
