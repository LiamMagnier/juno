import XCTest
@testable import JunoChatKit

/// The wire-format tests are the ones that matter most here: the failure they
/// guard against is not a crash but a *visible* one — a `<juno:memory>` tag, or an
/// artifact's whole source, rendered into the transcript as if it were prose.
final class NativeMessageContentTests: XCTestCase {

    // MARK: - Memories

    func testDropsMemoryTagsFromRenderedText() {
        let raw = """
        Here is the answer.

        <juno:memory>The user prefers concise answers.</juno:memory>
        """

        XCTAssertEqual(
            NativeMessageContent.parts(of: raw),
            [.text("Here is the answer.\n\n")]
        )
        XCTAssertEqual(NativeMessageContent.plainText(of: raw), "Here is the answer.")
    }

    func testDropsEveryMemoryTag() {
        let raw = "<juno:memory>One.</juno:memory>Answer.<juno:memory>Two.</juno:memory>"
        XCTAssertEqual(NativeMessageContent.plainText(of: raw), "Answer.")
        XCTAssertEqual(NativeMessageContent.memories(in: raw), ["One.", "Two."])
    }

    /// The tag arrives in deltas, so a message is briefly `…<juno:memory>The user`
    /// with no closing tag. Rendering that showed the half-written fact.
    func testDropsAnUnclosedMemoryTagWhileStreaming() {
        let raw = "Answer.\n\n<juno:memory>The user prefers conc"
        XCTAssertEqual(NativeMessageContent.plainText(of: raw), "Answer.")
    }

    func testMemoriesIgnoresEmptyFacts() {
        XCTAssertEqual(NativeMessageContent.memories(in: "<juno:memory>   </juno:memory>"), [])
    }

    // MARK: - Clarification wizard

    func testDropsAClarificationWizardBlock() {
        let raw = """
        Before I answer:

        :::clarification-wizard
        {"question":"Which framework?"}
        :::

        Done.
        """
        XCTAssertEqual(NativeMessageContent.plainText(of: raw), "Before I answer:\n\n\n\nDone.")
    }

    func testDropsAnUnterminatedClarificationWizard() {
        let raw = "Question:\n\n:::clarification-wizard\n{\"question\":\"Whi"
        XCTAssertEqual(NativeMessageContent.plainText(of: raw), "Question:")
    }

    // MARK: - Artifacts

    func testSplitsAnArtifactOutOfTheProse() {
        let raw = """
        Here you go.

        <juno:artifact identifier="todo" type="react" title="Todo App" language="tsx">
        export default function App() {}
        </juno:artifact>

        Tell me what to change.
        """

        let parts = NativeMessageContent.parts(of: raw)
        XCTAssertEqual(parts.count, 3)
        XCTAssertEqual(parts.first, .text("Here you go.\n\n"))
        guard case .artifact(let artifact) = parts[1] else {
            return XCTFail("expected an artifact in the middle")
        }
        XCTAssertEqual(artifact.identifier, "todo")
        XCTAssertEqual(artifact.title, "Todo App")
        XCTAssertEqual(artifact.kind, "REACT")
        XCTAssertEqual(artifact.language, "tsx")
        XCTAssertFalse(artifact.streaming)
        XCTAssertEqual(parts[2], .text("\n\nTell me what to change."))
    }

    /// The whole point of the card: the source must never reach the transcript as
    /// text, and it must not reach the pasteboard either.
    func testArtifactSourceNeverAppearsInPlainText() {
        let raw = """
        <juno:artifact type="code" title="Script">
        rm -rf /
        </juno:artifact>
        """
        let plain = NativeMessageContent.plainText(of: raw)
        XCTAssertEqual(plain, "Script")
        XCTAssertFalse(plain.contains("rm -rf"))
    }

    func testMarksAStillStreamingArtifact() {
        let raw = "<juno:artifact type=\"html\" title=\"Page\">\n<!doctype html>"
        guard case .artifact(let artifact)? = NativeMessageContent.parts(of: raw).first else {
            return XCTFail("expected a streaming artifact")
        }
        XCTAssertTrue(artifact.streaming)
        XCTAssertEqual(artifact.kind, "HTML")
        XCTAssertEqual(artifact.title, "Page")
    }

