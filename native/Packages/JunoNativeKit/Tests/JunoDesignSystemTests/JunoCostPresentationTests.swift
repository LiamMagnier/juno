import XCTest
@testable import JunoDesignSystem

/// The regression this file exists for: `amount.formatted(.currency(code:
/// "USD"))` renders in the *reader's* locale, so a 41-cent run displayed as
/// `0,41 US$` on a French Mac and `0,41 $` on a German one. Every assertion
/// below runs against a process whose current locale has been swapped, because
/// a formatter that is only ever tested on an American machine is exactly how
/// that bug shipped.
final class JunoCostPresentationTests: XCTestCase {
    /// The locales the money must survive. `fr_FR` is the confirmed regression:
    /// comma decimal separator, narrow-no-break space, trailing `$US` symbol.
    private static let locales = ["en_US", "fr_FR", "de_DE"]

    /// `Locale.current` is read from the process, and `FormatStyle` consults it
    /// unless a locale is pinned. Swapping `AppleLanguages`/`AppleLocale` in the
    /// user defaults is the only way to move it inside a test process, and it
    /// has to be put back or the next test class inherits it.
    private func withLocale(_ identifier: String, _ body: () throws -> Void) rethrows {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: "AppleLocale")
        defaults.set(identifier, forKey: "AppleLocale")
        defer {
            if let previous {
                defaults.set(previous, forKey: "AppleLocale")
            } else {
                defaults.removeObject(forKey: "AppleLocale")
            }
        }
        try body()
    }

    private func inEveryLocale(
        _ body: (String) throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) rethrows {
        for identifier in Self.locales {
            try withLocale(identifier) { try body(identifier) }
        }
    }

    // MARK: - The bug

    /// The exact figure from the screenshot: a French-locale Mac showed
    /// `0,41 US$` where the product means forty-one American cents.
    func testFortyOneCentsIsDollarsInFrance() {
        withLocale("fr_FR") {
            XCTAssertEqual(JunoCostFormatting.cost(Decimal(string: "0.41")!), "$0.41")
            XCTAssertEqual(JunoCostFormatting.cost(microUSD: 410_000), "$0.41")
            XCTAssertEqual(JunoCostFormatting.cost(usd: 0.41), "$0.41")
        }
    }

    func testEveryMagnitudeIsIdenticalInEveryLocale() {
        inEveryLocale { identifier in
            XCTAssertEqual(JunoCostFormatting.cost(Decimal(0)), "$0.00", identifier)
            XCTAssertEqual(
                JunoCostFormatting.cost(Decimal(string: "0.0006")!), "<$0.01", identifier
            )
            XCTAssertEqual(JunoCostFormatting.cost(Decimal(string: "0.41")!), "$0.41", identifier)
            XCTAssertEqual(JunoCostFormatting.cost(Decimal(string: "12.34")!), "$12.34", identifier)
            XCTAssertEqual(
                JunoCostFormatting.cost(Decimal(string: "1234.5")!), "$1,234.50", identifier
            )
        }
    }

    /// A locale swap must not reach the grouping separator either — `1.234,50 $`
    /// is the German rendering of the same number and is not what is meant.
    func testGroupingSeparatorIsPinnedToo() {
        withLocale("de_DE") {
            XCTAssertEqual(JunoCostFormatting.cost(Decimal(1_234_567)), "$1,234,567.00")
        }
    }

    // MARK: - The sub-cent rule

    func testOnlyAnExactZeroPrintsAsZero() {
        XCTAssertEqual(JunoCostFormatting.cost(Decimal(0)), "$0.00")
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 0), "$0.00")
    }

    func testARealButSubCentAmountNeverRoundsToZero() {
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 1), "<$0.01")
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 9_999), "<$0.01")
        XCTAssertEqual(JunoCostFormatting.cost(usd: 0.0006), "<$0.01")
        XCTAssertEqual(JunoCostFormatting.cost(usd: 0.0099), "<$0.01")
    }

    func testExactlyOneCentIsACentNotSubCent() {
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 10_000), "$0.01")
    }

    /// The presentation decision: display precision is cents, always. `$0.021`
    /// under a chat message was a developer artifact.
    func testDisplayPrecisionIsAlwaysCents() {
        XCTAssertEqual(JunoCostFormatting.cost(Decimal(string: "0.021")!), "$0.02")
        XCTAssertEqual(JunoCostFormatting.cost(Decimal(string: "1.5")!), "$1.50")
        XCTAssertEqual(JunoCostFormatting.cost(Decimal(string: "12.345")!), "$12.35")
    }

    /// Bankers' rounding — the `FormatStyle` default — would render this
    /// `$12.34`. A bill rounds away from zero.
    func testHalfCentsRoundTheWayABillRounds() {
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 12_345_000), "$12.35")
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 125_000), "$0.13")
    }

    func testExactPrecisionKeepsTheAccountantsDigits() {
        XCTAssertEqual(
            JunoCostFormatting.cost(Decimal(string: "0.021")!, precision: .exact), "$0.021"
        )
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 600, precision: .exact), "$0.0006")
        XCTAssertEqual(JunoCostFormatting.cost(Decimal(2), precision: .exact), "$2.00")
    }

    /// Exact precision does not get the `<$0.01` floor — it has its own, four
    /// decimals down. A single micro-dollar still may not print as `$0.0000`,
    /// because that reads as free and it was not.
    func testExactPrecisionShowsSubCentAmountsLiterally() {
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 1, precision: .exact), "<$0.0001")
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 100, precision: .exact), "$0.0001")
        inEveryLocale { identifier in
            XCTAssertEqual(
                JunoCostFormatting.cost(microUSD: 600, precision: .exact), "$0.0006", identifier
            )
        }
    }

    // MARK: - Micro-USD

    /// The wire format. `Decimal` division rather than `Double` so a value that
    /// sits exactly on the cent boundary lands on the right side of it.
    func testMicroUSDDividesExactly() {
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 1_000_000), "$1.00")
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 2_500_000), "$2.50")
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 999_999_999), "$1,000.00")
    }

    func testNegativeCostIsClampedRatherThanRendered() {
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: -5_000_000), "$0.00")
        XCTAssertEqual(JunoCostFormatting.cost(usd: -5), "$0.00")
    }

    func testNonFiniteDoublesDoNotProduceGarbage() {
        XCTAssertEqual(JunoCostFormatting.cost(usd: Double.nan), "$0.00")
        XCTAssertEqual(JunoCostFormatting.cost(usd: Double.infinity), "$0.00")
    }

    // MARK: - Partial totals

    func testAPartialTotalIsMarkedAsAFloor() {
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 30_000, isPartial: true), "≥$0.03")
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 0, isPartial: true), "≥$0.00")
        XCTAssertEqual(JunoCostFormatting.cost(microUSD: 500, isPartial: true), "≥<$0.01")
    }

    /// VoiceOver says the words. "≥" is spoken as "greater than or equal to", or
    /// dropped entirely, and neither is the sentence the receipt means.
    func testSpokenCostSaysAtLeastRatherThanDrawingAGlyph() {
        XCTAssertEqual(
            JunoCostFormatting.spokenCost(Decimal(string: "0.41")!, isPartial: true),
            "at least $0.41"
        )
        XCTAssertEqual(JunoCostFormatting.spokenCost(Decimal(string: "0.41")!), "$0.41")
    }

    // MARK: - Pairs

    func testSpentOfCeilingKeepsBothHalvesAtOnePrecision() {
        withLocale("fr_FR") {
            XCTAssertEqual(
                JunoCostFormatting.costOfCeiling(Decimal(string: "1.2")!, ceiling: Decimal(5)),
                "$1.20 of $5.00"
            )
            XCTAssertEqual(
                JunoCostFormatting.costOfCeiling(
                    spentMicroUSD: 1_200_000, ceilingMicroUSD: 5_000_000
                ),
                "$1.20 of $5.00"
            )
        }
    }
}
