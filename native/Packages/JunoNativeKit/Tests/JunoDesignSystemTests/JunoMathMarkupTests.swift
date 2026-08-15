import XCTest
@testable import JunoDesignSystem

/// LaTeX extraction and conversion.
///
/// The extraction half is where the expensive bugs live: a `$` that opens maths
/// when it meant money turns a price list into italic algebra, and an unclosed
/// `$` that swallows the rest of a streamed answer is worse still. So the
/// delimiter rules get more tests than the symbol table does.
final class JunoMathMarkupTests: XCTestCase {
    // MARK: - Inline extraction

    func testInlineDollarsProduceAMathSegment() {
        XCTAssertEqual(
            JunoMathMarkup.segments(in: "Given $x + 1$ we continue."),
            [.text("Given "), .math("x + 1", display: false), .text(" we continue.")]
        )
    }

    func testDisplayDollarsAreMarkedAsDisplay() {
        XCTAssertEqual(
            JunoMathMarkup.segments(in: "$$E = mc^2$$"),
            [.math("E = mc^2", display: true)]
        )
    }

    func testBackslashDelimitersAreRecognised() {
        // Several models emit these by default; a reader who sees the raw
        // brackets in the transcript is looking at a rendering bug.
        XCTAssertEqual(
            JunoMathMarkup.segments(in: #"inline \(a\) and block \[b\]"#),
            [
                .text("inline "),
                .math("a", display: false),
                .text(" and block "),
                .math("b", display: true),
            ]
        )
    }

    func testTwoFormulasInOneSentence() {
        XCTAssertEqual(
            JunoMathMarkup.segments(in: "$a$ and $b$"),
            [.math("a", display: false), .text(" and "), .math("b", display: false)]
        )
    }

    // MARK: - Money is not maths

    func testCurrencyAmountsStayProse() {
        // The single most important case in the file. "$5 and $10" has no valid
        // closing delimiter, because the second `$` is preceded by a space.
        let source = "It costs $5 and $10 in total."
        XCTAssertEqual(JunoMathMarkup.segments(in: source), [.text(source)])
        XCTAssertFalse(JunoMathMarkup.containsMath(source))
    }

    func testClosingDollarFollowedByADigitIsRejected() {
        let source = "from $100 to $200"
        XCTAssertEqual(JunoMathMarkup.segments(in: source), [.text(source)])
    }

    func testOpeningDollarFollowedByASpaceIsNotAnOpener() {
        let source = "costs 5$ or more"
        XCTAssertEqual(JunoMathMarkup.segments(in: source), [.text(source)])
    }

    func testEscapedDollarIsALiteralDollar() {
        XCTAssertEqual(JunoMathMarkup.segments(in: #"\$5.00"#), [.text("$5.00")])
    }

    func testMathsSurvivesBesideCurrency() {
        // A stray `$` earlier in the line must not consume the real formula.
        let segments = JunoMathMarkup.segments(in: "Cost $5 then $y = 2$ holds")
        XCTAssertTrue(segments.contains(.math("y = 2", display: false)), "\(segments)")
    }

    func testInlineCodeSpansAreVerbatim() {
        // Documentation about shell variables must not become algebra.
        let source = "Use `$PATH` and `x_i` carefully."
        XCTAssertEqual(JunoMathMarkup.segments(in: source), [.text(source)])
    }

    // MARK: - Streaming safety

    func testUnterminatedInlineMathStaysProse() {
        let source = "the formula $E = mc"
        XCTAssertEqual(JunoMathMarkup.segments(in: source), [.text(source)])
    }

    func testInlineMathDoesNotCrossABlankLine() {
        let source = "opens $here\n\nand a later $ appears"
        XCTAssertEqual(JunoMathMarkup.segments(in: source), [.text(source)])
    }

    func testEveryPrefixOfAFormulaSentenceIsTotal() {
        let full = "Given $\\alpha \\leq \\beta$ and $$\\frac{1}{2}$$ we finish."
        for length in 1...full.count {
            let prefix = String(full.prefix(length))
            let segments = JunoMathMarkup.segments(in: prefix)
            let rebuilt = segments.reduce(into: 0) { total, segment in
                switch segment {
                case .text(let text): total += text.count
                case .math(let latex, _): total += latex.count
                }
            }
            // Nothing may vanish: every character is either prose or inside a
            // formula. Delimiters are the only thing consumed.
            XCTAssertLessThanOrEqual(rebuilt, prefix.count, "prefix of length \(length)")
            XCTAssertFalse(segments.isEmpty, "prefix of length \(length) produced nothing")
        }
    }

    // MARK: - Conversion

    func testGreekAndOperators() {
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\alpha \\leq \\beta").text, "α ≤ β")
        XCTAssertEqual(JunoMathMarkup.render(latex: "a \\times b \\neq c").text, "a × b ≠ c")
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\Omega \\subset \\mathbb{R}").text, "Ω ⊂ ℝ")
    }

    func testSuperscriptsAndSubscripts() {
        XCTAssertEqual(JunoMathMarkup.render(latex: "E = mc^2").text, "E = mc²")
        XCTAssertEqual(JunoMathMarkup.render(latex: "x^{10}").text, "x¹⁰")
        XCTAssertEqual(JunoMathMarkup.render(latex: "a_1 + a_2").text, "a₁ + a₂")
        XCTAssertEqual(JunoMathMarkup.render(latex: "x_{ij}").text, "xᵢⱼ")
    }

    func testCompoundScriptsUseUnicodeWhereEveryCharacterHasAForm() {
        // `n`, `+` and `1` all have superscript forms, so this needs no fallback.
        XCTAssertEqual(JunoMathMarkup.render(latex: "x^{n+1}").text, "xⁿ⁺¹")
    }

    func testUnrepresentableScriptFallsBackWithoutLosingTheExponent() {
        // Unicode has no superscript or subscript `q`. `x^(q+1)` is uglier than
        // a typeset exponent and it is still correct; dropping the exponent, or
        // substituting a lookalike from another block, would not be.
        XCTAssertEqual(JunoMathMarkup.render(latex: "x^{q+1}").text, "x^(q+1)")
        XCTAssertEqual(JunoMathMarkup.render(latex: "x_{q}").text, "x_q")
    }

    func testFallbackScriptsAreNotReportedAsUnconverted() {
        // They are a typesetting compromise, not a loss. Flagging them would
        // train the reader to ignore the flag.
        XCTAssertTrue(JunoMathMarkup.render(latex: "x^{q+1}").isFaithful)
    }

    func testFractions() {
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\frac{1}{2}").text, "½")
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\frac{dy}{dx}").text, "dy/dx")
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\frac{5}{7}").text, "5/7")
    }

    func testCompoundFractionOperandsAreParenthesised() {
        // Without the parentheses this reads as `a + b/c`, which is a different
        // expression and a plausible-looking one.
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\frac{a+b}{c}").text, "(a+b)/c")
    }

    func testRoots() {
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\sqrt{2}").text, "√2")
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\sqrt[3]{x}").text, "∛x")
    }

    func testDelimiterSizingIsDropped() {
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\left( x \\right)").text, "( x )")
    }

    func testNamedOperatorsKeepTheirSpacing() {
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\sin x + \\log y").text, "sin x + log y")
    }

    func testTextCommandUnwrapsItsArgument() {
        XCTAssertEqual(JunoMathMarkup.render(latex: "3 \\text{ apples}").text, "3  apples")
    }

    // MARK: - Never drop a term

    func testUnknownCommandsSurviveVerbatimAndAreReported() {
        let rendering = JunoMathMarkup.render(latex: "a \\xrightarrow{f} b")
        XCTAssertTrue(rendering.text.contains("\\xrightarrow"), rendering.text)
        XCTAssertEqual(rendering.unconverted, ["\\xrightarrow"])
        XCTAssertFalse(rendering.isFaithful)
    }

    func testEnvironmentsAreReportedButTheirTermsSurvive() {
        // Layout is lost; nothing the author wrote is.
        let rendering = JunoMathMarkup.render(latex: "\\begin{aligned} x &= 1 \\end{aligned}")
        XCTAssertTrue(rendering.text.contains("x"), rendering.text)
        XCTAssertTrue(rendering.text.contains("1"), rendering.text)
        XCTAssertFalse(rendering.isFaithful)
        XCTAssertEqual(rendering.unconverted.first, "\\begin{aligned}")
    }

    func testAFullyConvertedFormulaIsFaithful() {
        XCTAssertTrue(JunoMathMarkup.render(latex: "\\int_0^1 x^2 dx").isFaithful)
    }

    func testNestedGroupsRecurse() {
        XCTAssertEqual(JunoMathMarkup.render(latex: "\\frac{x^{2}}{\\sqrt{y}}").text, "x²/√y")
    }

    func testUnclosedGroupDoesNotHangOrDrop() {
        // The streaming case, one level down.
        let rendering = JunoMathMarkup.render(latex: "\\frac{a}{b")
        XCTAssertTrue(rendering.text.contains("a"), rendering.text)
        XCTAssertTrue(rendering.text.contains("b"), rendering.text)
    }

    // MARK: - Display maths as a block

    func testDisplayMathBecomesItsOwnBlock() {
        XCTAssertEqual(
            JunoMarkdown.blocks(from: "$$\nE = mc^2\n$$"),
            [.math(latex: "E = mc^2", isClosed: true)]
        )
    }

    func testSingleLineDisplayMathBlock() {
        XCTAssertEqual(
            JunoMarkdown.blocks(from: "$$x = 1$$"),
            [.math(latex: "x = 1", isClosed: true)]
        )
    }

    func testBracketDisplayMathBlock() {
        XCTAssertEqual(
            JunoMarkdown.blocks(from: "\\[\nx = 1\n\\]"),
            [.math(latex: "x = 1", isClosed: true)]
        )
    }

    func testUnterminatedDisplayMathStillRenders() {
        XCTAssertEqual(
            JunoMarkdown.blocks(from: "$$\nx = 1"),
            [.math(latex: "x = 1", isClosed: false)]
        )
    }

    func testDisplayMathSurvivesABlankLineInsideIt() {
        // A `$$ … $$` run with a blank row would otherwise be split into three
        // paragraphs by the blank-line rule.
        XCTAssertEqual(
            JunoMarkdown.blocks(from: "$$\na = 1\n\nb = 2\n$$"),
            [.math(latex: "a = 1\n\nb = 2", isClosed: true)]
        )
    }

    func testDollarsInsideACodeFenceStaySource() {
        XCTAssertEqual(
            JunoMarkdown.blocks(from: "```sh\n$$ is the pid\n```"),
            [.code(language: "sh", source: "$$ is the pid", isClosed: true)]
        )
    }

    func testMidSentenceDisplayMathStaysInline() {
        // Only a line that *starts* with the delimiter opens a block; otherwise
        // one sentence gets cut in half by a centred slab.
        let blocks = JunoMarkdown.blocks(from: "the identity $$x$$ shows")
        XCTAssertEqual(blocks, [.paragraph("the identity $$x$$ shows")])
    }

    func testMathBlocksMixWithOrdinaryOnes() {
        let source = """
            # Title

            Intro.

            $$
            a^2 + b^2 = c^2
            $$

            Closing.
            """
        let blocks = JunoMarkdown.blocks(from: source)
        XCTAssertEqual(blocks.count, 4)
        XCTAssertEqual(blocks[2], .math(latex: "a^2 + b^2 = c^2", isClosed: true))
        XCTAssertEqual(blocks.last, .paragraph("Closing."))
    }
}
