import Foundation
import JunoStorage

/// A count of what the durable outbox is still holding, across every entity
/// type.
///
/// The per-feature stores each track their own slice (settings and memory, for
/// instance), which is the right thing for their own banners but useless for
/// the question Diagnostics has to answer: *is anything at all still waiting to
/// reach the server?* Before deleting or replacing an installed build, that is
/// the number that says whether unsynchronized work would be lost.
public struct NativeOutboxDiagnostics: Equatable, Sendable {
    /// Queued and never attempted.
    public let pending: Int
    /// Currently leased by a drainer — in flight right now.
    public let inFlight: Int
    /// Failed and waiting on a backoff timer.
    public let retryScheduled: Int
    /// Rejected as a conflict; needs a resolution decision.
    public let conflicted: Int

    public init(pending: Int, inFlight: Int, retryScheduled: Int, conflicted: Int) {
        self.pending = pending
        self.inFlight = inFlight
        self.retryScheduled = retryScheduled
        self.conflicted = conflicted
    }

    public static let empty = NativeOutboxDiagnostics(
        pending: 0, inFlight: 0, retryScheduled: 0, conflicted: 0
    )

    /// Everything not yet accepted by the server. `acknowledged` and
    /// `discarded` are excluded: they are terminal and losing them costs
    /// nothing.
    public var unresolved: Int {
        pending + inFlight + retryScheduled + conflicted
    }

    public static func count(_ mutations: [QueuedMutation]) -> NativeOutboxDiagnostics {
        var pending = 0, inFlight = 0, retryScheduled = 0, conflicted = 0
        for mutation in mutations {
            switch mutation.state {
            case .pending: pending += 1
            case .leased: inFlight += 1
            case .retryScheduled: retryScheduled += 1
            case .conflicted: conflicted += 1
            case .acknowledged, .discarded: break
            }
        }
        return NativeOutboxDiagnostics(
            pending: pending,
            inFlight: inFlight,
            retryScheduled: retryScheduled,
            conflicted: conflicted
        )
    }

    public static func read(
        from outbox: any MutationOutboxRepository,
        accountID: StorageAccountID
    ) async throws -> NativeOutboxDiagnostics {
        count(try await outbox.mutations(accountID: accountID))
    }
}
