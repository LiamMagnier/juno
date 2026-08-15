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
