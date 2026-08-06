import Foundation
import JunoWorkCore
import XCTest

@testable import JunoWorkLocal

/// A throwaway tree for one test: a granted folder, and a sibling the grant must
/// never be able to reach.
///
/// The sibling matters. Half of these tests are about a location that *looks*
/// like it is inside `grant` and resolves somewhere else, and without a real
/// second directory on disk there is nothing for a symlink to escape to.
struct WorkSandbox {
    let root: URL
    let grant: URL
    let outside: URL

    func grantURL(_ relative: String) -> URL {
        grant.appendingPathComponent(relative)
    }

    func outsideURL(_ relative: String) -> URL {
        outside.appendingPathComponent(relative)
    }

    @discardableResult
    func writeInGrant(_ relative: String, _ contents: String) throws -> URL {
        let url = grantURL(relative)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(contents.utf8).write(to: url)
        return url
    }

    func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }
}

extension XCTestCase {
    func makeWorkSandbox() throws -> WorkSandbox {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-work-\(UUID().uuidString)", isDirectory: true)
        let grant = root.appendingPathComponent("grant", isDirectory: true)
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: grant, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return WorkSandbox(root: root, grant: grant, outside: outside)
    }

    func makeAccess(
        _ sandbox: WorkSandbox,
        mode: WorkAccessMode = .readWrite
    ) throws -> GrantAccess {
        try GrantAccess(
            grantID: WorkGrantID(value: "grant-1"),
            mode: mode,
            grantedURL: sandbox.grant
        )
    }

    func makeService(
        _ sandbox: WorkSandbox,
        mode: WorkAccessMode = .readWrite
    ) throws -> (GrantAccess, WorkFileService) {
        let access = try makeAccess(sandbox, mode: mode)
        return (access, WorkFileService(access: access))
    }

    func text(at url: URL) -> String? {
        (try? Data(contentsOf: url)).flatMap { String(data: $0, encoding: .utf8) }
    }

    /// `XCTAssertThrowsError` has no `async` form, and writing the do/catch by
    /// hand in thirty places is how one of them ends up asserting nothing.
    func assertThrowsAsync<T>(
        _ expression: @autoclosure () async throws -> T,
        _ message: String = "expected an error",
        file: StaticString = #filePath,
        line: UInt = #line,
        _ inspect: (any Error) -> Void = { _ in }
    ) async {
        do {
            _ = try await expression()
            XCTFail(message, file: file, line: line)
        } catch {
            inspect(error)
        }
    }
}

final class GrantAccessTests: XCTestCase {
    // MARK: - Symlinks out of the grant

