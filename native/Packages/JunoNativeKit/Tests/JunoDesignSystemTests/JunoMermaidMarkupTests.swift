import XCTest
@testable import JunoDesignSystem

/// Mermaid fence detection, isolation, and the host document.
///
/// The escaping tests are the ones that matter most. A diagram's source is model
/// output embedded in a JavaScript string literal inside a `<script>` element; a
/// label containing `</script>` that is not escaped stops being a label and
/// starts being markup, in a WebView that is executing JavaScript.
final class JunoMermaidMarkupTests: XCTestCase {
    // MARK: - Fence detection

    func testMermaidFenceIsDetectedCaseInsensitively() {
        XCTAssertTrue(JunoMermaidMarkup.isMermaidFence(info: "mermaid"))
        XCTAssertTrue(JunoMermaidMarkup.isMermaidFence(info: "Mermaid"))
        XCTAssertTrue(JunoMermaidMarkup.isMermaidFence(info: "  MERMAID  "))
    }

    func testInfoStringWithExtraWordsStillCounts() {
        XCTAssertTrue(JunoMermaidMarkup.isMermaidFence(info: "mermaid flowchart"))
    }

    func testLookalikeInfoStringsAreRefused() {
        // A prefix match would point a JavaScript engine at a file called
        // `mermaid-notes.md`.
        XCTAssertFalse(JunoMermaidMarkup.isMermaidFence(info: "mermaidjs"))
        XCTAssertFalse(JunoMermaidMarkup.isMermaidFence(info: "mermaid-notes.md"))
        XCTAssertFalse(JunoMermaidMarkup.isMermaidFence(info: "swift"))
        XCTAssertFalse(JunoMermaidMarkup.isMermaidFence(info: nil))
        XCTAssertFalse(JunoMermaidMarkup.isMermaidFence(info: ""))
    }

    // MARK: - Block isolation

    func testMermaidFenceIsIsolatedAsItsOwnCodeBlock() {
        let source = """
            Before.

            ```mermaid
            flowchart LR
              A --> B
            ```

            After.
            """
        let blocks = JunoMarkdown.blocks(from: source)
        XCTAssertEqual(blocks.count, 3)
        guard case .code(let language, let body, let isClosed) = blocks[1] else {
            return XCTFail("expected a fenced block, got \(blocks[1])")
        }
        XCTAssertTrue(JunoMermaidMarkup.isMermaidFence(info: language))
        XCTAssertEqual(body, "flowchart LR\n  A --> B")
        XCTAssertTrue(isClosed)
    }

    func testMarkdownInsideADiagramIsNotParsed() {
        // `A --> B` starts with no marker, but `- - -` inside a diagram would
        // otherwise become a thematic break.
        let blocks = JunoMarkdown.blocks(from: "```mermaid\ngraph TD\n---\nA-->B\n```")
        XCTAssertEqual(
            blocks,
            [.code(language: "mermaid", source: "graph TD\n---\nA-->B", isClosed: true)]
        )
    }

    func testStreamingDiagramFenceIsStillOpen() {
        // The renderer keys on `isClosed` to avoid drawing a half-written graph.
        let blocks = JunoMarkdown.blocks(from: "```mermaid\nflowchart LR\n  A -->")
        XCTAssertEqual(
            blocks,
            [.code(language: "mermaid", source: "flowchart LR\n  A -->", isClosed: false)]
        )
    }

    // MARK: - Diagram kind

    func testDiagramKindsFromTheDeclarationLine() {
        let cases: [(String, JunoMermaidDiagramKind)] = [
            ("flowchart LR\n A-->B", .flowchart),
            ("graph TD\n A-->B", .flowchart),
            ("sequenceDiagram\n A->>B: hi", .sequence),
            ("classDiagram\n class A", .classDiagram),
            ("stateDiagram-v2\n [*] --> A", .stateDiagram),
            ("erDiagram\n A ||--o{ B : has", .entityRelationship),
            ("gantt\n title X", .gantt),
            ("pie showData\n \"a\" : 1", .pie),
            ("mindmap\n root", .mindmap),
            ("gitGraph\n commit", .gitGraph),
        ]
        for (source, expected) in cases {
            XCTAssertEqual(
                JunoMermaidMarkup.diagramKind(of: source),
                expected,
                "for \(source.prefix(20))"
            )
        }
    }

    func testFrontMatterAndCommentsAreSkippedBeforeTheDeclaration() {
        // A naive "first non-empty line" reads `---` and reports an unknown
        // diagram for a perfectly ordinary flowchart.
        let source = """
            ---
            title: Deploy
            ---
            %% generated
            flowchart TD
              A --> B
            """
        XCTAssertEqual(JunoMermaidMarkup.diagramKind(of: source), .flowchart)
    }

