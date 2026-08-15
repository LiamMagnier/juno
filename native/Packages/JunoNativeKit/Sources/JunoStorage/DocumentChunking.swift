import Foundation

/// The document formats this package can turn into retrievable text.
///
/// The raw values are the canonical lowercase extensions so a file name is
/// enough to infer a format without a second mapping table drifting out of sync
/// with this one.
public enum IngestibleDocumentFormat: String, CaseIterable, Equatable, Sendable {
    case pdf
    case docx
    case csv
    case markdown = "md"
    case plainText = "txt"

    /// The format implied by a file name, or nil when the name does not name one.
    ///
    /// Nil rather than a `.plainText` default on purpose. Guessing plain text for
    /// an unknown extension is how a `.pages` or `.key` file gets ingested as a
    /// wall of binary garbage that then scores as a legitimate retrieval hit; the
    /// caller has to be told we do not know rather than handed a false answer.
    public static func inferred(fromFileName fileName: String) -> Self? {
        let ext = (fileName as NSString).pathExtension.lowercased()
        switch ext {
        case "pdf": return .pdf
        case "docx": return .docx
        case "csv": return .csv
        case "md", "markdown", "mdown": return .markdown
        case "txt", "text", "log": return .plainText
        default: return nil
        }
    }
}

/// How the text of a segment was recovered from the file.
///
/// Recorded rather than discarded because the two are not equally trustworthy:
/// OCR output contains transcription errors that embedded text does not, and a
/// surface that quotes a chunk back to a person should be able to say which one
/// it is looking at. A pipeline that flattens the distinction quietly presents a
/// guess as a transcript.
public enum DocumentTextExtractionMethod: String, Equatable, Sendable {
    case embeddedText
    case opticalCharacterRecognition
}

/// One contiguous piece of a source document that shares a single set of
/// positional facts.
///
/// Segmenting before chunking is what keeps metadata honest. If the whole
/// document were chunked as one string, a chunk that straddles a page boundary
/// would have to claim one page number and lie about the rest of its content;
/// by cutting at every point where the page, section, or row range changes, the
/// facts attached to a chunk are always true of every character in it.
public struct DocumentSegment: Equatable, Sendable {
    public let text: String
    /// 1-based page number, or nil for formats that have no pages.
    ///
    /// A CSV has no page 1. Defaulting it to `1` would let a citation claim a
    /// page location the source document does not have.
    public let pageNumber: Int?
    /// The heading path this text sits under, e.g. `Guide › Installation`, or
    /// nil when the document has no heading above it. Never a placeholder.
    public let section: String?
    /// 1-based, inclusive row range for tabular formats, nil otherwise.
    public let rowRange: ClosedRange<Int>?
    public let extraction: DocumentTextExtractionMethod

    public init(
        text: String,
        pageNumber: Int? = nil,
        section: String? = nil,
        rowRange: ClosedRange<Int>? = nil,
        extraction: DocumentTextExtractionMethod = .embeddedText
    ) {
        self.text = text
        self.pageNumber = pageNumber
        self.section = section
        self.rowRange = rowRange
        self.extraction = extraction
    }
}

/// Everything known about where a chunk came from.
///
/// This travels with the chunk all the way into a prompt and back out into a
/// citation, so every field here is either a fact about the source or nil.
public struct DocumentChunkMetadata: Equatable, Sendable {
    public let sourceName: String
    public let format: IngestibleDocumentFormat
    public let pageNumber: Int?
    public let section: String?
    public let rowRange: ClosedRange<Int>?
    /// 0-based position of this chunk within its document, in reading order.
    public let chunkIndex: Int
    /// Character offsets of this chunk *within its segment*, not within the
    /// whole document. Segment-relative because that is the only offset the
    /// pipeline can state truthfully: OCR and PDF extraction never reconstruct a
    /// single document-wide character stream.
    public let characterRange: Range<Int>
    public let extraction: DocumentTextExtractionMethod

    public init(
        sourceName: String,
        format: IngestibleDocumentFormat,
        pageNumber: Int?,
        section: String?,
        rowRange: ClosedRange<Int>?,
        chunkIndex: Int,
        characterRange: Range<Int>,
        extraction: DocumentTextExtractionMethod
    ) {
        self.sourceName = sourceName
        self.format = format
        self.pageNumber = pageNumber
        self.section = section
        self.rowRange = rowRange
        self.chunkIndex = chunkIndex
        self.characterRange = characterRange
        self.extraction = extraction
    }

