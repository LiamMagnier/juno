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

/// The project's verify recipe for one orchestrator: the file is read (and
/// its acceptance checked) at every ask, which is one small read; discovery,
/// which walks the project, runs once.
actor VerifyRecipeStatusCache: VerifyRecipeProviding {
    private let store: VerifyRecipeStore
    private var discovered: VerifyRecipe?

    init(store: VerifyRecipeStore) {
        self.store = store
    }

    func status() async -> VerifyRecipeStatus {
        switch store.file() {
        case .missing:
            if let discovered { return .discovered(discovered) }
            let found = await store.discover()
            discovered = found
            return .discovered(found)
        case let .present(recipe, _, accepted):
            return accepted ? .accepted(recipe) : .awaitingAcceptance(recipe)
        case let .invalid(message, _):
            return .invalid(message)
        }
    }

    nonisolated func acceptedRecipe() -> VerifyRecipe? {
        store.acceptedRecipe()
    }
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

    /// Everything a Code orchestrator needs to work autonomously: Lane A's
    /// ledger and goal runtime, with Lane B's recipe, check runner, reviewer
    /// and report behind the stop check.
    ///
    /// - Parameter reviewer: the read-only `delegate_task` the review pass
    ///   starts the built-in `reviewer` through; nil where no diff can be read.
    func autonomyConfiguration(
        contractModelID: String,
        live: Live,
        context: WorkspaceContext,
        reviewer: (any SubagentDelegating)? = nil
    ) async -> AutonomyConfiguration {
        let runtime = autonomyRuntime(live)
        let suggested = await gateRecipe(context)
        let modelPricing = live.modelPricing(contractModelID)
        let root = context.access.rootURL
        let recipes = VerifyRecipeStore(workspaceRoot: root)
        let evidence = await VerificationLedgers.shared.ledger(for: sessionID, store: live.store)
        let checks = CheckRunner(
            executor: context.executor,
            permissions: live.permissions,
            ledger: evidence,
            changes: WorkspaceChangeDetector(rootURL: root)
        )
        let statuses = VerifyRecipeStatusCache(store: recipes)
        // The project's recipe (accepted, or found when there is no file),
        // each check marked with whether it runs without a prompt now: asked
        // at every stop check, so a rule or mode change counts at once. The
        // toolchain's suggestion stands in where the recipe has nothing.
        let recipe: @Sendable () async -> GateRecipe? = {
            let made = await VerifyGateRecipe.make(status: await statuses.status()) { check in
                await checks.allowedWithoutPrompt([
                    PlannedCheck(check: check, commandLine: check.commandLine, isTargeted: false),
                ])
            }
            return made ?? suggested
        }
        var reviewRunner: (any GateReviewRunning)?
        if let reviewer, context.access.isGitRepository {
            let store = live.store
            let sessionID = self.sessionID
            let git = context.git
            reviewRunner = VerifyGateReviewRunner(
                pass: ReviewPass(delegate: reviewer, ledger: evidence),
                diff: { await Self.reviewDiff(git) },
                request: {
                    await store.events(for: sessionID).reversed().lazy.compactMap { event -> String? in
                        if case let .userPrompt(prompt) = event.payload { return prompt.text }
                        return nil
                    }.first ?? ""
                }
            )
        }
        return AutonomyConfiguration(
            settings: settings.autonomy,
            behavior: .code,
            ledger: runtime.ledger,
            goals: runtime.goals,
            recipe: recipe,
            checkRunner: VerifyGateCheckRunner(recipes: statuses, runner: checks),
            reviewRunner: reviewRunner,
            reportBuilder: VerifyRunReportBuilder(),
            // Rule 2 waits on the session's background sub-agents (Lane B's
            // `BackgroundSubagents`, §5.2): a run whose children still work
            // ends "Waiting for … to finish", never as done.
            backgroundWork: { [sessionID] in
                await BackgroundSubagents.shared.snapshots(parentSessionID: sessionID)
                    .filter { $0.finishedAt == nil }
                    .map(\.title)
            },
            pricing: { id in id == contractModelID ? modelPricing : nil },
            diffAvailable: context.access.isGitRepository
        )
    }

    /// The run's change for the reviewer: staged and unstaged diffs, and the
    /// new files `git diff` does not show, by name (the reviewer reads them).
    nonisolated static func reviewDiff(_ git: any GitServicing) async -> String? {
        let unstaged = (try? await git.diff(staged: false, path: nil)) ?? ""
        let staged = (try? await git.diff(staged: true, path: nil)) ?? ""
        let untracked = ((try? await git.status())?.files ?? [])
            .filter { $0.indexState == "?" || $0.worktreeState == "?" }
            .map(\.path)
        var parts = [staged, unstaged].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if !untracked.isEmpty {
            parts.append("New files, not in the diff (read them with read_file):\n"
                + untracked.prefix(50).map { "- \($0)" }.joined(separator: "\n"))
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n")
    }

    /// The stop check for a Code orchestrator.
    func autonomyGate(
        _ configuration: AutonomyConfiguration,
        uiAdvisor: (any PreviewUIVerifyAdvising)? = nil
    ) -> AutonomyGate {
        AutonomyGate(
            settings: configuration.settings,
            recipe: configuration.recipe,
            goals: configuration.goals,
            uiAdvisor: uiAdvisor
        )
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
            body = "Alevr keeps the run going until the work is done and checked: " + parts.joined(separator: ", ") + "."
        } else {
            body = "Alevr reports when you finish but does not send you back to work."
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
        // Lane F's two goal hooks (§5.9), told as the goal runtime records:
        // `GoalSet` when a goal is set or replaced, `GoalVerdict` after each
        // verdict. Their answers are notices; they decide nothing.
        switch event.payload {
        case let .goalSet(set):
            Task { @MainActor [weak self] in
                await self?.signalHooks { hooks, id in
                    await hooks.goalSet(sessionID: id, objective: set.objective, criteria: set.criteria.map(\.text))
                }
            }
        case let .goalVerdict(verdict):
            Task { @MainActor [weak self] in
                await self?.signalHooks { hooks, id in
                    await hooks.goalVerdict(
                        sessionID: id,
                        verdict: verdict.verdict.rawValue,
                        reason: verdict.reason,
                        unmetCriteria: verdict.unmetCriteria
                    )
                }
            }
        default:
            break
        }
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
    /// steps and budget, and the run carries on with no new message. Refused
    /// while a run, a rewind or a compaction holds the session; answers
    /// whether the run carried on (the Runs list and notifications ask).
    @discardableResult
    public func keepGoing() async -> Bool {
        guard let live, !isRunning, !isRewinding, !isCompacting else { return false }
        var resumed = false
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
            resumed = true
        } catch {
            transientError = "Could not keep going: \(error.localizedDescription)"
        }
        await goal.refresh()
        return resumed
    }

    /// Resume a run Juno quit in the middle of: the calls that were running
    /// are named as "outcome unknown", and no message is added for the
    /// reader (§1.12).
    @discardableResult
    public func resumeInterruptedRun() async -> Bool {
        guard let live, !isRunning, !isRewinding, !isCompacting else { return false }
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
            return true
        } catch {
            transientError = "Could not resume: \(error.localizedDescription)"
            return false
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
        // The project's own checks (Lane B's recipe) are what a grant can
        // cover; the toolchain's suggestion where it has none.
        let projectRecipe = await VerifyGateRecipe.make(
            status: await VerifyRecipeStore(workspaceRoot: context.access.rootURL).status(),
            runsWithoutPrompt: { _ in false }
        )
        var recipe = projectRecipe
        if recipe == nil { recipe = await gateRecipe(context) }
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
