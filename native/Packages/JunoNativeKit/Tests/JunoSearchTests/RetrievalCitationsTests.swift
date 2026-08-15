import Foundation
import XCTest

@testable import JunoSearch

/// A fabricated `[n]` is more damaging than no citation at all: it renders as a
/// verified link and nothing about it looks wrong. These tests are the guard.
final class RetrievalCitationsTests: XCTestCase {
    // MARK: - Never fabricate

    func testAMarkerWithNoSourceBehindItIsRemoved() {
        var registry = CitationRegistry()
        registry.register(
            title: "Refund policy",
            url: URL(string: "https://example.com/refunds"),
            locator: "example.com",
            snippet: "Refunds within 14 days."
        )

        let answer = "Refunds take 14 days [1], and shipping is free [4]."

        XCTAssertEqual(
            registry.sanitized(answer),
            "Refunds take 14 days [1], and shipping is free ."
        )
    }

    /// Renumbering a bad marker to the nearest real source is a worse lie than
    /// dropping it: the sentence would then claim a document that does not
    /// support it.
    func testABadMarkerIsDroppedRatherThanReassigned() {
        var registry = CitationRegistry()
        registry.register(title: "A", url: nil, locator: "a.pdf", snippet: "")
        registry.register(title: "B", url: nil, locator: "b.pdf", snippet: "")

        let sanitized = registry.sanitized("Claim one [3]. Claim two [2].")

        XCTAssertEqual(sanitized, "Claim one . Claim two [2].")
        XCTAssertFalse(sanitized.contains("[3]"))
        XCTAssertFalse(sanitized.contains("[1]"), "nothing may be reassigned to source 1")
    }

    func testMarkersBecomeClickableOnlyWhenTheSourceHasAURL() {
        var registry = CitationRegistry()
        registry.register(
            title: "Web page",
            url: URL(string: "https://example.com/a"),
            locator: "example.com",
            snippet: ""
        )
        // A local document has nothing to link to, and a synthesized file:// URL
        // would render as a link the reader cannot open.
        registry.register(title: "Report.pdf", url: nil, locator: "Report.pdf, page 2", snippet: "")

        let rendered = registry.rendered("Online [1] and offline [2].")

        XCTAssertEqual(rendered, "Online [[1](https://example.com/a)] and offline [2].")
    }

    /// Order matters: linking first would turn a fabricated `[9]` into a link
    /// before anything checked whether 9 exists.
    func testRenderingSanitizesBeforeItLinks() {
        var registry = CitationRegistry()
        registry.register(
            title: "Only source",
            url: URL(string: "https://example.com"),
            locator: "example.com",
            snippet: ""
        )

        let rendered = registry.rendered("Real [1], invented [9].")

        XCTAssertEqual(rendered, "Real [[1](https://example.com)], invented .")
    }

    // MARK: - Things that look like markers but are not

    /// `array[0]` and `sed -n [1]p` are not citations, and rewriting them
    /// corrupts a code sample the reader is meant to copy.
    func testMarkersInsideFencedCodeAreLeftAlone() {
        var registry = CitationRegistry()
        registry.register(
            title: "Docs",
            url: URL(string: "https://example.com"),
            locator: "example.com",
            snippet: ""
        )

        let markdown = """
        Prose citing [1].

        ```swift
        let value = items[1]
        ```

        More prose [1].
        """

        let rendered = registry.rendered(markdown)

        XCTAssertTrue(rendered.contains("let value = items[1]"))
        XCTAssertEqual(
            rendered.components(separatedBy: "[[1](https://example.com)]").count - 1,
            2
        )
    }

    /// Running the renderer twice must not produce `[[[1](u)](u)]`.
    func testAlreadyLinkedMarkersAreNotRewrittenAgain() {
        var registry = CitationRegistry()
        registry.register(
            title: "Docs",
            url: URL(string: "https://example.com"),
            locator: "example.com",
            snippet: ""
        )

        let once = registry.rendered("Cited [1].")
        XCTAssertEqual(registry.rendered(once), once)
    }

    // MARK: - Numbering

