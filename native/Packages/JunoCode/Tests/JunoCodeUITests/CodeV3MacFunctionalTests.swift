import AppKit
import Foundation
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoScreenControl
@testable import JunoCodeUI

// Code v3 (Mac functional lane): env-thread terminals, Orchestrate roles on
// other provider instances, connected-agent approvals as Studio cards, and
// the computer-use overlay panel.

// MARK: - A fake env server

/// Answers commands like the env server: `handle` returns the result (or an
/// error) and may push events after the response.
final class FakeEnvServer: EnvServerTransport, @unchecked Sendable {
    struct Reply {
        var result: JSONValue = .object([:])
        var error: CodeV2.WireError?
        var events: [CodeV2.ServerEventEnvelope] = []
    }

    private let lock = NSLock()
    private var frames: [String?] = []
    private var waiting: CheckedContinuation<String?, Error>?
    /// A command as sent, by wire name (newer commands have no enum case here).
    struct Command: Decodable {
        let id: String
        let type: String
        let params: JSONValue
        var kind: CodeV2.ClientCommandType? { CodeV2.ClientCommandType(rawValue: type) }
    }

    private var log: [Command] = []
    var handle: (Command) -> Reply = { _ in Reply() }

    var commands: [Command] { lock.withLock { log } }

    func send(_ text: String) async throws {
        let command = try JSONDecoder().decode(Command.self, from: Data(text.utf8))
        lock.withLock { log.append(command) }
        let reply = handle(command)
        let response = CodeV2.ServerResponse(id: command.id, ok: reply.error == nil, result: reply.result, error: reply.error)
        push(String(decoding: try JSONEncoder().encode(response), as: UTF8.self))
        for event in reply.events { emit(event) }
    }

    func emitRaw(_ frame: String) { push(frame) }

    func emit(_ envelope: CodeV2.ServerEventEnvelope) {
        push(String(decoding: (try? JSONEncoder().encode(envelope)) ?? Data(), as: UTF8.self))
    }

    private func push(_ frame: String?) {
        lock.lock()
        if let waiting {
            self.waiting = nil
            lock.unlock()
            waiting.resume(returning: frame)
            return
        }
        frames.append(frame)
        lock.unlock()
    }

    func receive() async throws -> String? {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if !frames.isEmpty {
                let frame = frames.removeFirst()
                lock.unlock()
                continuation.resume(returning: frame)
                return
            }
            waiting = continuation
            lock.unlock()
        }
    }

    func close() async { push(nil) }

    static func value(_ object: [String: String]) -> JSONValue {
        .object(object.mapValues { .string($0) })
    }

    static func event(_ sessionId: String?, _ sequence: Int, _ event: CodeV2.ServerEvent) -> CodeV2.ServerEventEnvelope {
        CodeV2.ServerEventEnvelope(
            stream: sessionId == nil ? .global : .session, sessionId: sessionId, sequence: sequence,
            at: "2026-10-09T10:00:00Z", event: event
        )
    }
}

