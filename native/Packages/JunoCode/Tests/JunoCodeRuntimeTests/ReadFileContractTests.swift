import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// What `read_file` actually hands a model, and what `write_file` /
/// `apply_patch` accept back.
///
/// `FileOperationService` computed a fingerprint all along; the tool result
/// never carried it, so the contract the tool description promised did not
/// exist end to end. These lock the wire shape, because it is the only thing a
/// model can act on.
final class ReadFileContractTests: XCTestCase {
    private func result(
        path: String = "src/a.swift",
        content: String,
        truncated: Bool = false,
        fullContent: String? = nil
    ) throws -> FileReadResult {
        let whole = fullContent ?? content
        return FileReadResult(
            path: try WorkspacePath(path),
            content: content,
            wasTruncated: truncated,
            fingerprint: FileFingerprint(of: whole),
            byteCount: whole.utf8.count,
            // As FileOperationService counts them.
            lineCount: DiffEngine.splitLines(whole).count
        )
    }

    /// The header is one line and the content starts after the first newline,
    /// so the split stays unambiguous for a file that itself begins with `{`.
    private func split(_ rendered: String) -> (header: String, body: String) {
        guard let newline = rendered.firstIndex(of: "\n") else {
            return (rendered, "")
        }
        return (
            String(rendered[rendered.startIndex..<newline]),
            String(rendered[rendered.index(after: newline)...])
        )
    }

    private func headerFields(_ rendered: String) throws -> [String: Any] {
        let header = split(rendered).header
        let object = try JSONSerialization.jsonObject(with: Data(header.utf8))
        return try XCTUnwrap(object as? [String: Any])
    }

    // MARK: - Complete reads

    func testACompleteReadCarriesTheFingerprintTheWriteToolsNeed() throws {
        let source = "print(\"hi\")\n"
        let rendered = ReadFileTool.render(try result(content: source))
        let fields = try headerFields(rendered)

        XCTAssertEqual(fields["path"] as? String, "src/a.swift")
        XCTAssertEqual(fields["bytes"] as? Int, source.utf8.count)
        XCTAssertEqual(fields["truncated"] as? Bool, false)
        XCTAssertEqual(
            fields["base_sha256"] as? String,
            FileFingerprint(of: source).sha256
        )
        XCTAssertEqual(split(rendered).body, source, "the content is returned verbatim")
    }

    /// A JSON file's first character is `{`, which is also the header's. The
    /// contract is "first line is the header", not "first `{` is the header".
    func testAFileThatBeginsWithABraceIsStillSplittableFromTheHeader() throws {
        let source = "{\n  \"name\": \"juno\"\n}\n"
        let rendered = ReadFileTool.render(try result(path: "package.json", content: source))

        XCTAssertEqual(try headerFields(rendered)["path"] as? String, "package.json")
        XCTAssertEqual(split(rendered).body, source)
    }

    func testAnEmptyFileStillCarriesAFingerprint() throws {
        let rendered = ReadFileTool.render(try result(path: "empty.txt", content: ""))
        let fields = try headerFields(rendered)

        XCTAssertEqual(fields["bytes"] as? Int, 0)
        XCTAssertEqual(fields["base_sha256"] as? String, FileFingerprint(of: "").sha256)
        XCTAssertEqual(split(rendered).body, "")
    }

    func testByteCountsAreBytesNotCharacters() throws {
        let source = "héllo 🌍\n"
        let rendered = ReadFileTool.render(try result(path: "u.txt", content: source))

        XCTAssertEqual(try headerFields(rendered)["bytes"] as? Int, source.utf8.count)
        XCTAssertNotEqual(source.utf8.count, source.count)
        XCTAssertEqual(split(rendered).body, source)
    }

    // MARK: - Truncated reads

    /// The truncation guard. The digest of the complete file is exactly what a
    /// full overwrite would need, so a model that saw only part of the file
    /// must not be handed it — otherwise it can pass a *matching* base and
    /// silently discard everything it was not shown.
    func testATruncatedReadIssuesNoFingerprintAtAll() throws {
        let whole = String(repeating: "x", count: 500)
        let rendered = ReadFileTool.render(
            try result(
                path: "big.txt",
                content: String(whole.prefix(20)),
                truncated: true,
                fullContent: whole
            )
        )
        let fields = try headerFields(rendered)

        XCTAssertEqual(fields["truncated"] as? Bool, true)
        XCTAssertNil(
            fields["base_sha256"],
            "a partial read must not carry a base a whole-file write would accept"
        )
        XCTAssertEqual(fields["bytes"] as? Int, 500, "the true size is still reported")
        XCTAssertNotNil(fields["note"], "and the model is told why there is no fingerprint")
        // The complete digest must appear nowhere in the payload the model sees.
        XCTAssertFalse(rendered.contains(FileFingerprint(of: whole).sha256))
    }

