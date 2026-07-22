import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class WorkspaceIndexServiceTests: XCTestCase {
    private var workspaceURL: URL!
    private var index: WorkspaceIndexService!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-index-\(UUID().uuidString)")
        let files: [String: String] = [
            "README.md": "# Demo\nhello index\n",
            "src/main.swift": "let answer = 42\nprint(answer)\n",
            "src/util/helper.swift": "func helper() {}\n",
            "src/util/notes.txt": "helper notes\nanswer inside\n",
            "tests/main_test.swift": "assert(answer == 42)\n",
            "build/generated.swift": "// generated\n",
            "logs/app.log": "answer everywhere\n",
            ".gitignore": "build/\n*.log\n",
        ]
        for (path, contents) in files {
            let url = workspaceURL.appendingPathComponent(path)
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try contents.write(to: url, atomically: true, encoding: .utf8)
        }
        // Binary file: must be skipped by grep.
        try Data([0x00, 0x01, 0x02, 0x61, 0x6E, 0x73, 0x77, 0x65, 0x72]).write(
            to: workspaceURL.appendingPathComponent("src/blob.bin")
        )
        // node_modules: built-in exclusion.
        let nodeURL = workspaceURL.appendingPathComponent("node_modules/pkg")
        try FileManager.default.createDirectory(at: nodeURL, withIntermediateDirectories: true)
        try "answer".write(
            to: nodeURL.appendingPathComponent("index.js"),
            atomically: true,
            encoding: .utf8
        )
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        index = WorkspaceIndexService(access: access)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    func testListDirectoryRootExcludesIgnoredAndBuiltin() async throws {
        let entries = try await index.listDirectory(nil)
        let names = entries.map(\.path.value)
        XCTAssertTrue(names.contains("README.md"))
        XCTAssertTrue(names.contains("src"))
        XCTAssertTrue(names.contains("tests"))
        XCTAssertFalse(names.contains("build"), "gitignored directory must be hidden")
        XCTAssertFalse(names.contains("node_modules"))
        // Directories sort before files.
        XCTAssertTrue(entries.first?.isDirectory == true)
    }

    func testListSubdirectory() async throws {
        let entries = try await index.listDirectory(try WorkspacePath("src"))
        let names = entries.map(\.path.value)
        XCTAssertTrue(names.contains("src/main.swift"))
        XCTAssertTrue(names.contains("src/util"))
        do {
            _ = try await index.listDirectory(try WorkspacePath("README.md"))
            XCTFail("expected notADirectory")
        } catch let error as WorkspaceIndexError {
            XCTAssertEqual(error, .notADirectory(path: "README.md"))
        }
    }

    func testFindFilesByName() async throws {
        let matches = try await index.findFiles(nameContains: "main", limit: 10)
        let names = Set(matches.map(\.path.value))
        XCTAssertEqual(names, ["src/main.swift", "tests/main_test.swift"])
    }

    func testGlobRespectsIgnores() async throws {
        let matches = try await index.glob("**/*.swift", limit: 100)
        let names = Set(matches.map(\.path.value))
        XCTAssertEqual(
            names,
            ["src/main.swift", "src/util/helper.swift", "tests/main_test.swift"],
            "gitignored build/generated.swift must not appear"
        )
    }

    func testGrepLiteralAndLimits() async throws {
        let matches = try await index.grep(GrepQuery(pattern: "answer"))
        let paths = Set(matches.map(\.path.value))
        XCTAssertTrue(paths.contains("src/main.swift"))
        XCTAssertTrue(paths.contains("src/util/notes.txt"))
        XCTAssertTrue(paths.contains("tests/main_test.swift"))
        XCTAssertFalse(paths.contains("logs/app.log"), "gitignored")
        XCTAssertFalse(paths.contains("src/blob.bin"), "binary")

        let limited = try await index.grep(GrepQuery(pattern: "answer", maximumMatches: 2))
        XCTAssertEqual(limited.count, 2)
    }

    func testGrepWithIncludeGlobAndRegex() async throws {
        let swiftOnly = try await index.grep(
            GrepQuery(pattern: "answer", includeGlob: "**/*.swift")
        )
        XCTAssertTrue(swiftOnly.allSatisfy { $0.path.value.hasSuffix(".swift") })

        let regex = try await index.grep(
            GrepQuery(pattern: "let [a-z]+ = \\d+", isRegex: true)
        )
        XCTAssertEqual(regex.count, 1)
        XCTAssertEqual(regex.first?.path.value, "src/main.swift")
        XCTAssertEqual(regex.first?.lineNumber, 1)

        do {
            _ = try await index.grep(GrepQuery(pattern: "[unclosed", isRegex: true))
            XCTFail("expected invalid pattern")
        } catch let error as WorkspaceIndexError {
            XCTAssertEqual(error, .invalidPattern)
        }
    }

    func testWalkCancellation() async throws {
        let index = self.index!
        let task = Task {
            try await index.grep(GrepQuery(pattern: "anything", maximumMatches: 10_000))
        }
        task.cancel()
        do {
            _ = try await task.value
            // Fast walks may finish before the cancellation lands; both
            // outcomes are acceptable as long as nothing hangs.
        } catch is CancellationError {
            // expected
        }
    }
}