    /// The attribute list itself streams a character at a time, so there is a
    /// moment with no `>` and therefore no title to show.
    func testHandlesAnArtifactTagThatHasNoClosingBracketYet() {
        let parts = NativeMessageContent.parts(of: "Working on it.\n\n<juno:artifact type=\"re")
        XCTAssertEqual(parts.count, 2)
        guard case .artifact(let artifact) = parts[1] else {
            return XCTFail("expected a placeholder artifact")
        }
        XCTAssertTrue(artifact.streaming)
        XCTAssertEqual(artifact.title, "Untitled artifact")
    }

    /// No card for an empty artifact — and, critically, no tag left behind in the
    /// prose either. Eliding the match without consuming its range is exactly how
    /// raw wire text reaches a transcript.
    func testDrawsNoCardForAnEmptyArtifactAndStillRemovesTheTag() {
        let raw = "Answer.<juno:artifact identifier=\"x\" type=\"code\" title=\"X\">  </juno:artifact>"
        XCTAssertEqual(NativeMessageContent.parts(of: raw), [.text("Answer.")])
        XCTAssertFalse(NativeMessageContent.plainText(of: raw).contains("juno:artifact"))
    }

    func testAcceptsSingleQuotedAndUnquotedAttributes() {
        let raw = "<juno:artifact identifier='a-b' type=svg title='Chart'>x</juno:artifact>"
        guard case .artifact(let artifact)? = NativeMessageContent.parts(of: raw).first else {
            return XCTFail("expected an artifact")
        }
        XCTAssertEqual(artifact.identifier, "a-b")
        XCTAssertEqual(artifact.kind, "SVG")
        XCTAssertEqual(artifact.title, "Chart")
    }

    func testUnknownTypesFallBackToCode() {
        let raw = "<juno:artifact type=\"spreadsheet\" title=\"T\">x</juno:artifact>"
        guard case .artifact(let artifact)? = NativeMessageContent.parts(of: raw).first else {
            return XCTFail("expected an artifact")
        }
        XCTAssertEqual(artifact.kind, "CODE")
    }

    /// The djb2 hash and `art-` prefix have to match `message-content.ts` exactly,
    /// or a card drawn here keys differently from the same card on the web.
    func testDerivesTheWebsStableIdentifierWhenTheModelOmitsOne() {
        let raw = "<juno:artifact type=\"code\" title=\"T\">hello</juno:artifact>"
        guard case .artifact(let artifact)? = NativeMessageContent.parts(of: raw).first else {
            return XCTFail("expected an artifact")
        }
        // djb2("hello") in 32-bit wrapping arithmetic is 261238937 — "4bj995" in
        // base 36, the value the web's `hashId` produces for the same body.
        XCTAssertEqual(artifact.identifier, "art-4bj995")
    }

    func testHandlesTwoArtifactsInOneReply() {
        let raw = """
        <juno:artifact identifier="a" type="code" title="A">1</juno:artifact>
        between
        <juno:artifact identifier="b" type="code" title="B">2</juno:artifact>
        """
        let parts = NativeMessageContent.parts(of: raw)
        XCTAssertEqual(parts.count, 3)
        XCTAssertEqual(parts[1], .text("\nbetween\n"))
        if case .artifact(let first) = parts[0] { XCTAssertEqual(first.identifier, "a") }
        else { XCTFail("expected the first artifact") }
        if case .artifact(let last) = parts[2] { XCTAssertEqual(last.identifier, "b") }
        else { XCTFail("expected the second artifact") }
    }

    // MARK: - Plain text

    func testLeavesOrdinaryProseUntouched() {
        let raw = "A paragraph with **bold** and a <div> that is not one of ours."
        XCTAssertEqual(NativeMessageContent.parts(of: raw), [.text(raw)])
    }

    func testWhitespaceOnlyRunsAreNotEmittedAsBlankParagraphs() {
        let raw = "\n\n<juno:artifact identifier=\"a\" type=\"code\" title=\"A\">1</juno:artifact>"
        XCTAssertEqual(NativeMessageContent.parts(of: raw).count, 1)
    }

