import XCTest
import JunoCodeCore
import JunoCodeKit
import JunoCore
@testable import JunoCodeBridge

/// What a phone actually sends, and what a Mac that lists its sessions on the
/// phone must still refuse.
///
/// The phone's session sheet sends `workspaceKey` and `prompt`; the CLI sends
/// `workspaceId` and `initialMessage`. The Mac used to accept only the second,
/// so every session a phone tried to start failed. And once the Mac's own
/// sessions are listed on the phone they are reachable from it, which is why
/// the remote ceiling is checked on every action here.
final class RemoteSessionCommandTests: XCTestCase {
    private actor Host:
        CodeRemoteSessionAdoptingBridging,
        CodeRemoteCeilingProviding,
        CodeRemoteSessionUpdating
    {
        var modes: [String: PermissionMode]
        var existing: Set<String>
        let ceiling: PermissionMode
        private(set) var calls: [String] = []
        private(set) var requests: [CodeRemoteSessionRequest] = []
        private(set) var updates: [CodeRemoteSessionUpdate] = []

        init(
            modes: [String: PermissionMode] = ["s-1": .askBeforeChanges],
            existing: Set<String> = [],
            ceiling: PermissionMode = .askBeforeChanges
        ) {
            self.modes = modes
            self.existing = existing
            self.ceiling = ceiling
        }

        func isWorkspaceSharedWithRemote(_ workspaceID: String) async -> Bool {
            workspaceID == "ws-granted"
        }
        func permissionMode(forSession sessionID: String) async -> PermissionMode? { modes[sessionID] }
        func remoteCeiling(forSession sessionID: String) async -> PermissionMode? {
            modes[sessionID] == nil ? nil : ceiling
        }
        func remoteCeiling(forWorkspace _: String) async -> PermissionMode { ceiling }

        func createSession(_ request: CodeRemoteSessionRequest) async throws -> CodeRemoteCreatedSession {
            requests.append(request)
            let id = request.requestedID ?? "host-minted"
            let isNew = !existing.contains(id)
            existing.insert(id)
            return CodeRemoteCreatedSession(id: id, isNew: isNew)
        }
        func createSession(
            workspaceID: String, title: String?, permissionMode: PermissionMode
        ) async throws -> String {
            XCTFail("an adopting host is always asked through the request")
            return ""
        }
        func updateSession(sessionID: String, update: CodeRemoteSessionUpdate) async throws {
            updates.append(update)
        }
        func sendMessage(sessionID: String, text: String) async throws {
            calls.append("send(\(sessionID),\(text))")
        }
        func stopAgent(sessionID: String) async throws { calls.append("stop") }
        func retryTurn(sessionID: String) async throws { calls.append("retry") }
        func forkSession(sessionID: String) async throws -> String { "fork" }
        func resolveApproval(sessionID: String, approvalID: String, approved: Bool) async throws {
            calls.append("approval(\(approvalID),\(approved))")
        }
        func applyChange(sessionID: String, changeID: String, accept: Bool) async throws {
            calls.append("change(\(changeID),\(accept))")
        }
        func undoChange(sessionID: String, checkpointID: String) async throws {}
        func deleteChange(sessionID: String, changeID: String) async throws {}
        func runTests(sessionID: String, command: String?) async throws {}
        func stopTests(sessionID: String) async throws {}
        func performGitAction(sessionID: String, action: String, message: String?) async throws {}
    }

    // MARK: - Starting a session

    func testThePhonesSpellingStartsASession() async throws {
        let host = Host()
        let adapter = RemoteCommandAdapter(bridge: host)

        let result = try await adapter.execute(command(
            "create_session", session: "remote-6f1c",
            payload: [
                "workspaceKey": .string("ws-granted"),
                "workspaceName": .string("juno"),
                "prompt": .string("Fix the login flow"),
                "text": .string("Fix the login flow"),
                "title": .string("Fix the login flow"),
                "modelID": .string("anthropic:claude-sonnet-5"),
            ]
        ))

        XCTAssertEqual(result["sessionId"], .string("remote-6f1c"))
        let request = try await XCTUnwrapAsync(await host.requests.first)
        XCTAssertEqual(request.workspaceID, "ws-granted")
        XCTAssertEqual(request.modelID, "anthropic:claude-sonnet-5")
        XCTAssertEqual(request.title, "Fix the login flow")
        let calls = await host.calls
        XCTAssertEqual(calls, ["send(remote-6f1c,Fix the login flow)"])
    }

