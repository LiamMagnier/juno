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
        case offline
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
                phase = .offline
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
            phase = .offline
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
}
