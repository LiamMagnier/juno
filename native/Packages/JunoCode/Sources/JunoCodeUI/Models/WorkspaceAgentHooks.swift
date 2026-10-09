import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

/// What one session's hooks remember across the orchestrators that serve it.
///
/// An orchestrator — and the hook adapter with it — is rebuilt whenever the
/// turn contract changes: a mode switch, another model, a hook allowed in
/// Settings. `SessionStart` and `SessionEnd` are about the session, not the
/// orchestrator, so the facts that decide them live here, owned by the
/// session controller for as long as the session is open.
actor HookSessionLedger {
    private var started = false
    private var ended = false
    private var generation = 0

    /// True exactly once: the first time the session starts.
    func beginSession() -> Bool {
        guard !started else { return false }
        started = true
        return true
    }

    /// True exactly once, and only for a session that started.
    func endSession() -> Bool {
        guard started, !ended else { return false }
        ended = true
        return true
    }

    /// Something happened. Returns a mark to compare with later.
    func touch() -> Int {
        generation += 1
        return generation
    }

    /// Whether nothing has happened since `mark` and the session is open.
    func isIdle(since mark: Int) -> Bool {
        generation == mark && !ended
    }

    // `TaskCreated` and `TaskCompleted` compare each `todo_write` list with
    // the last one that went through, so they fire for what changed.
    private var todoStatuses: [String: String] = [:]

    func todos() -> [String: String] { todoStatuses }

    func setTodos(_ statuses: [String: String]) {
        todoStatuses = statuses
    }

    // `PermissionDenied` names the tool the declined request was for, which
    // the resolution alone does not carry.
    private var approvals: [String: (toolName: String, summary: String)] = [:]

    func remember(approvalID: String, toolName: String, summary: String) {
        approvals[approvalID] = (toolName, summary)
    }

    func takeApproval(_ id: String) -> (toolName: String, summary: String)? {
        approvals.removeValue(forKey: id)
    }
}

/// Bridges the local Claude/Juno hook implementation to the provider-neutral
/// agent lifecycle.
///
/// The adapter runs only hooks the policy admits: the reader's own
/// `~/.juno/settings.json`, and repository hooks the reader allowed by ID in
/// private storage. Committing `.claude/settings.json` to a repository cannot
/// by itself execute code or alter a session.
struct WorkspaceAgentHooks: AgentLifecycleHooks, Sendable {
    enum Role: Sendable {
        case session
        /// A delegated sub-agent: tool hooks as usual, `SubagentStop` in
        /// place of `Stop`, and none of the session-level events, whose
        /// prompt came from the parent model rather than the reader.
        case subagent
    }

    private let definitions: [HookDefinition]
    private let executor: any HookCommandExecuting
    private let permissions: PermissionCoordinator
    private let policy: HookExecutionPolicy
    private let currentPermissionMode: @Sendable () async -> PermissionMode
    /// The project root, where the hooks' scripts live.
    private let projectDirectory: String
    /// Where the session works: the project, or a sub-agent's worktree.
    private let workingDirectory: String
    private let transcriptPath: @Sendable (CodeSessionID) -> String?
    private let ledger: HookSessionLedger
    private let role: Role
    /// How long a finished session sits unanswered before `Notification`
    /// hooks hear it is waiting — Claude Code's sixty seconds.
    private let idleNotificationDelay: Duration
    /// Writes notices that arrive after the run that caused them has ended:
    /// the idle notification's, and `SessionEnd`'s.
    private let recordActivity: @Sendable (CodeSessionID, [HookActivityEvent]) async -> Void
    /// Told each hook's identifier after it has run, so Settings can show
    /// "last ran 2 minutes ago" without the hook runner knowing about Settings.
    private let didRun: @Sendable (String) -> Void
    /// Sends `http` hooks' POSTs.
    private let poster: any HookHTTPPosting
    /// Answers `prompt` hooks with a small model; nil fails them, out loud.
    private let promptEvaluator: (any HookPromptEvaluating)?
    /// The instruction files a session starts with, for `InstructionsLoaded`.
    private let instructionFiles: @Sendable () async -> [String]
    /// For a sub-agent's hooks: which agent it is.
    private let agentID: String?
    private let agentType: String?

