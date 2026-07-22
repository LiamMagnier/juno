import Foundation

/// One renderable block of assistant/user message content.
///
/// Chat answers arrive as Markdown text. `AttributedString(markdown:)` handles
/// *inline* styling but collapses every block structure — fenced code loses its
/// monospace run and its horizontal scroll, list items lose their markers, and
/// tables become a single run-on line. So content is split into blocks here and
/// each block is rendered by the view layer with the right affordances.
///
/// The parser is deliberately line-based and total: any input produces blocks,
/// unterminated constructs close at end-of-input, and no input is dropped. That
/// matters because it runs against *streaming* text, where the last fence or
/// table row is routinely half-written.
public enum JunoMarkdownBlock: Equatable, Sendable, Identifiable {
    /// A run of prose. Inline Markdown (bold, italic, code, links) is applied by
    /// the renderer; the raw source is kept so streaming re-parses stay cheap.
    case paragraph(String)
    /// `#`–`######`. `level` is clamped to 1...6.
    case heading(level: Int, text: String)
    /// A fenced (``` / ~~~) or indented code block. `language` is the info
    /// string when present, `isClosed` is false while a fence is still open.
    case code(language: String?, source: String, isClosed: Bool)
    /// Consecutive list items. `ordered` distinguishes `1.` from `-`/`*`/`+`.
    /// `start` is the first number of an ordered list.
    case list(ordered: Bool, start: Int, items: [Item])
    /// A GitHub-style pipe table with a delimiter row.
    case table(header: [String], rows: [[String]])
    /// One or more `>` lines, with the marker stripped.
    case quote(String)
    /// `---`, `***`, `___`.
    case thematicBreak

    /// A single list item. `depth` is the nesting level (0 = top level), so the
    /// renderer can indent without the parser building a tree it would only
    /// have to flatten again.
    public struct Item: Equatable, Sendable {
        public var text: String
        public var depth: Int
        /// Set for `- [ ]` / `- [x]` task-list items; nil for ordinary items.
        public var isChecked: Bool?

        public init(text: String, depth: Int, isChecked: Bool? = nil) {
            self.text = text
            self.depth = depth
            self.isChecked = isChecked
        }
    }

    /// Stable within one parse, which is all `ForEach` needs: blocks are
    /// re-parsed wholesale whenever the content string changes.
    public var id: String {
        switch self {
        case .paragraph(let text): "p:\(text.hashValue)"
        case .heading(let level, let text): "h\(level):\(text.hashValue)"
        case .code(let language, let source, _): "c:\(language ?? ""):\(source.hashValue)"
        case .list(let ordered, let start, let items):
            "l:\(ordered):\(start):\(items.map(\.text).joined().hashValue)"
        case .table(let header, let rows):
            "t:\(header.joined().hashValue):\(rows.count)"
        case .quote(let text): "q:\(text.hashValue)"
        case .thematicBreak: "hr"
        }
    }
}

public enum JunoMarkdown {
    /// Splits Markdown source into renderable blocks.
    ///
    /// Total by construction: every line lands in exactly one block, and an
    /// unterminated fence or table closes at end-of-input rather than
    /// swallowing the remainder or throwing. Streaming text is therefore always
    /// renderable, just occasionally mid-construct.
    public static func blocks(from source: String) -> [JunoMarkdownBlock] {
        var blocks: [JunoMarkdownBlock] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var listItems: [JunoMarkdownBlock.Item] = []
        var listOrdered = false
        var listStart = 1

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
            paragraph.removeAll()
        }
        func flushQuote() {
            guard !quote.isEmpty else { return }
            blocks.append(.quote(quote.joined(separator: "\n")))
            quote.removeAll()
        }
        func flushList() {
            guard !listItems.isEmpty else { return }
            blocks.append(.list(ordered: listOrdered, start: listStart, items: listItems))
            listItems.removeAll()
        }
        func flushAll() {
            flushParagraph()
            flushQuote()
            flushList()
        }