private func eventually(_ timeout: Duration = .seconds(3), _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

// MARK: - Terminal

@MainActor
final class CodeV2EnvTerminalTests: XCTestCase {
    func testOpensWritesResizesAndFollowsItsOwnOutput() async throws {
        let server = FakeEnvServer()
        server.handle = { command in
            switch command.kind {
            case .terminalOpen:
                return .init(result: FakeEnvServer.value(["terminalId": "t1"]), events: [
                    FakeEnvServer.event(nil, 1, .terminalOutput(terminalId: "t1", data: "\u{1B}[32m$\u{1B}[0m ")),
                    FakeEnvServer.event(nil, 2, .terminalOutput(terminalId: "other", data: "not mine")),
                ])
            case .terminalWrite:
                return .init(events: [FakeEnvServer.event(nil, 3, .terminalOutput(terminalId: "t1", data: "ls\r\nREADME.md\r\n$ "))])
            default:
                return .init()
            }
        }
        let connection = EnvServerConnection(transport: server, commandTimeout: .seconds(5))
        await connection.start()
        let terminal = CodeV2EnvTerminal(cwd: "/tmp/repo", connection: { connection })
        await terminal.open(cols: 80, rows: 24)
        XCTAssertEqual(terminal.phase, .running)
        XCTAssertEqual(terminal.terminalId, "t1")
        await terminal.send(line: "ls")
        let painted = await eventually { terminal.screen.text == "$ ls\nREADME.md\n$ " }
        XCTAssertTrue(painted, terminal.screen.text)
        await terminal.send(control: .interrupt)
        await terminal.resize(cols: 120, rows: 40)
        let types = server.commands.map(\.kind)
        XCTAssertEqual(types, [.terminalOpen, .terminalWrite, .terminalWrite, .terminalResize])
        XCTAssertEqual(server.commands[0].params["cwd"]?.stringValue, "/tmp/repo")
        XCTAssertEqual(server.commands[1].params["data"]?.stringValue, "ls\r")
        XCTAssertEqual(server.commands[2].params["data"]?.stringValue, "\u{03}")
        terminal.receive(.terminalExited(terminalId: "t1", exitCode: 0))
        XCTAssertEqual(terminal.phase, .exited(0))
        await terminal.send(line: "ignored")
        XCTAssertEqual(server.commands.count, 4, "nothing is written to an exited shell")
        await connection.close()
    }

    func testAFailedOpenSaysWhy() async {
        let server = FakeEnvServer()
        server.handle = { _ in .init(error: CodeV2.WireError(code: .badRequest, message: "That folder is not shared.")) }
        let connection = EnvServerConnection(transport: server, commandTimeout: .seconds(5))
        await connection.start()
        let terminal = CodeV2EnvTerminal(cwd: "/", connection: { connection })
        await terminal.open()
        XCTAssertEqual(terminal.phase, .failed("That folder is not shared."))
        await connection.close()
    }

    func testDockTabsFollowWhatTheThreadHas() {
        XCTAssertEqual(CodeV2DockTabs.visible(hasTerminal: false, hasWorkspace: false, hasFrames: false), [.changes, .agents])
        XCTAssertEqual(
            CodeV2DockTabs.visible(hasTerminal: true, hasWorkspace: true, hasFrames: true),
            [.changes, .agents, .terminal, .files, .preview, .screen]
        )
    }
}

// MARK: - Orchestrate on other instances

private struct StubClient: AgentModelClient {
    let name: String
    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

final class CodeV2SubagentProvidersTests: XCTestCase {
    private let alevr = CodeV2.ProviderInstance(
        id: "alevr", kind: .alevr, label: "Alevr", status: .ready,
        models: [CodeV2.ProviderModel(id: "openai:gpt-6.1", label: "GPT-6.1", contextTiers: [
            CodeV2.ContextTier(tokens: 272_000, label: "272K", inputPerMTok: 2, outputPerMTok: 10),
            CodeV2.ContextTier(tokens: 1_000_000, label: "1M", inputPerMTok: 4, outputPerMTok: 15),
        ])]
    )
    private let anthropicKey = CodeV2.ProviderInstance(id: "byok:anthropic", kind: .byok, label: "Anthropic key", status: .ready)
    private let claude = CodeV2.ProviderInstance(id: "claude-agent:default", kind: .claudeAgent, label: "Claude", status: .ready)
    private let codexSignedOut = CodeV2.ProviderInstance(id: "codex:default", kind: .codex, label: "Codex", status: .signedOut)

    private func providers(env: Bool = true) -> (CodeV2SubagentProviders, BillingLog) {
        let log = BillingLog()
        let failing: CodeV2SubagentProviders.EnvConnector = { throw EnvServerConnectionError.closed }
        let providers = CodeV2SubagentProviders(
            instances: [alevr, anthropicKey, claude, codexSignedOut],
            backend: { billing, tokens in
                log.append(billing, tokens)
                return StubClient(name: billing.rawValue)
            },
            env: env ? failing : nil,
            cwd: "/tmp/repo",
            runtimeMode: .autoEdit
        )
        return (providers, log)
    }

    func testAlevrRolesUseThePlanAtTheirTier() throws {
        let (providers, log) = providers()
        let route = try XCTUnwrap(providers.resolve(CodeV2.ModelSelection(instanceId: "alevr", model: "openai:gpt-6.1", contextTokens: 1_000_000)))
        XCTAssertEqual(route.modelID, "openai:gpt-6.1")
        XCTAssertTrue(route.billable)
        XCTAssertEqual(route.tier?.tokens, 1_000_000, "the budget prices the chosen tier")
        XCTAssertEqual(log.entries.first?.0, .alevr)
        XCTAssertEqual(log.entries.first?.1, 1_000_000)
    }

    func testKeyRolesRunOnTheUsersKeyUnbilled() throws {
        let (providers, log) = providers()
        let route = try XCTUnwrap(providers.resolve(CodeV2.ModelSelection(instanceId: "byok:anthropic", model: "claude-sonnet-5")))
        XCTAssertEqual(route.modelID, "anthropic:claude-sonnet-5")
        XCTAssertFalse(route.billable)
        XCTAssertEqual(log.entries.first?.0, .byok)
        XCTAssertNil(providers.resolve(CodeV2.ModelSelection(instanceId: "byok:openai", model: "gpt-6.1")), "no key stored for that lab")
    }

    func testSubscriptionRolesRunOnTheEnvServer() throws {
        let (providers, _) = providers()
        let route = try XCTUnwrap(providers.resolve(CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "claude-opus-5-5")))
        let client = try XCTUnwrap(route.client as? EnvServerSubagentClient)
        XCTAssertEqual(client.cwd, "/tmp/repo")
        XCTAssertEqual(client.selection.instanceId, "claude-agent:default")
        XCTAssertFalse(route.billable)
        XCTAssertNil(providers.resolve(CodeV2.ModelSelection(instanceId: "codex:default", model: "gpt-6.1-codex")), "signed out")
        XCTAssertNil(self.providers(env: false).0.resolve(CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "x")))
    }

    func testRoutingUsesTheResolverAndFallsBackWithANote() {
        let (providers, _) = providers()
        var routing = CodeV2.RoleRouting(orchestrator: CodeV2.ModelSelection(instanceId: "alevr", model: "openai:gpt-6.1"))
        routing.workers = [
            CodeV2.ModelSelection(instanceId: "byok:anthropic", model: "claude-sonnet-5"),
            CodeV2.ModelSelection(instanceId: "codex:default", model: "gpt-6.1-codex"),
        ]
        let engine = SubagentRouting(routing: routing, resolver: providers.resolver)
        let parent = StubClient(name: "parent")
        let first = engine.route(
            requestedModelID: nil, requestedEffort: nil, role: .worker, ordinal: 0,
            parentClient: parent, parentModelID: "openai:gpt-6.1", parentEffort: nil
        )
        XCTAssertEqual(first.modelID, "anthropic:claude-sonnet-5")
        XCTAssertFalse(first.billable)
        let second = engine.route(
            requestedModelID: nil, requestedEffort: nil, role: .worker, ordinal: 1,
            parentClient: parent, parentModelID: "openai:gpt-6.1", parentEffort: nil
        )
        XCTAssertEqual(second.modelID, "openai:gpt-6.1", "a signed-out subscription falls back to the parent")
        XCTAssertNotNil(second.note)
    }

    func testFingerprintChangesWhenAProviderComesOrGoes() {
        let (providers, _) = providers()
        var later = providers
        later.instances.append(CodeV2.ProviderInstance(id: "codex:default", kind: .codex, label: "Codex", status: .ready))
        XCTAssertNotEqual(providers.fingerprint, later.fingerprint)
    }

    func testEngineMappingAndWindow() {
        XCTAssertEqual(CodeV2EngineMapping.engineModelID(for: .init(instanceId: "alevr", model: "openai:gpt-6.1")), "openai:gpt-6.1")
        XCTAssertEqual(CodeV2EngineMapping.engineModelID(for: .init(instanceId: "byok:google", model: "gemini-3.5-pro")), "google:gemini-3.5-pro")
        XCTAssertNil(CodeV2EngineMapping.engineModelID(for: .init(instanceId: "codex:default", model: "gpt-6.1-codex")))
        XCTAssertEqual(CodeV2EngineMapping.contextWindow(for: .init(instanceId: "alevr", model: "m", contextTokens: 272_000), lean: true), CodeV2ContextMath.leanWindow)
        XCTAssertEqual(CodeV2EngineMapping.contextWindow(for: .init(instanceId: "alevr", model: "m", contextTokens: 272_000), lean: false), 272_000)
        XCTAssertEqual(SessionController.effectiveContextWindow(model: 400_000, override: 128_000), 128_000)
        XCTAssertEqual(SessionController.effectiveContextWindow(model: 272_000, override: 1_000_000), 272_000, "never more than the model has")
        XCTAssertEqual(SessionController.effectiveContextWindow(model: 272_000, override: nil), 272_000)
        XCTAssertEqual(SessionController.effectiveContextWindow(model: nil, override: 128_000), 128_000)
    }
}

