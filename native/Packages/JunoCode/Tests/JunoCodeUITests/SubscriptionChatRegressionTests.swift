import Foundation
import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeUI

@MainActor
final class SubscriptionChatRegressionTests: XCTestCase {
    func testFirstSnapshotAndTurnSurviveImmediateReplyAndConcurrentOpen() async throws {
        let transport = FakeEnvServer()
        let selection = CodeV2.ModelSelection(instanceId: "codex:default", model: "gpt-5.4")
        transport.handle = { command in
            let id = command.params["sessionId"]?.stringValue ?? "lost"
            switch command.kind {
            case .sessionOpen:
                return .init(result: FakeEnvServer.value(["sessionId": id]), events: [
                    FakeEnvServer.event(id, 0, .sessionSnapshot(snapshotSequence: 0,
                        session: .init(id: id, cwd: "/tmp/chat", selection: selection)))
                ])
            case .turnStart:
                return .init(result: FakeEnvServer.value(["turnId": "turn-1"]), events: [
                    FakeEnvServer.event(id, 1, .itemAdded(.assistantMessage(.init(
                        id: "reply", turnId: "turn-1", createdAt: "2026-10-11T10:00:00Z", text: "Hello"))))
                ])
            default: return .init()
            }
        }
        let connection = EnvServerConnection(transport: transport)
        let hub = EnvServerHub(connection: connection)
        let session = hub.session(id: "draft-chat", cwd: "/tmp/chat", selection: selection)
        async let first = session.open()
        async let second = session.open()
        let opened = await (first, second)
        XCTAssertTrue(opened.0 && opened.1)
        XCTAssertEqual(transport.commands.filter { $0.kind == .sessionOpen }.count, 1)
        XCTAssertEqual(transport.commands.first?.params["sessionId"]?.stringValue, "draft-chat")
        await session.send("Hi", selection: selection, routing: nil, runtimeMode: .ask, interactionMode: .default)
        for _ in 0..<100 where session.snapshot.items.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(session.snapshot.items.count, 1)
        XCTAssertEqual(session.state.cursor, 1)
        XCTAssertNil(session.lastError)
        hub.stop()
    }

    func testFailedOpeningDoesNotStartATurnAndPreservesError() async {
        let transport = FakeEnvServer()
        transport.handle = { command in
            if command.kind == .sessionOpen {
                return .init(error: .init(code: .notFound, message: "The folder is missing."))
            }
            return .init()
        }
        let hub = EnvServerHub(connection: EnvServerConnection(transport: transport))
        let selection = CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "sonnet")
        let session = hub.session(id: "draft-chat", cwd: "/tmp/missing", selection: selection)
        await session.send("Hi", selection: selection, routing: nil, runtimeMode: .ask, interactionMode: .default)
        XCTAssertEqual(session.lastError, "The folder is missing.")
        XCTAssertFalse(transport.commands.contains { $0.kind == .turnStart })
        hub.stop()
    }

    func testAgentMessageReportsRejectedDeliveryAndRecoversOnRetry() async {
        let transport = FakeEnvServer()
        transport.handle = { command in
            guard command.kind == .agentMessage else { return .init() }
            XCTAssertEqual(command.params["sessionId"]?.stringValue, "chat")
            XCTAssertEqual(command.params["agentId"]?.stringValue, "worker")
            return .init(result: .object(["accepted": .bool(false), "message": .string("Worker is busy.")]))
        }
        let hub = EnvServerHub(connection: EnvServerConnection(transport: transport))
        let session = hub.session(id: "chat", cwd: "/tmp/chat", selection: .init(instanceId: "alevr", model: "sonnet"))
        let rejected = await session.messageAgent("worker", text: "Check startup")
        XCTAssertFalse(rejected)
        XCTAssertEqual(session.lastError, "Worker is busy.")
        transport.handle = { _ in .init(result: .object(["accepted": .bool(true)])) }
        let accepted = await session.messageAgent("worker", text: "Check startup")
        XCTAssertTrue(accepted)
        XCTAssertNil(session.lastError)
        XCTAssertEqual(transport.commands.filter { $0.kind == .agentMessage }.count, 2)
        hub.stop()
    }

    func testQuietRefreshIncludesReadyProvidersAndUsesCache() async {
        let transport = FakeEnvServer()
        transport.handle = { command in
            let provider: JSONValue = .object(["id": .string("codex:default"), "kind": .string("codex"),
                "label": .string("Codex"), "status": .string("ready")])
            if command.kind == .providerList { return .init(result: .object(["instances": .array([provider])])) }
            if command.kind == .providerProbe { return .init(result: .object(["instance": provider])) }
            return .init()
        }
        let hub = EnvServerHub(connection: EnvServerConnection(transport: transport))
        await hub.refreshSubscriptions()
        XCTAssertEqual(transport.commands.filter { $0.kind == .providerProbe }.count, 1)
        XCTAssertEqual(transport.commands.last?.params["maxAgeMs"], .number(30_000))
        XCTAssertTrue(hub.probing.isEmpty)
        XCTAssertEqual(hub.refreshFailures, 0)
        hub.stop()
    }
}
