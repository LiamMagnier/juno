import XCTest
@testable import JunoCodeCore

final class GitAndTestParsingTests: XCTestCase {
    func testStatusParserBranchHeader() {
        let summary = GitStatusParser.parse("""
        ## main...origin/main [ahead 2, behind 1]
         M src/app.swift
        A  new.txt
        ?? untracked.txt
        """)
        XCTAssertEqual(summary.branch, "main")
        XCTAssertEqual(summary.upstream, "origin/main")
        XCTAssertEqual(summary.ahead, 2)
        XCTAssertEqual(summary.behind, 1)
        XCTAssertEqual(summary.files.count, 3)
        XCTAssertEqual(summary.stagedCount, 1)
        XCTAssertEqual(summary.untrackedCount, 1)
        XCTAssertFalse(summary.isClean)
        XCTAssertFalse(summary.hasConflicts)

        let modified = summary.files[0]
        XCTAssertEqual(modified.path, "src/app.swift")
        XCTAssertFalse(modified.isStaged)
        XCTAssertTrue(modified.hasUnstagedChanges)
    }

    func testStatusParserDetachedAndCleanStates() {
        let detached = GitStatusParser.parse("## HEAD (no branch)\n")
        XCTAssertNil(detached.branch)
        XCTAssertTrue(detached.isClean)

        let fresh = GitStatusParser.parse("## No commits yet on main\n?? a.txt\n")
        XCTAssertEqual(fresh.branch, "main")
        XCTAssertEqual(fresh.untrackedCount, 1)
    }

    func testStatusParserConflicts() {
        let summary = GitStatusParser.parse("""
        ## feature
        UU conflicted.swift
        """)
        XCTAssertTrue(summary.hasConflicts)
    }

    func testXCTestSummaryParsing() {
        let output = """
        Test Suite 'X' passed.
        \t Executed 5 tests, with 0 failures (0 unexpected) in 0.1 (0.1) seconds
        Test Suite 'All tests' passed.
        \t Executed 52 tests, with 2 failures (0 unexpected) in 0.5 (0.5) seconds
        """
        let outcome = TestOutputParser.parse(
            command: "swift test",
            output: output,
            exitCode: 1,
            durationSeconds: 3
        )
        XCTAssertEqual(outcome.testsRun, 52)
        XCTAssertEqual(outcome.failures, 2)
        XCTAssertFalse(outcome.passed)
    }

    func testJestSummaryParsing() {
        let outcome = TestOutputParser.parse(
            command: "npm test",
            output: "Tests:       1 failed, 5 passed, 6 total\n",
            exitCode: 1,
            durationSeconds: 2
        )
        XCTAssertEqual(outcome.testsRun, 6)
        XCTAssertEqual(outcome.failures, 1)
    }

    func testPytestSummaryParsing() {
        let outcome = TestOutputParser.parse(
            command: "pytest",
            output: "========== 3 passed, 1 failed in 2.34s ==========\n",
            exitCode: 1,
            durationSeconds: 3
        )
        XCTAssertEqual(outcome.testsRun, 4)
        XCTAssertEqual(outcome.failures, 1)

        let passing = TestOutputParser.parse(
            command: "pytest",
            output: "===== 7 passed in 0.5s =====\n",
            exitCode: 0,
            durationSeconds: 1
        )
        XCTAssertEqual(passing.testsRun, 7)
        XCTAssertEqual(passing.failures, 0)
        XCTAssertTrue(passing.passed)
    }

    func testCargoSummaryParsing() {
        let outcome = TestOutputParser.parse(
            command: "cargo test",
            output: "test result: ok. 10 passed; 0 failed; 0 ignored\n",
            exitCode: 0,
            durationSeconds: 4
        )
        XCTAssertEqual(outcome.testsRun, 10)
        XCTAssertEqual(outcome.failures, 0)
    }

    func testUnknownOutputFallsBackToExitCode() {
        let pass = TestOutputParser.parse(
            command: "./check.sh",
            output: "all good",
            exitCode: 0,
            durationSeconds: 1
        )
        XCTAssertTrue(pass.passed)
        XCTAssertNil(pass.testsRun)

        let fail = TestOutputParser.parse(
            command: "./check.sh",
            output: "boom",
            exitCode: 2,
            durationSeconds: 1
        )
        XCTAssertFalse(fail.passed)
    }
}
