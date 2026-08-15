import Foundation

// Structured data blocks: detection, parsing, and the model Swift Charts draws.
//
// **Pure, and view-free by design.** Every interesting decision here is about
// *what the numbers are* — which column is the category, which cells are absent,
// whether a fence is data at all — and none of it needs a renderer to be
// checked. `InlineChartRenderer.swift` holds the marks; this file holds the
// truth they are drawn from.
//
// ── The rule that shaped the model: ABSENT IS NOT ZERO ───────────────────────
//
// A cell that is empty, `-`, `n/a` or unparseable is ``nil``, never `0`. This is
// the single most consequential line in the file. A bar chart that plots a
// missing month as a bar of height zero does not say "we do not know"; it says
// "it was zero", which is a *specific false claim* about the world, drawn at
// full confidence, in a picture the reader will believe faster than they would
// believe a sentence. So values are `Double?` all the way through, marks are
// omitted rather than floored, and ``JunoChartTable/missingValueCount`` exists
// so the renderer can say out loud how much it did not draw.
//
// ── The rule that shaped detection: OPT IN, NEVER SNIFF ──────────────────────
//
// A ```` ```json ```` fence in an answer about an API response must stay code.
// Replacing it with a pie chart because it happened to parse would destroy the
// thing the reader asked for. So the *format* is sniffed from the payload
// (``JunoChartMarkup/table(structured:)``), but the *decision to draw* comes
// only from an explicit opt-in in the info string — ```` ```chart ````, or a
// data fence carrying a `chart=` directive.

// MARK: - Model

/// The mark family a chart is drawn with. Mirrors the four Swift Charts marks
/// Juno uses, and nothing else: an option the renderer cannot draw is a promise
/// the parser should not make.
public enum JunoChartKind: String, CaseIterable, Sendable {
    /// Compare magnitudes across named categories.
    case bar
    /// A quantity that moves along an ordered axis.
    case line
    /// Individual observations; no connection implied between them.
    case point
    /// Parts of one whole. Single-series only — see ``JunoChartData/chartedColumns``.
    case sector

    /// Accepts the aliases models reach for. `pie` is by far the most common
    /// word for a sector chart and refusing it would be pedantry.
    public init?(directiveValue: String) {
        switch directiveValue.lowercased() {
        case "bar", "column", "bars": self = .bar
        case "line", "area", "trend": self = .line
        case "point", "scatter", "dot", "dots": self = .point
        case "sector", "pie", "donut", "doughnut": self = .sector
        default: return nil
        }
    }
}

/// A parsed data block: one category column, zero or more numeric series.
public struct JunoChartTable: Equatable, Sendable {
    /// One record. `values` is index-aligned with ``valueColumns``.
    public struct Row: Equatable, Sendable {
        public var category: String
        /// `nil` where the source cell was blank, a placeholder, or not a
        /// number. **Never zero-filled** — see the note at the top of the file.
        public var values: [Double?]

        public init(category: String, values: [Double?]) {
            self.category = category
            self.values = values
        }
    }

    /// The label column's header — "Month", "Region", "Model".
    public var categoryColumn: String
    /// Headers of the plottable columns, in source order.
    public var valueColumns: [String]
    public var rows: [Row]
    /// Headers of columns that held no numbers at all.
    ///
    /// Kept rather than forgotten so the renderer can name them. A chart that
    /// silently discards a "Notes" column has told the reader their data is
    /// fully represented, and it is not.
    public var ignoredColumns: [String]

    public init(
        categoryColumn: String,
        valueColumns: [String],
        rows: [Row],
        ignoredColumns: [String] = []
    ) {
        self.categoryColumn = categoryColumn
        self.valueColumns = valueColumns
        self.rows = rows
        self.ignoredColumns = ignoredColumns
    }

    /// How many plottable cells were absent. Zero means the chart is complete.
    public var missingValueCount: Int {
        rows.reduce(0) { $0 + $1.values.filter { $0 == nil }.count }
    }

    /// A table with no numbers is not a chart, and drawing an empty axis pair is
    /// worse than showing the source.
    public var isPlottable: Bool {
        !valueColumns.isEmpty && rows.contains { $0.values.contains { $0 != nil } }
    }
}

