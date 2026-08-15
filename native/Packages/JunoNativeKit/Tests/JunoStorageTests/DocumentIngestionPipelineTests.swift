import Foundation
import XCTest

@testable import JunoStorage

/// Ingestion's contract is that a chunk states only facts about where it came
/// from. Everything here is either about that, or about the pure chunker whose
/// offsets those facts rest on.
final class DocumentIngestionPipelineTests: XCTestCase {
    // MARK: - Recursive chunking

    /// The property every downstream citation depends on: the reported range
    /// really is where the reported text is. A splitter that drops separators
    /// shifts every offset after the first cut, and nothing about the resulting
    /// chunks looks wrong.
    func testEveryChunkRangeAddressesExactlyItsOwnText() {
        let text = (1 ... 40)
            .map { "Paragraph \($0) with some prose in it that runs on a little." }
            .joined(separator: "\n\n")
        let characters = Array(text)

        let chunks = RecursiveTextChunker.chunks(
            in: text,
            options: TextChunkingOptions(maximumCharacters: 200, overlapCharacters: 40)
        )

        XCTAssertGreaterThan(chunks.count, 5)
        for chunk in chunks {
            XCTAssertEqual(String(characters[chunk.range]), chunk.text)
        }
    }

    func testChunksNeverExceedTheCeiling() {
        let text = String(repeating: "alpha beta gamma delta ", count: 400)
        let options = TextChunkingOptions(maximumCharacters: 300, overlapCharacters: 50)

        for chunk in RecursiveTextChunker.chunks(in: text, options: options) {
            XCTAssertLessThanOrEqual(chunk.text.count, options.maximumCharacters)
        }
    }

    /// A fact split across a boundary is retrievable by neither half without
    /// overlap: the sentence naming the subject lands in one chunk and the
    /// sentence carrying the number lands in the next.
    func testConsecutiveChunksOverlap() {
        let text = (1 ... 30).map { "Sentence number \($0) about revenue." }
            .joined(separator: "\n")
        let chunks = RecursiveTextChunker.chunks(
            in: text,
            options: TextChunkingOptions(maximumCharacters: 200, overlapCharacters: 60)
        )

        XCTAssertGreaterThan(chunks.count, 2)
        for (previous, next) in zip(chunks, chunks.dropFirst()) {
            XCTAssertLessThan(
                next.range.lowerBound,
                previous.range.upperBound,
                "chunk \(next.range) should start before \(previous.range) ends"
            )
            // …but never so far back that it swallows the previous chunk whole,
            // which is duplication rather than overlap.
            XCTAssertGreaterThan(next.range.lowerBound, previous.range.lowerBound)
        }
    }

    /// No separator in the ladder occurs, so the fallback has to fire. A chunker
    /// that gives up here emits one chunk many times a model's budget.
    func testTextWithNoSeparatorsIsStillBounded() {
        let text = String(repeating: "x", count: 1000)
        let chunks = RecursiveTextChunker.chunks(
            in: text,
            options: TextChunkingOptions(maximumCharacters: 100, overlapCharacters: 0)
        )

        XCTAssertEqual(chunks.count, 10)
        XCTAssertEqual(chunks.map(\.text).joined(), text)
    }

    /// An overlap at or above the ceiling makes every chunk start at or before
    /// the last one — an infinite document. Clamped rather than trapped so a bad
    /// constant in a caller cannot crash an import.
    func testAbsurdOptionsAreClampedRatherThanLooping() {
        let options = TextChunkingOptions(maximumCharacters: 100, overlapCharacters: 500)
        XCTAssertEqual(options.overlapCharacters, 50)

        let chunks = RecursiveTextChunker.chunks(
            in: String(repeating: "word ", count: 200),
            options: options
        )
        XCTAssertFalse(chunks.isEmpty)
    }

    func testEmptyAndWhitespaceOnlyTextProduceNoChunks() {
        XCTAssertTrue(RecursiveTextChunker.chunks(in: "").isEmpty)
        XCTAssertTrue(RecursiveTextChunker.chunks(in: "   \n\n\t  ").isEmpty)
    }

    // MARK: - Metadata

