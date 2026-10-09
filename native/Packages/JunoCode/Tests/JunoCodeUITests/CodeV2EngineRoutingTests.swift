import XCTest
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeUI

/// The Alevr engine's half of Code v2 Orchestrate and `auto`: how the
/// composer's role routing sizes the delegate tools and picks the reviewer.
final class CodeV2EngineRoutingTests: XCTestCase {
    private func selection(_ instance: String, _ model: String) -> CodeV2.ModelSelection {
        CodeV2.ModelSelection(instanceId: instance, model: model)
    }

    func testConcurrencyFollowsTheWorkersWithinTheEngineCeiling() {
        XCTAssertEqual(SessionController.subagentConcurrency(for: nil), DelegateTaskTool.maximumConcurrent)
        let lead = selection("alevr", "anthropic:claude-opus-5-5")
        let solo = CodeV2.RoleRouting(orchestrator: lead, workers: Array(repeating: lead, count: 5), preset: .solo)
        XCTAssertEqual(SessionController.subagentConcurrency(for: solo), DelegateTaskTool.maximumConcurrent, "solo ignores workers")
        let five = CodeV2.RoleRouting(orchestrator: lead, workers: Array(repeating: lead, count: 5), preset: .leadWorkers)
        XCTAssertEqual(SessionController.subagentConcurrency(for: five), 5)
        let ten = CodeV2.RoleRouting(orchestrator: lead, workers: Array(repeating: lead, count: 10), preset: .bestOfN)
        XCTAssertEqual(SessionController.subagentConcurrency(for: ten), DelegateTaskTool.maximumConfigurableConcurrent)
    }

    func testTheReviewerRunsOnTheRoutedAlevrModelOnly() {
        let lead = selection("alevr", "anthropic:claude-opus-5-5")
        XCTAssertEqual(SessionController.autoReviewerModelID(routing: nil, sessionModelID: "m"), "m")
        let alevr = CodeV2.RoleRouting(orchestrator: lead, reviewer: selection("alevr", "openai:gpt-6.1-mini"), preset: .leadWorkers)
        XCTAssertEqual(SessionController.autoReviewerModelID(routing: alevr, sessionModelID: "m"), "openai:gpt-6.1-mini")
        // A subscription's model is not served by this engine: the session's model reviews.
        let subscription = CodeV2.RoleRouting(orchestrator: lead, reviewer: selection("codex:default", "gpt-6.1-codex"), preset: .leadWorkers)
        XCTAssertEqual(SessionController.autoReviewerModelID(routing: subscription, sessionModelID: "m"), "m")
    }

    func testTheRunBudgetStartsOverEachTurn() async {
        let ledger = RunBudgetLedger(limits: CodeV2.RunBudget(maxTokens: 100))
        let exhausted = await ledger.charge(inputTokens: 80, outputTokens: 40)
        XCTAssertTrue(exhausted)
        await ledger.reset()
        let reason = await ledger.exhaustedReason
        XCTAssertNil(reason)
        let snapshot = await ledger.snapshot()
        XCTAssertEqual(snapshot.tokens, 0)
        let again = await ledger.charge(inputTokens: 10, outputTokens: 10)
        XCTAssertFalse(again)
    }
}