/// A chart, ready to render: the marks to use, what to call it, and the numbers.
public struct JunoChartData: Equatable, Sendable {
    public var kind: JunoChartKind
    /// From a `title=` directive. `nil` means the block had no title — the
    /// renderer draws no caption rather than inventing one from the columns.
    public var title: String?
    public var table: JunoChartTable

    public init(kind: JunoChartKind, title: String? = nil, table: JunoChartTable) {
        self.kind = kind
        self.title = title
        self.table = table
    }

    /// The columns this chart actually draws.
    ///
    /// A sector chart divides one whole, so a second series has nowhere to go.
    /// Rather than refusing the block or silently summing the series into a
    /// meaningless total, it draws the first and the renderer names the rest as
    /// undrawn — the same contract as ``JunoChartTable/ignoredColumns``.
    public var chartedColumns: [String] {
        kind == .sector ? Array(table.valueColumns.prefix(1)) : table.valueColumns
    }

    /// Columns the *chart kind* cannot show, as opposed to columns the data
    /// could not supply.
    public var undrawnColumns: [String] {
        Array(table.valueColumns.dropFirst(chartedColumns.count))
    }
}

// MARK: - Detection

public enum JunoChartMarkup {
    /// The info-string words that make a fence eligible to become a chart.
    ///
    /// `chart` is the opt-in. The data formats are listed too, but they only
    /// qualify when the info string *also* carries a `chart=` directive — see
    /// ``data(fenceInfo:source:)``. Listing them here keeps the two rules in one
    /// place instead of spread across a condition.
    static let dataFormatWords: Set<String> = ["csv", "tsv", "json", "ndjson", "data"]

    /// Directives parsed out of a fence's info string.
    public struct Directive: Equatable, Sendable {
        /// The first word: `chart`, `csv`, `json`…
        public var format: String
        public var kind: JunoChartKind?
        public var title: String?

        public init(format: String, kind: JunoChartKind? = nil, title: String? = nil) {
            self.format = format
            self.kind = kind
            self.title = title
        }
    }

    /// Parses ```` ```chart type=line title="Revenue by month" ````.
    ///
    /// Tolerant on purpose: unknown keys are ignored, quotes are optional when
    /// the value has no spaces, and `type`/`kind`/`chart` are accepted as
    /// synonyms because there is no way for a model to know which one Juno
    /// wanted. A directive it cannot understand costs the reader a default
    /// chart, never an error.
    public static func directive(_ info: String?) -> Directive? {
        guard let info else { return nil }
        let tokens = tokenise(info.trimmingCharacters(in: .whitespaces))
        guard let format = tokens.first?.lowercased() else { return nil }

        var directive = Directive(format: format)
        for token in tokens.dropFirst() {
            guard let separator = token.firstIndex(of: "=") else { continue }
            let key = token[token.startIndex..<separator].lowercased()
            var value = String(token[token.index(after: separator)...])
            if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
                value = String(value.dropFirst().dropLast())
            }
            switch key {
            case "type", "kind", "chart": directive.kind = JunoChartKind(directiveValue: value)
            case "title", "label": directive.title = value.isEmpty ? nil : value
            default: continue
            }
        }
        return directive
    }

    /// Whether a fence should be drawn as a chart rather than as code.
    ///
    /// Two ways in, and no third: the fence says `chart`, or it names a data
    /// format *and* carries a `chart=` directive. Anything else — including a
    /// ```` ```json ```` block that would parse perfectly — stays code, because
    /// the reader who asked to see JSON asked to see JSON.
    public static func isChartFence(info: String?) -> Bool {
        guard let directive = directive(info) else { return false }
        if directive.format == "chart" { return true }
        return dataFormatWords.contains(directive.format) && directive.kind != nil
    }

    /// The whole fence path: eligibility, parsing, and kind selection.
    ///
    /// Returns `nil` — meaning "render this as an ordinary code block" — for a
    /// fence that is not opted in, a payload that does not parse, and a table
    /// with nothing plottable in it. Each of those is a case where showing the
    /// source is strictly more useful than showing an empty chart.
    public static func data(fenceInfo info: String?, source: String) -> JunoChartData? {
        guard isChartFence(info: info), let directive = directive(info) else { return nil }
        guard let table = table(structured: source), table.isPlottable else { return nil }
        return JunoChartData(
            kind: directive.kind ?? defaultKind(for: table),
            title: directive.title,
            table: table
        )
    }

    /// When the author did not say which chart to draw.
    ///
    /// A numeric category column is an ordered axis — years, indices, doses —
    /// and a line says "these connect", which is true of a sequence and false of
    /// a set of named categories. Everything else gets bars, which claim the
    /// least.
    static func defaultKind(for table: JunoChartTable) -> JunoChartKind {
        let categories = table.rows.map(\.category)
        guard !categories.isEmpty else { return .bar }
        return categories.allSatisfy { numeric($0) != nil } ? .line : .bar
    }

    /// Splits an info string on whitespace while keeping `"quoted values"`
    /// together, so `title="Q3 revenue"` survives as one token.
    private static func tokenise(_ info: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var quoted = false
        for character in info {
            if character == "\"" {
                quoted.toggle()
                current.append(character)
                continue
            }
            if !quoted, character == " " || character == "\t" {
                if !current.isEmpty { tokens.append(current) }
                current.removeAll()
                continue
            }
            current.append(character)
        }
        if !current.isEmpty { tokens.append(current) }
        return tokens
    }
}