    /// A short human-readable locator, e.g. `Report.pdf, page 4 — Methodology`.
    ///
    /// Only the parts that are actually known are rendered. This string ends up
    /// under a citation marker, so an invented "page 1" here becomes a false
    /// claim on screen.
    public var locator: String {
        var parts: [String] = [sourceName]
        if let pageNumber { parts.append("page \(pageNumber)") }
        if let rowRange {
            parts.append(
                rowRange.lowerBound == rowRange.upperBound
                    ? "row \(rowRange.lowerBound)"
                    : "rows \(rowRange.lowerBound)–\(rowRange.upperBound)"
            )
        }
        var locator = parts.joined(separator: ", ")
        if let section, !section.isEmpty { locator += " — \(section)" }
        return locator
    }
}

public struct DocumentChunk: Equatable, Sendable, Identifiable {
    /// Stable across re-ingestion of the same bytes, because it is derived only
    /// from the source name and the chunk's position. A random UUID here would
    /// duplicate every chunk in the retrieval index on every re-import.
    public let id: String
    public let text: String
    public let metadata: DocumentChunkMetadata

    public init(id: String, text: String, metadata: DocumentChunkMetadata) {
        self.id = id
        self.text = text
        self.metadata = metadata
    }
}

/// A span of the input text, with the offsets it was taken from.
public struct TextChunkSpan: Equatable, Sendable {
    public let text: String
    public let range: Range<Int>

    public init(text: String, range: Range<Int>) {
        self.text = text
        self.range = range
    }
}

public struct TextChunkingOptions: Equatable, Sendable {
    /// Hard ceiling on the characters in one chunk, **overlap included**.
    ///
    /// Included rather than added on top, because this number is chosen against
    /// a model's context budget and a chunker that quietly returns 1.5× it makes
    /// that budget unenforceable.
    public var maximumCharacters: Int
    /// How much of the preceding text is repeated at the head of a chunk.
    ///
    /// Overlap exists because a fact that straddles a chunk boundary is
    /// otherwise retrievable by neither half: the sentence naming the subject
    /// lands in chunk N and the sentence carrying the number lands in N+1, and a
    /// query mentioning both matches neither well.
    public var overlapCharacters: Int
    /// The recursion ladder, coarsest first. Splitting is attempted at the
    /// coarsest separator that actually occurs, so a chunk boundary lands
    /// between paragraphs before it lands between words.
    public var separators: [String]

    public init(
        maximumCharacters: Int = 1200,
        overlapCharacters: Int = 160,
        separators: [String] = ["\n\n", "\n", ". ", "; ", ", ", " "]
    ) {
        // A non-positive ceiling makes chunking undefined, and an overlap at or
        // above the ceiling makes every chunk start at or before the previous
        // one — an infinite document. Clamp rather than trap: a bad constant in
        // a caller must not crash an import.
        self.maximumCharacters = max(1, maximumCharacters)
        self.overlapCharacters = max(0, min(overlapCharacters, self.maximumCharacters / 2))
        self.separators = separators
    }

    public static let `default` = TextChunkingOptions()
}

/// Recursive character chunking: pure, deterministic, and offset-exact.
///
/// Pure by design. This is the one piece of ingestion whose behaviour a test can
/// pin down completely, and it stays that way only if it never touches a file, a
/// clock, or a model. Everything format-specific happens before it, in
/// extraction; everything storage-specific happens after it.
public enum RecursiveTextChunker {
    /// Splits `text` into overlapping spans no longer than
    /// `options.maximumCharacters`.
    ///
    /// Every returned `range` indexes `Array(text)` — character offsets, not
    /// UTF-8 or UTF-16 offsets — and `text` is exactly the substring at that
    /// range. Emoji and combining marks are therefore never cut in half, which
    /// byte offsets would do.
    public static func chunks(
        in text: String,
        options: TextChunkingOptions = .default
    ) -> [TextChunkSpan] {
        let characters = Array(text)
        guard !characters.isEmpty else { return [] }

        // Room for the overlap is reserved out of the ceiling rather than added
        // on top of it. Splitting to the full ceiling and *then* prepending
        // overlap produces chunks up to 1.5× the number the caller asked for,
        // which is how a chunk sized to a model's budget quietly overruns it.
        let coreCeiling = max(1, options.maximumCharacters - options.overlapCharacters)

        let atoms = atomize(
            characters: characters,
            range: 0 ..< characters.count,
            separators: options.separators,
            depth: 0,
            maximum: coreCeiling
        )
        guard !atoms.isEmpty else { return [] }

        let cores = merge(atoms: atoms, maximum: coreCeiling)
        return finish(
            cores: cores,
            characters: characters,
            overlap: options.overlapCharacters
        )
    }

