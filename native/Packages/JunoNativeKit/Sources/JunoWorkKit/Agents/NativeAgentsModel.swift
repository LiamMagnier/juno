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
///
/// With a Work client it also reads what each waiting task is stopped at —
/// ``gates`` — so an approval or a question can be answered on the agent's
/// page, through the same routes and with the same digest check as the
/// task's thread. Without one the page sends the person to the thread.
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
    /// What each agent's waiting tasks are stopped at, by agent id. Read from
    /// the tasks' runs, so it stays empty without a Work client.
    public private(set) var gates: [String: [NativeAgentGate]] = [:]
    /// Each agent's latest run as its computer saw it, by agent id.
    public private(set) var computers: [String: NativeAgentComputer] = [:]
    /// Approvals and questions whose answer is on its way.
    public private(set) var answeringIDs: Set<String> = []

    /// Called when an agent starts needing the person between two reads of
    /// the roster — never for the first read, which is a state and not a
    /// change. Each app decides what a rise is worth: a sidebar dot, a sound.
    @ObservationIgnored public var onNeedsYouRise: (@MainActor (NativeAgent) -> Void)?

    private let client: NativeAgentsClient
    private let workClient: NativeWorkClient?
    private var accountID: AccountID?
    private var pollTask: Task<Void, Never>?
    private var lastRefreshReachedNothing = false
    /// The idempotency key for a task start that has not been answered yet,
    /// keyed by what it asked for. Pressing Start again after a lost response —
    /// or after saying yes to the cost — must land on the same task.
    private var retriableTaskKeys: [String: String] = [:]
    /// Who was waiting at the last roster read; nil until the first one.
    @ObservationIgnored private var polledWaitingIDs: Set<String>?
    /// Approvals and questions answered from this device. A run read that
    /// left before the answer landed still lists them.
    @ObservationIgnored private var settledGateIDs: Set<String> = []
    /// The newest gate read per agent. An older read that finishes later is
    /// dropped rather than put back over a newer one.
    @ObservationIgnored private var gateReads: [String: Int] = [:]

    private static let pollInterval = Duration.seconds(60)
    private static let maximumPollInterval = Duration.seconds(300)
    /// How many tasks one gate read looks at. A page with more waiting than
    /// this is a page to open the threads from.
    nonisolated private static let maximumGateReads = 5
    /// How long one run read may take before the page stops waiting on it.
    nonisolated private static let gateReadTimeout = Duration.seconds(8)

    /// - Parameter workClient: reads and answers the gates of an agent's
    ///   tasks. Nil keeps the page read-only about them.
    public init(client: NativeAgentsClient, workClient: NativeWorkClient? = nil) {
        self.client = client
        self.workClient = workClient
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

    /// The roster in the sidebar's order: the agents that need the person
    /// first, then the order they were hired in. Not ``orderedAgents``, which
    /// ranks every state — rows that moved each time an agent started or
    /// finished something would be a sidebar nobody can find anything in.
    public var sidebarAgents: [NativeAgent] {
        Self.sidebarOrder(agents)
    }

    /// Whether gates can be read and answered on an agent's page.
    public var canAnswerInPlace: Bool {
        workClient != nil
    }

    public func isAnswering(_ id: String) -> Bool {
        answeringIDs.contains(id)
    }

    /// An agent's tasks, newest first: its page's when that is loaded, the
    /// roster's one task otherwise.
    public func tasks(for agentID: String) -> [NativeAgentTask] {
        if let tasks = details[agentID]?.tasks, !tasks.isEmpty { return tasks }
        guard let task = agent(id: agentID)?.task else { return [] }
        return [task]
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
        gates = [:]
        computers = [:]
        answeringIDs = []
        polledWaitingIDs = nil
        settledGateIDs = []
        gateReads = [:]
        phase = .idle
    }

    public func refresh() async {
        guard let accountID else { return }
        do {
            let values = try await client.agents(for: accountID)
            guard self.accountID == accountID else { return }
            let risen = Self.newlyWaiting(previous: polledWaitingIDs, current: values)
            polledWaitingIDs = Set(values.filter { $0.state == .waiting }.map(\.id))
            agents = values
            // A page that is open keeps the newer derived state too, so its
            // header and the roster cannot disagree about what it is doing.
            for value in values where details[value.id] != nil {
                details[value.id]?.agent = value
            }
            lastErrorDescription = nil
            lastRefreshReachedNothing = false
            phase = .ready
            for risenAgent in risen {
                onNeedsYouRise?(risenAgent)
            }
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

    // MARK: - Gates

    /// Reads what an agent's waiting tasks are stopped at, and what its
    /// newest run did on its computer.
    ///
    /// One read of each run (``NativeWorkClient/snapshot(sessionID:for:)``),
    /// falling back to the plain session read when the stream is refused —
    /// which still carries the approvals, if not the log a question is read
    /// from. Quiet on failure: the page calls this on a clock, and a read that
    /// did not land keeps the gate it had rather than putting an error on the
    /// page every ten seconds.
    public func loadGates(agentID: String) async {
        guard let accountID, let workClient else { return }
        let agentTasks = tasks(for: agentID)
        let targets = Self.gateTargets(in: agentTasks)
        guard !targets.isEmpty else {
            gates[agentID] = nil
            computers[agentID] = nil
            return
        }
        let read = (gateReads[agentID] ?? 0) + 1
        gateReads[agentID] = read

        var updates: [String: WorkStreamUpdate] = [:]
        for task in targets {
            let update = await Self.readRun(task.sessionID, client: workClient, accountID: accountID)
            if let update {
                updates[task.sessionID] = update
            }
        }
        guard self.accountID == accountID, gateReads[agentID] == read else { return }
        apply(updates, tasks: agentTasks, agentID: agentID)
    }

    /// Answers an approval one of an agent's tasks is stopped at, through the
    /// same route and digest check as the task's thread.
    ///
    /// The card leaves at once — the run is blocked on this answer, and a card
    /// that stays after the tap reads as the tap not landing — and comes back
    /// only if the answer failed and the approval can still be answered.
    public func decide(
        agentID: String,
        _ approval: WorkApprovalRequest,
        _ decision: JunoWorkApprovalDecision
    ) async {
        guard let accountID, let workClient else { return }
        let id = approval.approvalID
        guard !answeringIDs.contains(id) else { return }
        let place = removeApproval(id, agentID: agentID)
        answeringIDs.insert(id)
        do {
            _ = try await workClient.decide(on: approval, decision: decision, for: accountID)
            guard self.accountID == accountID else { return }
            answeringIDs.remove(id)
            settledGateIDs.insert(id)
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            answeringIDs.remove(id)
            // Put back only what can still be answered. Restoring an expired
            // card would offer a button that cannot work.
            if let place, approval.isAnswerable(at: Date()) {
                restoreApproval(approval, at: place, agentID: agentID)
            }
            record(error)
            return
        }
        // Answering moves the task, and with it the agent's face.
        await refresh()
        await loadGates(agentID: agentID)
    }

    /// Replies to the question one of an agent's tasks is stopped at.
    ///
    /// Unlike an approval, the card stays while the reply travels: it holds
    /// what the person wrote, and taking it away to put it back on a failure
    /// would throw their words away with it.
    @discardableResult
    public func answer(
        agentID: String,
        sessionID: String,
        question: WorkQuestionPrompt,
        text: String
    ) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let accountID, let workClient, !trimmed.isEmpty else { return false }
        let id = question.questionID
        guard !answeringIDs.contains(id) else { return false }
        answeringIDs.insert(id)
        do {
            try await workClient.answer(
                sessionID: sessionID,
                questionID: id,
                text: trimmed,
                for: accountID
            )
            guard self.accountID == accountID else { return false }
            answeringIDs.remove(id)
            settledGateIDs.insert(id)
            clearQuestion(id, agentID: agentID)
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return false }
            answeringIDs.remove(id)
            record(error)
            return false
        }
        await refresh()
        await loadGates(agentID: agentID)
        return true
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
        gates[id] = nil
        computers[id] = nil
    }

    /// Lays a gate read over the page: the tasks' fresher states, the gates of
    /// the ones still waiting, and the newest run's computer.
    private func apply(
        _ updates: [String: WorkStreamUpdate],
        tasks agentTasks: [NativeAgentTask],
        agentID: String
    ) {
        let hiddenApprovals = answeringIDs.union(settledGateIDs)
        let previous = gates[agentID] ?? []
        var loaded: [NativeAgentGate] = []
        for task in agentTasks {
            guard let update = updates[task.sessionID] else {
                // Not read this time. A task still waiting keeps the gate it
                // had, less anything answered since.
                guard NativeAgentGate.isWaiting(task),
                    var kept = previous.first(where: { $0.id == task.sessionID })
                else { continue }
                kept.approvals.removeAll { hiddenApprovals.contains($0.approvalID) }
                loaded.append(kept)
                continue
            }
            let current = NativeAgentGate.current(task, from: update.session)
            if current != task {
                replaceTask(current, agentID: agentID)
            }
            guard NativeAgentGate.isWaiting(current) else { continue }
            let gate = NativeAgentGate.read(
                update,
                task: current,
                hidingApprovals: hiddenApprovals,
                answeredQuestions: settledGateIDs
            )
            loaded.append(gate)
        }
        gates[agentID] = loaded
        if let latest = agentTasks.first, let update = updates[latest.sessionID] {
            computers[agentID] = NativeAgentComputer.read(
                update,
                sessionID: latest.sessionID,
                status: latest.status
            )
        }
    }

    /// Puts a task's fresher state on the page that lists it.
    private func replaceTask(_ task: NativeAgentTask, agentID: String) {
        guard let index = details[agentID]?.tasks.firstIndex(where: { $0.sessionID == task.sessionID }) else {
            return
        }
        details[agentID]?.tasks[index] = task
    }

    /// Takes an approval off its gate, and says where it was.
    private func removeApproval(_ id: String, agentID: String) -> (sessionID: String, index: Int)? {
        guard let list = gates[agentID] else { return nil }
        for (gateIndex, gate) in list.enumerated() {
            guard let index = gate.approvals.firstIndex(where: { $0.approvalID == id }) else { continue }
            _ = gates[agentID]?[gateIndex].approvals.remove(at: index)
            return (sessionID: gate.id, index: index)
        }
        return nil
    }

    private func restoreApproval(
        _ approval: WorkApprovalRequest,
        at place: (sessionID: String, index: Int),
        agentID: String
    ) {
        guard let gateIndex = gates[agentID]?.firstIndex(where: { $0.id == place.sessionID }) else { return }
        let current = gates[agentID]?[gateIndex].approvals ?? []
        guard !current.contains(where: { $0.approvalID == approval.approvalID }) else { return }
        gates[agentID]?[gateIndex].approvals.insert(approval, at: min(place.index, current.count))
    }

    private func clearQuestion(_ id: String, agentID: String) {
        guard let list = gates[agentID] else { return }
        for (index, gate) in list.enumerated() where gate.question?.questionID == id {
            gates[agentID]?[index].question = nil
        }
    }

    /// The tasks a gate read looks at: the newest, whose run is the one "Its
    /// computer" shows and which may have stopped to ask something the roster
    /// has not heard about yet, then every other one that is waiting.
    nonisolated static func gateTargets(in tasks: [NativeAgentTask]) -> [NativeAgentTask] {
        guard let latest = tasks.first else { return [] }
        var targets = [latest]
        for task in tasks.dropFirst() where NativeAgentGate.isWaiting(task) {
            targets.append(task)
        }
        return Array(targets.prefix(Self.maximumGateReads))
    }

    /// One run, read once. Bounded, because a proxy that buffers the stream
    /// would otherwise hold the read — and every gate behind it — open until
    /// the server closed its window minutes later.
    private nonisolated static func readRun(
        _ sessionID: String,
        client: NativeWorkClient,
        accountID: AccountID
    ) async -> WorkStreamUpdate? {
        let timeout = Self.gateReadTimeout
        let snapshot = await withTaskGroup(of: WorkStreamUpdate?.self) { group in
            group.addTask {
                try? await client.snapshot(sessionID: sessionID, for: accountID)
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        if let snapshot { return snapshot }
        // The plain read, for a connection that will not carry a stream: it
        // has the approvals, if not the log.
        guard let detail = try? await client.session(id: sessionID, for: accountID) else { return nil }
        return WorkStreamUpdate(
            session: detail.session,
            run: detail.run,
            events: detail.events,
            approvals: detail.approvals
        )
    }

    // MARK: - Cloud computer

    public func computerAction(agentID: String, action: String) async {
        guard let accountID else { return }
        do {
            let updated = try await client.computerAction(agentID: agentID, action: action, for: accountID)
            guard self.accountID == accountID else { return }
            if var detail = details[agentID] {
                detail.computer = updated
                detail.computerConfigured = true
                details[agentID] = detail
            }
        } catch {
            record(error)
        }
    }

    public func computerHandoffURL(agentID: String, mode: String) async -> String? {
        guard let accountID else { return nil }
        do {
            let view = try await client.computerView(agentID: agentID, mode: mode, handoff: true, for: accountID)
            return view.handoffURL
        } catch {
            record(error)
            return nil
        }
    }

    public func computerHeartbeat(agentID: String, mode: String, ended: Bool = false) async {
        guard let accountID else { return }
        do {
            let updated = try await client.computerHeartbeat(
                agentID: agentID,
                mode: mode,
                ended: ended,
                for: accountID
            )
            guard self.accountID == accountID else { return }
            if var detail = details[agentID] {
                detail.computer = updated
                details[agentID] = detail
            }
        } catch {
            // Periodic keepalive; do not surface transient network errors
        }
    }

    public func computerHandBack(agentID: String) async {
        guard let accountID else { return }
        do {
            let updated = try await client.computerHeartbeat(
                agentID: agentID,
                mode: "control",
                ended: true,
                for: accountID
            )
            guard self.accountID == accountID else { return }
            if var detail = details[agentID] {
                detail.computer = updated
                details[agentID] = detail
            }
            if let gate = (gates[agentID] ?? []).first(where: { $0.question != nil }),
                let question = gate.question
            {
                await answer(
                    agentID: agentID,
                    sessionID: gate.task.sessionID,
                    question: question,
                    text: "Done. I've finished on your computer; continue."
                )
            }
        } catch {
            record(error)
        }
    }

    public func computerPoster(agentID: String) async -> Data? {
        guard let accountID else { return nil }
        return try? await client.computerPoster(agentID: agentID, for: accountID)
    }

    /// Waiting first, then the order they were hired in. Ties keep the
    /// server's order, so rows never swap on a read that changed nothing.
    nonisolated static func sidebarOrder(_ agents: [NativeAgent]) -> [NativeAgent] {
        agents.enumerated()
            .sorted { lhs, rhs in
                let left = lhs.element.state == .waiting
                let right = rhs.element.state == .waiting
                if left != right { return left }
                if lhs.element.sortOrder != rhs.element.sortOrder {
                    return lhs.element.sortOrder < rhs.element.sortOrder
                }
                return lhs.offset < rhs.offset
            }
            .map { $0.element }
    }

    /// The agents waiting now that were not at the last read. A nil
    /// `previous` is the first read, which is a state and not a rise.
    nonisolated static func newlyWaiting(previous: Set<String>?, current: [NativeAgent]) -> [NativeAgent] {
        guard let previous else { return [] }
        return current.filter { $0.state == .waiting && !previous.contains($0.id) }
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