        let lines = source.components(separatedBy: "\n")
        var index = 0
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code. The fence character and length are captured so a
            // shorter inner fence does not close the block early, matching
            // CommonMark.
            if let fence = CodeFence(line: trimmed) {
                flushAll()
                var body: [String] = []
                var closed = false
                index += 1
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    if fence.closes(candidate) {
                        closed = true
                        index += 1
                        break
                    }
                    body.append(lines[index])
                    index += 1
                }
                blocks.append(
                    .code(
                        language: fence.language,
                        source: body.joined(separator: "\n"),
                        isClosed: closed
                    )
                )
                continue
            }

            if trimmed.isEmpty {
                flushAll()
                index += 1
                continue
            }

            if isThematicBreak(trimmed) {
                flushAll()
                blocks.append(.thematicBreak)
                index += 1
                continue
            }

            if let heading = parseHeading(trimmed) {
                flushAll()
                blocks.append(heading)
                index += 1
                continue
            }

            // A table needs its delimiter row to be a table at all; without it
            // the pipes are just prose.
            if trimmed.contains("|"),
                index + 1 < lines.count,
                isTableDelimiter(lines[index + 1].trimmingCharacters(in: .whitespaces))
            {
                flushAll()
                let header = splitTableRow(trimmed)
                var rows: [[String]] = []
                index += 2
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard candidate.contains("|"), !candidate.isEmpty else { break }
                    rows.append(splitTableRow(candidate))
                    index += 1
                }
                blocks.append(.table(header: header, rows: rows))
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                flushList()
                var body = String(trimmed.dropFirst())
                if body.hasPrefix(" ") { body.removeFirst() }
                quote.append(body)
                index += 1
                continue
            }

            if let item = parseListItem(line) {
                flushParagraph()
                flushQuote()
                // A change of list kind starts a new block so ordered and
                // unordered runs never merge into one mis-numbered list.
                if !listItems.isEmpty && listOrdered != item.ordered {
                    flushList()
                }
                if listItems.isEmpty {
                    listOrdered = item.ordered
                    listStart = item.number ?? 1
                }
                listItems.append(item.item)
                index += 1
                continue
            }

            flushQuote()
            flushList()
            paragraph.append(trimmed)
            index += 1
        }
        flushAll()
        return blocks
    }

    // MARK: - Line classification

    private struct CodeFence {
        let marker: Character
        let length: Int
        let language: String?

        init?(line: String) {
            guard let first = line.first, first == "`" || first == "~" else { return nil }
            let run = line.prefix { $0 == first }
            guard run.count >= 3 else { return nil }
            let info = line
                .dropFirst(run.count)
                .trimmingCharacters(in: .whitespaces)
            // A backtick fence's info string may not contain a backtick.
            if first == "`" && info.contains("`") { return nil }
            marker = first
            length = run.count
            language = info.isEmpty ? nil : info
        }

        func closes(_ line: String) -> Bool {
            guard let first = line.first, first == marker else { return false }
            let run = line.prefix { $0 == marker }
            guard run.count >= length else { return false }
            // A closing fence carries no info string.
            return line.dropFirst(run.count).trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private static func parseHeading(_ line: String) -> JunoMarkdownBlock? {
        guard line.hasPrefix("#") else { return nil }
        let hashes = line.prefix { $0 == "#" }
        guard (1...6).contains(hashes.count) else { return nil }
        let rest = line.dropFirst(hashes.count)
        // `#hashtag` is not a heading — ATX requires a space after the run.
        guard rest.isEmpty || rest.hasPrefix(" ") else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces)
        return .heading(level: hashes.count, text: text)
    }

    private static func isThematicBreak(_ line: String) -> Bool {
        for marker in ["-", "*", "_"] {
            let stripped = line.replacingOccurrences(of: " ", with: "")
            if stripped.count >= 3, stripped.allSatisfy({ String($0) == marker }) {
                return true
            }
        }
        return false
    }

    private static func isTableDelimiter(_ line: String) -> Bool {
        guard line.contains("-"), line.contains("|") else { return false }
        let cells = splitTableRow(line)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            let body = cell.trimmingCharacters(in: .whitespaces)
            guard !body.isEmpty else { return false }
            return body.allSatisfy { $0 == "-" || $0 == ":" } && body.contains("-")
        }
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var body = line
        if body.hasPrefix("|") { body.removeFirst() }
        if body.hasSuffix("|") { body.removeLast() }
        return body
            .components(separatedBy: "|")
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private struct ListLine {
        let item: JunoMarkdownBlock.Item
        let ordered: Bool
        let number: Int?
    }

    private static func parseListItem(_ line: String) -> ListLine? {
        let leading = line.prefix { $0 == " " || $0 == "\t" }
        // Tabs count as four columns, matching how the source was most likely
        // authored; two columns per nesting level.
        let columns = leading.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let depth = min(columns / 2, 5)
        let body = line.dropFirst(leading.count)
        guard let marker = body.first else { return nil }

        if marker == "-" || marker == "*" || marker == "+" {
            let rest = body.dropFirst()
            guard rest.hasPrefix(" ") else { return nil }
            var text = rest.trimmingCharacters(in: .whitespaces)
            var checked: Bool?
            if text.hasPrefix("[ ] ") || text == "[ ]" {
                checked = false
                text = String(text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if text.lowercased().hasPrefix("[x] ") || text.lowercased() == "[x]" {
                checked = true
                text = String(text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            }
            return ListLine(
                item: .init(text: text, depth: depth, isChecked: checked),
                ordered: false,
                number: nil
            )
        }

        guard marker.isNumber else { return nil }
        let digits = body.prefix { $0.isNumber }
        let afterDigits = body.dropFirst(digits.count)
        guard let separator = afterDigits.first, separator == "." || separator == ")" else {
            return nil
        }
        let rest = afterDigits.dropFirst()
        guard rest.hasPrefix(" ") else { return nil }
        return ListLine(
            item: .init(
                text: rest.trimmingCharacters(in: .whitespaces),
                depth: depth
            ),
            ordered: true,
            number: Int(digits)
        )
    }
}
