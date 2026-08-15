import Foundation

#if canImport(PDFKit)
import PDFKit
#endif

#if canImport(CoreGraphics)
import CoreGraphics
#endif

#if canImport(Vision)
import Vision
#endif

public enum DocumentIngestionError: Error, Equatable, Sendable {
    /// The file name carries no extension this build understands. Deliberately
    /// not "assume plain text": ingesting an unknown binary as text produces
    /// chunks of garbage that then compete with real content in retrieval.
    case unrecognizedFormat(fileName: String)
    /// The bytes are not text in any encoding we attempt. Better than mojibake,
    /// which is indistinguishable from a badly OCR'd page once it is a chunk.
    case undecodableText(fileName: String)
    /// The format needs a framework this build cannot import (PDFKit on a
    /// platform without it, Vision for OCR). Named so the caller can say why
    /// rather than reporting an empty document.
    case extractorUnavailable(format: IngestibleDocumentFormat)
    case malformedArchive(reason: String)
    case malformedDocument(reason: String)
    /// The file parsed, but no text came out of it. Distinct from a failure: a
    /// scanned PDF with OCR unavailable is empty for a reason worth reporting.
    case noExtractableText(fileName: String)
}

extension DocumentIngestionError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .unrecognizedFormat(fileName):
            "\(fileName) is not a document type Juno can read."
        case let .undecodableText(fileName):
            "\(fileName) is not readable as text."
        case let .extractorUnavailable(format):
            "Reading \(format.rawValue.uppercased()) files is not available on this device."
        case let .malformedArchive(reason):
            "The document archive is damaged: \(reason)."
        case let .malformedDocument(reason):
            "The document is damaged: \(reason)."
        case let .noExtractableText(fileName):
            "\(fileName) contains no text Juno could read."
        }
    }
}

/// The seam every format extractor sits behind.
///
/// Returning segments rather than one string is the whole point: the extractor
/// is the only layer that knows what a page or a heading is, so it is the only
/// layer that can attach those facts truthfully.
public protocol DocumentTextExtracting: Sendable {
    func segments(from data: Data, fileName: String) throws -> [DocumentSegment]
}

// MARK: - Text decoding

enum DocumentTextDecoder {
    /// Decodes bytes with the encodings that actually appear in the wild, in
    /// descending order of confidence.
    ///
    /// ISO Latin 1 is last and is a genuine fallback rather than a default: it
    /// can decode any byte sequence, so putting it earlier would mean UTF-8 text
    /// with a single malformed byte silently becomes Latin-1 mojibake instead of
    /// being retried. Reaching it at all is reported by the caller as a
    /// lower-confidence decode.
    static func string(from data: Data, fileName: String) throws -> String {
        if data.isEmpty { return "" }

        // A byte-order mark is a statement by the producer, so honour it before
        // guessing anything.
        if data.starts(with: [0xEF, 0xBB, 0xBF]) {
            if let text = String(data: data.dropFirst(3), encoding: .utf8) { return text }
        }
        if data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF]) {
            if let text = String(data: data, encoding: .utf16) { return text }
        }
        if let text = String(data: data, encoding: .utf8) { return text }
        if let text = String(data: data, encoding: .utf16) { return text }
        if let text = String(data: data, encoding: .isoLatin1) { return text }
        throw DocumentIngestionError.undecodableText(fileName: fileName)
    }
}

// MARK: - Plain text and Markdown

/// Plain text and Markdown.
///
/// Markdown is not "text with syntax noise": its headings are the only reliable
/// section boundaries a document of this kind has, and carrying the heading path
/// onto every chunk underneath is what lets a citation say *where* in a long
/// document a claim came from instead of just naming the file.
public struct PlainTextDocumentExtractor: DocumentTextExtracting {
    private let honoursMarkdownHeadings: Bool

    public init(honoursMarkdownHeadings: Bool) {
        self.honoursMarkdownHeadings = honoursMarkdownHeadings
    }

    public func segments(from data: Data, fileName: String) throws -> [DocumentSegment] {
        let text = try DocumentTextDecoder.string(from: data, fileName: fileName)
        guard honoursMarkdownHeadings else {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [DocumentSegment(text: text)]
        }
        return Self.markdownSegments(in: text)
    }

