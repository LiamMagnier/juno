import XCTest
@testable import JunoDesignSystem

final class JunoMarkdownTests: XCTestCase {
    // MARK: - Paragraphs

    func testConsecutiveLinesJoinIntoOneParagraph() {
        let blocks = JunoMarkdown.blocks(from: "first line\nsecond line")
        XCTAssertEqual(blocks, [.paragraph("first line\nsecond line")])
    }

    func testBlankLineSeparatesParagraphs() {
        let blocks = JunoMarkdown.blocks(from: "one\n\ntwo")
        XCTAssertEqual(blocks, [.paragraph("one"), .paragraph("two")])
    }

    func testEmptySourceProducesNoBlocks() {
        XCTAssertTrue(JunoMarkdown.blocks(from: "").isEmpty)
        XCTAssertTrue(JunoMarkdown.blocks(from: "\n\n  \n").isEmpty)
    }

    // MARK: - Headings

    func testHeadingLevels() {
        let blocks = JunoMarkdown.blocks(from: "# One\n\n### Three\n\n###### Six")
        XCTAssertEqual(
            blocks,
            [
                .heading(level: 1, text: "One"),
                .heading(level: 3, text: "Three"),
                .heading(level: 6, text: "Six"),
            ]
        )
    }

    func testSevenHashesIsNotAHeading() {
        let blocks = JunoMarkdown.blocks(from: "####### too deep")
        XCTAssertEqual(blocks, [.paragraph("####### too deep")])
    }

    func testHashWithoutSpaceIsNotAHeading() {
        // Otherwise every "#swift" mention becomes an H1.
        let blocks = JunoMarkdown.blocks(from: "#hashtag")
        XCTAssertEqual(blocks, [.paragraph("#hashtag")])
    }

    // MARK: - Code

    func testFencedCodeKeepsIndentationAndLanguage() {
        let source = "```swift\nlet x = 1\n    let y = 2\n```"
        XCTAssertEqual(
            JunoMarkdown.blocks(from: source),
            [.code(language: "swift", source: "let x = 1\n    let y = 2", isClosed: true)]
        )
    }

    func testFenceWithoutLanguage() {
        XCTAssertEqual(
            JunoMarkdown.blocks(from: "```\nplain\n```"),
            [.code(language: nil, source: "plain", isClosed: true)]
        )
    }

    func testUnterminatedFenceStillRenders() {
        // The streaming case: the closing fence has not arrived yet.
        XCTAssertEqual(
            JunoMarkdown.blocks(from: "```python\nprint(1)"),
            [.code(language: "python", source: "print(1)", isClosed: false)]
        )
    }

    func testShorterInnerFenceDoesNotCloseALongerFence() {
        let source = "````\n```\nnested\n```\n````"
        XCTAssertEqual(
            JunoMarkdown.blocks(from: source),
            [.code(language: nil, source: "```\nnested\n```", isClosed: true)]
        )
    }

    func testTildeFenceIsNotClosedByBackticks() {
        let source = "~~~\n```\n~~~"
        XCTAssertEqual(
            JunoMarkdown.blocks(from: source),
            [.code(language: nil, source: "```", isClosed: true)]
        )
    }

    func testMarkdownInsideCodeIsNotParsed() {
        let source = "```\n# not a heading\n- not a list\n```"
        XCTAssertEqual(
            JunoMarkdown.blocks(from: source),
            [.code(language: nil, source: "# not a heading\n- not a list", isClosed: true)]
        )
    }

    // MARK: - Lists

    func testUnorderedListCollectsConsecutiveItems() {
        let blocks = JunoMarkdown.blocks(from: "- one\n- two\n* three")
        XCTAssertEqual(
            blocks,
            [
                .list(
                    ordered: false,
                    start: 1,
                    items: [
                        .init(text: "one", depth: 0),
                        .init(text: "two", depth: 0),
                        .init(text: "three", depth: 0),
                    ]
                )
            ]
        )
    }

    func testOrderedListPreservesItsStartNumber() {
        let blocks = JunoMarkdown.blocks(from: "3. three\n4. four")
        XCTAssertEqual(
            blocks,
            [
                .list(
                    ordered: true,
                    start: 3,
                    items: [.init(text: "three", depth: 0), .init(text: "four", depth: 0)]
                )
            ]
        )
    }