    /// The headline case. A link inside the granted folder points at `/etc`, and
    /// neither reading through it nor writing through it may work — for the leaf
    /// itself, for a file underneath it, and for a file underneath it that does
    /// not exist yet.
    func testASymlinkToEtcIsNotFollowedForReadingOrWriting() async throws {
        let sandbox = try makeWorkSandbox()
        try FileManager.default.createSymbolicLink(
            atPath: sandbox.grantURL("etc").path,
            withDestinationPath: "/etc"
        )
        try FileManager.default.createSymbolicLink(
            atPath: sandbox.grantURL("hosts").path,
            withDestinationPath: "/etc/hosts"
        )
        let (access, service) = try makeService(sandbox)

        for raw in ["etc/hosts", "hosts"] {
            let path = try GrantedPath(raw)
            XCTAssertThrowsError(try access.resolveForReading(path)) { error in
                XCTAssertEqual(error as? WorkGrantAccessError, .symlinkEscapesGrant(path: raw))
            }
            await assertThrowsAsync(try await service.read(path)) { error in
                XCTAssertEqual(error as? WorkGrantAccessError, .symlinkEscapesGrant(path: raw))
            }
        }

        // The mutation side, including the case a leaf-only check misses: the
        // file does not exist yet, so there is nothing to canonicalize about it.
        let newFile = try GrantedPath("etc/juno-should-never-write-this")
        XCTAssertThrowsError(try access.resolveForMutation(newFile)) { error in
            XCTAssertEqual(
                error as? WorkGrantAccessError,
                .symlinkEscapesGrant(path: newFile.value)
            )
        }
        await assertThrowsAsync(
            try await service.write(newFile, data: Data("x".utf8))
        ) { error in
            XCTAssertEqual(
                error as? WorkGrantAccessError,
                .symlinkEscapesGrant(path: newFile.value)
            )
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: "/etc/juno-should-never-write-this"))
    }

    /// A move is two resolutions, and the destination is the one that gets
    /// forgotten: the source is a real file inside the grant, so the operation
    /// looks legitimate right up to the moment it lands outside.
    func testAMoveWhoseDestinationIsReachedThroughASymlinkOutOfTheGrantIsRefused() async throws {
        let sandbox = try makeWorkSandbox()
        try sandbox.writeInGrant("Report.pdf", "the report")
        try FileManager.default.createSymbolicLink(
            atPath: sandbox.grantURL("linked").path,
            withDestinationPath: sandbox.outside.path
        )
        let (_, service) = try makeService(sandbox)

        let source = try GrantedPath("Report.pdf")
        let destination = try GrantedPath("linked/Report.pdf")
        await assertThrowsAsync(try await service.move(from: source, to: destination)) { error in
            XCTAssertEqual(
                error as? WorkGrantAccessError,
                .symlinkEscapesGrant(path: destination.value)
            )
        }
        XCTAssertFalse(sandbox.exists(sandbox.outsideURL("Report.pdf")))
        XCTAssertTrue(sandbox.exists(sandbox.grantURL("Report.pdf")))

        // The same refusal one level deeper, where the destination folder does
        // not exist yet either.
        let deeper = try GrantedPath("linked/Archive/Report.pdf")
        await assertThrowsAsync(try await service.copy(from: source, to: deeper)) { error in
            XCTAssertEqual(
                error as? WorkGrantAccessError,
                .symlinkEscapesGrant(path: deeper.value)
            )
        }
        XCTAssertFalse(sandbox.exists(sandbox.outsideURL("Archive")))
    }

    func testAWalkNeverDescendsADirectorySymlink() async throws {
        let sandbox = try makeWorkSandbox()
        try sandbox.writeInGrant("Inside/note.txt", "inside the grant")
        try Data("outside the grant".utf8).write(to: sandbox.outsideURL("secret.txt"))
        try FileManager.default.createSymbolicLink(
            atPath: sandbox.grantURL("linked").path,
            withDestinationPath: sandbox.outside.path
        )
        // A link back to the grant root, which is how a walk that follows links
        // spins until it runs out of entries.
        try FileManager.default.createSymbolicLink(
            atPath: sandbox.grantURL("loop").path,
            withDestinationPath: sandbox.grant.path
        )
        let (_, service) = try makeService(sandbox)

        let found = try await service.search(WorkSearchQuery(nameContains: "txt"))
        XCTAssertEqual(found.map(\.entry.path.value), ["Inside/note.txt"])

        let listing = try await service.list()
        XCTAssertEqual(listing.map(\.path.value), ["Inside"])
    }

    /// The `/tmp` case, and the reason `realpath(3)` is not optional. Foundation
    /// resolves `/private/tmp` to `/tmp` and the kernel resolves it the other
    /// way; canonicalize the root with one and a candidate with the other and
    /// containment silently stops meaning anything.
    func testTheSlashPrivateFormOfTheSameFolderIsTreatedAsTheSameFolder() async throws {
        XCTAssertEqual(
            URL(fileURLWithPath: "/private/tmp").resolvingSymlinksInPath().path,
            "/tmp",
            "Foundation still strips a leading /private"
        )
        XCTAssertEqual(GrantAccess.canonicalPath("/tmp"), "/private/tmp")

        let name = "juno-work-\(UUID().uuidString)"
        let shortRoot = URL(fileURLWithPath: "/tmp").appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: shortRoot, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: shortRoot) }
        try Data("hello".utf8).write(to: shortRoot.appendingPathComponent("Report.pdf"))

        let access = try GrantAccess(
            grantID: WorkGrantID(value: "tmp-grant"),
            mode: .readWrite,
            grantedURL: shortRoot
        )
        XCTAssertEqual(
            try access.resolveForReading(try GrantedPath("Report.pdf")).path,
            "/private/tmp/\(name)/Report.pdf"
        )
        XCTAssertEqual(
            try access.makeRelative(URL(fileURLWithPath: "/tmp/\(name)/Report.pdf")),
            try GrantedPath("Report.pdf")
        )
        let service = WorkFileService(access: access)
        try await service.write(try GrantedPath("New/Note.txt"), data: Data("written".utf8))
        XCTAssertEqual(text(at: shortRoot.appendingPathComponent("New/Note.txt")), "written")
    }

    func testASiblingFolderWithTheGrantAsANamePrefixIsNotInsideTheGrant() throws {
        let sandbox = try makeWorkSandbox()
        let sibling = sandbox.root.appendingPathComponent("grant-old", isDirectory: true)
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        try Data("theirs".utf8).write(to: sibling.appendingPathComponent("x.txt"))
        let access = try makeAccess(sandbox)

        XCTAssertThrowsError(try access.makeRelative(sibling.appendingPathComponent("x.txt")))
    }

    // MARK: - Trash

    /// Trash is not delete, and this is the difference: after trashing, the
    /// bytes are still on disk somewhere the person can reach them.
    func testTrashMovesToTheTrashAndDoesNotUnlink() async throws {
        let sandbox = try makeWorkSandbox()
        let file = try sandbox.writeInGrant("Old Draft.txt", "still wanted, actually")
        let (_, service) = try makeService(sandbox)

        let token = try await service.trash(try GrantedPath("Old Draft.txt"))
        // Tidied up so a test run does not leave litter in the person's Trash.
        addTeardownBlock { try? FileManager.default.removeItem(atPath: token) }

        XCTAssertFalse(sandbox.exists(file), "the item left the granted folder")
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: token),
            "the item is still on disk in the Trash, not unlinked"
        )
        XCTAssertEqual(text(at: URL(fileURLWithPath: token)), "still wanted, actually")
        XCTAssertTrue(token.contains(".Trash"), "the token points into a Trash folder: \(token)")
    }

    func testAGrantSharedWithoutDeletePermissionRefusesToTrashAnything() async throws {
        let sandbox = try makeWorkSandbox()
        try sandbox.writeInGrant("Report.pdf", "the report")
        let (_, service) = try makeService(sandbox, mode: .readWriteNoDelete)

        await assertThrowsAsync(try await service.trash(try GrantedPath("Report.pdf"))) { error in
            XCTAssertEqual(
                error as? WorkGrantAccessError,
                .modeForbidsTrash(path: "Report.pdf", mode: .readWriteNoDelete)
            )
        }
        XCTAssertTrue(sandbox.exists(sandbox.grantURL("Report.pdf")))
    }

    func testAReadOnlyGrantRefusesEveryMutation() async throws {
        let sandbox = try makeWorkSandbox()
        try sandbox.writeInGrant("Report.pdf", "the report")
        let (_, service) = try makeService(sandbox, mode: .read)

        await assertThrowsAsync(
            try await service.write(try GrantedPath("New.txt"), data: Data("x".utf8))
        )
        await assertThrowsAsync(try await service.createFolder(at: try GrantedPath("New")))
        await assertThrowsAsync(
            try await service.copy(
                from: try GrantedPath("Report.pdf"),
                to: try GrantedPath("Copy.pdf")
            )
        )
        XCTAssertFalse(sandbox.exists(sandbox.grantURL("New.txt")))
        XCTAssertFalse(sandbox.exists(sandbox.grantURL("Copy.pdf")))
        // Reading still works, which is the whole point of the mode.
        let read = try await service.read(try GrantedPath("Report.pdf"))
        XCTAssertEqual(read.text, "the report")
    }

    // MARK: - Revocation

    func testARevokedGrantRefusesEveryResolution() async throws {
        let sandbox = try makeWorkSandbox()
        try sandbox.writeInGrant("Report.pdf", "the report")
        let (access, service) = try makeService(sandbox)
        XCTAssertNoThrow(try access.resolveForReading(try GrantedPath("Report.pdf")))

        access.revoke()
        XCTAssertThrowsError(try access.resolveForReading(try GrantedPath("Report.pdf"))) { error in
            XCTAssertEqual(
                error as? WorkGrantAccessError,
                .grantRevoked(grantID: WorkGrantID(value: "grant-1"))
            )
        }
        await assertThrowsAsync(
            try await service.write(try GrantedPath("New.txt"), data: Data("x".utf8))
        )
        XCTAssertFalse(sandbox.exists(sandbox.grantURL("New.txt")))
    }

    // MARK: - Reading

    /// A read that quietly returns the first two megabytes of a forty-megabyte
    /// contract is worse than one that refuses: whatever consumes it will
    /// describe the whole document from a fraction of it.
    func testAReadIsCappedAndSaysSo() async throws {
        let sandbox = try makeWorkSandbox()
        let body = String(repeating: "a", count: 4_096)
        try sandbox.writeInGrant("Long.txt", body)
        let (_, service) = try makeService(sandbox)

        let capped = try await service.read(try GrantedPath("Long.txt"), maximumBytes: 100)
        XCTAssertTrue(capped.wasTruncated)
        XCTAssertEqual(capped.data.count, 100)
        XCTAssertEqual(capped.totalByteCount, 4_096)
        XCTAssertEqual(capped.maximumBytes, 100)
        XCTAssertNil(capped.fingerprint, "a fingerprint of a prefix would never match the file")

        let whole = try await service.read(try GrantedPath("Long.txt"))
        XCTAssertFalse(whole.wasTruncated)
        XCTAssertEqual(whole.fingerprint, WorkContentFingerprint(of: body))
    }

    func testReadingSomethingThatIsNotThereSaysSoRatherThanBlamingTheGrant() async throws {
        let sandbox = try makeWorkSandbox()
        let (_, service) = try makeService(sandbox)
        await assertThrowsAsync(try await service.read(try GrantedPath("Nowhere.txt"))) { error in
            XCTAssertEqual(error as? WorkFileServiceError, .notFound(path: "Nowhere.txt"))
        }
    }

    /// The streamed hash and the in-memory one must agree exactly, across a file
    /// larger than one chunk. If they ever disagreed, every conflict check in
    /// Work would report a change nobody made.
    func testTheStreamedFingerprintMatchesTheInMemoryOneAcrossChunkBoundaries() throws {
        let sandbox = try makeWorkSandbox()
        // Deliberately not a round number of chunks.
        let count = ContentFingerprint.chunkBytes * 2 + 12_345
        var body = Data(capacity: count)
        for index in 0..<count { body.append(UInt8(index % 251)) }
        let url = sandbox.grantURL("Big.bin")
        try body.write(to: url)

        let streamed = try ContentFingerprint.fingerprint(ofFileAt: url)
        XCTAssertEqual(streamed, WorkContentFingerprint(of: body))
        XCTAssertEqual(streamed.byteCount, count)
    }

    func testFingerprintingRefusesAFileLargerThanItsCapAndNamesTheCap() throws {
        let sandbox = try makeWorkSandbox()
        let url = try sandbox.writeInGrant("Big.bin", String(repeating: "b", count: 5_000))
        XCTAssertThrowsError(
            try ContentFingerprint.fingerprint(ofFileAt: url, maximumBytes: 1_000)
        ) { error in
            XCTAssertEqual(
                error as? ContentFingerprintError,
                .tooLarge(byteCount: 5_000, maximumBytes: 1_000)
            )
        }
        XCTAssertThrowsError(try ContentFingerprint.fingerprint(ofFileAt: sandbox.grant)) { error in
            XCTAssertEqual(
                error as? ContentFingerprintError,
                .unreadable(reason: "it is a folder, not a file")
            )
        }
    }

    // MARK: - Ordinary work

    func testTheOrdinaryOperationsWorkAndStayInsideTheGrant() async throws {
        let sandbox = try makeWorkSandbox()
        try sandbox.writeInGrant("Report.pdf", "the report")
        let (_, service) = try makeService(sandbox)

        let createdArchive = try await service.createFolder(at: try GrantedPath("Archive"))
        XCTAssertTrue(createdArchive)
        let createdAgain = try await service.createFolder(at: try GrantedPath("Archive"))
        XCTAssertFalse(createdAgain, "a folder that was already there was not created by this batch")

        try await service.copy(
            from: try GrantedPath("Report.pdf"),
            to: try GrantedPath("Archive/Report.pdf")
        )
        XCTAssertEqual(text(at: sandbox.grantURL("Archive/Report.pdf")), "the report")

        let renamed = try await service.rename(try GrantedPath("Report.pdf"), to: "Final.pdf")
        XCTAssertEqual(renamed.value, "Final.pdf")
        XCTAssertFalse(sandbox.exists(sandbox.grantURL("Report.pdf")))

        try await service.move(
            from: try GrantedPath("Final.pdf"),
            to: try GrantedPath("Archive/2026/Final.pdf")
        )
        XCTAssertEqual(text(at: sandbox.grantURL("Archive/2026/Final.pdf")), "the report")

        let metadata = try await service.metadata(of: try GrantedPath("Archive/2026/Final.pdf"))
        XCTAssertEqual(metadata.byteCount, 10)
        XCTAssertFalse(metadata.isDirectory)
    }

    func testCopyingOntoSomethingRefusesUnlessTheReplacementWasApproved() async throws {
        let sandbox = try makeWorkSandbox()
        try sandbox.writeInGrant("a.txt", "alpha")
        try sandbox.writeInGrant("b.txt", "beta")
        let (_, service) = try makeService(sandbox)

        await assertThrowsAsync(
            try await service.copy(from: try GrantedPath("a.txt"), to: try GrantedPath("b.txt"))
        ) { error in
            XCTAssertEqual(error as? WorkFileServiceError, .alreadyExists(path: "b.txt"))
        }
        XCTAssertEqual(text(at: sandbox.grantURL("b.txt")), "beta")

        try await service.copy(
            from: try GrantedPath("a.txt"),
            to: try GrantedPath("b.txt"),
            replacingApprovedExistingItem: true
        )
        XCTAssertEqual(text(at: sandbox.grantURL("b.txt")), "alpha")
    }

    func testWritingWithAStaleBaseIsRefused() async throws {
        let sandbox = try makeWorkSandbox()
        try sandbox.writeInGrant("Note.txt", "first")
        let (_, service) = try makeService(sandbox)
        let stale = WorkContentFingerprint(of: "something else")

        await assertThrowsAsync(
            try await service.write(
                try GrantedPath("Note.txt"),
                data: Data("second".utf8),
                expectedBase: stale
            )
        ) { error in
            XCTAssertEqual(
                error as? WorkFileServiceError,
                .contentChangedUnderneath(path: "Note.txt")
            )
        }
        XCTAssertEqual(text(at: sandbox.grantURL("Note.txt")), "first")
    }

    func testTagsRoundTripOnAMac() async throws {
        let sandbox = try makeWorkSandbox()
        try sandbox.writeInGrant("Report.pdf", "the report")
        let (_, service) = try makeService(sandbox)
        let path = try GrantedPath("Report.pdf")

        XCTAssertEqual(try service.tags(of: path), [])
        try await service.setTags(["Ashworth", "Urgent"], on: path)
        XCTAssertEqual(Set(try service.tags(of: path)), ["Ashworth", "Urgent"])
        try await service.setTags([], on: path)
        XCTAssertEqual(try service.tags(of: path), [])
    }

    // MARK: - Bookmarks

    func testAPlainBookmarkReopensTheSameFolder() throws {
        let sandbox = try makeWorkSandbox()
        try sandbox.writeInGrant("Report.pdf", "the report")
        let bookmark = try GrantAccess.makeBookmark(for: sandbox.grant)

        let reopened = try GrantAccess(
            grantID: WorkGrantID(value: "grant-1"),
            mode: .readWrite,
            bookmarkData: bookmark
        )
        XCTAssertEqual(
            try reopened.resolveForReading(try GrantedPath("Report.pdf")).lastPathComponent,
            "Report.pdf"
        )
        XCTAssertFalse(reopened.bookmarkNeedsRefresh)
    }

    func testOpeningAFileOrAMissingFolderAsAGrantIsRefused() throws {
        let sandbox = try makeWorkSandbox()
        let file = try sandbox.writeInGrant("Report.pdf", "the report")
        XCTAssertThrowsError(
            try GrantAccess(grantID: WorkGrantID(), mode: .readWrite, grantedURL: file)
        ) { error in
            XCTAssertEqual(error as? WorkGrantOpenError, .rootIsNotADirectory)
        }
        XCTAssertThrowsError(
            try GrantAccess(
                grantID: WorkGrantID(),
                mode: .readWrite,
                grantedURL: sandbox.root.appendingPathComponent("nowhere")
            )
        ) { error in
            XCTAssertEqual(error as? WorkGrantOpenError, .rootUnavailable)
        }
    }
}
