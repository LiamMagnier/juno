import Foundation
import JunoStorage
import Testing

@testable import JunoSync

/// Diagnostics exists to answer "what actually failed" from the device. These
/// pin the two things the previous investigation could not establish: whether
/// the server answered at all, and what kind of failure it was.
@Suite struct NativeSyncDiagnosticsTests {
    typealias Model = NativeSyncModel<InMemoryTransactionalStore>

    @Test func serverRefusalCarriesItsHTTPStatus() {
        let error = NativeBootstrapError.server(statusCode: 401, code: "unauthenticated")
        #expect(Model.httpStatusCode(of: error) == 401)
        #expect(Model.failureKind(of: error) == "bootstrap http 401 (unauthenticated)")
    }

    /// The distinction the Offline banner got wrong: a transport failure never
    /// reached a server, so there is no status to report. Reporting `0` or
    /// `-1` here would read as a real HTTP answer.
    @Test func transportFailureHasNoHTTPStatus() {
        let error = URLError(.notConnectedToInternet)
        #expect(Model.httpStatusCode(of: error) == nil)
        #expect(Model.failureKind(of: error).hasPrefix("transport"))
    }

    /// A contract mismatch is the exact defect that stalled the previous build,
    /// and the useful form names *both* versions — knowing only that they
    /// differ does not say which side to move.
    @Test func contractMismatchNamesBothVersions() {
        let error = NativeBootstrapError.contractVersionMismatch(
            expected: "1.3.0", received: "1.0.1"
        )
        #expect(Model.httpStatusCode(of: error) == nil)
        #expect(Model.failureKind(of: error) == "contract mismatch — build 1.3.0, server 1.0.1")
        // And it must not be presented as an outage: retrying cannot fix it.
        #expect(Model.isConnectivityFailure(error) == false)
    }

    @Test func syncServerErrorCarriesItsStatus() {
        let error = NativeSyncAPIError.server(
            statusCode: 503, code: "unavailable", retryable: true, retryAfterMilliseconds: 1_000
        )
        #expect(Model.httpStatusCode(of: error) == 503)
        #expect(Model.failureKind(of: error) == "sync http 503 (unavailable)")
    }

    /// No diagnostic string may ever carry a credential. The failure kinds are
    /// built only from status codes, error codes and version strings, so this
    /// asserts the shape rather than trusting the review.
    @Test func failureKindsNeverEmbedSecrets() {
        let errors: [any Error] = [
            NativeBootstrapError.server(statusCode: 403, code: "forbidden"),
            NativeBootstrapError.malformedResponse,
            NativeBootstrapError.accountMismatch,
            URLError(.timedOut),
            NativeSyncCoordinatorError.retryLimitExceeded,
        ]
        for error in errors {
            let kind = Model.failureKind(of: error)
            #expect(!kind.lowercased().contains("bearer"))
            #expect(!kind.lowercased().contains("token"))
            #expect(!kind.contains("Authorization"))
        }
    }
}

@Suite struct NativeOutboxDiagnosticsTests {
    private func draft(_ id: String) -> MutationDraft {
        MutationDraft(
            id: OutboxMutationID(id),
            accountID: StorageAccountID("acct"),
            idempotencyKey: IdempotencyKey("key-\(id)"),
            entity: RecordKey(namespace: "conversation", id: "c-\(id)"),
            operation: "update",
            payload: Data("{}".utf8),
            createdAt: Date(timeIntervalSince1970: 0)
        )
    }

    /// Terminal states are excluded from `unresolved`: acknowledged work has
    /// reached the server and discarded work was deliberately dropped, so
    /// neither is at risk when a build is replaced.
    @Test func unresolvedExcludesTerminalStates() {
        let now = Date(timeIntervalSince1970: 100)
        let mutations = [
            QueuedMutation(draft: draft("1"), state: .pending),
            QueuedMutation(
                draft: draft("2"),
                state: .leased(MutationLease(
                    token: "t", owner: "o", leasedAt: now, expiresAt: now.addingTimeInterval(30)
                ))
            ),
            QueuedMutation(
                draft: draft("3"),
                state: .retryScheduled(MutationRetry(eligibleAt: now, errorCode: "e"))
            ),
            QueuedMutation(
                draft: draft("4"),
                state: .conflicted(MutationConflict(
                    detectedAt: now, localRevision: 1, serverRevision: 2, reason: "r"
                ))
            ),
            QueuedMutation(draft: draft("5"), state: .acknowledged(at: now)),
            QueuedMutation(draft: draft("6"), state: .discarded(at: now, reason: "r")),
        ]

        let counts = NativeOutboxDiagnostics.count(mutations)
        #expect(counts.pending == 1)
        #expect(counts.inFlight == 1)
        #expect(counts.retryScheduled == 1)
        #expect(counts.conflicted == 1)
        #expect(counts.unresolved == 4)
    }

    @Test func emptyOutboxHasNothingUnresolved() {
        #expect(NativeOutboxDiagnostics.count([]).unresolved == 0)
        #expect(NativeOutboxDiagnostics.empty.unresolved == 0)
    }
}
