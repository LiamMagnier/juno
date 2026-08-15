import XCTest
@testable import JunoDesignSystem

/// Structured-data detection and parsing.
///
/// Two properties get the most attention, because both fail silently and both
/// produce a confident, wrong picture: an absent cell must never become zero,
/// and an ordinary ```json fence must never become a chart.
final class JunoChartMarkupTests: XCTestCase {
    // MARK: - Absent is not zero

    func testBlankCellsAreAbsentRatherThanZero() {
        let table = JunoChartMarkup.table(
            delimited: "Month,Revenue\nJan,10\nFeb,\nMar,30"
        )
        XCTAssertEqual(table?.rows.map { $0.values[0] }, [10, nil, 30])
        XCTAssertEqual(table?.missingValueCount, 1)
    }

    func testPlaceholderMarkersAreAbsent() {
        for marker in ["-", "n/a", "N/A", "null", "TBD", "—", "?"] {
            guard let table = JunoChartMarkup.table(delimited: "K,V\na,1\nb,\(marker)"),
                let row = table.rows.last
            else { return XCTFail("\(marker) did not produce a table") }
            XCTAssertEqual(row.values, [nil], "\(marker) should read as absent")
            XCTAssertEqual(table.missingValueCount, 1, "\(marker) should count as missing")
        }
    }

    func testAnExplicitZeroIsStillZero() {
        // The rule is "absent is not zero", not "zero is suspicious".
        let table = JunoChartMarkup.table(delimited: "K,V\na,0")
        XCTAssertEqual(table?.rows.first?.values.first, 0)
        XCTAssertEqual(table?.missingValueCount, 0)
    }

    // MARK: - Cell parsing

    func testDecoratedNumbersParse() {
        XCTAssertEqual(JunoChartMarkup.numeric("$1200"), 1200)
        XCTAssertEqual(JunoChartMarkup.numeric("1,234.5"), 1234.5)
        XCTAssertEqual(JunoChartMarkup.numeric("42%"), 42)
        XCTAssertEqual(JunoChartMarkup.numeric("-7"), -7)
        XCTAssertEqual(JunoChartMarkup.numeric("1e3"), 1000)
    }

    func testParenthesisedNegativesKeepTheirSign() {
        // A spreadsheet export writes a loss as `(1,200)`. Reading it as 1200
        // inverts the sign of the number the chart is about.
        XCTAssertEqual(JunoChartMarkup.numeric("(1,200)"), -1200)
    }

    func testNonNumbersAreNil() {
        XCTAssertNil(JunoChartMarkup.numeric("high"))
        XCTAssertNil(JunoChartMarkup.numeric(""))
        XCTAssertNil(JunoChartMarkup.numeric("12 apples"))
    }

    // MARK: - CSV

    func testCSVColumnRoles() {
        let table = JunoChartMarkup.table(delimited: "Month,Revenue,Cost\nJan,10,4\nFeb,20,9")
        XCTAssertEqual(table?.categoryColumn, "Month")
        XCTAssertEqual(table?.valueColumns, ["Revenue", "Cost"])
        XCTAssertEqual(table?.rows.map(\.category), ["Jan", "Feb"])
        XCTAssertEqual(table?.rows.first?.values, [10, 4])
    }

    func testQuotedFieldsKeepTheirSeparators() {
        // A naive split turns `"Smith, J."` into two columns and shifts every
        // value after it into the wrong series.
        let table = JunoChartMarkup.table(delimited: "Name,Score\n\"Smith, J.\",\"1,200\"")
        XCTAssertEqual(table?.rows.first?.category, "Smith, J.")
        XCTAssertEqual(table?.rows.first?.values.first, 1200)
    }

    func testDoubledQuotesEscapeALiteralQuote() {
        let table = JunoChartMarkup.table(delimited: "Name,N\n\"a \"\"b\"\" c\",1")
        XCTAssertEqual(table?.rows.first?.category, "a \"b\" c")
    }

    func testTabSeparatedValuesAreDetected() {
        let table = JunoChartMarkup.table(delimited: "Region\tUnits\nEast\t5\nWest\t9")
        XCTAssertEqual(table?.categoryColumn, "Region")
        XCTAssertEqual(table?.rows.map { $0.values[0] }, [5, 9])
    }

    func testSemicolonSeparatedValuesAreDetected() {
        let table = JunoChartMarkup.table(delimited: "A;B\nx;1")
        XCTAssertEqual(table?.valueColumns, ["B"])
    }

    func testASingleColumnIsNotATable() {
        XCTAssertNil(JunoChartMarkup.table(delimited: "Value\n1\n2"))
    }

