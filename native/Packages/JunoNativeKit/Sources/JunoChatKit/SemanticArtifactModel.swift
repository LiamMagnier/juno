import Foundation

/// The three semantic artifact bodies — SPREADSHEET, DOCUMENT and
/// PRESENTATION — read for drawing.
///
/// The web owns these models (`src/lib/work/deliverables/semantic/*`): a
/// stored body is the canonical JSON its validators write, and the body a chat
/// tag carries is the looser *authoring* form the model writes (rows instead
/// of addressed cells, ids left out, list items as bare strings). This reader
/// takes both, so a card can draw from the tag while the stored row is still
/// on its way, and it never validates beyond what drawing needs: the server
/// has already refused anything malformed before it stored it.
public enum SemanticArtifact: Equatable, Sendable {
    case workbook(SemanticWorkbook)
    case document(SemanticDocument)
    case deck(SemanticDeck)

    public enum ParseError: Error, Equatable, LocalizedError, Sendable {
        case notSemantic
        case notJSON
        case wrongShape(String)

        public var errorDescription: String? {
            switch self {
            case .notSemantic: "This artifact is not a spreadsheet, document or deck."
            case .notJSON: "This version could not be opened: its body is not JSON."
            case .wrongShape(let detail): "This version could not be opened: \(detail)."
            }
        }
    }

    public static func parse(kind: NativeArtifactKind, content: String) throws -> SemanticArtifact {
        guard kind.isSemantic else { throw ParseError.notSemantic }
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any]
        else { throw ParseError.notJSON }
        switch kind {
        case .spreadsheet: return .workbook(try SemanticWorkbook(json: object))
        case .document: return .document(try SemanticDocument(json: object))
        case .presentation: return .deck(try SemanticDeck(json: object))
        default: throw ParseError.notSemantic
        }
    }

    /// `try? parse`, for surfaces that fall back to source.
    public static func parsed(kind: NativeArtifactKind, content: String) -> SemanticArtifact? {
        try? parse(kind: kind, content: content)
    }

    public var title: String {
        switch self {
        case .workbook(let book): book.title
        case .document(let document): document.title
        case .deck(let deck): deck.title
        }
    }

    /// The web's `describeSemantic`: "3 sheets · 2 formulas · 1 chart",
    /// "14 blocks · 2 comments", "8 slides".
    public var summary: String {
        func count(_ n: Int, _ noun: String) -> String { "\(n) \(noun)\(n == 1 ? "" : "s")" }
        switch self {
        case .workbook(let book):
            let formulas = book.sheets.reduce(0) { $0 + $1.cells.values.filter { $0.formula != nil }.count }
            let charts = book.sheets.reduce(0) { $0 + $1.chartCount }
            return [
                count(book.sheets.count, "sheet"),
                formulas > 0 ? count(formulas, "formula") : nil,
                charts > 0 ? count(charts, "chart") : nil,
            ].compactMap { $0 }.joined(separator: " · ")
        case .document(let document):
            let open = document.comments.filter { !$0.resolved }.count
            let pending = document.revisions.filter { $0.status == "pending" }.count
            return [
                count(document.blocks.count, "block"),
                open > 0 ? count(open, "comment") : nil,
                pending > 0 ? count(pending, "suggestion") : nil,
            ].compactMap { $0 }.joined(separator: " · ")
        case .deck(let deck):
            return count(deck.slides.count, "slide")
        }
    }

    /// The summary for a body, or nil when it does not open.
    public static func summary(kind: NativeArtifactKind, content: String) -> String? {
        parsed(kind: kind, content: content)?.summary
    }
}

// MARK: - JSON helpers

private extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String? {
        if let value = self[key] as? String { return value }
        return nil
    }

    func int(_ key: String) -> Int? {
        if let value = self[key] as? NSNumber, !(value === kCFBooleanTrue || value === kCFBooleanFalse) {
            return value.intValue
        }
        return nil
    }

    func bool(_ key: String) -> Bool? {
        if let value = self[key] as? NSNumber, value === kCFBooleanTrue || value === kCFBooleanFalse {
            return value.boolValue
        }
        return nil
    }

    func objects(_ key: String) -> [[String: Any]] {
        (self[key] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
    }
}

