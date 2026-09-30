import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// Search beyond the root `.gitignore`: nested ignore files, worktree copies,
/// context lines, counts, multiline patterns and scoped paths.
final class WorkspaceSearchTests: XCTestCase {
    private var workspaceURL: URL!
    private var index: WorkspaceIndexService!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-search-\(UUID().uuidString)")
        let files: [String: String] = [
            ".gitignore": "*.gen\n",
            "top.log": "needle at the top\n",
            "app/.gitignore": "*.log\n!keep.gen\n",
            "app/debug.log": "needle in a log\n",
            "app/keep.gen": "needle kept by negation\n",
            "app/drop.gen": "needle dropped\n",
            "app/main.swift": "one\ntwo\nneedle three\nfour\nfive\nsix\nneedle seven\neight\n",
            "app/deep/.gitignore": "secret.txt\n",
            "app/deep/secret.txt": "needle hidden deep\n",
            "app/deep/open.txt": "needle open deep\n",
            ".juno/worktrees/copy/app/main.swift": "needle in a juno worktree\n",
            ".claude/worktrees/other/x.swift": "needle in a claude worktree\n",
            "linked/.git": "gitdir: /somewhere/repo/.git/worktrees/linked\n",
            "linked/file.swift": "needle in a linked worktree\n",
            "vendor/sub/.git": "gitdir: ../../.git/modules/sub\n",
            "vendor/sub/lib.swift": "needle in a submodule\n",
            "multi.txt": "func start() {\n    body\n}\nfunc other() {}\n",
        ]
        for (path, contents) in files {
            let url = workspaceURL.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try contents.write(to: url, atomically: true, encoding: .utf8)
        }
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        index = WorkspaceIndexService(access: access)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    private func matchedPaths(_ query: GrepQuery) async throws -> Set<String> {
        Set(try await index.grep(query).map(\.path.value))
    }

    func testNestedGitignoresLayerLikeGit() async throws {
        let paths = try await matchedPaths(GrepQuery(pattern: "needle"))
        XCTAssertTrue(paths.contains("top.log"), "the nested *.log rule does not reach the root")
        XCTAssertFalse(paths.contains("app/debug.log"))
        XCTAssertTrue(paths.contains("app/keep.gen"), "a deeper ! rule re-includes")
        XCTAssertFalse(paths.contains("app/drop.gen"))
        XCTAssertFalse(paths.contains("app/deep/secret.txt"))
        XCTAssertTrue(paths.contains("app/deep/open.txt"))
    }

    func testWorktreeCopiesAreSkippedButSubmodulesAreNot() async throws {
        let paths = try await matchedPaths(GrepQuery(pattern: "needle"))
        XCTAssertFalse(paths.contains { $0.hasPrefix(".juno/worktrees") })
        XCTAssertFalse(paths.contains { $0.hasPrefix(".claude/worktrees") })
        XCTAssertFalse(paths.contains("linked/file.swift"))
        XCTAssertTrue(paths.contains("vendor/sub/lib.swift"))
        let globbed = try await index.glob("**/main.swift", limit: 50).map(\.path.value)
        XCTAssertEqual(globbed, ["app/main.swift"])
    }

    func testAScopedSearchStillObeysTheIgnoreFilesAboveIt() async throws {
        let underApp = try await matchedPaths(GrepQuery(pattern: "needle", path: WorkspacePath("app")))
        XCTAssertTrue(underApp.allSatisfy { $0.hasPrefix("app/") })
        XCTAssertFalse(underApp.contains("app/drop.gen"), "the root's *.gen still applies")
        XCTAssertTrue(underApp.contains("app/keep.gen"))

        let oneFile = try await matchedPaths(GrepQuery(pattern: "needle", path: WorkspacePath("app/main.swift")))
        XCTAssertEqual(oneFile, ["app/main.swift"])

        let ignoredFile = try await matchedPaths(GrepQuery(pattern: "needle", path: WorkspacePath("app/drop.gen")))
        XCTAssertTrue(ignoredFile.isEmpty)

        let listed = try await index.listDirectory(WorkspacePath("app/deep")).map(\.path.value)
        XCTAssertEqual(listed, ["app/deep/open.txt"], "a listing applies every layer too")
    }

