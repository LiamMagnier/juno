import XCTest
import JunoCodeCore
import JunoCodeKit
import JunoCore
@testable import JunoCodeBridge

/// The Remote path end to end: a command leaves a phone, is claimed by a host,
/// runs against a session, and is acknowledged.
///
/// Driven through `CodeRemoteHost` with a scripted relay rather than through
/// the adapter alone, because most of what can go wrong here is in the seams —
/// a claim that lands after sign-out, a revocation mid-poll, a duplicate
/// delivery, a host that dies with a command outstanding. None of those is
/// visible in a unit test of either half.
final class RemoteEndToEndTests: XCTestCase {
    // MARK: - Scripted relay

    /// Hands out commands in order, records acknowledgements, and can be told
    /// to fail or to revoke the device.
    private actor Relay: CodeRemoteRelaying {
        struct Ack: Equatable {
            let commandID: String
            let status: String
            let error: String?
        }

        private var queue: [CodeRemoteCommand]
        private(set) var acks: [Ack] = []
        private(set) var claims = 0
        private var failure: CodeRemoteError?
        /// Re-delivers the last command once, as a relay does when an
        /// acknowledgement is lost.
        private var redeliverNext = false

        init(_ commands: [CodeRemoteCommand]) { queue = commands }

        func fail(with error: CodeRemoteError) { failure = error }
        func scheduleRedelivery() { redeliverNext = true }

        func claimNextCommand(
            deviceID: String, for accountID: AccountID
        ) async throws -> CodeRemoteCommand? {
            claims += 1
            if let failure { throw failure }
            if redeliverNext, let last = acks.last {
                redeliverNext = false
                return CodeRemoteCommand(
                    id: last.commandID, sessionID: "s-1", kind: "stop_agent",
                    payload: [:], status: "claimed"
                )
            }
            return queue.isEmpty ? nil : queue.removeFirst()
        }

        func acknowledgeCommand(
            deviceID: String,
            commandID: String,
            status: String,
            result: [String: JunoJSONValue]?,
            error: String?,
            for accountID: AccountID
        ) async throws {
            acks.append(Ack(commandID: commandID, status: status, error: error))
        }
    }

    /// Records what actually ran, so a refused command can be shown to have
    /// reached the runtime not at all.
    private actor Runtime: CodeRemoteSessionBridging {
        private(set) var performed: [String] = []
        private var shared: Set<String> = ["ws-1"]
        private var modes: [String: PermissionMode] = ["s-1": .workspaceWrite]

        func isWorkspaceSharedWithRemote(_ workspaceID: String) async -> Bool {
            shared.contains(workspaceID)
        }
        func permissionMode(forSession sessionID: String) async -> PermissionMode? {
            modes[sessionID]
        }
        func createSession(
            workspaceID: String, title: String?, permissionMode: PermissionMode
        ) async throws -> String {
            performed.append("create(\(workspaceID))")
            return "s-new"
        }
        func sendMessage(sessionID: String, text: String) async throws {
            performed.append("send(\(text))")
        }
        func stopAgent(sessionID: String) async throws { performed.append("stop") }
        func retryTurn(sessionID: String) async throws { performed.append("retry") }
        func forkSession(sessionID: String) async throws -> String {
            performed.append("fork")
            return "s-fork"
        }
        func resolveApproval(
            sessionID: String, approvalID: String, approved: Bool
        ) async throws {
            performed.append("approval(\(approvalID),\(approved))")
        }
        func applyChange(sessionID: String, changeID: String, accept: Bool) async throws {
            performed.append("change(\(changeID),\(accept))")
        }
        func undoChange(sessionID: String, checkpointID: String) async throws {
            performed.append("undo(\(checkpointID))")
        }
        func deleteChange(sessionID: String, changeID: String) async throws {
            performed.append("delete(\(changeID))")
        }
        func runTests(sessionID: String, command: String?) async throws {
            performed.append("tests(\(command ?? "-"))")
        }
        func stopTests(sessionID: String) async throws { performed.append("stopTests") }
        func performGitAction(
            sessionID: String, action: String, message: String?
        ) async throws {
            performed.append("git(\(action))")
        }
    }

