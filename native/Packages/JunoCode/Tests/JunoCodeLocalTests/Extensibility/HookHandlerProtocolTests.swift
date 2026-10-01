import Foundation
import Network
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The full hooks protocol (CODE_AGENT_SPEC §5.9): every event and handler
/// type parses, every event's stdin is the documented JSON, exit codes and
/// answers mean what they say per event, `http` hooks post and are read like
/// commands, and `prompt` hooks can only block.
final class HookHandlerProtocolTests: XCTestCase {
    // MARK: - Events and handler types

    func testEveryEventParsesByItsClaudeCodeKey() throws {
        XCTAssertEqual(HookLifecycleEvent.allCases.count, 27)
        for event in HookLifecycleEvent.allCases {
            XCTAssertEqual(HookLifecycleEvent(configurationKey: event.rawValue), event, event.rawValue)
            XCTAssertEqual(HookLifecycleEvent(configurationKey: event.rawValue.lowercased()), event)
        }
        // Juno's own earlier names still land on Claude's.
        XCTAssertEqual(HookLifecycleEvent(configurationKey: "before_command"), .preToolUse)
        XCTAssertEqual(HookLifecycleEvent(configurationKey: "session_stop"), .stop)
        // Not adopted: diagnosed, never silently accepted.
        for key in ["Setup", "UserPromptExpansion", "MessageDisplay", "TeammateIdle", "CwdChanged", "Elicitation"] {
            XCTAssertNil(HookLifecycleEvent(configurationKey: key), key)
        }

        var json: [String: Any] = [:]
        for event in HookLifecycleEvent.allCases {
            json[event.rawValue] = [["hooks": [["type": "command", "command": "echo \(event.rawValue)"]]]]
        }
        let data = try JSONSerialization.data(withJSONObject: ["hooks": json])
        let configuration = try HookConfigurationParser().parse(data: data, file: .claudeProject)
        XCTAssertEqual(Set(configuration.hooks.map(\.event)), Set(HookLifecycleEvent.allCases))
        XCTAssertTrue(configuration.diagnostics.isEmpty, "\(configuration.diagnostics)")
    }

    func testEveryHandlerTypeParsesAndTheUnadoptedOnesAreDiagnosed() throws {
        let json = """
        {"hooks": {
          "PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": "echo guard"},
            {"type": "http", "url": "http://127.0.0.1:8123/hook", "headers": {"X-Team": "juno"}, "timeout": 20},
            {"type": "prompt", "prompt": "Is $ARGUMENTS safe?", "model": "haiku"},
            {"type": "mcp_tool", "server": "x", "tool": "y"},
            {"type": "agent", "prompt": "check"}
          ]}],
          "Notification": [{"type": "prompt", "prompt": "never blocks"}],
          "Stop": [{"type": "http"}]
        }}
        """
        let configuration = try HookConfigurationParser().parse(data: Data(json.utf8), file: .claudeProject)
        let kinds = configuration.hooks.map(\.kind)
        XCTAssertEqual(kinds, [.command, .http, .prompt])
        let http = try XCTUnwrap(configuration.hooks.first { $0.kind == .http })
        XCTAssertEqual(http.url?.absoluteString, "http://127.0.0.1:8123/hook")
        XCTAssertEqual(http.headers, ["X-Team": "juno"])
        XCTAssertEqual(http.timeoutSeconds, 20)
        XCTAssertEqual(http.risk, .execute, "an endpoint on this Mac is graded like a contained command")
        let prompt = try XCTUnwrap(configuration.hooks.first { $0.kind == .prompt })
        XCTAssertEqual(prompt.model, "haiku")
        XCTAssertEqual(prompt.timeoutSeconds, HookExecutionLimits.promptTimeoutSeconds)
        XCTAssertEqual(prompt.risk, .read)
        let messages = configuration.diagnostics.map(\.message)
        XCTAssertTrue(messages.contains { $0.contains("MCP tool hooks are not supported yet") })
        XCTAssertTrue(messages.contains { $0.contains("Agent hooks are not supported") })
        XCTAssertTrue(messages.contains { $0.contains("Notification cannot be blocked") })
        XCTAssertTrue(messages.contains { $0.contains("requires a `url`") })
    }

