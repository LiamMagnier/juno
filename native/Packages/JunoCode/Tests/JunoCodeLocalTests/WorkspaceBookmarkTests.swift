import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// Persisting a granted folder and getting it back on the next launch.
///
/// This is the path that made Juno Code unusable. A **security-scoped** bookmark
/// is bound to the code identity of the app that created it, and this layer both
/// minted and required one — so re-signing the app (ad-hoc to Developer ID, a
/// changed team, a local build replacing an installed one) made every stored
/// grant unresolvable. It surfaced as `bookmarkInvalid` under the project list,
/// and since no workspace opened, no session started and the composer never
/// appeared.
///
/// The grant is now stored as a plain bookmark, which carries no such binding,
/// while scoped bookmarks are still *accepted* so grants written by earlier
/// builds keep working.
final class WorkspaceBookmarkTests: XCTestCase {
    private var workspaceURL: URL!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-bookmark-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("src"),
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    /// What the app now persists must not be identity-bound.
    ///
    /// This is the actual regression guard: a scoped bookmark would resolve here
    /// (the test process created it) and still fail in a re-signed app, so
    /// asserting "it round-trips" is not enough — the stored form itself has to
    /// be the portable one.
    func testTheStoredGrantIsNotBoundToThisBuildsSignature() throws {
        let stored = try WorkspaceAccess.makeBookmark(for: workspaceURL)
        let scoped = try workspaceURL.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        XCTAssertNotEqual(
            stored, scoped,
            "A security-scoped bookmark is tied to this build's code identity; the stored grant must not be one"
        )
    }

    /// Grants written by earlier builds still open, so the fix is not a data
    /// migration the user has to notice.
    func testAScopedBookmarkFromAnEarlierBuildStillResolves() throws {
        let legacy = try workspaceURL.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        let reopened = try WorkspaceAccess(workspaceID: WorkspaceID(), bookmarkData: legacy)
        XCTAssertEqual(
            reopened.rootURL.resolvingSymlinksInPath().standardizedFileURL.path,
            workspaceURL.resolvingSymlinksInPath().standardizedFileURL.path
        )
    }

    /// The regression, end to end: grant a folder, persist it, reopen it.
    func testBookmarkRoundTripsInAnUnsandboxedProcess() throws {
        let id = WorkspaceID()
        let data = try WorkspaceAccess.makeBookmark(for: workspaceURL)
        XCTAssertFalse(data.isEmpty, "A granted folder must produce persistable bookmark data")

        let reopened = try WorkspaceAccess(workspaceID: id, bookmarkData: data)
        XCTAssertEqual(
            reopened.rootURL.resolvingSymlinksInPath().standardizedFileURL.path,
            workspaceURL.resolvingSymlinksInPath().standardizedFileURL.path
        )
    }

    /// A reopened workspace has to be usable, not merely constructible.
    func testAReopenedWorkspaceCanStillResolvePaths() throws {
        try "hello".write(
            to: workspaceURL.appendingPathComponent("src/main.swift"),
            atomically: true,
            encoding: .utf8
        )
        let data = try WorkspaceAccess.makeBookmark(for: workspaceURL)
        let reopened = try WorkspaceAccess(workspaceID: WorkspaceID(), bookmarkData: data)

        let resolved = try reopened.resolveForReading(try WorkspacePath("src/main.swift"))
        XCTAssertEqual(try String(contentsOf: resolved, encoding: .utf8), "hello")
    }

    /// Containment is not weakened by the fallback: a plain bookmark grants the
    /// same root and the same escape checks apply.
    func testContainmentStillHoldsForAPlainBookmark() throws {
        let data = try WorkspaceAccess.makeBookmark(for: workspaceURL)
        let reopened = try WorkspaceAccess(workspaceID: WorkspaceID(), bookmarkData: data)

        XCTAssertThrowsError(try reopened.makeRelative(URL(fileURLWithPath: "/etc/hosts"))) { error in
            XCTAssertTrue(error is WorkspaceAccessError)
        }
    }

    /// Garbage must still be refused — the fallback widens which bookmarks
    /// resolve, not which bytes are accepted.
    func testCorruptBookmarkDataIsStillRejected() {
        XCTAssertThrowsError(
            try WorkspaceAccess(
                workspaceID: WorkspaceID(),
                bookmarkData: Data([0x00, 0x01, 0x02, 0x03])
            )
        ) { error in
            XCTAssertEqual(error as? WorkspaceAccessError, .bookmarkInvalid)
        }
    }

    /// A folder deleted after it was granted is reported as unavailable rather
    /// than as an invalid bookmark: the difference decides whether the UI offers
    /// "choose it again" or says the data is corrupt.
    func testADeletedFolderReportsItselfUnavailable() throws {
        let data = try WorkspaceAccess.makeBookmark(for: workspaceURL)
        try FileManager.default.removeItem(at: workspaceURL)

        XCTAssertThrowsError(
            try WorkspaceAccess(workspaceID: WorkspaceID(), bookmarkData: data)
        ) { error in
            let access = error as? WorkspaceAccessError
            XCTAssertNotNil(access)
            // Either way the reader is offered a re-grant, which is the point.
            XCTAssertTrue(access?.isRecoverableByRegrantingAccess == true)
        }
    }
}

/// The sentences these errors show the reader.
final class WorkspaceAccessErrorCopyTests: XCTestCase {
    /// The regression this replaced: `"\(error)"` printed the enum case, so the
    /// sidebar showed the literal word "bookmarkInvalid".
    func testALapsedGrantExplainsItselfInProse() {
        let message = WorkspaceAccessError.bookmarkInvalid.localizedDescription
        XCTAssertFalse(message.contains("bookmarkInvalid"))
        XCTAssertTrue(message.lowercased().contains("permission"))
    }

    func testOnlyRegrantableFailuresOfferARegrant() {
        XCTAssertTrue(WorkspaceAccessError.bookmarkInvalid.isRecoverableByRegrantingAccess)
        XCTAssertTrue(WorkspaceAccessError.bookmarkStale.isRecoverableByRegrantingAccess)
        XCTAssertTrue(WorkspaceAccessError.rootUnavailable.isRecoverableByRegrantingAccess)
        // Picking the folder again cannot fix a path that escapes the workspace.
        XCTAssertFalse(
            WorkspaceAccessError.outsideWorkspace(path: "x").isRecoverableByRegrantingAccess
        )
        XCTAssertFalse(WorkspaceAccessError.rootIsNotADirectory.isRecoverableByRegrantingAccess)
    }

    func testEveryCaseHasAMessage() {
        let cases: [WorkspaceAccessError] = [
            .rootUnavailable, .rootIsNotADirectory, .bookmarkInvalid, .bookmarkStale,
            .outsideWorkspace(path: "a"), .symlinkEscapesWorkspace(path: "b"),
            .parentDoesNotExist(path: "c"),
        ]
        for error in cases {
            XCTAssertFalse(
                error.localizedDescription.isEmpty,
                "\(error) reaches the reader with no explanation"
            )
        }
    }
}
