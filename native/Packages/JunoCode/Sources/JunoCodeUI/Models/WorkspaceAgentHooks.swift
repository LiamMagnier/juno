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
        didRun: @escaping @Sendable (String) -> Void = { _ in }
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
            didRun: didRun
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
        didRun: @escaping @Sendable (String) -> Void
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
        return response(outcome)
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
        // Each file of a multi-file patch meets PreToolUse as an Edit of its
        // own. As one call, a guard reading `tool_input.file_path` judged the
        // first file and let the patch change the others unexamined. The
        // first file a hook blocks stops the patch; a hook's allow skips the
        // prompt only when every file got one.
        let files = HookToolNames.patchFiles(toolName: invocation.toolName, input: invocation.input)
        guard files.count > 1, var fields = invocation.input.objectValue else {
            return await beforeOneTool(invocation, input: invocation.input)
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
        return response(outcome, toolCallID: invocation.toolCallID)
    }

    func agentStopping(
        sessionID: CodeSessionID,
        stopHookActive: Bool,
        lastMessage _: String
    ) async -> AgentHookResponse {
        let event: HookLifecycleEvent = role == .session ? .stop : .subagentStop
        let outcome = await run(event, sessionID: sessionID) { base in
            base.with(stopHookActive: stopHookActive)
        }
        return response(outcome)
    }

    func sessionStopped(sessionID: CodeSessionID, status: SessionStatus) async {
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
                message: "Juno is waiting for your input"
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
            didRun: didRun
        )
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
                permissionMode: mode
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
            projectDirectory: projectDirectory
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
            case .postToolUse: notices.append(notice(block, .feedback))
            case .stop, .subagentStop: notices.append(notice(block, .continued))
            default: notices.append(notice(block, .blocked))
            }
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
        notificationType: String? = nil
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
            notificationType: notificationType ?? self.notificationType
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
