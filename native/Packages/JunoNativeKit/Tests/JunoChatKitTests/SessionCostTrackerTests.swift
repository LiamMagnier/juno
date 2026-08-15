import Foundation
import XCTest
@testable import JunoChatKit

/// The ledger's whole job is to add up only what the server actually said, and
/// to stay honest about the rest. These tests are mostly about the *rest*.
final class SessionCostTrackerTests: XCTestCase {
    private func turn(
        _ id: String,
        model: String? = "anthropic:claude-opus-5",
        prompt: Int? = nil,
        completion: Int? = nil,
        cacheRead: Int? = nil,
        cacheWrite: Int? = nil,
        cost: Double? = nil
    ) -> NativeTurnUsage {
        NativeTurnUsage(
            messageID: id,
            model: model,
            promptTokens: prompt,
            completionTokens: completion,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            costUsd: cost
        )
    }

    func testTotalsSumOnlyReportedValues() {
        var ledger = SessionCostLedger()
        ledger.record(turn("a", prompt: 1_000, completion: 200, cost: 0.01))
        ledger.record(turn("b", prompt: 2_000, completion: 300, cost: 0.02))

        let totals = ledger.totals
        XCTAssertEqual(totals.turns, 2)
        XCTAssertEqual(totals.promptTokens, 3_000)
        XCTAssertEqual(totals.completionTokens, 500)
        XCTAssertEqual(totals.totalTokens, 3_500)
        XCTAssertEqual(totals.costUsd, 0.03, accuracy: 1e-9)
        XCTAssertEqual(totals.turnsReportingCost, 2)
        XCTAssertFalse(totals.isPartial)
    }

    /// The central rule: a provider that reported nothing must not be recorded
    /// as having reported zero, or the session silently under-bills.
    func testUnreportedUsageIsNotCountedAsZero() {
        var ledger = SessionCostLedger()
        ledger.record(turn("a", prompt: 1_000, completion: 200, cost: 0.01))
        ledger.record(turn("b")) // provider reported no usage at all

        let totals = ledger.totals
        XCTAssertEqual(totals.turns, 2)
        XCTAssertEqual(totals.turnsReportingTokens, 1)
        XCTAssertEqual(totals.turnsReportingCost, 1)
        XCTAssertTrue(totals.isPartial, "A turn with no cost makes the total a floor")
        XCTAssertEqual(totals.costUsd, 0.01, accuracy: 1e-9)
    }

    func testCacheHitRateIsUnknownRatherThanZeroWhenNoTurnReportedASplit() {
        var ledger = SessionCostLedger()
        ledger.record(turn("a", prompt: 1_000, completion: 200, cost: 0.01))

        let totals = ledger.totals
        XCTAssertEqual(totals.turnsReportingCache, 0)
        XCTAssertNil(totals.cacheHitRate, "Absent cache data is unknown, not a 0% hit rate")
    }

    func testCacheHitRateAndFreshInputUseTheReportedSplit() {
        var ledger = SessionCostLedger()
        ledger.record(turn("a", prompt: 10_000, completion: 500, cacheRead: 8_000, cacheWrite: 1_200, cost: 0.05))

        let totals = ledger.totals
        XCTAssertEqual(totals.cacheReadTokens, 8_000)
        XCTAssertEqual(totals.cacheWriteTokens, 1_200)
        XCTAssertEqual(totals.freshInputTokens, 2_000)
        XCTAssertEqual(try XCTUnwrap(totals.cacheHitRate), 0.8, accuracy: 1e-9)
        XCTAssertEqual(totals.turnsReportingCache, 1)
    }

    /// A resumed generation re-sends `done`. Billing it twice is the bug this
    /// guards; keeping its original position is what stops the list reordering.
    func testRecordingTheSameMessageTwiceReplacesRatherThanDoubleBills() {
        var ledger = SessionCostLedger()
        ledger.record(turn("a", prompt: 100, completion: 10, cost: 0.001))
        ledger.record(turn("b", prompt: 100, completion: 10, cost: 0.001))
        ledger.record(turn("a", prompt: 400, completion: 90, cost: 0.009))

        let totals = ledger.totals
        XCTAssertEqual(totals.turns, 2)
        XCTAssertEqual(totals.promptTokens, 500)
        XCTAssertEqual(totals.costUsd, 0.010, accuracy: 1e-9)
        XCTAssertEqual(ledger.turns.map(\.messageID), ["a", "b"], "Order is preserved")
    }

    func testFreshInputIsUnknownWhenEitherHalfIsMissing() {
        XCTAssertNil(turn("a", prompt: 1_000).freshInputTokens)
        XCTAssertNil(turn("a", cacheRead: 500).freshInputTokens)
        XCTAssertEqual(turn("a", prompt: 1_000, cacheRead: 400).freshInputTokens, 600)
    }

    /// The two counters come from different provider fields; a disagreement
    /// must clamp rather than produce negative tokens.
    func testFreshInputClampsWhenCacheReadExceedsPrompt() {
        XCTAssertEqual(turn("a", prompt: 100, cacheRead: 900).freshInputTokens, 0)
    }