    init(
        definitions: [HookDefinition],
        executor: any HookCommandExecuting,
        permissions: PermissionCoordinator,
        policy: HookExecutionPolicy,
        projectDirectory: String,
        ledger: HookSessionLedger,
        currentPermissionMode: @escaping @Sendable () async -> PermissionMode,
        transcriptPath: @escaping @Sendable (CodeSessionID) -> String? = { _ in nil },
        idleNotificationDelay: Duration = .seconds(60),
        recordActivity: @escaping @Sendable (CodeSessionID, [HookActivityEvent]) async -> Void = { _, _ in },
        didRun: @escaping @Sendable (String) -> Void = { _ in },
        poster: any HookHTTPPosting = URLSessionHookPoster(),
        promptEvaluator: (any HookPromptEvaluating)? = nil,
        instructionFiles: @escaping @Sendable () async -> [String] = { [] }
    ) {
        self.init(
            definitions: definitions,
            executor: executor,
            permissions: permissions,
            policy: policy,
            currentPermissionMode: currentPermissionMode,
            projectDirectory: projectDirectory,
            workingDirectory: projectDirectory,
            transcriptPath: transcriptPath,
            ledger: ledger,
            role: .session,
            idleNotificationDelay: idleNotificationDelay,
            recordActivity: recordActivity,
            didRun: didRun,
            poster: poster,
            promptEvaluator: promptEvaluator,
            instructionFiles: instructionFiles,
            agentID: nil,
            agentType: nil
        )
    }

    private init(
        definitions: [HookDefinition],
        executor: any HookCommandExecuting,
        permissions: PermissionCoordinator,
        policy: HookExecutionPolicy,
        currentPermissionMode: @escaping @Sendable () async -> PermissionMode,
        projectDirectory: String,
        workingDirectory: String,
        transcriptPath: @escaping @Sendable (CodeSessionID) -> String?,
        ledger: HookSessionLedger,
        role: Role,
        idleNotificationDelay: Duration,
        recordActivity: @escaping @Sendable (CodeSessionID, [HookActivityEvent]) async -> Void,
        didRun: @escaping @Sendable (String) -> Void,
        poster: any HookHTTPPosting,
        promptEvaluator: (any HookPromptEvaluating)?,
        instructionFiles: @escaping @Sendable () async -> [String],
        agentID: String?,
        agentType: String?
    ) {
        self.definitions = definitions
        self.executor = executor
        self.permissions = permissions
        self.policy = policy
        self.currentPermissionMode = currentPermissionMode
        self.projectDirectory = projectDirectory
        self.workingDirectory = workingDirectory
        self.transcriptPath = transcriptPath
        self.ledger = ledger
        self.role = role
        self.idleNotificationDelay = idleNotificationDelay
        self.recordActivity = recordActivity
        self.didRun = didRun
        self.poster = poster
        self.promptEvaluator = promptEvaluator
        self.instructionFiles = instructionFiles
        self.agentID = agentID
        self.agentType = agentType
    }

    // MARK: - Lifecycle

    func sessionStarted(
        sessionID: CodeSessionID,
        source: AgentSessionStartSource
    ) async -> AgentHookResponse {
        guard role == .session, await ledger.beginSession() else { return .empty }
        let outcome = await run(.sessionStart, sessionID: sessionID) { base in
            base.with(source: source.rawValue)
        }
        var answer = response(outcome)
        // The project's instruction files enter the session with its start.
        if definitions.contains(where: { $0.event == .instructionsLoaded }) {
            let files = await instructionFiles()
            if !files.isEmpty {
                let loaded = await run(.instructionsLoaded, sessionID: sessionID) { base in
                    base.with(
                        fields: [
                            "file_paths": .array(files.map { .string($0) }),
                            "load_reason": "session_start",
                        ],
                        matcherSubject: "session_start"
                    )
                }
                answer.notices += response(loaded).notices
            }
        }
        return answer
    }