    /// The same page cited from three passages is one source, not three, or the
    /// reference list reads as three times the research that happened.
    func testTheSameSourceKeepsOneNumberEvenAcrossFragments() {
        var registry = CitationRegistry()
        let first = registry.register(
            title: "Page",
            url: URL(string: "https://example.com/doc#intro"),
            locator: "example.com",
            snippet: ""
        )
        let second = registry.register(
            title: "Page",
            url: URL(string: "https://example.com/doc#appendix"),
            locator: "example.com",
            snippet: ""
        )

        XCTAssertEqual(first, second)
        XCTAssertEqual(registry.count, 1)
    }

    func testNumbersAreOneBasedAndInRegistrationOrder() {
        var registry = CitationRegistry()
        XCTAssertEqual(registry.register(title: "A", url: nil, locator: "a", snippet: ""), 1)
        XCTAssertEqual(registry.register(title: "B", url: nil, locator: "b", snippet: ""), 2)
        XCTAssertEqual(registry.citation(number: 2)?.title, "B")
        XCTAssertNil(registry.citation(number: 0))
        XCTAssertNil(registry.citation(number: 3))
    }

    /// An empty "Sources" heading reads as "sources were consulted and none are
    /// shown", which is a different claim from "none were consulted".
    func testAnEmptyRegistryProducesNoReferenceListAtAll() {
        XCTAssertNil(CitationRegistry().referenceList())
    }

    func testCitedNumbersReportsOnlyRealReferences() {
        var registry = CitationRegistry()
        registry.register(title: "A", url: nil, locator: "a", snippet: "")
        registry.register(title: "B", url: nil, locator: "b", snippet: "")

        XCTAssertEqual(registry.citedNumbers(in: "Only [2] here, plus a bogus [8]."), [2])
    }

    // MARK: - Prompt block

    /// The mechanism itself: the model is shown `[n] locator` next to the text
    /// it may cite as `[n]`, and the registry it is checked against afterwards
    /// is the one that produced those numbers.
    func testThePromptBlockNumbersMatchTheRegistryItReturns() {
        let passages = [
            passage("a", "Refunds are issued within 14 days.", source: "policy.pdf", page: 3),
            passage("b", "Shipping is free above $50.", source: "shipping.md", page: nil),
        ]

        let block = RetrievedContextPrompt.block(for: passages)

        XCTAssertTrue(block.text.contains("[1] policy.pdf, page 3"))
        XCTAssertTrue(block.text.contains("[2] shipping.md"))
        XCTAssertEqual(block.registry.count, 2)
        XCTAssertEqual(block.registry.citation(number: 1)?.locator, "policy.pdf, page 3")
        XCTAssertEqual(block.omittedPassageCount, 0)

        // And the round trip a caller performs: whatever the model writes is
        // checked against exactly this registry.
        XCTAssertEqual(
            block.registry.sanitized("A [1] B [2] C [3]"),
            "A [1] B [2] C "
        )
    }

    /// Exceeding the context window turns a good answer into a hard failure, so
    /// the budget is enforced — and the fact that it was is reported rather than
    /// swallowed.
    func testTheBudgetTruncatesAndReportsWhatItDropped() {
        let passages = (1 ... 5).map {
            passage("chunk-\($0)", String(repeating: "word ", count: 50), source: "doc.md")
        }

        let block = RetrievedContextPrompt.block(for: passages, characterBudget: 300)

        XCTAssertGreaterThan(block.omittedPassageCount, 0)
        XCTAssertLessThan(block.registry.count, passages.count)
    }

    func testNoPassagesProducesNoBlockAndNoCitations() {
        let block = RetrievedContextPrompt.block(for: [])
        XCTAssertTrue(block.text.isEmpty)
        XCTAssertTrue(block.registry.isEmpty)
    }

    // MARK: - Helpers

    private func passage(
        _ id: String,
        _ text: String,
        source: String,
        page: Int? = nil
    ) -> RetrievedPassage {
        RetrievedPassage(
            chunk: RetrievableChunk(
                id: id,
                sourceName: source,
                text: text,
                pageNumber: page
            ),
            score: 1,
            lexicalScore: 1,
            semanticScore: nil
        )
    }
}