    // MARK: - The byte budget

    private func lines(_ count: Int, width: Int, ending: String = "\n") -> String {
        (1...count).map { number in
            let label = "line \(number) "
            return label + String(repeating: "a", count: max(0, width - label.count))
        }.joined(separator: ending) + ending
    }

    /// Under the line limit but over the byte budget. This used to go out
    /// whole with a fingerprint, and the orchestrator's cap then cut its
    /// middle out: a write_file from that fingerprint deleted the middle.
    func testAFileUnderTheLineLimitButOverTheBudgetIsWindowedWithoutAFingerprint() throws {
        let source = lines(1_500, width: 120)
        XCTAssertGreaterThan(source.utf8.count, ReadFileTool.maximumContentBytes)
        let rendered = ReadFileTool.render(try result(path: "data.json", content: source), offset: nil, limit: nil)
        let fields = try headerFields(rendered)

        XCTAssertEqual(fields["truncated"] as? Bool, true)
        XCTAssertNil(fields["base_sha256"])
        XCTAssertFalse(rendered.contains(FileFingerprint(of: source).sha256))
        let lastLine = try XCTUnwrap(fields["last_line"] as? Int)
        XCTAssertLessThan(lastLine, 1_500)
        XCTAssertEqual(fields["note"] as? String, "partial read; pass offset \(lastLine + 1) to continue")
        let body = split(rendered).body
        XCTAssertLessThanOrEqual(body.utf8.count, ReadFileTool.maximumContentBytes)
        XCTAssertEqual(body, DiffEngine.splitLines(source)[0..<lastLine].joined(separator: "\n"))
        XCTAssertLessThan(
            rendered.utf8.count,
            AgentOrchestrator.Configuration(systemPrompt: "").maximumToolResultBytes,
            "a read must never reach the cap that cuts results"
        )
    }

    /// Following the continuation offsets from the first page to the last
    /// shows every line exactly once.
    func testPagingByTheContinuationOffsetSkipsNothing() throws {
        let source = lines(3_000, width: 100)
        let fileLines = DiffEngine.splitLines(source)
        let read = try result(path: "big.log", content: source)
        var offset: Int?
        var seen: [String] = []
        while true {
            let rendered = ReadFileTool.render(read, offset: offset, limit: nil)
            let fields = try headerFields(rendered)
            XCTAssertNil(fields["base_sha256"])
            XCTAssertEqual(fields["first_line"] as? Int, offset ?? 1)
            let lastLine = try XCTUnwrap(fields["last_line"] as? Int)
            let page = DiffEngine.splitLines(split(rendered).body)
            XCTAssertEqual(page.count, lastLine - (offset ?? 1) + 1)
            seen += page
            guard lastLine < 3_000 else { break }
            offset = lastLine + 1
        }
        XCTAssertEqual(seen, fileLines)
    }

    /// A window that covers the whole file is the whole read, trailing
    /// newline included, so the fingerprint covers exactly what was shown.
    func testAWindowCoveringTheWholeFileIsTheWholeRead() throws {
        let source = "one\ntwo\nthree\n"
        let rendered = ReadFileTool.render(try result(content: source), offset: 1, limit: 50)
        XCTAssertEqual(try headerFields(rendered)["base_sha256"] as? String, FileFingerprint(of: source).sha256)
        XCTAssertEqual(split(rendered).body, source)
    }

    /// A trailing newline is not a line: exactly the line limit, newline
    /// terminated, is still a whole read.
    func testExactlyTheLineLimitIsAWholeRead() throws {
        let source = lines(ReadFileTool.defaultLineLimit, width: 20)
        let fields = try headerFields(ReadFileTool.render(try result(content: source), offset: nil, limit: nil))
        XCTAssertEqual(fields["base_sha256"] as? String, FileFingerprint(of: source).sha256)
        XCTAssertEqual(fields["lines"] as? Int, ReadFileTool.defaultLineLimit)
    }

