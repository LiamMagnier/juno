import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoCodeKit

/// The host loop is what lets a phone cause code to run on someone's Mac, so
/// these are about the properties that keep that safe and bounded rather than
/// about the happy path.
final class CodeRemoteHostTests: XCTestCase {
    private let account = try! AccountID("account-a")

    /// Nothing may start on its own. A Mac that silently began accepting remote
    /// commands the moment someone signed in would be a dangerous default.
    func testAHostIsInactiveUntilExplicitlyActivated() async {
        let host = makeHost(transport: HostTransport(script: []))
        let state = await host.state
        XCTAssertEqual(state, .inactive)
    }

    /// Execution belongs to the JunoCode runtime, with its own tool permissions
    /// and approvals. The loop claims, hands over and acknowledges — it must
    /// never execute anything itself, or a remote command would acquire
    /// capabilities a local prompt does not have.
    func testAClaimedCommandIsHandedToTheExecutorAndAcknowledged() async throws {
        let transport = HostTransport(script: [
            .command(id: "c1", kind: "message"),
            .idle,
        ])
        let executor = RecordingExecutor()
        let host = makeHost(transport: transport, executor: executor)

        await host.activate()
        try await settle { await transport.acknowledgements.count >= 1 }

        let executed = await executor.executed
        XCTAssertEqual(executed.map(\.id), ["c1"])

        let acks = await transport.acknowledgements
        XCTAssertEqual(acks.first?.status, "completed")
        await host.deactivate()
    }

    /// A failed command still has to be acknowledged. The relay's claim is a
    /// CAS, so no other process can pick it up — staying silent leaves a
    /// command that never completes and never fails.
    func testAFailedCommandIsStillAcknowledged() async throws {
        let transport = HostTransport(script: [
            .command(id: "c1", kind: "message"),
            .idle,
        ])
        let executor = RecordingExecutor(failWith: ExecutorFailure.boom)
        let host = makeHost(transport: transport, executor: executor)

        await host.activate()
        try await settle { await transport.acknowledgements.count >= 1 }

        let acks = await transport.acknowledgements
        XCTAssertEqual(acks.first?.status, "failed")
        XCTAssertNotNil(acks.first?.error)
        await host.deactivate()
    }

    /// A revoked device is told to stop. Retrying that forever is how a
    /// decommissioned Mac keeps polling a relay that has already refused it.
    func testANonRetryableRefusalStopsTheLoopForGood() async throws {
        let transport = HostTransport(script: [.status(403)])
        let host = makeHost(transport: transport)

        await host.activate()
        try await settle {
            if case .stopped = await host.state { return true }
            return false
        }

        guard case .stopped = await host.state else {
            return XCTFail("a 403 must stop the loop, not retry it")
        }
        // And it must not keep hammering the relay after stopping.
        let before = await transport.requestCount
        try? await Task.sleep(for: .milliseconds(60))
        let after = await transport.requestCount
        XCTAssertEqual(before, after, "a stopped host must make no further requests")
    }

    /// A 5xx is worth another attempt, unlike a 403.
    func testARetryableFailureBacksOffRatherThanStopping() async throws {
        let transport = HostTransport(script: [.status(503), .idle])
        let host = makeHost(transport: transport)

        await host.activate()
        try await settle { await transport.requestCount >= 2 }

        if case .stopped = await host.state {
            XCTFail("a 503 must not stop the loop for good")
        }
        await host.deactivate()
    }

    /// Every host that lost the relay at the same moment would otherwise come
    /// back at the same moment. The jitter is what stops a fleet of Macs
    /// synchronising into a thundering herd against a service that has just
    /// recovered.
    func testBackoffGrowsIsBoundedAndIsJittered() async {
        let host = makeHost(transport: HostTransport(script: []))

        let first = await host.backoffDelay(attempt: 1)
        let later = await host.backoffDelay(attempt: 4)
        XCTAssertGreaterThan(later, first, "backoff must grow with attempts")

        // Bounded, so a long outage does not push the next attempt hours away.
        let veryLate = await host.backoffDelay(attempt: 50)
        XCTAssertLessThanOrEqual(
            veryLate, CodeRemoteHost.maximumBackoff.scaled(by: 1.5),
            "backoff must stay capped"
        )

        // Jittered: two draws at the same attempt must not be identical.
        let hostA = makeHost(transport: HostTransport(script: []), jitter: { 0.5 })
        let hostB = makeHost(transport: HostTransport(script: []), jitter: { 1.5 })
        let a = await hostA.backoffDelay(attempt: 3)
        let b = await hostB.backoffDelay(attempt: 3)
        XCTAssertNotEqual(a, b, "the delay must actually be jittered")
    }

