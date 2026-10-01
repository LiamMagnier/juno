import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// The events the full hooks protocol added (CODE_AGENT_SPEC §5.9), through
/// Juno Code's adapter: the seams commit's four hook points, todos, sub-agents,
/// approvals, files, and the app's own signals.
final class WorkspaceAgentHookEventsTests: XCTestCase {
    private let sessionID = CodeSessionID()

    private func hook(_ event: HookLifecycleEvent, _ command: String, matcher: String? = nil) -> HookDefinition {
        HookDefinition(
            event: event,
            matcher: HookMatcher(pattern: matcher),
            command: command,
            source: .claude,
            path: ".claude/settings.json"
        )
    }

    private func adapter(
        _ hooks: [HookDefinition],
        shell: EventShell,
        ledger: HookSessionLedger = HookSessionLedger(),
        evaluator: (any HookPromptEvaluating)? = nil,
        instructionFiles: @escaping @Sendable () async -> [String] = { [] },
        record: @escaping @Sendable (CodeSessionID, [HookActivityEvent]) async -> Void = { _, _ in }
    ) -> WorkspaceAgentHooks {
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        return WorkspaceAgentHooks(
            definitions: hooks,
            executor: shell,
            permissions: permissions,
            policy: HookExecutionPolicy(allowedHookIDs: Set(hooks.map(\.id)), allowUntrustedHooks: true),
            projectDirectory: "/work/app",
            ledger: ledger,
            currentPermissionMode: { await permissions.permissionMode },
            recordActivity: record,
            promptEvaluator: evaluator,
            instructionFiles: instructionFiles
        )
    }

    // MARK: - The seams commit's points

    func testCompactionHooksHearTheTriggerAndTheFocus() async {
        let shell = EventShell()
        let hooks = adapter([hook(.preCompact, "echo pre", matcher: "manual"), hook(.postCompact, "echo post")], shell: shell)
        _ = await hooks.compactionStarting(sessionID: sessionID, trigger: .manual, focus: "the API")
        _ = await hooks.compactionStarting(sessionID: sessionID, trigger: .auto, focus: nil)
        _ = await hooks.compactionFinished(
            sessionID: sessionID,
            trigger: .auto,
            event: CompactionEvent(summary: "Kept the API decisions.", beforeMessageCount: 40, afterMessageCount: 6, summarySource: .model)
        )
        XCTAssertEqual(shell.calls.count, 2, "the manual-only PreCompact matcher skipped the auto fold")
        XCTAssertEqual(shell.calls[0].payload["trigger"]?.stringValue, "manual")
        XCTAssertEqual(shell.calls[0].payload["custom_instructions"]?.stringValue, "the API")
        XCTAssertEqual(shell.calls[1].payload["hook_event_name"]?.stringValue, "PostCompact")
        XCTAssertEqual(shell.calls[1].payload["compact_summary"]?.stringValue, "Kept the API decisions.")
        XCTAssertEqual(shell.calls[1].payload["messages_after"]?.numberValue, 6)
    }

