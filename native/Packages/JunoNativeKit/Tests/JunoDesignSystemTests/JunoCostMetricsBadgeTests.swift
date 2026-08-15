import XCTest
@testable import JunoDesignSystem

/// The formatter decides whether a reader sees "$0.00" (reads as free) or
/// "<$0.01" (reads as cheap) for a turn they were actually billed for. That
/// distinction is the reason this is a testable type and not a `String(format:)`
/// buried in a view.
final class JunoCostMetricsBadgeTests: XCTestCase {
    // MARK: - Money

    func testOnlyAnExactZeroPrintsAsZero() {
        XCTAssertEqual(JunoCostFormatting.cost(0), "$0.00")
    }

    func testARealButSubCentAmountNeverPrintsAsZero() {
        XCTAssertEqual(JunoCostFormatting.cost(0.0006), "<$0.01")
        XCTAssertEqual(JunoCostFormatting.cost(0.0099), "<$0.01")
    }

    func testSmallAmountsKeepThreeDecimalsAndLargeOnesTwo() {
        XCTAssertEqual(JunoCostFormatting.cost(0.0125), "$0.013")
        XCTAssertEqual(JunoCostFormatting.cost(1.5), "$1.500")
        XCTAssertEqual(JunoCostFormatting.cost(12.345), "$12.35")
    }

    func testAPartialTotalIsMarkedAsAFloor() {
        XCTAssertEqual(JunoCostFormatting.cost(0.03, isPartial: true), "≥$0.030")
        XCTAssertEqual(JunoCostFormatting.cost(0, isPartial: true), "≥$0.00")
    }

    func testNegativeCostIsClampedRatherThanRendered() {
        XCTAssertEqual(JunoCostFormatting.cost(-5), "$0.00")
    }

    // MARK: - Tokens

    func testTokenCountsAreCompactAndTruncatedNeverRoundedUp() {
        XCTAssertEqual(JunoCostFormatting.tokens(0), "0")
        XCTAssertEqual(JunoCostFormatting.tokens(847), "847")
        XCTAssertEqual(JunoCostFormatting.tokens(1_999), "1.9K", "Truncates, so the figure is one the session reached")
        XCTAssertEqual(JunoCostFormatting.tokens(12_400), "12K")
        XCTAssertEqual(JunoCostFormatting.tokens(1_890_000), "1.8M")
    }

    func testPercentHasNoDecimals() {
        XCTAssertEqual(JunoCostFormatting.percent(0.8), "80%")
        XCTAssertEqual(JunoCostFormatting.percent(1.4), "100%", "Clamped")
        XCTAssertEqual(JunoCostFormatting.percent(-0.2), "0%")
    }

    // MARK: - Metrics

    private func metrics(
        turns: Int = 1,
        input: Int = 0,
        output: Int = 0,
        cacheRead: Int = 0,
        cacheWrite: Int = 0,
        cost: Double = 0,
        reportingCache: Int = 0,
        reportingCost: Int = 1
    ) -> JunoCostMetrics {
        JunoCostMetrics(
            turns: turns, inputTokens: input, outputTokens: output,
            cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
            costUsd: cost, turnsReportingCache: reportingCache,
            turnsReportingCost: reportingCost
        )
    }

    func testAnEmptySessionIsEmptySoTheBadgeDrawsNothing() {
        XCTAssertTrue(JunoCostMetrics.empty.isEmpty)
        XCTAssertFalse(metrics(turns: 1).isEmpty)
    }

    /// The rule the badge's cache rows depend on: no reported split means the
    /// rows are absent, not zeroed. A "0 cached" row would assert a total cache
    /// miss that never happened.
    func testAbsentCacheDataIsUnknownNotZeroPercent() {
        let noCache = metrics(input: 5_000, reportingCache: 0)
        XCTAssertFalse(noCache.hasCacheData)
        XCTAssertNil(noCache.cacheHitRate)

        let withCache = metrics(input: 5_000, cacheRead: 4_000, reportingCache: 1)
        XCTAssertTrue(withCache.hasCacheData)
        XCTAssertEqual(try XCTUnwrap(withCache.cacheHitRate), 0.8, accuracy: 1e-9)
    }

    func testCacheHitRateGuardsTheDivideWhenNoInputWasReported() {
        XCTAssertNil(metrics(input: 0, cacheRead: 10, reportingCache: 1).cacheHitRate)
    }

    func testPartialWhenSomeTurnReportedNoCost() {
        XCTAssertTrue(metrics(turns: 3, reportingCost: 2).isPartial)
        XCTAssertFalse(metrics(turns: 3, reportingCost: 3).isPartial)
    }

    func testTotalTokensAddsBothDirections() {
        XCTAssertEqual(metrics(input: 1_000, output: 250).totalTokens, 1_250)
    }
}