    /// Splits Markdown at ATX headings, carrying the full heading path.
    ///
    /// Fenced code is tracked because `# ` at the start of a line inside a fence
    /// is a shell comment or a Python comment, not a heading. Treating it as one
    /// invents sections that do not exist and cuts a code sample in half.
    ///
    /// Setext headings (`Title` over `=====`) are intentionally not recognised:
    /// the same underline syntax is a table rule and a horizontal rule, so
    /// promoting it would fabricate section names out of ordinary prose.
    public static func markdownSegments(in text: String) -> [DocumentSegment] {
        var segments: [DocumentSegment] = []
        var headingPath: [String] = []
        var buffer: [String] = []
        var currentSection: String?
        var inFence = false

        func flush() {
            let body = buffer.joined(separator: "\n")
            buffer.removeAll(keepingCapacity: true)
            guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            segments.append(DocumentSegment(text: body, section: currentSection))
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inFence.toggle()
                buffer.append(line)
                continue
            }
            guard !inFence, let heading = atxHeading(in: trimmed) else {
                buffer.append(line)
                continue
            }

            flush()
            if headingPath.count >= heading.level {
                headingPath.removeSubrange((heading.level - 1) ..< headingPath.count)
            }
            while headingPath.count < heading.level - 1 {
                // A document that jumps from `#` to `###` has a level with no
                // heading. Recording an empty rung would print `A ›  › C`; the
                // honest path is simply the headings that exist.
                headingPath.append("")
            }
            headingPath.append(heading.title)
            currentSection = headingPath.filter { !$0.isEmpty }.joined(separator: " › ")
            buffer.append(line)
        }
        flush()

        // A document with no headings at all still has to produce something.
        if segments.isEmpty {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [DocumentSegment(text: text)]
        }
        return segments
    }

    private static func atxHeading(in line: String) -> (level: Int, title: String)? {
        guard line.hasPrefix("#") else { return nil }
        var level = 0
        var index = line.startIndex
        while index < line.endIndex, line[index] == "#" {
            level += 1
            index = line.index(after: index)
        }
        // Seven or more hashes is not a heading in any Markdown dialect, and
        // `#tag` with no space is a hashtag rather than a title.
        guard (1 ... 6).contains(level), index < line.endIndex, line[index] == " " else {
            return nil
        }
        let title = line[index...]
            .trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
            .trimmingCharacters(in: .whitespaces)
        return title.isEmpty ? nil : (level, title)
    }
}

// MARK: - CSV

/// Comma-separated values, parsed to RFC 4180 rather than by splitting on commas.
///
/// Splitting on commas is the bug this replaces: a quoted field containing a
/// comma or a newline (an address, a sentence, a JSON blob in a column) shreds
/// the row and every downstream row number is then wrong.
public struct DelimitedTextDocumentExtractor: DocumentTextExtracting {
    private let delimiter: Character
    private let rowsPerSegment: Int

    public init(delimiter: Character = ",", rowsPerSegment: Int = 20) {
        self.delimiter = delimiter
        self.rowsPerSegment = max(1, rowsPerSegment)
    }

    public func segments(from data: Data, fileName: String) throws -> [DocumentSegment] {
        let text = try DocumentTextDecoder.string(from: data, fileName: fileName)
        let rows = Self.parse(text, delimiter: delimiter)
        return Self.segments(rows: rows, rowsPerSegment: rowsPerSegment)
    }

    /// RFC 4180 field parsing: quotes, doubled quotes, embedded newlines, and
    /// CRLF normalisation.
    public static func parse(_ text: String, delimiter: Character = ",") -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var inQuotes = false

