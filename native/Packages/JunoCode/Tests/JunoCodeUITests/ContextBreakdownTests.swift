import Foundation
import Testing
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeUI

/// `/context` and `/cost` (CODE_AGENT_SPEC §5.4, §5.5): the parts are shares
/// of the provider's own total, and spend is told apart by who spent it.
struct ContextBreakdownTests {
    @Test
    func thePartsSumToTheMetersTotal() {
        let estimates: [ContextBreakdown.Part: Int] = [
            .system: 3_211, .tools: 9_870, .instructions: 1_402, .skills: 233,
            .sessionState: 97, .conversation: 18_004, .images: 4_800, .toolResults: 27_771,
        ]
        for total in [1, 7, 999, 48_212, 161_337, 1_000_003] {
            let breakdown = ContextBreakdown(estimates: estimates, reportedTotal: total, window: 200_000, compactionFraction: 0.8)
            #expect(breakdown.rows.reduce(0) { $0 + $1.tokens } == total, "total \(total)")
            #expect(breakdown.total == total)
            #expect(breakdown.isMeasured)
        }
        // Each part is within a token of its exact share.
        let breakdown = ContextBreakdown(estimates: estimates, reportedTotal: 100_000, window: nil, compactionFraction: nil)
        let sum = Double(estimates.values.reduce(0, +))
        for row in breakdown.rows {
            let exact = Double(estimates[row.part]!) * 100_000 / sum
            #expect(abs(Double(row.tokens) - exact) <= 1)
        }
        #expect(breakdown.rows.first?.part == .toolResults, "largest first")
    }

    @Test
    func beforeTheFirstReplyTheEstimatesAreTheTotal() {
        let breakdown = ContextBreakdown(
            estimates: [.system: 2_000, .tools: 6_000, .conversation: 0],
            reportedTotal: nil,
            window: 200_000,
            compactionFraction: 0.8
        )
        #expect(!breakdown.isMeasured)
        #expect(breakdown.total == 8_000)
        #expect(breakdown.rows.map(\.part) == [.tools, .system], "empty parts are left out")
        #expect(breakdown.compactionThreshold == 160_000)
    }

    @Test
    func suggestionsSayWhatTakesTheRoom() {
        let breakdown = ContextBreakdown(
            estimates: [.images: 14_000, .toolResults: 120_000, .conversation: 10_000],
            reportedTotal: 150_000,
            window: 180_000,
            compactionFraction: 0.9,
            imageCount: 7
        )
        #expect(breakdown.suggestions.contains { $0.hasPrefix("7 images hold") })
        #expect(breakdown.suggestions.contains { $0.hasPrefix("Tool results are") })
        #expect(breakdown.suggestions.contains { $0.contains("this session is close") })
        #expect(ContextBreakdown.estimate("abcdefgh") == 2)
    }

    @Test
    func costTellsTheSessionsTurnsFromItsSubagents() {
        func ledger(_ model: String, input: Int, output: Int) -> SessionUsageLedger {
            var ledger = SessionUsageLedger()
            ledger.record(ModelCallUsage(purpose: .turn, inputTokens: input, outputTokens: output, modelID: model))
            return ledger
        }
        var session = ledger("anthropic:claude-sonnet-5", input: 100_000, output: 4_000)
        let child = ledger("anthropic:claude-sonnet-5", input: 30_000, output: 1_000)
        session.add(child)
        let pricing: (String) -> CodeUsagePricing? = { _ in
            CodeUsagePricing(inputPerMillion: 3, outputPerMillion: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25)
        }
        let cost = CostBreakdown(session: session, subagents: [("Survey the tests", child)], pricing: pricing)
        #expect(cost.total.inputTokens == 130_000)
        #expect(cost.spenders.map(\.label) == ["This session's turns", "1 sub-agent"])
        #expect(cost.spenders[0].totals.inputTokens == 100_000)
        #expect(cost.spenders[1].totals.inputTokens == 30_000)
        let spenderSum = cost.spenders.compactMap(\.cost).reduce(0, +)
        #expect(abs(spenderSum - (cost.cost ?? 0)) < 0.000_001, "the shares add up to the whole")
        #expect(cost.models.count == 1)
        #expect(StudioCostBreakdownView.money(0.004) == "under $0.01")
        #expect(StudioCostBreakdownView.money(1.125) == "$1.13" || StudioCostBreakdownView.money(1.125) == "$1.12")
    }
}