private func isBoolean(_ number: NSNumber) -> Bool {
    number === kCFBooleanTrue || number === kCFBooleanFalse
}

// MARK: - Workbook

/// A cell address, 1-based: `B3` is row 3, column 2.
public struct SemanticCellAddress: Hashable, Comparable, Sendable {
    public let row: Int
    public let column: Int

    public init(row: Int, column: Int) {
        self.row = row
        self.column = column
    }

    /// `A1`, `$B$7`, `aa10`. Nil for anything else.
    public init?(_ text: String) {
        var letters = ""
        var digits = ""
        for character in text.uppercased() where character != "$" {
            if character.isASCII, character.isLetter, digits.isEmpty { letters.append(character) }
            else if character.isASCII, character.isNumber, !letters.isEmpty { digits.append(character) }
            else { return nil }
        }
        guard (1...3).contains(letters.count), let row = Int(digits), row >= 1, row <= 1_048_576 else { return nil }
        var column = 0
        for scalar in letters.unicodeScalars { column = column * 26 + Int(scalar.value) - 64 }
        guard column >= 1, column <= 16_384 else { return nil }
        self.row = row
        self.column = column
    }

    public var a1: String { Self.columnName(column) + String(row) }

    public static func columnName(_ column: Int) -> String {
        var n = column
        var name = ""
        while n > 0 {
            let remainder = (n - 1) % 26
            name = String(UnicodeScalar(UInt8(65 + remainder))) + name
            n = (n - 1) / 26
        }
        return name
    }

    public static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.row != rhs.row ? lhs.row < rhs.row : lhs.column < rhs.column
    }
}

/// A stored cell's literal value.
public enum SemanticScalar: Equatable, Sendable {
    case text(String)
    case number(Double)
    case bool(Bool)
}

public struct SemanticCell: Equatable, Sendable {
    /// The literal, or for an imported opaque formula its cached value. A
    /// computed formula carries none: the engine works it out.
    public var value: SemanticScalar?
    /// The formula without its leading `=`.
    public var formula: String?
    public var isDate: Bool
    /// The resolved Excel number format code.
    public var format: String?
    public var bold: Bool
    /// An imported formula the web's engine cannot compute; `value` is the
    /// file's cached result.
    public var opaque: Bool

    public init(
        value: SemanticScalar? = nil, formula: String? = nil, isDate: Bool = false,
        format: String? = nil, bold: Bool = false, opaque: Bool = false
    ) {
        self.value = value
        self.formula = formula
        self.isDate = isDate
        self.format = format
        self.bold = bold
        self.opaque = opaque
    }
}

public struct SemanticSheet: Equatable, Sendable {
    public let name: String
    public let cells: [SemanticCellAddress: SemanticCell]
    public let frozenRows: Int
    public let frozenColumns: Int
    /// Column widths in characters, keyed by column number.
    public let columnWidths: [Int: Double]
    public let chartCount: Int
    public let tableCount: Int

    /// The used extent: highest row and column holding anything.
    public var rowCount: Int { cells.keys.map(\.row).max() ?? 0 }
    public var columnCount: Int { cells.keys.map(\.column).max() ?? 0 }
}

public struct SemanticWorkbook: Equatable, Sendable {
    public let title: String
    public let sheets: [SemanticSheet]
    /// Defined names → a qualified range (`Assumptions!$B$3`).
    public let names: [String: String]

