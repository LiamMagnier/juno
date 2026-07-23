import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import XCTest
@testable import JunoSync

/// Regression tests for the real-device defect where an authenticated iPhone sat
/// on "Offline — showing saved settings" with a Retry button that could never
/// succeed.
///
/// The device was on a working network. The installed build declared contract
/// 1.2.0; production had been deployed at 1.3.0. `NativeBootstrapClient` correctly
/// threw `contractVersionMismatch` — and then `NativeSyncModel` filed *every*
/// error under `.offline`, so a permanent protocol incompatibility was presented
/// as a transient network problem and the real explanation never reached the UI.
///
/// The distinction under test: `.offline` means "could not reach the server, retry
/// is the right response"; `.failed` means "reached the server and cannot
/// proceed", which retrying cannot fix.
@MainActor
final class NativeSyncModelPhaseTests: XCTestCase {
    func testContractVersionMismatchIsFailedNotOffline() async throws {
        let model = makeModel(sender: FailingSender(
            error: NativeBootstrapError.contractVersionMismatch(
                expected: "1.2.0",
                received: "1.3.0"
            )
        ))

        model.start(for: try AccountID("account-a"))
        await settle(model)

        XCTAssertEqual(
            model.phase, .failed,
            "A contract mismatch is not a connectivity problem and must not be reported as offline."
        )
        XCTAssertEqual(
            model.lastErrorDescription,
            "This version of Juno is not compatible with the server.",
            "The reader has to be told to update; a nil description renders as a bare offline banner."
        )
    }

    func testServerRejectionIsFailedNotOffline() async throws {
        let model = makeModel(sender: FailingSender(
            error: NativeBootstrapError.server(statusCode: 401, code: "unauthorized")
        ))

        model.start(for: try AccountID("account-a"))
        await settle(model)

        XCTAssertEqual(model.phase, .failed)
        XCTAssertNotNil(model.lastErrorDescription)
    }

    func testMalformedResponseIsFailedNotOffline() async throws {
        let model = makeModel(sender: FailingSender(error: NativeBootstrapError.malformedResponse))

        model.start(for: try AccountID("account-a"))
        await settle(model)

        XCTAssertEqual(
            model.phase, .failed,
            "A decode failure means the server answered; retrying the same request cannot fix it."
        )
    }

    /// A real outage does not surface as `URLError`. `synchronizeWithRetry`
    /// absorbs it across six attempts and throws `retryLimitExceeded`, so this is
    /// the error the model actually sees when the network is down — and it must
    /// still read as offline, where Retry is the right affordance.
    func testExhaustedRetriesReadAsOfflineNotFailed() {
        typealias Model = NativeSyncModel<InMemoryTransactionalStore>

        XCTAssertTrue(
            Model.isConnectivityFailure(NativeSyncCoordinatorError.retryLimitExceeded),
            "Matching only URLError would report a genuine network outage as a hard failure."
        )
    }

    /// Coordinator errors that are not about reachability must not be excused as
    /// offline just because they come from the same enum.
    func testNonConnectivityCoordinatorErrorsAreNotOffline() {
        typealias Model = NativeSyncModel<InMemoryTransactionalStore>

        XCTAssertFalse(Model.isConnectivityFailure(NativeSyncCoordinatorError.corruptStoredCursor))
        XCTAssertFalse(Model.isConnectivityFailure(NativeSyncCoordinatorError.repeatedCompaction))
    }

    /// The classifier is what the account stores consult, so pin it directly too.
    func testConnectivityClassifier() {
        typealias Model = NativeSyncModel<InMemoryTransactionalStore>

        XCTAssertTrue(Model.isConnectivityFailure(URLError(.networkConnectionLost)))
        XCTAssertTrue(Model.isConnectivityFailure(URLError(.cannotConnectToHost)))
        XCTAssertFalse(
            Model.isConnectivityFailure(URLError(.cancelled)),
            "Cancellation is a control-flow signal, not a verdict about the network."
        )
        XCTAssertFalse(Model.isConnectivityFailure(
            NativeBootstrapError.contractVersionMismatch(expected: "1.2.0", received: "1.3.0")
        ))
        XCTAssertFalse(Model.isConnectivityFailure(NativeBootstrapError.accountMismatch))
    }

