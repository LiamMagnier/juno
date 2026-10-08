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

/// Answers every turn at once and remembers what it was sent. Told to, it
/// holds the first turn open until released, so that run stays active.
private final class RecordingModel: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [ModelTurnRequest] = []
    private var holdingFirstTurn: Bool

    init(holdingFirstTurn: Bool = false) {
        self.holdingFirstTurn = holdingFirstTurn
    }

    var requests: [ModelTurnRequest] { lock.withLock { storage } }
    private var isHolding: Bool { lock.withLock { holdingFirstTurn } }

    func releaseFirstTurn() {
        lock.withLock { holdingFirstTurn = false }
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        let held = lock.withLock { () -> Bool in
            storage.append(request)
            return storage.count == 1 && holdingFirstTurn
        }
        return AsyncThrowingStream { continuation in
            guard held else {
                continuation.yield(.textDelta("Done."))
                continuation.yield(.turnCompleted(.endTurn))
                continuation.finish()
                return
            }
            let answer = Task {
                while self.isHolding, !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(5))
                }
                // Stopped rather than released: the run has gone.
                guard !Task.isCancelled else { return }
                continuation.yield(.textDelta("Done."))
                continuation.yield(.turnCompleted(.endTurn))
                continuation.finish()
            }
            continuation.onTermination = { _ in answer.cancel() }
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
            .notify(sessionID: sessionID, kind: .permissionPrompt, message: "Alevr needs you")
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

    func testEachFileOfAPatchMeetsTheEditGuardOnItsOwn() async {
        let patch = """
            *** Begin Patch
            *** Update File: src/app.swift
            @@
            -a
            +b
            *** Add File: .env
            +TOKEN=x
            *** End Patch
            """
        let invocation = AgentToolHookInvocation(
            sessionID: sessionID, toolCallID: "call-2", toolName: "apply_patch", input: ["patch": .string(patch)]
        )
        let allowing = HookShell { _ in (0, #"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#, "") }
        let allowed = await adapter([hook(.preToolUse, "guard.sh", matcher: "Edit")], shell: allowing).beforeTool(invocation)
        XCTAssertEqual(
            allowing.calls.map { $0.payload["tool_input"]?["file_path"]?.stringValue },
            ["/work/app/src/app.swift", "/work/app/.env"],
            "a guard reading file_path sees every file, not just the first"
        )
        XCTAssertEqual(allowing.calls.first?.payload["tool_name"]?.stringValue, "Edit")
        XCTAssertEqual(allowing.calls.first?.payload["tool_input"]?["file_paths"]?.arrayValue?.count, 2)
        XCTAssertEqual(allowed.permission, .allow, "allowed file by file")

        let blocking = HookShell { _ in (2, "", "No edits to secrets.\n") }
        let blocked = await adapter([hook(.preToolUse, "guard.sh", matcher: "Edit")], shell: blocking).beforeTool(invocation)
        XCTAssertEqual(blocked.blockReason, "No edits to secrets.")
        XCTAssertEqual(blocking.calls.count, 1, "the first block stops the patch")

        // One file: the envelope's file is the Edit's file_path.
        let single = HookShell()
        _ = await adapter([hook(.preToolUse, "guard.sh", matcher: "Edit")], shell: single).beforeTool(
            AgentToolHookInvocation(
                sessionID: sessionID,
                toolName: "apply_patch",
                input: ["patch": "*** Begin Patch\n*** Delete File: .env\n*** End Patch"]
            )
        )
        XCTAssertEqual(single.calls.map { $0.payload["tool_input"]?["file_path"]?.stringValue }, ["/work/app/.env"])
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

    // Async, so it runs on the main actor with the rest of the @MainActor
    // case; a synchronous override is nonisolated and cannot read `root`.
    override func tearDown() async throws {
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

    /// A session in a cloned repository whose `UserPromptSubmit` hook is
    /// `command`, allowed by the reader, in `mode`.
    private func hookedSession(
        _ command: String,
        mode: PermissionMode,
        model: RecordingModel = RecordingModel()
    ) async throws -> (SessionController, CodeSessionStore, RecordingModel) {
        let project = root.appendingPathComponent("repo")
        let settings = JSONValue.object([
            "hooks": .object([
                "UserPromptSubmit": .array([
                    .object(["hooks": .array([.object(["type": "command", "command": .string(command)])])]),
                ]),
            ]),
        ])
        try settings.canonicalJSONString()
            .write(to: project.appendingPathComponent(".claude/settings.json"), atomically: true, encoding: .utf8)
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
            title: "Remote",
            configuration: AgentConfiguration(modelID: "test-model", permissionMode: mode),
            gitBranch: nil
        )
        let controller = SessionController(session: session, context: context, store: store, modelClient: model)
        await controller.attach()
        return (controller, store, model)
    }

    /// The relay runs one command at a time, and the answer to a hook's
    /// approval is itself a command. A prompt from the phone is therefore
    /// taken — and its command answered — before its hooks decide, or the
    /// phone's Approve and Stop wait behind it until someone at the Mac
    /// answers. The session stays held while the hook waits: a rewind, or
    /// a second prompt, is refused.
    func testAPromptFromThePhoneIsTakenBeforeItsHookAsks() async throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable on this machine")
        let (controller, store, model) = try await hookedSession("echo from-the-hook", mode: .workspaceWrite)
        try await controller.deliverRemotePrompt("first")
        await controller.awaitRemoteHandover()
        try await waitForIdle(store, controller.sessionID)
        let first = try XCTUnwrap(controller.rewindTurns.first)

        await controller.setHooksEnabled(true)
        let delivery = try await controller.deliverRemotePrompt("from the phone")
        XCTAssertFalse(delivery.isSettled, "the hook has not been answered yet")
        let pending = try await waitForApproval(controller)
        let request = try XCTUnwrap(pending, "the hook must ask first")
        XCTAssertEqual(request.toolName, "hook")
        XCTAssertTrue(controller.isRunning, "the session reads as taken while the hook waits")

        // Held against everything that would start or cut a run meanwhile.
        let rewound = await controller.rewind(to: first.id, restoring: .conversation)
        XCTAssertEqual(rewound, .failed(message: RewindCopy.running))
        do {
            try await controller.deliverRemotePrompt("and another")
            XCTFail("a second prompt was taken while the first one's hook decided")
        } catch let refusal as SessionController.RemotePromptRefusal {
            XCTAssertEqual(refusal.message, "The agent is already running in this session.")
        }

        // The phone's answer, as the next command would carry it.
        await controller.approve(request.id)
        let refusal = await delivery.outcome()
        XCTAssertNil(refusal)
        try await waitForIdle(store, controller.sessionID)
        XCTAssertTrue(lastPrompt(model).contains("from-the-hook"))
        let prompts = await store.events(for: controller.sessionID).compactMap { event -> String? in
            if case let .userPrompt(prompt) = event.payload { return prompt.text }
            return nil
        }
        XCTAssertEqual(prompts, ["first", "from the phone"])
    }

    /// A prompt a hook turns away after the session took it says so on its
    /// delivery, which is how a queued task knows its turn never started.
    func testAPromptFromThePhoneAHookBlocksSaysSoOnItsDelivery() async throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable on this machine")
        let (controller, store, model) = try await hookedSession(
            "echo 'no prompts from phones' >&2; exit 2",
            mode: .fullAccess
        )
        await controller.setHooksEnabled(true)

        var refusal: SessionController.RemotePromptRefusal?
        do {
            let delivery = try await controller.deliverRemotePrompt("from the phone")
            refusal = await delivery.outcome()
        } catch let turnedAway as SessionController.RemotePromptRefusal {
            // The hook can finish before the wait for the handover does.
            refusal = turnedAway
        }
        XCTAssertEqual(refusal?.message, "A hook on the Mac stopped this message: no prompts from phones")
        await controller.awaitRemoteHandover()
        XCTAssertFalse(controller.isSubmitting)
        XCTAssertTrue(model.requests.isEmpty)
        let status = try await store.session(id: controller.sessionID).status
        XCTAssertFalse(status.isTerminal, "a blocked new session stays idle, which is why the delivery says so")
    }

    /// The phone's Stop while its steer's hook runs stops the steer too. The
    /// relay answers a steer once the run takes it, before its hooks decide,
    /// so that Stop is often the very next command it claims. It used to
    /// reach the run alone: the hook ran on in the handover, and once the
    /// stopped run had ended the steer started a turn of its own.
    func testThePhonesStopWhileItsSteersHookRunsStopsTheSteer() async throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable on this machine")
        let (controller, store, model, gate) = try await runHeldOpen()

        let delivery = try await controller.deliverRemotePrompt("Also fix the tests", as: .steer)
        XCTAssertFalse(delivery.isSettled, "the hook is still deciding")
        await controller.stop()
        // Opened after the Stop, as a hook that took its time would finish.
        try Data().write(to: gate)

        let refusal = await delivery.outcome()
        XCTAssertEqual(refusal?.message, "The session was stopped on the Mac before this message was sent.")
        await controller.awaitRemoteHandover()
        await controller.awaitCurrentRun()
        XCTAssertFalse(controller.isSubmitting)
        XCTAssertEqual(model.requests.count, 1, "the steer started no turn of its own")
        let events = await store.events(for: controller.sessionID).map(\.payload)
        XCTAssertFalse(
            events.contains { if case .userInstruction = $0 { return true }; return false },
            "the steer was not recorded for a later run to apply"
        )
        XCTAssertEqual(prompts(in: events), ["Start"])
    }

    /// A steer whose run finishes on its own while the steer's hook decides
    /// still goes, as the next turn. The phone was told it had been taken,
    /// so turning it away then would lose it without a word.
    func testASteerFromThePhoneWhoseRunEndsWhileItsHookRunsStartsTheNextTurn() async throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable on this machine")
        let (controller, store, model, gate) = try await runHeldOpen()

        let delivery = try await controller.deliverRemotePrompt("Also fix the tests", as: .steer)
        model.releaseFirstTurn()
        await controller.awaitCurrentRun()
        XCTAssertFalse(delivery.isSettled, "the hook is still deciding")
        try Data().write(to: gate)

        let refusal = await delivery.outcome()
        XCTAssertNil(refusal)
        await controller.awaitRemoteHandover()
        await controller.awaitCurrentRun()
        XCTAssertEqual(model.requests.count, 2)
        XCTAssertTrue(lastPrompt(model).hasPrefix("Also fix the tests"))
        let events = await store.events(for: controller.sessionID).map(\.payload)
        XCTAssertFalse(events.contains { if case .userInstruction = $0 { return true }; return false })
        XCTAssertEqual(prompts(in: events), ["Start", "Also fix the tests"])
    }

    /// A session whose `UserPromptSubmit` hook waits until the returned gate
    /// file exists, with a run under way that its model holds open. The gate
    /// is open for the prompt that started the run and shut again after.
    private func runHeldOpen() async throws -> (SessionController, CodeSessionStore, RecordingModel, URL) {
        // Inside the project, which the hook's shell runs in: a path outside
        // it would make the command one that asks in every mode.
        let gate = root.appendingPathComponent("repo/hook-gate")
        let model = RecordingModel(holdingFirstTurn: true)
        let (controller, store, _) = try await hookedSession(
            "until [ -e hook-gate ]; do sleep 0.02; done",
            mode: .fullAccess,
            model: model
        )
        await controller.setHooksEnabled(true)
        try Data().write(to: gate)
        controller.composerText = "Start"
        await controller.send()
        for _ in 0..<400 where !controller.session.status.isActive || model.requests.isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(controller.session.status.isActive, "the run should be under way")
        try FileManager.default.removeItem(at: gate)
        return (controller, store, model, gate)
    }

    private func prompts(in events: [SessionEventPayload]) -> [String] {
        events.compactMap { payload -> String? in
            if case let .userPrompt(prompt) = payload { return prompt.text }
            return nil
        }
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
