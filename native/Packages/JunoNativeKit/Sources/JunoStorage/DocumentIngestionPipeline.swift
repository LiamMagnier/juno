import Foundation

/// The result of reading one file into retrievable chunks.
///
/// `pageCount` and `usedOpticalCharacterRecognition` are reported rather than
/// inferred downstream, because both are facts only the extractor could observe
/// and both change how the result should be presented: a document whose text
/// came from OCR is a transcription, not a transcript.
public struct IngestedDocument: Equatable, Sendable {
    public let sourceName: String
    public let format: IngestibleDocumentFormat
    public let chunks: [DocumentChunk]
    /// Number of pages, or nil for formats that have none.
    ///
    /// Nil, never zero. A CSV does not have zero pages; it has no concept of
    /// pages, and a `0` here would render as "0 pages" on a surface that has no
    /// way to tell the two apart.
    public let pageCount: Int?
    public let usedOpticalCharacterRecognition: Bool

    public init(
        sourceName: String,
        format: IngestibleDocumentFormat,
        chunks: [DocumentChunk],
        pageCount: Int?,
        usedOpticalCharacterRecognition: Bool
    ) {
        self.sourceName = sourceName
        self.format = format
        self.chunks = chunks
        self.pageCount = pageCount
        self.usedOpticalCharacterRecognition = usedOpticalCharacterRecognition
    }
}

/// Turns a file's bytes into chunks that carry where they came from.
///
/// The pipeline is deliberately split in two halves with different testability
/// properties, and the split is the design:
///
/// * **Extraction** is format-specific and framework-bound (PDFKit, Vision, the
///   OOXML package). It is behind `DocumentTextExtracting` so it can be replaced
///   or stubbed, and it produces `DocumentSegment`s — text plus the positional
///   facts only it can know.
/// * **Chunking** is pure. Given segments, it is a total function to chunks with
///   no clock, no filesystem, and no framework in it, so the part that actually
///   decides what a model will read can be pinned down exactly by tests.
///
/// That boundary is why `chunks(from:)` is public: a test does not need a PDF
/// fixture to prove that page numbers, sections, and offsets survive chunking.
public struct DocumentIngestionPipeline: Sendable {
    public let options: TextChunkingOptions
    private let allowsOpticalCharacterRecognition: Bool

    public init(
        options: TextChunkingOptions = .default,
        allowsOpticalCharacterRecognition: Bool = true
    ) {
        self.options = options
        self.allowsOpticalCharacterRecognition = allowsOpticalCharacterRecognition
    }

    /// Reads `data` as `fileName` and chunks it.
    ///
    /// `format` may be supplied when the caller knows better than the extension
    /// does (a download with a generic name, a paste). When it is not supplied
    /// and the extension names nothing we support, this throws rather than
    /// guessing — see `DocumentIngestionError.unrecognizedFormat`.
    public func ingest(
        data: Data,
        fileName: String,
        format: IngestibleDocumentFormat? = nil
    ) throws -> IngestedDocument {
        let resolved: IngestibleDocumentFormat
        if let format {
            resolved = format
        } else if let inferred = IngestibleDocumentFormat.inferred(fromFileName: fileName) {
            resolved = inferred
        } else {
            throw DocumentIngestionError.unrecognizedFormat(fileName: fileName)
        }

        let segments = try extractor(for: resolved).segments(from: data, fileName: fileName)
        let chunks = chunks(from: segments, sourceName: fileName, format: resolved)
        guard !chunks.isEmpty else {
            throw DocumentIngestionError.noExtractableText(fileName: fileName)
        }

        // Highest observed page number, not `segments.count`: a PDF whose
        // page 3 is blank produces two segments, and calling that a two-page
        // document misstates the file.
        let pageCount = segments.compactMap(\.pageNumber).max()
        return IngestedDocument(
            sourceName: fileName,
            format: resolved,
            chunks: chunks,
            pageCount: pageCount,
            usedOpticalCharacterRecognition: segments.contains {
                $0.extraction == .opticalCharacterRecognition
            }
        )
    }

    /// The pure half: segments in, chunks out.
    ///
    /// Chunking runs *per segment* so a chunk never spans a page or section
    /// boundary. The alternative — concatenate everything, chunk once, then pick
    /// a page for each chunk — has to choose one page number for a chunk whose
    /// text came from two, and whichever it picks is a citation pointing at the
    /// wrong page half the time.
    public func chunks(
        from segments: [DocumentSegment],
        sourceName: String,
        format: IngestibleDocumentFormat
    ) -> [DocumentChunk] {
        var chunks: [DocumentChunk] = []
        var index = 0
        for segment in segments {
            for span in RecursiveTextChunker.chunks(in: segment.text, options: options) {
                let metadata = DocumentChunkMetadata(
                    sourceName: sourceName,
                    format: format,
                    pageNumber: segment.pageNumber,
                    section: segment.section,
                    rowRange: segment.rowRange,
                    chunkIndex: index,
                    characterRange: span.range,
                    extraction: segment.extraction
                )
                chunks.append(
                    DocumentChunk(
                        // Position-derived, so re-importing the same file
                        // replaces its chunks in the index instead of doubling
                        // them.
                        id: "\(sourceName)#\(index)",
                        text: span.text,
                        metadata: metadata
                    )
                )
                index += 1
            }
        }
        return chunks
    }

    private func extractor(for format: IngestibleDocumentFormat) -> DocumentTextExtracting {
        switch format {
        case .pdf:
            PDFDocumentExtractor(
                allowsOpticalCharacterRecognition: allowsOpticalCharacterRecognition
            )
        case .docx:
            OfficeOpenXMLDocumentExtractor()
        case .csv:
            DelimitedTextDocumentExtractor()
        case .markdown:
            PlainTextDocumentExtractor(honoursMarkdownHeadings: true)
        case .plainText:
            PlainTextDocumentExtractor(honoursMarkdownHeadings: false)
        }
    }
}