    func testHeaderOnlyIsNotATable() {
        XCTAssertNil(JunoChartMarkup.table(delimited: "A,B"))
    }

    // MARK: - Non-numeric columns

    func testColumnsWithNoNumbersAreNamedRatherThanForgotten() {
        // Silently dropping "Notes" tells the reader their data is fully
        // represented when it is not.
        let table = JunoChartMarkup.table(delimited: "Month,Revenue,Notes\nJan,10,good\nFeb,20,bad")
        XCTAssertEqual(table?.valueColumns, ["Revenue"])
        XCTAssertEqual(table?.ignoredColumns, ["Notes"])
    }

    func testAllNumericColumnsPutTheFirstOnTheCategoryAxis() {
        // A series of numbers still needs something on the x axis.
        let table = JunoChartMarkup.table(delimited: "Year,Value\n2020,5\n2021,8")
        XCTAssertEqual(table?.categoryColumn, "Year")
        XCTAssertEqual(table?.valueColumns, ["Value"])
    }

    // MARK: - JSON

    func testJSONArrayOfObjects() {
        let source = """
            [{"month": "Jan", "revenue": 10}, {"month": "Feb", "revenue": 20}]
            """
        let table = JunoChartMarkup.table(json: source)
        XCTAssertEqual(table?.categoryColumn, "month")
        XCTAssertEqual(table?.valueColumns, ["revenue"])
        XCTAssertEqual(table?.rows.map { $0.values[0] }, [10, 20])
    }

    func testJSONColumnOrderFollowsTheSourceTextNotTheDecoder() {
        // `JSONSerialization` returns an unordered dictionary; ordering by
        // anything it hands back would shuffle the legend between runs, and
        // sorting alphabetically would be stable and wrong.
        let source = """
            [{"zeta": 1, "alpha": 2, "label": "x"}]
            """
        XCTAssertEqual(JunoChartMarkup.table(json: source)?.valueColumns, ["zeta", "alpha"])
    }

    func testJSONNullsAreAbsent() {
        let source = """
            [{"k": "a", "v": 1}, {"k": "b", "v": null}]
            """
        let table = JunoChartMarkup.table(json: source)
        XCTAssertEqual(table?.rows.map { $0.values[0] }, [1, nil])
    }

    func testJSONKeysMissingFromTheFirstObjectAreStillOffered() {
        let source = """
            [{"k": "a", "v": 1}, {"k": "b", "v": 2, "w": 9}]
            """
        XCTAssertEqual(JunoChartMarkup.table(json: source)?.valueColumns.sorted(), ["v", "w"])
    }

    func testMalformedJSONIsNotATable() {
        XCTAssertNil(JunoChartMarkup.table(json: "[{\"a\": }]"))
    }

    // MARK: - Format sniffing

    func testStructuredSniffingPicksTheRightParser() {
        XCTAssertEqual(
            JunoChartMarkup.table(structured: "[{\"a\":\"x\",\"b\":1}]")?.categoryColumn,
            "a"
        )
        XCTAssertEqual(
            JunoChartMarkup.table(structured: "a,b\nx,1")?.categoryColumn,
            "a"
        )
        XCTAssertEqual(
            JunoChartMarkup.table(structured: "| a | b |\n| --- | --- |\n| x | 1 |")?
                .categoryColumn,
            "a"
        )
    }

    func testPipesWithoutADelimiterRowAreNotAPipeTable() {
        // Same rule as in prose: pipes alone are not a table.
        let table = JunoChartMarkup.table(structured: "| a | b |\n| x | 1 |")
        XCTAssertNotEqual(table?.categoryColumn, "a")
    }

    func testEmptyPayloadIsNotATable() {
        XCTAssertNil(JunoChartMarkup.table(structured: "   \n  "))
    }

    // MARK: - Opt-in detection

    func testPlainDataFencesAreNotCharts() {
        // The load-bearing refusal. A ```json fence in an answer about an API
        // response must stay code.
        XCTAssertFalse(JunoChartMarkup.isChartFence(info: "json"))
        XCTAssertFalse(JunoChartMarkup.isChartFence(info: "csv"))
        XCTAssertFalse(JunoChartMarkup.isChartFence(info: "swift"))
        XCTAssertFalse(JunoChartMarkup.isChartFence(info: nil))
        XCTAssertNil(JunoChartMarkup.data(fenceInfo: "json", source: "[{\"a\":\"x\",\"b\":1}]"))
    }

    func testChartFenceOptsIn() {
        XCTAssertTrue(JunoChartMarkup.isChartFence(info: "chart"))
        XCTAssertTrue(JunoChartMarkup.isChartFence(info: "chart type=bar"))
    }