        let characters = Array(text)
        var index = 0
        while index < characters.count {
            let character = characters[index]
            if inQuotes {
                if character == "\"" {
                    if index + 1 < characters.count, characters[index + 1] == "\"" {
                        field.append("\"")
                        index += 2
                        continue
                    }
                    inQuotes = false
                    index += 1
                    continue
                }
                field.append(character)
                index += 1
                continue
            }

            switch character {
            case "\"":
                inQuotes = true
            case delimiter:
                row.append(field)
                field = ""
            case "\r":
                // Swallowed; the following \n closes the row. A lone \r also
                // closes one, which is what old Mac exports emit.
                if index + 1 < characters.count, characters[index + 1] == "\n" {
                    index += 1
                }
                row.append(field)
                field = ""
                rows.append(row)
                row = []
            case "\n":
                row.append(field)
                field = ""
                rows.append(row)
                row = []
            default:
                field.append(character)
            }
            index += 1
        }

        if !field.isEmpty || !row.isEmpty {
            row.append(field)
            rows.append(row)
        }
        // A trailing newline produces one empty row, and a blank line in the
        // middle of a file produces another. Neither is a record.
        return rows.filter { !($0.count == 1 && $0[0].isEmpty) }
    }

    /// Turns rows into segments, repeating the column labels in every segment.
    ///
    /// Repeating the header is not redundancy: a chunk that reads
    /// `12, 4, 2026-01-02` in isolation is unusable as retrieved context, and a
    /// model asked to cite it will invent what the columns mean.
    public static func segments(rows: [[String]], rowsPerSegment: Int) -> [DocumentSegment] {
        guard let first = rows.first else { return [] }

        let header = usableHeader(first)
        let dataRows = header == nil ? rows : Array(rows.dropFirst())
        guard !dataRows.isEmpty else { return [] }

        let labels = header ?? (1 ... (rows.map(\.count).max() ?? 1)).map { "column \($0)" }
        var segments: [DocumentSegment] = []
        var index = 0
        while index < dataRows.count {
            let upper = min(index + max(1, rowsPerSegment), dataRows.count)
            let slice = dataRows[index ..< upper]
            var lines: [String] = ["columns: " + labels.joined(separator: ", ")]
            for (offset, row) in slice.enumerated() {
                let rowNumber = index + offset + 1
                let rendered = row.enumerated().map { column, value -> String in
                    let label = column < labels.count ? labels[column] : "column \(column + 1)"
                    return "\(label): \(value)"
                }.joined(separator: " | ")
                lines.append("row \(rowNumber) — \(rendered)")
            }
            segments.append(
                DocumentSegment(
                    text: lines.joined(separator: "\n"),
                    rowRange: (index + 1) ... upper
                )
            )
            index = upper
        }
        return segments
    }

    /// Whether the first row can be trusted as column labels.
    ///
    /// This tests the data rather than guessing intent. A header row has a
    /// non-empty, non-numeric, unique name in every column; anything else is a
    /// data row, and calling it a header would silently delete a record and
    /// label every other row with that record's values.
    private static func usableHeader(_ row: [String]) -> [String]? {
        let trimmed = row.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !trimmed.isEmpty,
            trimmed.allSatisfy({ !$0.isEmpty && Double($0) == nil }),
            Set(trimmed).count == trimmed.count
        else { return nil }
        return trimmed
    }
}

// MARK: - DOCX

/// Word documents, read straight out of the Office Open XML package.
///
/// `word/document.xml` is scanned rather than fully parsed because the parts of
/// it that matter here are a closed set — paragraph bounds, run text, tabs,
/// breaks, and the paragraph style that marks a heading. A full XML parse would
/// pull in the entire WordprocessingML schema to end up at the same five facts.
public struct OfficeOpenXMLDocumentExtractor: DocumentTextExtracting {
    public init() {}

    public func segments(from data: Data, fileName: String) throws -> [DocumentSegment] {
        let archive = try ZIPArchiveReader(data: data)
        guard let entry = try archive.contents(of: "word/document.xml") else {
            throw DocumentIngestionError.malformedDocument(
                reason: "the package has no word/document.xml part"
            )
        }
        let xml = try DocumentTextDecoder.string(from: entry, fileName: fileName)
        return Self.segments(fromDocumentXML: xml)
    }