    func testSwitchingListKindStartsANewBlock() {
        // Merging them would renumber the ordered items from the bullet run.
        let blocks = JunoMarkdown.blocks(from: "- bullet\n1. number")
        XCTAssertEqual(blocks.count, 2)
        guard case .list(let firstOrdered, _, _) = blocks[0],
            case .list(let secondOrdered, _, _) = blocks[1]
        else { return XCTFail("expected two list blocks, got \(blocks)") }
        XCTAssertFalse(firstOrdered)
        XCTAssertTrue(secondOrdered)
    }

    func testNestedItemsCarryDepth() {
        let blocks = JunoMarkdown.blocks(from: "- top\n  - nested\n    - deeper")
        guard case .list(_, _, let items) = blocks.first else {
            return XCTFail("expected a list, got \(blocks)")
        }
        XCTAssertEqual(items.map(\.depth), [0, 1, 2])
    }

    func testTaskListItemsCarryTheirCheckedState() {
        let blocks = JunoMarkdown.blocks(from: "- [ ] todo\n- [x] done\n- plain")
        guard case .list(_, _, let items) = blocks.first else {
            return XCTFail("expected a list, got \(blocks)")
        }
        XCTAssertEqual(items.map(\.isChecked), [false, true, nil])
        XCTAssertEqual(items.map(\.text), ["todo", "done", "plain"])
    }

    func testDashWithoutSpaceIsNotAListItem() {
        XCTAssertEqual(
            JunoMarkdown.blocks(from: "-notalist"),
            [.paragraph("-notalist")]
        )
    }

    // MARK: - Tables

    func testTableWithDelimiterRow() {
        let source = """
            | Name | Count |
            | --- | ---: |
            | apples | 3 |
            | pears | 12 |
            """
        XCTAssertEqual(
            JunoMarkdown.blocks(from: source),
            [
                .table(
                    header: ["Name", "Count"],
                    rows: [["apples", "3"], ["pears", "12"]]
                )
            ]
        )
    }

    func testPipesWithoutADelimiterRowStayProse() {
        let source = "a | b\nc | d"
        XCTAssertEqual(JunoMarkdown.blocks(from: source), [.paragraph("a | b\nc | d")])
    }

    func testTableEndsAtABlankLine() {
        let source = "| a |\n| --- |\n| 1 |\n\nafter"
        let blocks = JunoMarkdown.blocks(from: source)
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(blocks.last, .paragraph("after"))
    }

    // MARK: - Quotes and rules

    func testQuoteStripsItsMarker() {
        XCTAssertEqual(
            JunoMarkdown.blocks(from: "> quoted\n> lines"),
            [.quote("quoted\nlines")]
        )
    }

    func testThematicBreakVariants() {
        for rule in ["---", "***", "___", "- - -"] {
            XCTAssertEqual(
                JunoMarkdown.blocks(from: rule),
                [.thematicBreak],
                "\(rule) should be a thematic break"
            )
        }
    }

    // MARK: - Totality

    func testEveryLineOfAMixedDocumentIsAccountedFor() {
        let source = """
            # Title

            Intro paragraph.

            - one
            - two

            ```swift
            let x = 1
            ```

            | a | b |
            | --- | --- |
            | 1 | 2 |

            > note

            ---

            Closing.
            """
        let blocks = JunoMarkdown.blocks(from: source)
        XCTAssertEqual(blocks.count, 8)
        XCTAssertEqual(blocks.first, .heading(level: 1, text: "Title"))
        XCTAssertEqual(blocks.last, .paragraph("Closing."))
    }

    func testStreamingPrefixesNeverCrashAndNeverLoseTrailingText() {
        // Every prefix of a real answer must render, because the UI re-parses on
        // each streamed chunk.
        let full = """
            Here is a table:

            | a | b |
            | --- | --- |
            | 1 | 2 |

            And code:

            ```swift
            let value = 1
            ```
            """
        for length in 1...full.count {
            let prefix = String(full.prefix(length))
            let blocks = JunoMarkdown.blocks(from: prefix)
            if prefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                XCTAssertTrue(blocks.isEmpty, "prefix of length \(length)")
            } else {
                XCTAssertFalse(blocks.isEmpty, "prefix of length \(length) produced no blocks")
            }
        }
    }
}
