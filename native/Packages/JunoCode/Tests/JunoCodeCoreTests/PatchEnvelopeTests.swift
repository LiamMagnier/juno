import XCTest
@testable import JunoCodeCore

/// The `*** Begin Patch` envelope: what it parses to, how hunks find their
/// place, and the ways a bad patch is refused before anything is written.
final class PatchEnvelopeTests: XCTestCase {
    // MARK: - Parsing

    func testParsesEveryOperationKind() throws {
        let envelope = try PatchEnvelope.parse("""
            *** Begin Patch
            *** Add File: docs/new.md
            +# Title
            +
            +Body
            *** Update File: src/app.swift
            *** Move to: src/main.swift
            @@ func run() {
                 let a = 1
            -    let b = 2
            +    let b = 3
            *** Delete File: old.txt
            *** End Patch
            """)
        XCTAssertEqual(envelope.operations.count, 3)
        XCTAssertEqual(envelope.operations[0], .add(path: "docs/new.md", content: "# Title\n\nBody\n"))
        XCTAssertEqual(
            envelope.operations[1],
            .update(
                path: "src/app.swift",
                moveTo: "src/main.swift",
                hunks: [
                    PatchEnvelope.Hunk(
                        context: "func run() {",
                        oldLines: ["    let a = 1", "    let b = 2"],
                        newLines: ["    let a = 1", "    let b = 3"]
                    ),
                ]
            )
        )
        XCTAssertEqual(envelope.operations[2], .delete(path: "old.txt"))
        XCTAssertEqual(envelope.paths, ["docs/new.md", "src/app.swift", "src/main.swift", "old.txt"])
    }

    func testAFirstHunkMayOmitItsAtAtLineAndARangeHeaderIsNotAnAnchor() throws {
        let bare = try PatchEnvelope.parse("""
            *** Begin Patch
            *** Update File: a.txt
             one
            -two
            +2
            *** End Patch
            """)
        guard case let .update(_, _, hunks) = bare.operations[0] else { return XCTFail() }
        XCTAssertNil(hunks[0].context)

        let unified = try PatchEnvelope.parse("""
            *** Begin Patch
            *** Update File: a.txt
            @@ -1,2 +1,2 @@
             one
            -two
            +2
            *** End Patch
            """)
        guard case let .update(_, _, rangeHunks) = unified.operations[0] else { return XCTFail() }
        XCTAssertNil(rangeHunks[0].context, "line numbers are not text to search for")
    }

    func testRefusesMalformedPatches() {
        XCTAssertThrowsError(try PatchEnvelope.parse("*** Update File: a\n-x\n+y\n*** End Patch")) {
            XCTAssertEqual($0 as? PatchEnvelopeError, .missingBegin)
        }
        XCTAssertThrowsError(try PatchEnvelope.parse("*** Begin Patch\n*** Delete File: a")) {
            XCTAssertEqual($0 as? PatchEnvelopeError, .missingEnd)
        }
        XCTAssertThrowsError(try PatchEnvelope.parse("*** Begin Patch\n*** End Patch")) {
            XCTAssertEqual($0 as? PatchEnvelopeError, .empty)
        }
        XCTAssertThrowsError(try PatchEnvelope.parse("*** Begin Patch\n*** Update File: a\n*** End Patch")) {
            XCTAssertEqual($0 as? PatchEnvelopeError, .updateWithoutChanges(path: "a"))
        }
        XCTAssertThrowsError(try PatchEnvelope.parse("""
            *** Begin Patch
            *** Delete File: a
            *** Delete File: a
            *** End Patch
            """)) {
            XCTAssertEqual($0 as? PatchEnvelopeError, .duplicatePath("a"))
        }
        XCTAssertThrowsError(try PatchEnvelope.parse("""
            *** Begin Patch
            *** Add File: a
            no plus sign
            *** End Patch
            """)) { error in
            guard case .invalidLine(3, _, _) = error as? PatchEnvelopeError else {
                return XCTFail("\(error)")
            }
        }
        XCTAssertThrowsError(try PatchEnvelope.parse("""
            *** Begin Patch
            *** Rename File: a
            *** End Patch
            """))
    }

    // MARK: - Applying

    func testAppliesHunksInOrderUnderTheirAnchors() throws {
        let source = """
            struct A {
                func run() {
                    let value = 1
                }
            }
            struct B {
                func run() {
                    let value = 1
                }
            }

            """
        let hunks = [
            PatchEnvelope.Hunk(
                context: "struct B {",
                oldLines: ["    func run() {", "        let value = 1"],
                newLines: ["    func run() {", "        let value = 2"]
            ),
        ]
        let updated = try PatchEnvelope.apply(hunks, to: source, path: "a.swift")
        XCTAssertTrue(updated.contains("struct A {\n    func run() {\n        let value = 1"))
        XCTAssertTrue(updated.contains("struct B {\n    func run() {\n        let value = 2"))
        XCTAssertTrue(updated.hasSuffix("}\n"))
    }

