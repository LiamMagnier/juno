import XCTest
import JunoAuth
import JunoCore
@testable import JunoWorkKit

/// The claim loop, exercised against the failures that actually happen.
///
/// Everything here is a seam test rather than an integration test, because the
/// interesting states — a revocation arriving mid-poll, a lease expiring while
/// a command runs, a re-delivery after a lost acknowledgement — are all timing
/// states that a live server reproduces by accident at best.
/// Hoisted to file scope because `XCTestCase` is not `Sendable`, so a test
/// instance cannot be captured by the `@Sendable` policy provider the host
/// takes. Making it a global constant is the honest fix; making the test class
/// `@unchecked Sendable` would silence the compiler about a real rule.
private let enabledPolicy = WorkHostPolicy(enabled: true, allowsFileWork: true)

final class WorkRemoteHostTests: XCTestCase {
    private let account = try! AccountID("account-a")

    // MARK: - Doubles

    /// Records what the host said to the relay, and hands back scripted claims.
    private actor RecordingRelay: WorkRelaying {
        private var queue: [WorkCommand]
        private(set) var acknowledgements: [(id: String, status: String, error: String?)] = []
        private(set) var advertisements: [WorkHostPolicy] = []
        /// Set to make the next claim throw, simulating a relay refusal.
        var nextClaimError: (any Error)?

        init(queue: [WorkCommand] = []) { self.queue = queue }

        func claimNextWorkCommand(
            hostID: String, for accountID: AccountID
        ) async throws -> WorkCommand? {
            if let error = nextClaimError {
                nextClaimError = nil
                throw error
            }
            return queue.isEmpty ? nil : queue.removeFirst()
        }

        func acknowledgeWorkCommand(
            hostID: String, commandID: String, status: String,
            result: [String: JunoJSONValue]?, error: String?, for accountID: AccountID
        ) async throws {
            acknowledgements.append((commandID, status, error))
        }

        func advertiseWorkHost(
            hostID: String, policy: WorkHostPolicy, for accountID: AccountID
        ) async throws {
            advertisements.append(policy)
        }

        func setNextClaimError(_ error: any Error) { nextClaimError = error }
    }

    private actor CountingExecutor: WorkCommandExecuting {
        private(set) var executed: [String] = []
        private let failWith: (any Error)?

        init(failWith: (any Error)? = nil) { self.failWith = failWith }

        func execute(_ command: WorkCommand) async throws -> [String: JunoJSONValue] {
            executed.append(command.id)
            if let failWith { throw failWith }
            return ["ok": .bool(true)]
        }
    }

    // MARK: - Helpers

    private func command(
        id: String = "cmd_1",
        kind: String = "start",
        expiresIn seconds: TimeInterval = 300,
        now: Date = Date(timeIntervalSince1970: 1_000_000)
    ) -> WorkCommand {
        WorkCommand(
            id: id, sessionID: "sess_1", runID: "run_1", kind: kind, payload: [:],
            status: "claimed", leaseExpiresAt: now.addingTimeInterval(60),
            expiresAt: now.addingTimeInterval(seconds)
        )
    }


    private func makeHost(
        relay: any WorkRelaying,
        executor: any WorkCommandExecuting,
        policy: @escaping @Sendable () async -> WorkHostPolicy,
        now: Date = Date(timeIntervalSince1970: 1_000_000)
    ) -> WorkRemoteHost {
        WorkRemoteHost(
            hostID: "host_1", accountID: account, relay: relay, executor: executor,
            policyProvider: policy,
            now: { now },
            sleep: { _ in },
            jitter: { 1.0 }
        )
    }

    // MARK: - Activation

    func testActivationIsRefusedWhenWorkIsSwitchedOff() async {
        let relay = RecordingRelay()
        let executor = CountingExecutor()
        let host = makeHost(relay: relay, executor: executor, policy: { .denied })

        let started = await host.activate()

        XCTAssertFalse(started, "a Mac with Work off must not start a loop that would refuse everything it claimed")
        let advertised = await relay.advertisements
        XCTAssertTrue(advertised.isEmpty, "a disabled host must not advertise itself as available")
        let state = await host.state
        guard case .stopped = state else {
            return XCTFail("expected .stopped, got \(state)")
        }
    }