    /// The reason chunking runs per segment. A chunk that straddled two pages
    /// would have to claim one of them, and the citation under it would point at
    /// the wrong page for half its content.
    func testAChunkNeverSpansTwoPages() throws {
        let pipeline = DocumentIngestionPipeline(
            options: TextChunkingOptions(maximumCharacters: 4000, overlapCharacters: 0)
        )
        let segments = [
            DocumentSegment(text: "Page one body.", pageNumber: 1),
            DocumentSegment(text: "Page two body.", pageNumber: 2),
        ]

        let chunks = pipeline.chunks(from: segments, sourceName: "Report.pdf", format: .pdf)

        XCTAssertEqual(chunks.count, 2, "the ceiling would fit both, the page boundary must not")
        XCTAssertEqual(chunks.map(\.metadata.pageNumber), [1, 2])
        XCTAssertEqual(chunks.map(\.text), ["Page one body.", "Page two body."])
    }

    /// Absent ≠ zero. A CSV does not have page 1; it has no pages.
    func testFormatsWithoutPagesReportNoPageNumber() throws {
        let pipeline = DocumentIngestionPipeline()
        let data = Data("name,amount\nAcme,120\nGlobex,340\n".utf8)

        let document = try pipeline.ingest(data: data, fileName: "sales.csv")

        XCTAssertNil(document.pageCount)
        XCTAssertTrue(document.chunks.allSatisfy { $0.metadata.pageNumber == nil })
        XCTAssertFalse(document.usedOpticalCharacterRecognition)
    }

    /// Position-derived rather than random, so re-importing a file replaces its
    /// chunks in the retrieval index instead of doubling them.
    func testChunkIdentifiersAreStableAcrossIngestions() throws {
        let pipeline = DocumentIngestionPipeline()
        let data = Data("# Title\n\nSome body text worth indexing.\n".utf8)

        let first = try pipeline.ingest(data: data, fileName: "notes.md")
        let second = try pipeline.ingest(data: data, fileName: "notes.md")

        XCTAssertEqual(first.chunks.map(\.id), second.chunks.map(\.id))
        XCTAssertEqual(first.chunks.first?.id, "notes.md#0")
    }

    func testLocatorNamesOnlyTheFactsItHas() {
        let paged = DocumentChunkMetadata(
            sourceName: "Report.pdf",
            format: .pdf,
            pageNumber: 4,
            section: "Revenue",
            rowRange: nil,
            chunkIndex: 0,
            characterRange: 0 ..< 10,
            extraction: .embeddedText
        )
        XCTAssertEqual(paged.locator, "Report.pdf, page 4 — Revenue")

        let plain = DocumentChunkMetadata(
            sourceName: "notes.txt",
            format: .plainText,
            pageNumber: nil,
            section: nil,
            rowRange: nil,
            chunkIndex: 0,
            characterRange: 0 ..< 10,
            extraction: .embeddedText
        )
        XCTAssertEqual(plain.locator, "notes.txt")
    }

    // MARK: - Markdown

    func testMarkdownHeadingsBecomeSectionPaths() {
        let markdown = """
        # Guide

        Intro text.

        ## Installation

        Run the installer.

        ### Troubleshooting

        Try again.

        ## Usage

        Use it.
        """

        let sections = PlainTextDocumentExtractor.markdownSegments(in: markdown).map(\.section)

        XCTAssertEqual(
            sections,
            [
                "Guide",
                "Guide › Installation",
                "Guide › Installation › Troubleshooting",
                "Guide › Usage",
            ]
        )
    }