// MARK: - Format sniffing

public extension JunoChartMarkup {
    /// The structured-data detector: works out what shape the payload is and
    /// parses it.
    ///
    /// Sniffs the *content*, not the fence label, because a ```` ```chart ````
    /// fence may hold CSV, JSON or a Markdown pipe table and a model will not
    /// reliably tell you which. Order matters: JSON is checked first because its
    /// opening brace is unambiguous, then pipe tables, then delimited text as
    /// the general case.
    static func table(structured source: String) -> JunoChartTable? {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if trimmed.hasPrefix("[") || trimmed.hasPrefix("{") {
            return table(json: trimmed)
        }
        if let pipe = pipeTable(in: trimmed) {
            return table(header: pipe.header, rows: pipe.rows)
        }
        return table(delimited: trimmed)
    }

    /// Comma-, tab- or semicolon-separated values with a header row.
    ///
    /// Quoting follows RFC 4180: a field may be wrapped in `"`, may contain the
    /// separator and newlines while wrapped, and escapes a literal quote by
    /// doubling it. That is not gold-plating — `"1,234"` and `"Smith, J."` are
    /// exactly what a model emits when asked for CSV, and a naive
    /// `split(separator:)` turns both into two columns and silently shifts every
    /// value after them into the wrong series.
    static func table(delimited source: String) -> JunoChartTable? {
        let separator = detectSeparator(source)
        let grid = parseDelimited(source, separator: separator).filter { row in
            !(row.count == 1 && row[0].trimmingCharacters(in: .whitespaces).isEmpty)
        }
        guard let header = grid.first, header.count >= 2, grid.count >= 2 else { return nil }
        return table(header: header, rows: Array(grid.dropFirst()))
    }

    /// A JSON array of flat objects — `[{"month":"Jan","revenue":10}, …]`.
    ///
    /// **Column order comes from the raw text, not from the decoded
    /// dictionary.** `JSONSerialization` hands back an unordered
    /// `[String: Any]`, so ordering by anything it returns would make the series
    /// order — and therefore the legend, and the colours — change between runs
    /// on identical input. Sorting alphabetically would be stable and wrong: it
    /// would put "cost" before "revenue" regardless of what the author wrote.
    /// So the keys are read back off the source in the order they appear.
    static func table(json source: String) -> JunoChartTable? {
        guard let data = source.data(using: .utf8),
            let decoded = try? JSONSerialization.jsonObject(with: data)
        else { return nil }

        let objects: [[String: Any]]
        if let array = decoded as? [[String: Any]] {
            objects = array
        } else if let single = decoded as? [String: Any] {
            objects = [single]
        } else {
            return nil
        }
        guard !objects.isEmpty else { return nil }

        var keys = textualKeyOrder(in: source)
        // Any key present in the data but not found by the textual pass — an
        // object later in the array with an extra field — is appended rather
        // than dropped. A column that exists must be offered.
        for object in objects {
            for key in object.keys.sorted() where !keys.contains(key) {
                keys.append(key)
            }
        }
        guard keys.count >= 2 else { return nil }

        let rows = objects.map { object in
            keys.map { key -> String in
                guard let value = object[key], !(value is NSNull) else { return "" }
                if let number = value as? NSNumber { return numberText(number) }
                return String(describing: value)
            }
        }
        return table(header: keys, rows: rows)
    }

