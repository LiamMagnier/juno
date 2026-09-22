import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The contract a Claude Code hook relies on: what it reads on stdin, what
/// its exit code means for each event, and what its JSON answers do.
final class HookProtocolTests: XCTestCase {
    // MARK: - Standard input

    func testPayloadCarriesTheCommonFieldsForEveryEvent() {
        for event in HookLifecycleEvent.allCases {
            let payload = HookInvocationContext(
                event: event,
                sessionID: "s-1",
                transcriptPath: "/store/sessions/s-1/events.jsonl",
                cwd: "/work/app",
                permissionMode: .workspaceWrite
            ).payload(projectDirectory: "/work/app")
            XCTAssertEqual(payload["hook_event_name"]?.stringValue, event.rawValue)
            XCTAssertEqual(payload["session_id"]?.stringValue, "s-1")
            XCTAssertEqual(payload["transcript_path"]?.stringValue, "/store/sessions/s-1/events.jsonl")
            XCTAssertEqual(payload["cwd"]?.stringValue, "/work/app")
            XCTAssertEqual(payload["permission_mode"]?.stringValue, "acceptEdits")
        }
        // No transcript yet: the field is left out rather than invented.
        let fresh = HookInvocationContext(event: .sessionStart, source: "startup").payload(projectDirectory: "/w")
        XCTAssertNil(fresh["transcript_path"])
        XCTAssertEqual(fresh["cwd"]?.stringValue, "/w")
    }

    func testPayloadCarriesEachEventsOwnFields() {
        let pre = HookInvocationContext(
            event: .preToolUse,
            cwd: "/work/app",
            toolName: "apply_patch",
            toolUseID: "call-7",
            toolInput: ["path": "src/a.swift", "target": "let a = 1", "replacement": "let a = 2"]
        ).payload(projectDirectory: "/work/app")
        XCTAssertEqual(pre["tool_name"]?.stringValue, "Edit")
        XCTAssertEqual(pre["tool_use_id"]?.stringValue, "call-7")
        XCTAssertEqual(pre["tool_input"]?["file_path"]?.stringValue, "/work/app/src/a.swift")
        XCTAssertEqual(pre["tool_input"]?["old_string"]?.stringValue, "let a = 1")
        XCTAssertEqual(pre["tool_input"]?["new_string"]?.stringValue, "let a = 2")
        XCTAssertEqual(pre["tool_input"]?["path"]?.stringValue, "src/a.swift", "Juno's fields stay")
        XCTAssertNil(pre["tool_response"])

        let post = HookInvocationContext(
            event: .postToolUse,
            cwd: "/work/app",
            toolName: "write_file",
            toolInput: ["path": "README.md", "content": "hello"],
            toolResult: HookToolResult(succeeded: true, content: "Wrote 1 line.")
        ).payload(projectDirectory: "/work/app")
        XCTAssertEqual(post["tool_name"]?.stringValue, "Write")
        XCTAssertEqual(post["tool_input"]?["file_path"]?.stringValue, "/work/app/README.md")
        XCTAssertEqual(post["tool_input"]?["content"]?.stringValue, "hello")
        XCTAssertEqual(post["tool_response"]?["success"]?.boolValue, true)
        XCTAssertEqual(post["tool_response"]?["filePath"]?.stringValue, "/work/app/README.md")

        let prompt = HookInvocationContext(event: .userPromptSubmit, prompt: "fix the build")
            .payload(projectDirectory: nil)
        XCTAssertEqual(prompt["prompt"]?.stringValue, "fix the build")

        for event in [HookLifecycleEvent.stop, .subagentStop] {
            let stop = HookInvocationContext(event: event, stopHookActive: true).payload(projectDirectory: nil)
            XCTAssertEqual(stop["stop_hook_active"]?.boolValue, true)
        }
        let start = HookInvocationContext(event: .sessionStart, source: "resume").payload(projectDirectory: nil)
        XCTAssertEqual(start["source"]?.stringValue, "resume")
        let end = HookInvocationContext(event: .sessionEnd, reason: "logout").payload(projectDirectory: nil)
        XCTAssertEqual(end["reason"]?.stringValue, "logout")
        let notification = HookInvocationContext(
            event: .notification,
            message: "Juno needs your permission",
            notificationType: "permission_prompt"
        ).payload(projectDirectory: nil)
        XCTAssertEqual(notification["message"]?.stringValue, "Juno needs your permission")
        XCTAssertEqual(notification["notification_type"]?.stringValue, "permission_prompt")
    }

