import Foundation
import JunoCore
import JunoStorage
import XCTest
@testable import JunoChatKit

/// The wiring these cover is the whole point of ``NativeDocumentIndexModel``:
/// bytes in one module become chunks in a second and retrievable passages in a
/// third, and every screen that imports a document depends on all three steps
/// happening in the right order. They deliberately go through the public entry
/// point rather than the pipeline directly — the pipeline already has its own
/// tests, and what is untested without these is the *joining*.
@MainActor
final class NativeDocumentIndexStoreTests: XCTestCase {
    private let markdown = """
    # Quarterly review

    Revenue in the Nordics grew by eleven percent, driven by renewals.

    # Hiring

    We closed three engineering roles in Lisbon this quarter.
    """

    func testIngestedDocumentBecomesRetrievableWithAnHonestLocator() async throws {
        let model = NativeDocumentIndexModel()
        model.start(for: try AccountID("account-a"))

        await model.ingest(data: Data(markdown.utf8), fileName: "Review.md")

        XCTAssertNil(model.lastErrorDescription)
        XCTAssertFalse(model.isIngesting)
        let document = try XCTUnwrap(model.documents.first)
        XCTAssertEqual(model.documents.count, 1)
        XCTAssertEqual(document.sourceName, "Review.md")
        XCTAssertEqual(document.format, .markdown)
        XCTAssertGreaterThan(document.chunkCount, 0)
        // Markdown has no pages, so the count is absent rather than 1 or 0.
        XCTAssertNil(document.pageCount)
        XCTAssertFalse(document.usedOpticalCharacterRecognition)

        model.setQuery("Nordics renewals")
        try await waitUntil { !model.passages.isEmpty }

        let passage = try XCTUnwrap(model.passages.first)
        XCTAssertTrue(passage.text.contains("Nordics"))
        // The locator names the file and the heading the text really sits under,
        // and claims no page for a format that has none.
        XCTAssertTrue(passage.locator.hasPrefix("Review.md"))
        XCTAssertFalse(passage.locator.contains("page"))
    }

    /// The `removeSource` before `insert` in `store(_:accountID:)`, from the
    /// outside. Without it the second import overwrites the first N chunks and
    /// leaves the rest behind, so text the document no longer contains keeps
    /// answering searches.
    func testReimportingAShorterFileDropsTheTextThatIsGone() async throws {
        let model = NativeDocumentIndexModel()
        model.start(for: try AccountID("account-a"))
        await model.ingest(data: Data(markdown.utf8), fileName: "Review.md")
        let firstChunkCount = model.chunkCount

        model.setQuery("Lisbon")
        try await waitUntil { !model.passages.isEmpty }

        let shortened = """
        # Quarterly review

        Revenue in the Nordics grew by eleven percent, driven by renewals.
        """
        await model.ingest(data: Data(shortened.utf8), fileName: "Review.md")

        XCTAssertEqual(model.documents.count, 1, "A re-import replaces; it does not add.")
        XCTAssertLessThan(model.chunkCount, firstChunkCount)
        try await waitUntil { model.passages.isEmpty }
    }

    /// An extension the pipeline does not understand is refused with a sentence,
    /// not ingested as a wall of binary that then competes with real content.
    func testUnknownFormatIsRefusedAndIndexesNothing() async throws {
        let model = NativeDocumentIndexModel()
        model.start(for: try AccountID("account-a"))

        await model.ingest(data: Data([0xFF, 0xD8, 0xFF]), fileName: "photo.heic")

        XCTAssertTrue(model.documents.isEmpty)
        XCTAssertEqual(model.chunkCount, 0)
        let message = try XCTUnwrap(model.lastErrorDescription)
        XCTAssertTrue(message.contains("photo.heic"))
    }

    /// Signing out has to leave nothing on screen, whatever the actor does
    /// afterwards. The partition wipe itself is fired as a task and is not
    /// asserted here — racing it would be a flaky test of a guarantee the model
    /// documents rather than a real one.
    func testStopClearsEverythingTheScreenCanSee() async throws {
        let model = NativeDocumentIndexModel()
        model.start(for: try AccountID("account-a"))
        await model.ingest(data: Data(markdown.utf8), fileName: "Review.md")
        model.setQuery("Nordics")
        try await waitUntil { !model.passages.isEmpty }

        model.stop()

        XCTAssertFalse(model.isReady)
        XCTAssertTrue(model.documents.isEmpty)
        XCTAssertTrue(model.passages.isEmpty)
        XCTAssertEqual(model.query, "")
        XCTAssertNil(model.lastErrorDescription)
    }