    /// Sign-out and explicit deactivation must stop the loop, so an in-flight
    /// command is not acknowledged against an account that has signed out.
    func testDeactivationStopsTheLoop() async throws {
        let transport = HostTransport(script: [.idle, .idle, .idle])
        let host = makeHost(transport: transport)

        await host.activate()
        try await settle { await transport.requestCount >= 1 }
        await host.deactivate(reason: "Signed out")

        // A claim already in flight when deactivation lands will still come
        // back — that request was issued before the stop and cannot be
        // un-issued. What must not happen is a *new* one being started, so the
        // count is sampled after letting the in-flight one settle and is then
        // required to hold still.
        try? await Task.sleep(for: .milliseconds(40))
        let before = await transport.requestCount
        try? await Task.sleep(for: .milliseconds(80))
        let after = await transport.requestCount
        XCTAssertEqual(before, after, "no new request may start after deactivation")
        let finalState = await host.state
        XCTAssertEqual(finalState, .stopped(reason: "Signed out"))
    }

    // MARK: - Redelivery

    /// The relay hands a command back when its acknowledgement did not land
    /// within the lease. Running it again would send the prompt twice; the
    /// host answers it from what it already did instead.
    func testARedeliveredCommandIsAnsweredWithoutRunningAgain() async throws {
        let transport = HostTransport(script: [
            .command(id: "c1", kind: "message"),
            .command(id: "c1", kind: "message"),
            .idle,
        ])
        let executor = RecordingExecutor()
        let host = makeHost(transport: transport, executor: executor)

        await host.activate()
        try await settle { await transport.acknowledgements.count >= 2 }
        await host.deactivate()

        let executed = await executor.executed
        XCTAssertEqual(executed.map(\.id), ["c1"], "a redelivery must not execute twice")
        let acks = await transport.acknowledgements
        XCTAssertEqual(acks.map(\.status), ["completed", "completed"])
    }

    /// A command the Mac started and never finished — it quit mid-run — may or
    /// may not have taken effect. At most once: it is failed, not retried.
    func testACommandInterruptedMidRunIsFailedRatherThanRunAgain() async throws {
        let seeded = CodeRemoteCommandLedger()
        await seeded.record(.started, for: "c1")
        let transport = HostTransport(script: [.command(id: "c1", kind: "message"), .idle])
        let executor = RecordingExecutor()
        let host = makeHost(transport: transport, executor: executor, ledger: seeded)

        await host.activate()
        try await settle { await transport.acknowledgements.count >= 1 }
        await host.deactivate()

        let executed = await executor.executed
        XCTAssertTrue(executed.isEmpty)
        let acks = await transport.acknowledgements
        XCTAssertEqual(acks.first?.status, "failed")
        XCTAssertNotNil(acks.first?.error)
    }

    /// The ledger survives a relaunch, which is when an unacknowledged command
    /// is most likely to come back.
    func testTheLedgerPersistsAndStaysBounded() async {
        let box = DataBox()
        let ledger = CodeRemoteCommandLedger(
            capacity: 3, read: { box.data }, write: { box.data = $0 }
        )
        for id in ["a", "b", "c", "d"] {
            await ledger.record(.completed(["id": .string(id)]), for: id)
        }

        let reloaded = CodeRemoteCommandLedger(capacity: 3, read: { box.data })
        let oldest = await reloaded.outcome(for: "a")
        let newest = await reloaded.outcome(for: "d")
        XCTAssertNil(oldest, "the oldest entry is dropped past capacity")
        XCTAssertEqual(newest, .completed(["id": .string("d")]))
    }