    init(json: [String: Any]) throws {
        let sheetObjects = json.objects("sheets")
        guard !sheetObjects.isEmpty else { throw SemanticArtifact.ParseError.wrongShape("a workbook needs a sheet") }
        title = json.string("title")?.trimmingCharacters(in: .whitespaces).nonEmpty ?? "Untitled workbook"
        var names: [String: String] = [:]
        for (key, value) in (json["names"] as? [String: Any]) ?? [:] {
            if let range = value as? String { names[key.uppercased()] = range }
        }
        self.names = names
        sheets = sheetObjects.enumerated().map { index, sheet in
            var cells: [SemanticCellAddress: SemanticCell] = [:]
            if let rows = sheet["rows"] as? [Any] {
                for (r, row) in rows.enumerated() {
                    guard let row = row as? [Any] else { continue }
                    for (c, raw) in row.enumerated() {
                        if let cell = Self.cell(raw) {
                            cells[SemanticCellAddress(row: r + 1, column: c + 1)] = cell
                        }
                    }
                }
            }
            for (key, raw) in (sheet["cells"] as? [String: Any]) ?? [:] {
                guard let address = SemanticCellAddress(key), let cell = Self.cell(raw) else { continue }
                cells[address] = cell
            }
            var widths: [Int: Double] = [:]
            for (key, raw) in (sheet["columns"] as? [String: Any]) ?? [:] {
                guard let column = SemanticCellAddress("\(key)1")?.column,
                    let width = ((raw as? [String: Any])?["width"] as? NSNumber)?.doubleValue
                else { continue }
                widths[column] = width
            }
            let freeze = sheet["freeze"] as? [String: Any] ?? [:]
            return SemanticSheet(
                name: (sheet["name"] as? String)?.nonEmpty ?? "Sheet\(index + 1)",
                cells: cells,
                frozenRows: freeze.int("rows") ?? 0,
                frozenColumns: freeze.int("cols") ?? 0,
                columnWidths: widths,
                chartCount: sheet.objects("charts").count,
                tableCount: sheet.objects("tables").count
            )
        }
    }

    /// A cell from its stored or authoring form; nil for an empty one.
    static func cell(_ raw: Any) -> SemanticCell? {
        if raw is NSNull { return nil }
        if let text = raw as? String { return SemanticCell(value: .text(text)) }
        if let number = raw as? NSNumber {
            return SemanticCell(value: isBoolean(number) ? .bool(number.boolValue) : .number(number.doubleValue))
        }
        guard let object = raw as? [String: Any] else { return nil }
        var cell = SemanticCell()
        if let text = object["v"] as? String { cell.value = .text(text) }
        else if let number = object["v"] as? NSNumber {
            cell.value = isBoolean(number) ? .bool(number.boolValue) : .number(number.doubleValue)
        }
        if var formula = object.string("f")?.trimmingCharacters(in: .whitespaces), !formula.isEmpty {
            if formula.hasPrefix("=") { formula.removeFirst() }
            cell.formula = formula
        }
        if let date = object.string("date"), let serial = SemanticNumberFormat.serial(fromISODate: date) {
            cell.value = .number(serial)
            cell.isDate = true
        }
        if object.string("t") == "date" { cell.isDate = true }
        if let format = object.string("fmt") { cell.format = SemanticNumberFormat.resolve(format) }
        if cell.isDate, cell.format == nil { cell.format = "yyyy-mm-dd" }
        cell.bold = object.bool("bold") ?? false
        cell.opaque = object.bool("opaque") ?? false
        if cell.value == nil, cell.formula == nil, !cell.bold { return nil }
        return cell
    }

    public func sheet(named name: String) -> SemanticSheet? {
        let key = name.trimmingCharacters(in: .whitespaces).lowercased()
        return sheets.first { $0.name.lowercased() == key }
    }
}

// MARK: - Number formats (`workbook/format.ts`, ported)

public enum SemanticNumberFormat {
    static let aliases: [String: String] = [
        "general": "General", "text": "@", "number": "#,##0.00", "integer": "#,##0",
        "currency": "\"$\"#,##0.00", "usd": "\"$\"#,##0.00", "eur": "\"€\"#,##0.00",
        "gbp": "\"£\"#,##0.00", "percent": "0.0%", "date": "yyyy-mm-dd", "month": "mmm yyyy",
    ]

