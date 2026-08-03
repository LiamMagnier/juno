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
            lineCount: whole.split(separator: "\n", omittingEmptySubsequences: false).count
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
