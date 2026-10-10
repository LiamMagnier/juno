import JunoAPI
import JunoAuth
import JunoCodeCore
import JunoSync
import XCTest
@testable import JunoCodeRemote

/// The model against a scripted backend: pairs, host.info, the session list,
/// an open session streaming over polls, a gap re-opened from its cursor,
/// approvals, revert and the not-paired path.
@MainActor
final class CodeLinkRemoteModelTests: XCTestCase {
    final class Script: @unchecked Sendable {
        let lock = NSLock()
        var polls: [[[String: Any]]] = []
        var notPaired = false

        func nextPoll() -> [[String: Any]] {
            lock.withLock { polls.isEmpty ? [] : polls.removeFirst() }
        }
    }

    private static func event(_ sequence: Int, _ event: [String: Any], session: String = "s1") -> [String: Any] {
        ["type": "event", "stream": "session", "sessionId": session, "sequence": sequence, "at": "2026-10-10T10:00:0\(sequence % 10)Z", "event": event]
    }

    private func makeModel(_ script: Script) -> (CodeLinkRemoteModel, FakeSender) {
        let sender = FakeSender { request in
            if request.path == "/api/code/pairing/pairs" {
                return FakeSender.json(["pairs": [[
                    "id": "p1", "kind": "phone", "name": "iPhone", "platform": "ios", "deviceId": "mac1",
                    "deviceName": "Studio", "createdAt": "2026-10-10T09:00:00Z", "lastUsedAt": "2026-10-10T09:00:00Z",
                ]]])
            }
            if request.path.hasPrefix("/api/sync/threads") {
                return FakeSender.json(["thread": NSNull(), "threads": [], "cursor": NSNull()])
            }
            if script.notPaired {
                return FakeSender.json(["message": "Pair it on Studio.", "code": "not_paired"], status: 403)
            }
            let (kind, type) = FakeSender.command(request)
            if kind == "poll" { return FakeSender.json(["events": script.nextPoll()]) }
            switch type {
            case "host.info":
                return FakeSender.rpcReply(request, result: ["name": "Studio", "sharedFolders": ["/Users/me/code"], "terminal": true, "captures": ["preview"]])
            case "session.list":
                return FakeSender.rpcReply(request, result: ["sessions": [[
                    "id": "s1", "cwd": "/Users/me/code/shop", "title": "Fix the cart", "state": "idle",
                    "selection": ["instanceId": "alevr", "model": "claude-sonnet-5-5"], "updatedAt": "2026-10-10T09:00:00Z", "lastSequence": 3,
                ]]])
            case "provider.list":
                let data = try! JSONEncoder().encode(Fixture.providers)
                return FakeSender.rpcReply(request, result: ["instances": try! JSONSerialization.jsonObject(with: data)])
            case "skills.list": return FakeSender.rpcReply(request, result: ["skills": []])
            case "session.open": return FakeSender.rpcReply(request, result: ["sessionId": "s1"])
            case "turn.start": return FakeSender.rpcReply(request, result: ["turnId": "t9"])
            case "turn.queue": return FakeSender.rpcReply(request, result: ["queuedId": "q1"])
            case "turn.steer": return FakeSender.rpcReply(request, result: ["accepted": true])
            case "checkpoint.applyPatch": return FakeSender.rpcReply(request, result: ["applied": true, "files": ["a.ts"]])
            default: return FakeSender.rpcReply(request)
            }
        }
        let model = CodeLinkRemoteModel(sender: sender, sleep: { _ in try await Task.sleep(for: .milliseconds(5)) })
        model.start(for: Fixture.account)
        return (model, sender)
    }

    private func snapshotEvent(_ sequence: Int, state: String = "running", items: [[String: Any]] = []) -> [String: Any] {
        Self.event(sequence, [
            "type": "session.snapshot", "snapshotSequence": sequence,
            "session": [
                "id": "s1", "cwd": "/Users/me/code/shop", "title": "Fix the cart",
                "selection": ["instanceId": "alevr", "model": "claude-sonnet-5-5"],
                "runtimeMode": "full", "interactionMode": "default", "state": state, "activeTurnId": "t1",
                "items": items, "queue": [],
            ],
        ])
    }

    func testMacsSessionsAndAnOpenThreadStream() async throws {
        let script = Script()
        let (model, sender) = makeModel(script)
        await model.refreshMacs()
        XCTAssertEqual(model.macs.map(\.name), ["Studio"])
        XCTAssertEqual(model.selectedMac?.reachability, .online)
        XCTAssertEqual(model.selectedMac?.stateLine, "Online, sharing 1 folder")

        await model.select("mac1")
        XCTAssertEqual(model.orderedSessions.map(\.id), ["s1"])
        XCTAssertEqual(model.catalogue.map(\.id), ["alevr", "claude-agent:default"])
        XCTAssertEqual(model.composer.selection?.model, "claude-sonnet-5-5")

        script.polls = [
            [snapshotEvent(4, items: [[
                "kind": "assistant_message", "id": "m1", "turnId": "t1", "createdAt": "2026-10-10T10:00:00Z", "text": "Look", "streaming": true,
            ]])],
            [Self.event(5, ["type": "item.delta", "itemId": "m1", "field": "text", "append": "ing"])],
            // A hole: 6 is missing.
            [Self.event(7, ["type": "item.delta", "itemId": "m1", "field": "text", "append": "!"])],
        ]
        await model.open("s1")
        XCTAssertEqual(sender.commands.last { $0.type == "session.open" }?.params["sessionId"] as? String, "s1")
        XCTAssertEqual(model.composer.runtimeMode, .ask, "no snapshot yet")

        let link = Task { await model.runLink() }
        try await waitUntil { sender.commands.filter { $0.type == "session.open" }.count >= 2 }
        link.cancel()

        guard case let .assistantMessage(m)? = model.openThread?.item("m1") else { return XCTFail("no message") }
        XCTAssertEqual(m.text, "Looking")
        XCTAssertEqual(model.openThread?.cursor, 5)
        let reopen = try XCTUnwrap(sender.commands.last { $0.type == "session.open" })
        XCTAssertEqual(reopen.params["afterSequence"] as? Int, 5)
        XCTAssertEqual(reopen.params["cwd"] as? String, "/Users/me/code/shop")
        XCTAssertTrue(model.isRunning)
    }

