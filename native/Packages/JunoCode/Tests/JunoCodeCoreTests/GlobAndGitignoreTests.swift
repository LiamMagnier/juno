import XCTest
@testable import JunoCodeCore

final class GlobAndGitignoreTests: XCTestCase {
    func testGlobBasics() throws {
        let swiftFiles = try GlobPattern("**/*.swift")
        XCTAssertTrue(swiftFiles.matches("main.swift"))
        XCTAssertTrue(swiftFiles.matches("Sources/App/main.swift"))
        XCTAssertFalse(swiftFiles.matches("main.swift.bak"))

        let anchored = try GlobPattern("Sources/*.swift")
        XCTAssertTrue(anchored.matches("Sources/main.swift"))
        XCTAssertFalse(anchored.matches("Sources/App/main.swift"))
        XCTAssertFalse(anchored.matches("Other/main.swift"))

        let question = try GlobPattern("file?.txt")
        XCTAssertTrue(question.matches("file1.txt"))
        XCTAssertTrue(question.matches("dir/file2.txt"))
        XCTAssertFalse(question.matches("file12.txt"))
        XCTAssertFalse(question.matches("file/.txt"))
    }

    func testBareNameGlobMatchesAnywhere() throws {
        let name = try GlobPattern("*.md")
        XCTAssertTrue(name.matches("README.md"))
        XCTAssertTrue(name.matches("docs/deep/GUIDE.md"))
        XCTAssertFalse(name.matches("README.mdx"))
    }

    func testDoubleStarInMiddle() throws {
        let pattern = try GlobPattern("src/**/test/*.js")
        XCTAssertTrue(pattern.matches("src/test/a.js"))
        XCTAssertTrue(pattern.matches("src/a/b/test/c.js"))
        XCTAssertFalse(pattern.matches("src/a/b/other/c.js"))
    }

    func testInvalidGlobs() {
        XCTAssertThrowsError(try GlobPattern(""))
        XCTAssertThrowsError(try GlobPattern(String(repeating: "a", count: 2_000)))
    }

    func testGitignoreBasenamePatterns() {
        let matcher = GitignoreMatcher(contents: """
        # comment
        *.log
        build
        """)
        XCTAssertTrue(matcher.isIgnored("debug.log", isDirectory: false))
        XCTAssertTrue(matcher.isIgnored("deep/nested/error.log", isDirectory: false))
        XCTAssertFalse(matcher.isIgnored("log.txt", isDirectory: false))
        XCTAssertTrue(matcher.isIgnored("build", isDirectory: true))
        XCTAssertTrue(matcher.isIgnored("build/output.bin", isDirectory: false))
        XCTAssertTrue(matcher.isIgnored("sub/build", isDirectory: true))
    }

    func testGitignoreAnchoredAndDirectoryOnly() {
        let matcher = GitignoreMatcher(contents: """
        /dist
        cache/
        """)
        XCTAssertTrue(matcher.isIgnored("dist", isDirectory: true))
        XCTAssertTrue(matcher.isIgnored("dist/x.js", isDirectory: false))
        XCTAssertFalse(matcher.isIgnored("packages/dist", isDirectory: true))
        // Directory-only: ignores the directory and files inside it, but not
        // a plain file named "cache".
        XCTAssertTrue(matcher.isIgnored("cache", isDirectory: true))
        XCTAssertTrue(matcher.isIgnored("a/cache/data.bin", isDirectory: false))
        XCTAssertFalse(matcher.isIgnored("cache", isDirectory: false))
    }

    func testGitignoreNegationLastMatchWins() {
        let matcher = GitignoreMatcher(contents: """
        *.env
        !example.env
        """)
        XCTAssertTrue(matcher.isIgnored("prod.env", isDirectory: false))
        XCTAssertFalse(matcher.isIgnored("example.env", isDirectory: false))
        XCTAssertFalse(matcher.isIgnored("config/example.env", isDirectory: false))
    }

    func testGitignoreEmptyAndComments() {
        let matcher = GitignoreMatcher(contents: "\n# only comments\n\n")
        XCTAssertTrue(matcher.isEmpty)
        XCTAssertFalse(matcher.isIgnored("anything", isDirectory: false))
    }
}