    // MARK: - Step 1: atoms

    /// Cuts `range` down to pieces no larger than `maximum`, descending the
    /// separator ladder only as far as it has to.
    ///
    /// The pieces keep their separators attached to the *end* of the preceding
    /// piece, so concatenating every atom reproduces the input exactly. That is
    /// what makes the reported offsets trustworthy; a splitter that drops
    /// separators silently shifts every offset after the first cut.
    private static func atomize(
        characters: [Character],
        range: Range<Int>,
        separators: [String],
        depth: Int,
        maximum: Int
    ) -> [Range<Int>] {
        guard !range.isEmpty else { return [] }
        guard range.count > maximum else { return [range] }
        guard depth < separators.count else {
            return hardSplit(range: range, maximum: maximum)
        }

        let separator = Array(separators[depth])
        guard !separator.isEmpty else {
            return atomize(
                characters: characters,
                range: range,
                separators: separators,
                depth: depth + 1,
                maximum: maximum
            )
        }

        let pieces = split(characters: characters, range: range, separator: separator)
        guard pieces.count > 1 else {
            return atomize(
                characters: characters,
                range: range,
                separators: separators,
                depth: depth + 1,
                maximum: maximum
            )
        }

        return pieces.flatMap {
            atomize(
                characters: characters,
                range: $0,
                separators: separators,
                depth: depth + 1,
                maximum: maximum
            )
        }
    }

    private static func split(
        characters: [Character],
        range: Range<Int>,
        separator: [Character]
    ) -> [Range<Int>] {
        var pieces: [Range<Int>] = []
        var pieceStart = range.lowerBound
        var index = range.lowerBound
        let limit = range.upperBound - separator.count

        while index <= limit {
            var matches = true
            for offset in 0 ..< separator.count where characters[index + offset] != separator[offset] {
                matches = false
                break
            }
            if matches {
                let end = index + separator.count
                pieces.append(pieceStart ..< end)
                pieceStart = end
                index = end
            } else {
                index += 1
            }
        }

        if pieceStart < range.upperBound {
            pieces.append(pieceStart ..< range.upperBound)
        }
        return pieces
    }

    /// The last resort, used only when no separator in the ladder occurs inside
    /// an oversized run (a minified blob, a base64 payload, a language with no
    /// spaces). Cutting mid-word is bad retrieval; silently emitting a chunk ten
    /// times the model's budget is worse.
    private static func hardSplit(range: Range<Int>, maximum: Int) -> [Range<Int>] {
        var pieces: [Range<Int>] = []
        var start = range.lowerBound
        while start < range.upperBound {
            let end = min(start + maximum, range.upperBound)
            pieces.append(start ..< end)
            start = end
        }
        return pieces
    }

    // MARK: - Step 2: merge

    private static func merge(atoms: [Range<Int>], maximum: Int) -> [Range<Int>] {
        var cores: [Range<Int>] = []
        var current: Range<Int>?

        for atom in atoms {
            guard let open = current else {
                current = atom
                continue
            }
            if atom.upperBound - open.lowerBound <= maximum {
                current = open.lowerBound ..< atom.upperBound
            } else {
                cores.append(open)
                current = atom
            }
        }
        if let open = current { cores.append(open) }
        return cores
    }

    // MARK: - Step 3: overlap and trim

    private static func finish(
        cores: [Range<Int>],
        characters: [Character],
        overlap: Int
    ) -> [TextChunkSpan] {
        var spans: [TextChunkSpan] = []
        var emitted = Set<Range<Int>>()

        for (index, core) in cores.enumerated() {
            var start = core.lowerBound
            if index > 0, overlap > 0 {
                // Never reach back past the previous chunk's own start: doing so
                // would let chunk N+1 fully contain chunk N, which is a
                // duplicate rather than an overlap.
                let floor = max(cores[index - 1].lowerBound, core.lowerBound - overlap)
                start = floor
            }

            var end = core.upperBound
            while start < end, characters[start].isWhitespace { start += 1 }
            while end > start, characters[end - 1].isWhitespace { end -= 1 }
            guard start < end else { continue }

            let range = start ..< end
            // Trimming can collapse two neighbouring cores onto the same span
            // (a run of blank lines between them). Emitting it twice would
            // double-count the passage in every downstream score.
            guard emitted.insert(range).inserted else { continue }
            spans.append(
                TextChunkSpan(text: String(characters[range]), range: range)
            )
        }

        return spans
    }
}
