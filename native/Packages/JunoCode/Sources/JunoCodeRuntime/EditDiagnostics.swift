import Foundation
import JunoCodeCore

/// Diagnostics after an edit batch (CODE_AGENT_SPEC §5.13).
///
/// After the model's edits, the runtime runs the project's typecheck for the
/// edited package itself, but only when three things hold: the reader
/// accepted the recipe, the command is allowed without a prompt by their
/// rules (or the mode), and it was fast the last time it ran (under 20 s).
/// New errors come back as a short block for the next tool result, the way
/// Claude Code feeds language-server diagnostics back after an edit. The run
/// is recorded like any check, so it counts as evidence too.
///
/// It never asks the reader anything: a typecheck that would prompt simply
/// does not run here, and the model runs it itself when it wants to.
///
/// Called by the loop after a batch that changed files (Lane A's
/// orchestrator, or Lane F's `PostToolBatch` hook point, which can hand the
/// block back as context); the result goes after the batch's tool results.
public struct EditDiagnostics: Sendable {
    /// The longest a typecheck may have taken last time to run unasked.
    public static let maximumSeconds = 20.0
    /// The block stays short: the model can run the check for the rest.
    public static let maximumBlockBytes = 2 * 1_024

    private let recipes: any VerifyRecipeProviding
    private let runner: CheckRunner
    private let ledger: VerificationLedger

    public init(recipes: any VerifyRecipeProviding, runner: CheckRunner, ledger: VerificationLedger) {
        self.recipes = recipes
        self.runner = runner
        self.ledger = ledger
    }

    /// The typecheck to run for `changedFiles`, or nil when none qualifies.
    public func plan(changedFiles: [String]) async -> [PlannedCheck]? {
        guard !changedFiles.isEmpty, let recipe = recipes.acceptedRecipe() else { return nil }
        let checks = recipe.targetedChecks(for: changedFiles, kinds: [.typecheck])
        guard !checks.isEmpty else { return nil }
        let history = ledger.verifications
        for check in checks {
            guard let last = history.last(where: { $0.checkID == check.id }),
                  Double(last.durationMs) / 1_000 < Self.maximumSeconds
            else { return nil }
        }
        let planned = checks.map { PlannedCheck(check: $0, commandLine: $0.commandLine, isTargeted: false) }
        guard await runner.allowedWithoutPrompt(planned) else { return nil }
        return planned
    }

    /// Runs the typecheck when it qualifies and answers the block for the
    /// model, or nil when it did not run or found nothing.
    public func afterEdits(changedFiles: [String]) async -> String? {
        guard let planned = await plan(changedFiles: changedFiles) else { return nil }
        let outcomes = await runner.runAndRecord(planned)
        let failures = outcomes.compactMap { outcome -> String? in
            guard let record = outcome.record, !record.passed else { return nil }
            return "`\(record.command)`:\n" + record.excerpt
        }
        guard !failures.isEmpty else { return nil }
        var block = "Diagnostics after your edit (Juno ran the typecheck):\n" + failures.joined(separator: "\n\n")
        if block.utf8.count > Self.maximumBlockBytes {
            block = String(block.prefix(Self.maximumBlockBytes)) + "\n… run the check for the rest."
        }
        return block
    }
}