private final class BillingLog: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [(CodeV2SubagentBilling, Int?)] = []
    func append(_ billing: CodeV2SubagentBilling, _ tokens: Int?) { lock.withLock { stored.append((billing, tokens)) } }
    var entries: [(CodeV2SubagentBilling, Int?)] { lock.withLock { stored } }
}

// MARK: - A subscription child through the env server

final class EnvServerSubagentClientTests: XCTestCase {
    private func assistant(_ id: String, turn: String, _ text: String, agent: String? = nil) -> CodeV2.TurnItem {
        .assistantMessage(CodeV2.AssistantMessage(id: id, turnId: turn, createdAt: "2026-10-09T10:00:00Z", text: text, agentId: agent))
    }

    func testTheChildsTaskIsOneVendorTurnAndItsClosingTextIsTheReply() async throws {
        let server = FakeEnvServer()
        server.handle = { [unowned self] command in
            switch command.kind {
            case .sessionOpen:
                return .init(result: FakeEnvServer.value(["sessionId": "env-1"]))
            case .turnStart:
                return .init(result: FakeEnvServer.value(["turnId": "turn-1"]), events: [
                    FakeEnvServer.event("env-1", 1, .itemAdded(self.assistant("m1", turn: "turn-1", "Looking at the tests."))),
                    FakeEnvServer.event("env-1", 2, .itemAdded(self.assistant("m9", turn: "turn-1", "child noise", agent: "a1"))),
                    FakeEnvServer.event("env-1", 3, .itemAdded(self.assistant("m2", turn: "turn-1", "Fixed"))),
                    FakeEnvServer.event("env-1", 4, .itemDelta(itemId: "m2", field: "text", append: " the flaky upload test.")),
                    FakeEnvServer.event("env-1", 5, .turnCompleted(
                        turnId: "turn-1", outcome: .completed,
                        usage: CodeV2.SessionUsage(inputTokens: 1_200, outputTokens: 300)
                    )),
                ])
            default:
                return .init()
            }
        }
        let connection = EnvServerConnection(transport: server, commandTimeout: .seconds(5))
        await connection.start()
        let client = EnvServerSubagentClient(
            selection: CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "claude-opus-5-5"),
            cwd: "/tmp/repo", runtimeMode: .autoEdit, connect: { connection }
        )
        let request = ModelTurnRequest(
            sessionID: CodeSessionID(), systemPrompt: "You are a sub-agent.",
            messages: [.user("Fix the flaky upload test in tests/upload.test.ts.")], tools: [],
            modelID: "claude-opus-5-5", reasoningEffort: nil
        )
        var text = ""
        var usage: (Int?, Int?)?
        var stop: ModelStopReason?
        for try await event in client.streamTurn(request) {
            switch event {
            case let .textDelta(delta): text += delta
            case let .usage(input, output): usage = (input, output)
            case let .turnCompleted(reason): stop = reason
            default: break
            }
        }
        XCTAssertEqual(text, "Fixed the flaky upload test.")
        XCTAssertEqual(usage?.0, 1_200)
        XCTAssertEqual(usage?.1, 300)
        XCTAssertEqual(stop, .endTurn)
        let open = try XCTUnwrap(server.commands.first { $0.kind == .sessionOpen })
        XCTAssertEqual(open.params["cwd"]?.stringValue, "/tmp/repo")
        let start = try XCTUnwrap(server.commands.first { $0.kind == .turnStart })
        XCTAssertEqual(start.params["input"]?["text"]?.stringValue, "Fix the flaky upload test in tests/upload.test.ts.")
        XCTAssertEqual(start.params["runtimeMode"]?.stringValue, "auto-edit")
        let sessionId = await client.sessionId
        XCTAssertEqual(sessionId, "env-1")
        await connection.close()
    }

    func testCollectorAsksEachPendingApprovalOnceAndReadsLimits() {
        var collector = EnvSubagentTurnCollector(sessionId: "s", turnId: "t")
        let request = CodeV2.ApprovalRequest(
            id: "a", turnId: "t", createdAt: "2026-10-09T10:00:00Z", callId: "c", requestId: "r1",
            action: .command, summary: "npm test", status: .pending
        )
        XCTAssertEqual(collector.apply(.itemAdded(.approvalRequest(request))).map(\.requestId), ["r1"])
        XCTAssertTrue(collector.apply(.itemUpdated(.approvalRequest(request))).isEmpty, "asked once")
        _ = collector.apply(.sessionState(state: .limited, resumeAt: nil, message: "Claude limit until 3pm."))
        _ = collector.apply(.turnCompleted(turnId: "other", outcome: .completed, usage: nil))
        XCTAssertNil(collector.finished, "another turn's end is not ours")
        _ = collector.apply(.turnCompleted(turnId: "t", outcome: .limited, usage: nil))
        XCTAssertEqual(collector.finished?.outcome, .limited)
        XCTAssertEqual(collector.stateMessage, "Claude limit until 3pm.")
    }
}