    /// Retry after a temporary failure must actually recover rather than latch
    /// in a terminal state.
    ///
    /// The first bootstrap is refused with a hard error, which parks the model in
    /// `.failed` and clears its task. Retry then has to restart synchronization
    /// from scratch and reach `.live`.
    func testRetryRecoversAfterTemporaryFailure() async throws {
        let sender = ScriptedSender(outcomes: [
            .failure(NativeBootstrapError.server(statusCode: 503, code: "unavailable")),
            .success(bootstrapBody(cursor: "42")),
            .success(#"{"items":[],"nextAfter":null,"hasMore":false}"#),
            .success(#"{"after":"42","changes":[],"nextCursor":"42","compactionFloorCursor":"10","hasMore":false}"#),
        ])
        let model = makeModel(sender: sender)

        model.start(for: try AccountID("account-a"))
        await settle(model)
        XCTAssertEqual(model.phase, .failed, "precondition: the first attempt is refused")
        XCTAssertNotNil(model.lastErrorDescription)

        await model.refresh()
        await settle(model)

        XCTAssertEqual(
            model.phase, .live,
            "Retry after a temporary failure has to recover, not latch in the failed state."
        )
        XCTAssertNil(
            model.lastErrorDescription,
            "A recovered sync must clear the stale error, or the banner outlives the problem."
        )
    }

    // MARK: - Helpers

    private func makeModel(
        sender: any NativeAuthenticatedRequestSending & NativeAuthenticatedByteStreaming
    ) -> NativeSyncModel<InMemoryTransactionalStore> {
        let coordinator = NativeSyncCoordinator(
            repository: InMemoryTransactionalStore(),
            sender: sender
        )
        return NativeSyncModel(
            coordinator: coordinator,
            monitor: NativeSyncMonitor(coordinator: coordinator, streamer: sender)
        )
    }

    /// `start` runs its work in a detached Task; yield until the phase settles.
    private func settle(_ model: NativeSyncModel<InMemoryTransactionalStore>) async {
        for _ in 0..<200 {
            if model.phase != .synchronizing && model.phase != .idle { return }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    private func bootstrapBody(cursor: String) -> String {
        """
        {"profile":{"id":"account-a","name":"Tester","email":"test@juno.test","image":null},\
        "subscription":{"plan":"free","status":"active"},\
        "usage":{"period":"2026-07","messageCount":0,"promptTokens":"0","completionTokens":"0"},\
        "settings":null,"featureFlags":{},"currentChangeCursor":"\(cursor)",\
        "compactionFloorCursor":"10","modelManifestVersion":"models-1",\
        "contractVersion":"\(JunoNativeContract.version)","minimumClientVersions":{},"announcements":[]}
        """
    }
}

// MARK: - Doubles

/// Always throws the same error, so the phase under test is unambiguous.
private actor FailingSender: NativeAuthenticatedRequestSending, NativeAuthenticatedByteStreaming {
    private let error: any Error
    init(error: any Error) { self.error = error }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) throws -> HTTPResponse {
        throw error
    }

    func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) throws -> HTTPByteStreamResponse {
        throw error
    }
}

/// Fails first, then serves a scripted successful bootstrap — the shape of a
/// temporary network failure followed by a working Retry.
private actor ScriptedSender: NativeAuthenticatedRequestSending, NativeAuthenticatedByteStreaming {
    enum Outcome {
        case failure(any Error)
        case success(String)
    }

    private var outcomes: [Outcome]
    init(outcomes: [Outcome]) { self.outcomes = outcomes }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) throws -> HTTPResponse {
        guard !outcomes.isEmpty else {
            return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data("{}".utf8))
        }
        switch outcomes.removeFirst() {
        case .failure(let error):
            throw error
        case .success(let body):
            return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(body.utf8))
        }
    }

    func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) -> HTTPByteStreamResponse {
        // Park the monitor so its wakeup loop never races the assertions.
        // The content type has to be a real event stream or the wakeup client
        // rejects it and drives the model straight back into a failed phase.
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: (try? HTTPHeaders(["content-type": "text/event-stream"])) ?? HTTPHeaders(),
            bytes: AsyncThrowingStream { _ in }
        )
    }
}