    func testToolNamesAndInputsMapToClaudeCodes() {
        let expected: [String: String] = [
            "run_command": "Bash", "run_tests": "Bash", "read_file": "Read",
            "write_file": "Write", "create_file": "Write", "apply_patch": "Edit",
            "edit_file": "Edit", "multi_edit": "MultiEdit", "glob": "Glob", "find_files": "Glob",
            "grep": "Grep", "list_directory": "LS", "web_fetch": "WebFetch",
            "web_search": "WebSearch", "delegate_task": "Task",
            "mcp__github__create_issue": "mcp__github__create_issue",
            "delete_file": "delete_file", "git_commit": "git_commit",
        ]
        for (juno, claude) in expected {
            XCTAssertEqual(HookToolNames.hookName(for: juno), claude, juno)
        }

        let bash = HookToolNames.hookInput(
            toolName: "run_command",
            input: ["command": "npm test", "timeout_seconds": 30],
            root: "/w"
        )
        XCTAssertEqual(bash["command"]?.stringValue, "npm test")
        XCTAssertEqual(bash["timeout"]?.numberValue, 30_000)

        let read = HookToolNames.hookInput(toolName: "read_file", input: ["path": "a/b.txt"], root: "/w")
        XCTAssertEqual(read["file_path"]?.stringValue, "/w/a/b.txt")

        let task = HookToolNames.hookInput(
            toolName: "delegate_task",
            input: ["task": "Survey the tests", "title": "Survey"],
            root: "/w"
        )
        XCTAssertEqual(task["prompt"]?.stringValue, "Survey the tests")
        XCTAssertEqual(task["description"]?.stringValue, "Survey")
    }

    // MARK: - Exit codes

    func testExitCodeTwoBlocksTheEventsThatCanBeBlocked() {
        for event in [HookLifecycleEvent.preToolUse, .postToolUse, .userPromptSubmit, .stop, .subagentStop] {
            let outcome = HookEventOutcome(
                event: event,
                results: [result(event, .blocked(reason: "Use the wrapper script."))]
            )
            XCTAssertEqual(outcome.block?.reason, "Use the wrapper script.", event.rawValue)
            XCTAssertTrue(outcome.errors.isEmpty, event.rawValue)
        }
        // Where nothing can be blocked, exit 2 is shown to the reader only.
        for event in [HookLifecycleEvent.sessionStart, .sessionEnd, .notification] {
            let outcome = HookEventOutcome(
                event: event,
                results: [result(event, .blocked(reason: "nope"))]
            )
            XCTAssertNil(outcome.block, event.rawValue)
            XCTAssertEqual(outcome.errors.map(\.reason), ["nope"], event.rawValue)
        }
    }

    func testOtherExitCodesAreNonBlockingErrorsForTheReader() {
        let outcome = HookEventOutcome(
            event: .preToolUse,
            results: [
                result(.preToolUse, .failed(exitCode: 1, reason: "The hook exited with status 1."), stderr: "jq: not found"),
                result(.preToolUse, .failed(exitCode: 15, reason: "The hook timed out after 1s.")),
            ]
        )
        XCTAssertNil(outcome.block)
        XCTAssertNil(outcome.halt)
        XCTAssertEqual(outcome.errors.count, 2)
        XCTAssertTrue(outcome.errors[0].reason.contains("jq: not found"))
        XCTAssertTrue(outcome.errors[1].reason.contains("timed out"))
    }

    func testPlainStdoutIsContextOnlyForPromptAndSessionStart() {
        for event in HookLifecycleEvent.allCases {
            let outcome = HookEventOutcome(
                event: event,
                results: [result(event, .succeeded(exitCode: 0), stdout: "Branch: main\n")]
            )
            let expected = event == .userPromptSubmit || event == .sessionStart
            XCTAssertEqual(outcome.additionalContext, expected ? ["Branch: main"] : [], event.rawValue)
        }
    }

    func testContextIsBoundedAsClaudeCodeBoundsIt() {
        let huge = String(repeating: "x", count: HookExecutionLimits.maximumContextCharacters * 2)
        let outcome = HookEventOutcome(
            event: .sessionStart,
            results: [
                result(.sessionStart, .succeeded(exitCode: 0), stdout: huge),
                result(.sessionStart, .succeeded(exitCode: 0), stdout: "more"),
            ]
        )
        XCTAssertEqual(outcome.additionalContext.count, 1)
        XCTAssertLessThanOrEqual(
            outcome.additionalContext[0].count,
            HookExecutionLimits.maximumContextCharacters
        )
    }

    // MARK: - JSON answers