    func testTheCLIsSpellingStillStartsASession() async throws {
        let host = Host()
        let adapter = RemoteCommandAdapter(bridge: host)

        _ = try await adapter.execute(command(
            "create_session", session: "remote-1",
            payload: [
                "workspaceId": .string("ws-granted"),
                "initialMessage": .string("Run the tests"),
                "modelId": .string("model-a"),
                "reasoning": .string("high"),
            ]
        ))

        let request = try await XCTUnwrapAsync(await host.requests.first)
        XCTAssertEqual(request.modelID, "model-a")
        XCTAssertEqual(request.reasoningEffort, .high)
        let calls = await host.calls
        XCTAssertEqual(calls, ["send(remote-1,Run the tests)"])
    }

    /// The phone follows the id it minted from sequence zero. A session opened
    /// under any other id is a transcript the phone never sees.
    func testTheSessionOpensUnderTheIDThePhoneIsWatching() async throws {
        let host = Host()
        let adapter = RemoteCommandAdapter(bridge: host)

        _ = try await adapter.execute(command(
            "create_session", session: "remote-abc",
            payload: ["workspaceKey": .string("ws-granted")]
        ))

        let requested = await host.requests.first?.requestedID
        XCTAssertEqual(requested, "remote-abc")
    }

    /// A create delivered twice — its acknowledgement lost — finds the session
    /// it opened and must not send the first prompt again.
    func testARedeliveredCreateDoesNotSendItsPromptTwice() async throws {
        let host = Host()
        let adapter = RemoteCommandAdapter(bridge: host)
        let create = command(
            "create_session", session: "remote-abc",
            payload: ["workspaceKey": .string("ws-granted"), "prompt": .string("Go")]
        )

        _ = try await adapter.execute(create)
        _ = try await adapter.execute(create)

        let calls = await host.calls
        XCTAssertEqual(calls, ["send(remote-abc,Go)"])
    }

    func testAnIDThatCannotNameASessionIsRefused() async throws {
        let adapter = RemoteCommandAdapter(bridge: Host())
        do {
            _ = try await adapter.execute(command(
                "create_session", session: "remote:../../etc",
                payload: ["workspaceKey": .string("ws-granted")]
            ))
            XCTFail("an id that is not a plain token must not name a session directory")
        } catch let error as CodeRemoteCommandError {
            guard case .invalidField("sessionId", _) = error else {
                return XCTFail("expected an invalid sessionId, got \(error)")
            }
        }
    }

    /// The CLI's `run` names no session; the canonical sentinel it travels
    /// under must not become a session's id.
    func testTheCanonicalSentinelIsNotAdopted() async throws {
        let host = Host()
        let adapter = RemoteCommandAdapter(bridge: host)

        _ = try await adapter.execute(
            CodeSessionCommandEnvelope(
                targetID: ExecutionTargetID(value: "host-1"),
                sessionID: nil,
                kind: .createSession,
                payload: ["workspaceId": .string("ws-granted")]
            )
        )

        let request = try await XCTUnwrapAsync(await host.requests.first)
        XCTAssertNil(request.requestedID)
    }

    /// A reader who set the remote ceiling to read-only meant it: a phone that
    /// names no mode gets read-only, not the default ask-before-changes.
    func testANewSessionIsCappedAtTheRemoteCeiling() async throws {
        let host = Host(ceiling: .readOnly)
        let adapter = RemoteCommandAdapter(bridge: host)

        _ = try await adapter.execute(command(
            "create_session", session: "remote-1", payload: ["workspaceKey": .string("ws-granted")]
        ))

        let mode = await host.requests.first?.permissionMode
        XCTAssertEqual(mode, .readOnly)
    }

    // MARK: - The ceiling on existing sessions

    func testASessionAboveTheCeilingTakesNoWorkFromThePhone() async throws {
        let host = Host(modes: ["s-1": .fullAccess], ceiling: .askBeforeChanges)
        let adapter = RemoteCommandAdapter(bridge: host)

        do {
            _ = try await adapter.execute(command("send_message", payload: ["text": .string("rm -rf build")]))
            XCTFail("a full-access session must not run a prompt sent from a phone")
        } catch let error as CodeRemoteCommandError {
            guard case .aboveRemoteCeiling = error else {
                return XCTFail("expected the ceiling refusal, got \(error)")
            }
            XCTAssertTrue(error.localizedDescription.contains("full access"))
        }
        let calls = await host.calls
        XCTAssertTrue(calls.isEmpty)
    }

