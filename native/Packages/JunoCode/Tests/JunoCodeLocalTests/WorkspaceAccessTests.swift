import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class WorkspaceAccessTests: XCTestCase {
    private var workspaceURL: URL!
    private var outsideURL: URL!

    override func setUpWithError() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-ws-\(UUID().uuidString)")
        workspaceURL = base.appendingPathComponent("workspace")
        outsideURL = base.appendingPathComponent("outside")
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("src"),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(at: outsideURL, withIntermediateDirectories: true)
        try "hello".write(
            to: workspaceURL.appendingPathComponent("src/main.swift"),
            atomically: true,
            encoding: .utf8
        )
        try "secret".write(
            to: outsideURL.appendingPathComponent("secret.txt"),
            atomically: true,
            encoding: .utf8
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(
            at: workspaceURL.deletingLastPathComponent()
        )
    }

    private func makeAccess() throws -> WorkspaceAccess {
        try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
    }

    func testResolvesExistingFileForReading() throws {
        let access = try makeAccess()
        let url = try access.resolveForReading(try WorkspacePath("src/main.swift"))
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "hello")
    }

    func testSymlinkEscapingWorkspaceIsRejectedForReading() throws {
        try FileManager.default.createSymbolicLink(
            at: workspaceURL.appendingPathComponent("link.txt"),
            withDestinationURL: outsideURL.appendingPathComponent("secret.txt")
        )
        let access = try makeAccess()
        XCTAssertThrowsError(
            try access.resolveForReading(try WorkspacePath("link.txt"))
        ) { error in
            guard case WorkspaceAccessError.symlinkEscapesWorkspace = error else {
                return XCTFail("unexpected error \(error)")
            }
        }
    }

    func testSymlinkedDirectoryEscapeIsRejectedForMutation() throws {
        try FileManager.default.createSymbolicLink(
            at: workspaceURL.appendingPathComponent("evil"),
            withDestinationURL: outsideURL
        )
        let access = try makeAccess()
        XCTAssertThrowsError(
            try access.resolveForMutation(try WorkspacePath("evil/new.txt"))
        ) { error in
            guard case WorkspaceAccessError.symlinkEscapesWorkspace = error else {
                return XCTFail("unexpected error \(error)")
            }
        }
    }

    func testInternalSymlinkIsAllowed() throws {
        try FileManager.default.createSymbolicLink(
            at: workspaceURL.appendingPathComponent("alias"),
            withDestinationURL: workspaceURL.appendingPathComponent("src")
        )
        let access = try makeAccess()
        let url = try access.resolveForReading(try WorkspacePath("alias/main.swift"))
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "hello")
    }

    func testMutationOfNewFileInExistingDirectory() throws {
        let access = try makeAccess()
        let url = try access.resolveForMutation(try WorkspacePath("src/new.swift"))
        XCTAssertTrue(url.path.hasSuffix("/src/new.swift"))
    }

    func testMutationWithMissingIntermediateDirectories() throws {
        let access = try makeAccess()
        let url = try access.resolveForMutation(try WorkspacePath("deep/nested/dir/file.txt"))
        XCTAssertTrue(url.path.hasSuffix("/deep/nested/dir/file.txt"))
        // The resolved path must still live under the canonical root.
        let relative = try access.makeRelative(
            url.deletingLastPathComponent().deletingLastPathComponent()
        )
        XCTAssertEqual(relative.value, "deep/nested")
    }

    func testMakeRelativeRejectsOutsidePaths() throws {
        let access = try makeAccess()
        XCTAssertThrowsError(
            try access.makeRelative(outsideURL.appendingPathComponent("secret.txt"))
        )
        XCTAssertThrowsError(try access.makeRelative(access.rootURL))
        let inside = try access.makeRelative(
            workspaceURL.appendingPathComponent("src/main.swift")
        )
        XCTAssertEqual(inside.value, "src/main.swift")
    }

    func testMissingRootFails() {
        let missing = workspaceURL.deletingLastPathComponent().appendingPathComponent("nope")
        XCTAssertThrowsError(
            try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: missing)
        ) { error in
            XCTAssertEqual(error as? WorkspaceAccessError, .rootUnavailable)
        }
    }

    func testFileRootFails() throws {
        let filePath = workspaceURL.appendingPathComponent("src/main.swift")
        XCTAssertThrowsError(
            try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: filePath)
        ) { error in
            XCTAssertEqual(error as? WorkspaceAccessError, .rootIsNotADirectory)
        }
    }

    func testBookmarkRoundTrip() throws {
        let bookmark = try WorkspaceAccess.makeBookmark(for: workspaceURL)
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), bookmarkData: bookmark)
        let url = try access.resolveForReading(try WorkspacePath("src/main.swift"))
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "hello")
    }

    func testGitDetection() throws {
        let access = try makeAccess()
        XCTAssertFalse(access.isGitRepository)
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent(".git"),
            withIntermediateDirectories: true
        )
        XCTAssertTrue(access.isGitRepository)
    }
}
