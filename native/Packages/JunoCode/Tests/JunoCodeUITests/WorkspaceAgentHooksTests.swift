import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Stands in for the shell: records each hook's command, stdin and
/// environment, and answers as told.
private final class HookShell: HookCommandExecuting, @unchecked Sendable {
    struct Call {
        let command: String
        let payload: JSONValue
        let environment: [String: String]
    }

    let isContained = true
    private let lock = NSLock()
    private var recorded: [Call] = []
    private let answer: @Sendable (String) -> (Int32, String, String)

    init(answer: @escaping @Sendable (String) -> (Int32, String, String) = { _ in (0, "", "") }) {
        self.answer = answer
    }

    var calls: [Call] { lock.withLock { recorded } }

    func runHook(
        _ commandLine: String,
        standardInput: Data,
        environment: [String: String],
        timeoutSeconds _: Double,
        outputLimit _: OutputLimit
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        let payload = (try? JSONDecoder().decode(JSONValue.self, from: standardInput)) ?? .null
        lock.withLock {
            recorded.append(Call(command: commandLine, payload: payload, environment: environment))
        }
        let (code, stdout, stderr) = answer(commandLine)
        return (
            CommandResult(exitCode: code, wasTimeout: false, wasCancelled: false, wasTruncated: false, durationSeconds: 0),
            stdout,
            stderr
        )
    }
}

/// Answers every turn at once and remembers what it was sent.
private final class RecordingModel: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [ModelTurnRequest] = []

    var requests: [ModelTurnRequest] { lock.withLock { storage } }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.withLock { storage.append(request) }
        return AsyncThrowingStream { continuation in
            continuation.yield(.textDelta("Done."))
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}

final class WorkspaceAgentHooksTests: XCTestCase {
    private let sessionID = CodeSessionID()

    private func hook(
        _ event: HookLifecycleEvent,
        _ command: String,
        matcher: String? = nil,
        trust: ExtensibilityTrust = .untrustedWorkspace
    ) -> HookDefinition {
        HookDefinition(
            event: event,
            matcher: HookMatcher(pattern: matcher),
            command: command,
            source: .claude,
            path: ".claude/settings.json",
            trust: trust
        )
    }

    /// Full access by default, where an allowed repository hook runs without
    /// a prompt; the modes that ask are tested on their own.
    private func adapter(
        _ hooks: [HookDefinition],
        shell: HookShell,
        ledger: HookSessionLedger = HookSessionLedger(),
        policy: HookExecutionPolicy? = nil,
        permissions: PermissionCoordinator? = nil,
        idleDelay: Duration = .seconds(60),
        record: @escaping @Sendable (CodeSessionID, [HookActivityEvent]) async -> Void = { _, _ in }
    ) -> WorkspaceAgentHooks {
        let permissions = permissions ?? PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        return WorkspaceAgentHooks(
            definitions: hooks,
            executor: shell,
            permissions: permissions,
            policy: policy ?? HookExecutionPolicy(
                allowedHookIDs: Set(hooks.map(\.id)),
                allowUntrustedHooks: true
            ),
            projectDirectory: "/work/app",
            ledger: ledger,
            currentPermissionMode: { await permissions.permissionMode },
            transcriptPath: { "/store/\($0.value)/events.jsonl" },
            idleNotificationDelay: idleDelay,
            recordActivity: record
        )
    }

    func testSessionStartRunsOncePerSessionWhateverServesIt() async {
        let shell = HookShell { _ in (0, "Branch: main", "") }
        let ledger = HookSessionLedger()
        let hooks = [hook(.sessionStart, "echo start")]

        let first = await adapter(hooks, shell: shell, ledger: ledger)
            .sessionStarted(sessionID: sessionID, source: .startup)
        // A rebuilt orchestrator gets a new adapter over the same ledger.
        let second = await adapter(hooks, shell: shell, ledger: ledger)
            .sessionStarted(sessionID: sessionID, source: .resume)

        XCTAssertEqual(first.context, ["Branch: main"])
        XCTAssertEqual(second, .empty)
        XCTAssertEqual(shell.calls.count, 1)
        let payload = shell.calls[0].payload
        XCTAssertEqual(payload["source"]?.stringValue, "startup")
        XCTAssertEqual(payload["transcript_path"]?.stringValue, "/store/\(sessionID.value)/events.jsonl")
        XCTAssertEqual(payload["permission_mode"]?.stringValue, "bypassPermissions")
        XCTAssertEqual(shell.calls[0].environment["CLAUDE_PROJECT_DIR"], "/work/app")
    }