// MARK: - Connected-agent approvals

@MainActor
final class CodeV2ConnectedApprovalsTests: XCTestCase {
    func testABridgeRequestWaitsForTheReadersCard() async {
        let approvals = CodeV2ConnectedApprovals()
        var summoned = 0
        approvals.summon = { summoned += 1 }
        let approver = StudioComputerBridgeApprover { request, sessionID, crop in
            await approvals.ask(request, sessionID: sessionID, crop: crop)
        }
        let answer = Task { await approver.allowAgent(sessionID: "env-1", title: "Fix the upload test") }
        let shown = await eventually { approvals.pending.count == 1 }
        XCTAssertTrue(shown)
        XCTAssertEqual(summoned, 1, "no window could show it, so the app is asked to bring one forward")
        let item = approvals.pending[0]
        XCTAssertEqual(item.request.action, .computer)
        XCTAssertEqual(item.request.options, [.acceptForSession, .decline])
        XCTAssertEqual(approvals.unclaimed.map(\.id), [item.id])
        approvals.showing(session: "env-1")
        XCTAssertTrue(approvals.unclaimed.isEmpty, "the thread on screen shows it in its composer")
        XCTAssertEqual(approvals.pending(forSession: "env-1").map(\.id), [item.id])
        approvals.respond(item.id, .acceptForSession)
        let allowed = await answer.value
        XCTAssertTrue(allowed)
        XCTAssertTrue(approvals.pending.isEmpty)
    }

