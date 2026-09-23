import Foundation
import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// The reading style's pure parts: the highlighter, find, citations, inline
/// code and the table's column arithmetic.
final class JunoProseTests: XCTestCase {
    // MARK: Syntax

    func testSwiftIsClassifiedIntoTheFourColours() {
        let source = """
        // cache
        let limit = 42
        func name() -> String { "juno" }
        """
        let tokens = JunoSyntaxHighlighter.tokens(in: source, language: "swift")
        let classified = tokens.map { (String(source[$0.0]), $0.1) }
        XCTAssertEqual(classified.first?.0, "// cache")
        XCTAssertEqual(classified.first?.1, .comment)
        XCTAssertTrue(classified.contains { $0 == ("let", .keyword) })
        XCTAssertTrue(classified.contains { $0 == ("42", .number) })
        XCTAssertTrue(classified.contains { $0 == ("func", .keyword) })
        XCTAssertTrue(classified.contains { $0 == ("\"juno\"", .string) })
        XCTAssertFalse(classified.contains { $0.0 == "limit" }, "identifiers stay plain")
    }

    func testShellCommentsNeedAWordBoundaryAndPlainTextIsLeftAlone() {
        let shell = "echo ${#items} # count"
        let tokens = JunoSyntaxHighlighter.tokens(in: shell, language: "bash")
        XCTAssertEqual(tokens.filter { $0.1 == .comment }.map { String(shell[$0.0]) }, ["# count"])
        XCTAssertTrue(JunoSyntaxHighlighter.tokens(in: "let x = 1", language: "text").isEmpty)
        // One string for the whole listing: selection runs across lines.
        let highlighted = JunoSyntaxHighlighter.highlighted("a\nb", language: "swift")
        XCTAssertEqual(String(highlighted.characters), "a\nb")
    }

    // MARK: Find

    func testFindIgnoresCaseAndDiacriticsAndNeverOverlaps() {
        XCTAssertEqual(JunoFindText.count(of: "cafe", in: "Café, CAFE and café"), 3)
        XCTAssertEqual(JunoFindText.count(of: "aa", in: "aaaa"), 2)
        XCTAssertEqual(JunoFindText.count(of: "  ", in: "a b"), 0, "a blank query finds nothing")
    }

    func testTheCurrentMatchIsTheStrongerRun() {
        let highlighted = JunoFindText.highlighted(
            "one two one",
            with: JunoFindHighlight(query: "one", current: 1)
        )
        let runs = highlighted.runs.compactMap { run -> (String, Bool)? in
            guard run.backgroundColor != nil else { return nil }
            return (String(highlighted[run.range].characters), true)
        }
        XCTAssertEqual(runs.map(\.0), ["one", "one"])
        XCTAssertEqual(JunoFindHighlight(query: "x", current: nil).shifted(by: 3).base, 3)
    }

    /// Counting walks what is drawn: code blocks count, a closed diagram does
    /// not, and inline Markdown is resolved first.
    func testMarkdownIsCountedAsDrawn() {
        let source = """
        A **readme** is read.

        ```swift
        let readme = true
        ```

        ```mermaid
        graph TD; readme-->done
        ```
        """
        XCTAssertEqual(JunoFindText.count(of: "readme", inMarkdown: source), 2)
    }

    // MARK: Citations and inline code

    func testOnlyNumberedCitationsInRangeBecomeChips() {
        let rewritten = JunoProseInline.rewritingCitations("Rose [1][2], fell [7], see [docs](https://x.dev) and [2](y).", citations: 2)
        XCTAssertEqual(
            rewritten,
            "Rose [1](juno-cite://1)[2](juno-cite://2), fell [7], see [docs](https://x.dev) and [2](y)."
        )
        XCTAssertEqual(JunoProseInline.rewritingCitations("Rose [1].", citations: 0), "Rose [1].")
        XCTAssertEqual(JunoProseInline.citationNumber(URL(string: "juno-cite://3")!), 3)
        XCTAssertNil(JunoProseInline.citationNumber(URL(string: "https://3.dev")!))
    }

    func testInlineCodeSitsInItsOwnPaddedRun() {
        let styled = JunoProseInline.styled("Use `swift test` now", baseSize: 16, scale: 1, citations: 0)
        XCTAssertEqual(String(styled.characters), "Use \u{202F}swift test\u{202F} now")
        XCTAssertTrue(styled.runs.contains { $0.backgroundColor != nil })
    }

    // MARK: Tables

    func testColumnsFillTheMeasureShrinkThenScroll() {
        // Everything fits: the slack is shared out and the table fills.
        let fits = JunoProseTableLayout.columnWidths(natural: [100, 200], available: 600, floor: 120)
        XCTAssertEqual(fits.reduce(0, +), 600, accuracy: 1)
        XCTAssertGreaterThan(fits[1], fits[0])

        // Too wide: the wide column wraps down toward its floor; the narrow
        // one keeps its width.
        let shrinks = JunoProseTableLayout.columnWidths(natural: [80, 900], available: 600, floor: 120)
        XCTAssertEqual(shrinks[0], 80)
        XCTAssertEqual(shrinks.reduce(0, +), 600, accuracy: 1)

        // Even the floors do not fit: the table keeps them and scrolls.
        let scrolls = JunoProseTableLayout.columnWidths(natural: Array(repeating: 300, count: 8), available: 600, floor: 120)
        XCTAssertEqual(scrolls, Array(repeating: 120, count: 8))
    }

    @MainActor
    func testTheMeasureIsSeventyFiveCharacters() {
        let measure = JunoProseMetrics.measure(scale: 1)
        XCTAssertGreaterThan(measure, 560)
        XCTAssertLessThan(measure, 768)
        XCTAssertEqual(JunoProseMetrics.headingSize(level: 1), 24)
        XCTAssertEqual(JunoProseMetrics.headingSize(level: 2), 20.8, accuracy: 0.01)
        XCTAssertEqual(JunoProseMetrics.headingSize(level: 3), 17.92, accuracy: 0.01)
        XCTAssertEqual(JunoProseMetrics.blockGap, 13.6, accuracy: 0.01)
    }
}