    func promptSubmitted(sessionID: CodeSessionID, prompt: String) async -> AgentHookResponse {
        guard role == .session else { return .empty }
        _ = await ledger.touch()
        let outcome = await run(.userPromptSubmit, sessionID: sessionID) { base in
            base.with(prompt: prompt)
        }
        return response(outcome, subject: prompt)
    }

    func beforeTool(_ invocation: AgentToolHookInvocation) async -> AgentHookResponse {
        var answer = await beforeToolProper(invocation)
        guard answer.blockReason == nil, answer.haltReason == nil, invocation.toolName == "todo_write" else {
            return answer
        }
        // A checklist change meets `TaskCreated` and `TaskCompleted` before it
        // is written: a hook may refuse a new item, or refuse to let one be
        // marked done ("not until the tests pass"). Checked against the list
        // as it would be written, the rewrite's if a hook changed it.
        let tasks = await taskHooks(sessionID: invocation.sessionID, input: answer.updatedInput ?? invocation.input)
        answer.notices += tasks.notices
        answer.context += tasks.context
        if let block = tasks.blockReason {
            answer.blockReason = block
            answer.updatedInput = nil
        }
        return answer
    }

    private func beforeToolProper(_ invocation: AgentToolHookInvocation) async -> AgentHookResponse {
        // Each file of a multi-file patch meets PreToolUse as an Edit of its
        // own. As one call, a guard reading `tool_input.file_path` judged the
        // first file and let the patch change the others unexamined. The
        // first file a hook blocks stops the patch; a hook's allow skips the
        // prompt only when every file got one.
        let files = HookToolNames.patchFiles(toolName: invocation.toolName, input: invocation.input)
        guard files.count > 1, var fields = invocation.input.objectValue else {
            var single = await beforeOneTool(invocation, input: invocation.input)
            single.updatedInput = single.blockReason == nil ? single.updatedInput : nil
            return single
        }
        var combined = AgentHookResponse.empty
        var permissions: [AgentHookPermission?] = []
        for file in files {
            fields["path"] = .string(file)
            let answer = await beforeOneTool(invocation, input: .object(fields))
            combined.notices += answer.notices
            combined.context += answer.context
            combined.haltReason = combined.haltReason ?? answer.haltReason
            if let block = answer.blockReason {
                combined.blockReason = block
                return combined
            }
            permissions.append(answer.permission)
        }
        if permissions.contains(.ask) {
            combined.permission = .ask
        } else if permissions.allSatisfy({ $0 == .allow }) {
            combined.permission = .allow
        }
        // A rewrite of one file's view of a multi-file patch is not a
        // rewrite of the patch, so none is applied.
        combined.updatedInput = nil
        return combined
    }

    /// `TaskCreated` for each new checklist item and `TaskCompleted` for each
    /// newly done one, in list order. The first block stops the change.
    private func taskHooks(sessionID: CodeSessionID, input: JSONValue) async -> AgentHookResponse {
        guard definitions.contains(where: { $0.event == .taskCreated || $0.event == .taskCompleted }),
              let items = input["todos"]?.arrayValue
        else { return .empty }
        let known = await ledger.todos()
        var combined = AgentHookResponse.empty
        for item in items {
            guard let id = item["id"]?.stringValue else { continue }
            let status = item["status"]?.stringValue ?? "pending"
            let fields: [String: JSONValue] = [
                "task_id": .string(id),
                "task_subject": .string(item["content"]?.stringValue ?? ""),
                "task_status": .string(status),
            ]
            var events: [HookLifecycleEvent] = []
            if known[id] == nil { events.append(.taskCreated) }
            if status == "completed", known[id] != "completed" { events.append(.taskCompleted) }
            for event in events {
                let outcome = await run(event, sessionID: sessionID) { base in base.with(fields: fields) }
                let answer = response(outcome)
                combined.notices += answer.notices
                combined.context += answer.context
                if let block = answer.blockReason {
                    combined.blockReason = block
                    return combined
                }
            }
        }
        return combined
    }

