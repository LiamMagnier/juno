import XCTest
@testable import JunoDesignSystem

/// Pins the native learning-block parser to the website's own behaviour.
///
/// These are the same cases as `tests/learning-blocks.test.ts`, assertion for
/// assertion. The reason for the duplication is that the two clients disagreeing
/// here is INVISIBLE: the website would draw a five-step timeline and the phone a
/// four-step one, both confidently, and nothing would report the difference.
///
/// The contract both sides defend: be forgiving enough that a stray tab or a
/// missing quote does not cost the reader the lesson, and strict enough that a
/// block which cannot teach anything — a quiz with no right answer, a comparison
/// with one column — is refused rather than drawn.
final class JunoLearningBlocksTests: XCTestCase {

    private func parse(
        _ kind: JunoLearningBlocks.Kind,
        _ body: String
    ) -> (payload: JunoLearningBlocks.Payload?, error: String?) {
        JunoLearningBlocks.parse(kind: kind, source: body, seed: "test")
    }

    // MARK: - The YAML subset

    func testScalarsAreTypedAndAQuotedCommaDoesNotSplitAFlowList() {
        let value = JunoYAMLSubset.parse(
            ["count: 3", "ratio: -0.5", "flag: true", "blank: null", #"items: ["a, b", c]"#]
                .joined(separator: "\n")
        )
        XCTAssertEqual(
            value,
            .mapping([
                "count": .number(3),
                "ratio": .number(-0.5),
                "flag": .bool(true),
                "blank": .null,
                "items": .array([.string("a, b"), .string("c")]),
            ])
        )
    }

    func testCommentsAndBlankLinesAreDroppedAndTabsCountAsTwoSpaces() {
        let value = JunoYAMLSubset.parse(["# a note", "", "root:", "\tchild: yes"].joined(separator: "\n"))
        XCTAssertEqual(value, .mapping(["root": .mapping(["child": .string("yes")])]))
    }

    func testASequenceOfRecordsReadsItsInlineKeyPlusTheIndentedRest() {
        let value = JunoYAMLSubset.parse(
            ["steps:", "  - label: Tokenize", "    description: Split the text", "  - label: Embed"]
                .joined(separator: "\n")
        )
        XCTAssertEqual(
            value,
            .mapping([
                "steps": .array([
                    .mapping(["label": .string("Tokenize"), "description": .string("Split the text")]),
                    .mapping(["label": .string("Embed")]),
                ])
            ])
        )
    }

    /// "Note this" is not an identifier, so the line is skipped rather than
    /// becoming a key — otherwise every sentence with a colon would be a field.
    func testAProseLineWithAColonIsNotData() {
        let value = JunoYAMLSubset.parse(["title: Real", "Note this: not a field"].joined(separator: "\n"))
        XCTAssertEqual(value, .mapping(["title": .string("Real")]))
    }

    // MARK: - Learning card

    func testLearningCardToneIconAndContent() {
        let result = parse(.learningCard, "title: Caching\ntone: tip\nicon: 💡\ncontent: Cache the read path.")
        XCTAssertNil(result.error)
        XCTAssertEqual(
            result.payload,
            .learningCard(
                JunoLearningBlocks.Card(
                    title: "Caching", icon: "💡", tone: .tip, content: "Cache the read path."
                )
            )
        )
    }

    func testUnknownToneBecomesInsightAndTheTitleHasADefault() {
        let result = parse(.learningCard, "tone: spicy\ncontent: Something true.")
        XCTAssertEqual(
            result.payload,
            .learningCard(
                JunoLearningBlocks.Card(
                    title: "Core idea", icon: nil, tone: .insight, content: "Something true."
                )
            )
        )
    }

    func testACardWithNoContentIsARefusalNotAnEmptyCard() {
        let result = parse(.learningCard, "title: Nothing here")
        XCTAssertNil(result.payload)
        XCTAssertEqual(result.error, "Learning card needs `content`.")
    }

    // MARK: - Process timeline

    func testTimelineStepsKeepTheirOrderAndAcceptLabelAliases() {
        let result = parse(
            .processTimeline,
            ["title: Request", "steps:", "  - label: Receive", "    description: Parse it",
             "  - title: Route", "  - name: Answer"].joined(separator: "\n")
        )
        XCTAssertEqual(
            result.payload,
            .processTimeline(
                JunoLearningBlocks.Timeline(
                    title: "Request",
                    steps: [
                        .init(id: 0, label: "Receive", description: "Parse it"),
                        .init(id: 1, label: "Route", description: nil),
                        .init(id: 2, label: "Answer", description: nil),
                    ]
                )
            )
        )
    }

    func testOneStepIsNotAProcess() {
        let result = parse(.processTimeline, "steps:\n  - label: Only")
        XCTAssertNil(result.payload)
        XCTAssertEqual(result.error, "Process timeline needs at least two steps with labels.")
    }

    // MARK: - Comparison

    func testComparisonColumnsRowsAndVerdict() {
        let result = parse(
            .comparison,
            ["columns: [Postgres, SQLite]", "rows:", "  - label: Concurrency",
             "    values: [High, Single writer]", "verdict: Postgres, for this workload."]
                .joined(separator: "\n")
        )
        XCTAssertEqual(
            result.payload,
            .comparison(
                JunoLearningBlocks.Comparison(
                    title: nil,
                    columns: ["Postgres", "SQLite"],
                    rows: [.init(id: 0, label: "Concurrency", values: ["High", "Single writer"])],
                    verdict: "Postgres, for this workload."
                )
            )
        )
    }

    func testOneColumnIsAListNotAComparison() {
        let result = parse(.comparison, "columns: [Only]\nrows:\n  - label: A\n    values: [x]")
        XCTAssertNil(result.payload)
        XCTAssertEqual(result.error, "Comparison needs 2+ columns and at least one row with values.")
    }

    // MARK: - Quiz

    func testLegacySingleQuestionShapeWithStringOptionsAndAnswerKey() {
        let result = parse(
            .quiz,
            ["question: Which is idempotent?", "options: [POST, PUT]", "answer: PUT"]
                .joined(separator: "\n")
        )
        XCTAssertEqual(
            result.payload,
            .quiz(
                JunoLearningBlocks.Quiz(
                    title: nil,
                    questions: [
                        .init(
                            id: 0,
                            question: "Which is idempotent?",
                            options: [
                                .init(id: 0, label: "POST", correct: false, explanation: nil),
                                .init(id: 1, label: "PUT", correct: true, explanation: nil),
                            ],
                            explanation: nil,
                            hint: nil
                        )
                    ]
                )
            )
        )
    }

    func testMultiQuestionShapeKeepsItsOwnTitle() {
        let result = parse(
            .quiz,
            [
                "title: HTTP",
                "questions:",
                "  - question: Which is safe?",
                "    options:",
                "      - label: GET",
                "        correct: true",
                "      - label: DELETE",
                "  - question: Which creates?",
                "    options:",
                "      - label: POST",
                "        correct: true",
                "      - label: HEAD",
            ].joined(separator: "\n")
        )
        guard case .quiz(let quiz)? = result.payload else {
            return XCTFail("expected a quiz payload, got \(String(describing: result.payload))")
        }
        XCTAssertEqual(quiz.title, "HTTP")
        XCTAssertEqual(quiz.questions.count, 2)
        XCTAssertEqual(quiz.questions.map { $0.options.firstIndex(where: \.correct) }, [0, 0])
    }

    func testAQuestionNobodyCanPassIsRefused() {
        let result = parse(.quiz, "question: Pick one\noptions: [A, B]")
        XCTAssertNil(result.payload)
        XCTAssertEqual(result.error, "Quiz needs a question with 2+ options and a correct answer.")
    }

    // MARK: - Deep dive

    func testDeepDiveSummaryDefaultsToTheTitle() {
        let result = parse(.deepDive, "title: Vacuum\ncontent: One.\ndetail: ignored")
        XCTAssertEqual(
            result.payload,
            .deepDive(
                JunoLearningBlocks.DeepDive(title: "Vacuum", summary: "Vacuum", content: "One.")
            )
        )
    }

    func testATitleWithNoContentIsRefused() {
        let result = parse(.deepDive, "title: Alone")
        XCTAssertNil(result.payload)
        XCTAssertEqual(result.error, "Deep dive needs `title` and `content`.")
    }

    // MARK: - Scanning a reply

    func testBlocksAreFoundInOrderWithTheProseBetweenThemIntact() {
        let text = [
            "Before.",
            ":::learning-card",
            "content: First idea.",
            ":::",
            "Between.",
            ":::deep-dive",
            "title: More",
            "content: Detail.",
            ":::",
            "After.",
        ].joined(separator: "\n")
        let blocks = JunoLearningBlocks.blocks(in: text)
        XCTAssertEqual(blocks.map(\.kind), [.learningCard, .deepDive])
        XCTAssertEqual(slice(text, 0, blocks[0].start), "Before.\n")
        XCTAssertEqual(slice(text, blocks[0].end, blocks[1].start), "Between.\n")
        XCTAssertEqual(slice(text, blocks[1].end, (text as NSString).length), "After.")
    }

    func testABlockInsideACodeFenceIsSourceNotALesson() {
        let text = ["```md", ":::quiz", "question: no", ":::", "```"].joined(separator: "\n")
        XCTAssertEqual(JunoLearningBlocks.blocks(in: text).count, 0)
    }

    func testAnUnclosedTrailingBlockIsStreamingAndIsNotParsed() {
        let text = [":::quiz", "question: Which is safe?"].joined(separator: "\n")
        let blocks = JunoLearningBlocks.blocks(in: text)
        XCTAssertEqual(blocks.count, 1)
        XCTAssertTrue(blocks[0].streaming)
        XCTAssertNil(blocks[0].payload)
        XCTAssertEqual(blocks[0].kind, .quiz)
    }

    func testSalvagingACutOffBlockParsesWhatArrivedAndSaysItWasCut() {
        let text = [":::learning-card", "content: Half a thought."].joined(separator: "\n")
        let salvaged = JunoLearningBlocks.salvage(JunoLearningBlocks.blocks(in: text)[0])
        XCTAssertFalse(salvaged.streaming)
        XCTAssertEqual(salvaged.error, "This block was cut off mid-stream.")
        XCTAssertEqual(salvaged.payload?.kind, .learningCard)
    }

    func testAnUnknownKindIsLeftAlone() {
        XCTAssertEqual(JunoLearningBlocks.blocks(in: ":::mystery\nx: 1\n:::").count, 0)
    }

    // MARK: - Step Lab

    func testStepLabStepsInferredVisualTypesAndADedupedID() {
        let parsed = JunoStepLab.parse(
            [
                "title: How it reads",
                "steps:",
                "  - id: same",
                "    title: Tokens",
                "    summary: Split the prompt",
                "  - id: same",
                "    title: Attention",
                "    summary: Weigh the context",
                "takeaway: That is the whole loop.",
            ].joined(separator: "\n"),
            seed: "seed"
        )
        XCTAssertNil(parsed.error)
        XCTAssertEqual(parsed.lab.title, "How it reads")
        XCTAssertEqual(parsed.lab.steps.map(\.id), ["same", "same_2"])
        XCTAssertEqual(parsed.lab.steps.map(\.visualType), [.tokenization, .attention])
        XCTAssertEqual(parsed.lab.takeaway, "That is the whole loop.")
    }

    func testAStepWithNoSummaryIsDroppedAndNoneLeftIsAFallbackLab() {
        let parsed = JunoStepLab.parse("title: Broken\nsteps:\n  - title: Alone", seed: "seed")
        XCTAssertEqual(parsed.error, "Step Lab has no valid steps.")
        XCTAssertEqual(parsed.lab.title, "Broken")
        XCTAssertEqual(parsed.lab.steps.count, 1)
        XCTAssertEqual(parsed.lab.steps.first?.id, "fallback")
    }

    func testStepLabQuizUsesTheSameRulesAsTheStandaloneBlock() {
        let parsed = JunoStepLab.parse(
            [
                "title: Lab",
                "steps:",
                "  - title: One",
                "    summary: Does something",
                "quiz:",
                "  question: Which?",
                "  options:",
                "    - label: This",
                "      correct: true",
                "    - label: That",
            ].joined(separator: "\n"),
            seed: "seed"
        )
        XCTAssertEqual(parsed.lab.quiz?.questions.count, 1)
        XCTAssertEqual(parsed.lab.quiz?.questions.first?.options.first?.correct, true)
    }

    // MARK: - Splitting a reply for rendering

    /// The transcript's own use of the scanner: prose runs and lessons in source
    /// order, with whitespace-only runs dropped so two adjacent lessons are not
    /// pushed apart by a gap that came from nothing.
    func testSplitProducesProseAndBlocksInOrderDroppingEmptyRuns() {
        let text = [
            ":::learning-card",
            "content: First.",
            ":::",
            "",
            ":::learning-card",
            "content: Second.",
            ":::",
            "Tail.",
        ].joined(separator: "\n")
        let segments = JunoLessonText.split(text)
        XCTAssertEqual(segments.count, 3)
        if case .block = segments[0] {} else { XCTFail("expected a block first") }
        if case .block = segments[1] {} else { XCTFail("expected a block second") }
        if case .markdown(let tail) = segments[2] {
            XCTAssertEqual(tail.trimmingCharacters(in: .whitespacesAndNewlines), "Tail.")
        } else {
            XCTFail("expected trailing prose")
        }
    }

    private func slice(_ text: String, _ start: Int, _ end: Int) -> String {
        JunoLineScanner.substring(of: text, fromUTF16: start, toUTF16: end)
    }
}