    /// `# comment` inside a fence is a shell comment. Promoting it invents a
    /// section that does not exist and cuts the code sample in half.
    func testHashInsideAFenceIsNotAHeading() throws {
        let markdown = """
        # Real heading

        ```bash
        # not a heading
        echo hi
        ```

        Body.
        """

        let segments = PlainTextDocumentExtractor.markdownSegments(in: markdown)

        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments.first?.section, "Real heading")
        XCTAssertTrue(try XCTUnwrap(segments.first?.text).contains("# not a heading"))
    }

    /// Text before the first heading has no section. `"Untitled"` would be a
    /// fact the document never stated.
    func testTextAboveTheFirstHeadingHasNoSection() {
        let segments = PlainTextDocumentExtractor.markdownSegments(
            in: "Preamble paragraph.\n\n# Heading\n\nBody."
        )

        XCTAssertEqual(segments.count, 2)
        XCTAssertNil(segments[0].section)
        XCTAssertEqual(segments[1].section, "Heading")
    }

    // MARK: - CSV

    /// The bug that splitting on commas causes: one quoted field with a comma or
    /// a newline in it shreds the row, and every row number after it is wrong.
    func testQuotedFieldsWithCommasAndNewlinesSurviveParsing() {
        let csv = "name,note\n\"Acme, Inc.\",\"line one\nline two\"\n\"He said \"\"hi\"\"\",x\n"

        let rows = DelimitedTextDocumentExtractor.parse(csv)

        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[1], ["Acme, Inc.", "line one\nline two"])
        XCTAssertEqual(rows[2], ["He said \"hi\"", "x"])
    }

    /// Calling a data row a header deletes a record and mislabels every other
    /// row with that record's values, so the first row has to earn it.
    func testAFirstRowThatIsDataIsNotTreatedAsAHeader() throws {
        let withHeader = DelimitedTextDocumentExtractor.segments(
            rows: [["name", "amount"], ["Acme", "120"]],
            rowsPerSegment: 10
        )
        XCTAssertEqual(withHeader.count, 1)
        XCTAssertTrue(try XCTUnwrap(withHeader.first).text.contains("name: Acme"))
        XCTAssertEqual(withHeader.first?.rowRange, 1 ... 1)

        // Numeric first row: not labels, so no record may be consumed.
        let withoutHeader = DelimitedTextDocumentExtractor.segments(
            rows: [["1", "2"], ["3", "4"]],
            rowsPerSegment: 10
        )
        XCTAssertEqual(withoutHeader.first?.rowRange, 1 ... 2)
        XCTAssertTrue(try XCTUnwrap(withoutHeader.first).text.contains("column 1: 1"))
    }

    /// A chunk reading `12 | 4 | 2026-01-02` in isolation is unusable as
    /// retrieved context, and a model asked to cite it invents what the columns
    /// mean.
    func testEverySegmentCarriesTheColumnLabels() {
        let rows = [["name", "amount"]] + (1 ... 30).map { ["Row \($0)", "\($0)"] }

        let segments = DelimitedTextDocumentExtractor.segments(rows: rows, rowsPerSegment: 10)

        XCTAssertEqual(segments.count, 3)
        XCTAssertEqual(segments.map(\.rowRange), [1 ... 10, 11 ... 20, 21 ... 30])
        XCTAssertTrue(segments.allSatisfy { $0.text.contains("columns: name, amount") })
    }

    // MARK: - DOCX

    func testWordParagraphsAndHeadingStylesBecomeSegments() {
        let xml = """
        <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Contract</w:t></w:r></w:p>
        <w:p><w:r><w:t>Terms &amp; conditions apply.</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Payment</w:t></w:r></w:p>
        <w:p><w:r><w:t>Net </w:t></w:r><w:r><w:t>30.</w:t></w:r></w:p>
        </w:body>
        """

        let segments = OfficeOpenXMLDocumentExtractor.segments(fromDocumentXML: xml)

        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(segments[0].section, "Contract")
        XCTAssertTrue(segments[0].text.contains("Terms & conditions apply."))
        XCTAssertEqual(segments[1].section, "Contract › Payment")
        // Runs inside one paragraph are one line, not two.
        XCTAssertTrue(segments[1].text.contains("Net 30."))
    }

    /// An entity this build does not know is left verbatim rather than deleted;
    /// dropping it would silently alter the text of a contract.
    func testUnknownEntitiesAreLeftIntactRatherThanDropped() {
        XCTAssertEqual(
            OfficeOpenXMLDocumentExtractor.decodeXMLEntities("a &nbsp; b &#65; c &amp; d"),
            "a &nbsp; b A c & d"
        )
    }

    /// End to end through the real ZIP reader, because the OOXML path is only
    /// as good as the archive parsing under it.
    func testADocxPackageIsUnzippedAndRead() throws {
        let xml = """
        <w:document><w:body>\
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>\
        <w:p><w:r><w:t>Body paragraph with enough words to index.</w:t></w:r></w:p>\
        </w:body></w:document>
        """
        let archive = Self.storedZIP(entries: [("word/document.xml", Data(xml.utf8))])

        let document = try DocumentIngestionPipeline().ingest(
            data: archive,
            fileName: "agreement.docx"
        )

        XCTAssertEqual(document.format, .docx)
        XCTAssertNil(document.pageCount)
        XCTAssertEqual(document.chunks.first?.metadata.section, "Title")
        XCTAssertTrue(
            try XCTUnwrap(document.chunks.first).text.contains("Body paragraph")
        )
    }

    func testAPackageWithoutADocumentPartIsReportedAsDamaged() {
        let archive = Self.storedZIP(entries: [("word/styles.xml", Data("<x/>".utf8))])

        XCTAssertThrowsError(
            try DocumentIngestionPipeline().ingest(data: archive, fileName: "broken.docx")
        ) { error in
            guard case .malformedDocument = error as? DocumentIngestionError else {
                return XCTFail("expected a malformedDocument error, got \(error)")
            }
        }
    }

    // MARK: - Format resolution

    /// Guessing plain text for an unknown extension is how a binary gets
    /// ingested as a wall of garbage that then competes with real content in
    /// retrieval.
    func testAnUnknownExtensionIsRejectedRatherThanGuessed() {
        XCTAssertNil(IngestibleDocumentFormat.inferred(fromFileName: "deck.key"))
        XCTAssertEqual(IngestibleDocumentFormat.inferred(fromFileName: "a/b/NOTES.MD"), .markdown)

        XCTAssertThrowsError(
            try DocumentIngestionPipeline().ingest(data: Data("x".utf8), fileName: "deck.key")
        ) { error in
            XCTAssertEqual(
                error as? DocumentIngestionError,
                .unrecognizedFormat(fileName: "deck.key")
            )
        }
    }

    /// A file that parses but yields nothing is reported, not returned as a
    /// successful zero-chunk import that looks indistinguishable from success.
    func testAnEmptyDocumentIsReportedRatherThanReturnedEmpty() {
        XCTAssertThrowsError(
            try DocumentIngestionPipeline().ingest(
                data: Data("   \n\n ".utf8),
                fileName: "blank.txt"
            )
        ) { error in
            XCTAssertEqual(
                error as? DocumentIngestionError,
                .noExtractableText(fileName: "blank.txt")
            )
        }
    }

    // MARK: - Fixtures

    /// A ZIP with stored (uncompressed) entries, written by hand so the archive
    /// reader is exercised against real bytes rather than a mock.
    private static func storedZIP(entries: [(name: String, data: Data)]) -> Data {
        var output = Data()
        var directory = Data()

        func append16(_ value: UInt16, to data: inout Data) {
            data.append(UInt8(value & 0xFF))
            data.append(UInt8((value >> 8) & 0xFF))
        }
        func append32(_ value: UInt32, to data: inout Data) {
            for shift in stride(from: 0, through: 24, by: 8) {
                data.append(UInt8((value >> UInt32(shift)) & 0xFF))
            }
        }

        for entry in entries {
            let name = Data(entry.name.utf8)
            let offset = UInt32(output.count)

            append32(0x0403_4B50, to: &output)
            append16(20, to: &output) // version needed
            append16(0, to: &output) // flags
            append16(0, to: &output) // method: stored
            append16(0, to: &output) // time
            append16(0, to: &output) // date
            append32(0, to: &output) // crc32, unchecked by the reader
            append32(UInt32(entry.data.count), to: &output)
            append32(UInt32(entry.data.count), to: &output)
            append16(UInt16(name.count), to: &output)
            append16(0, to: &output) // extra length
            output.append(name)
            output.append(entry.data)

            append32(0x0201_4B50, to: &directory)
            append16(20, to: &directory) // version made by
            append16(20, to: &directory) // version needed
            append16(0, to: &directory)
            append16(0, to: &directory)
            append16(0, to: &directory)
            append16(0, to: &directory)
            append32(0, to: &directory)
            append32(UInt32(entry.data.count), to: &directory)
            append32(UInt32(entry.data.count), to: &directory)
            append16(UInt16(name.count), to: &directory)
            append16(0, to: &directory) // extra
            append16(0, to: &directory) // comment
            append16(0, to: &directory) // disk number
            append16(0, to: &directory) // internal attributes
            append32(0, to: &directory) // external attributes
            append32(offset, to: &directory)
            directory.append(name)
        }

        let directoryOffset = UInt32(output.count)
        output.append(directory)
        append32(0x0605_4B50, to: &output)
        append16(0, to: &output)
        append16(0, to: &output)
        append16(UInt16(entries.count), to: &output)
        append16(UInt16(entries.count), to: &output)
        append32(UInt32(directory.count), to: &output)
        append32(directoryOffset, to: &output)
        append16(0, to: &output)
        return output
    }
}