    private func beforeOneTool(_ invocation: AgentToolHookInvocation, input: JSONValue) async -> AgentHookResponse {
        let outcome = await run(.preToolUse, sessionID: invocation.sessionID) { base in
            base.with(
                toolName: invocation.toolName,
                toolUseID: invocation.toolCallID,
                toolInput: input
            )
        }
        var answer = response(outcome, toolCallID: invocation.toolCallID)
        if answer.blockReason == nil, let permission = outcome.permission {
            answer.permission = permission.decision == .ask ? .ask : .allow
        }
        answer.updatedInput = outcome.updatedInput
        return answer
    }

    func afterTool(
        _ invocation: AgentToolHookInvocation,
        succeeded: Bool,
        content: String
    ) async -> AgentHookResponse {
        let outcome = await run(.postToolUse, sessionID: invocation.sessionID) { base in
            base.with(
                toolName: invocation.toolName,
                toolUseID: invocation.toolCallID,
                toolInput: invocation.input,
                toolResult: HookToolResult(succeeded: succeeded, content: content)
            )
        }
        var answer = response(outcome, toolCallID: invocation.toolCallID)
        guard succeeded else { return answer }
        if invocation.toolName == "todo_write", let items = invocation.input["todos"]?.arrayValue {
            var statuses: [String: String] = [:]
            for item in items {
                if let id = item["id"]?.stringValue {
                    statuses[id] = item["status"]?.stringValue ?? "pending"
                }
            }
            await ledger.setTodos(statuses)
        }
        // `FileChanged` for each file the agent's own edit tools wrote. A
        // change a command made is not seen here; the command's tool call is.
        if Self.writingTools.contains(invocation.toolName),
           definitions.contains(where: { $0.event == .fileChanged })
        {
            for path in ToolTouchedPaths.paths(toolName: invocation.toolName, input: invocation.input) {
                let absolute = URL(fileURLWithPath: workingDirectory).appendingPathComponent(path.value).path
                let changed = await run(.fileChanged, sessionID: invocation.sessionID) { base in
                    base.with(
                        fields: [
                            "file_path": .string(absolute),
                            "event": .string(invocation.toolName == "delete_file" ? "unlink" : "change"),
                        ],
                        matcherSubject: path.lastComponent
                    )
                }
                answer.notices += response(changed, toolCallID: invocation.toolCallID).notices
            }
        }
        return answer
    }

    /// The tools that write files through Juno's own edit path.
    static let writingTools: Set<String> = [
        "write_file", "create_file", "apply_patch", "edit_file", "multi_edit", "delete_file", "move_file",
    ]

    func agentStopping(
        sessionID: CodeSessionID,
        stopHookActive: Bool,
        lastMessage: String
    ) async -> AgentHookResponse {
        let event: HookLifecycleEvent = role == .session ? .stop : .subagentStop
        let outcome = await run(event, sessionID: sessionID) { base in
            base.with(stopHookActive: stopHookActive, lastAssistantMessage: lastMessage)
        }
        return response(outcome)
    }

