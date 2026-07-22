import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest

@testable import JunoChatKit

/// Every screen has to answer the same question the same way: was this an
/// outage, or did the server answer and refuse?
///
/// `NativeSyncModel.isConnectivityFailure` is the single definition, and it
/// exists because two easy readings are both wrong. A genuine outage does *not*
/// arrive as a `URLError`: `synchronizeWithRetry` swallows it across six
/// attempts and throws `retryLimitExceeded` instead. And `URLError.cancelled`
/// is a control-flow signal, not a verdict about the network.
///
/// Three stores were classifying by `error is URLError` or not classifying at
/// all, so they disagreed with the sync layer about the same failure. These
/// tests drive the real models through a failing transport and pin the answer.
@MainActor
final class NativeFailureClassificationTests: XCTestCase {
    private let account = "account-a"

    // MARK: - Artifacts

    /// A real outage reaches the store as `retryLimitExceeded`. Under the old
    /// `error is URLError` test this became `.failed` — a dead end with no
    /// Retry — when in fact retrying is exactly the right response.
    func testArtifactOutageIsOfflineNotFailed() async throws {
        let model = makeArtifactModel(
            failing: NativeSyncCoordinatorError.retryLimitExceeded
        )
        await model.start(for: try AccountID(account))
        await model.deleteArtifact(id: "artifact-a")

        XCTAssertEqual(
            model.phase, .offline,
            "An exhausted retry ladder is an outage; presenting it as a hard failure strands the reader."
        )
    }

    /// The mirror case. A 403 is the server answering and refusing, so calling
    /// it "offline" hands the reader a Retry button that can never succeed.
    func testArtifactRefusalIsFailedNotOffline() async throws {
        let model = makeArtifactModel(
            failing: NativeSyncAPIError.server(
                statusCode: 403, code: "forbidden", retryable: false, retryAfterMilliseconds: nil
            )
        )
        await model.start(for: try AccountID(account))
        await model.deleteArtifact(id: "artifact-a")

        XCTAssertEqual(model.phase, .failed)
        XCTAssertNotNil(model.lastErrorDescription)
    }

    /// Cancellation is not a connectivity verdict.
    func testArtifactCancellationIsNotReportedAsOffline() async throws {
        let model = makeArtifactModel(failing: URLError(.cancelled))
        await model.start(for: try AccountID(account))
        await model.deleteArtifact(id: "artifact-a")

        XCTAssertEqual(
            model.phase, .failed,
            "URLError.cancelled is control flow, not an outage."
        )
    }

    // MARK: - Projects

    /// The project store used to set a phase *only* for `URLError`, so any
    /// other failure left an error banner sitting over a `.ready` phase: the
    /// screen claimed to be fine and complained at the same time.
    func testProjectRefusalLeavesNoReadyPhaseWithAnError() async throws {
        let model = try await makeProjectModel(
            failing: NativeSyncAPIError.server(
                statusCode: 500, code: "server_error", retryable: false, retryAfterMilliseconds: nil
            )
        )
        await model.start(for: try AccountID(account))
        await model.uploadFile(
            data: Data("hello".utf8),
            fileName: "notes.txt",
            mimeType: "text/plain",
            projectID: "project-a"
        )

        XCTAssertNotNil(model.lastErrorDescription)
        XCTAssertNotEqual(
            model.phase, .ready,
            "A screen must not report an error while claiming to be ready."
        )
        XCTAssertEqual(model.phase, .failed)
    }

    func testProjectOutageIsOffline() async throws {
        let model = try await makeProjectModel(
            failing: NativeSyncCoordinatorError.retryLimitExceeded
        )
        await model.start(for: try AccountID(account))
        await model.uploadFile(
            data: Data("hello".utf8),
            fileName: "notes.txt",
            mimeType: "text/plain",
            projectID: "project-a"
        )

        XCTAssertEqual(model.phase, .offline)
    }

    // MARK: - Helpers

    private func makeSyncModel(
        _ repository: InMemoryTransactionalStore,
        sender: AlwaysFailingSender
    ) -> NativeSyncModel<InMemoryTransactionalStore> {
        let coordinator = NativeSyncCoordinator(repository: repository, sender: sender)
        return NativeSyncModel(
            coordinator: coordinator,
            monitor: NativeSyncMonitor(coordinator: coordinator, streamer: sender)
        )
    }

    private func makeArtifactModel(
        failing error: any Error
    ) -> NativeArtifactModel<InMemoryTransactionalStore> {
        let repository = InMemoryTransactionalStore()
        let sender = AlwaysFailingSender(error: error)
        return NativeArtifactModel(
            repository: repository,
            syncModel: makeSyncModel(repository, sender: sender),
            sender: sender
        )
    }

    private func makeProjectModel(
        failing error: any Error
    ) async throws -> NativeProjectModel<InMemoryTransactionalStore> {
        let repository = InMemoryTransactionalStore()
        try await seedProject(repository)
        let sender = AlwaysFailingSender(error: error)
        let outbox = InMemoryMutationOutbox()
        return NativeProjectModel(
            repository: repository,
            outbox: outbox,
            drainer: NativeMutationDrainer(
                repository: repository, outbox: outbox, sender: sender
            ),
            syncModel: makeSyncModel(repository, sender: sender),
            sender: sender
        )
    }

    /// `uploadFile` refuses a project it cannot see locally, so without this the
    /// test would never reach the classification it is checking.
    private func seedProject(_ repository: InMemoryTransactionalStore) async throws {
        let payload = """
        {"id":"project-a","name":"Project A","nameSource":"user","instructions":"",\
        "starred":false,"createdAt":"2026-07-21T12:00:00.000Z",\
        "updatedAt":"2026-07-21T12:01:00.000Z"}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: StorageAccountID(account),
            operations: [
                .upsert(StoredRecord(
                    accountID: StorageAccountID(account),
                    key: RecordKey(namespace: "project", id: "project-a"),
                    revision: 8,
                    updatedAt: Date(),
                    payload: Data(payload.utf8)
                ))
            ]
        ))
    }
}

/// Fails every request with one chosen error, so a test names the failure it
/// cares about instead of contriving a transport that produces it.
private struct AlwaysFailingSender: NativeAuthenticatedRequestSending,
    NativeAuthenticatedByteStreaming, Sendable
{
    let error: any Error

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws
        -> HTTPResponse
    { throw error }

    func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPByteStreamResponse { throw error }
}
