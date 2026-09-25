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
    /// The automation page's history: the Work runs and Code runs of one
    /// automation, read together. Nil while it has not been read, or when the
    /// last read failed (``historyFailed``) — "couldn't be read" and "has
    /// never run" are different statements about something being trusted.
    public private(set) var history: NativeWorkScheduleHistory?
    public private(set) var historyScheduleID: String?
    public private(set) var historyFailed = false
    /// Automations fetched one at a time for a page opened on one the list
    /// does not hold (a notification, a link), by id.
    public private(set) var fetched: [String: NativeWorkSchedule] = [:]
    /// Ids the server answered 404 for.
    public private(set) var missingIDs: Set<String> = []

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
        history = nil
        historyScheduleID = nil
        historyFailed = false
        fetched = [:]
        missingIDs = []
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

    // MARK: - The automation pages

    /// An automation by id: the list's copy, or one fetched for a page.
    public func schedule(id: String) -> NativeWorkSchedule? {
        schedules.first { $0.id == id } ?? fetched[id]
    }

    /// Reads one automation the list does not hold. Returns whether it could
    /// be read; a 404 records it as missing.
    @discardableResult
    public func loadSchedule(id: String) async -> Bool {
        guard let accountID else { return false }
        do {
            let schedule = try await client.schedule(id: id, for: accountID)
            guard self.accountID == accountID else { return false }
            fetched[id] = schedule
            missingIDs.remove(id)
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            if case .server(404, _, _)? = error as? WorkRemoteError { missingIDs.insert(id) }
            return false
        }
    }

    /// Reads an automation's history for its page. A failed read leaves
    /// ``history`` nil and sets ``historyFailed``; the rows already read for
    /// this automation stay until a read succeeds.
    public func loadHistory(for scheduleID: String) async {
        guard let accountID else { return }
        do {
            let value = try await client.history(for: scheduleID, accountID: accountID)
            guard self.accountID == accountID else { return }
            historyScheduleID = scheduleID
            history = value
            historyFailed = false
        } catch {
            guard self.accountID == accountID else { return }
            if historyScheduleID != scheduleID { history = nil }
            historyScheduleID = scheduleID
            historyFailed = true
        }
    }

    /// Creates an automation for the New automation page.
    public func createReporting(_ draft: NativeWorkScheduleDraft) async -> NativeWorkAutomationResult<NativeWorkSchedule> {
        guard let accountID else { return .failed(offline: true) }
        isMutating = true
        defer { isMutating = false }
        do {
            let schedule = try await client.create(draft, for: accountID)
            guard self.accountID == accountID else { return .failed(offline: false) }
            schedules.insert(schedule, at: 0)
            return .done(schedule, notes: [])
        } catch {
            guard self.accountID == accountID else { return .failed(offline: false) }
            return Self.failure(error)
        }
    }

    /// Saves an edit for the automation page, with the server's sentences.
    public func saveReporting(
        id: String,
        draft: NativeWorkScheduleDraft
    ) async -> NativeWorkAutomationResult<NativeWorkSchedule> {
        guard let accountID else { return .failed(offline: true) }
        isMutating = true
        defer { isMutating = false }
        do {
            let change = try await client.edit(id: id, draft, for: accountID)
            guard self.accountID == accountID else { return .failed(offline: false) }
            store(change.schedule)
            return .done(change.schedule, notes: change.notes)
        } catch {
            guard self.accountID == accountID else { return .failed(offline: false) }
            return Self.failure(error)
        }
    }

    /// Pause or resume, moving the row at once and putting it back if the
    /// server refuses.
    public func setEnabledReporting(
        id: String,
        enabled: Bool
    ) async -> NativeWorkAutomationResult<NativeWorkSchedule> {
        guard let accountID, let previous = schedule(id: id) else { return .failed(offline: false) }
        store(previous.withEnabled(enabled))
        isMutating = true
        defer { isMutating = false }
        do {
            let change = try await client.changeEnabled(id: id, enabled: enabled, for: accountID)
            guard self.accountID == accountID else { return .failed(offline: false) }
            store(change.schedule)
            return .done(change.schedule, notes: change.notes)
        } catch {
            guard self.accountID == accountID else { return .failed(offline: false) }
            store(previous)
            return Self.failure(error)
        }
    }

    /// Deletes an automation, returning the server's sentence about the fires
    /// it cancelled.
    public func deleteReporting(id: String) async -> NativeWorkAutomationResult<String?> {
        guard let accountID else { return .failed(offline: true) }
        isMutating = true
        defer { isMutating = false }
        do {
            let note = try await client.remove(id: id, for: accountID)
            guard self.accountID == accountID else { return .failed(offline: false) }
            schedules.removeAll { $0.id == id }
            fetched[id] = nil
            if historyScheduleID == id {
                history = nil
                historyScheduleID = nil
            }
            return .done(note, notes: [])
        } catch {
            guard self.accountID == accountID else { return .failed(offline: false) }
            return Self.failure(error)
        }
    }

    /// Run now for the pages: the same retry key as ``runNow(id:)``, so a
    /// press whose answer was lost replays that run instead of starting two.
    public func runNowReporting(id: String) async -> NativeWorkAutomationResult<NativeWorkScheduleRunResult> {
        guard let accountID else { return .failed(offline: true) }
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
            guard self.accountID == accountID else { return .failed(offline: false) }
            retriableRunNow = nil
            lastRunResult = result
            return .done(result, notes: [])
        } catch {
            guard self.accountID == accountID else { return .failed(offline: false) }
            return Self.failure(error)
        }
    }

    public func issueFireToken(id: String) async -> NativeWorkAutomationResult<NativeWorkFireToken> {
        guard let accountID else { return .failed(offline: true) }
        do {
            let token = try await client.issueFireToken(id: id, for: accountID)
            guard self.accountID == accountID else { return .failed(offline: false) }
            return .done(token, notes: [])
        } catch {
            return Self.failure(error)
        }
    }

    public func revokeFireToken(id: String) async -> NativeWorkAutomationResult<Void> {
        guard let accountID else { return .failed(offline: true) }
        do {
            try await client.revokeFireToken(id: id, for: accountID)
            return .done((), notes: [])
        } catch {
            return Self.failure(error)
        }
    }

    private func store(_ schedule: NativeWorkSchedule) {
        if let index = schedules.firstIndex(where: { $0.id == schedule.id }) {
            schedules[index] = schedule
        } else if fetched[schedule.id] != nil {
            fetched[schedule.id] = schedule
        } else {
            schedules.insert(schedule, at: 0)
        }
    }

    private static func failure<Value>(_ error: any Error) -> NativeWorkAutomationResult<Value> {
        if let sentence = NativeWorkServerSentence.refusal(error) { return .refused(sentence) }
        if let work = error as? WorkRemoteError, case .server = work { return .failed(offline: false) }
        return .failed(offline: NativeFailureClassification.isConnectivityFailure(error))
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
        schedule.withEnabled(enabled)
    }
}


