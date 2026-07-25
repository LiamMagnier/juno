import Foundation
import JunoChatKit
import XCTest
@testable import JunoMobile

/// The Library's selection rule: what the chips, the search field and the sort
/// menu together decide to show.
final class JunoMobileLibraryTests: XCTestCase {
    private func file(
        _ name: String,
        kind: String = "IMAGE",
        secondsAgo: TimeInterval = 0
    ) -> NativeProjectFile {
        NativeProjectFile(
            id: name,
            projectID: nil,
            conversationID: nil,
            messageID: nil,
            fileName: name,
            kind: kind,
            mimeType: kind == "IMAGE" ? "image/png" : "application/pdf",
            size: 1024,
            width: nil,
            height: nil,
            createdAt: Date(timeIntervalSince1970: 1_000_000 - secondsAgo),
            revision: 1
        )
    }

    private var library: [NativeProjectFile] {
        [
            file("beach.png", secondsAgo: 30),
            file("Contract.pdf", kind: "FILE", secondsAgo: 10),
            file("apple.png", secondsAgo: 20),
            file("notes.txt", kind: "FILE", secondsAgo: 0),
        ]
    }

    private func names(
        _ filter: JunoLibraryFilter = .all,
        search: String = "",
        sort: JunoLibrarySort = .newest
    ) -> [String] {
        JunoLibraryFilter.apply(library, filter: filter, search: search, sort: sort)
            .map(\.fileName)
    }

    func testAllShowsEverythingNewestFirst() {
        XCTAssertEqual(names(), ["notes.txt", "Contract.pdf", "apple.png", "beach.png"])
    }

    func testImagesAndDocumentsPartitionTheLibraryExactly() {
        let images = names(.images)
        let documents = names(.documents)

        XCTAssertEqual(Set(images), ["apple.png", "beach.png"])
        XCTAssertEqual(Set(documents), ["Contract.pdf", "notes.txt"])
        // No file is in both, and none is in neither.
        XCTAssertEqual(images.count + documents.count, library.count)
        XCTAssertTrue(Set(images).isDisjoint(with: Set(documents)))
    }

    func testSearchIsCaseInsensitiveAndMatchesAnywhereInTheName() {
        XCTAssertEqual(names(search: "CONTRACT"), ["Contract.pdf"])
        XCTAssertEqual(Set(names(search: "p")), ["apple.png", "beach.png", "Contract.pdf"])
    }

    func testSearchIsTrimmedSoAStrayKeystrokeDoesNotEmptyTheGrid() {
        XCTAssertEqual(names(search: "   "), names())
    }

    func testSearchAndFilterCompose() {
        XCTAssertEqual(names(.images, search: "app"), ["apple.png"])
        XCTAssertTrue(names(.documents, search: "app").isEmpty)
    }

    func testSortingByNameIsLocalisedAndCaseInsensitive() {
        XCTAssertEqual(
            names(sort: .name), ["apple.png", "beach.png", "Contract.pdf", "notes.txt"]
        )
    }

    /// Two files uploaded in the same second must not swap places between
    /// reloads, which is what an unstable sort would do.
    func testFilesFromTheSameMomentKeepAStableOrder() {
        let same = [file("b.png", secondsAgo: 5), file("a.png", secondsAgo: 5)]
        let sorted = JunoLibraryFilter.apply(same, filter: .all, search: "", sort: .newest)

        XCTAssertEqual(sorted.map(\.fileName), ["a.png", "b.png"])
    }

    @MainActor
    func testAFileIsOnlyEverFetchedOnce() async {
        let loader = JunoLibraryPreviewLoader()
        let subject = file("beach.png")
        var fetches = 0

        await loader.load(subject) {
            fetches += 1
            return nil
        }
        // A second appearance — the card scrolled away and came back.
        await loader.load(subject) {
            fetches += 1
            return nil
        }

        XCTAssertEqual(fetches, 1, "The library re-downloaded a file it had already failed on.")
        XCTAssertEqual(loader.state(for: subject.id), .unavailable)
    }

    /// A 60 MB video or archive is not worth pulling down to draw a 300pt
    /// square, so it never leaves the card's fallback state.
    @MainActor
    func testAnOversizedDocumentIsNeverDownloadedForAThumbnail() async {
        let loader = JunoLibraryPreviewLoader()
        let huge = NativeProjectFile(
            id: "huge",
            projectID: nil,
            conversationID: nil,
            messageID: nil,
            fileName: "archive.zip",
            kind: "FILE",
            mimeType: "application/zip",
            size: JunoLibraryPreviewLoader.documentPreviewByteLimit + 1,
            width: nil,
            height: nil,
            createdAt: Date(timeIntervalSince1970: 1_000_000),
            revision: 1
        )
        var fetched = false

        await loader.load(huge) {
            fetched = true
            return nil
        }

        XCTAssertFalse(fetched)
        XCTAssertEqual(loader.state(for: huge.id), .unavailable)
    }
}