    private func command(
        _ kind: String, id: String = "c-1", payload: [String: JunoJSONValue] = [:]
    ) -> CodeRemoteCommand {
        CodeRemoteCommand(
            id: id, sessionID: "s-1", kind: kind, payload: payload, status: "queued"
        )
    }

    /// Runs the host until it has acknowledged `expected` commands, then stops.
    private func drive(
        relay: Relay,
        runtime: Runtime,
        hostActive: @escaping @Sendable () async -> Bool = { true },
        expected: Int,
        timeout: Duration = .seconds(5)
    ) async {
        let adapter = RemoteCommandAdapter(bridge: runtime, isHostActive: hostActive)
        let host = CodeRemoteHost(
            deviceID: "dev-1",
            accountID: try! AccountID("acct-1"),
            relay: relay,
            executor: adapter,
            sleep: { _ in },
            jitter: { 1 }
        )
        await host.activate()

        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if await relay.acks.count >= expected { break }
            try? await Task.sleep(for: .milliseconds(5))
        }
        await host.deactivate()
    }

    // MARK: - Dispatch

    func testAPhoneDispatchReachesTheMacAndIsAcknowledged() async throws {
        let relay = Relay([command("send_message", payload: ["text": .string("hello")])])
        let runtime = Runtime()

        await drive(relay: relay, runtime: runtime, expected: 1)

        let performed = await runtime.performed
        XCTAssertEqual(performed, ["send(hello)"])
        let acks = await relay.acks
        XCTAssertEqual(acks.first?.status, "completed")
    }

    /// A relay re-delivers when an acknowledgement is lost. Running the command
    /// twice would send the message twice; the ack must simply repeat.
    func testADuplicateDeliveryIsAcknowledgedAgainWithoutRunningTwice() async throws {
        let relay = Relay([command("stop_agent")])
        let runtime = Runtime()
        await relay.scheduleRedelivery()

        await drive(relay: relay, runtime: runtime, expected: 2)

        let acks = await relay.acks
        XCTAssertGreaterThanOrEqual(acks.count, 2, "the redelivery is acknowledged too")
        XCTAssertTrue(
            acks.allSatisfy { $0.commandID == "c-1" },
            "both acknowledgements are for the same command"
        )
    }

    // MARK: - Failure paths

    func testAnUnsupportedCommandIsAcknowledgedAsFailedRatherThanStranded() async throws {
        // Silence here would strand it: the relay's claim means nothing else
        // picks it up, so the command would never complete and never fail.
        let relay = Relay([command("mine_bitcoin")])
        let runtime = Runtime()

        await drive(relay: relay, runtime: runtime, expected: 1)

        let acks = await relay.acks
        XCTAssertEqual(acks.first?.status, "failed")
        XCTAssertNotNil(acks.first?.error)
        let performed = await runtime.performed
        XCTAssertTrue(performed.isEmpty)
    }

    func testAWorkspaceThatWasNeverSharedFailsTheCommand() async throws {
        let relay = Relay([
            command("create_session", payload: ["workspaceId": .string("ws-secret")])
        ])
        let runtime = Runtime()

        await drive(relay: relay, runtime: runtime, expected: 1)

        let acks = await relay.acks
        XCTAssertEqual(acks.first?.status, "failed")
        let performed = await runtime.performed
        XCTAssertTrue(performed.isEmpty, "the runtime must not have been reached")
    }

    func testAnEscalatingCommandFailsAndChangesNothing() async throws {
        let relay = Relay([
            command(
                "send_message",
                payload: [
                    "text": .string("do it"),
                    "permissionMode": .string(PermissionMode.fullAccess.rawValue),
                ]
            )
        ])
        let runtime = Runtime()

        await drive(relay: relay, runtime: runtime, expected: 1)

        let acks = await relay.acks
        XCTAssertEqual(acks.first?.status, "failed")
        let performed = await runtime.performed
        XCTAssertTrue(performed.isEmpty)
    }

    // MARK: - Host lifecycle

    /// Sign-out lands during the long poll far more often than between polls.
    func testACommandClaimedAfterSignOutIsNotExecuted() async throws {
        let relay = Relay([command("send_message", payload: ["text": .string("late")])])
        let runtime = Runtime()

        await drive(relay: relay, runtime: runtime, hostActive: { false }, expected: 1)

        let performed = await runtime.performed
        XCTAssertTrue(performed.isEmpty, "an inactive host must run nothing")
        let acks = await relay.acks
        XCTAssertEqual(acks.first?.status, "failed")
    }

    /// A revoked device must stop, not retry forever — otherwise a
    /// decommissioned Mac keeps polling a relay that has already refused it.
    func testARevokedDeviceStopsInsteadOfRetrying() async throws {
        let relay = Relay([])
        await relay.fail(with: .server(statusCode: 403, message: "revoked", retryable: false))
        let runtime = Runtime()

        let adapter = RemoteCommandAdapter(bridge: runtime)
        let host = CodeRemoteHost(
            deviceID: "dev-1", accountID: try! AccountID("acct-1"),
            relay: relay, executor: adapter, sleep: { _ in }, jitter: { 1 }
        )
        await host.activate()

        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if case .stopped = await host.state { break }
            try? await Task.sleep(for: .milliseconds(5))
        }

        guard case let .stopped(reason) = await host.state else {
            return XCTFail("a revoked device must stop, got \(await host.state)")
        }
        XCTAssertTrue(reason.contains("revoked"))
        let claims = await relay.claims
        XCTAssertLessThan(claims, 5, "it must not have kept polling")
    }

    /// A retryable outage must NOT stop the host — that is the difference
    /// between "the relay is down for a minute" and "this Mac is finished".
    func testARelayOutageReconnectsRatherThanStopping() async throws {
        let relay = Relay([])
        await relay.fail(with: .server(statusCode: 503, message: "down", retryable: true))
        let runtime = Runtime()

        let adapter = RemoteCommandAdapter(bridge: runtime)
        let host = CodeRemoteHost(
            deviceID: "dev-1", accountID: try! AccountID("acct-1"),
            relay: relay, executor: adapter, sleep: { _ in }, jitter: { 1 }
        )
        await host.activate()

        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline {
            if await relay.claims > 2 { break }
            try? await Task.sleep(for: .milliseconds(5))
        }
        let state = await host.state
        await host.deactivate()

        if case .stopped = state {
            XCTFail("a transient outage must not stop the host")
        }
        let claims = await relay.claims
        XCTAssertGreaterThan(claims, 1, "it must have retried")
    }

    // MARK: - Ordering

    func testCommandsRunInTheOrderTheRelayHandsThemOut() async throws {
        let relay = Relay([
            command("send_message", id: "c-1", payload: ["text": .string("one")]),
            command("send_message", id: "c-2", payload: ["text": .string("two")]),
            command("stop_agent", id: "c-3"),
        ])
        let runtime = Runtime()

        await drive(relay: relay, runtime: runtime, expected: 3)

        let performed = await runtime.performed
        XCTAssertEqual(performed, ["send(one)", "send(two)", "stop"])
        let acks = await relay.acks
        XCTAssertEqual(acks.map(\.commandID), ["c-1", "c-2", "c-3"])
    }

    /// One failing command must not stop the ones behind it.
    func testAFailureDoesNotBlockTheQueue() async throws {
        let relay = Relay([
            command("nonsense", id: "c-1"),
            command("stop_agent", id: "c-2"),
        ])
        let runtime = Runtime()

        await drive(relay: relay, runtime: runtime, expected: 2)

        let acks = await relay.acks
        XCTAssertEqual(acks.map(\.status), ["failed", "completed"])
        let performed = await runtime.performed
        XCTAssertEqual(performed, ["stop"])
    }

    /// No raw filesystem path may appear in anything the relay is told.
    func testNoRawPathLeaksIntoAnAcknowledgement() async throws {
        let relay = Relay([
            command("create_session", payload: ["workspaceId": .string("ws-secret")])
        ])
        let runtime = Runtime()

        await drive(relay: relay, runtime: runtime, expected: 1)

        let acks = await relay.acks
        let text = acks.map { "\($0.commandID) \($0.status) \($0.error ?? "")" }.joined()
        XCTAssertFalse(text.contains("/Users"), "a refusal must not echo a path")
        XCTAssertFalse(text.contains("ws-secret"), "nor the identifier it was probing with")
    }
}