    func testDecisionBlockAndContinueFalse() {
        let block = HookEventOutcome(
            event: .stop,
            results: [json(.stop, #"{"decision": "block", "reason": "Tests are still failing."}"#)]
        )
        XCTAssertEqual(block.block?.reason, "Tests are still failing.")

        let halt = HookEventOutcome(
            event: .postToolUse,
            results: [json(.postToolUse, #"{"continue": false, "stopReason": "Deploy freeze", "systemMessage": "Frozen"}"#)]
        )
        XCTAssertEqual(halt.halt?.reason, "Deploy freeze")
        XCTAssertEqual(halt.messages.map(\.reason), ["Frozen"])
    }

    func testPreToolUsePermissionDecisions() {
        let deny = HookEventOutcome(
            event: .preToolUse,
            results: [json(.preToolUse, """
            {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
             "permissionDecisionReason": "Secrets live in .env"}}
            """)]
        )
        XCTAssertEqual(deny.block?.reason, "Secrets live in .env")
        XCTAssertNil(deny.permission)

        let allow = HookEventOutcome(
            event: .preToolUse,
            results: [json(.preToolUse, """
            {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}
            """)]
        )
        XCTAssertNil(allow.block)
        XCTAssertEqual(allow.permission?.decision, .allow)

        // Ask outranks allow whichever hook said it first.
        let both = HookEventOutcome(
            event: .preToolUse,
            results: [
                json(.preToolUse, #"{"hookSpecificOutput": {"permissionDecision": "allow"}}"#),
                json(.preToolUse, #"{"hookSpecificOutput": {"permissionDecision": "ask", "permissionDecisionReason": "Production file"}}"#),
            ]
        )
        XCTAssertEqual(both.permission?.decision, .ask)
        XCTAssertEqual(both.permission?.verdict.reason, "Production file")

        // The older spellings.
        let approve = HookEventOutcome(
            event: .preToolUse,
            results: [json(.preToolUse, #"{"decision": "approve"}"#)]
        )
        XCTAssertEqual(approve.permission?.decision, .allow)
        let legacyBlock = HookEventOutcome(
            event: .preToolUse,
            results: [json(.preToolUse, #"{"decision": "block", "reason": "no"}"#)]
        )
        XCTAssertEqual(legacyBlock.block?.reason, "no")
    }

    func testEventSpecificOutputForAnotherEventIsIgnored() {
        let outcome = HookEventOutcome(
            event: .preToolUse,
            results: [json(.preToolUse, #"{"hookSpecificOutput": {"hookEventName": "PostToolUse", "permissionDecision": "deny"}}"#)]
        )
        XCTAssertNil(outcome.block)
    }

    func testAdditionalContextFromJSON() {
        let outcome = HookEventOutcome(
            event: .userPromptSubmit,
            results: [json(.userPromptSubmit, #"{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "Ticket JUNO-12"}}"#)]
        )
        XCTAssertEqual(outcome.additionalContext, ["Ticket JUNO-12"])
    }

    // MARK: - Real processes

    func testARealHookReadsItsEventFromStdinAndSeesTheProjectDirectory() async throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable on this machine")
        let root = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }
        let hook = makeHook(
            event: .preToolUse,
            command: "cat > \"$CLAUDE_PROJECT_DIR/stdin.json\"; printf %s \"$JUNO_PROJECT_DIR\" > project.txt"
        )
        let outcome = await runner(for: root, allowing: [hook]).run(
            hooks: [hook],
            context: HookInvocationContext(
                event: .preToolUse,
                sessionID: "s-9",
                cwd: root.path,
                toolName: "run_command",
                toolUseID: "call-9",
                toolInput: ["command": "git push"]
            )
        )
        XCTAssertTrue(outcome.results[0].succeeded, "\(outcome.results)")

        let data = try Data(contentsOf: root.appendingPathComponent("stdin.json"))
        let payload = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(payload["tool_name"]?.stringValue, "Bash")
        XCTAssertEqual(payload["tool_input"]?["command"]?.stringValue, "git push")
        XCTAssertEqual(payload["session_id"]?.stringValue, "s-9")
        let project = try String(contentsOf: root.appendingPathComponent("project.txt"), encoding: .utf8)
        XCTAssertEqual(project, root.path)
    }

    func testARealHookBlocksWithExitTwoAndDecidesWithJSON() async throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable on this machine")
        let root = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }

        let blocking = makeHook(
            event: .preToolUse,
            command: "grep -q 'rm -rf' && { echo 'rm -rf is not allowed here' >&2; exit 2; }; exit 0"
        )
        let context = HookInvocationContext(
            event: .preToolUse,
            cwd: root.path,
            toolName: "run_command",
            toolInput: ["command": "rm -rf build"]
        )
        let blocked = await runner(for: root, allowing: [blocking]).run(hooks: [blocking], context: context)
        XCTAssertEqual(blocked.block?.reason, "rm -rf is not allowed here")
        XCTAssertEqual(blocked.block?.hookID, blocking.id)

        let deciding = makeHook(
            event: .preToolUse,
            command: #"echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Check first"}}'"#
        )
        let asked = await runner(for: root, allowing: [deciding]).run(hooks: [deciding], context: context)
        XCTAssertNil(asked.block)
        XCTAssertEqual(asked.permission?.decision, .ask)

        let failing = makeHook(event: .preToolUse, command: "echo broken >&2; exit 3")
        let failed = await runner(for: root, allowing: [failing]).run(hooks: [failing], context: context)
        XCTAssertNil(failed.block, "only exit 2 blocks")
        XCTAssertTrue(failed.errors.first?.reason.contains("status 3") == true)
        XCTAssertTrue(failed.errors.first?.reason.contains("broken") == true)
    }

    func testTimeoutKillsTheHooksWholeProcessGroup() async throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable on this machine")
        let root = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }
        // A child left running in the background is the case a plain kill
        // misses: it would outlive its hook and hold the pipes open.
        let hook = HookDefinition(
            event: .postToolUse,
            command: "sleep 30 & echo $! > child.pid; wait",
            timeoutSeconds: 1,
            source: .juno,
            path: ".juno/settings.json"
        )
        let started = ContinuousClock.now
        let outcome = await runner(for: root, allowing: [hook]).run(
            hooks: [hook],
            context: HookInvocationContext(event: .postToolUse, cwd: root.path, toolName: "write_file")
        )
        let elapsed = ContinuousClock.now - started

        XCTAssertLessThan(elapsed, .seconds(10), "the hook must not run its 30 seconds")
        guard case let .failed(_, reason) = outcome.results[0].status else {
            return XCTFail("expected a timeout, got \(outcome.results[0].status)")
        }
        XCTAssertTrue(reason?.contains("timed out") == true)
        XCTAssertNil(outcome.block, "a timeout does not block")
        XCTAssertEqual(outcome.errors.count, 1)

        let pidText = try String(contentsOf: root.appendingPathComponent("child.pid"), encoding: .utf8)
        let pid = try XCTUnwrap(pid_t(pidText.trimmingCharacters(in: .whitespacesAndNewlines)))
        var alive = kill(pid, 0) == 0
        for _ in 0..<30 where alive {
            try await Task.sleep(for: .milliseconds(100))
            alive = kill(pid, 0) == 0
        }
        XCTAssertFalse(alive, "the background child must die with its hook")
    }

    func testAHookThatIgnoresItsInputDoesNotHangOrCrashTheWriter() async throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable on this machine")
        let root = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }
        let hook = makeHook(event: .postToolUse, command: "exit 0")
        // Far more than a pipe buffer: the writer must meet a closed pipe and
        // stop, rather than block or take SIGPIPE.
        let large = String(repeating: "a", count: 1_000_000)
        let outcome = await runner(for: root, allowing: [hook]).run(
            hooks: [hook],
            context: HookInvocationContext(
                event: .postToolUse,
                cwd: root.path,
                toolName: "write_file",
                toolInput: ["path": "big.txt", "content": .string(large)]
            )
        )
        XCTAssertTrue(outcome.results[0].succeeded)
    }

    // MARK: - Helpers

    private func runner(for root: URL, allowing hooks: [HookDefinition]) -> HookRunner {
        HookRunner(
            executor: CommandExecutionService.contained(workspaceRootURL: root),
            // Full access, where an allowed repository hook runs without a
            // prompt; the modes that ask have their own test.
            policy: HookExecutionPolicy(
                allowedHookIDs: Set(hooks.map(\.id)),
                permissionMode: .fullAccess,
                allowUntrustedHooks: true
            ),
            projectDirectory: root.path
        )
    }

    private func result(
        _ event: HookLifecycleEvent,
        _ status: HookExecutionStatus,
        stdout: String = "",
        stderr: String = ""
    ) -> HookExecutionResult {
        HookExecutionResult(
            hookID: "hook-\(UUID().uuidString)",
            hookName: "guard.sh",
            event: event,
            status: status,
            stdout: stdout,
            stderr: stderr,
            output: status == .succeeded(exitCode: 0) ? HookOutput(stdout: stdout, event: event) : nil
        )
    }

    private func json(_ event: HookLifecycleEvent, _ stdout: String) -> HookExecutionResult {
        result(event, .succeeded(exitCode: 0), stdout: stdout)
    }

    private func makeHook(event: HookLifecycleEvent, command: String) -> HookDefinition {
        HookDefinition(event: event, command: command, source: .claude, path: ".claude/settings.json")
    }

    private func makeWorkspace() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-hook-protocol-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // Canonical, as the executor's workspace root is.
        return root.resolvingSymlinksInPath()
    }
}