    func sessionStopped(sessionID: CodeSessionID, status: SessionStatus) async {
        // `StopFailure`: the run ended on an error the retries could not
        // clear. Told, never asked: the run is over.
        if status == .failed, definitions.contains(where: { $0.event == .stopFailure }) {
            let failed = await run(.stopFailure, sessionID: sessionID) { base in
                base.with(reason: "The run ended with an error.", matcherSubject: "error")
            }
            let notices = response(failed).notices
            if !notices.isEmpty {
                await recordActivity(sessionID, notices)
            }
        }
        // Stopping a run is the reader acting, so they are not waiting on
        // anything; every other ending leaves the session waiting on them.
        guard role == .session,
              status != .cancelled,
              definitions.contains(where: { $0.event == .notification })
        else { return }
        let mark = await ledger.touch()
        let hooks = self
        Task.detached {
            try? await Task.sleep(for: hooks.idleNotificationDelay)
            guard await hooks.ledger.isIdle(since: mark) else { return }
            let answer = await hooks.notify(
                sessionID: sessionID,
                kind: .idlePrompt,
                message: "Alevr is waiting for your input"
            )
            if !answer.notices.isEmpty {
                await hooks.recordActivity(sessionID, answer.notices)
            }
        }
    }

    func notify(
        sessionID: CodeSessionID,
        kind: AgentHookNotificationKind,
        message: String
    ) async -> AgentHookResponse {
        let outcome = await run(.notification, sessionID: sessionID) { base in
            base.with(message: message, notificationType: kind.rawValue)
        }
        return response(outcome)
    }

    func subagentHooks(executionRootPath: String?) -> (any AgentLifecycleHooks)? {
        subagent(executionRootPath: executionRootPath, agentID: nil, agentType: nil)
    }

    func subagentHooks(
        executionRootPath: String?,
        agentID: String,
        agentType: String
    ) -> (any AgentLifecycleHooks)? {
        subagent(executionRootPath: executionRootPath, agentID: agentID, agentType: agentType)
    }

    private func subagent(executionRootPath: String?, agentID: String?, agentType: String?) -> WorkspaceAgentHooks? {
        // A sub-agent cannot delegate further, so there is no third level.
        guard role == .session else { return nil }
        return WorkspaceAgentHooks(
            definitions: definitions,
            executor: executor,
            permissions: permissions,
            policy: policy,
            currentPermissionMode: currentPermissionMode,
            projectDirectory: projectDirectory,
            workingDirectory: executionRootPath ?? projectDirectory,
            transcriptPath: transcriptPath,
            ledger: ledger,
            role: .subagent,
            idleNotificationDelay: idleNotificationDelay,
            recordActivity: recordActivity,
            didRun: didRun,
            poster: poster,
            promptEvaluator: promptEvaluator,
            instructionFiles: instructionFiles,
            agentID: agentID,
            agentType: agentType
        )
    }

    func subagentStarted(
        sessionID: CodeSessionID,
        agentID: String,
        agentType: String,
        task: String
    ) async -> AgentHookResponse {
        guard role == .session else { return .empty }
        let outcome = await run(.subagentStart, sessionID: sessionID) { base in
            base.with(
                agentID: agentID,
                agentType: agentType,
                fields: ["prompt": .string(HookInvocationContext.bounded(task))]
            )
        }
        return response(outcome)
    }

    // MARK: - The seams commit's hook points (CODE_AGENT_SPEC §6.0)

    func compactionStarting(
        sessionID: CodeSessionID,
        trigger: AgentCompactionTrigger,
        focus: String?
    ) async -> AgentHookResponse {
        let outcome = await run(.preCompact, sessionID: sessionID) { base in
            base.with(
                fields: [
                    "trigger": .string(trigger.rawValue),
                    "custom_instructions": .string(focus ?? ""),
                ],
                matcherSubject: trigger.rawValue
            )
        }
        return response(outcome)
    }

    func compactionFinished(
        sessionID: CodeSessionID,
        trigger: AgentCompactionTrigger,
        event: CompactionEvent
    ) async -> AgentHookResponse {
        let outcome = await run(.postCompact, sessionID: sessionID) { base in
            base.with(
                fields: [
                    "trigger": .string(trigger.rawValue),
                    "custom_instructions": .string(event.focus ?? ""),
                    "compact_summary": .string(HookInvocationContext.bounded(event.summary)),
                    "messages_before": .number(Double(event.beforeMessageCount)),
                    "messages_after": .number(Double(event.afterMessageCount)),
                ],
                matcherSubject: trigger.rawValue
            )
        }
        return response(outcome)
    }