    /// Builds a table from an already-split grid — the shared tail of every
    /// format, and the entry point a Markdown pipe table uses directly.
    ///
    /// Column roles are inferred, not declared: the category is the first column
    /// with no numbers in it (a label column), falling back to the first column
    /// when every column is numeric, because a series of numbers still needs
    /// something on the x axis.
    static func table(header: [String], rows: [[String]]) -> JunoChartTable? {
        guard header.count >= 2, !rows.isEmpty else { return nil }
        let width = header.count

        func column(_ index: Int) -> [String] {
            rows.map { $0.indices.contains(index) ? $0[index] : "" }
        }
        let numericColumns = (0..<width).map { index in
            let cells = column(index).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            return !cells.isEmpty && cells.allSatisfy { numeric($0) != nil }
        }

        let categoryIndex = (0..<width).first { !numericColumns[$0] } ?? 0
        var valueIndices: [Int] = []
        var ignored: [String] = []
        for index in 0..<width where index != categoryIndex {
            if column(index).contains(where: { numeric($0) != nil }) {
                valueIndices.append(index)
            } else {
                ignored.append(header[index])
            }
        }

        let parsedRows = rows.map { row in
            JunoChartTable.Row(
                category: row.indices.contains(categoryIndex)
                    ? row[categoryIndex].trimmingCharacters(in: .whitespaces)
                    : "",
                // `numeric` returns nil for an absent cell and the model keeps
                // it nil. This is the load-bearing line of the whole file.
                values: valueIndices.map { row.indices.contains($0) ? numeric(row[$0]) : nil }
            )
        }

        return JunoChartTable(
            categoryColumn: header[categoryIndex].trimmingCharacters(in: .whitespaces),
            valueColumns: valueIndices.map { header[$0].trimmingCharacters(in: .whitespaces) },
            rows: parsedRows,
            ignoredColumns: ignored
        )
    }
}

// MARK: - Cell parsing

public extension JunoChartMarkup {
    /// Placeholders that mean "we do not have this value".
    ///
    /// They map to `nil`, alongside every other cell that fails to parse. The
    /// list exists because these spellings are *common* in generated tables and
    /// each one would otherwise be an unparseable string — which lands in the
    /// same place, but silently, and would make a real typo look like a
    /// deliberate gap.
    static let absentMarkers: Set<String> = [
        "", "-", "–", "—", "n/a", "na", "null", "nil", "none", "?", ".", "tbd", "nan",
    ]

    /// Reads one cell as a number, or `nil` when there is no number in it.
    ///
    /// Handles the decorations that arrive with real data: a leading currency
    /// symbol, grouping commas inside a quoted field, a trailing `%`, and
    /// parenthesised negatives from spreadsheet exports — `(1,200)` is −1200,
    /// and reading it as `1200` would invert the sign of a loss.
    static func numeric(_ cell: String) -> Double? {
        var text = cell.trimmingCharacters(in: .whitespaces)
        guard !absentMarkers.contains(text.lowercased()) else { return nil }

        var negative = false
        if text.hasPrefix("("), text.hasSuffix(")") {
            negative = true
            text = String(text.dropFirst().dropLast())
        }
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: "$€£¥₹"))
        if text.hasSuffix("%") { text = String(text.dropLast()) }
        text = text.replacingOccurrences(of: ",", with: "")
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "\u{00A0}", with: "")
            .trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, let value = Double(text), value.isFinite else { return nil }
        return negative ? -value : value
    }

    /// Formats a cell value for a label or a tooltip. Integers lose their `.0`;
    /// everything else keeps at most two decimals, so an axis does not sprout
    /// `1.2999999999999998`.
    static func label(for value: Double) -> String {
        if value == value.rounded(), abs(value) < 1e15 {
            return String(Int(value))
        }
        return String(format: "%.2f", value)
    }
}

// MARK: - Low-level parsing

private extension JunoChartMarkup {
    /// Picks the separator by counting candidates outside quotes on the header
    /// line. Tabs win ties, then semicolons, then commas — a tab in a header is
    /// almost never incidental, whereas a comma frequently is.
    static func detectSeparator(_ source: String) -> Character {
        let firstLine = source.components(separatedBy: "\n").first ?? ""
        var counts: [Character: Int] = ["\t": 0, ";": 0, ",": 0]
        var quoted = false
        for character in firstLine {
            if character == "\"" { quoted.toggle(); continue }
            guard !quoted, counts[character] != nil else { continue }
            counts[character, default: 0] += 1
        }
        for candidate in ["\t", ";", ","] where counts[Character(candidate)] ?? 0 > 0 {
            return Character(candidate)
        }
        return ","
    }

