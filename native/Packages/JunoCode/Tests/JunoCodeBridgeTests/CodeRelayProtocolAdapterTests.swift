import Foundation
import XCTest
import JunoCodeCore
import JunoCodeKit
import JunoCodeRuntime
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
        func applyChange(sessionID _: String, changeID: String, accept: Bool) async throws {
            calls.append("change(\(changeID),\(accept))")
        }
        func undoChange(sessionID _: String, checkpointID: String) async throws {
            calls.append("undo(\(checkpointID))")
        }
        func deleteChange(sessionID _: String, changeID: String) async throws {
            calls.append("delete(\(changeID))")
        }
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
        let executor = hostExecutor(bridge)
        _ = try await executor.execute(
            CodeRemoteCommand(
                id: "command-1", sessionID: "session-1", kind: "message",
                payload: ["text": .string("Canonical remote")], status: "claimed"
            )
        )
        let calls = await bridge.calls
        XCTAssertEqual(calls, ["send(session-1,Canonical remote)"])
    }

    // MARK: - Change review verbs

    /// Accept, reject, undo and delete used to have no canonical kind, so the
    /// Mac refused every one of them at the protocol edge with an error that
    /// named nothing the phone had done.
    func testEveryReviewVerbHasACanonicalKind() throws {
        let expected: [(String, CodeSessionCommandKind)] = [
            ("accept_change", .acceptChange), ("reject_change", .rejectChange),
            ("undo_change", .undoChange), ("delete_change", .deleteChange),
            ("update_session", .updateSession),
        ]
        for (kind, canonical) in expected {
            let envelope = try CodeRelayProtocolAdapter.commandEnvelope(
                from: command(kind, payload: ["path": .string("src/a.swift")]),
                targetID: .init(value: "device-1")
            )
            XCTAssertEqual(envelope.kind, canonical, kind)
        }
    }

    /// `apply_patch` is what older relays made of the phone's session menu. It
    /// keeps a change when it names one and is a settings update when not.
    func testApplyPatchIsReadByWhatItNames() throws {
        let keep = try CodeRelayProtocolAdapter.commandEnvelope(
            from: command("apply_patch", payload: ["changeId": .string("src/a.swift")]),
            targetID: .init(value: "device-1")
        )
        XCTAssertEqual(keep.kind, .acceptChange)
        let menu = try CodeRelayProtocolAdapter.commandEnvelope(
            from: command("apply_patch", payload: ["modelID": .string("model-b")]),
            targetID: .init(value: "device-1")
        )
        XCTAssertEqual(menu.kind, .updateSession)
    }

    func testDeletingASessionIsRefusedWithAReasonThePhoneCanShow() {
        for kind in ["delete", "delete_session"] {
            XCTAssertThrowsError(
                try CodeRelayProtocolAdapter.commandEnvelope(
                    from: command(kind), targetID: .init(value: "device-1")
                )
            ) { error in
                XCTAssertEqual(
                    error.localizedDescription,
                    "Sessions are deleted on the Mac itself. This one is still there."
                )
            }
        }
    }

    /// The acknowledgement carries `localizedDescription` to the phone. A Swift
    /// type name there is an error nobody can act on.
    func testAnUnknownVerbFailsInWords() {
        XCTAssertThrowsError(
            try CodeRelayProtocolAdapter.commandEnvelope(
                from: command("defragment"), targetID: .init(value: "device-1")
            )
        ) { error in
            XCTAssertTrue(error.localizedDescription.contains("\"defragment\""))
            XCTAssertFalse(error.localizedDescription.contains("CodeRelayProtocolAdapter"))
        }
    }

    func testReviewVerbsReachTheRuntimeThroughTheHost() async throws {
        let bridge = Bridge()
        let executor = hostExecutor(bridge)

        _ = try await executor.execute(command("accept_change", payload: ["path": .string("src/a.swift")]))
        _ = try await executor.execute(command("reject_change", payload: ["changeId": .string("src/b.swift")]))
        _ = try await executor.execute(command("undo_change", payload: ["checkpointId": .string("cp-1")]))
        _ = try await executor.execute(command("delete_change", payload: ["path": .string("src/c.swift")]))

        let calls = await bridge.calls
        XCTAssertEqual(calls, [
            "change(src/a.swift,true)", "change(src/b.swift,false)", "undo(cp-1)", "delete(src/c.swift)",
        ])
    }

    func testAnUndoWithNoCheckpointNamesTheMissingField() async {
        let executor = hostExecutor(Bridge())
        do {
            _ = try await executor.execute(command("undo_change", payload: ["requestId": .string("r-1")]))
            XCTFail("an undo must name the checkpoint it restores")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The command is missing \"checkpointId\".")
        }
    }

    // MARK: - Helpers

    private func command(
        _ kind: String, payload: [String: JunoJSONValue] = [:]
    ) -> CodeRemoteCommand {
        CodeRemoteCommand(
            id: "command-\(kind)", sessionID: "session-1", kind: kind, payload: payload, status: "claimed"
        )
    }

    /// The production shape: the relay DTO crosses the canonical envelope into
    /// a `RuntimeCodeHost`, which executes through the authorising adapter.
    private func hostExecutor(_ bridge: Bridge) -> CanonicalRelayHostExecutor {
        let targetID = ExecutionTargetID(value: "device-1")
        let target = ExecutionTarget(
            id: targetID, kind: .local, displayName: "This Mac", connectionState: .online
        )
        let adapter = RemoteCommandAdapter(bridge: bridge)
        let host = RuntimeCodeHost(
            targets: { [target] },
            events: { _ in [] },
            execute: { try await adapter.execute($0) }
        )
        return CanonicalRelayHostExecutor(host: host, targetID: targetID)
    }
}
