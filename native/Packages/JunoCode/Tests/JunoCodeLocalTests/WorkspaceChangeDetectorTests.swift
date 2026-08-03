import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The honest half of the undo story: a command's edits cannot be reverted, so
/// the least the transcript can do is say which files it touched.
final class WorkspaceChangeDetectorTests: XCTestCase {
    private var rootURL: URL!
    private var detector: WorkspaceChangeDetector!

    override func setUpWithError() throws {
        rootURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-changes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        detector = WorkspaceChangeDetector(rootURL: rootURL)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: rootURL)
    }

    private func write(_ relative: String, _ contents: String) throws {
        let url = rootURL.appendingPathComponent(relative)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try contents.write(to: url, atomically: true, encoding: .utf8)
    }

    private func paths(_ list: [WorkspacePath]) -> [String] { list.map(\.value) }

    func testCreationsModificationsAndDeletionsAreAllReported() async throws {
        try write("keep.txt", "same\n")
        try write("edit.txt", "before\n")
        try write("gone.txt", "doomed\n")
        let before = await detector.snapshot()

        try write("new.txt", "fresh\n")
        try write("edit.txt", "after, and a different length\n")
        try FileManager.default.removeItem(at: rootURL.appendingPathComponent("gone.txt"))

        let report = WorkspaceChangeReport.comparing(
            before: before,
            after: await detector.snapshot()
        )

        XCTAssertEqual(paths(report.created), ["new.txt"])
        XCTAssertEqual(paths(report.modified), ["edit.txt"])
        XCTAssertEqual(paths(report.deleted), ["gone.txt"])
        XCTAssertFalse(report.isPartial)
        XCTAssertEqual(report.count, 3)
    }

    func testACommandThatChangesNothingReportsNothing() async throws {
        try write("a.txt", "unchanged\n")
        let before = await detector.snapshot()
        let report = WorkspaceChangeReport.comparing(
            before: before,
            after: await detector.snapshot()
        )
        XCTAssertTrue(report.isEmpty)
    }

    /// A formatter that swaps two lines leaves the byte count identical, so
    /// size alone would miss it — the modification date is why it does not.
    func testASameSizeEditIsStillDetected() async throws {
        try write("swap.txt", "alpha\nbeta\n")
        let before = await detector.snapshot()

        // The filesystem's timestamp resolution is coarse enough that an
        // immediate rewrite can land in the same tick.
        try await Task.sleep(for: .milliseconds(20))
        try write("swap.txt", "beta\nalpha\n")

        let report = WorkspaceChangeReport.comparing(
            before: before,
            after: await detector.snapshot()
        )
        XCTAssertEqual(paths(report.modified), ["swap.txt"])
    }

    /// Build products and dependency trees churn on every command and would
    /// bury the real edits.
    func testNoisyDirectoriesAreNotScanned() async throws {
        try write("src/real.swift", "let a = 1\n")
        try write("node_modules/pkg/index.js", "module.exports = {}\n")
        try write(".build/debug/thing.o", "binary-ish\n")
        try write(".git/objects/ab/cdef", "object\n")

        let snapshot = await detector.snapshot()
        let scanned = Set(snapshot.stamps.keys.map(\.value))

        XCTAssertTrue(scanned.contains("src/real.swift"))
        XCTAssertFalse(scanned.contains { $0.hasPrefix("node_modules/") })
        XCTAssertFalse(scanned.contains { $0.hasPrefix(".build/") })
        XCTAssertFalse(scanned.contains { $0.hasPrefix(".git/") })
    }

    /// A scan that stopped early must say so, or a partial list reads as a
    /// complete one — which is the exact overclaim this feature exists to end.
    func testATruncatedScanMarksTheReportPartial() async throws {
        for index in 0..<12 {
            try write("file-\(index).txt", "x\n")
        }
        let small = WorkspaceChangeDetector(rootURL: rootURL, fileCeiling: 5)
        let snapshot = await small.snapshot()

        XCTAssertTrue(snapshot.wasTruncated)
        XCTAssertEqual(snapshot.stamps.count, 5)

        let report = WorkspaceChangeReport.comparing(before: snapshot, after: snapshot)
        XCTAssertTrue(report.isPartial)
    }

}
