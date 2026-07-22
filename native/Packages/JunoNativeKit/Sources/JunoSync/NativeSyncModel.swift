import Foundation
import JunoCore
import JunoStorage
import Observation

@MainActor
@Observable
public final class NativeSyncModel<Repository: AccountScopedRepository> {
    public enum Phase: Equatable, Sendable {
        case idle
        case synchronizing
        case live
        /// The device could not reach the server. Retrying is the right response.
        case offline
        /// The server was reached and refused, or answered something this build
        /// cannot use — a contract-version mismatch, a rejected token, a decode
        /// failure. Retrying the same request cannot fix any of these, so this is
        /// deliberately *not* `.offline`: presenting it as a network problem
        /// hands the reader a Retry button that can never succeed.
        case failed
    }

    /// Whether a failure means "the network is unavailable" as opposed to "the
    /// server answered and we cannot proceed".
    ///
    /// Transport failures count. Everything else — including
    /// `NativeBootstrapError.contractVersionMismatch`, HTTP 4xx/5xx surfaced as
    /// `.server`, and decoding errors — is a real, non-transient failure that the
    /// reader has to be told about.
    ///
    /// Two cases are easy to get wrong, and both were:
    ///
    /// - `retryLimitExceeded` is what a genuine outage actually surfaces.
    ///   `synchronizeWithRetry` swallows the underlying `URLError` across six
    ///   attempts and then throws *its own* error, so matching only `URLError`
    ///   would report a real network outage as a hard failure.
    /// - `URLError.cancelled` is a control-flow signal, not a connectivity
    ///   verdict, so it is deliberately excluded.
    public static func isConnectivityFailure(_ error: any Error) -> Bool {
        if let coordinatorError = error as? NativeSyncCoordinatorError {
            return coordinatorError == .retryLimitExceeded
        }
        if let syncError = error as? NativeSyncAPIError { return syncError.isRetryable }
        guard let urlError = error as? URLError else { return false }
        return urlError.code != .cancelled
    }

    public private(set) var phase: Phase = .idle
    public private(set) var cursor: String?
    public private(set) var lastErrorDescription: String?
    public private(set) var synchronizationGeneration = 0

    private let coordinator: NativeSyncCoordinator<Repository>
    private let monitor: NativeSyncMonitor<Repository>
    private var task: Task<Void, Never>?
    private var activeAccountID: AccountID?
    private var runID: UUID?

    public init(
        coordinator: NativeSyncCoordinator<Repository>,
        monitor: NativeSyncMonitor<Repository>
    ) {
        self.coordinator = coordinator
        self.monitor = monitor
    }

    public func start(for accountID: AccountID) {
        guard activeAccountID != accountID || task == nil else { return }
        stop()
        activeAccountID = accountID
        let currentRunID = UUID()
        runID = currentRunID
        phase = .synchronizing
        lastErrorDescription = nil
        task = Task { [self, coordinator, monitor] in
            do {
                let initial = try await coordinator.synchronizeWithRetry(for: accountID)
                try Task.checkCancellation()
                recordSynchronization(initial, runID: currentRunID)
                try await monitor.run(
                    for: accountID,
                    startingAt: initial
                ) { result in
                    await self.recordSynchronization(result, runID: currentRunID)
                }
            } catch is CancellationError {
                return
            } catch {
                guard runID == currentRunID else { return }
                lastErrorDescription = error.localizedDescription
                phase = Self.isConnectivityFailure(error) ? .offline : .failed
                task = nil
            }
        }
    }

    public func refresh() async {
        guard let activeAccountID, let currentRunID = runID else { return }
        guard task != nil else {
            start(for: activeAccountID)
            return
        }
        phase = .synchronizing
        do {
            let result = try await coordinator.synchronizeWithRetry(for: activeAccountID)
            recordSynchronization(result, runID: currentRunID)
        } catch {
            guard runID == currentRunID else { return }
            lastErrorDescription = error.localizedDescription
            phase = Self.isConnectivityFailure(error) ? .offline : .failed
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        activeAccountID = nil
        runID = nil
        cursor = nil
        lastErrorDescription = nil
        phase = .idle
    }

    private func recordSynchronization(
        _ result: NativeSyncResult,
        runID expectedRunID: UUID
    ) {
        guard runID == expectedRunID else { return }
        cursor = result.cursor
        synchronizationGeneration &+= 1
        lastErrorDescription = nil
        phase = .live
    }

    #if DEBUG
    /// Development-only: force a phase without touching the network, so the
    /// local UI Preview harness can present live/offline states. Never called by
    /// the shipping app.
    public func previewConfigure(phase: Phase, errorDescription: String? = nil) {
        self.phase = phase
        self.lastErrorDescription = errorDescription
        synchronizationGeneration &+= 1
    }
    #endif
}
