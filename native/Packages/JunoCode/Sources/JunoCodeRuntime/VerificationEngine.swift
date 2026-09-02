import Foundation
import JunoCodeCore

/// Manages structured verification contracts for task execution, evaluating
/// test runs, build results, and diff evidence to honestly attest whether a task succeeded.
public actor VerificationEngine {
    private let store: CodeSessionStore

    public init(store: CodeSessionStore) {
        self.store = store
    }

    /// Evaluates a completed test run, records structured verification evidence into the
    /// session goal if passing, and returns a verified outcome.
    @discardableResult
    public func recordTestVerification(
        sessionID: CodeSessionID,
        run: TestRunCompletedEvent
    ) async -> VerificationOutcome {
        if run.passed {
            let summary: String
            if let count = run.testsRun {
                summary = "\(count) test\(count == 1 ? "" : "s") passed."
            } else {
                summary = "Verification command passed."
            }

            _ = try? await store.updateGoal(
                sessionID: sessionID,
                mutation: .addVerificationEvidence(
                    summary: summary,
                    source: run.command
                )
            )

            return .passed(summary: summary)
        } else {
            let failureReason: String
            if let failures = run.failures, failures > 0 {
                failureReason = "\(failures) test failure\(failures == 1 ? "" : "s") in \(run.command)."
            } else {
                failureReason = "Test command failed: \(run.command)."
            }
            return .failedVerification(reason: failureReason)
        }
    }

    /// Evaluates overall task completion honestly against goal requirements,
    /// changed files, and verified evidence.
    ///
    /// Pure and static: the verdict is a function of its inputs, and the
    /// projection layer needs it without owning a store.
    public nonisolated static func evaluateTaskOutcome(
        goal: SessionGoal?,
        lastTestRun: TestRunCompletedEvent?,
        filesChangedCount: Int
    ) -> VerificationOutcome {
        // If there is an active goal with verification evidence
        if let goal {
            if !goal.verificationEvidence.isEmpty {
                let evidenceCount = goal.verificationEvidence.count
                let summary = "\(evidenceCount) verification check\(evidenceCount == 1 ? "" : "s") passed."
                return .passed(summary: summary)
            }

            // Check if all steps were completed
            let allCompleted = goal.steps.allSatisfy { $0.status == .completed }
            if allCompleted && filesChangedCount > 0 && lastTestRun?.passed == true {
                return .passed(summary: "All steps completed and verified by tests.")
            } else if allCompleted && filesChangedCount > 0 {
                return .passedWithWarnings(summary: "All steps completed, but no automated test evidence was recorded.")
            } else if !allCompleted {
                let remaining = goal.steps.filter { $0.status != .completed }.count
                return .failedVerification(reason: "\(remaining) goal step\(remaining == 1 ? "" : "s") remained incomplete.")
            }
        }

        // Without a formal goal, check if tests ran and passed
        if let lastTestRun {
            if lastTestRun.passed {
                return .passed(summary: "Tests passed successfully.")
            } else {
                return .failedVerification(reason: "Latest test run reported failures.")
            }
        }

        // If files changed without any verification
        if filesChangedCount > 0 {
            return .unverified(reason: "Edits were made without executing verification tests.")
        }

        return .passed(summary: "Run completed.")
    }
}