    public static func resolve(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespaces)
        if let alias = aliases[trimmed.lowercased()] { return alias }
        return trimmed.isEmpty ? nil : trimmed
    }

    static func isDateFormat(_ code: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "ymd-/ .,")
        return !code.isEmpty && code.unicodeScalars.allSatisfy { allowed.contains($0) }
            && code.contains(where: { "dmy".contains($0) })
    }

    /// An ISO date → an Excel serial (1900 system).
    static func serial(fromISODate text: String) -> Double? {
        let parts = text.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])),
            let epoch = calendar.date(from: DateComponents(year: 1899, month: 12, day: 30))
        else { return nil }
        return (date.timeIntervalSince(epoch) / 86_400).rounded()
    }

    private static let months = [
        "January", "February", "March", "April", "May", "June", "July", "August",
        "September", "October", "November", "December",
    ]

    /// `formatGeneral`: integers bare, otherwise 15 significant digits.
    public static func general(_ value: Double) -> String {
        if value.isNaN || value.isInfinite { return "#NUM!" }
        if value == value.rounded(), abs(value) < 1e15 { return String(Int64(value)) }
        let text = String(format: "%.15g", value)
        return text
    }

    /// The text a cell shows for `value` in `code`.
    public static func format(_ value: Double, code: String?) -> String {
        guard let code, code != "General", code != "@" else { return general(value) }
        if isDateFormat(code) { return date(value, code: code) }
        return number(value, code: code)
    }

    static func date(_ serial: Double, code: String) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let epoch = calendar.date(from: DateComponents(year: 1899, month: 12, day: 30)) else { return general(serial) }
        let date = epoch.addingTimeInterval((serial * 86_400).rounded())
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let y = parts.year ?? 1900
        let m = (parts.month ?? 1) - 1
        let d = parts.day ?? 1
        var out = ""
        var rest = Substring(code)
        let tokens = ["yyyy", "yy", "mmmm", "mmm", "mm", "m", "dd", "d"]
        while !rest.isEmpty {
            if let token = tokens.first(where: { rest.hasPrefix($0) }) {
                switch token {
                case "yyyy": out += String(y)
                case "yy": out += String(String(y).suffix(2))
                case "mmmm": out += months[m]
                case "mmm": out += String(months[m].prefix(3))
                case "mm": out += String(format: "%02d", m + 1)
                case "m": out += String(m + 1)
                case "dd": out += String(format: "%02d", d)
                default: out += String(d)
                }
                rest = rest.dropFirst(token.count)
            } else {
                out.append(rest.removeFirst())
            }
        }
        return out
    }

    static func number(_ value: Double, code: String) -> String {
        var rest = Substring(code)
        var prefix = ""
        if rest.hasPrefix("\""), let end = rest.dropFirst().firstIndex(of: "\"") {
            prefix = String(rest[rest.index(after: rest.startIndex)..<end])
            rest = rest[rest.index(after: end)...]
        } else if let first = rest.first, "$€£¥".contains(first) {
            prefix = String(first)
            rest = rest.dropFirst()
        }
        var suffix = ""
        if rest.hasSuffix("\""), let start = rest.dropLast().lastIndex(of: "\"") {
            suffix = String(rest[rest.index(after: start)..<rest.index(before: rest.endIndex)])
            rest = rest[..<start]
        }
        let percent = rest.hasSuffix("%")
        if percent { rest = rest.dropLast() }
        let decimals = rest.split(separator: ".", omittingEmptySubsequences: false).dropFirst().first?.count ?? 0
        let grouped = rest.contains(",")
        let scaled = percent ? value * 100 : value
        let fixed = String(format: "%.\(decimals)f", abs(scaled))
        let pieces = fixed.split(separator: ".", omittingEmptySubsequences: false)
        var whole = String(pieces.first ?? "0")
        if grouped {
            var groupedText = ""
            for (index, character) in whole.reversed().enumerated() {
                if index > 0, index % 3 == 0 { groupedText.append(",") }
                groupedText.append(character)
            }
            whole = String(groupedText.reversed())
        }
        let fraction = pieces.count > 1 ? "." + pieces[1] : ""
        let negative = scaled < 0 && (Double(fixed) ?? 0) != 0
        return "\(negative ? "-" : "")\(prefix)\(whole)\(fraction)\(percent ? "%" : "")\(suffix)"
    }
}

// MARK: - Document

public struct SemanticDocument: Equatable, Sendable {
    public struct ListItem: Equatable, Sendable {
        public let text: String
        public let level: Int
    }