    func testTimeoutsDefaultPerKindAndEvent() throws {
        let json = """
        {"hooks": {
          "PreToolUse": [{"type": "command", "command": "echo a"}, {"type": "http", "url": "http://localhost:1/x"}],
          "UserPromptSubmit": [{"type": "command", "command": "echo b"}],
          "Stop": [{"type": "prompt", "prompt": "done?"}]
        }}
        """
        let hooks = try HookConfigurationParser().parse(data: Data(json.utf8), file: .claudeProject).hooks
        XCTAssertEqual(hooks.first { $0.event == .preToolUse && $0.kind == .command }?.timeoutSeconds, 600)
        XCTAssertEqual(hooks.first { $0.kind == .http }?.timeoutSeconds, 600)
        XCTAssertEqual(hooks.first { $0.event == .userPromptSubmit }?.timeoutSeconds, 30)
        XCTAssertEqual(hooks.first { $0.kind == .prompt }?.timeoutSeconds, 30)
    }

    func testAnHTTPHookIsANewHookWhenItsHeadersChange() throws {
        func parse(_ header: String) throws -> HookDefinition {
            let json = "{\"hooks\": {\"Stop\": [{\"type\": \"http\", \"url\": \"http://localhost:9/x\", \"headers\": {\"A\": \"\(header)\"}}]}}"
            return try XCTUnwrap(HookConfigurationParser().parse(data: Data(json.utf8), file: .claudeProject).hooks.first)
        }
        XCTAssertNotEqual(try parse("one").id, try parse("two").id)
        // A command hook keeps the identity earlier builds gave it.
        let command = HookDefinition(event: .stop, command: "echo x", source: .claude, path: ".claude/settings.json")
        XCTAssertEqual(
            command.id,
            HookDefinition.makeID(event: .stop, matcher: HookMatcher(), command: "echo x", source: .claude, path: ".claude/settings.json", occurrence: 0)
        )
    }

    // MARK: - Standard input

    func testGoldenStandardInputPerEvent() {
        func payload(_ context: HookInvocationContext) -> String {
            context.payload(projectDirectory: "/w").canonicalJSONString()
        }
        let base = { (event: HookLifecycleEvent) in
            HookInvocationContext(event: event, sessionID: "s", cwd: "/w", permissionMode: .askBeforeChanges)
        }
        XCTAssertEqual(
            payload(HookInvocationContext(
                event: .postToolUseFailure, sessionID: "s", cwd: "/w", permissionMode: .askBeforeChanges,
                toolName: "run_command", toolUseID: "c1", toolInput: ["command": "npm test"],
                toolResult: HookToolResult(succeeded: false, content: "exit 1")
            )),
            #"{"cwd":"/w","error":"exit 1","hook_event_name":"PostToolUseFailure","is_interrupt":false,"permission_mode":"default","session_id":"s","tool_input":{"command":"npm test"},"tool_name":"Bash","tool_use_id":"c1"}"#
        )
        XCTAssertEqual(
            payload(HookInvocationContext(
                event: .stop, sessionID: "s", cwd: "/w", permissionMode: .askBeforeChanges,
                stopHookActive: true, lastAssistantMessage: "Done."
            )),
            #"{"cwd":"/w","hook_event_name":"Stop","last_assistant_message":"Done.","permission_mode":"default","session_id":"s","stop_hook_active":true}"#
        )
        XCTAssertEqual(
            payload(HookInvocationContext(
                event: .subagentStop, sessionID: "s", cwd: "/w", permissionMode: .askBeforeChanges,
                stopHookActive: false, agentID: "call#0", agentType: "reviewer"
            )),
            #"{"agent_id":"call#0","agent_type":"reviewer","cwd":"/w","hook_event_name":"SubagentStop","permission_mode":"default","session_id":"s","stop_hook_active":false}"#
        )
        XCTAssertEqual(
            payload(HookInvocationContext(
                event: .preCompact, sessionID: "s", cwd: "/w", permissionMode: .askBeforeChanges,
                fields: ["trigger": "manual", "custom_instructions": "keep the API"]
            )),
            #"{"custom_instructions":"keep the API","cwd":"/w","hook_event_name":"PreCompact","permission_mode":"default","session_id":"s","trigger":"manual"}"#
        )
        XCTAssertEqual(
            payload(HookInvocationContext(
                event: .permissionDenied, sessionID: "s", cwd: "/w", permissionMode: .askBeforeChanges,
                toolName: "run_command", reason: "The request was declined."
            )),
            #"{"cwd":"/w","hook_event_name":"PermissionDenied","permission_mode":"default","reason":"The request was declined.","session_id":"s","tool_input":{},"tool_name":"Bash"}"#
        )
        // An event's own fields never replace the common ones.
        let spoof = HookInvocationContext(event: .goalSet, sessionID: "s", cwd: "/w", fields: ["session_id": "other", "goal": ["objective": "x"]])
            .payload(projectDirectory: "/w")
        XCTAssertEqual(spoof["session_id"]?.stringValue, "s")
        XCTAssertEqual(spoof["goal"]?["objective"]?.stringValue, "x")
        for event in HookLifecycleEvent.allCases {
            XCTAssertEqual(base(event).payload(projectDirectory: "/w")["hook_event_name"]?.stringValue, event.rawValue)
        }
    }

