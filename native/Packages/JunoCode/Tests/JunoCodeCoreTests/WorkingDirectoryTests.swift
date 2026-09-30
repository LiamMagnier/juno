import XCTest
@testable import JunoCodeCore

/// How a `cd` argument resolves against a session's current folder.
final class WorkingDirectoryTests: XCTestCase {
    private func resolve(_ target: String, from current: String? = nil) throws -> String? {
        try SessionWorkingDirectories.resolve(
            target,
            from: current.map { try WorkspacePath($0) },
            workspaceRoot: "/Users/me/project"
        )?.value
    }

    func testRelativeTargetsResolveLikeAShell() throws {
        XCTAssertEqual(try resolve("src"), "src")
        XCTAssertEqual(try resolve("lib", from: "src"), "src/lib")
        XCTAssertEqual(try resolve("..", from: "src/lib"), "src")
        XCTAssertEqual(try resolve("./a/../b/", from: "src"), "src/b")
        XCTAssertEqual(try resolve("\"with space\""), "with space")
        XCTAssertNil(try resolve("..", from: "src"), "back to the root")
        XCTAssertNil(try resolve("", from: "src"))
        XCTAssertNil(try resolve("~", from: "src"))
    }

    func testAbsoluteTargetsMustBeInsideTheWorkspace() throws {
        XCTAssertEqual(try resolve("/Users/me/project/app", from: "src"), "app")
        XCTAssertNil(try resolve("/Users/me/project"))
        XCTAssertThrowsError(try resolve("/Users/me/projectile"))
        XCTAssertThrowsError(try resolve("/etc"))
        XCTAssertThrowsError(try resolve("~/Desktop"))
        XCTAssertThrowsError(try resolve("../.."))
    }

    func testEachSessionKeepsItsOwnFolder() throws {
        let directories = SessionWorkingDirectories()
        let first = CodeSessionID()
        let second = CodeSessionID()
        directories.set(try WorkspacePath("src"), for: first)
        XCTAssertEqual(directories.current(for: first)?.value, "src")
        XCTAssertNil(directories.current(for: second))
        directories.set(nil, for: first)
        XCTAssertNil(directories.current(for: first))
    }

    func testAFolderOutlivesARelaunchUntilItsSessionIsForgotten() throws {
        let store = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-cwd-\(UUID().uuidString)")
            .appendingPathComponent("directories.json")
        defer { try? FileManager.default.removeItem(at: store.deletingLastPathComponent()) }
        let session = CodeSessionID()
        let other = CodeSessionID()
        let before = SessionWorkingDirectories(storeURL: store)
        before.set(try WorkspacePath("app/src"), for: session)
        before.set(try WorkspacePath("lib"), for: other)

        // The transcript still says the session moved; so does the next launch.
        let after = SessionWorkingDirectories(storeURL: store)
        XCTAssertEqual(after.current(for: session)?.value, "app/src")
        after.forget(session)
        XCTAssertNil(SessionWorkingDirectories(storeURL: store).current(for: session))
        XCTAssertEqual(SessionWorkingDirectories(storeURL: store).current(for: other)?.value, "lib")
    }
}