    func testAnAllowedRepositoryHookAsksBeforeEachRunWhereCommandsAsk() async throws {
        // Edit automatically: the agent may rewrite the script this entry runs
        // without asking, so running it must ask, as the command itself would.
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .workspaceWrite)
        nonisolated(unsafe) var asked: [ApprovalRequest] = []
        await permissions.addObserver { update in
            if case let .requested(request) = update {
                asked.append(request)
                Task { await permissions.resolve(approvalID: request.id, decision: .approved) }
            }
        }
        let shell = HookShell()
        let guardHook = hook(.preToolUse, "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard.sh")
        let hooks = adapter([guardHook], shell: shell, permissions: permissions)
        let call = AgentToolHookInvocation(sessionID: sessionID, toolName: "write_file", input: ["path": "a"])

        _ = await hooks.beforeTool(call)
        _ = await hooks.beforeTool(call)
        XCTAssertEqual(asked.count, 2, "allowing the entry is not approval of every run")
        XCTAssertEqual(shell.calls.count, 2)
        XCTAssertEqual(asked.first?.toolName, "hook")
        XCTAssertEqual(asked.first?.summary, guardHook.command)
        // "Always allow" saves the rule a `run_command` prompt would.
        XCTAssertEqual(
            asked.first?.suggestedRule,
            PermissionRule(tool: "Bash", specifier: "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard.sh *")
        )

        // With that rule, the reader has vouched for the command as they would
        // for the agent's own, and the hook runs without asking.
        await permissions.addAllowRule(try XCTUnwrap(asked.first?.suggestedRule))
        _ = await hooks.beforeTool(call)
        XCTAssertEqual(asked.count, 2)
        XCTAssertEqual(shell.calls.count, 3)