    func testDeactivationIsTerminalAndNotRetried() async {
        let relay = RecordingRelay()
        let host = makeHost(relay: relay, executor: CountingExecutor(), policy: { enabledPolicy })
        _ = await host.activate()
        await host.deactivate(reason: "Signed out")

        let state = await host.state
        guard case .stopped(let reason) = state else {
            return XCTFail("expected .stopped, got \(state)")
        }
        XCTAssertEqual(reason, "Signed out")
    }

    // MARK: - The escalation boundary

    func testAnExpiredCommandIsRefusedRatherThanExecuted() {
        let host = makeHost(relay: RecordingRelay(), executor: CountingExecutor(), policy: { enabledPolicy })
        let stale = command(expiresIn: -1)

        let refusal = host.refusal(for: stale, under: enabledPolicy)

        XCTAssertEqual(
            refusal, .expired,
            "a stop claimed by a host that was offline for an hour would otherwise stop a run the user has since restarted"
        )
    }

    func testStartIsRefusedWhenNoLocalCapabilityWasGranted() {
        let host = makeHost(relay: RecordingRelay(), executor: CountingExecutor(), policy: { enabledPolicy })
        let bare = WorkHostPolicy(enabled: true)

        XCTAssertEqual(host.refusal(for: command(kind: "start"), under: bare), .capabilityNotGranted)
        XCTAssertNil(host.refusal(for: command(kind: "start"), under: enabledPolicy))
    }

    func testGrantingAFolderRequiresFileWorkToBeOn() {
        let host = makeHost(relay: RecordingRelay(), executor: CountingExecutor(), policy: { enabledPolicy })
        let noFiles = WorkHostPolicy(enabled: true, allowsComputerUse: true)

        XCTAssertEqual(
            host.refusal(for: command(kind: "grant_folder"), under: noFiles),
            .capabilityNotGranted
        )
    }

    func testControlCommandsNeedNoCapabilityBeyondWorkBeingOn() {
        let host = makeHost(relay: RecordingRelay(), executor: CountingExecutor(), policy: { enabledPolicy })
        let bare = WorkHostPolicy(enabled: true)

        for kind in ["pause", "stop", "answer", "approve", "deny", "undo", "ping"] {
            XCTAssertNil(
                host.refusal(for: command(kind: kind), under: bare),
                "\(kind) only reduces what is happening or answers a question the host asked"
            )
        }
    }

    func testAnUnknownCommandKindIsRefused() {
        let host = makeHost(relay: RecordingRelay(), executor: CountingExecutor(), policy: { enabledPolicy })
        XCTAssertEqual(
            host.refusal(for: command(kind: "exfiltrate"), under: enabledPolicy),
            .unsupportedKind,
            "an instruction this build does not understand must be refused, never best-guessed"
        )
    }

    func testWorkDisabledRefusesEvenAControlCommand() {
        let host = makeHost(relay: RecordingRelay(), executor: CountingExecutor(), policy: { enabledPolicy })
        XCTAssertEqual(host.refusal(for: command(kind: "ping"), under: .denied), .workDisabled)
    }

    // MARK: - Command validity