    public enum BlockKind: Equatable, Sendable {
        case heading(level: Int, text: String)
        case paragraph(text: String, style: String?)
        case list(ordered: Bool, items: [ListItem])
        case table(header: [String], rows: [[String]], caption: String?)
        case callout(tone: String, title: String?, text: String)
        case figure(alt: String, caption: String?)
        case pageBreak
    }

    public struct Block: Identifiable, Equatable, Sendable {
        public let id: String
        public let kind: BlockKind
    }

    public struct Comment: Identifiable, Equatable, Sendable {
        public let id: String
        public let blockID: String
        public let author: String
        public let text: String
        public let resolved: Bool
    }

    public struct Revision: Identifiable, Equatable, Sendable {
        public let id: String
        public let blockID: String
        public let kind: String
        public let text: String
        public let author: String
        public let status: String
    }

    public struct Source: Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let url: String?
        public let publisher: String?
    }

    public let title: String
    public let blocks: [Block]
    public let comments: [Comment]
    public let revisions: [Revision]
    public let sources: [Source]

    init(json: [String: Any]) throws {
        title = json.string("title")?.trimmingCharacters(in: .whitespaces).nonEmpty ?? "Untitled document"
        guard json["blocks"] is [Any] else { throw SemanticArtifact.ParseError.wrongShape("a document needs blocks") }
        blocks = json.objects("blocks").enumerated().compactMap { index, block in
            let id = block.string("id") ?? "b\(index + 1)"
            let text = block.string("text") ?? ""
            let kind: BlockKind
            switch block.string("type") {
            case "heading":
                kind = .heading(level: min(4, max(1, block.int("level") ?? 1)), text: text)
            case "paragraph":
                kind = .paragraph(text: text, style: block.string("style"))
            case "list":
                let items = ((block["items"] as? [Any]) ?? []).compactMap { raw -> ListItem? in
                    if let text = raw as? String { return ListItem(text: text, level: 0) }
                    guard let object = raw as? [String: Any], let text = object.string("text") else { return nil }
                    return ListItem(text: text, level: min(2, max(0, object.int("level") ?? 0)))
                }
                kind = .list(ordered: block.bool("ordered") ?? false, items: items)
            case "table":
                let header = (block["header"] as? [Any])?.map { "\($0)" } ?? []
                let rows = ((block["rows"] as? [Any]) ?? []).map { ($0 as? [Any])?.map { "\($0)" } ?? [] }
                kind = .table(header: header, rows: rows, caption: block.string("caption"))
            case "callout":
                kind = .callout(tone: block.string("tone") ?? "note", title: block.string("title"), text: text)
            case "figure":
                kind = .figure(alt: block.string("alt") ?? "Figure", caption: block.string("caption"))
            case "pageBreak":
                kind = .pageBreak
            default:
                return nil
            }
            return Block(id: id, kind: kind)
        }
        comments = json.objects("comments").enumerated().map { index, comment in
            Comment(
                id: comment.string("id") ?? "c\(index + 1)",
                blockID: comment.string("blockId") ?? "",
                author: comment.string("author") ?? "Alevr",
                text: comment.string("text") ?? "",
                resolved: comment.bool("resolved") ?? false
            )
        }
        revisions = json.objects("revisions").enumerated().map { index, revision in
            Revision(
                id: revision.string("id") ?? "r\(index + 1)",
                blockID: revision.string("blockId") ?? "",
                kind: revision.string("kind") ?? "replace",
                text: revision.string("text") ?? "",
                author: revision.string("author") ?? "Alevr",
                status: revision.string("status") ?? "pending"
            )
        }
        sources = json.objects("sources").enumerated().map { index, source in
            Source(
                id: source.string("id") ?? "src\(index + 1)",
                title: source.string("title") ?? "Source",
                url: source.string("url"),
                publisher: source.string("publisher")
            )
        }
    }

    /// Open comments on one block.
    public func openComments(on blockID: String) -> [Comment] {
        comments.filter { $0.blockID == blockID && !$0.resolved }
    }

    /// Pending suggestions on one block.
    public func pendingRevisions(on blockID: String) -> [Revision] {
        revisions.filter { $0.blockID == blockID && $0.status == "pending" }
    }

    /// The text with `[@source]` citations as bracketed numbers, ready for the
    /// inline Markdown reader (`**bold**`, `*italic*`, `` `code` ``, links).
    public func inlineMarkdown(_ text: String) -> String {
        guard text.contains("[@") else { return text }
        var numbers: [String: Int] = [:]
        for (index, source) in sources.enumerated() { numbers[source.id] = index + 1 }
        var out = ""
        var rest = Substring(text)
        while let start = rest.range(of: "[@") {
            out += rest[..<start.lowerBound]
            guard let end = rest[start.upperBound...].firstIndex(of: "]") else {
                out += rest[start.lowerBound...]
                return out
            }
            let id = String(rest[start.upperBound..<end])
            while out.hasSuffix(" ") { out.removeLast() }
            out += "[\(numbers[id].map(String.init) ?? "?")]"
            rest = rest[rest.index(after: end)...]
        }
        out += rest
        return out
    }
}