    /// Stopping and answering what the Mac itself asked stay possible: the
    /// ceiling limits what a phone can start, not whether it can halt work or
    /// reply to a question it was asked.
    func testStopAndApprovalsStillReachASessionAboveTheCeiling() async throws {
        let host = Host(modes: ["s-1": .fullAccess], ceiling: .askBeforeChanges)
        let adapter = RemoteCommandAdapter(bridge: host)

        _ = try await adapter.execute(command("stop_agent"))
        _ = try await adapter.execute(command(
            "approval_decision", payload: ["requestId": .string("a-1"), "approve": .bool(false)]
        ))

        let calls = await host.calls
        XCTAssertEqual(calls, ["stop", "approval(a-1,false)"])
    }

    // MARK: - The phone's session menu

    func testTheSessionMenuChangesModelEffortAndLowersTheMode() async throws {
        let host = Host(modes: ["s-1": .askBeforeChanges])
        let adapter = RemoteCommandAdapter(bridge: host)

        _ = try await adapter.execute(command(
            "update_session",
            payload: [
                "modelID": .string("model-b"),
                "reasoningEffort": .string("high"),
                "permissionMode": .string("readOnly"),
            ]
        ))

        let update = try await XCTUnwrapAsync(await host.updates.first)
        XCTAssertEqual(update.modelID, "model-b")
        XCTAssertEqual(update.reasoningEffort, .high)
        XCTAssertEqual(update.permissionMode, .readOnly)
    }

    func testTheSessionMenuCannotRaiseTheMode() async throws {
        let host = Host(modes: ["s-1": .askBeforeChanges], ceiling: .fullAccess)
        let adapter = RemoteCommandAdapter(bridge: host)

        do {
            _ = try await adapter.execute(command("update_session", payload: ["permissionMode": .string("auto")]))
            XCTFail("raising the mode is decided at the Mac")
        } catch let error as CodeRemoteCommandError {
            guard case .permissionEscalation = error else {
                return XCTFail("expected an escalation refusal, got \(error)")
            }
        }
        let updates = await host.updates
        XCTAssertTrue(updates.isEmpty)
    }

    /// Older relays rewrote the phone's "patch" to `apply_patch`. Without a
    /// change named, it is the session menu, not a missing `changeId`.
    func testAnApplyPatchWithNoChangeIsTheSessionMenu() async throws {
        let host = Host()
        let adapter = RemoteCommandAdapter(bridge: host)

        _ = try await adapter.execute(command("apply_patch", payload: ["modelID": .string("model-b")]))

        let updates = await host.updates
        XCTAssertEqual(updates.first?.modelID, "model-b")
    }

    func testArchivingAndDeletingAreRefusedInWords() async throws {
        let adapter = RemoteCommandAdapter(bridge: Host())
        for (kind, payload) in [
            ("update_session", ["archived": JunoJSONValue.bool(true)]),
            ("delete_session", [:]),
        ] {
            do {
                _ = try await adapter.execute(command(kind, payload: payload))
                XCTFail("\(kind) must be refused")
            } catch let error as CodeRemoteCommandError {
                guard case .notAvailableRemotely(let message) = error else {
                    return XCTFail("expected a refusal with a reason, got \(error)")
                }
                XCTAssertTrue(message.contains("Mac"))
            }
        }
    }

    func testTheWebsPathSpellingNamesAChange() async throws {
        let host = Host()
        let adapter = RemoteCommandAdapter(bridge: host)

        _ = try await adapter.execute(command("accept_change", payload: ["path": .string("src/a.swift")]))

        let calls = await host.calls
        XCTAssertEqual(calls, ["change(src/a.swift,true)"])
    }

    func testThePhonesModeNamesAreTheMacsRungs() {
        XCTAssertEqual(PermissionMode(remoteName: "approvalRequired"), .askBeforeChanges)
        XCTAssertEqual(PermissionMode(remoteName: "auto"), .workspaceWrite)
        XCTAssertEqual(PermissionMode(remoteName: "readOnly"), .readOnly)
        XCTAssertNil(PermissionMode(remoteName: "god_mode"))
        for mode in PermissionMode.allCases {
            XCTAssertEqual(PermissionMode(remoteName: mode.relayName), mode, "round trip for \(mode)")
        }
    }

    // MARK: - Helpers

    private func command(
        _ kind: String, session: String = "s-1", payload: [String: JunoJSONValue] = [:]
    ) -> CodeRemoteCommand {
        CodeRemoteCommand(id: "c-1", sessionID: session, kind: kind, payload: payload, status: "claimed")
    }
}

/// `XCTUnwrap` cannot take an `await`; this is the same assertion for a value
/// read from an actor.
func XCTUnwrapAsync<T>(
    _ expression: @autoclosure () async throws -> T?,
    file: StaticString = #filePath, line: UInt = #line
) async throws -> T {
    let value = try await expression()
    return try XCTUnwrap(value, file: file, line: line)
}