    func toolBatchFinished(
        sessionID: CodeSessionID,
        results: [AgentToolBatchResult]
    ) async -> AgentHookResponse {
        let outcome = await run(.postToolBatch, sessionID: sessionID) { base in
            base.with(fields: [
                "tool_calls": .array(results.map { result in
                    .object([
                        "tool_use_id": .string(result.toolCallID),
                        "tool_name": .string(HookToolNames.hookName(for: result.toolName)),
                        "succeeded": .bool(result.succeeded),
                    ])
                }),
            ])
        }
        return response(outcome)
    }

    func toolFailed(_ invocation: AgentToolHookInvocation, error: String) async -> AgentHookResponse {
        let outcome = await run(.postToolUseFailure, sessionID: invocation.sessionID) { base in
            base.with(
                toolName: invocation.toolName,
                toolUseID: invocation.toolCallID,
                toolInput: invocation.input,
                toolResult: HookToolResult(succeeded: false, content: error)
            )
        }
        return response(outcome, toolCallID: invocation.toolCallID)
    }

    // MARK: - Approvals

    func permissionRequested(_ request: ApprovalRequest) async -> AgentHookResponse {
        await ledger.remember(approvalID: request.id, toolName: request.toolName, summary: request.summary)
        guard definitions.contains(where: { $0.event == .permissionRequest }) else { return .empty }
        let outcome = await run(.permissionRequest, sessionID: request.sessionID) { base in
            base.with(
                toolName: request.toolName,
                fields: [
                    "approval_id": .string(request.id),
                    "summary": .string(request.summary),
                    "risk": .string(request.risk.rawValue),
                ]
            )
        }
        return response(outcome, subject: request.summary)
    }

    func permissionResolved(sessionID: CodeSessionID, approvalID: String, decision: ApprovalDecision) async {
        let asked = await ledger.takeApproval(approvalID)
        guard decision == .denied, let asked,
              definitions.contains(where: { $0.event == .permissionDenied })
        else { return }
        let outcome = await run(.permissionDenied, sessionID: sessionID) { base in
            base.with(
                toolName: asked.toolName,
                reason: "The request was declined.",
                fields: ["approval_id": .string(approvalID), "summary": .string(asked.summary)]
            )
        }
        let notices = response(outcome).notices
        if !notices.isEmpty {
            await recordActivity(sessionID, notices)
        }
    }

    // MARK: - Session signals from the app

    /// `ConfigChange`, before a settings change the reader made in the app
    /// takes effect. A block keeps the change from happening.
    func configChanging(sessionID: CodeSessionID, source: String, filePath: String?) async -> AgentHookResponse {
        let outcome = await run(.configChange, sessionID: sessionID) { base in
            var fields: [String: JSONValue] = ["source": .string(source)]
            if let filePath { fields["file_path"] = .string(filePath) }
            return base.with(fields: fields, matcherSubject: source)
        }
        return response(outcome)
    }

    /// `PreModelSwitch`: the reader is switching this session's model. A
    /// block keeps the current one.
    func modelSwitching(sessionID: CodeSessionID, from: String, to: String) async -> AgentHookResponse {
        let outcome = await run(.preModelSwitch, sessionID: sessionID) { base in
            base.with(fields: ["from_model": .string(from), "to_model": .string(to)])
        }
        return response(outcome)
    }

    /// `PostModelSwitch`, told.
    func modelSwitched(sessionID: CodeSessionID, from: String, to: String) async -> AgentHookResponse {
        let outcome = await run(.postModelSwitch, sessionID: sessionID) { base in
            base.with(fields: ["from_model": .string(from), "to_model": .string(to)])
        }
        return response(outcome)
    }