    func testMatchesLooselyWhenWhitespaceOrPunctuationDrifted() throws {
        let source = "let title = “Hello”   \nlet x = 1\n"
        let updated = try PatchEnvelope.apply(
            [PatchEnvelope.Hunk(oldLines: ["let title = \"Hello\"", "let x = 1"], newLines: ["let title = \"Hello\"", "let x = 2"])],
            to: source,
            path: "a.swift"
        )
        XCTAssertEqual(updated, "let title = \"Hello\"\nlet x = 2\n")
    }

    func testEndOfFileHunksMatchTheLastLines() throws {
        let source = "x\ny\nx\ny\n"
        let updated = try PatchEnvelope.apply(
            [PatchEnvelope.Hunk(oldLines: ["x", "y"], newLines: ["x", "z"], isEndOfFile: true)],
            to: source,
            path: "a"
        )
        XCTAssertEqual(updated, "x\ny\nx\nz\n")
    }

    func testKeepsCRLFAndAMissingTrailingNewline() throws {
        let crlf = try PatchEnvelope.apply(
            [PatchEnvelope.Hunk(oldLines: ["b"], newLines: ["B", "b2"])],
            to: "a\r\nb\r\nc\r\n",
            path: "a"
        )
        XCTAssertEqual(crlf, "a\r\nB\r\nb2\r\nc\r\n")

        let unterminated = try PatchEnvelope.apply(
            [PatchEnvelope.Hunk(oldLines: ["c"], newLines: ["C"])],
            to: "a\nc",
            path: "a"
        )
        XCTAssertEqual(unterminated, "a\nC")
    }

    func testAPureInsertionGoesUnderItsAnchorOrAtTheEnd() throws {
        let anchored = try PatchEnvelope.apply(
            [PatchEnvelope.Hunk(context: "import Foundation", oldLines: [], newLines: ["import os"])],
            to: "import Foundation\n\nlet a = 1\n",
            path: "a"
        )
        XCTAssertEqual(anchored, "import Foundation\nimport os\n\nlet a = 1\n")

        let appended = try PatchEnvelope.apply(
            [PatchEnvelope.Hunk(oldLines: [], newLines: ["last"])],
            to: "first\n",
            path: "a"
        )
        XCTAssertEqual(appended, "first\nlast\n")
    }

    func testAHunkThatDoesNotMatchNamesItself() {
        XCTAssertThrowsError(
            try PatchEnvelope.apply(
                [
                    PatchEnvelope.Hunk(oldLines: ["a"], newLines: ["A"]),
                    PatchEnvelope.Hunk(oldLines: ["missing"], newLines: ["x"]),
                ],
                to: "a\nb\n",
                path: "f.txt"
            )
        ) { error in
            guard case .hunkNotFound("f.txt", 2, _) = error as? PatchEnvelopeError else {
                return XCTFail("\(error)")
            }
        }
        XCTAssertThrowsError(
            try PatchEnvelope.apply(
                [PatchEnvelope.Hunk(context: "nowhere", oldLines: ["a"], newLines: ["A"])],
                to: "a\n",
                path: "f.txt"
            )
        ) { error in
            XCTAssertEqual(error as? PatchEnvelopeError, .contextNotFound(path: "f.txt", context: "nowhere"))
        }
    }

    func testHunksSearchOnlyAfterThePreviousOne() throws {
        // The second hunk's lines exist above the first match too; order is
        // what disambiguates repeated code.
        let updated = try PatchEnvelope.apply(
            [
                PatchEnvelope.Hunk(oldLines: ["marker"], newLines: ["marker"]),
                PatchEnvelope.Hunk(oldLines: ["value"], newLines: ["changed"]),
            ],
            to: "value\nmarker\nvalue\n",
            path: "a"
        )
        XCTAssertEqual(updated, "value\nmarker\nchanged\n")
    }

    // MARK: - Multi-edit

    func testMultiEditAppliesInOrderOrNotAtAll() throws {
        let edited = try MultiEdit.apply(
            [
                TextPatch(target: "alpha", replacement: "beta"),
                TextPatch(target: "beta gamma", replacement: "delta"),
                TextPatch(target: "x", replacement: "y", replaceAll: true),
            ],
            to: "alpha gamma x x\n"
        )
        XCTAssertEqual(edited, "delta y y\n")

        XCTAssertThrowsError(
            try MultiEdit.apply(
                [TextPatch(target: "a", replacement: "b"), TextPatch(target: "zzz", replacement: "q")],
                to: "a\n"
            )
        ) { error in
            XCTAssertEqual(error as? MultiEditError, .editFailed(index: 1, underlying: .targetNotFound))
            XCTAssertTrue(String(describing: error).contains("Edit 2"))
        }
        XCTAssertThrowsError(try MultiEdit.apply([], to: "a")) {
            XCTAssertEqual($0 as? MultiEditError, .noEdits)
        }
    }
}