    /// "\r\n" is a single Character that is not "\n", so a CRLF file used to
    /// read as one line: never paged, offsets refused as past the end, and a
    /// small window returned the whole file with its fingerprint.
    func testCRLFFilesPageByTheirLines() throws {
        let source = "line1\r\nline2\r\nline3\r\n"
        let read = try result(path: "a.cs", content: source)

        let second = ReadFileTool.render(read, offset: 2, limit: 1)
        let fields = try headerFields(second)
        XCTAssertEqual(fields["total_lines"] as? Int, 3)
        XCTAssertEqual(fields["first_line"] as? Int, 2)
        XCTAssertEqual(fields["last_line"] as? Int, 2)
        XCTAssertNil(fields["base_sha256"])
        XCTAssertEqual(split(second).body, "line2\r")

        let big = lines(10_000, width: 30, ending: "\r\n")
        let first = try headerFields(ReadFileTool.render(try result(path: "b.cs", content: big), offset: nil, limit: nil))
        XCTAssertEqual(first["total_lines"] as? Int, 10_000)
        XCTAssertEqual(first["last_line"] as? Int, ReadFileTool.defaultLineLimit)
        XCTAssertNil(first["base_sha256"])
        let later = try headerFields(ReadFileTool.render(try result(path: "b.cs", content: big), offset: 2_001, limit: nil))
        XCTAssertEqual(later["first_line"] as? Int, 2_001)
    }

    /// A single line over the budget shows its head and moves on, rather than
    /// returning nothing and a continuation offset that points at itself.
    func testALineLongerThanTheBudgetShowsItsHead() throws {
        let source = "short\n" + String(repeating: "m", count: ReadFileTool.maximumContentBytes * 2) + "\nafter\n"
        let rendered = ReadFileTool.render(try result(path: "min.js", content: source), offset: 2, limit: nil)
        let fields = try headerFields(rendered)
        XCTAssertEqual(fields["first_line"] as? Int, 2)
        XCTAssertEqual(fields["last_line"] as? Int, 2)
        XCTAssertEqual(split(rendered).body.utf8.count, ReadFileTool.maximumContentBytes)
        XCTAssertTrue((fields["note"] as? String)?.contains("pass offset 3") == true)
    }

    /// Defence in depth for a cap set below the tool's own budget: the cut
    /// keeps the head and the header stops vouching for what was removed.
    func testACutReadLosesItsFingerprintAndReportsWhereItStopped() throws {
        let source = lines(500, width: 40)
        let whole = ReadFileTool.render(try result(content: source))
        XCTAssertNotNil(try headerFields(whole)["base_sha256"])

        let cut = ReadFileTool.bounded(whole, maximumBytes: 4_096)
        XCTAssertLessThanOrEqual(cut.utf8.count, 4_096)
        let fields = try headerFields(cut)
        XCTAssertNil(fields["base_sha256"])
        XCTAssertFalse(cut.contains(FileFingerprint(of: source).sha256))
        XCTAssertEqual(fields["truncated"] as? Bool, true)
        let lastLine = try XCTUnwrap(fields["last_line"] as? Int)
        XCTAssertEqual(split(cut).body, DiffEngine.splitLines(source)[0..<lastLine].joined(separator: "\n"))
        XCTAssertTrue((fields["note"] as? String)?.contains("pass offset \(lastLine + 1)") == true)

        XCTAssertEqual(ReadFileTool.bounded(whole, maximumBytes: 1_000_000), whole, "an uncut read is untouched")
    }

    // MARK: - Fingerprint validation

    func testAWellFormedDigestIsAcceptedInEitherCase() throws {
        let digest = FileFingerprint(of: "anything").sha256

        XCTAssertEqual(try FileFingerprint(validating: digest).sha256, digest)
        XCTAssertEqual(
            try FileFingerprint(validating: digest.uppercased()).sha256,
            digest,
            "an upper-cased digest is the same digest, not a stale one"
        )
        XCTAssertEqual(try FileFingerprint(validating: "  \(digest)\n").sha256, digest)
    }

    /// Before this, a malformed value was wrapped as-is, failed to compare
    /// equal, and was reported as "the file changed underneath you" — sending
    /// the model to re-read a file nobody had touched.
    func testMalformedDigestsAreRejectedRatherThanQuietlyMismatching() {
        let digest = FileFingerprint(of: "anything").sha256
        let bad = [
            "",
            "unknown",
            String(digest.dropLast()),          // 63 characters
            digest + "0",                        // 65 characters
            String(repeating: "z", count: 64),   // right length, not hex
            "sha256:" + digest,                  // prefixed
        ]

        for value in bad {
            XCTAssertThrowsError(try FileFingerprint(validating: value), "accepted \(value)") {
                XCTAssertEqual($0 as? FileFingerprintError, .malformed)
            }
        }
    }
}
