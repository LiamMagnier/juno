import XCTest
import JunoCodeCore
import JunoCodeKit
import JunoCore
@testable import JunoCodeBridge

/// The remote command path, from a relay command to a call on the real runtime.
///
/// These cover the rules a phone must not be able to talk its way past — an
/// unknown command, a workspace that was never shared, a permission mode above
/// the session's own — because every one of those is a way for someone who is
/// not sitting at the Mac to make it do something its owner did not allow.
final class RemoteCommandAdapterTests: XCTestCase {
    /// Records what the runtime was asked to do, so a test can assert that a
    /// refused command reached it *not at all*.
    private actor Bridge: CodeRemoteSessionBridging {
        var sharedWorkspaces: Set<String>
        var modes: [String: PermissionMode]
        private(set) var calls: [String] = []

        init(
            sharedWorkspaces: Set<String> = ["ws-granted"],
            modes: [String: PermissionMode] = ["s-1": .workspaceWrite]
        ) {
            self.sharedWorkspaces = sharedWorkspaces
            self.modes = modes
        }

        func isWorkspaceSharedWithRemote(_ workspaceID: String) async -> Bool {
            sharedWorkspaces.contains(workspaceID)
        }

        func permissionMode(forSession sessionID: String) async -> PermissionMode? {
            modes[sessionID]
        }

        func createSession(
            workspaceID: String, title: String?, permissionMode: PermissionMode
        ) async throws -> String {
            calls.append("createSession(\(workspaceID),\(permissionMode.rawValue))")
            return "s-new"
        }

        func sendMessage(sessionID: String, text: String) async throws {
            calls.append("sendMessage(\(sessionID),\(text))")
        }
        func stopAgent(sessionID: String) async throws { calls.append("stopAgent(\(sessionID))") }
        func retryTurn(sessionID: String) async throws { calls.append("retry(\(sessionID))") }
        func forkSession(sessionID: String) async throws -> String {
            calls.append("fork(\(sessionID))")
            return "s-fork"
        }
        func resolveApproval(sessionID: String, approvalID: String, approved: Bool) async throws {
            calls.append("approval(\(approvalID),\(approved))")
        }
        func applyChange(sessionID: String, changeID: String, accept: Bool) async throws {
            calls.append("applyChange(\(changeID),\(accept))")
        }
        func undoChange(sessionID: String, checkpointID: String) async throws {
            calls.append("undo(\(checkpointID))")
        }
        func deleteChange(sessionID: String, changeID: String) async throws {
            calls.append("delete(\(changeID))")
        }
        func runTests(sessionID: String, command: String?) async throws {
            calls.append("runTests(\(command ?? "-"))")
        }
        func stopTests(sessionID: String) async throws { calls.append("stopTests") }
        func performGitAction(sessionID: String, action: String, message: String?) async throws {
            calls.append("git(\(action))")
        }
    }

    private func command(
        _ kind: String,
        session: String = "s-1",
        payload: [String: JunoJSONValue] = [:]
    ) -> CodeRemoteCommand {
        CodeRemoteCommand(
            id: "c-1", sessionID: session, kind: kind, payload: payload, status: "claimed"
        )
    }

    // MARK: - Unknown commands

    func testAnUnknownCommandIsRefusedBeforeItReachesTheRuntime() async throws {
        let bridge = Bridge()
        let adapter = RemoteCommandAdapter(bridge: bridge)

        do {
            _ = try await adapter.execute(command("format_the_disk"))
            XCTFail("an unknown command must be refused")
        } catch let error as CodeRemoteCommandError {
            XCTAssertEqual(error, .unsupportedKind("format_the_disk"))
        }
        let calls = await bridge.calls
        XCTAssertTrue(calls.isEmpty, "a refused command must not touch the runtime")
    }

    func testEveryDeclaredKindParses() throws {
        let adapter = RemoteCommandAdapter(bridge: Bridge())
        for kind in CodeRemoteCommandKind.allCases {
            XCTAssertNoThrow(
                try adapter.validate(command(kind.rawValue)),
                "\(kind.rawValue) should parse"
            )
        }
    }

