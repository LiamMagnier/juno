import XCTest
@testable import JunoCodeCore

final class DiffEngineTests: XCTestCase {
    func testIdenticalInputsProduceEmptyDiff() throws {
        let diff = try DiffEngine.diff(old: "a\nb\nc\n", new: "a\nb\nc\n")
        XCTAssertTrue(diff.isEmpty)
        XCTAssertEqual(diff.linesAdded, 0)
        XCTAssertEqual(diff.linesRemoved, 0)
    }

    func testSimpleLineChange() throws {
        let diff = try DiffEngine.diff(old: "a\nb\nc\n", new: "a\nB\nc\n")
        XCTAssertEqual(diff.linesAdded, 1)
        XCTAssertEqual(diff.linesRemoved, 1)
        XCTAssertEqual(diff.hunks.count, 1)
        let kinds = diff.hunks[0].lines.map(\.kind)
        XCTAssertEqual(kinds, [.context, .removed, .added, .context])
        let removed = diff.hunks[0].lines.first { $0.kind == .removed }
        XCTAssertEqual(removed?.text, "b")
        XCTAssertEqual(removed?.oldLineNumber, 2)
        XCTAssertNil(removed?.newLineNumber)
        let added = diff.hunks[0].lines.first { $0.kind == .added }
        XCTAssertEqual(added?.text, "B")
        XCTAssertEqual(added?.newLineNumber, 2)
    }

    func testPureAdditionAndRemoval() throws {
        let addition = try DiffEngine.diff(old: "", new: "x\ny\n")
        XCTAssertEqual(addition.linesAdded, 2)
        XCTAssertEqual(addition.linesRemoved, 0)
        XCTAssertEqual(addition.hunks.count, 1)

        let removal = try DiffEngine.diff(old: "x\ny\n", new: "")
        XCTAssertEqual(removal.linesAdded, 0)
        XCTAssertEqual(removal.linesRemoved, 2)
    }

    func testDistantChangesProduceSeparateHunks() throws {
        let old = (1...40).map(String.init).joined(separator: "\n") + "\n"
        var newLines = (1...40).map(String.init)
        newLines[0] = "one"
        newLines[39] = "forty"
        let new = newLines.joined(separator: "\n") + "\n"
        let diff = try DiffEngine.diff(old: old, new: new)
        XCTAssertEqual(diff.hunks.count, 2)
        XCTAssertEqual(diff.linesAdded, 2)
        XCTAssertEqual(diff.linesRemoved, 2)
        XCTAssertLessThanOrEqual(diff.hunks[0].lines.count, 5)
    }

    func testNearbyChangesMergeIntoOneHunk() throws {
        let old = (1...10).map(String.init).joined(separator: "\n") + "\n"
        var newLines = (1...10).map(String.init)
        newLines[2] = "three"
        newLines[5] = "six"
        let new = newLines.joined(separator: "\n") + "\n"
        let diff = try DiffEngine.diff(old: old, new: new)
        XCTAssertEqual(diff.hunks.count, 1)
    }

    func testHunkHeaderNumbers() throws {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\n"
        let new = "a\nb\nc\nd\nE\nf\ng\nh\n"
        let diff = try DiffEngine.diff(old: old, new: new)
        XCTAssertEqual(diff.hunks.count, 1)
        let hunk = diff.hunks[0]
        XCTAssertEqual(hunk.oldStart, 2)
        XCTAssertEqual(hunk.newStart, 2)
        XCTAssertEqual(hunk.oldCount, 7)
        XCTAssertEqual(hunk.newCount, 7)
        XCTAssertEqual(hunk.header, "@@ -2,7 +2,7 @@")
    }

    func testTrailingNewlineModelMatchesGit() {
        XCTAssertEqual(DiffEngine.splitLines("a\n"), ["a"])
        XCTAssertEqual(DiffEngine.splitLines("a"), ["a"])
        XCTAssertEqual(DiffEngine.splitLines(""), [])
        XCTAssertEqual(DiffEngine.splitLines("a\n\n"), ["a", ""])
    }

    func testOversizedInputThrows() {
        let big = String(repeating: "x", count: DiffEngine.maximumInputBytes + 1)
        XCTAssertThrowsError(try DiffEngine.diff(old: big, new: "")) { error in
            XCTAssertEqual(error as? DiffEngineError, .inputTooLarge)
        }
    }

    func testMoveHeavyDiffRemainsCorrect() throws {
        let old = "one\ntwo\nthree\nfour\n"
        let new = "four\nthree\ntwo\none\n"
        let diff = try DiffEngine.diff(old: old, new: new)
        // Reconstruct: applying the diff to old must produce new.
        var reconstructed: [String] = []
        for hunk in diff.hunks {
            for line in hunk.lines where line.kind != .removed {
                reconstructed.append(line.text)
            }
        }
        XCTAssertEqual(reconstructed, DiffEngine.splitLines(new))
    }
}