    // MARK: - Trailing sources section

    func testDropsATrailingSourcesSectionOfCitations() {
        let raw = """
        The answer is 42.

        ## Sources
        [1] https://example.com/a
        - [2] https://example.com/b
        """
        XCTAssertEqual(
            NativeMessageContent.strippingTrailingSourcesSection(raw),
            "The answer is 42."
        )
    }

    /// A Sources section the model wrote prose into is the model saying something,
    /// not a list already rendered as chips.
    func testKeepsASourcesSectionThatContainsProse() {
        let raw = """
        Answer.

        ## Sources
        I could not find a primary source for this.
        """
        XCTAssertEqual(NativeMessageContent.strippingTrailingSourcesSection(raw), raw)
    }

    func testIgnoresASourcesHeadingInsideACodeFence() {
        let raw = """
        Answer.

        ```markdown
        ## Sources
        [1] https://example.com
        ```
        """
        XCTAssertEqual(NativeMessageContent.strippingTrailingSourcesSection(raw), raw)
    }

    func testLeavesContentWithNoSourcesHeadingAlone() {
        let raw = "Answer.\n\n## Notes\n[1] a"
        XCTAssertEqual(NativeMessageContent.strippingTrailingSourcesSection(raw), raw)
    }

    func testABulletWithoutASpaceIsNotACitationEntry() {
        let raw = "Answer.\n\n## Sources\n-[1] https://example.com"
        XCTAssertEqual(NativeMessageContent.strippingTrailingSourcesSection(raw), raw)
    }
}

/// The artifact body travels on the reference.
///
/// It is the only copy of an artifact that is guaranteed to be on the device.
/// The stored row is written server-side and arrives on the next sync, so for
/// the whole window between "the reply finished" and "the row arrived" the tag's
/// own body is all the transcript has to open. Dropping it is what made tapping
/// an artifact card do nothing at all in that window.
final class NativeArtifactBodyTests: XCTestCase {
    private func artifact(
        in raw: String
    ) -> NativeMessageContent.ArtifactReference? {
        for part in NativeMessageContent.parts(of: raw) {
            if case .artifact(let reference) = part { return reference }
        }
        return nil
    }

    func testTheReferenceCarriesTheTagsBody() {
        let raw = """
        Here you go.

        <juno:artifact identifier="todo" type="react" title="Todo App">
        export default function App() { return null }
        </juno:artifact>
        """
        let reference = artifact(in: raw)
        XCTAssertEqual(reference?.identifier, "todo")
        XCTAssertEqual(reference?.title, "Todo App")
        XCTAssertEqual(
            reference?.content,
            "export default function App() { return null }"
        )
    }

    /// Surrounding newlines come from the tag's own formatting, not from the
    /// artifact — a preview that renders them shows an SVG pushed down the page.
    func testTheBodyIsTrimmed() {
        let raw = "<juno:artifact type=\"svg\" title=\"Mark\">\n\n  <svg/>\n\n</juno:artifact>"
        XCTAssertEqual(artifact(in: raw)?.content, "<svg/>")
    }

    /// A body still arriving has no closing tag. The card is inert while that is
    /// true, but the partial source must still reach the reference rather than
    /// being discarded — the streaming flag is what gates the tap, not emptiness.
    func testAStreamingArtifactCarriesWhatHasArrivedSoFar() {
        let raw = "<juno:artifact type=\"code\" title=\"Draft\">let x ="
        let reference = artifact(in: raw)
        XCTAssertEqual(reference?.streaming, true)
        XCTAssertEqual(reference?.content, "let x =")
    }

    /// The derived identifier still hashes the body, unchanged: a card keyed here
    /// has to match the one the website drew for the same reply.
    func testAnOmittedIdentifierIsStillDerivedFromTheBody() {
        let raw = "<juno:artifact type=\"code\" title=\"Draft\">let x = 1</juno:artifact>"
        let reference = artifact(in: raw)
        XCTAssertTrue(reference?.identifier.hasPrefix("art-") == true)
        XCTAssertEqual(reference?.content, "let x = 1")
    }
}