    func testTotalsByModelGroupsAndOrdersBySpend() {
        var ledger = SessionCostLedger()
        ledger.record(turn("a", model: "cheap", prompt: 100, completion: 10, cost: 0.001))
        ledger.record(turn("b", model: "pricey", prompt: 100, completion: 10, cost: 0.500))
        ledger.record(turn("c", model: "cheap", prompt: 100, completion: 10, cost: 0.001))
        ledger.record(turn("d", model: nil, prompt: 50, completion: 5, cost: 0.010))

        let grouped = ledger.totalsByModel()
        XCTAssertEqual(grouped.map(\.model), ["pricey", nil, "cheap"])
        XCTAssertEqual(grouped.first?.totals.turns, 1)
        XCTAssertEqual(grouped.last?.totals.turns, 2)
        // Unnamed models are grouped, never dropped: the rows must still add
        // back up to the session total.
        let regrouped = grouped.reduce(0.0) { $0 + $1.totals.costUsd }
        XCTAssertEqual(regrouped, ledger.totals.costUsd, accuracy: 1e-9)
    }

    func testTurnUsageIsBuiltFromACompletedMessageWithoutInventingValues() {
        let message = NativeCompletedChatMessage(
            id: "assistant_1",
            content: "hi",
            reasoning: nil,
            model: "anthropic:claude-opus-5",
            createdAt: Date(timeIntervalSince1970: 1_000),
            sources: [],
            finishReason: .stop,
            promptTokens: 900,
            completionTokens: 100,
            costUsd: 0.004,
            cacheReadTokens: 600,
            cacheWriteTokens: nil
        )

        let usage = NativeTurnUsage(message: message)
        XCTAssertEqual(usage.messageID, "assistant_1")
        XCTAssertEqual(usage.promptTokens, 900)
        XCTAssertEqual(usage.cacheReadTokens, 600)
        XCTAssertNil(usage.cacheWriteTokens, "An absent bucket stays absent")
        XCTAssertEqual(usage.recordedAt, Date(timeIntervalSince1970: 1_000))
    }

    func testCompletedMessageCacheHitRateGuardsTheDivide() {
        func message(prompt: Int?, cacheRead: Int?) -> NativeCompletedChatMessage {
            NativeCompletedChatMessage(
                id: "m", content: "", reasoning: nil, model: nil,
                createdAt: Date(), sources: [], finishReason: .stop,
                promptTokens: prompt, cacheReadTokens: cacheRead
            )
        }
        XCTAssertNil(message(prompt: 0, cacheRead: 10).cacheHitRate)
        XCTAssertNil(message(prompt: nil, cacheRead: 10).cacheHitRate)
        XCTAssertNil(message(prompt: 100, cacheRead: nil).cacheHitRate)
        XCTAssertEqual(try XCTUnwrap(message(prompt: 100, cacheRead: 25).cacheHitRate), 0.25, accuracy: 1e-9)
    }

    /// Switching conversations must not carry spend across. The ledgers are held
    /// per conversation by `NativeConversationModel`, so this pins the primitive
    /// that guarantee rests on.
    func testResetClearsTheLedger() {
        var ledger = SessionCostLedger()
        ledger.record(turn("a", prompt: 100, completion: 10, cost: 0.01))
        XCTAssertEqual(ledger.totals.turns, 1)

        ledger.reset()
        XCTAssertEqual(ledger.totals, .empty)
    }
}

/// Seeding a ledger from a reloaded transcript is what makes the receipt
/// survive a relaunch. The rules it must not break are about double-billing and
/// about not inventing a zero.
final class SessionCostLedgerSeedingTests: XCTestCase {
    private func usage(_ id: String, cost: Double?, cacheRead: Int? = nil) -> NativeTurnUsage {
        NativeTurnUsage(
            messageID: id, model: "m", promptTokens: 100, completionTokens: 10,
            cacheReadTokens: cacheRead, costUsd: cost
        )
    }

    /// The persisted row is authoritative — it is what the server actually
    /// wrote — and re-seeding on every reload must correct, never re-bill.
    func testReSeedingAnAlreadyRecordedTurnReplacesRatherThanDoubleBills() {
        var ledger = SessionCostLedger()
        ledger.record(usage("a", cost: 0.01))          // live `done` frame
        ledger.record(usage("a", cost: 0.02, cacheRead: 80)) // persisted row on reload

        XCTAssertEqual(ledger.totals.turns, 1, "One turn, not two")
        XCTAssertEqual(ledger.totals.costUsd, 0.02, accuracy: 1e-9)
        XCTAssertEqual(ledger.totals.cacheReadTokens, 80, "The persisted split wins")
    }

    /// A reload must not turn "the provider never reported" into a measured
    /// zero — that is what keeps the "≥" in front of a partial total.
    func testATurnWithNoReportedUsageStaysUnknownAfterReload() {
        var ledger = SessionCostLedger()
        ledger.record(usage("a", cost: 0.01))
        ledger.record(NativeTurnUsage(messageID: "b")) // nothing reported

        let totals = ledger.totals
        XCTAssertEqual(totals.turns, 2)
        XCTAssertEqual(totals.turnsReportingCost, 1)
        XCTAssertTrue(totals.isPartial)
    }
}
