import Foundation

/// The forgiving YAML subset a learning block's body is written in — the Swift
/// counterpart of `parseYamlSubset` and the `clean*` helpers in
/// `src/lib/step-lab.ts`.
///
/// It is **not** a YAML parser and must not become one. The model writes this by
/// hand, mid-sentence, into a streaming reply; a strict parser would reject a
/// block over a stray tab and the reader would lose the lesson. So: two-space
/// indentation, `key: value`, `- ` sequences, `[a, b]` flow lists, `#` comments,
/// and nothing else. Anything it cannot read becomes an empty mapping, which the
/// per-kind validators then reject with a sentence a person can act on.
///
/// Ported line for line rather than reimplemented, because the two clients
/// disagreeing about what a block body *means* is a silent bug: the website
/// would draw a five-step timeline and the phone a four-step one, and neither
/// would say anything was wrong.
public enum JunoYAML {
    public typealias Map = [String: Value]

    /// The value shapes the subset produces. `null` is a real case rather than a
    /// Swift `nil` because JavaScript's `??` treats an explicit `null` and an
    /// absent key identically, and the per-kind parsers lean on that.
    public enum Value: Equatable, Sendable {
        case string(String)
        case number(Double)
        case bool(Bool)
        case null
        case array([Value])
        case mapping(Map)
    }

    // MARK: - Coercion

    /// `cleanString` — a single-line label. Collapses every whitespace run to one
    /// space, so a value wrapped across two source lines still reads as a title.
    public static func cleanString(_ value: Value?, fallback: String = "") -> String {
        guard let raw = scalar(value) else { return fallback }
        let collapsed = collapsingWhitespace(raw)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let clipped = String(collapsed.prefix(maxStringLength))
        return clipped.isEmpty ? fallback : clipped
    }

    /// `cleanText` — prose. Keeps paragraph breaks (a deep dive and a card body
    /// are written in paragraphs) while still normalising runs of spaces and
    /// tabs, and caps blank runs at one so a lazily-indented block does not open
    /// a hole in the transcript.
    public static func cleanText(_ value: Value?, max: Int = 4_000, fallback: String = "") -> String {
        guard let raw = scalar(value) else { return fallback }
        // Three passes, in the web's order, because the order is load-bearing:
        // collapsing spaces BEFORE blank lines is what turns a line of trailing
        // indentation into a single space rather than into nothing.
        var collapsed = ""
        collapsed.reserveCapacity(raw.count)
        var inSpaceRun = false
        for character in raw.replacingOccurrences(of: "\r\n", with: "\n") {
            if character == " " || character == "\t" {
                if !inSpaceRun { collapsed.append(" ") }
                inSpaceRun = true
            } else {
                inSpaceRun = false
                collapsed.append(character)
            }
        }

        var out = ""
        out.reserveCapacity(collapsed.count)
        var newlineRun = 0
        for character in collapsed {
            if character == "\n" {
                newlineRun += 1
                continue
            }
            // `\n{3,}` collapses to exactly two; one and two survive as written.
            out += String(repeating: "\n", count: newlineRun >= 3 ? 2 : newlineRun)
            newlineRun = 0
            out.append(character)
        }
        out += String(repeating: "\n", count: newlineRun >= 3 ? 2 : newlineRun)

        let clipped = String(
            out.trimmingCharacters(in: .whitespacesAndNewlines).prefix(max)
        )
        return clipped.isEmpty ? fallback : clipped
    }

    /// `Array.isArray(value) ? value : []`.
    public static func array(_ value: Value?) -> [Value] {
        if case .array(let items) = value { return items }
        return []
    }

    /// `Array.isArray(value) ? value : null` — the distinction the quiz parser
    /// needs, where "no `questions:` key" and "an empty `questions:` list" mean
    /// different things.
    public static func arrayOrNil(_ value: Value?) -> [Value]? {
        if case .array(let items) = value { return items }
        return nil
    }

    /// `arrayOfRecords` — the list's mapping entries, other shapes dropped.
    public static func recordArray(_ value: Value?) -> [Map] {
        array(value).compactMap { item in
            if case .mapping(let map) = item { return map }
            return nil
        }
    }

    /// JavaScript's `String(value)` for the three coercible types. Anything else
    /// — a list, a mapping, `null`, an absent key — has no string form, and the
    /// callers turn that into their own fallback rather than printing "[object
    /// Object]" into a lesson.
    static func scalar(_ value: Value?) -> String? {
        switch value {
        case .string(let text): text
        case .number(let number): jsNumber(number)
        case .bool(let flag): flag ? "true" : "false"
        default: nil
        }
    }