/// What a page does with the answer to a change: say the server's sentences,
/// or the web's own for a failure.
public enum NativeWorkAutomationResult<Value> {
    /// It happened. `notes` are the server's sentences about what the change
    /// did to queued fires and the next one, in the order the web joins them.
    case done(Value, notes: [String])
    /// The server refused it and wrote why (a 4xx with a sentence).
    case refused(String)
    /// It could not be done: offline (Juno could not be reached) or a failure
    /// with no sentence of its own.
    case failed(offline: Bool)
}

/// The server's own sentence in a refusal, when it wrote one.
///
/// A 4xx that carries a message is the route talking to the reader ("That
/// Mac is not reachable, so this cannot be pinned to it."), and the web shows
/// it as it arrives. A 5xx, a 401 (which the auth coordinator answers) and a
/// refusal with no sentence get the page's own fixed sentence instead.
public enum NativeWorkServerSentence {
    public static func refusal(_ error: any Error) -> String? {
        guard case .server(let status, let message, _)? = error as? WorkRemoteError,
            (400...499).contains(status), status != 401,
            !isFallback(message)
        else { return nil }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The clients' own words for a refusal whose body said nothing.
    static func isFallback(_ message: String) -> Bool {
        message.hasPrefix("Juno could not update Work automations (")
            || message.hasPrefix("Juno could not reach your Work session (")
    }
}
