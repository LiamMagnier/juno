import XCTest
@testable import JunoMobile

/// The per-answer price, as the transcript formats it.
///
/// Ported thresholds, not invented ones: this is `formatUsd` from the website's
/// `src/lib/utils.ts`, and the two clients have to agree or the same answer
/// costs "$0.0021" in a browser and "$0.00" on a phone. A flat two-decimal
/// format is the failure being guarded against — almost every answer costs less
/// than a cent, so it would print "$0.00" for all of them.
final class JunoMobileMessageCostTests: XCTestCase {
    private func format(_ value: Double) -> String {
        JunoMobileCost.formatted(value)
    }

    func testFourDecimalsUnderACent() {
        XCTAssertEqual(format(0.0021), "$0.0021")
        XCTAssertEqual(format(0.0099), "$0.0099")
    }

    func testThreeDecimalsUnderADollar() {
        XCTAssertEqual(format(0.01), "$0.010")
        XCTAssertEqual(format(0.4213), "$0.421")
    }

    func testTwoDecimalsAtADollarAndAbove() {
        XCTAssertEqual(format(1), "$1.00")
        XCTAssertEqual(format(12.3456), "$12.35")
    }

    /// Below a hundredth of a cent the exact figure is noise; the web says so
    /// rather than rounding to zero, and so does this.
    func testVerySmallCostsAreMarkedRatherThanRounded() {
        XCTAssertEqual(format(0.00001), "<$0.0001")
    }

    /// Zero and nonsense never reach the transcript — `costUSD` is nil for them —
    /// but the formatter is total anyway rather than trapping.
    func testNonPositiveAndNonFiniteAreSafe() {
        XCTAssertEqual(format(0), "$0")
        XCTAssertEqual(format(-1), "$0")
        XCTAssertEqual(format(.nan), "$0")
        XCTAssertEqual(format(.infinity), "$0")
    }
}
