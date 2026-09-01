import Foundation
import XCTest
import JunoCodeCore
import JunoCodeKit
import JunoCore
@testable import JunoCodeBridge

final class CodeRelayProtocolAdapterTests: XCTestCase {
    private actor Bridge: CodeRemoteSessionBridging {
        private(set) var calls: [String] = []

        func isWorkspaceSharedWithRemote(_: String) async -> Bool { true }
        func permissionMode(forSession _: String) async -> PermissionMode? { .workspaceWrite }
        func createSession(workspaceID: String, title _: String?, permissionMode _: PermissionMode) async throws -> String { workspaceID }
        func sendMessage(sessionID: String, text: String) async throws { calls.append("send(\(sessionID),\(text))") }
        func stopAgent(sessionID _: String) async throws {}
        func retryTurn(sessionID _: String) async throws {}
        func forkSession(sessionID: String) async throws -> String { sessionID }
        func resolveApproval(sessionID _: String, approvalID _: String, approved _: Bool) async throws {}
        func applyChange(sessionID _: String, changeID _: String, accept _: Bool) async throws {}
        func undoChange(sessionID _: String, checkpointID _: String) async throws {}
        func deleteChange(sessionID _: String, changeID _: String) async throws {}
        func runTests(sessionID _: String, command _: String?) async throws {}
        func stopTests(sessionID _: String) async throws {}
        func performGitAction(sessionID _: String, action _: String, message _: String?) async throws {}
    }
    func testLegacyRemoteCommandMapsToCanonicalCommandWithStableIdempotency() throws {
        let remote = CodeRemoteCommand(
            id: "command-1", sessionID: "session-1", kind: "message",
            payload: ["text": .string("Fix it")], status: "claimed"
        )
        let canonical = try CodeRelayProtocolAdapter.commandEnvelope(
            from: remote,
            targetID: ExecutionTargetID(value: "device-1"),
            issuedAt: Date(timeIntervalSince1970: 1)
        )
        XCTAssertEqual(canonical.kind, .sendMessage)
        XCTAssertEqual(canonical.idempotencyKey, "command-1")
        XCTAssertEqual(canonical.payload["text"], .string("Fix it"))
    }

    func testCreateSessionMapsThroughTheRelayWithoutInventingASecondVerb() throws {
        let remote = CodeRemoteCommand(
            id: "command-1", sessionID: "relay-sentinel", kind: "create_session",
            payload: ["workspaceId": .string("workspace-1"), "initialMessage": .string("Fix it")],
            status: "claimed"
        )
        let canonical = try CodeRelayProtocolAdapter.commandEnvelope(
            from: remote, targetID: .init(value: "device-1")
        )
        XCTAssertEqual(canonical.kind, .createSession)
        XCTAssertEqual(canonical.sessionID?.value, "relay-sentinel")
        XCTAssertEqual(canonical.payload["initialMessage"], .string("Fix it"))
    }

    func testCanonicalEventSurvivesRelayRoundTrip() throws {
        let event = CodeSessionEventEnvelope(
            id: "event-1",
            sessionID: CodeSessionID(value: "session-1"),
            sequence: 1,
            occurredAt: Date(timeIntervalSince1970: 1),
            payload: .userPrompt(UserPromptEvent(text: "Ship it"))
        )
        let relay = try CodeRelayProtocolAdapter.relayEvent(from: event)
        XCTAssertEqual(relay.kind, "canonical_session_event")
        XCTAssertEqual(try CodeRelayProtocolAdapter.canonicalEvent(from: relay), event)
    }

    func testRelayExecutorActuallyCrossesTheCanonicalCommandPath() async throws {
        let bridge = Bridge()
        let executor = CanonicalRelayCommandExecutor(
            adapter: RemoteCommandAdapter(bridge: bridge),
            targetID: ExecutionTargetID(value: "device-1")
        )
        _ = try await executor.execute(
            CodeRemoteCommand(
                id: "command-1", sessionID: "session-1", kind: "message",
                payload: ["text": .string("Canonical remote")], status: "claimed"
            )
        )
        let calls = await bridge.calls
        XCTAssertEqual(calls, ["send(session-1,Canonical remote)"])
    }
}