    /// `WorktreeCreate` and `WorktreeRemove`, told.
    func worktreeChanged(sessionID: CodeSessionID, created: Bool, path: String, branch: String?) async -> AgentHookResponse {
        let outcome = await run(created ? .worktreeCreate : .worktreeRemove, sessionID: sessionID) { base in
            var fields: [String: JSONValue] = ["worktree_path": .string(path)]
            if let branch { fields["branch"] = .string(branch) }
            return base.with(fields: fields)
        }
        return response(outcome)
    }

    /// `GoalSet`, told when a goal is set or replaced.
    func goalSet(sessionID: CodeSessionID, objective: String, criteria: [String]) async -> AgentHookResponse {
        let outcome = await run(.goalSet, sessionID: sessionID) { base in
            base.with(fields: [
                "goal": .object([
                    "objective": .string(objective),
                    "criteria": .array(criteria.map { .string($0) }),
                ]),
            ])
        }
        return response(outcome)
    }

    /// `GoalVerdict`, told after the goal loop judged the goal.
    func goalVerdict(
        sessionID: CodeSessionID,
        verdict: String,
        reason: String,
        unmetCriteria: [String]
    ) async -> AgentHookResponse {
        let outcome = await run(.goalVerdict, sessionID: sessionID) { base in
            base.with(fields: [
                "verdict": .string(verdict),
                "reason": .string(reason),
                "unmet_criteria": .array(unmetCriteria.map { .string($0) }),
            ])
        }
        return response(outcome)
    }

    /// `SessionEnd`, for a session whose start hooks ran. Called by the
    /// session controller when the session goes away — deleted, or the
    /// reader signed out — since no run is in flight to report it.
    func sessionEnded(sessionID: CodeSessionID, reason: String) async {
        guard role == .session, await ledger.endSession() else { return }
        let outcome = await run(.sessionEnd, sessionID: sessionID) { base in
            base.with(reason: reason)
        }
        let notices = response(outcome).notices
        if !notices.isEmpty {
            await recordActivity(sessionID, notices)
        }
    }

    // MARK: - Running

    private func run(
        _ event: HookLifecycleEvent,
        sessionID: CodeSessionID,
        _ configure: (HookInvocationContext) -> HookInvocationContext
    ) async -> HookEventOutcome {
        let active = definitions.filter { $0.event == event }
        guard !active.isEmpty else { return HookEventOutcome(event: event, results: []) }

        let mode = await currentPermissionMode()
        let context = configure(
            HookInvocationContext(
                event: event,
                sessionID: sessionID.value,
                transcriptPath: transcriptPath(sessionID),
                cwd: workingDirectory,
                permissionMode: mode,
                agentID: agentID,
                agentType: agentType
            )
        )
        let runner = HookRunner(
            executor: executor,
            policy: HookExecutionPolicy(
                allowedHookIDs: policy.allowedHookIDs,
                permissionMode: mode,
                allowUntrustedHooks: policy.allowUntrustedHooks
            ),
            approvalAuthorizer: HookPermissionAuthorizer(permissions: permissions),
            projectDirectory: projectDirectory,
            poster: poster,
            promptEvaluator: promptEvaluator
        )
        let outcome = await runner.run(hooks: active, context: context)
        for result in outcome.results {
            switch result.status {
            case .succeeded, .blocked, .failed:
                didRun(result.hookID)
            case .denied, .skipped:
                continue
            }
        }
        return outcome
    }

