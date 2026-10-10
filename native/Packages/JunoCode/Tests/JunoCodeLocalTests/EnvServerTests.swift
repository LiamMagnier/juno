import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The Mac's env-server plumbing (Code v2 SPEC §2, §6 "mac"): the sidecar's
/// launch plan, the WebSocket client's request / event handling, the Terminal
/// setup launcher, BYOK key shapes and the device link relay.
final class EnvServerTests: XCTestCase {
    // MARK: Sidecar

    /// The server exits when its stdin ends (the app went away). The sidecar
    /// must hold stdin open, or the server dies right after its handshake:
    /// Mac 1.10.3 shipped /dev/null there and Connections never connected.
    func testTheServerOutlivesItsHandshakeBecauseStdinStaysOpen() async throws {
        guard let node = EnvServerLaunchPlanner.findNode() else { throw XCTSkip("no Node on this machine") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sidecar-stdin-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let script = dir.appendingPathComponent("fake-env.mjs")
        // Same contract as runner/env-server/src/bin.ts: handshake line, exit on stdin end.
        try """
        const i = process.argv.indexOf("--port");
        const port = Number(process.argv[i + 1]);
        process.stdout.write(JSON.stringify({ alevrEnv: 1, port }) + "\\n");
        process.stdin.on("end", () => process.exit(0));
        process.stdin.resume();
        setInterval(() => {}, 1000);
        """.write(to: script, atomically: true, encoding: .utf8)
        let entry = EnvServerEntry(url: script, kind: .javascript, packageRoot: dir)
        let sidecar = EnvServerSidecar(
            resolveEntry: { entry }, resolveNode: { node }, diagnoseNode: { .success(node) },
            dataDirectory: dir.appendingPathComponent("data"), readinessTimeout: .seconds(10)
        )
        let launch = try await sidecar.start()
        let held = await sidecar.holdsServerStdin
        XCTAssertTrue(held)
        try await Task.sleep(for: .milliseconds(1500))
        guard case .running = await sidecar.currentState else {
            return XCTFail("the server exited after its handshake: \(await sidecar.currentState)")
        }
        if let pid = launch.pid { XCTAssertEqual(kill(pid, 0), 0, "server process is alive") }
        await sidecar.stop()
        let released = await sidecar.holdsServerStdin
        XCTAssertFalse(released)
    }

    func testTokensAreLongAndURLSafe() {
        let a = EnvServerLaunchPlanner.makeToken()
        let b = EnvServerLaunchPlanner.makeToken()
        XCTAssertEqual(a.count, 43)
        XCTAssertNotEqual(a, b)
        XCTAssertNil(a.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
    }

    func testFreePortIsALoopbackPort() throws {
        let port = try XCTUnwrap(EnvServerLaunchPlanner.freePort())
        XCTAssertTrue((1...65_535).contains(port))
    }

    func testLaunchPlanPassesOnlyIdentityAndToolchain() {
        let entry = EnvServerEntry(url: URL(fileURLWithPath: "/repo/runner/env-server/src/bin.ts"), kind: .typescript, packageRoot: URL(fileURLWithPath: "/repo/runner/env-server"))
        let plan = EnvServerLaunchPlanner.plan(
            entry: entry, node: URL(fileURLWithPath: "/opt/node/bin/node"), port: 4567, token: "tok",
            dataDirectory: URL(fileURLWithPath: "/data"),
            base: ["HOME": "/Users/maya", "AWS_SECRET_ACCESS_KEY": "nope", "OPENAI_API_KEY": "nope"],
            path: "/usr/bin:/bin"
        )
        XCTAssertEqual(plan.arguments, ["--import", "tsx", "/repo/runner/env-server/src/bin.ts", "--host", "127.0.0.1", "--port", "4567", "--data-dir", "/data"])
        XCTAssertEqual(plan.environment["ALEVR_ENV_TOKEN"], "tok")
        XCTAssertEqual(plan.environment["HOME"], "/Users/maya")
        XCTAssertEqual(plan.environment["PATH"], "/usr/bin:/bin")
        XCTAssertNil(plan.environment["AWS_SECRET_ACCESS_KEY"])
        XCTAssertNil(plan.environment["OPENAI_API_KEY"])
        XCTAssertEqual(plan.webSocketURL.absoluteString, "ws://127.0.0.1:4567/")
        XCTAssertEqual(plan.workingDirectory?.path, "/repo/runner/env-server")
    }

    func testEntryResolutionPrefersOverrideThenBundleThenCheckout() {
        let files: Set<String> = [
            "/override/main.mjs",
            "/App.app/Contents/Resources/env-server/alevr-env.mjs",
            "/repo/runner/env-server/src/bin.ts",
            "/repo/runner/env-server/src/index.ts",
        ]
        let exists: (String) -> Bool = { files.contains($0) }
        let override = EnvServerEntry.resolve(
            environment: ["ALEVR_ENV_SERVER_ENTRY": "/override/main.mjs"],
            bundleResources: URL(fileURLWithPath: "/App.app/Contents/Resources"),
            searchRoots: [], fileExists: exists
        )
        XCTAssertEqual(override?.url.path, "/override/main.mjs")
        let bundled = EnvServerEntry.resolve(
            environment: [:], bundleResources: URL(fileURLWithPath: "/App.app/Contents/Resources"),
            searchRoots: [], fileExists: exists
        )
        XCTAssertEqual(bundled?.url.path, "/App.app/Contents/Resources/env-server/alevr-env.mjs")
        let checkout = EnvServerEntry.resolve(
            environment: [:], bundleResources: nil,
            searchRoots: [URL(fileURLWithPath: "/repo/native/macOS/build/Debug")], fileExists: exists
        )
        XCTAssertEqual(checkout?.url.path, "/repo/runner/env-server/src/bin.ts", "bin starts the server; index is only the library")
        XCTAssertEqual(checkout?.kind, .typescript)
        XCTAssertNil(EnvServerEntry.resolve(environment: [:], bundleResources: nil, searchRoots: [], fileExists: { _ in false }))
    }

    func testReadyLineAndRestartBackoff() {
        XCTAssertEqual(EnvServerLaunchPlanner.readyPort(in: "ALEVR_ENV_READY {\"port\":51234}"), 51_234)
        XCTAssertNil(EnvServerLaunchPlanner.readyPort(in: "listening on 51234"))
        XCTAssertNil(EnvServerLaunchPlanner.readyPort(in: "ALEVR_ENV_READY {\"port\":0}"))
        // The handshake line runner/env-server/src/bin.ts prints.
        XCTAssertEqual(EnvServerLaunchPlanner.readyPort(in: #"{"alevrEnv":1,"port":53001,"token":"t","pid":42}"#), 53_001)
        XCTAssertNil(EnvServerLaunchPlanner.readyPort(in: #"{"port":53001}"#), "only the env server's own handshake")
        XCTAssertEqual(EnvServerLaunchPlanner.restartDelay(attempt: 1), 1)
        XCTAssertEqual(EnvServerLaunchPlanner.restartDelay(attempt: 5), 16)
        XCTAssertNil(EnvServerLaunchPlanner.restartDelay(attempt: 6))
    }

    // MARK: Connection

    func testConnectionCorrelatesResponsesAndStreamsEvents() async throws {
        let transport = ScriptedTransport()
        let connection = EnvServerConnection(transport: transport, commandTimeout: .seconds(5))
        await connection.start()
        let events = await connection.events()

        transport.onSend = { text in
            let command = try JSONDecoder().decode(CodeV2.ClientCommand.self, from: Data(text.utf8))
            XCTAssertEqual(command.type, .providerList)
            transport.push("""
                {"type":"event","stream":"global","sequence":1,"at":"2026-10-09T10:00:00Z","event":{"type":"provider.updated","instance":{"id":"codex:default","kind":"codex","label":"ChatGPT (Codex)","status":"signed-out"}}}
                """)
            transport.push("""
                {"type":"response","id":"\(command.id)","ok":true,"result":{"instances":[{"id":"codex:default","kind":"codex","label":"ChatGPT (Codex)","status":"ready"}]}}
                """)
        }
        let instances = try await connection.providerList()
        XCTAssertEqual(instances.map(\.id), ["codex:default"])
        var iterator = events.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first?.stream, .global)

        transport.onSend = { text in
            let command = try JSONDecoder().decode(CodeV2.ClientCommand.self, from: Data(text.utf8))
            transport.push("""
                {"type":"response","id":"\(command.id)","ok":false,"error":{"code":"not_found","message":"No such session."}}
                """)
        }
        do {
            _ = try await connection.turnSteer(sessionId: "s", turnId: "t", input: CodeV2.UserInput(text: "x"))
            XCTFail("expected an error")
        } catch let EnvServerConnectionError.server(code, message) {
            XCTAssertEqual(code, .notFound)
            XCTAssertEqual(message, "No such session.")
        }
        await connection.close()
    }

    func testConnectionFailsPendingCommandsWhenTheSocketCloses() async {
        let transport = ScriptedTransport()
        let connection = EnvServerConnection(transport: transport, commandTimeout: .seconds(5))
        transport.onSend = { _ in transport.finish() }
        do {
            _ = try await connection.providerList()
            XCTFail("expected closed")
        } catch {
            XCTAssertEqual(error as? EnvServerConnectionError, .closed)
        }
    }

    // MARK: Terminal launcher

    func testTerminalScriptTypesTheCommandWithoutRunningIt() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("alevr-terminal-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let opened = OpenedFiles()
        let launcher = TerminalCommandLauncher(directory: directory, opener: { opened.append($0) })
        let script = try launcher.open(command: "claude auth login", title: "Sign in to Claude", workingDirectory: "/tmp/it's")
        XCTAssertEqual(opened.files, [script.commandFile])
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: script.commandFile.path))
        let zshrc = try String(contentsOf: script.zdotdir.appendingPathComponent(".zshrc"), encoding: .utf8)
        XCTAssertTrue(zshrc.contains("print -z -- 'claude auth login'"))
        XCTAssertFalse(script.commandFileContents.contains("claude auth login"), "the command is typed at the prompt, never run by the script")
        XCTAssertTrue(script.commandFileContents.contains("cd '/tmp/it'\\''s'"))
        XCTAssertEqual(TerminalCommandLauncher.shellQuote("a'b"), "'a'\\''b'")
    }

    // MARK: BYOK

    func testKeyShapeChecksThePrefix() {
        XCTAssertEqual(try ByokKeyShape.check("  sk-ant-api03-0123456789abcdef  ", for: .anthropic).get(), "sk-ant-api03-0123456789abcdef")
        XCTAssertThrowsError(try ByokKeyShape.check("sk-proj-123", for: .anthropic).get())
        XCTAssertThrowsError(try ByokKeyShape.check("", for: .openai).get())
    }

    func testAccountStoreMapsTheWebAPI() async throws {
        let store = ByokAccountStore { method, path, body in
            switch (method, path) {
            case ("GET", "/api/provider-keys"):
                return (200, Data(#"{"keys":[{"provider":"anthropic","keyHint":"sk-ant-…4f2a","status":"valid","createdAt":"2026-10-01T09:00:00Z"},{"provider":"mystery","keyHint":"x","status":"valid","createdAt":"2026-10-01T09:00:00Z"}]}"#.utf8))
            case ("POST", "/api/provider-keys"):
                let object = try JSONSerialization.jsonObject(with: body ?? Data()) as? [String: String]
                XCTAssertEqual(object?["provider"], "openai")
                return (422, Data(#"{"error":"OpenAI refused this key."}"#.utf8))
            default:
                return (500, Data())
            }
        }
        let records = try await store.records()
        XCTAssertEqual(records.map(\.provider), [.anthropic])
        XCTAssertEqual(records.first?.location, .account)
        do {
            _ = try await store.save("sk-proj-0123456789abcdef0123", for: .openai)
            XCTFail("expected a rejection")
        } catch {
            XCTAssertEqual(error as? ByokKeyStoreError, .rejected("OpenAI refused this key."))
        }
    }

    // MARK: Device link

    private func makeLink(forwarded: ForwardLog, terminal: Bool = false) -> EnvServerDeviceLink {
        EnvServerDeviceLink(
            allowedRoots: { ["/Users/maya/code/shop"] },
            allowsTerminal: { terminal },
            forward: { type, params in
                forwarded.append(type)
                if type == .sessionOpen { return .object(["sessionId": .string("s-new")]) }
                if type == .turnStart { return .object(["turnId": .string("t1")]) }
                return .object([:])
            }
        )
    }

    func testLinkRefusesLocalOnlyAndUnsharedWork() async {
        let forwarded = ForwardLog()
        let link = makeLink(forwarded: forwarded)
        func rpc(_ type: String, _ params: [String: JSONValue]) async -> CodeV2.ServerResponse? {
            await link.handle(EnvLinkRequest(kind: .rpc, command: .init(id: "1", type: type, params: .object(params)))).responses?.first
        }
        let configure = await rpc("env.configure", ["byok": .array([])])
        XCTAssertEqual(configure?.ok, false)
        XCTAssertEqual(configure?.error?.code, .unsupported)

        let terminal = await rpc("terminal.open", ["cwd": .string("/Users/maya/code/shop"), "cols": .number(80), "rows": .number(24)])
        XCTAssertEqual(terminal?.error?.code, .unsupported)

        let outside = await rpc("session.open", ["cwd": .string("/Users/maya/code/shop/../secrets")])
        XCTAssertEqual(outside?.error?.code, .badRequest)

        let unopened = await rpc("turn.start", ["sessionId": .string("someone-else")])
        XCTAssertEqual(unopened?.error?.code, .badRequest)
        XCTAssertEqual(forwarded.types, [])

        let opened = await rpc("session.open", ["cwd": .string("/Users/maya/code/shop/web")])
        XCTAssertEqual(opened?.ok, true)
        let started = await rpc("turn.start", ["sessionId": .string("s-new"), "input": .object(["text": .string("hi")])])
        XCTAssertEqual(started?.ok, true)
        XCTAssertEqual(forwarded.types, [.sessionOpen, .turnStart])
    }

    func testLinkRefusesAttachingToASessionOutsideSharedFolders() async {
        let forwarded = ForwardLog()
        let link = EnvServerDeviceLink(
            allowedRoots: { ["/Users/maya/code/shop"] },
            forward: { type, _ in
                forwarded.append(type)
                if type == .sessionList {
                    return .object(["sessions": .array([
                        .object(["id": .string("s-private"), "cwd": .string("/Users/maya/private")]),
                        .object(["id": .string("s-shop"), "cwd": .string("/Users/maya/code/shop")]),
                    ])])
                }
                if type == .sessionOpen { return .object(["sessionId": .string("s-shop")]) }
                return .object([:])
            }
        )
        func rpc(_ type: String, _ params: [String: JSONValue]) async -> CodeV2.ServerResponse? {
            await link.handle(EnvLinkRequest(kind: .rpc, command: .init(id: "1", type: type, params: .object(params)))).responses?.first
        }
        let sneaky = await rpc("session.open", ["sessionId": .string("s-private"), "cwd": .string("/Users/maya/code/shop")])
        XCTAssertEqual(sneaky?.error?.code, .badRequest)
        let follow = await rpc("turn.start", ["sessionId": .string("s-private"), "input": .object(["text": .string("hi")])])
        XCTAssertEqual(follow?.error?.code, .badRequest, "a refused open must not link the session")
        XCTAssertFalse(forwarded.types.contains(.sessionOpen))

        let fine = await rpc("session.open", ["sessionId": .string("s-shop"), "cwd": .string("/Users/maya/code/shop")])
        XCTAssertEqual(fine?.ok, true)

        let listed = await rpc("session.list", [:])
        XCTAssertEqual(EnvServerDeviceLink.sessionCwd("s-private", in: listed?.result), nil, "unshared sessions are not listed")
        XCTAssertEqual(EnvServerDeviceLink.sessionCwd("s-shop", in: listed?.result), "/Users/maya/code/shop")
    }

    func testLinkAllowsTheTerminalOnlyWhenShared() async {
        let forwarded = ForwardLog()
        let link = makeLink(forwarded: forwarded, terminal: true)
        let reply = await link.handle(EnvLinkRequest(kind: .rpc, command: .init(
            id: "1", type: "terminal.open",
            params: .object(["cwd": .string("/Users/maya/code/shop"), "cols": .number(80), "rows": .number(24)])
        )))
        XCTAssertEqual(reply.responses?.first?.ok, true)
    }

    func testOnlyTerminalsOpenedThroughTheLinkAreRelayedOrDriven() async {
        let forwarded = ForwardLog()
        let link = EnvServerDeviceLink(
            allowedRoots: { ["/Users/maya/code/shop"] },
            allowsTerminal: { true },
            forward: { type, _ in
                forwarded.append(type)
                return type == .terminalOpen ? .object(["terminalId": .string("t-remote")]) : .object([:])
            }
        )
        func rpc(_ type: String, _ params: [String: JSONValue]) async -> CodeV2.ServerResponse? {
            await link.handle(EnvLinkRequest(kind: .rpc, command: .init(id: "1", type: type, params: .object(params)))).responses?.first
        }
        // The Mac's own Dock › Terminal shell: never reachable from the web.
        let write = await rpc("terminal.write", ["terminalId": .string("t-local"), "data": .string("cat ~/.ssh/id_ed25519\r")])
        XCTAssertEqual(write?.error?.code, .badRequest)
        let reattach = await rpc("terminal.open", [
            "terminalId": .string("t-local"), "cwd": .string("/Users/maya/code/shop"), "cols": .number(80), "rows": .number(24),
        ])
        XCTAssertEqual(reattach?.error?.code, .badRequest, "re-attaching would repaint the local shell's scrollback")
        XCTAssertEqual(forwarded.types, [])

        let opened = await rpc("terminal.open", ["cwd": .string("/Users/maya/code/shop"), "cols": .number(80), "rows": .number(24)])
        XCTAssertEqual(opened?.ok, true)
        let typed = await rpc("terminal.write", ["terminalId": .string("t-remote"), "data": .string("ls\r")])
        XCTAssertEqual(typed?.ok, true)

        let global = { (sequence: Int, terminal: String) in
            CodeV2.ServerEventEnvelope(stream: .global, sessionId: nil, sequence: sequence, at: "2026-10-09T10:00:00Z", event: .terminalOutput(terminalId: terminal, data: "x"))
        }
        await link.record(global(1, "t-local"))
        await link.record(global(2, "t-remote"))
        let reply = await link.handle(EnvLinkRequest(kind: .poll, cursors: [:], globalCursor: 0), longPoll: .zero)
        XCTAssertEqual(reply.events?.map(\.sequence), [2])
        let localShared = await link.shareable(global(3, "t-local"))
        let remoteShared = await link.shareable(global(4, "t-remote"))
        XCTAssertFalse(localShared)
        XCTAssertTrue(remoteShared)
    }

    func testPollReturnsEventsPastTheCursorsAndLongPolls() async {
        let link = makeLink(forwarded: ForwardLog())
        let event = { (session: String, sequence: Int) in
            CodeV2.ServerEventEnvelope(sessionId: session, sequence: sequence, at: "2026-10-09T10:00:00Z", event: .sessionState(state: .running, resumeAt: nil, message: nil))
        }
        await link.record(event("s1", 1))
        await link.record(event("s1", 2))
        await link.record(event("s2", 1))
        await link.record(CodeV2.ServerEventEnvelope(sessionId: "s1", sequence: 3, at: "2026-10-09T10:00:00Z", event: .terminalOutput(terminalId: "t", data: "secret")))

        let reply = await link.handle(EnvLinkRequest(kind: .poll, cursors: ["s1": 1]), longPoll: .zero)
        XCTAssertEqual(reply.events?.map(\.sequence), [2], "s2 is not followed; terminal output is not shared")

        // Nothing new: the poll waits for the next event.
        async let waited = link.handle(EnvLinkRequest(kind: .poll, cursors: ["s1": 2]), longPoll: .seconds(5))
        try? await Task.sleep(for: .milliseconds(50))
        await link.record(event("s1", 4))
        let late = await waited
        XCTAssertEqual(late.events?.map(\.sequence), [4])
    }

    func testOfflineMacSaysSo() async {
        let link = EnvServerDeviceLink(isOnline: { false }, allowedRoots: { [] }, forward: { _, _ in nil })
        let reply = await link.handle(EnvLinkRequest(kind: .poll, cursors: [:]), longPoll: .zero)
        XCTAssertEqual(reply.offline, true)
    }

    func testPathContainment() {
        XCTAssertTrue(EnvServerDeviceLink.isInside("/a/b", roots: ["/a/b"]))
        XCTAssertTrue(EnvServerDeviceLink.isInside("/a/b/c", roots: ["/a/b/"]))
        XCTAssertFalse(EnvServerDeviceLink.isInside("/a/bc", roots: ["/a/b"]))
        XCTAssertFalse(EnvServerDeviceLink.isInside("/a/b/../c", roots: ["/a/b"]))
    }

    func testChannelPullsFromTheHubAndPushesResponsesAndEventsInOrder() async throws {
        let posted = PostLog()
        let link = makeLink(forwarded: ForwardLog())
        let channel = EnvServerDeviceLinkChannel(deviceId: "mac-1", link: link, appVersion: "1.11.0", flushDelay: .milliseconds(10)) { _, path, body in
            posted.append(path, body)
            let kind = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["kind"] as? String
            if kind == "pull" {
                return (200, Data(#"{"protocol":{"name":"alevr-code-v2","version":"1.0"},"commands":[{"id":"link_1","type":"session.open","params":{"cwd":"/Users/maya/code/shop"}},{"id":"link_2","type":"env.configure","params":{}}]}"#.utf8))
            }
            return (200, Data(#"{"accepted":1}"#.utf8))
        }
        // Pulls are driven by hand; `start()` would install this same hook and loop.
        await link.setOutbound { envelope in await channel.enqueue(.event(envelope)) }
        let delay = await channel.pullOnce()
        XCTAssertNil(delay)
        for _ in 0..<100 where posted.paths.count < 2 { try await Task.sleep(for: .milliseconds(20)) }
        // A session the link opened: its events go out; another session's do not.
        await link.record(CodeV2.ServerEventEnvelope(sessionId: "s-new", sequence: 1, at: "2026-10-09T10:00:00Z", event: .sessionState(state: .running, resumeAt: nil, message: nil)))
        await link.record(CodeV2.ServerEventEnvelope(sessionId: "elsewhere", sequence: 1, at: "2026-10-09T10:00:00Z", event: .sessionState(state: .running, resumeAt: nil, message: nil)))
        for _ in 0..<100 where posted.paths.count < 3 { try await Task.sleep(for: .milliseconds(20)) }

        XCTAssertTrue(posted.paths.allSatisfy { $0 == "/api/code/v2/link/mac-1/host" })
        let bodies = posted.bodies.compactMap { $0 }.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        XCTAssertEqual(bodies.first?["kind"] as? String, "pull")
        XCTAssertEqual(bodies.first?["protocol"] as? String, "alevr-code-v2")
        XCTAssertEqual(bodies.first?["appVersion"] as? String, "1.11.0")
        XCTAssertEqual(bodies.first?["terminal"] as? Bool, false, "the hub relays terminal.* only while this says true")
        let pushes = bodies.filter { $0["kind"] as? String == "push" }
        let responses = pushes.flatMap { ($0["responses"] as? [[String: Any]]) ?? [] }
        XCTAssertEqual(Set(responses.compactMap { $0["id"] as? String }), ["link_1", "link_2"])
        let refused = responses.first { $0["id"] as? String == "link_2" }
        XCTAssertEqual(refused?["ok"] as? Bool, false, "env.configure never runs from the web")
        let events = pushes.flatMap { ($0["events"] as? [[String: Any]]) ?? [] }
        XCTAssertEqual(events.compactMap { $0["sessionId"] as? String }, ["s-new"])
    }

    func testChannelStopsWhenThePairingIsGone() async {
        let link = makeLink(forwarded: ForwardLog())
        let channel = EnvServerDeviceLinkChannel(deviceId: "mac-1", link: link) { _, _, _ in (404, Data()) }
        _ = await channel.pullOnce()
        let reason = await channel.stoppedReason
        XCTAssertNotNil(reason)
    }

    func testLinkReopensAFollowedSessionForAReplay() async {
        let forwarded = ForwardLog()
        let link = makeLink(forwarded: forwarded)
        _ = await link.run(.init(id: "1", type: "session.open", params: .object(["cwd": .string("/Users/maya/code/shop")])))
        // The hub's synthetic replay open carries cwd "/", which is outside every shared folder.
        let replay = await link.run(.init(id: "replay_1", type: "session.open", params: .object(["sessionId": .string("s-new"), "cwd": .string("/"), "afterSequence": .number(3)])))
        XCTAssertEqual(replay.ok, true)
        let stranger = await link.run(.init(id: "2", type: "session.open", params: .object(["sessionId": .string("other"), "cwd": .string("/")])))
        XCTAssertEqual(stranger.error?.code, .badRequest)
    }

    // MARK: Node requirement (release: the app runs the bundle with the user's node)

    func testNodeOlderThanTheServerNeedsIsReportedPlainly() {
        XCTAssertTrue(EnvServerLaunchPlanner.isSupportedNode("v22.18.0"))
        XCTAssertTrue(EnvServerLaunchPlanner.isSupportedNode("v24.1.0"))
        XCTAssertFalse(EnvServerLaunchPlanner.isSupportedNode("v22.17.1"))
        XCTAssertFalse(EnvServerLaunchPlanner.isSupportedNode("v20.11.0"))
        XCTAssertFalse(EnvServerLaunchPlanner.isSupportedNode("garbage"))

        let versions = ["/old/node": "v20.11.0", "/new/node": "v24.2.0"]
        let executable: (String) -> Bool = { versions[$0] != nil }
        let found = EnvServerLaunchPlanner.locateNode(path: "/old:/new", isExecutable: executable, version: { versions[$0] })
        XCTAssertEqual(try? found.get(), URL(fileURLWithPath: "/new/node"), "a newer node later on PATH wins")

        let onlyOld = EnvServerLaunchPlanner.locateNode(path: "/old", isExecutable: executable, version: { versions[$0] })
        guard case let .failure(error) = onlyOld else { return XCTFail("old node accepted") }
        XCTAssertEqual(error, .nodeTooOld(version: "v20.11.0", path: "/old/node"))
        let sentence = error.errorDescription ?? ""
        XCTAssertTrue(sentence.contains("22.18"))
        XCTAssertTrue(sentence.contains("/old/node is v20.11.0"))
        XCTAssertFalse(sentence.contains("\u{2014}"), "no em-dashes in UI copy")

        let none = EnvServerLaunchPlanner.locateNode(path: "/nowhere", isExecutable: { _ in false }, version: { _ in nil })
        guard case .failure(.nodeNotFound) = none else { return XCTFail("expected nodeNotFound") }
    }
}

extension EnvServerTests {
    private func git(_ args: [String], in dir: URL) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"] + args
        process.currentDirectoryURL = dir
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }

    func testHunkApplierAcceptsAndRejectsOneHunk() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("alevr-hunks-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("a.txt")
        let original = (1...30).map { "line \($0)" }.joined(separator: "\n") + "\n"
        try original.write(to: file, atomically: true, encoding: .utf8)
        _ = try git(["init", "-q"], in: dir)
        _ = try git(["add", "."], in: dir)
        _ = try git(["commit", "-q", "-m", "base"], in: dir)
        var lines = original.split(separator: "\n").map(String.init)
        lines[1] = "line 2 changed"
        lines[27] = "line 28 changed"
        try (lines.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)

        let files = CodeV2UnifiedDiff.parse(try git(["diff"], in: dir))
        XCTAssertEqual(files.first?.hunks.count, 2)
        let applier = CodeV2HunkApplier()
        try await applier.apply(.reject, hunk: files[0].hunks[1], path: "a.txt", in: dir)
        let after = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(after.contains("line 2 changed"))
        XCTAssertFalse(after.contains("line 28 changed"))

        try await applier.apply(.accept, hunk: files[0].hunks[0], path: "a.txt", in: dir)
        XCTAssertTrue(try git(["diff", "--cached"], in: dir).contains("+line 2 changed"))

        do {
            try await applier.apply(.reject, hunk: files[0].hunks[1], path: "a.txt", in: dir)
            XCTFail("a hunk already reversed cannot be reversed again")
        } catch {
            XCTAssertNotNil(error as? CodeV2HunkApplier.Failure)
        }
    }
}

// MARK: - Test doubles

final class ScriptedTransport: EnvServerTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [String?] = []
    private var waiting: CheckedContinuation<String?, Error>?
    var onSend: ((String) throws -> Void)?

    func send(_ text: String) async throws {
        try onSend?(text)
    }

    func push(_ frame: String?) {
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

    func finish() { push(nil) }

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

    func close() async { finish() }
}

final class OpenedFiles: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [URL] = []
    func append(_ url: URL) { lock.withLock { stored.append(url) } }
    var files: [URL] { lock.withLock { stored } }
}

final class ForwardLog: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [CodeV2.ClientCommandType] = []
    func append(_ type: CodeV2.ClientCommandType) { lock.withLock { stored.append(type) } }
    var types: [CodeV2.ClientCommandType] { lock.withLock { stored } }
}

final class PostLog: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [(String, Data?)] = []
    func append(_ path: String, _ body: Data?) { lock.withLock { stored.append((path, body)) } }
    var paths: [String] { lock.withLock { stored.map(\.0) } }
    var bodies: [Data?] { lock.withLock { stored.map(\.1) } }
}