    // MARK: One-shot retrieval for a chat turn

    /// A send must be able to rank the corpus without stealing the search
    /// field's state. Before ``NativeDocumentIndexModel/passages(matching:limit:)``
    /// the only way to retrieve was `setQuery`, which would have wiped whatever
    /// the reader had typed into the Library search box mid-send.
    func testRetrievingForATurnLeavesTheSearchFieldAlone() async throws {
        let model = NativeDocumentIndexModel()
        model.start(for: try AccountID("account-a"))
        await model.ingest(data: Data(markdown.utf8), fileName: "Review.md")
        model.setQuery("Lisbon")
        try await waitUntil { !model.passages.isEmpty }
        let searchHits = model.passages

        let turnHits = await model.passages(matching: "Nordics renewals", limit: 2)

        XCTAssertFalse(turnHits.isEmpty)
        XCTAssertTrue(try XCTUnwrap(turnHits.first).text.contains("Nordics"))
        XCTAssertEqual(model.query, "Lisbon", "The turn must not retype the search field.")
        XCTAssertEqual(model.passages, searchHits, "The turn must not replace the search results.")
    }

    /// Every ordinary absence answers with no passages rather than an error. A
    /// send is the worst moment to put a failure notice in front of someone for
    /// the absence of a document they never claimed to have.
    func testRetrievingWithNothingToSearchIsEmptyRatherThanAFailure() async throws {
        let signedOut = NativeDocumentIndexModel()
        var hits = await signedOut.passages(matching: "anything")
        XCTAssertTrue(hits.isEmpty)

        let empty = NativeDocumentIndexModel()
        empty.start(for: try AccountID("account-a"))
        hits = await empty.passages(matching: "anything")
        XCTAssertTrue(hits.isEmpty)

        await empty.ingest(data: Data(markdown.utf8), fileName: "Review.md")
        hits = await empty.passages(matching: "   ")
        XCTAssertTrue(hits.isEmpty)
        XCTAssertNil(empty.lastErrorDescription)
    }

    // MARK: Grounding a turn

    private static func passage(
        _ id: String,
        source: String,
        locator: String,
        text: String,
        score: Double = 1
    ) -> NativeDocumentPassage {
        NativeDocumentPassage(
            id: id, sourceName: source, locator: locator, text: text, score: score
        )
    }

    func testAGroundedTurnCarriesTheRealLocatorUnderEveryMarker() {
        let grounding = NativeDocumentGrounding.ground(
            prompt: "What did the Nordics do?",
            in: [
                Self.passage(
                    "a#0",
                    source: "Q3.pdf",
                    locator: "Q3.pdf, page 4 — Revenue",
                    text: "Nordics revenue grew eleven percent."
                ),
                Self.passage(
                    "b#0",
                    source: "Notes.md",
                    locator: "Notes.md — Hiring",
                    text: "Three roles closed in Lisbon."
                ),
            ]
        )

        XCTAssertTrue(grounding.isGrounded)
        XCTAssertEqual(grounding.cited.count, 2)
        XCTAssertEqual(grounding.citedSourceNames, ["Q3.pdf", "Notes.md"])
        // The reader's question survives as the head of the message, verbatim.
        XCTAssertTrue(grounding.promptForModel.hasPrefix("What did the Nordics do?"))
        XCTAssertTrue(grounding.promptForModel.contains("[1] Q3.pdf, page 4 — Revenue"))
        XCTAssertTrue(grounding.promptForModel.contains("[2] Notes.md — Hiring"))
        // The instruction names the range that exists, so a `[3]` has been
        // ruled out rather than merely left unmentioned.
        XCTAssertTrue(grounding.promptForModel.contains("[1] to [2]"))
        XCTAssertFalse(grounding.promptForModel.contains("[3]"))
    }

    /// A single hit is cited as `[1]`, not as a range of one.
    func testASinglePassageIsCitedWithoutARange() {
        let grounding = NativeDocumentGrounding.ground(
            prompt: "Revenue?",
            in: [Self.passage("a#0", source: "Q3.pdf", locator: "Q3.pdf, page 4", text: "Up.")]
        )
        XCTAssertTrue(grounding.promptForModel.contains("— [1], and no other number"))
        XCTAssertFalse(grounding.promptForModel.contains("[2]"))
    }

