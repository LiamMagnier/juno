import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

// The autonomous loop's side of the session (CODE_AGENT_SPEC §1, §2): the run
// ledger and goal runtime a Code orchestrator is built with, the
// `<session_state>` sections for the goal, the checks and the bounds, the
// goal commands, Keep going, Retry and Resume. None of it widens a
// permission: task grants are exact commands the reader ticked, and every
// call still goes through the session's `PermissionCoordinator`.

/// What one session keeps for the loop between orchestrators: an orchestrator
/// is rebuilt whenever the turn contract changes, but the run ledger and the
/// goal runtime belong to the session.
@MainActor
final class SessionAutonomyState {
    var ledger: RunLedgerRecorder?
    var goals: GoalRuntime?
    /// The checks the workspace's toolchain suggests, read once per session.
    var recipe: GateRecipe?
    var recipeLoaded = false
    /// Whether attach has already looked for a goal to resume on launch.
    var launchChecked = false

    init() {}
}

/// The model that judges goals and drafts their criteria: the cheapest
/// capable route in the catalogue (D-020), today the `haiku` alias.
enum GoalJudgeRoute {
    static let modelID = "haiku"
}

extension SessionController {
    // MARK: - Building the loop

    /// The session's run ledger and goal runtime, made on first use.
    func autonomyRuntime(_ live: Live) -> (ledger: RunLedgerRecorder, goals: GoalRuntime) {
        if let ledger = autonomyState.ledger, let goals = autonomyState.goals {
            return (ledger, goals)
        }
        let sessionID = self.sessionID
        let store = live.store
        let ledger = autonomyState.ledger ?? RunLedgerRecorder(sessionID: sessionID, store: store)
        let pricing = live.modelPricing(session.configuration.modelID)
        let judge = ModelCompletionJudge(
            model: live.modelClient,
            modelID: GoalJudgeRoute.modelID,
            sessionID: sessionID,
            recordUsage: { usage in
                var spend = SessionUsageLedger()
                spend.record(usage)
                _ = try? await store.recordUsage(spend, for: sessionID)
            }
        )
        let goals = GoalRuntime(
            sessionID: sessionID,
            store: store,
            judge: judge,
            spend: {
                let ledger = await store.usageLedger(for: sessionID)
                let total = ledger.total
                return GoalUsageBaseline(
                    tokens: total.inputTokens + total.outputTokens,
                    costUSD: pricing.flatMap { pricing in ledger.estimatedCost(pricing: { _ in pricing }) }
                )
            }
        )
        autonomyState.ledger = ledger
        autonomyState.goals = goals
        return (ledger, goals)
    }

    /// The checks the workspace suggests, as the stop check's recipe, until
    /// the project records its own (`.juno/verify.json`, Lane B).
    func gateRecipe(_ context: WorkspaceContext) async -> GateRecipe? {
        if autonomyState.recipeLoaded { return autonomyState.recipe }
        let recipe = GateRecipe.suggested(await context.tests.detectSuggestions())
        autonomyState.recipe = recipe
        autonomyState.recipeLoaded = true
        return recipe
    }

    /// Everything a Code orchestrator needs to work autonomously.
    func autonomyConfiguration(contractModelID: String, live: Live, context: WorkspaceContext) async -> AutonomyConfiguration {
        let runtime = autonomyRuntime(live)
        let recipe = await gateRecipe(context)
        let modelPricing = live.modelPricing(contractModelID)
        return AutonomyConfiguration(
            settings: settings.autonomy,
            behavior: .code,
            ledger: runtime.ledger,
            goals: runtime.goals,
            recipe: { recipe },
            pricing: { id in id == contractModelID ? modelPricing : nil },
            diffAvailable: context.access.isGitRepository
        )
    }

    /// The stop check for a Code orchestrator.
    func autonomyGate(_ configuration: AutonomyConfiguration) -> AutonomyGate {
        AutonomyGate(settings: configuration.settings, recipe: configuration.recipe, goals: configuration.goals)
    }

    // MARK: - What the model is told each turn