    // MARK: - Exit codes and answers

    func testExitTwoBlocksOnlyWhereTheEventCanBeBlocked() {
        let blocking: Set<HookLifecycleEvent> = [
            .preToolUse, .postToolUse, .postToolUseFailure, .userPromptSubmit, .stop, .subagentStop,
            .permissionRequest, .taskCreated, .taskCompleted, .configChange, .preModelSwitch,
        ]
        for event in HookLifecycleEvent.allCases {
            let outcome = HookEventOutcome(
                event: event,
                results: [HookExecutionResult(hookID: "h", event: event, status: .blocked(reason: "no"))]
            )
            XCTAssertEqual(outcome.block != nil, blocking.contains(event), event.rawValue)
            XCTAssertEqual(outcome.errors.isEmpty, blocking.contains(event), event.rawValue)
        }
    }

    func testTheJSONAnswerContract() throws {
        let pre = try XCTUnwrap(HookOutput(
            stdout: #"{"continue": true, "suppressOutput": true, "systemMessage": "hidden", "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "defer", "updatedInput": {"command": "npm test -- --ci"}}}"#,
            event: .preToolUse
        ))
        XCTAssertEqual(pre.permissionDecision, .ask, "defer is read as ask")
        XCTAssertEqual(pre.updatedInput?["command"]?.stringValue, "npm test -- --ci")
        XCTAssertTrue(pre.suppressOutput)
        let outcome = HookEventOutcome(
            event: .preToolUse,
            results: [HookExecutionResult(hookID: "h", event: .preToolUse, status: .succeeded(exitCode: 0), output: pre)]
        )
        XCTAssertTrue(outcome.messages.isEmpty, "suppressOutput hides the message")
        XCTAssertEqual(outcome.updatedInput?["command"]?.stringValue, "npm test -- --ci")
        XCTAssertEqual(outcome.permission?.decision, .ask)

        // `updatedInput` means something only before a tool runs.
        let post = try XCTUnwrap(HookOutput(
            stdout: #"{"hookSpecificOutput": {"updatedInput": {"command": "rm -rf /"}}}"#,
            event: .postToolUse
        ))
        XCTAssertNil(post.updatedInput)

        // A block outranks a rewrite, and the second rewrite is reported.
        let rewrite = HookOutput(updatedInput: ["command": "ls"])
        let both = HookEventOutcome(event: .preToolUse, results: [
            HookExecutionResult(hookID: "a", event: .preToolUse, status: .succeeded(exitCode: 0), output: rewrite),
            HookExecutionResult(hookID: "b", event: .preToolUse, status: .succeeded(exitCode: 0), output: rewrite),
        ])
        XCTAssertEqual(both.errors.count, 1)
        let blocked = HookEventOutcome(event: .preToolUse, results: [
            HookExecutionResult(hookID: "a", event: .preToolUse, status: .succeeded(exitCode: 0), output: rewrite),
            HookExecutionResult(hookID: "b", event: .preToolUse, status: .blocked(reason: "no")),
        ])
        XCTAssertNil(blocked.updatedInput)

        // `continue: false` halts, `decision: block` blocks.
        let halt = try XCTUnwrap(HookOutput(stdout: #"{"continue": false, "stopReason": "enough"}"#, event: .postToolBatch))
        XCTAssertEqual(HookEventOutcome(event: .postToolBatch, results: [
            HookExecutionResult(hookID: "h", event: .postToolBatch, status: .succeeded(exitCode: 0), output: halt),
        ]).halt?.reason, "enough")
    }

    func testAPermissionRequestHookMayDeclineAndNeverApprove() throws {
        func outcome(_ json: String) throws -> HookEventOutcome {
            let output = try XCTUnwrap(HookOutput(stdout: json, event: .permissionRequest))
            return HookEventOutcome(event: .permissionRequest, results: [
                HookExecutionResult(hookID: "h", event: .permissionRequest, status: .succeeded(exitCode: 0), output: output),
            ])
        }
        let deny = try outcome(#"{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "not on Fridays"}}}"#)
        XCTAssertEqual(deny.block?.reason, "not on Fridays")
        let allow = try outcome(#"{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}"#)
        XCTAssertNil(allow.block)
        XCTAssertNil(allow.permission, "an allow grants nothing")
        XCTAssertTrue(allow.errors.contains { $0.reason.contains("cannot approve") })
    }

    // MARK: - HTTP hooks

    func testAnHTTPHookPostsTheEventAndIsReadLikeACommand() async throws {
        let server = try await LoopbackHookServer.start(status: 200, body: #"{"decision": "block", "reason": "CI is red"}"#)
        defer { server.stop() }
        let hook = HookDefinition(
            event: .stop,
            command: server.url.absoluteString,
            timeoutSeconds: 10,
            source: .juno,
            path: HookConfigurationFile.junoUser.path,
            trust: .readerConfiguration,
            kind: .http,
            url: server.url,
            headers: ["X-Juno-Test": "1"]
        )
        let runner = HookRunner(executor: UncontainedExecutor(), policy: HookExecutionPolicy(permissionMode: .workspaceWrite))
        let outcome = await runner.run(
            hooks: [hook],
            context: HookInvocationContext(event: .stop, sessionID: "s1", cwd: "/w", permissionMode: .workspaceWrite, stopHookActive: false)
        )
        XCTAssertEqual(outcome.block?.reason, "CI is red")
        let received = try XCTUnwrap(server.requests.first)
        XCTAssertTrue(received.head.hasPrefix("POST /hook"), received.head)
        XCTAssertTrue(received.head.lowercased().contains("x-juno-test: 1"))
        let body = try JSONDecoder().decode(JSONValue.self, from: received.body)
        XCTAssertEqual(body["hook_event_name"]?.stringValue, "Stop")
        XCTAssertEqual(body["session_id"]?.stringValue, "s1")

        // Any other status is a non-blocking error.
        let failing = try await LoopbackHookServer.start(status: 500, body: "boom")
        defer { failing.stop() }
        let broken = HookDefinition(
            event: .stop, command: failing.url.absoluteString, timeoutSeconds: 10, source: .juno,
            path: HookConfigurationFile.junoUser.path, trust: .readerConfiguration, kind: .http, url: failing.url
        )
        let error = await runner.run(
            hooks: [broken],
            context: HookInvocationContext(event: .stop, sessionID: "s1", cwd: "/w", permissionMode: .workspaceWrite)
        )
        XCTAssertNil(error.block)
        XCTAssertTrue(error.errors.first?.reason.contains("HTTP 500") == true)
    }

    func testAProjectHTTPHookMayOnlyPostToThisMac() async throws {
        let remote = URL(string: "https://hooks.example.com/juno")!
        let hook = HookDefinition(
            event: .stop, command: remote.absoluteString, source: .claude, path: ".claude/settings.json",
            kind: .http, url: remote
        )
        XCTAssertEqual(hook.risk, .critical)
        let policy = HookExecutionPolicy(allowedHookIDs: [hook.id], permissionMode: .fullAccess, allowUntrustedHooks: true)
        let decision = await policy.authorize(HookInvocation(
            hook: hook,
            context: HookInvocationContext(event: .stop, sessionID: "s")
        ))
        guard case let .denied(reason) = decision else { return XCTFail("\(decision)") }
        XCTAssertTrue(reason.contains("only post to this Mac"))

        // The reader's own file may name any endpoint.
        let mine = HookDefinition(
            event: .stop, command: remote.absoluteString, source: .juno, path: HookConfigurationFile.junoUser.path,
            trust: .readerConfiguration, kind: .http, url: remote
        )
        let allowed = await HookExecutionPolicy(permissionMode: .askBeforeChanges).authorize(
            HookInvocation(hook: mine, context: HookInvocationContext(event: .stop, sessionID: "s"))
        )
        XCTAssertEqual(allowed, .allowed)

        // A project's loopback hook asks wherever a command would.
        let local = HookDefinition(
            event: .stop, command: "http://localhost:9/x", source: .claude, path: ".claude/settings.json",
            kind: .http, url: URL(string: "http://localhost:9/x")
        )
        let asks = await HookExecutionPolicy(allowedHookIDs: [local.id], permissionMode: .askBeforeChanges, allowUntrustedHooks: true)
            .authorize(HookInvocation(hook: local, context: HookInvocationContext(event: .stop, sessionID: "s")))
        guard case .requiresPermission = asks else { return XCTFail("\(asks)") }
    }

    // MARK: - Prompt hooks

    func testAPromptStopHookBlocksWithItsModelsReason() async throws {
        let evaluator = ScriptedPromptEvaluator(answer: #"Here you go: {"ok": false, "reason": "The tests were not run."}"#)
        let hook = HookDefinition(
            event: .stop, command: "Did the agent run the tests? $ARGUMENTS", timeoutSeconds: 30,
            source: .juno, path: HookConfigurationFile.junoUser.path, trust: .readerConfiguration, kind: .prompt
        )
        let runner = HookRunner(executor: UncontainedExecutor(), policy: HookExecutionPolicy(permissionMode: .workspaceWrite), promptEvaluator: evaluator)
        let outcome = await runner.run(
            hooks: [hook],
            context: HookInvocationContext(event: .stop, sessionID: "s1", cwd: "/w", permissionMode: .workspaceWrite, stopHookActive: false, lastAssistantMessage: "All done.")
        )
        XCTAssertEqual(outcome.block?.reason, "The tests were not run.")
        let asked = try XCTUnwrap(evaluator.questions.first)
        XCTAssertTrue(asked.hasPrefix("Did the agent run the tests? {"))
        XCTAssertTrue(asked.contains("\"last_assistant_message\":\"All done.\""))
        XCTAssertTrue(asked.contains("\"hook_event_name\":\"Stop\""))
    }

    func testAPromptHookCanOnlyBlock() async throws {
        let hook = { (event: HookLifecycleEvent) in
            HookDefinition(
                event: event, command: "ok?", timeoutSeconds: 30, source: .juno,
                path: HookConfigurationFile.junoUser.path, trust: .readerConfiguration, kind: .prompt
            )
        }
        func run(_ answer: String, _ event: HookLifecycleEvent) async -> HookEventOutcome {
            await HookRunner(
                executor: UncontainedExecutor(),
                policy: HookExecutionPolicy(permissionMode: .fullAccess),
                promptEvaluator: ScriptedPromptEvaluator(answer: answer)
            ).run(hooks: [hook(event)], context: HookInvocationContext(event: event, sessionID: "s", toolName: "run_command"))
        }
        let yes = await run(#"{"ok": true}"#, .preToolUse)
        XCTAssertNil(yes.block)
        XCTAssertNil(yes.permission, "ok: true allows nothing")
        let no = await run(#"{"ok": false, "reason": "rm is not allowed"}"#, .preToolUse)
        XCTAssertEqual(no.block?.reason, "rm is not allowed")
        let garbage = await run("I think it is fine", .preToolUse)
        XCTAssertNil(garbage.block)
        XCTAssertTrue(garbage.errors.first?.reason.contains("{ok, reason}") == true)

        // A model that never answers is a non-blocking error, not a hang.
        let slow = HookDefinition(
            event: .stop, command: "ok?", timeoutSeconds: 0.2, source: .juno,
            path: HookConfigurationFile.junoUser.path, trust: .readerConfiguration, kind: .prompt
        )
        let timedOut = await HookRunner(
            executor: UncontainedExecutor(),
            policy: HookExecutionPolicy(permissionMode: .fullAccess),
            promptEvaluator: ScriptedPromptEvaluator(answer: "", delay: .seconds(5))
        ).run(hooks: [slow], context: HookInvocationContext(event: .stop, sessionID: "s"))
        XCTAssertTrue(timedOut.errors.first?.reason.contains("did not answer") == true)
    }
}

// MARK: - Test doubles

/// HTTP and prompt hooks never reach a command executor; this one fails the
/// test if anything does.
private struct UncontainedExecutor: HookCommandExecuting {
    let isContained = false

    func runHook(
        _: String,
        standardInput _: Data,
        environment _: [String: String],
        timeoutSeconds _: Double,
        outputLimit _: OutputLimit
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        XCTFail("A non-command hook reached the command executor")
        throw CommandExecutionError.launchFailed(message: "unexpected")
    }
}

private final class ScriptedPromptEvaluator: HookPromptEvaluating, @unchecked Sendable {
    private let answer: String
    private let delay: Duration?
    private let lock = NSLock()
    private var asked: [String] = []

    init(answer: String, delay: Duration? = nil) {
        self.answer = answer
        self.delay = delay
    }

    var questions: [String] { lock.withLock { asked } }

    func evaluate(system _: String, user: String, model _: String?) async throws -> String {
        lock.withLock { asked.append(user) }
        if let delay { try await Task.sleep(for: delay) }
        return answer
    }
}

/// A one-endpoint HTTP server on 127.0.0.1, in process: records each request
/// and answers with a fixed status and body.
private final class LoopbackHookServer: @unchecked Sendable {
    struct Received {
        let head: String
        let body: Data
    }

    private let listener: NWListener
    private let status: Int
    private let responseBody: String
    private let lock = NSLock()
    private var received: [Received] = []
    let url: URL

    var requests: [Received] { lock.withLock { received } }

    private init(listener: NWListener, port: UInt16, status: Int, body: String) {
        self.listener = listener
        self.status = status
        self.responseBody = body
        self.url = URL(string: "http://127.0.0.1:\(port)/hook")!
    }

    static func start(status: Int, body: String) async throws -> LoopbackHookServer {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        let listener = try NWListener(using: parameters, on: .any)
        let queue = DispatchQueue(label: "juno.test.hook-server")
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            nonisolated(unsafe) var resumed = false
            listener.stateUpdateHandler = { state in
                guard !resumed else { return }
                switch state {
                case .ready:
                    resumed = true
                    continuation.resume(returning: listener.port?.rawValue ?? 0)
                case let .failed(error):
                    resumed = true
                    continuation.resume(throwing: error)
                default:
                    break
                }
            }
            listener.newConnectionHandler = { _ in }
            listener.start(queue: queue)
        }
        let server = LoopbackHookServer(listener: listener, port: port, status: status, body: body)
        listener.newConnectionHandler = { [server] connection in
            connection.start(queue: queue)
            server.read(connection, buffer: Data())
        }
        return server
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [self] data, _, complete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = Self.parse(buffer) {
                lock.withLock { received.append(request) }
                let reply = "HTTP/1.1 \(status) X\r\nContent-Type: application/json\r\nContent-Length: \(responseBody.utf8.count)\r\nConnection: close\r\n\r\n\(responseBody)"
                connection.send(content: Data(reply.utf8), completion: .contentProcessed { _ in connection.cancel() })
            } else if complete || error != nil {
                connection.cancel()
            } else {
                read(connection, buffer: buffer)
            }
        }
    }

    /// A whole request, once its body has arrived as `Content-Length` says.
    private static func parse(_ data: Data) -> Received? {
        guard let separator = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[..<separator.lowerBound], as: UTF8.self)
        let length = head.split(separator: "\r\n")
            .first { $0.lowercased().hasPrefix("content-length:") }
            .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
        let body = data[separator.upperBound...]
        guard body.count >= length else { return nil }
        return Received(head: head, body: Data(body.prefix(length)))
    }

    func stop() {
        listener.cancel()
    }
}