    /// Pure, so the paragraph/heading logic is testable without a .docx fixture.
    public static func segments(fromDocumentXML xml: String) -> [DocumentSegment] {
        var segments: [DocumentSegment] = []
        var headingPath: [String] = []
        var currentSection: String?
        var buffer: [String] = []

        func flush() {
            let body = buffer.joined(separator: "\n")
            buffer.removeAll(keepingCapacity: true)
            guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            segments.append(DocumentSegment(text: body, section: currentSection))
        }

        for paragraph in paragraphs(in: xml) {
            let text = paragraphText(paragraph)
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                buffer.append("")
                continue
            }
            if let level = headingLevel(paragraph) {
                flush()
                if headingPath.count >= level {
                    headingPath.removeSubrange((level - 1) ..< headingPath.count)
                }
                while headingPath.count < level - 1 { headingPath.append("") }
                headingPath.append(text)
                currentSection = headingPath.filter { !$0.isEmpty }.joined(separator: " › ")
            }
            buffer.append(text)
        }
        flush()
        return segments
    }

    private static func paragraphs(in xml: String) -> [String] {
        var result: [String] = []
        var remainder = Substring(xml)
        while let openRange = remainder.range(of: "<w:p ") ?? remainder.range(of: "<w:p>") {
            let afterOpen = remainder[openRange.lowerBound...]
            guard let closeRange = afterOpen.range(of: "</w:p>") else {
                // A self-closed `<w:p/>` is an empty paragraph and carries no
                // text; stopping here loses nothing.
                break
            }
            result.append(String(afterOpen[..<closeRange.upperBound]))
            remainder = afterOpen[closeRange.upperBound...]
        }
        return result
    }

    private static func paragraphText(_ paragraph: String) -> String {
        var text = ""
        var remainder = Substring(paragraph)
        while let open = remainder.range(of: "<w:t") {
            let afterTag = remainder[open.upperBound...]
            guard let tagEnd = afterTag.firstIndex(of: ">") else { break }
            // `<w:tab/>` and `<w:tbl>` also start with `<w:t`; only a real text
            // run has a closing `</w:t>`.
            let body = afterTag[afterTag.index(after: tagEnd)...]
            guard afterTag[..<tagEnd].allSatisfy({ $0 != "/" }),
                let close = body.range(of: "</w:t>")
            else {
                remainder = afterTag[afterTag.index(after: tagEnd)...]
                continue
            }
            text += decodeXMLEntities(String(body[..<close.lowerBound]))
            remainder = body[close.upperBound...]
        }
        return text
    }

    private static func headingLevel(_ paragraph: String) -> Int? {
        guard let styleRange = paragraph.range(of: "<w:pStyle") else { return nil }
        let tail = paragraph[styleRange.upperBound...]
        guard let end = tail.firstIndex(of: ">") else { return nil }
        let attributes = tail[..<end]
        guard let valueRange = attributes.range(of: "w:val=\"") else { return nil }
        let value = attributes[valueRange.upperBound...]
        guard let quote = value.firstIndex(of: "\"") else { return nil }
        let style = String(value[..<quote])
        // Word writes `Heading1`; some producers write `heading 1`.
        let normalized = style.lowercased().replacingOccurrences(of: " ", with: "")
        guard normalized.hasPrefix("heading"),
            let level = Int(normalized.dropFirst("heading".count)),
            (1 ... 6).contains(level)
        else { return nil }
        return level
    }

    static func decodeXMLEntities(_ value: String) -> String {
        guard value.contains("&") else { return value }
        var result = ""
        var remainder = Substring(value)
        while let ampersand = remainder.firstIndex(of: "&") {
            result += remainder[..<ampersand]
            let tail = remainder[remainder.index(after: ampersand)...]
            guard let semicolon = tail.firstIndex(of: ";"),
                tail.distance(from: tail.startIndex, to: semicolon) <= 10
            else {
                result.append("&")
                remainder = tail
                continue
            }
            let entity = String(tail[..<semicolon])
            switch entity {
            case "amp": result.append("&")
            case "lt": result.append("<")
            case "gt": result.append(">")
            case "quot": result.append("\"")
            case "apos": result.append("'")
            default:
                if entity.hasPrefix("#x") || entity.hasPrefix("#X"),
                    let code = UInt32(entity.dropFirst(2), radix: 16),
                    let scalar = Unicode.Scalar(code) {
                    result.unicodeScalars.append(scalar)
                } else if entity.hasPrefix("#"),
                    let code = UInt32(entity.dropFirst()),
                    let scalar = Unicode.Scalar(code) {
                    result.unicodeScalars.append(scalar)
                } else {
                    // An entity we do not know is left verbatim rather than
                    // deleted: dropping it would silently alter the text.
                    result += "&\(entity);"
                }
            }
            remainder = tail[tail.index(after: semicolon)...]
        }
        result += remainder
        return result
    }
}