    func testCommandValidityIsCheckedAgainstTheClock() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertTrue(command(expiresIn: 60, now: now).isStillValid(at: now))
        XCTAssertFalse(command(expiresIn: 60, now: now).isStillValid(at: now.addingTimeInterval(61)))
    }

    // MARK: - Host summaries

    func testAStaleHostIsNotOfferedAsAbleToServeWork() {
        let stale = WorkHostSummary(
            hostID: "h", deviceID: "d", displayName: "Mac", state: "stale",
            enabled: true, capabilities: ["local_files"], activeRunCount: 0,
            queuedRunCount: 0, lastSeenAt: Date(), revokedAt: nil
        )
        XCTAssertFalse(
            stale.canServeWork,
            "a host that heartbeats but does not claim accepts work into a queue and never runs it"
        )
    }

    func testARevokedHostCannotServeWorkEvenWhenOnline() {
        let revoked = WorkHostSummary(
            hostID: "h", deviceID: "d", displayName: "Mac", state: "online",
            enabled: true, capabilities: ["local_files"], activeRunCount: 0,
            queuedRunCount: 0, lastSeenAt: Date(), revokedAt: Date()
        )
        XCTAssertFalse(revoked.canServeWork)
    }

    func testADisabledHostCannotServeWorkEvenWhenOnline() {
        let off = WorkHostSummary(
            hostID: "h", deviceID: "d", displayName: "Mac", state: "online",
            enabled: false, capabilities: [], activeRunCount: 0,
            queuedRunCount: 0, lastSeenAt: Date(), revokedAt: nil
        )
        XCTAssertFalse(off.canServeWork)
    }

    // MARK: - Approvals

    func testAnExpiredApprovalIsNotAnswerable() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let approval = WorkApprovalRequest(
            approvalID: "a", runID: "r", action: "work.connector.send_message",
            risk: "irreversible", summary: "Send the draft to Dana",
            detail: [:], actionDigest: "abc", expiresAt: now.addingTimeInterval(-1),
            decision: "pending"
        )
        XCTAssertFalse(
            approval.isAnswerable(at: now),
            "approving a send at 09:00 must not still authorise it at 17:00 after the draft was rewritten"
        )
    }

    func testAnAlreadyDecidedApprovalIsNotAnswerableAgain() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let approval = WorkApprovalRequest(
            approvalID: "a", runID: "r", action: "work.file.permanent_delete",
            risk: "irreversible", summary: "Delete 3 files permanently",
            detail: [:], actionDigest: "abc", expiresAt: now.addingTimeInterval(600),
            decision: "allowed"
        )
        XCTAssertFalse(approval.isAnswerable(at: now))
    }

    // MARK: - Errors

    func testPermanentFailuresAreNotRetryable() {
        XCTAssertFalse(WorkRemoteError.hostRevoked.isRetryable)
        XCTAssertFalse(WorkRemoteError.hostNotEnabled.isRetryable)
        XCTAssertFalse(WorkRemoteError.approvalDigestMismatch.isRetryable)
        XCTAssertFalse(WorkRemoteError.approvalExpired.isRetryable)
        XCTAssertFalse(WorkRemoteError.capabilityNotGranted("local_files").isRetryable)
    }

    func testServerRetryabilityIsCarriedFromTheServer() {
        XCTAssertTrue(WorkRemoteError.server(statusCode: 503, message: "busy", retryable: true).isRetryable)
        XCTAssertFalse(WorkRemoteError.server(statusCode: 403, message: "no", retryable: false).isRetryable)
    }

    func testEveryErrorHasAMessageWrittenForAPerson() {
        let errors: [WorkRemoteError] = [
            .invalidIdentifier, .unsupportedCommand("x"), .malformedResponse,
            .hostRevoked, .hostNotEnabled, .capabilityNotGranted("local_files"),
            .approvalDigestMismatch, .approvalExpired,
            .server(statusCode: 500, message: "Juno could not finish that.", retryable: true),
        ]
        for error in errors {
            let description = error.errorDescription ?? ""
            XCTAssertFalse(description.isEmpty, "\(error) has no user-facing description")
            XCTAssertFalse(
                description.contains("("),
                "\(error) reads like an enum case rather than a sentence: \(description)"
            )
        }
    }

    // MARK: - Backoff

    func testBackoffGrowsAndIsCapped() async {
        let host = makeHost(relay: RecordingRelay(), executor: CountingExecutor(), policy: { enabledPolicy })

        let first = await host.backoffDelay(attempt: 1)
        let second = await host.backoffDelay(attempt: 2)
        let far = await host.backoffDelay(attempt: 40)

        XCTAssertLessThan(first, second, "the delay must grow with consecutive failures")
        XCTAssertLessThanOrEqual(
            far, WorkRemoteHost.maximumBackoff,
            "an unbounded backoff means a Mac that never comes back"
        )
    }
}