    // MARK: - Host activation

    /// The long poll parks for ~25 seconds, so switching Remote off almost
    /// always lands while a command is in flight.
    func testACommandClaimedBeforeDeactivationIsNotCarriedOutAfterIt() async throws {
        let bridge = Bridge()
        let adapter = RemoteCommandAdapter(bridge: bridge, isHostActive: { false })

        do {
            _ = try await adapter.execute(
                command("send_message", payload: ["text": .string("hello")])
            )
            XCTFail("an inactive host must refuse")
        } catch let error as CodeRemoteCommandError {
            XCTAssertEqual(error, .hostInactive)
        }
        let calls = await bridge.calls
        XCTAssertTrue(calls.isEmpty)
    }

    // MARK: - Workspaces

    func testASessionCannotBeOpenedOnAWorkspaceThatWasNeverShared() async throws {
        let bridge = Bridge(sharedWorkspaces: ["ws-granted"])
        let adapter = RemoteCommandAdapter(bridge: bridge)

        do {
            _ = try await adapter.execute(
                command("create_session", payload: ["workspaceId": .string("ws-other")])
            )
            XCTFail("an unshared workspace must be refused")
        } catch let error as CodeRemoteCommandError {
            XCTAssertEqual(error, .workspaceNotGranted("ws-other"))
        }
        let calls = await bridge.calls
        XCTAssertTrue(calls.isEmpty)
    }

    /// A path is not a workspace id. Accepting one would let a phone name a
    /// folder that was never shared, which is the whole point of the opaque id.
    func testARawPathIsNotAcceptedAsAWorkspaceIdentifier() async throws {
        let bridge = Bridge(sharedWorkspaces: ["ws-granted"])
        let adapter = RemoteCommandAdapter(bridge: bridge)

        do {
            _ = try await adapter.execute(
                command("create_session", payload: ["workspaceId": .string("/Users/liam/secrets")])
            )
            XCTFail("a path must not resolve to a granted workspace")
        } catch let error as CodeRemoteCommandError {
            XCTAssertEqual(error, .workspaceNotGranted("/Users/liam/secrets"))
        }
    }

    func testAGrantedWorkspaceOpensASession() async throws {
        let bridge = Bridge()
        let adapter = RemoteCommandAdapter(bridge: bridge)

        let result = try await adapter.execute(
            command("create_session", payload: ["workspaceId": .string("ws-granted")])
        )
        XCTAssertEqual(result["sessionId"]?.stringValue, "s-new")
    }

    // MARK: - Permission non-escalation

    /// The rule that keeps the permission mode a boundary rather than a
    /// suggestion: it cannot be raised by someone who is not at the machine.
    func testARemoteCommandCannotRaiseTheSessionsPermissionMode() async throws {
        let bridge = Bridge(modes: ["s-1": .readOnly])
        let adapter = RemoteCommandAdapter(bridge: bridge)

        do {
            _ = try await adapter.execute(
                command(
                    "send_message",
                    payload: [
                        "text": .string("do it"),
                        "permissionMode": .string(PermissionMode.fullAccess.rawValue),
                    ]
                )
            )
            XCTFail("a remote escalation must be refused")
        } catch let error as CodeRemoteCommandError {
            XCTAssertEqual(
                error,
                .permissionEscalation(
                    requested: PermissionMode.fullAccess.rawValue,
                    current: PermissionMode.readOnly.rawValue
                )
            )
        }
        let calls = await bridge.calls
        XCTAssertTrue(calls.isEmpty, "the message must not have been sent")
    }

    func testARemoteCommandMayRunAtOrBelowTheSessionsMode() async throws {
        let bridge = Bridge(modes: ["s-1": .workspaceWrite])
        let adapter = RemoteCommandAdapter(bridge: bridge)

        _ = try await adapter.execute(
            command(
                "send_message",
                payload: [
                    "text": .string("ok"),
                    "permissionMode": .string(PermissionMode.readOnly.rawValue),
                ]
            )
        )
        let calls = await bridge.calls
        XCTAssertEqual(calls, ["sendMessage(s-1,ok)"])
    }