// MARK: - PDF

/// PDF text, with OCR only where the page genuinely has none.
///
/// The gate matters both ways. PDFKit's own text layer is exact, so OCR must
/// never override it; but a scanned contract has no text layer at all, and
/// without the OCR path it ingests as an empty document that reports success.
public struct PDFDocumentExtractor: DocumentTextExtracting {
    /// Whether pages with no embedded text may be rendered and recognised.
    public let allowsOpticalCharacterRecognition: Bool

    public init(allowsOpticalCharacterRecognition: Bool = true) {
        self.allowsOpticalCharacterRecognition = allowsOpticalCharacterRecognition
    }

    /// Whether this build can read PDFs at all, so a caller can say "not on this
    /// device" instead of "empty document".
    public static var isAvailable: Bool {
        #if canImport(PDFKit)
        return true
        #else
        return false
        #endif
    }

    public func segments(from data: Data, fileName: String) throws -> [DocumentSegment] {
        #if canImport(PDFKit)
        guard let document = PDFDocument(data: data) else {
            throw DocumentIngestionError.malformedDocument(
                reason: "the PDF could not be opened"
            )
        }
        // An encrypted PDF opens but yields nothing. Reporting that as an empty
        // document would be a false statement about the file's contents.
        guard !document.isLocked else {
            throw DocumentIngestionError.malformedDocument(
                reason: "the PDF is password protected"
            )
        }

        var segments: [DocumentSegment] = []
        for pageIndex in 0 ..< document.pageCount {
            guard let page = document.page(at: pageIndex) else { continue }
            let pageNumber = pageIndex + 1
            let embedded = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !embedded.isEmpty {
                segments.append(
                    DocumentSegment(
                        text: embedded,
                        pageNumber: pageNumber,
                        extraction: .embeddedText
                    )
                )
                continue
            }
            guard allowsOpticalCharacterRecognition,
                let recognized = Self.recognizedText(on: page),
                !recognized.isEmpty
            else { continue }
            segments.append(
                DocumentSegment(
                    text: recognized,
                    pageNumber: pageNumber,
                    extraction: .opticalCharacterRecognition
                )
            )
        }
        return segments
        #else
        throw DocumentIngestionError.extractorUnavailable(format: .pdf)
        #endif
    }

    #if canImport(PDFKit) && canImport(Vision) && canImport(CoreGraphics)
    /// Renders a page and recognises its text.
    ///
    /// Rendered at 2× because Vision's accuracy falls off sharply below roughly
    /// 150 dpi, which is what a 1× render of a letter-size page produces, and
    /// body text at that size comes back as plausible-looking nonsense — the
    /// worst possible failure for something that will be quoted as a source.
    private static func recognizedText(on page: PDFPage) -> String? {
        guard let pageRef = page.pageRef else { return nil }
        let bounds = page.bounds(for: .mediaBox)
        let scale: CGFloat = 2
        let width = Int((bounds.width * scale).rounded())
        let height = Int((bounds.height * scale).rounded())
        guard width > 0, height > 0, width * height <= 40_000_000 else { return nil }

        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }

        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
        context.drawPDFPage(pageRef)
        guard let image = context.makeImage() else { return nil }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            // OCR failing is not the document failing. The page simply
            // contributes nothing, and the pipeline reports that it used no OCR
            // for it rather than inventing a transcription.
            return nil
        }
        let lines = (request.results ?? []).compactMap {
            $0.topCandidates(1).first?.string
        }
        let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
    #elseif canImport(PDFKit)
    private static func recognizedText(on _: PDFPage) -> String? { nil }
    #endif
}
