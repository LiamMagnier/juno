import XCTest
@testable import JunoDesignSystem

/// Pins the reasoning chunker to the website's own behaviour.
///
/// These are the same cases as `tests/reasoning-lines.test.ts`, assertion for
/// assertion, because the two clients wrapping a trace differently is exactly the
/// kind of difference nobody notices until a run reads as two different runs
/// depending on where you opened it.
///
/// The rule both sides defend: this may WRAP a trace, and may never INVENT a
/// boundary in it. `reasoning-parts.ts` establishes that a step boundary is a fact
/// carried from the wire — so parts are used verbatim, and prose is split only on
/// blank lines the model itself wrote and, past a length nobody can read two lines
/// at a time, at its own sentence ends.
final class JunoAIcssReasoningLinesTests: XCTestCase {

    // MARK: - Provider parts

    func testPartsBecomeOneLineEachInOrder() {
        let lines = JunoAIcssReasoningLines.lines(
            text: "flattened text nobody should read here",
            parts: [
                "**Reading the middleware**\nThe verify call sets no allowlist.",
                "**Pinning the algorithm**\nHS256, plus issuer and audience checks.",
            ]
        )
        XCTAssertEqual(lines, ["Reading the middleware", "Pinning the algorithm"])
    }

    func testPartWithNoBoldTitleFallsBackToItsOpeningLine() {
        let lines = JunoAIcssReasoningLines.lines(
            text: nil,
            parts: ["Tracing where the secret is loaded from.\nThen confirming it never leaks."]
        )
        XCTAssertEqual(lines, ["Tracing where the secret is loaded from."])
    }

    func testTitleOnlyPartIsALine() {
        let lines = JunoAIcssReasoningLines.lines(text: nil, parts: ["**Designing high-traffic caching**"])
        XCTAssertEqual(lines, ["Designing high-traffic caching"])
    }

    func testEmptyPartsAreDroppedRatherThanRenderedAsBlankSlots() {
        let lines = JunoAIcssReasoningLines.lines(text: nil, parts: ["**First**", "   ", "", "**Second**"])
        XCTAssertEqual(lines, ["First", "Second"])
    }

    /// The flat text is the parts run together (see `appendReasoningDelta`), so
    /// reading it when parts exist would double every line.
    func testPartsWinOverTheFlatText() {
        let lines = JunoAIcssReasoningLines.lines(
            text: "**A**\nbody\n\n**B**\nbody",
            parts: ["**A**\nbody", "**B**\nbody"]
        )
        XCTAssertEqual(lines, ["A", "B"])
    }

    // MARK: - Prose

    func testBlankLinesAreTheBoundaries() {
        let lines = JunoAIcssReasoningLines.lines(text: "First thought.\n\nSecond thought.\n\n\nThird thought.")
        XCTAssertEqual(lines, ["First thought.", "Second thought.", "Third thought."])
    }

    /// A single newline is a wrap in the model's own prose, not a boundary.
    func testSingleNewlineIsNotABoundary() {
        let lines = JunoAIcssReasoningLines.lines(text: "One clause\nand its continuation.")
        XCTAssertEqual(lines, ["One clause and its continuation."])
    }

    func testShortParagraphIsNeverSplitHoweverManySentencesItHolds() {
        let short = "One. Two. Three. Four."
        XCTAssertEqual(JunoAIcssReasoningLines.lines(text: short), [short])
    }

    func testLongParagraphWrapsAtSentenceEndsLosingNoText() {
        let sentence = "This clause is long enough on its own to matter to the wrapper. "
        let paragraph = String(repeating: sentence, count: 4).trimmingCharacters(in: .whitespaces)
        let lines = JunoAIcssReasoningLines.lines(text: paragraph)

        XCTAssertGreaterThan(lines.count, 1, "a 260-character paragraph should wrap")
        // Every wrap point is a sentence end the model wrote, so rejoining
        // restores the paragraph exactly. This is the property that makes it a
        // wrap rather than an edit.
        XCTAssertEqual(lines.joined(separator: " "), paragraph)
        for line in lines {
            XCTAssertTrue(
                line.hasSuffix(".") || line.hasSuffix("!") || line.hasSuffix("?") || line.hasSuffix("…"),
                "line does not end at a sentence: \(line)"
            )
        }
    }

    func testOneOversizedSentenceGetsALineOfItsOwnRatherThanBeingCut() {
        let monster = String(repeating: "word ", count: 60).trimmingCharacters(in: .whitespaces) + "."
        XCTAssertEqual(JunoAIcssReasoningLines.lines(text: monster), [monster])
    }

    func testNoTraceIsNoLines() {
        XCTAssertEqual(JunoAIcssReasoningLines.lines(text: nil), [])
        XCTAssertEqual(JunoAIcssReasoningLines.lines(text: ""), [])
        XCTAssertEqual(JunoAIcssReasoningLines.lines(text: "   \n\n  "), [])
        XCTAssertEqual(JunoAIcssReasoningLines.lines(text: nil, parts: []), [])
    }
}