    func testBatchAndFailureHooks() async {
        let shell = EventShell { command in
            command.contains("batch") ? (0, #"{"continue": false, "stopReason": "Batch budget spent."}"#, "") : (2, "", "Read the error before retrying.")
        }
        let hooks = adapter([hook(.postToolBatch, "echo batch"), hook(.postToolUseFailure, "echo failure", matcher: "Bash")], shell: shell)
        let batch = await hooks.toolBatchFinished(sessionID: sessionID, results: [
            AgentToolBatchResult(toolCallID: "c1", toolName: "run_command", succeeded: false),
            AgentToolBatchResult(toolCallID: "c2", toolName: "read_file", succeeded: true),
        ])
        XCTAssertEqual(batch.haltReason, "Batch budget spent.")
        let calls = shell.calls[0].payload["tool_calls"]?.arrayValue
        XCTAssertEqual(calls?.first?["tool_name"]?.stringValue, "Bash")
        XCTAssertEqual(calls?.last?["succeeded"]?.boolValue, true)

        let failure = await hooks.toolFailed(
            AgentToolHookInvocation(sessionID: sessionID, toolCallID: "c1", toolName: "run_command", input: ["command": "npm test"]),
            error: "exit 1"
        )
        XCTAssertEqual(failure.blockReason, "Read the error before retrying.", "fed back with the result")
        XCTAssertEqual(shell.calls[1].payload["error"]?.stringValue, "exit 1")
    }

    // MARK: - Todos

    func testTaskHooksCanRefuseANewTodoOrMarkingOneDone() async {
        let shell = EventShell { command in
            command.contains("completed") ? (2, "", "Not until the tests pass.") : (0, "", "")
        }
        let ledger = HookSessionLedger()
        let hooks = adapter([hook(.taskCreated, "echo created"), hook(.taskCompleted, "echo completed")], shell: shell, ledger: ledger)
        let first: JSONValue = ["todos": [["id": "1", "content": "Fix the bug", "status": "in_progress"]]]
        let call = AgentToolHookInvocation(sessionID: sessionID, toolCallID: "t1", toolName: "todo_write", input: first)
        let created = await hooks.beforeTool(call)
        XCTAssertNil(created.blockReason)
        XCTAssertEqual(shell.calls.last?.payload["task_subject"]?.stringValue, "Fix the bug")
        _ = await hooks.afterTool(call, succeeded: true, content: "ok")

        let done: JSONValue = ["todos": [["id": "1", "content": "Fix the bug", "status": "completed"]]]
        let finishing = await hooks.beforeTool(
            AgentToolHookInvocation(sessionID: sessionID, toolCallID: "t2", toolName: "todo_write", input: done)
        )
        XCTAssertEqual(finishing.blockReason, "Not until the tests pass.")
        XCTAssertEqual(shell.calls.filter { $0.command.contains("created") }.count, 1, "an item already known is not created again")
    }

    // MARK: - Sub-agents, approvals, files

    func testSubagentHooksCarryTheAgent() async {
        let shell = EventShell { _ in (0, "Use the fixtures in tests/data.", "") }
        let hooks = adapter([hook(.subagentStart, "echo start", matcher: "reviewer"), hook(.subagentStop, "echo stop")], shell: shell)
        let start = await hooks.subagentStarted(sessionID: sessionID, agentID: "c1#0", agentType: "reviewer", task: "Review the diff")
        XCTAssertEqual(shell.calls.first?.payload["agent_type"]?.stringValue, "reviewer")
        XCTAssertEqual(shell.calls.first?.payload["prompt"]?.stringValue, "Review the diff")
        XCTAssertTrue(start.notices.isEmpty)
        let child = hooks.subagentHooks(executionRootPath: "/work/app/wt", agentID: "c1#0", agentType: "reviewer")
        _ = await child?.agentStopping(sessionID: sessionID, stopHookActive: false, lastMessage: "No findings.")
        let stop = shell.calls.last?.payload
        XCTAssertEqual(stop?["hook_event_name"]?.stringValue, "SubagentStop")
        XCTAssertEqual(stop?["agent_id"]?.stringValue, "c1#0")
        XCTAssertEqual(stop?["last_assistant_message"]?.stringValue, "No findings.")
        XCTAssertEqual(stop?["cwd"]?.stringValue, "/work/app/wt")
    }

    func testPermissionHooks() async {
        let shell = EventShell { command in
            command.contains("request")
                ? (0, #"{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "Ask in #infra first."}}}"#, "")
                : (0, "", "")
        }
        let recorded = Notices()
        let hooks = adapter(
            [hook(.permissionRequest, "echo request", matcher: "Bash"), hook(.permissionDenied, "echo denied")],
            shell: shell,
            record: { _, notices in await recorded.add(notices) }
        )
        let request = ApprovalRequest(
            sessionID: sessionID, actionDigest: "d", toolName: "run_command", summary: "npm install",
            risk: .critical, requestedAt: Date(), expiresAt: Date().addingTimeInterval(60)
        )
        let answer = await hooks.permissionRequested(request)
        XCTAssertEqual(answer.blockReason, "Ask in #infra first.")
        XCTAssertEqual(answer.notices.first?.outcome, .blocked)
        await hooks.permissionResolved(sessionID: sessionID, approvalID: request.id, decision: .denied)
        let denied = shell.calls.last?.payload
        XCTAssertEqual(denied?["hook_event_name"]?.stringValue, "PermissionDenied")
        XCTAssertEqual(denied?["tool_name"]?.stringValue, "Bash")
        XCTAssertEqual(denied?["summary"]?.stringValue, "npm install")
    }

    func testFileChangedFiresForTheAgentsOwnWrites() async {
        let shell = EventShell()
        let hooks = adapter([hook(.fileChanged, "echo changed", matcher: "\\.swift$")], shell: shell)
        _ = await hooks.afterTool(
            AgentToolHookInvocation(sessionID: sessionID, toolCallID: "w1", toolName: "write_file", input: ["path": "Sources/App.swift", "content": "x"]),
            succeeded: true,
            content: "Wrote."
        )
        _ = await hooks.afterTool(
            AgentToolHookInvocation(sessionID: sessionID, toolCallID: "w2", toolName: "write_file", input: ["path": "README.md", "content": "x"]),
            succeeded: true,
            content: "Wrote."
        )
        _ = await hooks.afterTool(
            AgentToolHookInvocation(sessionID: sessionID, toolCallID: "r1", toolName: "read_file", input: ["path": "Sources/App.swift"]),
            succeeded: true,
            content: "…"
        )
        XCTAssertEqual(shell.calls.count, 1, "only the Swift file matched, and reads change nothing")
        XCTAssertEqual(shell.calls[0].payload["file_path"]?.stringValue, "/work/app/Sources/App.swift")
    }

    func testInstructionsLoadedRunsWithTheSessionStart() async {
        let shell = EventShell()
        let hooks = adapter(
            [hook(.instructionsLoaded, "echo loaded")],
            shell: shell,
            instructionFiles: { ["AGENTS.md", "CLAUDE.md"] }
        )
        _ = await hooks.sessionStarted(sessionID: sessionID, source: .startup)
        XCTAssertEqual(shell.calls.first?.payload["file_paths"]?.arrayValue?.compactMap(\.stringValue), ["AGENTS.md", "CLAUDE.md"])
        XCTAssertEqual(shell.calls.first?.payload["load_reason"]?.stringValue, "session_start")
    }

    // MARK: - The app's signals

    func testModelSwitchConfigAndGoalSignals() async {
        let shell = EventShell { command in
            command.contains("pre-model") ? (2, "", "Stay on the reviewed model.") : (0, "", "")
        }
        let hooks = adapter(
            [
                hook(.preModelSwitch, "echo pre-model"), hook(.postModelSwitch, "echo post-model"),
                hook(.configChange, "echo config", matcher: "project_settings"), hook(.goalSet, "echo goal"),
                hook(.goalVerdict, "echo verdict"), hook(.worktreeCreate, "echo wt"),
            ],
            shell: shell
        )
        let pre = await hooks.modelSwitching(sessionID: sessionID, from: "a", to: "b")
        XCTAssertEqual(pre.blockReason, "Stay on the reviewed model.")
        _ = await hooks.modelSwitched(sessionID: sessionID, from: "a", to: "b")
        XCTAssertEqual(shell.calls[1].payload["to_model"]?.stringValue, "b")
        _ = await hooks.configChanging(sessionID: sessionID, source: "user_settings", filePath: "~/.juno/settings.json")
        _ = await hooks.configChanging(sessionID: sessionID, source: "project_settings", filePath: ".juno/settings.json")
        XCTAssertEqual(shell.calls.filter { $0.command == "echo config" }.count, 1, "the matcher reads the source")
        _ = await hooks.goalSet(sessionID: sessionID, objective: "Ship it", criteria: ["tests pass"])
        XCTAssertEqual(shell.calls.last?.payload["goal"]?["objective"]?.stringValue, "Ship it")
        _ = await hooks.goalVerdict(sessionID: sessionID, verdict: "not_met", reason: "c1 open", unmetCriteria: ["c1"])
        XCTAssertEqual(shell.calls.last?.payload["unmet_criteria"]?.arrayValue?.first?.stringValue, "c1")
        _ = await hooks.worktreeChanged(sessionID: sessionID, created: true, path: "/wt/a", branch: "juno/a")
        XCTAssertEqual(shell.calls.last?.payload["branch"]?.stringValue, "juno/a")
    }

    // MARK: - A prompt hook through a model

    func testAPromptStopHookThroughAScriptedModelKeepsTheAgentWorking() async throws {
        let model = AnsweringModel(answer: #"{"ok": false, "reason": "You said you would add a test."}"#)
        let evaluator = ModelHookPromptEvaluator(client: model, sessionID: sessionID, defaultModelID: { "test-model" })
        let prompt = HookDefinition(
            event: .stop, command: "Is the work finished? $ARGUMENTS", timeoutSeconds: 30, source: .claude,
            path: ".claude/settings.json", kind: .prompt
        )
        let hooks = adapter([prompt], shell: EventShell(), evaluator: evaluator)
        let answer = await hooks.agentStopping(sessionID: sessionID, stopHookActive: false, lastMessage: "Done, I'll add a test later.")
        XCTAssertEqual(answer.blockReason, "You said you would add a test.")
        XCTAssertEqual(answer.notices.first?.outcome, .continued)
        let request = try XCTUnwrap(model.requests.first)
        XCTAssertTrue(request.tools.isEmpty, "a prompt hook's model gets no tools")
        XCTAssertEqual(request.maximumOutputTokens, ModelHookPromptEvaluator.maximumOutputTokens)
        XCTAssertEqual(request.modelID, "test-model")
    }
}

// MARK: - Doubles

private final class EventShell: HookCommandExecuting, @unchecked Sendable {
    struct Call {
        let command: String
        let payload: JSONValue
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
        environment _: [String: String],
        timeoutSeconds _: Double,
        outputLimit _: OutputLimit
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        let payload = (try? JSONDecoder().decode(JSONValue.self, from: standardInput)) ?? .null
        lock.withLock { recorded.append(Call(command: commandLine, payload: payload)) }
        let (code, stdout, stderr) = answer(commandLine)
        return (
            CommandResult(exitCode: code, wasTimeout: false, wasCancelled: false, wasTruncated: false, durationSeconds: 0),
            stdout,
            stderr
        )
    }
}

private actor Notices {
    private(set) var all: [HookActivityEvent] = []
    func add(_ notices: [HookActivityEvent]) { all += notices }
}

private final class AnsweringModel: AgentModelClient, @unchecked Sendable {
    private let answer: String
    private let lock = NSLock()
    private var storage: [ModelTurnRequest] = []

    init(answer: String) {
        self.answer = answer
    }

    var requests: [ModelTurnRequest] { lock.withLock { storage } }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.withLock { storage.append(request) }
        let answer = self.answer
        return AsyncThrowingStream { continuation in
            continuation.yield(.textDelta(answer))
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}
