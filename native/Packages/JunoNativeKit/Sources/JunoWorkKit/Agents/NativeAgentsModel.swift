import Foundation
import JunoCore
import JunoDesignSystem
import JunoSync
import Observation

/// The account's agents, as this device reads them.
///
/// Shaped like ``NativeWorkAutomationModel``: started at sign-in, stopped at
/// sign-out, one account at a time, every write guarded against the account
/// having changed underneath it. The roster polls because the roster is what
/// answers "does any agent need me?" — its faces are the status bar, and a
/// status bar that only updates when opened is not one.
///
/// Pages are held per agent in ``details`` and edited in place after a write
/// succeeds, so a goal just added appears without a round trip. The server
/// derives every agent's state; nothing here guesses at it.
@MainActor
@Observable
public final class NativeAgentsModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case offline
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var agents: [NativeAgent] = []
    /// Each opened agent's page, by agent id.
    public private(set) var details: [String: NativeAgentDetail] = [:]
    /// Each opened agent's log, by agent id.
    public private(set) var activity: [String: [NativeAgentActivity]] = [:]
    /// The agent whose page is loading for the first time, for a quiet
    /// placeholder rather than a blank page.
    public private(set) var loadingDetailID: String?
    /// Agents asked to think it over whose answer has not come back yet.
    public private(set) var reflectingIDs: Set<String> = []
    public private(set) var isMutating = false
    public private(set) var lastErrorDescription: String?
    public private(set) var lastMutationExplanation: String?

    private let client: NativeAgentsClient
    private var accountID: AccountID?
    private var pollTask: Task<Void, Never>?
    private var lastRefreshReachedNothing = false
    /// The idempotency key for a task start that has not been answered yet,
    /// keyed by what it asked for. Pressing Start again after a lost response —
    /// or after saying yes to the cost — must land on the same task.
    private var retriableTaskKeys: [String: String] = [:]

    private static let pollInterval = Duration.seconds(60)
    private static let maximumPollInterval = Duration.seconds(300)

    public init(client: NativeAgentsClient) {
        self.client = client
    }

    // MARK: - Reading

    /// The roster in the order a person scans it: the agents that need them
    /// first, then the ones at work, then the rest as hired — the web's order.
    public var orderedAgents: [NativeAgent] {
        agents.enumerated()
            .sorted { lhs, rhs in
                let left = Self.rank(lhs.element.state)
                let right = Self.rank(rhs.element.state)
                if left != right { return left < right }
                if lhs.element.sortOrder != rhs.element.sortOrder {
                    return lhs.element.sortOrder < rhs.element.sortOrder
                }
                return lhs.offset < rhs.offset
            }
            .map { $0.element }
    }

    /// How many agents are waiting on the person, for a sidebar badge.
    public var needsYouCount: Int {
        agents.filter { $0.state == .waiting }.count
    }

    /// The freshest copy of one agent: the page's when it is open, the
    /// roster's otherwise.
    public func agent(id: String) -> NativeAgent? {
        details[id]?.agent ?? agents.first { $0.id == id }
    }

    public func isReflecting(_ agentID: String) -> Bool {
        reflectingIDs.contains(agentID)
    }

    // MARK: - Lifecycle

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
        agents = []
        details = [:]
        activity = [:]
        loadingDetailID = nil
        reflectingIDs = []
        isMutating = false
        lastErrorDescription = nil
        lastMutationExplanation = nil
        retriableTaskKeys = [:]
        lastRefreshReachedNothing = false
        phase = .idle
    }

    public func refresh() async {
        guard let accountID else { return }
        do {
            let values = try await client.agents(for: accountID)
            guard self.accountID == accountID else { return }
            agents = values
            // A page that is open keeps the newer derived state too, so its
            // header and the roster cannot disagree about what it is doing.
            for value in values where details[value.id] != nil {
                details[value.id]?.agent = value
            }
            lastErrorDescription = nil
            lastRefreshReachedNothing = false
            phase = .ready
        } catch {
            guard self.accountID == accountID else { return }
            lastRefreshReachedNothing = true
            record(error)
            phase = agents.isEmpty ? Self.failurePhase(for: error) : .ready
        }
    }

    /// Loads one agent's page. A 404 means it was retired elsewhere, and the
    /// honest thing is to let it leave the roster here too.
    public func loadDetail(id: String) async {
        guard let accountID else { return }
        if details[id] == nil { loadingDetailID = id }
        defer { if loadingDetailID == id { loadingDetailID = nil } }
        do {
            let detail = try await client.detail(id: id, for: accountID)
            guard self.accountID == accountID else { return }
            details[id] = detail
            replace(detail.agent)
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            if Self.isNotFound(error) {
                forget(id)
            }
            record(error)
        }
    }

    public func loadActivity(id: String) async {
        guard let accountID else { return }
        do {
            let values = try await client.activity(agentID: id, for: accountID)
            guard self.accountID == accountID else { return }
            activity[id] = values
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    // MARK: - The agent

    /// Hires an agent. Returns it so the caller can land on its page.
    @discardableResult
    public func hire(_ draft: NativeAgentDraft) async -> NativeAgent? {
        guard let accountID, draft.isValid else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let agent = try await client.hire(draft, for: accountID)
            guard self.accountID == accountID else { return nil }
            replace(agent)
            lastErrorDescription = nil
            lastMutationExplanation = "\(agent.name) joined."
            return agent
        } catch {
            guard self.accountID == accountID else { return nil }
            record(error)
            return nil
        }
    }

    @discardableResult
    public func update(id: String, _ patch: NativeAgentPatch) async -> Bool {
        guard let accountID, !patch.isEmpty else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            let agent = try await client.update(id: id, patch, for: accountID)
            guard self.accountID == accountID else { return false }
            replace(agent)
            lastErrorDescription = nil
            lastMutationExplanation = "Saved."
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            record(error)
            return false
        }
    }

    /// Pause keeps everything and starts nothing; resume picks up where it was.
    public func setPaused(id: String, paused: Bool) async {
        let changed = await update(id: id, NativeAgentPatch(status: paused ? .paused : .active))
        if changed {
            lastMutationExplanation = paused ? "Paused." : "Resumed."
            await loadDetail(id: id)
        }
    }

    /// Retires it. Its thread and its tasks stay, as ordinary chats and tasks.
    @discardableResult
    public func retire(id: String) async -> Bool {
        guard let accountID else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            try await client.retire(id: id, for: accountID)
            guard self.accountID == accountID else { return false }
            forget(id)
            lastErrorDescription = nil
            lastMutationExplanation = "Retired."
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            record(error)
            return false
        }
    }

    /// The agent's thread, created on first use. Falls back to the id the
    /// agent already carries when the request cannot be made, so Message still
    /// works offline for an agent whose thread exists.
    public func threadConversationID(for agentID: String) async -> String? {
        guard let accountID else { return nil }
        do {
            let conversationID = try await client.thread(id: agentID, for: accountID)
            guard self.accountID == accountID else { return nil }
            return conversationID
        } catch {
            guard self.accountID == accountID else { return nil }
            if let known = agent(id: agentID)?.conversationID { return known }
            record(error)
            return nil
        }
    }

    // MARK: - Goals

    @discardableResult
    public func addGoal(agentID: String, _ draft: NativeAgentGoalDraft) async -> Bool {
        guard let accountID, draft.isValid else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            let goal = try await client.createGoal(agentID: agentID, draft, for: accountID)
            guard self.accountID == accountID else { return false }
            details[agentID]?.goals.append(goal)
            lastErrorDescription = nil
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            record(error)
            return false
        }
    }

    public func setGoalStatus(agentID: String, goalID: String, status: NativeAgentGoalStatus) async {
        guard let accountID else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            let goal = try await client.setGoalStatus(
                agentID: agentID, goalID: goalID, status: status, for: accountID
            )
            guard self.accountID == accountID else { return }
            if let index = details[agentID]?.goals.firstIndex(where: { $0.id == goal.id }) {
                details[agentID]?.goals[index] = goal
            }
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    public func deleteGoal(agentID: String, goalID: String) async {
        guard let accountID else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await client.deleteGoal(agentID: agentID, goalID: goalID, for: accountID)
            guard self.accountID == accountID else { return }
            details[agentID]?.goals.removeAll { $0.id == goalID }
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    // MARK: - What it knows

    @discardableResult
    public func addNote(agentID: String, content: String) async -> Bool {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let accountID, !trimmed.isEmpty, trimmed.count <= NativeAgentLimits.note else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            let note = try await client.createNote(agentID: agentID, content: trimmed, for: accountID)
            guard self.accountID == accountID else { return false }
            // Newest first, the order the server lists them in.
            details[agentID]?.notes.insert(note, at: 0)
            lastErrorDescription = nil
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            record(error)
            return false
        }
    }

    @discardableResult
    public func updateNote(agentID: String, noteID: String, content: String) async -> Bool {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let accountID, !trimmed.isEmpty, trimmed.count <= NativeAgentLimits.note else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            let note = try await client.updateNote(
                agentID: agentID, noteID: noteID, content: trimmed, for: accountID
            )
            guard self.accountID == accountID else { return false }
            if let index = details[agentID]?.notes.firstIndex(where: { $0.id == note.id }) {
                details[agentID]?.notes[index] = note
            }
            lastErrorDescription = nil
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            record(error)
            return false
        }
    }

    public func deleteNote(agentID: String, noteID: String) async {
        guard let accountID else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await client.deleteNote(agentID: agentID, noteID: noteID, for: accountID)
            guard self.accountID == accountID else { return }
            details[agentID]?.notes.removeAll { $0.id == noteID }
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    // MARK: - Ideas and tasks

    /// Starts or dismisses an idea. A `needsConfirmation` answer leaves the
    /// idea where it is, for the page to ask about the cost and call again
    /// with `confirmExpensive`.
    public func decideIdea(
        agentID: String,
        ideaID: String,
        action: NativeAgentIdeaAction,
        confirmExpensive: Bool = false
    ) async -> NativeAgentStartOutcome? {
        guard let accountID else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let outcome = try await client.decideIdea(
                agentID: agentID,
                ideaID: ideaID,
                action: action,
                confirmExpensive: confirmExpensive,
                for: accountID
            )
            guard self.accountID == accountID else { return nil }
            if case .accepted = outcome {
                details[agentID]?.ideas.removeAll { $0.id == ideaID }
                lastErrorDescription = nil
                lastMutationExplanation = action == .start ? "Started." : nil
                if action == .start {
                    await loadDetail(id: agentID)
                    await refresh()
                }
            }
            return outcome
        } catch {
            guard self.accountID == accountID else { return nil }
            record(error)
            return nil
        }
    }

    /// Starts a task as the agent, in its thread. Used by a goal's
    /// "Work on this": the goal becomes the task's brief.
    public func startTask(
        agentID: String,
        title: String,
        goal: String,
        confirmExpensive: Bool = false
    ) async -> NativeAgentStartOutcome? {
        guard let accountID else { return nil }
        let request = "\(agentID)\n\(title)\n\(goal)"
        let key: String
        if let existing = retriableTaskKeys[request] {
            key = existing
        } else {
            key = "juno-agent-task-\(UUID().uuidString)"
            retriableTaskKeys[request] = key
        }
        isMutating = true
        defer { isMutating = false }
        do {
            let outcome = try await client.startTask(
                agentID: agentID,
                title: title,
                goal: goal,
                idempotencyKey: key,
                confirmExpensive: confirmExpensive,
                for: accountID
            )
            guard self.accountID == accountID else { return nil }
            if case .accepted = outcome {
                retriableTaskKeys[request] = nil
                lastErrorDescription = nil
                lastMutationExplanation = "Started."
                await loadDetail(id: agentID)
                await refresh()
            }
            return outcome
        } catch {
            guard self.accountID == accountID else { return nil }
            record(error)
            return nil
        }
    }

    /// Asks the agent to think it over. Unforced, this is the lazy trigger a
    /// page fires on open — a no-op until six hours have passed, and never an
    /// error worth showing. Forced, it is the person asking.
    @discardableResult
    public func reflect(agentID: String, force: Bool) async -> NativeAgentReflectOutcome? {
        guard let accountID, !reflectingIDs.contains(agentID) else { return nil }
        reflectingIDs.insert(agentID)
        defer { reflectingIDs.remove(agentID) }
        do {
            let outcome = try await client.reflect(agentID: agentID, force: force, for: accountID)
            guard self.accountID == accountID else { return nil }
            switch outcome {
            case .reflected(let ideas, let checkIns, _):
                if force {
                    lastMutationExplanation = ideas + checkIns == 0
                        ? "Nothing new to suggest right now."
                        : "It has thought it over."
                }
                await loadDetail(id: agentID)
            case .skipped:
                if force { lastMutationExplanation = "Nothing new to suggest right now." }
            }
            return outcome
        } catch {
            guard self.accountID == accountID else { return nil }
            if force { record(error) }
            return nil
        }
    }

    // MARK: - Routines

    @discardableResult
    public func createRoutine(agentID: String, _ draft: NativeAgentRoutineDraft) async -> Bool {
        guard let accountID, draft.isValid else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            let routine = try await client.createRoutine(agentID: agentID, draft, for: accountID)
            guard self.accountID == accountID else { return false }
            details[agentID]?.routines.append(routine)
            lastErrorDescription = nil
            lastMutationExplanation = "Routine created."
            // The agent's "Next:" sentence is derived from its routines.
            await refresh()
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            record(error)
            return false
        }
    }

    public func clearMutationMessage() {
        lastMutationExplanation = nil
    }

    public func clearError() {
        lastErrorDescription = nil
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

    private func replace(_ agent: NativeAgent) {
        if let index = agents.firstIndex(where: { $0.id == agent.id }) {
            agents[index] = agent
        } else {
            agents.append(agent)
        }
        details[agent.id]?.agent = agent
    }

    private func forget(_ id: String) {
        agents.removeAll { $0.id == id }
        details[id] = nil
        activity[id] = nil
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

    private static func isNotFound(_ error: any Error) -> Bool {
        guard case .server(let statusCode, _, _)? = error as? WorkRemoteError else { return false }
        return statusCode == 404
    }

    private static func failurePhase(for error: any Error) -> Phase {
        if let work = error as? WorkRemoteError { return work.isRetryable ? .offline : .failed }
        return NativeFailureClassification.isConnectivityFailure(error) ? .offline : .failed
    }

    /// The web roster's `RANK`: needs you, then at work, then settled, then
    /// idle, then asleep.
    private static func rank(_ state: JunoAgentState) -> Int {
        switch state {
        case .waiting: 0
        case .working, .thinking, .listening: 1
        case .done, .blocked: 2
        case .idle: 3
        case .sleeping: 4
        }
    }
}