        // A declined prompt means the hook does not run, and the thread says so.
        let declining = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        await declining.addObserver { update in
            if case let .requested(request) = update {
                Task { await declining.resolve(approvalID: request.id, decision: .denied) }
            }
        }
        let quiet = HookShell()
        let refused = await adapter([guardHook], shell: quiet, permissions: declining).beforeTool(call)
        XCTAssertTrue(quiet.calls.isEmpty)
        XCTAssertNil(refused.blockReason, "a hook that did not run blocks nothing")
        XCTAssertEqual(refused.notices.map(\.outcome), [.failed])
    }

    func testTheReadersOwnHooksNeverAsk() async {
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        nonisolated(unsafe) var asked = 0
        await permissions.addObserver { update in
            if case .requested = update { asked += 1 }
        }
        let shell = HookShell()
        // One inside the project, one outside it: the reader wrote both lines.
        let mine = [
            hook(.notification, "echo notified", trust: .readerConfiguration),
            hook(.notification, "cat /etc/hosts", trust: .readerConfiguration),
        ]
        _ = await adapter(mine, shell: shell, permissions: permissions)
            .notify(sessionID: sessionID, kind: .permissionPrompt, message: "Juno needs you")
        XCTAssertEqual(asked, 0)
        XCTAssertEqual(Set(shell.calls.map(\.command)), ["echo notified", "cat /etc/hosts"])
    }

    func testABlockingPreToolUseHookBecomesADecisionAndANotice() async {
        let shell = HookShell { _ in (2, "", "Use `swift package clean`.\n") }
        let answer = await adapter([hook(.preToolUse, "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard.sh", matcher: "Bash")], shell: shell)
            .beforeTool(AgentToolHookInvocation(
                sessionID: sessionID,
                toolCallID: "call-1",
                toolName: "run_command",
                input: ["command": "rm -rf .build"]
            ))

        XCTAssertEqual(answer.blockReason, "Use `swift package clean`.")
        XCTAssertEqual(answer.notices, [
            HookActivityEvent(
                hookEvent: "PreToolUse",
                hookName: ".claude/hooks/guard.sh",
                outcome: .blocked,
                message: "Use `swift package clean`.",
                toolCallID: "call-1"
            ),
        ])
        XCTAssertEqual(shell.calls.first?.payload["tool_name"]?.stringValue, "Bash")
        XCTAssertEqual(shell.calls.first?.payload["tool_use_id"]?.stringValue, "call-1")
    }

    func testPermissionAnswersAndFailuresBecomeWhatTheRuntimeReads() async {
        let allowing = await adapter(
            [hook(.preToolUse, "echo allow")],
            shell: HookShell { _ in (0, #"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#, "") }
        ).beforeTool(AgentToolHookInvocation(sessionID: sessionID, toolName: "write_file", input: ["path": "a"]))
        XCTAssertEqual(allowing.permission, .allow)
        XCTAssertNil(allowing.blockReason)

        let failing = await adapter(
            [hook(.postToolUse, "echo lint")],
            shell: HookShell { _ in (1, "", "eslint: not found") }
        ).afterTool(
            AgentToolHookInvocation(sessionID: sessionID, toolName: "write_file", input: ["path": "a"]),
            succeeded: true,
            content: "ok"
        )
        XCTAssertNil(failing.blockReason, "a failing hook does not block")
        XCTAssertEqual(failing.notices.map(\.outcome), [.failed])
        XCTAssertTrue(failing.notices.first?.message.contains("eslint: not found") == true)
    }

    func testABlockedPromptNamesItsSubject() async {
        let answer = await adapter(
            [hook(.userPromptSubmit, "echo vet")],
            shell: HookShell { _ in (2, "", "Mention the ticket.") }
        ).promptSubmitted(sessionID: sessionID, prompt: "Refactor the store")
        XCTAssertEqual(answer.blockReason, "Mention the ticket.")
        XCTAssertEqual(answer.notices.first?.outcome, .blocked)
        XCTAssertEqual(answer.notices.first?.subject, "Refactor the store")
    }

    func testStopHooksKeepWorkingAndSubagentsRunSubagentStopInTheirWorktree() async throws {
        let shell = HookShell { _ in (2, "", "Run the tests.") }
        let hooks = [hook(.stop, "echo stop"), hook(.subagentStop, "echo sub"), hook(.userPromptSubmit, "echo prompt")]
        let session = adapter(hooks, shell: shell)

        let stop = await session.agentStopping(sessionID: sessionID, stopHookActive: true, lastMessage: "Done.")
        XCTAssertEqual(stop.blockReason, "Run the tests.")
        XCTAssertEqual(stop.notices.map(\.outcome), [.continued])
        XCTAssertEqual(shell.calls.last?.command, "echo stop")
        XCTAssertEqual(shell.calls.last?.payload["stop_hook_active"]?.boolValue, true)

        let child = try XCTUnwrap(session.subagentHooks(executionRootPath: "/work/app/.worktrees/fix"))
        _ = await child.agentStopping(sessionID: sessionID, stopHookActive: false, lastMessage: "")
        XCTAssertEqual(shell.calls.last?.command, "echo sub")
        XCTAssertEqual(shell.calls.last?.payload["hook_event_name"]?.stringValue, "SubagentStop")
        XCTAssertEqual(shell.calls.last?.payload["cwd"]?.stringValue, "/work/app/.worktrees/fix")
        XCTAssertEqual(shell.calls.last?.environment["CLAUDE_PROJECT_DIR"], "/work/app")

        // A sub-agent's prompt came from the parent model, not the reader.
        let before = shell.calls.count
        _ = await child.promptSubmitted(sessionID: sessionID, prompt: "Investigate")
        XCTAssertEqual(shell.calls.count, before)
        XCTAssertNil(child.subagentHooks(executionRootPath: nil), "no third level")
    }

    func testRepositoryHooksTheReaderHasNotAllowedNeverRun() async {
        let shell = HookShell()
        let answer = await adapter(
            [hook(.preToolUse, "echo guard")],
            shell: shell,
            policy: .denyAll
        ).beforeTool(AgentToolHookInvocation(sessionID: sessionID, toolName: "read_file", input: ["path": "a"]))
        XCTAssertTrue(shell.calls.isEmpty)
        XCTAssertNil(answer.blockReason)
    }

    func testIdleNotificationWaitsAndActivityCancelsIt() async throws {
        let shell = HookShell()
        let notification = [hook(.notification, "echo ping")]
        let idle = adapter(notification, shell: shell, idleDelay: .milliseconds(50))
        await idle.sessionStopped(sessionID: sessionID, status: .completed)
        for _ in 0..<40 where shell.calls.isEmpty {
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertEqual(shell.calls.first?.payload["notification_type"]?.stringValue, "idle_prompt")

        let busyShell = HookShell()
        let busy = adapter(notification + [hook(.userPromptSubmit, "echo vet")], shell: busyShell, idleDelay: .milliseconds(150))
        await busy.sessionStopped(sessionID: sessionID, status: .completed)
        _ = await busy.promptSubmitted(sessionID: sessionID, prompt: "next")
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(busyShell.calls.map(\.command), ["echo vet"], "the reader came back, so nothing is announced")

        let stoppedShell = HookShell()
        await adapter(notification, shell: stoppedShell, idleDelay: .milliseconds(10))
            .sessionStopped(sessionID: sessionID, status: .cancelled)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(stoppedShell.calls.isEmpty, "stopping a run is the reader acting")
    }

    func testSessionEndRunsOnceAndOnlyForASessionThatStarted() async {
        let shell = HookShell()
        let ledger = HookSessionLedger()
        let hooks = [hook(.sessionStart, "echo start"), hook(.sessionEnd, "echo end")]
        let adapter = adapter(hooks, shell: shell, ledger: ledger)

        await adapter.sessionEnded(sessionID: sessionID, reason: "logout")
        XCTAssertTrue(shell.calls.isEmpty, "a session that never started does not end")

        _ = await adapter.sessionStarted(sessionID: sessionID, source: .startup)
        await adapter.sessionEnded(sessionID: sessionID, reason: "logout")
        await adapter.sessionEnded(sessionID: sessionID, reason: "logout")
        XCTAssertEqual(shell.calls.map(\.command), ["echo start", "echo end"])
        XCTAssertEqual(shell.calls.last?.payload["reason"]?.stringValue, "logout")
    }
}

/// The whole path, with the real sandboxed shell: a freshly opened repository
/// declares a hook, and it does not run until the reader allows it.
@MainActor
final class SessionHookTrustTests: XCTestCase {
    private var root: URL!

    override func setUp() async throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-hook-trust-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("repo/.claude"),
            withIntermediateDirectories: true
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
    }

    func testAClonedRepositorysHooksWaitForTheReader() async throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable on this machine")
        let project = root.appendingPathComponent("repo")
        try """
        {"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "echo from-the-hook"}]}]}}
        """.write(to: project.appendingPathComponent(".claude/settings.json"), atomically: true, encoding: .utf8)

        let workspaceID = WorkspaceID()
        let context = WorkspaceContext(
            record: WorkspaceRecord(
                descriptor: WorkspaceDescriptor(
                    id: workspaceID,
                    displayName: "Cloned",
                    localPathHint: project.path,
                    isGitRepository: false,
                    lastOpenedAt: Date()
                ),
                bookmarkData: Data()
            ),
            access: try WorkspaceAccess(workspaceID: workspaceID, grantedURL: project),
            storageRoot: root.appendingPathComponent("storage"),
            userSettingsDirectory: nil
        )
        let store = CodeSessionStore(directoryURL: root.appendingPathComponent("sessions"))
        let session = try await store.createSession(
            workspaceID: workspaceID,
            workspaceName: "Cloned",
            title: "Trust",
            configuration: AgentConfiguration(modelID: "test-model", permissionMode: .workspaceWrite),
            gitBranch: nil
        )
        let model = RecordingModel()
        let controller = SessionController(session: session, context: context, store: store, modelClient: model)
        XCTAssertEqual(controller.hookDiscoveryResult.hooks.count, 1, "the hook is seen")
        XCTAssertFalse(controller.hooksAreEnabled, "and not allowed")

        controller.composerText = "first"
        await controller.send()
        try await waitForIdle(store, session.id)
        XCTAssertFalse(lastPrompt(model).contains("from-the-hook"), "an unallowed hook must not run")

        await controller.setHooksEnabled(true)
        XCTAssertTrue(controller.hooksAreEnabled)
        controller.composerText = "second"
        // Edit automatically asks before a command, so it asks before the
        // hook's: allowing the entry does not vouch for the script it runs.
        let sending = Task { await controller.send() }
        let pending = try await waitForApproval(controller)
        let request = try XCTUnwrap(pending, "the hook must ask first")
        XCTAssertEqual(request.toolName, "hook")
        XCTAssertTrue(controller.isSubmitting)
        XCTAssertTrue(controller.isRunning, "the session reads as working while the hook waits")
        // A second ↩ while the message's hook decides must not be a second run.
        await controller.send()
        await controller.approve(request.id)
        await sending.value
        try await waitForIdle(store, session.id)
        XCTAssertFalse(controller.isSubmitting)
        XCTAssertTrue(lastPrompt(model).contains("from-the-hook"), "an allowed hook's output is context")
        let prompts = await store.events(for: session.id).compactMap { event -> String? in
            if case let .userPrompt(prompt) = event.payload { return prompt.text }
            return nil
        }
        XCTAssertEqual(prompts, ["first", "second"])
        XCTAssertEqual(model.requests.count, 2)

        // Revoking is as immediate as allowing.
        await controller.setHooksEnabled(false)
        controller.composerText = "third"
        await controller.send()
        try await waitForIdle(store, session.id)
        XCTAssertFalse(lastPrompt(model).contains("from-the-hook"))
    }

    private func lastPrompt(_ model: RecordingModel) -> String {
        guard case let .user(text)? = model.requests.last?.messages.last else { return "" }
        return text
    }

    private func waitForApproval(_ controller: SessionController) async throws -> ApprovalRequest? {
        for _ in 0..<200 {
            if let request = await controller.live?.permissions.pendingApprovals.first {
                return request
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        return nil
    }

    private func waitForIdle(_ store: CodeSessionStore, _ id: CodeSessionID) async throws {
        for _ in 0..<200 {
            let status = try await store.session(id: id).status
            if !status.isActive { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("the run did not finish")
    }
}