    func testDataFenceWithAChartDirectiveOptsIn() {
        XCTAssertTrue(JunoChartMarkup.isChartFence(info: "csv chart=line"))
        XCTAssertTrue(JunoChartMarkup.isChartFence(info: "json type=pie"))
    }

    // MARK: - Directives

    func testDirectiveParsesKindAndTitle() {
        let directive = JunoChartMarkup.directive("chart type=line title=\"Revenue by month\"")
        XCTAssertEqual(directive?.format, "chart")
        XCTAssertEqual(directive?.kind, .line)
        XCTAssertEqual(directive?.title, "Revenue by month")
    }

    func testChartKindAliases() {
        XCTAssertEqual(JunoChartKind(directiveValue: "pie"), .sector)
        XCTAssertEqual(JunoChartKind(directiveValue: "scatter"), .point)
        XCTAssertEqual(JunoChartKind(directiveValue: "column"), .bar)
        XCTAssertNil(JunoChartKind(directiveValue: "sankey"))
    }

    func testUnknownDirectiveKeysAreIgnoredRatherThanFatal() {
        let directive = JunoChartMarkup.directive("chart stacked=true type=bar")
        XCTAssertEqual(directive?.kind, .bar)
    }

    func testUnknownChartTypeFallsBackToTheDefaultRatherThanRefusing() {
        let data = JunoChartMarkup.data(
            fenceInfo: "chart type=sankey",
            source: "Region,Units\nEast,5\nWest,9"
        )
        XCTAssertEqual(data?.kind, .bar)
    }

    // MARK: - Whole-fence path

    func testFencePathProducesAChart() {
        let data = JunoChartMarkup.data(
            fenceInfo: "chart type=bar title=Sales",
            source: "Region,Units\nEast,5\nWest,9"
        )
        XCTAssertEqual(data?.kind, .bar)
        XCTAssertEqual(data?.title, "Sales")
        XCTAssertEqual(data?.table.rows.count, 2)
    }

    func testDefaultKindIsALineForAnOrderedNumericAxis() {
        let data = JunoChartMarkup.data(fenceInfo: "chart", source: "Year,Value\n2020,5\n2021,8")
        XCTAssertEqual(data?.kind, .line)
    }

    func testDefaultKindIsABarForNamedCategories() {
        let data = JunoChartMarkup.data(fenceInfo: "chart", source: "Region,Units\nEast,5\nWest,9")
        XCTAssertEqual(data?.kind, .bar)
    }

    func testATableWithNothingPlottableIsNotAChart() {
        // Showing the source beats drawing an empty axis pair.
        XCTAssertNil(JunoChartMarkup.data(fenceInfo: "chart", source: "A,B\nx,y\nz,w"))
        XCTAssertNil(JunoChartMarkup.data(fenceInfo: "chart", source: "not data at all"))
    }

    func testSectorChartsDrawOneSeriesAndNameTheRest() {
        // A pie has one whole to divide. Summing the second series into it would
        // produce a meaningless total that still looks like a chart.
        let data = JunoChartMarkup.data(
            fenceInfo: "chart type=pie",
            source: "Region,Units,Cost\nEast,5,2\nWest,9,3"
        )
        XCTAssertEqual(data?.chartedColumns, ["Units"])
        XCTAssertEqual(data?.undrawnColumns, ["Cost"])
    }

    func testBarChartsDrawEverySeries() {
        let data = JunoChartMarkup.data(
            fenceInfo: "chart type=bar",
            source: "Region,Units,Cost\nEast,5,2\nWest,9,3"
        )
        XCTAssertEqual(data?.chartedColumns, ["Units", "Cost"])
        XCTAssertEqual(data?.undrawnColumns, [])
    }

    // MARK: - Streaming

    func testEveryPrefixOfAChartFenceIsSafeToParse() {
        // The renderer waits for the fence to close, but the parser is still
        // called on partial payloads by anything that asks early.
        let payload = "Month,Revenue\nJan,10\nFeb,20\nMar,"
        for length in 0...payload.count {
            let prefix = String(payload.prefix(length))
            _ = JunoChartMarkup.table(structured: prefix)
            _ = JunoChartMarkup.data(fenceInfo: "chart", source: prefix)
        }
    }

    func testLabelFormatting() {
        XCTAssertEqual(JunoChartMarkup.label(for: 12), "12")
        XCTAssertEqual(JunoChartMarkup.label(for: -3), "-3")
        XCTAssertEqual(JunoChartMarkup.label(for: 1.5), "1.50")
    }
}