// MARK: - Deck

public struct SemanticDeck: Equatable, Sendable {
    public struct Paragraph: Equatable, Sendable {
        public let text: String
        public let level: Int
        public let bullet: Bool
        public let bold: Bool
    }

    public struct ChartSeries: Equatable, Sendable {
        public let name: String
        public let values: [Double]
    }

    public enum Element: Equatable, Sendable {
        case text(region: String?, paragraphs: [Paragraph])
        case image(alt: String)
        case shape(text: String?)
        case chart(type: String, title: String?, categories: [String], series: [ChartSeries])
        case table(header: [String], rows: [[String]])
    }

    public struct Slide: Identifiable, Equatable, Sendable {
        public let id: String
        public let layout: String
        public let title: String?
        public let subtitle: String?
        public let elements: [Element]
        public let notes: String?
    }

    public let title: String
    public let slides: [Slide]
    /// The theme's accent (`#rrggbb`), used for one rule on a title slide.
    public let accentHex: String?

    init(json: [String: Any]) throws {
        title = json.string("title")?.trimmingCharacters(in: .whitespaces).nonEmpty ?? "Untitled deck"
        let slideObjects = json.objects("slides")
        guard !slideObjects.isEmpty else { throw SemanticArtifact.ParseError.wrongShape("a deck needs a slide") }
        accentHex = (json["theme"] as? [String: Any])?["accent"] as? String
        slides = slideObjects.enumerated().map { index, slide in
            let elements: [Element] = slide.objects("elements").compactMap { element in
                switch element.string("type") {
                case "text":
                    let paragraphs = element.objects("paragraphs").map { paragraph in
                        Paragraph(
                            text: paragraph.string("text") ?? "",
                            level: min(2, max(0, paragraph.int("level") ?? 0)),
                            bullet: paragraph.bool("bullet") ?? false,
                            bold: paragraph.bool("bold") ?? false
                        )
                    }
                    return .text(region: element.string("region"), paragraphs: paragraphs)
                case "image":
                    return .image(alt: element.string("alt") ?? "Image")
                case "shape":
                    return .shape(text: element.string("text"))
                case "chart":
                    let series = element.objects("series").map { series in
                        ChartSeries(
                            name: series.string("name") ?? "Series",
                            values: ((series["values"] as? [Any]) ?? []).compactMap { ($0 as? NSNumber)?.doubleValue }
                        )
                    }
                    return .chart(
                        type: element.string("chartType") ?? "column",
                        title: element.string("title"),
                        categories: (element["categories"] as? [Any])?.map { "\($0)" } ?? [],
                        series: series
                    )
                case "table":
                    return .table(
                        header: (element["header"] as? [Any])?.map { "\($0)" } ?? [],
                        rows: ((element["rows"] as? [Any]) ?? []).map { ($0 as? [Any])?.map { "\($0)" } ?? [] }
                    )
                default:
                    return nil
                }
            }
            return Slide(
                id: slide.string("id") ?? "s\(index + 1)",
                layout: slide.string("layout") ?? "content",
                title: slide.string("title")?.nonEmpty,
                subtitle: slide.string("subtitle")?.nonEmpty,
                elements: elements,
                notes: slide.string("notes")?.nonEmpty
            )
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