    /// The whole point of the type. No passages means no heading, no markers and
    /// a message byte-identical to what the reader typed — a model handed
    /// "Excerpts retrieved from documents…" over nothing will still try to
    /// honour it.
    func testAnUngroundedTurnIsTheReadersOwnWordsAndNothingElse() {
        let grounding = NativeDocumentGrounding.ground(prompt: "Hello", in: [])
        XCTAssertFalse(grounding.isGrounded)
        XCTAssertEqual(grounding.promptForModel, "Hello")
        XCTAssertTrue(grounding.cited.isEmpty)
        XCTAssertEqual(NativeDocumentGrounding(ungrounded: "Hello").promptForModel, "Hello")
    }

    /// Markers are assigned after the budget is applied, never before. Numbering
    /// first and dropping afterwards leaves a marker over a passage that was
    /// never sent — a fabricated citation that looks exactly like a real one.
    func testMarkersAreOnlyEverGivenToPassagesThatFitTheBudget() {
        let long = String(repeating: "settlement ", count: 900)
        let grounding = NativeDocumentGrounding.ground(
            prompt: "Terms?",
            in: (0..<4).map {
                Self.passage(
                    "a#\($0)",
                    source: "Contract.pdf",
                    locator: "Contract.pdf, page \($0 + 1)",
                    text: long
                )
            }
        )

        XCTAssertGreaterThan(grounding.cited.count, 0)
        XCTAssertLessThan(grounding.cited.count, 4, "The budget has to actually bind.")
        let highest = grounding.cited.count
        XCTAssertTrue(grounding.promptForModel.contains("[\(highest)] Contract.pdf"))
        XCTAssertFalse(
            grounding.promptForModel.contains("[\(highest + 1)]"),
            "A dropped passage must leave no marker behind."
        )
        XCTAssertLessThanOrEqual(
            grounding.promptForModel.count - "Terms?".count,
            NativeDocumentGrounding.maximumBlockCharacters
        )
    }

    /// `cited` is what a surface shows when the reader asks what was sent, so it
    /// has to hold the excerpt as sent — a truncated quote and the chunk it came
    /// from are different strings.
    func testACutExcerptIsCutAtAWordBoundaryAndRecordedAsSent() {
        let long = String(repeating: "quarterly ", count: 400)
        let grounding = NativeDocumentGrounding.ground(
            prompt: "Summary?",
            in: [Self.passage("a#0", source: "Q3.pdf", locator: "Q3.pdf, page 1", text: long)]
        )

        let excerpt = try? XCTUnwrap(grounding.cited.first).text
        let sent = try? XCTUnwrap(excerpt)
        XCTAssertEqual(
            sent?.count,
            NativeDocumentGrounding.excerpt(long).count
        )
        XCTAssertTrue(sent?.hasSuffix("…") == true)
        XCTAssertFalse(sent?.contains("quarterl…") == true, "Never cut mid-word.")
        XCTAssertTrue(grounding.promptForModel.contains(sent ?? "\u{0}"))
    }

    /// A passage with nothing quotable in it is skipped rather than numbered: a
    /// marker over a blank quote is a citation to nothing.
    func testABlankPassageIsNeverGivenAMarker() {
        let grounding = NativeDocumentGrounding.ground(
            prompt: "Anything?",
            in: [
                Self.passage("a#0", source: "Empty.txt", locator: "Empty.txt", text: "   \n  "),
                Self.passage("b#0", source: "Real.md", locator: "Real.md", text: "Something."),
            ]
        )

        XCTAssertEqual(grounding.cited.map(\.sourceName), ["Real.md"])
        XCTAssertTrue(grounding.promptForModel.contains("[1] Real.md"))
        XCTAssertFalse(grounding.promptForModel.contains("Empty.txt"))
    }

    /// Ranking runs in a task the model does not hand back, so a test has to
    /// watch for the result rather than await it. Polling rather than a
    /// continuation on purpose: a condition that never becomes true has to fail
    /// the test, not hang the suite.
    private func waitUntil(
        _ condition: @MainActor () -> Bool,
        timeout: Duration = .seconds(2),
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("The condition was still false after \(timeout).", file: file, line: line)
    }
}