    /// `String(n)` as JavaScript prints it: an integral double has no `.0`.
    static func jsNumber(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value > 0 ? "Infinity" : "-Infinity" }
        if value == value.rounded(), abs(value) < 1e15 { return String(Int64(value)) }
        return String(value)
    }

    /// `/\s+/g → " "`. Every run, leading and trailing included — the caller
    /// trims immediately after, so the edges cost nothing.
    private static func collapsingWhitespace(_ raw: String) -> String {
        var out = ""
        out.reserveCapacity(raw.count)
        var inRun = false
        for character in raw {
            if character.isWhitespace {
                if !inRun { out.append(" ") }
                inRun = true
            } else {
                inRun = false
                out.append(character)
            }
        }
        return out
    }

    /// The web slices on UTF-16 units; this slices on grapheme clusters. They
    /// differ only for a value long enough to be truncated *and* carrying an
    /// astral character at the cut — where slicing by unit would hand the reader
    /// half a surrogate pair. Being one character shy of the web is the better
    /// of the two failures.
    private static let maxStringLength = 1_200
}

public extension Dictionary where Key == String, Value == JunoYAML.Value {
    /// JavaScript's `a ?? b ?? c`: the first of these keys that is present and
    /// is not an explicit `null`.
    ///
    /// Named `pick` rather than `first` so it cannot be mistaken for — or shadow
    /// — `Dictionary.first`, whose answer is an arbitrary entry.
    func pick(_ keys: String...) -> JunoYAML.Value? {
        for key in keys {
            if let value = self[key], value != .null { return value }
        }
        return nil
    }
}

// MARK: - The parser

public enum JunoYAMLSubset {
    /// Parses a block body. Never throws — an unreadable body yields an empty
    /// mapping and the caller reports it as a malformed block.
    public static func parse(_ source: String) -> JunoYAML.Value {
        parseNode(preprocess(source), 0, 0).value
    }

    private struct Line {
        let indent: Int
        let text: String
    }

    /// Tabs become two spaces (indentation is counted in spaces, and a tab would
    /// otherwise read as zero), trailing whitespace goes, and blank and `#`
    /// comment lines are dropped before any structure is inferred.
    private static func preprocess(_ source: String) -> [Line] {
        source
            .components(separatedBy: "\n")
            .map { line -> String in
                var expanded = line.replacingOccurrences(of: "\t", with: "  ")
                while let last = expanded.last, last.isWhitespace { expanded.removeLast() }
                return expanded
            }
            .compactMap { line in
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { return nil }
                return Line(indent: line.prefix(while: { $0 == " " }).count, text: trimmed)
            }
    }

    private static func parseNode(
        _ lines: [Line], _ index: Int, _ indent: Int
    ) -> (value: JunoYAML.Value, next: Int) {
        if index >= lines.count || lines[index].indent < indent { return (.mapping([:]), index) }
        if lines[index].text.hasPrefix("- ") { return parseSequence(lines, index, indent) }
        return parseMapping(lines, index, indent)
    }

    private static func parseSequence(
        _ lines: [Line], _ index: Int, _ indent: Int
    ) -> (value: JunoYAML.Value, next: Int) {
        var items: [JunoYAML.Value] = []
        var i = index
        while i < lines.count {
            let line = lines[i]
            guard line.indent == indent, line.text.hasPrefix("- ") else { break }
            let itemText = line.text.dropFirst(2).trimmingCharacters(in: .whitespacesAndNewlines)
            i += 1

            let item: JunoYAML.Value
            if itemText.isEmpty {
                let nested = parseNode(lines, i, indent + 2)
                item = nested.value
                i = nested.next
            } else if let inline = splitKeyValue(itemText) {
                // `- label: Tokenize` opens a record whose remaining keys are
                // indented one level under the dash.
                var object: JunoYAML.Map = [:]
                object[inline.key] = inline.value.isEmpty ? .mapping([:]) : parseScalar(inline.value)
                while i < lines.count, lines[i].indent > indent {
                    let nestedLine = lines[i]
                    guard nestedLine.indent == indent + 2,
                        let nested = splitKeyValue(nestedLine.text)
                    else { break }
                    i += 1
                    if !nested.value.isEmpty {
                        object[nested.key] = parseScalar(nested.value)
                    } else if i < lines.count,
                        lines[i].indent > nestedLine.indent || lines[i].text.hasPrefix("- ")
                    {
                        let childIndent = lines[i].indent > nestedLine.indent
                            ? nestedLine.indent + 2
                            : lines[i].indent
                        let child = parseNode(lines, i, childIndent)
                        object[nested.key] = child.value
                        i = child.next
                    } else {
                        object[nested.key] = .mapping([:])
                    }
                }
                item = .mapping(object)
            } else {
                item = parseScalar(itemText)
            }
            items.append(item)
        }
        return (.array(items), i)
    }