    /// What the runtime needs from an outcome: its decisions, and one notice
    /// for each thing the reader should see.
    private func response(
        _ outcome: HookEventOutcome,
        toolCallID: String? = nil,
        subject: String? = nil
    ) -> AgentHookResponse {
        let event = outcome.event
        func notice(_ verdict: HookVerdict, _ kind: HookActivityEvent.Outcome) -> HookActivityEvent {
            HookActivityEvent(
                hookEvent: event.rawValue,
                hookName: verdict.hookName,
                outcome: kind,
                message: verdict.reason,
                toolCallID: toolCallID,
                subject: subject
            )
        }
        var notices: [HookActivityEvent] = []
        let isStop = event == .stop || event == .subagentStop
        if let block = outcome.block, !(isStop && outcome.halt != nil) {
            switch event {
            case .postToolUse, .postToolUseFailure: notices.append(notice(block, .feedback))
            case .stop, .subagentStop: notices.append(notice(block, .continued))
            default: notices.append(notice(block, .blocked))
            }
        }
        if let changed = outcome.updatedInputBy {
            notices.append(notice(changed, .message))
        }
        if let halt = outcome.halt {
            notices.append(notice(halt, .stopped))
        }
        notices += outcome.errors.map { notice($0, .failed) }
        notices += outcome.messages.map { notice($0, .message) }
        return AgentHookResponse(
            blockReason: outcome.block?.reason,
            haltReason: outcome.halt?.reason,
            context: outcome.additionalContext,
            notices: notices
        )
    }
}

private extension HookInvocationContext {
    /// A copy with the event's own fields filled in.
    func with(
        toolName: String? = nil,
        toolUseID: String? = nil,
        toolInput: JSONValue? = nil,
        toolResult: HookToolResult? = nil,
        prompt: String? = nil,
        stopHookActive: Bool? = nil,
        source: String? = nil,
        reason: String? = nil,
        message: String? = nil,
        notificationType: String? = nil,
        lastAssistantMessage: String? = nil,
        agentID: String? = nil,
        agentType: String? = nil,
        fields: [String: JSONValue]? = nil,
        matcherSubject: String? = nil
    ) -> HookInvocationContext {
        HookInvocationContext(
            event: event,
            sessionID: sessionID,
            transcriptPath: transcriptPath,
            cwd: cwd,
            permissionMode: permissionMode,
            toolName: toolName ?? self.toolName,
            toolUseID: toolUseID ?? self.toolUseID,
            toolInput: toolInput ?? self.toolInput,
            toolResult: toolResult ?? self.toolResult,
            prompt: prompt ?? self.prompt,
            stopHookActive: stopHookActive ?? self.stopHookActive,
            source: source ?? self.source,
            reason: reason ?? self.reason,
            message: message ?? self.message,
            notificationType: notificationType ?? self.notificationType,
            lastAssistantMessage: lastAssistantMessage ?? self.lastAssistantMessage,
            agentID: agentID ?? self.agentID,
            agentType: agentType ?? self.agentType,
            fields: fields ?? self.fields,
            matcherSubject: matcherSubject ?? self.matcherSubject
        )
    }
}

/// Asks the reader before a repository hook runs, wherever the mode would ask
/// before the same command. The prompt shows the exact command, since that is
/// what is being approved.
///
/// The command is ruled as the shell command it is: the reader's `Bash`
/// rules apply to it (see `PermissionRule.families`), so "Always allow" on
/// this prompt saves the same rule a `run_command` prompt would, and a hook
/// the reader has vouched for that way runs without asking — with exactly
/// the trust that rule already gives the agent's own commands.
private struct HookPermissionAuthorizer: HookAuthorizing {
    let permissions: PermissionCoordinator

    func authorize(_ invocation: HookInvocation) async -> HookAuthorizationDecision {
        let digest = Digests.sha256Hex(
            JSONValue.object([
                "hook": .string(invocation.hook.id),
                "event": .string(invocation.context.event.rawValue),
                "command": .string(invocation.hook.command),
            ]).canonicalJSONString()
        )
        let outcome = await permissions.authorize(
            toolName: "hook",
            actionDigest: digest,
            risk: invocation.hook.risk,
            summary: invocation.hook.command,
            subject: .command(invocation.hook.command)
        )
        switch outcome {
        case .allowed, .approved:
            return .allowed
        case let .denied(reason):
            return .denied(reason: reason)
        }
    }
}