    /// The `<session_state>` sections the loop adds in Code: the goal, the
    /// project's checks and the run's bounds (§1.7, §2.5). Each is re-sent
    /// only when its fingerprint changes, and the goal and checks again in
    /// full after a compaction.
    nonisolated static func autonomySections(
        goal: GoalRun?,
        recipe: GateRecipe?,
        ledger: RunLedger?,
        settings: AutonomySettings
    ) -> [SessionStateSection] {
        [
            SessionStateSection(
                name: "goal",
                body: GoalText.section(goal),
                fingerprintSource: GoalText.fingerprint(goal)
            ),
            verifySection(recipe: recipe, ledger: ledger),
            autonomySection(settings),
        ]
    }

    /// The `<verify>` section: the checks, and the newest one's result.
    nonisolated static func verifySection(recipe: GateRecipe?, ledger: RunLedger?) -> SessionStateSection {
        var lines: [String] = []
        var fingerprint: [String] = []
        if let recipe, !recipe.checks.isEmpty {
            lines.append("Checks for this project (from \(recipe.source)):")
            for check in recipe.checks {
                let paths = check.paths.isEmpty ? "every file" : "paths " + check.paths.joined(separator: ", ")
                lines.append("- \(check.id) (\(check.kind.rawValue)): \(check.command) — \(paths)")
            }
            for target in recipe.ui {
                lines.append("UI: \(target.surface.rawValue) \(target.target)")
            }
            fingerprint.append(lines.joined(separator: "\n"))
        } else {
            lines.append(
                "No checks are recorded for this project yet. Find how it builds and tests (package scripts, Makefile, Package.swift and the like) and run the checks your change affects."
            )
            fingerprint.append("none")
        }
        if let ledger, let last = ledger.verifications.last {
            let fresh = ledger.isFresh(last)
            lines.append(
                "Last check: `\(last.command)` \(last.passed ? "passed" : "failed") at revision \(last.workspaceRevision)"
                    + (fresh ? ", since your last edit." : "; you have edited files since, so it no longer counts.")
            )
            fingerprint.append("\(last.id)|\(fresh)")
        }
        return SessionStateSection(
            name: "verify",
            body: lines.joined(separator: "\n"),
            fingerprintSource: fingerprint.joined(separator: "\u{1F}")
        )
    }

    /// The `<autonomy>` section: how far Juno keeps the run going.
    nonisolated static func autonomySection(_ settings: AutonomySettings) -> SessionStateSection {
        let body: String
        if settings.enforces {
            var parts = [
                "up to \(settings.maxAutoContinues) automatic continuations per run",
                "a step limit of \(settings.stepLimit)",
            ]
            if let budget = settings.runBudget.sentence {
                parts.append("a budget of \(budget) per run without a goal")
            }
            body = "Juno keeps the run going until the work is done and checked: " + parts.joined(separator: ", ") + "."
        } else {
            body = "Juno reports when you finish but does not send you back to work."
        }
        return SessionStateSection(name: "autonomy", body: body)
    }

    // MARK: - Session lifecycle

    /// Binds the goal model and reads the goals, after the transcript loads.
    func restoreAutonomy(_ live: Live) async {
        goal.host = self
        // A task grant applies only while its goal is in force, read from the
        // stored goal at the moment of each call: the goal runtime moves a
        // goal out of `active` (met, impossible, out of budget, blocked,
        // stopped) without telling the coordinator.
        let store = live.store
        let sessionID = self.sessionID
        await live.permissions.setTaskGrantCheck { goalID in
            guard let goal = await store.currentGoalRun(for: sessionID), goal.id == goalID else { return false }
            return goal.grantsApply
        }
        let file = await live.store.goalFile(for: sessionID)
        goal.apply(file)
        goal.isWorking = session.status.isActive
        if let current = file.current, current.isActive, let root = live.context?.access.rootURL.path {
            await live.permissions.setTaskGrants(current.grants, goalID: current.id, workspaceRoot: root)
        }
        guard !autonomyState.launchChecked else { return }
        autonomyState.launchChecked = true
        // "Resume interrupted goals when Juno opens" (off by default, D-025).
        guard let current = file.current,
              current.status == .paused,
              current.statusReason == GoalRun.interruptedReason,
              let context = live.context,
              CodeSettingsStore().resolved(projectRoot: context.access.rootURL).autonomy.resumeInterruptedGoalsOnLaunch
        else { return }
        try? await resumeGoal()
    }