    func testUnknownDiagramTypeIsNamedRatherThanRefused() {
        // Mermaid gains diagram types faster than the enum will; an unknown
        // header must still render.
        XCTAssertEqual(JunoMermaidMarkup.diagramKind(of: "brandNewDiagram\n x"), .unknown)
        XCTAssertEqual(JunoMermaidDiagramKind.unknown.label, "Diagram")
    }

    func testEmptySourceHasNoKindAndDoesNotCrash() {
        XCTAssertEqual(JunoMermaidMarkup.diagramKind(of: ""), .unknown)
        XCTAssertEqual(JunoMermaidMarkup.diagramKind(of: "\n\n  \n"), .unknown)
    }

    // MARK: - JavaScript escaping

    func testScriptTagInDiagramSourceCannotBreakOut() {
        let hostile = "flowchart LR\n  A[\"</script><script>alert(1)</script>\"] --> B"
        let escaped = JunoMermaidMarkup.escapedForJavaScript(hostile)
        XCTAssertFalse(escaped.contains("<"), escaped)
        XCTAssertFalse(escaped.contains(">"), escaped)
        XCTAssertTrue(escaped.contains("\\u003C"), escaped)

        let document = JunoMermaidMarkup.hostDocument(source: hostile, engine: "", isDark: false)
        XCTAssertFalse(document.contains("</script><script>alert"), document)
    }

    func testQuotesNewlinesAndAmpersandsAreEscaped() {
        let escaped = JunoMermaidMarkup.escapedForJavaScript("a\"b\nc&d\\e")
        XCTAssertEqual(escaped, "a\\\"b\\nc\\u0026d\\\\e")
    }

    func testLineSeparatorsAreEscaped() {
        // Valid JSON, invalid JavaScript — the classic way an embedding that
        // "round-trips fine" still produces a syntax error.
        XCTAssertEqual(JunoMermaidMarkup.escapedForJavaScript("a\u{2028}b"), "a\\u2028b")
        XCTAssertEqual(JunoMermaidMarkup.escapedForJavaScript("a\u{2029}b"), "a\\u2029b")
    }

    func testControlCharactersAreEscaped() {
        XCTAssertEqual(JunoMermaidMarkup.escapedForJavaScript("a\u{0007}b"), "a\\u0007b")
    }

    // MARK: - Host document

    func testHostDocumentDeclaresTheNetworkDenyingPolicy() {
        let document = JunoMermaidMarkup.hostDocument(
            source: "flowchart LR\n A --> B",
            engine: "/* engine */",
            isDark: false
        )
        XCTAssertTrue(document.contains("Content-Security-Policy"), document)
        XCTAssertTrue(document.contains("default-src 'none'"), document)
        XCTAssertTrue(document.contains("connect-src 'none'"), document)
    }

    func testHostDocumentCarriesTheEngineAndTheAppearance() {
        let dark = JunoMermaidMarkup.hostDocument(
            source: "graph TD\n A",
            engine: "window.mermaid = {};",
            isDark: true
        )
        XCTAssertTrue(dark.contains("window.mermaid = {};"))
        XCTAssertTrue(dark.contains("draw(\"dark\")"), "dark appearance must reach Mermaid")

        let light = JunoMermaidMarkup.hostDocument(
            source: "graph TD\n A",
            engine: "",
            isDark: false
        )
        XCTAssertTrue(light.contains("draw(\"default\")"))
    }

    func testHostDocumentExposesTheThemeAndResetHooks() {
        // The native chrome calls both by name; a typo here is a "Reset view"
        // button that silently does nothing.
        let document = JunoMermaidMarkup.hostDocument(source: "graph TD", engine: "", isDark: false)
        XCTAssertTrue(document.contains("window.junoSetTheme"))
        XCTAssertTrue(document.contains("window.junoResetView"))
        XCTAssertTrue(document.contains(JunoMermaidMarkup.messageHandlerName))
    }

    func testHostDocumentUsesMermaidStrictSecurityLevel() {
        let document = JunoMermaidMarkup.hostDocument(source: "graph TD", engine: "", isDark: false)
        XCTAssertTrue(document.contains("securityLevel: \"strict\""), document)
    }

    func testHostDocumentIsDeterministic() {
        // Same input, same bytes. A document that varies per call would make
        // every re-render a reload and throw away the reader's zoom.
        let first = JunoMermaidMarkup.hostDocument(source: "graph TD", engine: "x", isDark: true)
        let second = JunoMermaidMarkup.hostDocument(source: "graph TD", engine: "x", isDark: true)
        XCTAssertEqual(first, second)
    }
}