    func testSendStartsATurnWhenIdleAndQueuesWhileRunning() async throws {
        let script = Script()
        let (model, sender) = makeModel(script)
        await model.refreshMacs()
        await model.select("mac1")
        await model.open("s1")
        model.receive([try decode(snapshotEvent(4, state: "idle"))], deviceID: "mac1")
        XCTAssertEqual(model.composer.runtimeMode, .ask)
        model.composer.runtimeMode = .full

        await model.send("Add a test")
        let start = try XCTUnwrap(sender.commands.last)
        XCTAssertEqual(start.type, "turn.start")
        XCTAssertEqual(start.params["runtimeMode"] as? String, "full")
        XCTAssertEqual((start.params["input"] as? [String: Any])?["text"] as? String, "Add a test")

        model.receive([try decode(Self.event(5, ["type": "turn.started", "turnId": "t9", "selection": ["instanceId": "alevr", "model": "claude-sonnet-5-5"]]))], deviceID: "mac1")
        XCTAssertTrue(model.isRunning)
        XCTAssertNil(model.lastError)
        await model.send("then lint")
        XCTAssertEqual(sender.commands.last?.type, "turn.queue")
        XCTAssertNil(model.lastError)

        await model.steer("use the helper")
        let steer = try XCTUnwrap(sender.commands.first { $0.type == "turn.steer" })
        XCTAssertEqual(steer.params["turnId"] as? String, "t9")

        await model.interrupt()
        XCTAssertEqual(sender.commands.last?.type, "turn.interrupt")
        XCTAssertEqual(sender.commands.last?.params["turnId"] as? String, "t9")

        await model.respond(to: "req-a1", decision: .acceptForSession)
        XCTAssertEqual(sender.commands.last?.type, "approval.respond")
        XCTAssertEqual(sender.commands.last?.params["decision"] as? String, "acceptForSession")
    }

    func testRevertChecksThenAppliesInReverse() async throws {
        let script = Script()
        let (model, sender) = makeModel(script)
        await model.refreshMacs()
        await model.select("mac1")
        await model.open("s1")
        let files = CodeV2UnifiedDiff.parse("""
        diff --git a/a.ts b/a.ts
        --- a/a.ts
        +++ b/a.ts
        @@ -1,1 +1,1 @@
        -old
        +new
        """)
        let ok = await model.revert(files[0].hunks[0], in: files[0])
        XCTAssertTrue(ok)
        let patches = sender.commands.filter { $0.type == "checkpoint.applyPatch" }
        XCTAssertEqual(patches.count, 2)
        XCTAssertEqual(patches[0].params["checkOnly"] as? Bool, true)
        XCTAssertNil(patches[1].params["checkOnly"])
        XCTAssertEqual(patches[1].params["reverse"] as? Bool, true)
    }

    func testNotPairedStopsTheLinkAndSaysSo() async throws {
        let script = Script()
        let (model, _) = makeModel(script)
        await model.refreshMacs()
        script.notPaired = true
        await model.select("mac1")
        XCTAssertEqual(model.linkError, .notPaired(message: "Pair it on Studio."))
        XCTAssertEqual(model.selectedMac?.reachability, .notPaired("Pair it on Studio."))
        XCTAssertEqual(model.selectedMac?.stateLine, "Not paired with this iPhone")
        await model.runLink() // returns instead of spinning
    }

    func testNewSessionOpensInTheChosenFolderThenStartsTheTurn() async throws {
        let script = Script()
        let (model, sender) = makeModel(script)
        await model.refreshMacs()
        await model.select("mac1")
        model.beginNewSession()
        XCTAssertEqual(model.browser?.rows.map(\.path), ["/Users/me/code"])
        let id = await model.createSession(cwd: "/Users/me/code/shop", worktree: true, prompt: "Make the cart faster")
        XCTAssertEqual(id, "s1")
        let open = try XCTUnwrap(sender.commands.first { $0.type == "session.open" })
        XCTAssertEqual(open.params["worktree"] as? Bool, true)
        XCTAssertNil(open.params["sessionId"])
        XCTAssertEqual(sender.commands.last?.type, "turn.start")
        XCTAssertEqual(model.openSessionID, "s1")
    }

    // MARK: Helpers

    private func decode(_ object: [String: Any]) throws -> CodeV2.ServerEventEnvelope {
        try JSONDecoder().decode(CodeV2.ServerEventEnvelope.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func waitUntil(_ condition: @escaping () -> Bool) async throws {
        for _ in 0..<400 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out")
    }
}
