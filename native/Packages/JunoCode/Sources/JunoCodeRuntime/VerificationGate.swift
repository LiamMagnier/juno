import Foundation
import JunoCodeCore

// Lane B's recipe, check runner, reviewer and report behind Lane A's stop
// check (CODE_AGENT_SPEC §1.4 rules 6, 9–11; §1.8–§1.10): the seam both lanes
// left open, closed at integration.
//
// Nothing here widens a permission. The gate runs a check itself only when
// every command of it would run without a prompt by the reader's own rules
// and mode, asked again at the moment it runs; each command is then
// authorized through `PermissionCoordinator` exactly as `run_command` would
// be. The reviewer is the read-only built-in `reviewer`. Evidence lands in
// the transcript the way a tool's would, stamped with the transcript's
// revision, and in the run ledger with the run's.

/// The stop check's recipe from the project's verify recipe.
public enum VerifyGateRecipe {
    /// The checks and UI targets of a usable recipe (accepted, or discovered
    /// when the project has no `.juno/verify.json`), each check marked with
    /// whether it would run without a prompt now. Nil when there is nothing
    /// to check, so the caller can fall back to the toolchain's suggestion.
    public static func make(
        status: VerifyRecipeStatus,
        runsWithoutPrompt: @Sendable (VerifyCheck) async -> Bool
    ) async -> GateRecipe? {
        guard let recipe = status.usableRecipe else { return nil }
        var checks: [GateRecipeCheck] = []
        for check in recipe.checks {
            checks.append(GateRecipeCheck(
                id: check.id,
                kind: check.kind,
                command: check.commandLine,
                paths: check.paths,
                runsWithoutPrompt: await runsWithoutPrompt(check)
            ))
        }
        var ui: [GateUITarget] = []
        for target in recipe.ui {
            switch target.kind {
            case .web:
                // Routes the recipe names; the Preview's own advice (rule 8b)
                // answers the web surface when it is wired.
                for route in target.routes ?? [] {
                    ui.append(GateUITarget(surface: .web, target: route))
                }
            case .mac, .ios:
                // A native check is recorded against the app it launched.
                if let app = target.app, !app.isEmpty {
                    ui.append(GateUITarget(surface: target.kind, target: app))
                }
            }
        }
        guard !checks.isEmpty || !ui.isEmpty else { return nil }
        let source = status.isAccepted
            ? ".juno/verify.json"
            : "what Juno found in this project, not saved yet"
        return GateRecipe(checks: checks, ui: ui, source: source)
    }
}

/// Lane B's `CheckRunner` as the stop check's runner (`runCheck`).
public struct VerifyGateCheckRunner: GateCheckRunning {
    private let recipes: any VerifyRecipeProviding
    private let runner: CheckRunner

    public init(recipes: any VerifyRecipeProviding, runner: CheckRunner) {
        self.recipes = recipes
        self.runner = runner
    }

    /// `runAndRecord` appends each check's file changes and record to the
    /// transcript itself.
    public var recordsEvidence: Bool { true }

    public func runChecks(ids: [String], sessionID _: CodeSessionID) async -> [VerificationRecord] {
        guard let recipe = await recipes.status().usableRecipe,
              let planned = try? CheckRunner.plan(
                  recipe: recipe,
                  scope: .full,
                  ids: ids,
                  changedFiles: [],
                  fileExists: { _ in false }
              ),
              !planned.isEmpty
        else { return [] }
        // Asked again now: a rule the reader removed, or a mode they lowered,
        // since the gate decided means the model is asked instead.
        guard await runner.allowedWithoutPrompt(planned) else { return [] }
        return await runner.runAndRecord(planned).compactMap(\.record)
    }
}

/// Lane B's review pass as the stop check's reviewer (`runReview`).
public struct VerifyGateReviewRunner: GateReviewRunning {
    private let pass: ReviewPass
    private let diff: @Sendable () async -> String?
    private let request: @Sendable () async -> String

    /// - Parameters:
    ///   - diff: the run's change (`git diff` of the working tree), or nil
    ///     where none can be read.
    ///   - request: the reader's latest message, in their words.
    public init(
        pass: ReviewPass,
        diff: @escaping @Sendable () async -> String?,
        request: @escaping @Sendable () async -> String
    ) {
        self.pass = pass
        self.diff = diff
        self.request = request
    }

    /// `ReviewPass` records the review in the transcript itself.
    public var recordsEvidence: Bool { true }

    public func review(sessionID: CodeSessionID, ledger: RunLedger, goal: GoalRun?) async -> ReviewRecord? {
        guard let diff = await diff(), !diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        let outcome = await pass.run(
            ReviewPass.Request(
                diff: diff,
                request: await request(),
                criteria: goal?.criteria.map { (id: $0.id, text: $0.text) } ?? [],
                todos: ledger.openTodos.map(\.content),
                checks: ledger.verifications
            ),
            sessionID: sessionID
        )
        return outcome.record
    }
}

/// Lane B's report builder over the run ledger: the "Checked" rows, the
/// words about checks and "Not checked since the last edit", from the
/// ledger's records alone. Lane A's words stand for the ends Lane B leaves
/// unsaid (a step limit, a budget, a block, a wait).
public struct VerifyRunReportBuilder: RunReportBuilding {
    public init() {}

    public func report(
        endReason: RunEndReason,
        ledger: RunLedger,
        recipe: GateRecipe?,
        summary: String,
        endDetail: String?,
        durationSeconds: Double
    ) async -> RunOutcomeEvent {
        let evidence = VerificationSnapshot(
            workspaceRevision: ledger.workspaceRevision,
            verifications: ledger.verifications,
            uiVerifications: ledger.uiVerifications,
            review: ledger.review,
            lastDiffReadRevision: ledger.lastDiffReadRevision
        )
        let report = RunReportBuilder.build(RunReportBuilder.Input(
            endReason: endReason,
            modelReport: summary,
            evidence: evidence,
            filesChanged: ledger.filesChanged.count,
            durationSeconds: durationSeconds,
            checksKnown: !(recipe?.checks.isEmpty ?? true)
        ))
        guard report.verification == nil, let endDetail else { return report }
        return RunOutcomeEvent(
            endReason: report.endReason,
            summary: report.summary,
            verification: endDetail,
            checks: report.checks,
            notChecked: report.notChecked,
            left: report.left,
            filesChanged: report.filesChanged,
            durationSeconds: report.durationSeconds
        )
    }
}