    /// Keeps the goal model in step with the transcript.
    func integrateAutonomy(_ event: SessionEvent) {
        switch event.payload {
        case .goalSet, .goalEdited, .goalStatus, .goalVerdict, .budgetReached, .runCompleted, .runContinued:
            Task { @MainActor [weak self] in await self?.goal.refresh() }
        case let .statusChanged(change):
            goal.isWorking = change.status.isActive
        default:
            break
        }
    }

    // MARK: - Reader actions

    /// Keep going after a step limit, a budget or a stall: another block of
    /// steps and budget, and the run carries on with no new message.
    public func keepGoing() async {
        guard let live else { return }
        do {
            if let current = await live.store.currentGoalRun(for: sessionID),
               current.status == .budgetReached || current.status == .needsYou
            {
                try await live.store.updateCurrentGoal(for: sessionID, record: .status) { goal in
                    if goal.status == .budgetReached {
                        try goal.keepGoing()
                    } else {
                        try goal.transition(to: .active)
                    }
                }
                await restoreGrants(live)
            }
            try await currentOrchestrator(live).resume(note: .keepGoing, origin: .user)
            runStartedAt = Date()
            transientError = nil
        } catch {
            transientError = "Could not keep going: \(error.localizedDescription)"
        }
        await goal.refresh()
    }

    /// Resume a run Juno quit in the middle of: the calls that were running
    /// are named as "outcome unknown", and no message is added for the
    /// reader (§1.12).
    public func resumeInterruptedRun() async {
        guard let live else { return }
        let states = ConversationIntegrity.interruptedCalls(in: events)
        var summaries: [String: String] = [:]
        for event in events {
            if case let .toolProposed(proposed) = event.payload {
                summaries[proposed.toolCallID] = proposed.summary
            }
        }
        let unknown = states.compactMap { id, state -> String? in
            guard case .started = state else { return nil }
            return summaries[id] ?? id
        }.sorted()
        do {
            try await currentOrchestrator(live).resume(note: .afterQuit(unknownOutcomes: unknown), origin: .user)
            runStartedAt = Date()
            transientError = nil
        } catch {
            transientError = "Could not resume: \(error.localizedDescription)"
        }
    }

    /// Retry after a failed turn, through `resume(note: .retry)`: no second
    /// copy of the message and no clobbered draft. Nil when there was nothing
    /// to resume, so the caller can fall back to sending the message again.
    func retryByResuming() async -> Bool {
        guard let live, !session.status.isActive else { return false }
        do {
            try await currentOrchestrator(live).resume(note: .retry, origin: .user)
            runStartedAt = Date()
            transientError = nil
            return true
        } catch OrchestratorError.nothingToResume {
            return false
        } catch {
            transientError = "Could not retry: \(error.localizedDescription)"
            return true
        }
    }

    private func restoreGrants(_ live: Live) async {
        guard let current = await live.store.currentGoalRun(for: sessionID),
              let root = live.context?.access.rootURL.path
        else { return }
        if current.isActive {
            await live.permissions.setTaskGrants(current.grants, goalID: current.id, workspaceRoot: root)
        } else {
            await live.permissions.clearTaskGrants(goalID: current.id)
        }
    }
}

// MARK: - The goal commands

extension SessionController: GoalModelHost {
    public func draftGoal(objective: String, origin: GoalOrigin) async -> GoalDraft {
        var draft = GoalDraft(objective: objective, budget: settings.autonomy.goalBudget, origin: origin)
        guard let live, let context = live.context else { return draft }
        let recipe = await gateRecipe(context)
        draft.offeredGrants = recipe?.checks.map(\.command) ?? []
        let drafter = ModelCriteriaDrafter(
            model: live.modelClient,
            modelID: GoalJudgeRoute.modelID,
            sessionID: sessionID,
            recordUsage: { [store = live.store, sessionID] usage in
                var spend = SessionUsageLedger()
                spend.record(usage)
                _ = try? await store.recordUsage(spend, for: sessionID)
            }
        )
        // If drafting fails, the objective itself is the one criterion,
        // judged from the conversation.
        draft.criteria = (try? await drafter.draftCriteria(objective: objective, recipe: recipe))
            ?? [GoalCriterion(id: "c1", text: objective, check: .judged)]
        return draft
    }