    func testDeclineAndQuitBothSayNo() async {
        let approvals = CodeV2ConnectedApprovals()
        approvals.attachPresenter()
        var summoned = 0
        approvals.summon = { summoned += 1 }
        let approver = StudioComputerBridgeApprover { request, sessionID, crop in
            await approvals.ask(request, sessionID: sessionID, crop: crop)
        }
        let grant = ScreenApprovalDetail.takeover(sessionID: "env-2", display: "Built-in Display")
        let first = Task { await approver.approve(grant, summary: "Take over the screen", sessionID: "env-2") }
        _ = await eventually { approvals.pending.count == 1 }
        XCTAssertEqual(summoned, 0, "a window card is already attached")
        approvals.respond(approvals.pending[0].id, .decline)
        let firstAllowed = await first.value
        XCTAssertFalse(firstAllowed)
        let second = Task { await approver.approve(grant, summary: "Take over the screen", sessionID: "env-2") }
        _ = await eventually { approvals.pending.count == 1 }
        approvals.declineAll()
        let secondAllowed = await second.value
        XCTAssertFalse(secondAllowed)
    }
}

// MARK: - The overlay panel

@MainActor
final class ComputerActionOverlayPanelTests: XCTestCase {
    func testThePanelNeverTakesClicksFocusOrTheCapture() {
        let panel = ComputerActionOverlayWindow.makePanel()
        XCTAssertTrue(panel.ignoresMouseEvents)
        XCTAssertFalse(panel.canBecomeKey)
        XCTAssertEqual(panel.sharingType, .none, "never in a screenshot the agent is sent")
        XCTAssertEqual(panel.level, .screenSaver)
        XCTAssertFalse(panel.hidesOnDeactivate)
        XCTAssertTrue(panel.collectionBehavior.contains(.canJoinAllSpaces))
        XCTAssertTrue(panel.collectionBehavior.contains(.fullScreenAuxiliary))
        XCTAssertTrue(panel.styleMask.contains(.nonactivatingPanel))
    }
}