    private static func parseMapping(
        _ lines: [Line], _ index: Int, _ indent: Int
    ) -> (value: JunoYAML.Value, next: Int) {
        var object: JunoYAML.Map = [:]
        var i = index
        while i < lines.count {
            let line = lines[i]
            guard line.indent == indent, !line.text.hasPrefix("- ") else { break }
            guard let kv = splitKeyValue(line.text) else {
                // Not a key line at all — a stray sentence the model dropped in.
                // Skipped rather than aborting, so one bad line costs one line.
                i += 1
                continue
            }
            i += 1
            if !kv.value.isEmpty {
                object[kv.key] = parseScalar(kv.value)
            } else if i < lines.count,
                lines[i].indent > line.indent || lines[i].text.hasPrefix("- ")
            {
                let childIndent = lines[i].indent > line.indent ? line.indent + 2 : lines[i].indent
                let child = parseNode(lines, i, childIndent)
                object[kv.key] = child.value
                i = child.next
            } else {
                object[kv.key] = .mapping([:])
            }
        }
        return (.mapping(object), i)
    }

    /// `key: value` where the key is an identifier. The identifier test is what
    /// stops a prose line containing a colon ("Note: this matters") from being
    /// read as data.
    private static func splitKeyValue(_ text: String) -> (key: String, value: String)? {
        guard let separator = text.firstIndex(of: ":") else { return nil }
        let key = String(text[..<separator]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = key.first, first.isASCIILetter,
            key.dropFirst().allSatisfy({ $0.isASCIIWordCharacter || $0 == "-" })
        else { return nil }
        let value = String(text[text.index(after: separator)...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (key, value)
    }

    private static func parseScalar(_ value: String) -> JunoYAML.Value {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .string("") }
        if let first = trimmed.first, let last = trimmed.last,
            (first == "\"" && last == "\"") || (first == "'" && last == "'")
        {
            return .string(String(trimmed.dropFirst().dropLast()))
        }
        if trimmed == "true" { return .bool(true) }
        if trimmed == "false" { return .bool(false) }
        if trimmed == "null" { return .null }
        if isNumeric(trimmed), let number = Double(trimmed) { return .number(number) }
        if trimmed.hasPrefix("["), trimmed.hasSuffix("]") {
            let inner = String(trimmed.dropFirst().dropLast())
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if inner.isEmpty { return .array([]) }
            return .array(
                splitFlowItems(inner)
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                    .map(parseScalar)
            )
        }
        return .string(trimmed)
    }

    /// `/^-?\d+(\.\d+)?$/` — deliberately narrow. Exponents and leading `+` stay
    /// strings, because a lesson that writes `1e3` means the characters.
    private static func isNumeric(_ text: String) -> Bool {
        var rest = Substring(text)
        if rest.first == "-" { rest = rest.dropFirst() }
        let whole = rest.prefix(while: { $0.isASCIIDigit })
        guard !whole.isEmpty else { return false }
        rest = rest.dropFirst(whole.count)
        if rest.isEmpty { return true }
        guard rest.first == "." else { return false }
        let fraction = rest.dropFirst()
        return !fraction.isEmpty && fraction.allSatisfy(\.isASCIIDigit)
    }

    /// Splits a flow sequence on TOP-LEVEL commas only. Without this,
    /// `["a, b", "c"]` splits mid-string and leaves a dangling quote on each
    /// fragment — which then survives `parseScalar` as literal `"a` on screen.
    private static func splitFlowItems(_ inner: String) -> [String] {
        var items: [String] = []
        var buffer = ""
        var quote: Character?
        for character in inner {
            if let open = quote {
                buffer.append(character)
                if character == open { quote = nil }
            } else if character == "\"" || character == "'" {
                quote = character
                buffer.append(character)
            } else if character == "," {
                items.append(buffer)
                buffer = ""
            } else {
                buffer.append(character)
            }
        }
        items.append(buffer)
        return items
    }
}

private extension Character {
    var isASCIILetter: Bool { isASCII && isLetter }
    var isASCIIDigit: Bool { isASCII && isNumber }
    /// JavaScript's `\w`: `[A-Za-z0-9_]`.
    var isASCIIWordCharacter: Bool { (isASCII && (isLetter || isNumber)) || self == "_" }
}