    public func startGoal(_ draft: GoalDraft) async throws {
        guard let live, let context = live.context else {
            throw GoalActionError(message: Self.noProjectMessage("set a goal"))
        }
        let root = context.access.rootURL.path
        let runtime = autonomyRuntime(live)
        _ = runtime
        let usage = await live.store.usageLedger(for: sessionID)
        let pricing = live.modelPricing(session.configuration.modelID)
        let baseline = GoalUsageBaseline(
            tokens: usage.total.inputTokens + usage.total.outputTokens,
            costUSD: pricing.flatMap { pricing in usage.estimatedCost(pricing: { _ in pricing }) }
        )
        let goal = draft.goal(worktreePath: root, baseline: baseline)
        await live.permissions.clearTaskGrants()
        try await live.store.setGoal(goal, for: sessionID)
        await live.permissions.setTaskGrants(goal.grants, goalID: goal.id, workspaceRoot: root)
        await self.goal.refresh()
        // Start begins the first turn with the objective as the directive. A
        // run already working picks the goal up when it next tries to finish.
        guard !session.status.isActive else { return }
        try await startTurn(prompt: draft.objective, modelPrompt: draft.objective, images: [], live: live)
    }

    public func pauseGoal() async throws {
        guard let live else { return }
        // Instant: the turn in flight finishes its tool wave, then no
        // continuation toward the goal starts.
        try await live.store.updateCurrentGoal(for: sessionID, record: .status) { goal in
            try goal.transition(to: .paused, reason: "Paused by you")
        }
        await restoreGrants(live)
    }

    public func resumeGoal() async throws {
        guard let live else { return }
        guard let current = await live.store.currentGoalRun(for: sessionID) else { return }
        let keepGoing = current.status == .budgetReached
        try await live.store.updateCurrentGoal(for: sessionID, record: .status) { goal in
            if goal.status == .budgetReached {
                try goal.keepGoing()
            } else {
                try goal.transition(to: .active)
            }
        }
        await restoreGrants(live)
        // A step-based goal an earlier build left paused would refuse every
        // message; resuming the goal resumes it too.
        if let lifecycle = session.goal?.lifecycle, lifecycle == .paused || lifecycle == .blocked {
            await setGoalLifecycle(.active)
        }
        guard !session.status.isActive else { return }
        do {
            try await currentOrchestrator(live).resume(
                note: keepGoing ? .keepGoing : RuntimeContinuation.goalResumed,
                origin: .user
            )
            runStartedAt = Date()
        } catch OrchestratorError.nothingToResume {
            try await startTurn(prompt: current.objective, modelPrompt: current.objective, images: [], live: live)
        }
    }

    public func editGoal(_ draft: GoalDraft) async throws {
        guard let live else { return }
        try await live.store.updateCurrentGoal(for: sessionID, record: .edited) { goal in
            let objective = draft.objective.trimmingCharacters(in: .whitespacesAndNewlines)
            if !objective.isEmpty {
                goal.objective = String(objective.prefix(GoalRun.maximumObjectiveCharacters))
            }
            if !draft.criteria.isEmpty {
                goal.criteria = Array(draft.criteria.prefix(GoalRun.maximumCriteria))
            }
            goal.constraints = draft.constraints
            goal.budget = draft.budget
            goal.originalBudget = draft.budget
        }
    }

    public func clearGoal() async throws {
        guard let live else { return }
        let current = await live.store.currentGoalRun(for: sessionID)
        try await live.store.updateCurrentGoal(for: sessionID, record: .status) { goal in
            try goal.transition(to: .cleared, reason: "Cleared by you")
        }
        await live.permissions.clearTaskGrants(goalID: current?.id)
    }

    public func dismissGoalProposal() async {
        try? await live?.store.clearGoalProposal(for: sessionID)
    }

    public func reloadGoals() async -> GoalFile {
        guard let live else {
            return GoalFile(current: goal.current, proposal: goal.proposal, history: goal.history)
        }
        return await live.store.goalFile(for: sessionID)
    }
}

/// Why a goal command could not run, in words.
struct GoalActionError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