    /// Granting full access is a decision made at the machine that holds the
    /// files, so a phone cannot open a new session above ask-before-changes.
    func testANewSessionCannotBeOpenedAboveAskBeforeChanges() async throws {
        let adapter = RemoteCommandAdapter(bridge: Bridge())

        do {
            _ = try await adapter.execute(
                command(
                    "create_session",
                    payload: [
                        "workspaceId": .string("ws-granted"),
                        "permissionMode": .string(PermissionMode.fullAccess.rawValue),
                    ]
                )
            )
            XCTFail("a phone must not open a full-access session")
        } catch let error as CodeRemoteCommandError {
            guard case .permissionEscalation = error else {
                return XCTFail("expected an escalation refusal, got \(error)")
            }
        }
    }

    func testAnUnknownPermissionModeIsRejectedRatherThanIgnored() async throws {
        let adapter = RemoteCommandAdapter(bridge: Bridge())
        do {
            _ = try await adapter.execute(
                command(
                    "send_message",
                    payload: ["text": .string("x"), "permissionMode": .string("god_mode")]
                )
            )
            XCTFail("an unknown mode must be rejected")
        } catch let error as CodeRemoteCommandError {
            guard case .invalidField("permissionMode", _) = error else {
                return XCTFail("expected an invalid-field error, got \(error)")
            }
        }
    }

    // MARK: - Payload validation

    func testAMissingRequiredFieldIsNamed() async throws {
        let adapter = RemoteCommandAdapter(bridge: Bridge())
        do {
            _ = try await adapter.execute(command("send_message"))
            XCTFail("a message with no text must be refused")
        } catch let error as CodeRemoteCommandError {
            XCTAssertEqual(error, .missingField("text"))
        }
    }

    // MARK: - The dispatch table

    func testEachCommandReachesItsRuntimeCall() async throws {
        let bridge = Bridge(modes: ["s-1": .fullAccess])
        let adapter = RemoteCommandAdapter(bridge: bridge)

        _ = try await adapter.execute(command("stop_agent"))
        _ = try await adapter.execute(command("retry"))
        _ = try await adapter.execute(command("fork"))
        _ = try await adapter.execute(
            command(
                "approval_decision",
                payload: ["approvalId": .string("a-1"), "approved": .bool(true)]
            )
        )
        _ = try await adapter.execute(
            command("accept_change", payload: ["changeId": .string("ch-1")])
        )
        _ = try await adapter.execute(
            command("reject_change", payload: ["changeId": .string("ch-2")])
        )
        _ = try await adapter.execute(
            command("undo_change", payload: ["checkpointId": .string("cp-1")])
        )
        _ = try await adapter.execute(
            command("delete_change", payload: ["changeId": .string("ch-3")])
        )
        _ = try await adapter.execute(
            command("run_tests", payload: ["command": .string("swift test")])
        )
        _ = try await adapter.execute(command("stop_tests"))
        _ = try await adapter.execute(
            command("git_action", payload: ["action": .string("commit")])
        )

        let calls = await bridge.calls
        XCTAssertEqual(
            calls,
            [
                "stopAgent(s-1)", "retry(s-1)", "fork(s-1)", "approval(a-1,true)",
                "applyChange(ch-1,true)", "applyChange(ch-2,false)", "undo(cp-1)",
                "delete(ch-3)", "runTests(swift test)", "stopTests", "git(commit)",
            ]
        )
    }

    /// Stopping is always allowed, whatever the mode: refusing to let someone
    /// halt a run they can see is the wrong way for this to fail.
    func testStoppingIsNotGatedOnThePermissionMode() async throws {
        let bridge = Bridge(modes: ["s-1": .readOnly])
        let adapter = RemoteCommandAdapter(bridge: bridge)

        _ = try await adapter.execute(
            command(
                "stop_agent",
                payload: ["permissionMode": .string(PermissionMode.fullAccess.rawValue)]
            )
        )
        let calls = await bridge.calls
        XCTAssertEqual(calls, ["stopAgent(s-1)"])
    }
}
