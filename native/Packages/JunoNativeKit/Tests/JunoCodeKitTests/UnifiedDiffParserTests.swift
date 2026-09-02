import XCTest

@testable import JunoCodeKit

final class UnifiedDiffParserTests: XCTestCase {
    private let gitDiff = """
    diff --git a/src/app.ts b/src/app.ts
    index 3f2a1b0..9c8d7e6 100644
    --- a/src/app.ts
    +++ b/src/app.ts
    @@ -1,4 +1,5 @@ import
     import { a } from "./a";
    -import { b } from "./b";
    +import { b, c } from "./b";
    +import { d } from "./d";
     export const x = 1;
    @@ -10,2 +11,2 @@
    -const y = 2;
    +const y = 3;
     const z = 4;
    diff --git a/README.md b/README.md
    new file mode 100644
    --- /dev/null
    +++ b/README.md
    @@ -0,0 +1,2 @@
    +# Hello
    +World
    \\ No newline at end of file
    """

    func testParsesFilesHunksAndCounts() {
        let diff = UnifiedDiff.parse(gitDiff)

        XCTAssertEqual(diff.files.map(\.path), ["src/app.ts", "README.md"])
        XCTAssertEqual(diff.files[0].hunks.count, 2)
        XCTAssertEqual(diff.files[0].additions, 3)
        XCTAssertEqual(diff.files[0].deletions, 2)
        XCTAssertEqual(diff.files[0].status, .modified)
        XCTAssertEqual(diff.files[1].status, .added)
        XCTAssertEqual(diff.files[1].additions, 2)
        XCTAssertEqual(diff.additions, 5)
        XCTAssertEqual(diff.deletions, 2)
    }

    func testGutterNumbersFollowTheHunkHeader() {
        let diff = UnifiedDiff.parse(gitDiff)
        let hunk = diff.files[0].hunks[0]

        XCTAssertEqual(hunk.oldStart, 1)
        XCTAssertEqual(hunk.newStart, 1)
        XCTAssertEqual(hunk.lines.map(\.kind), [.context, .deletion, .addition, .addition, .context])
        XCTAssertEqual(hunk.lines.map(\.oldNumber), [1, 2, nil, nil, 3])
        XCTAssertEqual(hunk.lines.map(\.newNumber), [1, nil, 2, 3, 4])

        let second = diff.files[0].hunks[1]
        XCTAssertEqual(second.oldStart, 10)
        XCTAssertEqual(second.newStart, 11)
        XCTAssertEqual(second.lines.first?.oldNumber, 10)
        XCTAssertEqual(second.lines.last?.newNumber, 12)
    }

    func testNoNewlineMarkerIsKept() {
        let diff = UnifiedDiff.parse(gitDiff)
        let last = diff.files[1].hunks[0].lines.last
        XCTAssertEqual(last?.kind, .marker)
        XCTAssertEqual(last?.text, "No newline at end of file")
    }

    func testHeaderlessHunkStillRenders() {
        // Some hosts send only the hunk body of a single change.
        let diff = UnifiedDiff.parse("""
        -old line
        +new line
         same
        """)
        XCTAssertEqual(diff.files.count, 1)
        XCTAssertEqual(diff.files[0].hunks.count, 1)
        XCTAssertEqual(diff.files[0].hunks[0].lines.map(\.kind), [.deletion, .addition, .context])
        XCTAssertEqual(diff.additions, 1)
        XCTAssertEqual(diff.deletions, 1)
    }

    func testBareOldNewHeadersWithoutGitLine() {
        let diff = UnifiedDiff.parse("""
        --- a/lib/x.swift
        +++ b/lib/x.swift
        @@ -3,1 +3,1 @@
        -let a = 1
        +let a = 2
        """)
        XCTAssertEqual(diff.files.map(\.path), ["lib/x.swift"])
        XCTAssertEqual(diff.files[0].hunks[0].lines.map(\.oldNumber), [3, nil])
    }

    func testDeletedAndRenamedFiles() {
        let diff = UnifiedDiff.parse("""
        diff --git a/old.txt b/old.txt
        deleted file mode 100644
        --- a/old.txt
        +++ /dev/null
        @@ -1,1 +0,0 @@
        -gone
        diff --git a/a.txt b/b.txt
        similarity index 90%
        rename from a.txt
        rename to b.txt
        --- a/a.txt
        +++ b/b.txt
        @@ -1,1 +1,1 @@
        -x
        +y
        """)
        XCTAssertEqual(diff.files[0].status, .deleted)
        XCTAssertEqual(diff.files[1].status, .renamed)
        XCTAssertEqual(diff.files[1].oldPath, "a.txt")
        XCTAssertEqual(diff.files[1].newPath, "b.txt")
    }

    func testBinaryFile() {
        let diff = UnifiedDiff.parse("""
        diff --git a/icon.png b/icon.png
        Binary files a/icon.png and b/icon.png differ
        """)
        XCTAssertEqual(diff.files.count, 1)
        XCTAssertEqual(diff.files[0].status, .binary)
        XCTAssertTrue(diff.files[0].hunks.isEmpty)
    }

    func testEmptyInput() {
        XCTAssertTrue(UnifiedDiff.parse("").files.isEmpty)
        XCTAssertTrue(UnifiedDiff.parse("").isEmpty)
    }

    func testLineIdentifiersAreUniqueWithinAFile() {
        let diff = UnifiedDiff.parse(gitDiff)
        for file in diff.files {
            let ids = file.hunks.flatMap { $0.lines.map(\.id) }
            XCTAssertEqual(Set(ids).count, ids.count, "duplicate line id in \(file.path)")
        }
    }
}