// MARK: - Antigravity: install and sign in through the env server

@MainActor
final class CodeV2ManagedRuntimeTests: XCTestCase {
    private let id = "acp:antigravity"

    func testSignInOpensGooglesPageAndThePasteFallbackSendsTheRedirect() async throws {
        let server = FakeEnvServer()
        server.handle = { command in
            guard command.type == "provider.auth" else { return .init() }
            switch command.params["action"]?.stringValue {
            case "start":
                return .init(result: .object(["auth": .object([
                    "phase": .string("waiting"), "flowId": .string("flow-1"),
                    "authorizationUrl": .string("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"),
                ])]))
            case "complete":
                return .init(result: .object(["auth": .object(["phase": .string("succeeded")])]))
            default:
                return .init(result: .object(["auth": .object(["phase": .string("cancelled")])]))
            }
        }
        let connection = EnvServerConnection(transport: server, commandTimeout: .seconds(5))
        let hub = EnvServerHub(connection: connection)
        var opened: [URL] = []
        hub.openURL = { opened.append($0) }
        XCTAssertTrue(hub.managesRuntime(id))
        XCTAssertFalse(hub.managesRuntime("codex:default"))

        await hub.signIn(id)
        XCTAssertEqual(hub.runtimeSetup[id]?.auth?.phase, .waiting)
        XCTAssertEqual(opened.map(\.host), ["accounts.google.com"])

        let refused = await hub.completeSignIn(id, redirect: "https://evil.example/?code=1")
        XCTAssertFalse(refused)
        XCTAssertNotNil(hub.runtimeSetup[id]?.pasteError)
        XCTAssertFalse(server.commands.contains { $0.params["action"]?.stringValue == "complete" }, "a non-loopback address is never sent")

        let done = await hub.completeSignIn(id, redirect: "  http://127.0.0.1:51121/oauth-callback?code=abc&state=s  ")
        XCTAssertTrue(done)
        let complete = try XCTUnwrap(server.commands.first { $0.params["action"]?.stringValue == "complete" })
        XCTAssertEqual(complete.params["flowId"]?.stringValue, "flow-1")
        XCTAssertEqual(complete.params["callbackUrl"]?.stringValue, "http://127.0.0.1:51121/oauth-callback?code=abc&state=s")
        XCTAssertNil(hub.runtimeSetup[id]?.pasteError)
        XCTAssertTrue(server.commands.contains { $0.kind == .providerProbe }, "a finished sign-in re-checks the instance")
        await connection.close()
    }