    /// A lost acknowledgement is retried before the command is left to the
    /// lease, so a brief outage does not turn into a two-minute wait.
    func testATransientAcknowledgementFailureIsRetried() async throws {
        let transport = HostTransport(
            script: [.command(id: "c1", kind: "message"), .idle],
            failingAcknowledgements: 1
        )
        let host = makeHost(transport: transport)

        await host.activate()
        try await settle { await transport.acknowledgements.count >= 1 }
        await host.deactivate()

        let attempts = await transport.acknowledgementAttempts
        XCTAssertEqual(attempts, 2, "one failure, then the retry that lands")
    }

    // MARK: - Helpers

    private func makeHost(
        transport: HostTransport,
        executor: RecordingExecutor = RecordingExecutor(),
        ledger: CodeRemoteCommandLedger = CodeRemoteCommandLedger(),
        jitter: @escaping @Sendable () -> Double = { 1.0 }
    ) -> CodeRemoteHost {
        CodeRemoteHost(
            deviceID: "device-1",
            accountID: account,
            relay: NativeCodeRemoteClient(sender: transport),
            executor: executor,
            ledger: ledger,
            // Real sleeps would make these tests slow and flaky; the backoff
            // arithmetic is asserted directly instead.
            sleep: { _ in try await Task.sleep(for: .milliseconds(1)) },
            jitter: jitter
        )
    }

    private func settle(
        _ condition: @escaping () async -> Bool
    ) async throws {
        for _ in 0..<400 {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("condition never became true")
    }
}

private enum ExecutorFailure: Error { case boom }

/// Stands in for the app's preferences in the ledger's persistence test.
private final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Data?

    var data: Data? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

private actor RecordingExecutor: CodeRemoteCommandExecuting {
    private let failure: (any Error)?
    private(set) var executed: [CodeRemoteCommand] = []

    init(failWith failure: (any Error)? = nil) { self.failure = failure }

    func execute(_ command: CodeRemoteCommand) async throws -> [String: JunoJSONValue] {
        executed.append(command)
        if let failure { throw failure }
        return ["ok": .bool(true)]
    }
}

private actor HostTransport: NativeAuthenticatedRequestSending {
    enum Step {
        case command(id: String, kind: String)
        case idle
        case status(Int)
    }

    struct Acknowledgement {
        let status: String
        let error: String?
    }

    private var script: [Step]
    private var failingAcknowledgements: Int
    private(set) var requestCount = 0
    private(set) var acknowledgementAttempts = 0
    private(set) var acknowledgements: [Acknowledgement] = []

    init(script: [Step], failingAcknowledgements: Int = 0) {
        self.script = script
        self.failingAcknowledgements = failingAcknowledgements
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requestCount += 1

        if request.method == .post, let body = request.body,
            let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let status = object["status"] as? String
        {
            acknowledgementAttempts += 1
            if failingAcknowledgements > 0 {
                failingAcknowledgements -= 1
                return HTTPResponse(
                    statusCode: 503, headers: HTTPHeaders(),
                    body: Data(#"{"error":"unavailable"}"#.utf8)
                )
            }
            acknowledgements.append(
                Acknowledgement(status: status, error: object["error"] as? String)
            )
            return ok(#"{"ok":true}"#)
        }

        // Claims consume the script; once it is exhausted the relay just idles,
        // which keeps a running loop from spinning on a missing fixture.
        let step = script.isEmpty ? Step.idle : script.removeFirst()
        switch step {
        case .idle:
            return ok(#"{"command":null}"#)
        case .command(let id, let kind):
            return ok("""
            {"command":{"id":"\(id)","sessionID":"s1","kind":"\(kind)",
            "payload":{},"status":"claimed"}}
            """)
        case .status(let code):
            return HTTPResponse(
                statusCode: code, headers: HTTPHeaders(),
                body: Data(#"{"error":"refused"}"#.utf8)
            )
        }
    }

    private func ok(_ body: String) -> HTTPResponse {
        HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}
