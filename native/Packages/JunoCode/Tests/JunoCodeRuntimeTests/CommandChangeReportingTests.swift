import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// What `run_command` tells the reader about the files it touched.
///
/// The rule this enforces: a command's edits are real and are *not* undoable,
/// so the summary must list them and must not imply a checkpoint exists.
final class CommandChangeReportingTests: XCTestCase {
    private func path(_ value: String) throws -> WorkspacePath {
        try WorkspacePath(value)
    }

    func testTheSummaryStatesTheChangesCannotBeUndone() throws {
        let report = WorkspaceChangeReport(
            created: [try path("a.txt")],
            modified: [],
            deleted: [],
            isPartial: false
        )
        let summary = RunCommandTool.changeSummary(report)

        XCTAssertTrue(summary.contains("1 added"))
        XCTAssertTrue(summary.contains("not checkpointed"))
        XCTAssertTrue(summary.contains("cannot be undone"))
    }

    func testEveryCategoryIsCounted() throws {
        let report = WorkspaceChangeReport(
            created: [try path("a.txt")],
            modified: [try path("b.txt"), try path("c.txt")],
            deleted: [try path("d.txt")],
            isPartial: false
        )
        let summary = RunCommandTool.changeSummary(report)

        XCTAssertTrue(summary.contains("1 added"))
        XCTAssertTrue(summary.contains("2 changed"))
        XCTAssertTrue(summary.contains("1 deleted"))
        XCTAssertFalse(summary.contains("at least"))
    }

    /// A scan that stopped early must not present its list as the whole set.
    func testAPartialSummarySaysAtLeast() throws {
        let report = WorkspaceChangeReport(
            created: [try path("a.txt")],
            modified: [try path("b.txt")],
            deleted: [],
            isPartial: true
        )
        XCTAssertTrue(RunCommandTool.changeSummary(report).contains("at least"))
    }
}