    func testInstallProgressArrivesOnProviderUpdated() async throws {
        let server = FakeEnvServer()
        server.handle = { command in
            if command.type == "provider.install" {
                return .init(result: .object(["install": .object(["phase": .string("downloading"), "operationId": .string("op-1")])]))
            }
            return .init()
        }
        let connection = EnvServerConnection(transport: server, commandTimeout: .seconds(5))
        let hub = EnvServerHub(connection: connection)
        await hub.installRuntime(id)
        XCTAssertEqual(hub.runtimeSetup[id]?.install?.operationId, "op-1")
        server.emitRaw("""
            {"type":"event","stream":"global","sequence":7,"at":"2026-10-09T10:00:00Z","event":{"type":"provider.updated","instance":{"id":"acp:antigravity","kind":"acp","label":"Antigravity","status":"not-installed","install":{"phase":"downloading","operationId":"op-1","downloadedBytes":35651584,"totalBytes":125829120}}}}
            """)
        let progressed = await eventually { hub.runtimeSetup[self.id]?.install?.downloadedBytes == 35_651_584 }
        XCTAssertTrue(progressed)
        let install = try XCTUnwrap(hub.runtimeSetup[id]?.install)
        XCTAssertEqual(CodeV2ManagedRuntimeDetail.progress(install), "Downloading 34 of 120 MB")
        XCTAssertEqual(hub.instances?.first?.id, "acp:antigravity", "the instance itself still updates")
        await hub.cancelInstall(id)
        let cancel = try XCTUnwrap(server.commands.last)
        XCTAssertEqual(cancel.params["action"]?.stringValue, "cancel")
        XCTAssertEqual(cancel.params["operationId"]?.stringValue, "op-1")
        await connection.close()
    }

    func testOnlyWebPagesOpenAndOnlyLoopbackRedirectsAreSent() {
        XCTAssertNotNil(EnvRuntimeSetup.isOpenableAuthorizationURL("https://accounts.google.com/o/oauth2/v2/auth"))
        XCTAssertNil(EnvRuntimeSetup.isOpenableAuthorizationURL("file:///etc/passwd"))
        XCTAssertNil(EnvRuntimeSetup.isOpenableAuthorizationURL("javascript:alert(1)"))
        XCTAssertTrue(EnvRuntimeSetup.isLoopbackRedirect("http://localhost:8080/cb?code=1"))
        XCTAssertTrue(EnvRuntimeSetup.isLoopbackRedirect("http://127.0.0.1:51121/oauth-callback?code=abc"))
        XCTAssertFalse(EnvRuntimeSetup.isLoopbackRedirect("http://127.0.0.1:51121/oauth-callback"), "no query, nothing to finish")
        XCTAssertFalse(EnvRuntimeSetup.isLoopbackRedirect("https://accounts.google.com/?code=1"))
        XCTAssertFalse(EnvRuntimeSetup.isLoopbackRedirect("http://127.0.0.1.evil.com/?code=1"))
    }
}
