import Foundation
import JunoCore
import JunoSync
import Observation

/// Account-level automation state for the native Work product.
///
/// The model deliberately owns the retry key for run-now. A button press can
/// reach the server and lose its response; pressing the same button again must
/// replay that run, not create a second background action.
@MainActor
@Observable
public final class NativeWorkAutomationModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case offline
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var schedules: [NativeWorkSchedule] = []
    public private(set) var recentRuns: [NativeWorkScheduleRun] = []
    public private(set) var recentRunsScheduleID: String?
    public private(set) var isMutating = false
    public private(set) var lastErrorDescription: String?
    public private(set) var lastMutationExplanation: String?
    public private(set) var lastRunResult: NativeWorkScheduleRunResult?

    private let client: NativeWorkAutomationClient
    private var accountID: AccountID?
    private var pollTask: Task<Void, Never>?
    private var retriableRunNow: (scheduleID: String, key: String)?
    private var lastRefreshReachedNothing = false

    private static let pollInterval = Duration.seconds(60)
    private static let maximumPollInterval = Duration.seconds(300)

    public init(client: NativeWorkAutomationClient) {
        self.client = client
    }

    public func start(for accountID: AccountID) async {
        guard self.accountID != accountID else {
            await refresh()
            return
        }
        stop()
        self.accountID = accountID
        phase = .loading
        await refresh()
        startPolling(for: accountID)
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
        accountID = nil
        schedules = []
        recentRuns = []
        recentRunsScheduleID = nil
        isMutating = false
        lastErrorDescription = nil
        lastMutationExplanation = nil
        lastRunResult = nil
        retriableRunNow = nil
        lastRefreshReachedNothing = false
        phase = .idle
    }

    public func refresh() async {
        guard let accountID else { return }
        do {
            let values = try await client.schedules(for: accountID)
            guard self.accountID == accountID else { return }
            schedules = values
            lastErrorDescription = nil
            lastRefreshReachedNothing = false
            phase = .ready
        } catch {
            guard self.accountID == accountID else { return }
            lastRefreshReachedNothing = true
            record(error)
            phase = schedules.isEmpty ? Self.failurePhase(for: error) : .ready
        }
    }

    @discardableResult
    public func create(_ draft: NativeWorkScheduleDraft) async -> NativeWorkSchedule? {
        guard let accountID, draft.isValid else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let schedule = try await client.create(draft, for: accountID)
            guard self.accountID == accountID else { return nil }
            schedules.insert(schedule, at: 0)
            lastErrorDescription = nil
            lastMutationExplanation = "Automation created."
            return schedule
        } catch {
            guard self.accountID == accountID else { return nil }
            record(error)
            return nil
        }
    }

    @discardableResult
    public func update(
        id: String,
        draft: NativeWorkScheduleDraft
    ) async -> NativeWorkSchedule? {
        guard let accountID else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let schedule = try await client.update(id: id, draft, for: accountID)
            guard self.accountID == accountID else { return nil }
            replace(schedule)
            lastErrorDescription = nil
            lastMutationExplanation = "Automation updated."
            return schedule
        } catch {
            guard self.accountID == accountID else { return nil }
            record(error)
            return nil
        }
    }

    /// Moves the switch immediately and rolls it back if the server rejects it.
    public func setEnabled(id: String, enabled: Bool) async {
        guard let index = schedules.firstIndex(where: { $0.id == id }), let accountID else { return }
        let previous = schedules[index]
        schedules[index] = Self.withEnabled(previous, enabled: enabled)
        isMutating = true
        defer { isMutating = false }
        do {
            let updated = try await client.setEnabled(id: id, enabled: enabled, for: accountID)
            guard self.accountID == accountID else { return }
            replace(updated)
            lastErrorDescription = nil
            lastMutationExplanation = enabled ? "Automation resumed." : "Automation paused."
        } catch {
            guard self.accountID == accountID else { return }
            if let current = schedules.firstIndex(where: { $0.id == id }) { schedules[current] = previous }
            record(error)
        }
    }

    public func delete(id: String) async {
        guard let accountID else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await client.delete(id: id, for: accountID)
            guard self.accountID == accountID else { return }
            schedules.removeAll { $0.id == id }
            if recentRunsScheduleID == id {
                recentRuns = []
                recentRunsScheduleID = nil
            }
            lastErrorDescription = nil
            lastMutationExplanation = "Automation deleted."
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    @discardableResult
    public func runNow(id: String) async -> NativeWorkScheduleRunResult? {
        guard let accountID else { return nil }
        let key: String
        if let retriableRunNow, retriableRunNow.scheduleID == id {
            key = retriableRunNow.key
        } else {
            key = "juno-work-schedule-\(UUID().uuidString)"
            retriableRunNow = (id, key)
        }
        isMutating = true
        defer { isMutating = false }
        do {
            let result = try await client.runNow(id: id, idempotencyKey: key, for: accountID)
            guard self.accountID == accountID else { return nil }
            retriableRunNow = nil
            lastRunResult = result
            lastMutationExplanation = result.replay
                ? "This run was already started; Juno restored its result."
                : "Run started."
            replaceRun(result.run)
            await refresh()
            return result
        } catch {
            guard self.accountID == accountID else { return nil }
            record(error)
            return nil
        }
    }

    public func loadRuns(for scheduleID: String) async {
        guard let accountID else { return }
        do {
            let runs = try await client.runs(for: scheduleID, accountID: accountID)
            guard self.accountID == accountID else { return }
            recentRunsScheduleID = scheduleID
            recentRuns = runs
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    public func clearMutationMessage() {
        lastMutationExplanation = nil
    }

    // MARK: - Private

    private func startPolling(for accountID: AccountID) {
        pollTask = Task { [weak self] in
            var interval = Self.pollInterval
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self, self.accountID == accountID else { return }
                await self.refresh()
                guard !Task.isCancelled, self.accountID == accountID else { return }
                interval = self.lastRefreshReachedNothing
                    ? min(interval * 2, Self.maximumPollInterval)
                    : Self.pollInterval
            }
        }
    }

    private func replace(_ schedule: NativeWorkSchedule) {
        if let index = schedules.firstIndex(where: { $0.id == schedule.id }) {
            schedules[index] = schedule
        } else {
            schedules.insert(schedule, at: 0)
        }
    }

    private func replaceRun(_ run: NativeWorkScheduleRun) {
        if let index = recentRuns.firstIndex(where: { $0.id == run.id }) {
            recentRuns[index] = run
        } else {
            recentRuns.insert(run, at: 0)
        }
    }

    private func record(_ error: any Error) {
        lastErrorDescription = presentable(error)
    }

    private func presentable(_ error: any Error) -> String {
        if let work = error as? WorkRemoteError {
            return work.errorDescription ?? NativeFailureMessage.offline
        }
        return NativeFailureMessage.presentable(error)
    }

    private static func failurePhase(for error: any Error) -> Phase {
        if let work = error as? WorkRemoteError { return work.isRetryable ? .offline : .failed }
        return NativeFailureClassification.isConnectivityFailure(error) ? .offline : .failed
    }

    private static func withEnabled(
        _ schedule: NativeWorkSchedule,
        enabled: Bool
    ) -> NativeWorkSchedule {
        NativeWorkSchedule(
            id: schedule.id,
            sessionID: schedule.sessionID,
            name: schedule.name,
            enabled: enabled,
            instructions: schedule.instructions,
            instructionsVersion: schedule.instructionsVersion,
            target: schedule.target,
            hostID: schedule.hostID,
            timezone: schedule.timezone,
            runConfig: schedule.runConfig,
            runConfigVersion: schedule.runConfigVersion,
            budget: schedule.budget,
            unattendedPolicy: schedule.unattendedPolicy,
            hostOfflinePolicy: schedule.hostOfflinePolicy,
            maxConcurrentRuns: schedule.maxConcurrentRuns,
            notifyPolicy: schedule.notifyPolicy,
            missedRunPolicy: schedule.missedRunPolicy,
            retryPolicy: schedule.retryPolicy,
            lastRunAt: schedule.lastRunAt,
            nextRunAt: schedule.nextRunAt,
            legacyScheduledTaskID: schedule.legacyScheduledTaskID,
            createdAt: schedule.createdAt,
            updatedAt: schedule.updatedAt,
            triggers: schedule.triggers
        )
    }
}