    /// RFC 4180 split. Total: an unterminated quote runs to end-of-input rather
    /// than dropping the tail, which is the streaming case again.
    static func parseDelimited(_ source: String, separator: Character) -> [[String]] {
        var grid: [[String]] = []
        var row: [String] = []
        var field = ""
        var quoted = false
        var index = source.startIndex

        while index < source.endIndex {
            let character = source[index]
            if quoted {
                if character == "\"" {
                    let next = source.index(after: index)
                    if next < source.endIndex, source[next] == "\"" {
                        field.append("\"")
                        index = source.index(after: next)
                        continue
                    }
                    quoted = false
                    index = next
                    continue
                }
                field.append(character)
                index = source.index(after: index)
                continue
            }
            switch character {
            case "\"":
                quoted = true
            case separator:
                row.append(field.trimmingCharacters(in: .whitespaces))
                field.removeAll()
            case "\n":
                row.append(field.trimmingCharacters(in: .whitespaces))
                field.removeAll()
                grid.append(row)
                row.removeAll()
            case "\r":
                break
            default:
                field.append(character)
            }
            index = source.index(after: index)
        }
        row.append(field.trimmingCharacters(in: .whitespaces))
        grid.append(row)
        return grid
    }

    /// A Markdown pipe table inside a data fence. Reuses the delimiter-row rule
    /// so `| --- |` is required here exactly as it is in prose — pipes alone are
    /// not a table, in either place.
    static func pipeTable(in source: String) -> (header: [String], rows: [[String]])? {
        let lines = source.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard lines.count >= 3, lines[0].contains("|") else { return nil }

        let delimiter = lines[1]
        let delimiterCells = splitPipeRow(delimiter)
        guard !delimiterCells.isEmpty,
            delimiterCells.allSatisfy({ cell in
                !cell.isEmpty && cell.allSatisfy { $0 == "-" || $0 == ":" } && cell.contains("-")
            })
        else { return nil }

        return (splitPipeRow(lines[0]), lines.dropFirst(2).map(splitPipeRow))
    }

    static func splitPipeRow(_ line: String) -> [String] {
        var body = line
        if body.hasPrefix("|") { body.removeFirst() }
        if body.hasSuffix("|") { body.removeLast() }
        return body.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// Keys of the first JSON object, in the order they appear in the source
    /// text. See ``table(json:)`` for why this cannot come from the decoder.
    static func textualKeyOrder(in source: String) -> [String] {
        guard let start = source.firstIndex(of: "{") else { return [] }
        var keys: [String] = []
        var index = source.index(after: start)
        var depth = 1

        while index < source.endIndex, depth > 0 {
            let character = source[index]
            if character == "{" { depth += 1 }
            if character == "}" { depth -= 1; index = source.index(after: index); continue }
            guard character == "\"" else {
                index = source.index(after: index)
                continue
            }
            // Read the string, then decide whether a colon follows: only then
            // was it a key rather than a value.
            var name = ""
            index = source.index(after: index)
            while index < source.endIndex, source[index] != "\"" {
                if source[index] == "\\" {
                    index = source.index(after: index)
                    if index >= source.endIndex { break }
                }
                name.append(source[index])
                index = source.index(after: index)
            }
            if index < source.endIndex { index = source.index(after: index) }
            var lookahead = index
            while lookahead < source.endIndex, source[lookahead].isWhitespace {
                lookahead = source.index(after: lookahead)
            }
            if lookahead < source.endIndex, source[lookahead] == ":", depth == 1,
                !keys.contains(name)
            {
                keys.append(name)
            }
        }
        return keys
    }

    /// `NSNumber` stringifies booleans as `0`/`1` and doubles with a trailing
    /// `.0`; both would then re-parse as numbers and put a boolean column on a
    /// value axis. Rendering through the same text path every other format takes
    /// keeps one definition of what a cell is.
    static func numberText(_ number: NSNumber) -> String {
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
        let value = number.doubleValue
        return value == value.rounded() && abs(value) < 1e15
            ? String(number.int64Value)
            : String(value)
    }
}