    func testContextLinesComeWithEachMatch() async throws {
        let matches = try await index.grep(
            GrepQuery(pattern: "needle", path: WorkspacePath("app/main.swift"), contextBefore: 2, contextAfter: 1)
        )
        XCTAssertEqual(matches.map(\.lineNumber), [3, 7])
        XCTAssertEqual(matches[0].contextBefore, ["one", "two"])
        XCTAssertEqual(matches[0].contextAfter, ["four"])
        XCTAssertEqual(matches[1].contextBefore, ["five", "six"])
        XCTAssertEqual(matches[1].contextAfter, ["eight"])
    }

    func testCountsAndFilesWithMatches() async throws {
        let counts = try await index.grepCounts(GrepQuery(pattern: "needle", path: WorkspacePath("app")))
        XCTAssertEqual(counts.first { $0.path.value == "app/main.swift" }?.count, 2)
        XCTAssertEqual(counts.map(\.path.value), counts.map(\.path.value).sorted())

        let limited = try await index.grepCounts(GrepQuery(pattern: "needle", maximumMatches: 2))
        XCTAssertEqual(limited.count, 2)
    }

    func testMultilineMatchesSpanLines() async throws {
        let regex = try await index.grep(
            GrepQuery(pattern: #"func start\(\) \{.*?\}"#, isRegex: true, multiline: true)
        )
        XCTAssertEqual(regex.count, 1)
        XCTAssertEqual(regex[0].lineNumber, 1)
        XCTAssertEqual(regex[0].endLineNumber, 3)
        XCTAssertEqual(regex[0].lineText, "func start() {\n    body\n}")

        let literal = try await index.grep(GrepQuery(pattern: "body\n}", multiline: true))
        XCTAssertEqual(literal.map(\.lineNumber), [2])
        XCTAssertEqual(literal.first?.endLineNumber, 3)

        // Without multiline the same regex cannot cross a line.
        let single = try await index.grep(GrepQuery(pattern: #"func start\(\) \{.*?\}"#, isRegex: true))
        XCTAssertTrue(single.isEmpty)
    }

    func testAPatternThatMatchesEverythingStopsAtTheLimit() async throws {
        // Every character of a near-megabyte file matches `.`. Gathering all
        // of them, each counted back to the top for its line, never finished.
        let row = String(repeating: "a", count: 63) + "\n"
        try String(repeating: row, count: 15_000)
            .write(to: workspaceURL.appendingPathComponent("big.txt"), atomically: true, encoding: .utf8)
        let started = Date()
        let everything = try await index.grep(GrepQuery(
            pattern: ".", isRegex: true, maximumMatches: 50, path: WorkspacePath("big.txt"),
            contextBefore: 20, contextAfter: 20, multiline: true
        ))
        XCTAssertEqual(everything.count, 50)
        XCTAssertEqual(everything.last?.lineNumber, 1, "every match in the first line, numbered in one pass")
        let spanning = try await index.grep(GrepQuery(
            pattern: "a\na", maximumMatches: 3, path: WorkspacePath("big.txt"), multiline: true
        ))
        XCTAssertEqual(spanning.map(\.lineNumber), [1, 2, 3])
        let lines = try await index.grep(GrepQuery(
            pattern: "a", maximumMatches: 30, path: WorkspacePath("big.txt"), contextBefore: 20, contextAfter: 20
        ))
        XCTAssertEqual(lines.map(\.lineNumber), Array(1...30))
        let count = try await index.grepCounts(GrepQuery(
            pattern: "\n", maximumMatches: 5, path: WorkspacePath("big.txt"), multiline: true
        ))
        XCTAssertEqual(count.first?.count, 15_000)
        XCTAssertLessThan(Date().timeIntervalSince(started), 20)
    }
}
