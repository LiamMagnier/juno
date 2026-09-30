import Foundation

public enum PatchEnvelopeError: Error, Equatable, Sendable, CustomStringConvertible {
    case missingBegin
    case missingEnd
    case empty
    case invalidLine(number: Int, text: String, reason: String)
    case duplicatePath(String)
    case updateWithoutChanges(path: String)
    case contextNotFound(path: String, context: String)
    case hunkNotFound(path: String, hunk: Int, expected: String)
    case overlappingHunks(path: String)

    public var description: String {
        switch self {
        case .missingBegin:
            return "The patch must start with a line reading \"*** Begin Patch\"."
        case .missingEnd:
            return "The patch must end with a line reading \"*** End Patch\"."
        case .empty:
            return "The patch has no file operations."
        case let .invalidLine(number, text, reason):
            return "Patch line \(number) (\"\(text.prefix(80))\"): \(reason)"
        case let .duplicatePath(path):
            return "\(path) appears in more than one operation of the patch; combine its hunks into one \"*** Update File\" section."
        case let .updateWithoutChanges(path):
            return "\"*** Update File: \(path)\" has no hunks and no \"*** Move to\"."
        case let .contextNotFound(path, context):
            return "\(path): the @@ context line \"\(context.prefix(120))\" was not found after the previous hunk. Re-read the file and use a line that exists."
        case let .hunkNotFound(path, hunk, expected):
            return "\(path): hunk \(hunk) did not match the file. Its context and '-' lines must appear in the file exactly, in order, after the previous hunk. Expected:\n\(expected.prefix(600))"
        case let .overlappingHunks(path):
            return "\(path): two hunks change the same lines. Merge them into one hunk."
        }
    }
}

/// A multi-file patch in the `*** Begin Patch` envelope Codex models write:
///
/// ```
/// *** Begin Patch
/// *** Add File: docs/new.md
/// +first line
/// *** Update File: src/app.swift
/// *** Move to: src/main.swift
/// @@ func run() {
///      let a = 1
/// -    let b = 2
/// +    let b = 3
/// *** Delete File: old.txt
/// *** End Patch
/// ```
///
/// Parsing and applying are pure, so the whole patch can be validated against
/// every file it touches before a single byte is written — the file service
/// then commits the computed contents as one transaction.
public struct PatchEnvelope: Equatable, Sendable {
    public enum Operation: Equatable, Sendable {
        case add(path: String, content: String)
        case delete(path: String)
        case update(path: String, moveTo: String?, hunks: [Hunk])

        public var path: String {
            switch self {
            case let .add(path, _), let .delete(path), let .update(path, _, _):
                return path
            }
        }
    }

    /// One `@@` section: the lines it expects to find, and what replaces them.
    public struct Hunk: Equatable, Sendable {
        /// The text after `@@`, a line the hunk sits below. Nil for a bare `@@`.
        public var context: String?
        /// Context and removed lines, in file order.
        public var oldLines: [String]
        /// Context and added lines, in file order.
        public var newLines: [String]
        /// `*** End of File` followed the hunk: it matches the file's last lines.
        public var isEndOfFile: Bool

        public init(context: String? = nil, oldLines: [String], newLines: [String], isEndOfFile: Bool = false) {
            self.context = context
            self.oldLines = oldLines
            self.newLines = newLines
            self.isEndOfFile = isEndOfFile
        }
    }

    public let operations: [Operation]

    public init(operations: [Operation]) {
        self.operations = operations
    }

    /// Every path the patch reads or writes, move destinations included, in
    /// order of first appearance.
    public var paths: [String] {
        var seen = Set<String>()
        var result: [String] = []
        for operation in operations {
            var touched = [operation.path]
            if case let .update(_, moveTo?, _) = operation { touched.append(moveTo) }
            for path in touched where seen.insert(path).inserted {
                result.append(path)
            }
        }
        return result
    }

    // MARK: - Parsing

    public static func looksLikeEnvelope(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(beginMarker)
    }

    static let beginMarker = "*** Begin Patch"
    static let endMarker = "*** End Patch"
    private static let addPrefix = "*** Add File: "
    private static let deletePrefix = "*** Delete File: "
    private static let updatePrefix = "*** Update File: "
    private static let movePrefix = "*** Move to: "
    private static let endOfFile = "*** End of File"

    public static func parse(_ text: String) throws -> PatchEnvelope {
        var lines = text.components(separatedBy: "\n").map { line in
            line.hasSuffix("\r") ? String(line.dropLast()) : line
        }
        while let first = lines.first, first.trimmingCharacters(in: .whitespaces).isEmpty {
            lines.removeFirst()
        }
        while let last = lines.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
            lines.removeLast()
        }
        guard lines.first?.trimmingCharacters(in: .whitespaces) == beginMarker else {
            throw PatchEnvelopeError.missingBegin
        }
        guard lines.count >= 2, lines.last?.trimmingCharacters(in: .whitespaces) == endMarker else {
            throw PatchEnvelopeError.missingEnd
        }
        // Line numbers in errors count from the Begin marker as line 1.
        let body = Array(lines[1..<(lines.count - 1)])
        var operations: [Operation] = []
        var index = 0

        func lineNumber(_ bodyIndex: Int) -> Int { bodyIndex + 2 }
        func isHeader(_ line: String) -> Bool {
            line.hasPrefix(addPrefix) || line.hasPrefix(deletePrefix) || line.hasPrefix(updatePrefix)
        }
        func headerPath(after prefix: String, in line: String, at bodyIndex: Int) throws -> String {
            let value = String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
            guard !value.isEmpty else {
                throw PatchEnvelopeError.invalidLine(
                    number: lineNumber(bodyIndex), text: line, reason: "the file path is missing"
                )
            }
            return value
        }

        while index < body.count {
            let line = body[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                index += 1
                continue
            }
            if line.hasPrefix(addPrefix) {
                let path = try headerPath(after: addPrefix, in: line, at: index)
                index += 1
                var content: [String] = []
                while index < body.count, !isHeader(body[index]) {
                    let next = body[index]
                    if next.hasPrefix("+") {
                        content.append(String(next.dropFirst()))
                    } else if next.isEmpty {
                        content.append("")
                    } else {
                        throw PatchEnvelopeError.invalidLine(
                            number: lineNumber(index), text: next,
                            reason: "every line of an added file starts with '+'"
                        )
                    }
                    index += 1
                }
                // Blank separator lines before the next header are layout, not content.
                while content.last == "" { content.removeLast() }
                operations.append(.add(path: path, content: content.isEmpty ? "" : content.joined(separator: "\n") + "\n"))
            } else if line.hasPrefix(deletePrefix) {
                operations.append(.delete(path: try headerPath(after: deletePrefix, in: line, at: index)))
                index += 1
            } else if line.hasPrefix(updatePrefix) {
                let path = try headerPath(after: updatePrefix, in: line, at: index)
                index += 1
                var moveTo: String?
                if index < body.count, body[index].hasPrefix(movePrefix) {
                    moveTo = try headerPath(after: movePrefix, in: body[index], at: index)
                    index += 1
                }
                var hunks: [Hunk] = []
                var current: Hunk?
                func closeHunk() {
                    if let hunk = current, !(hunk.oldLines.isEmpty && hunk.newLines.isEmpty) {
                        hunks.append(hunk)
                    }
                    current = nil
                }
                while index < body.count, !isHeader(body[index]) {
                    let next = body[index]
                    if next.hasPrefix("@@") {
                        closeHunk()
                        current = Hunk(context: Self.contextText(next), oldLines: [], newLines: [])
                    } else if next.trimmingCharacters(in: .whitespaces) == endOfFile {
                        if current == nil {
                            throw PatchEnvelopeError.invalidLine(
                                number: lineNumber(index), text: next,
                                reason: "\"*** End of File\" must follow a hunk"
                            )
                        }
                        current?.isEndOfFile = true
                        closeHunk()
                    } else if next.hasPrefix(movePrefix) {
                        throw PatchEnvelopeError.invalidLine(
                            number: lineNumber(index), text: next,
                            reason: "\"*** Move to\" must come right after its \"*** Update File\" line"
                        )
                    } else if let marker = next.first, marker == " " || marker == "-" || marker == "+" {
                        // A first hunk may omit its `@@` line.
                        if current == nil {
                            current = Hunk(context: nil, oldLines: [], newLines: [])
                        }
                        let text = String(next.dropFirst())
                        switch marker {
                        case " ":
                            current?.oldLines.append(text)
                            current?.newLines.append(text)
                        case "-":
                            current?.oldLines.append(text)
                        default:
                            current?.newLines.append(text)
                        }
                    } else if next.isEmpty {
                        // An empty context line whose leading space was trimmed.
                        if current == nil {
                            index += 1
                            continue
                        }
                        current?.oldLines.append("")
                        current?.newLines.append("")
                    } else {
                        throw PatchEnvelopeError.invalidLine(
                            number: lineNumber(index), text: next,
                            reason: "a hunk line starts with ' ' (context), '-' (remove) or '+' (add)"
                        )
                    }
                    index += 1
                }
                closeHunk()
                // Trailing blank lines kept as context by the lenient rule
                // above are separators, not part of the hunk.
                hunks = hunks.map { hunk in
                    var trimmed = hunk
                    while trimmed.oldLines.last == "", trimmed.newLines.last == "",
                          trimmed.oldLines.count > 1 || trimmed.newLines.count > 1
                    {
                        trimmed.oldLines.removeLast()
                        trimmed.newLines.removeLast()
                    }
                    return trimmed
                }
                if hunks.isEmpty, moveTo == nil {
                    throw PatchEnvelopeError.updateWithoutChanges(path: path)
                }
                operations.append(.update(path: path, moveTo: moveTo, hunks: hunks))
            } else {
                throw PatchEnvelopeError.invalidLine(
                    number: lineNumber(index), text: line,
                    reason: "expected \"*** Add File:\", \"*** Update File:\" or \"*** Delete File:\""
                )
            }
        }
        guard !operations.isEmpty else { throw PatchEnvelopeError.empty }
        var seen = Set<String>()
        for operation in operations {
            var touched = [operation.path]
            if case let .update(_, moveTo?, _) = operation, moveTo != operation.path {
                touched.append(moveTo)
            }
            for path in touched where !seen.insert(path).inserted {
                throw PatchEnvelopeError.duplicatePath(path)
            }
        }
        return PatchEnvelope(operations: operations)
    }

    /// The `@@` line's anchor. A unified-diff range header (`@@ -3,7 +3,8 @@`)
    /// carries line numbers rather than text, and is treated as a bare `@@`.
    private static func contextText(_ line: String) -> String? {
        var text = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("-"), text.hasSuffix("@@"),
           text.range(of: #"^-\d+(,\d+)? \+\d+(,\d+)? @@$"#, options: .regularExpression) != nil
        {
            return nil
        }
        if text.hasSuffix("@@") {
            text = String(text.dropLast(2)).trimmingCharacters(in: .whitespaces)
        }
        return text.isEmpty ? nil : text
    }

    // MARK: - Applying

    /// The file's new content with `hunks` applied in order, or an error naming
    /// the first hunk that does not match. Line endings follow the file: a CRLF
    /// file stays CRLF, and a trailing newline is kept or left out as it was.
    public static func apply(_ hunks: [Hunk], to content: String, path: String) throws -> String {
        guard !hunks.isEmpty else { return content }
        let usesCRLF = content.contains("\r\n")
        var lines = content.components(separatedBy: "\n")
        // By code unit: "\r\n" is one Character, and `hasSuffix("\n")` is false for it.
        let hadTrailingNewline = content.isEmpty || content.utf8.last == UInt8(ascii: "\n")
        if lines.last == "" { lines.removeLast() }
        if usesCRLF {
            lines = lines.map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
        }

        var replacements: [(start: Int, count: Int, lines: [String])] = []
        var lineIndex = 0
        for (number, hunk) in hunks.enumerated() {
            if let context = hunk.context {
                guard let found = seek(lines, [context], from: lineIndex, endOfFile: false) else {
                    throw PatchEnvelopeError.contextNotFound(path: path, context: context)
                }
                lineIndex = found + 1
            }
            if hunk.oldLines.isEmpty {
                // Nothing to match: insert under the `@@` anchor, or append.
                let insertion = hunk.context == nil ? lines.count : lineIndex
                replacements.append((insertion, 0, hunk.newLines))
                lineIndex = insertion
                continue
            }
            var pattern = hunk.oldLines
            var replacement = hunk.newLines
            var found = seek(lines, pattern, from: lineIndex, endOfFile: hunk.isEndOfFile)
            if found == nil, pattern.last == "" {
                // A trailing empty line in the hunk is the file's final newline.
                pattern.removeLast()
                if replacement.last == "" { replacement.removeLast() }
                found = seek(lines, pattern, from: lineIndex, endOfFile: hunk.isEndOfFile)
            }
            guard let start = found else {
                throw PatchEnvelopeError.hunkNotFound(
                    path: path,
                    hunk: number + 1,
                    expected: hunk.oldLines.joined(separator: "\n")
                )
            }
            replacements.append((start, pattern.count, replacement))
            lineIndex = start + pattern.count
        }

        replacements.sort { $0.start < $1.start }
        for (previous, next) in zip(replacements, replacements.dropFirst())
        where previous.start + previous.count > next.start {
            throw PatchEnvelopeError.overlappingHunks(path: path)
        }
        for replacement in replacements.reversed() {
            lines.replaceSubrange(
                replacement.start..<(replacement.start + replacement.count),
                with: replacement.lines
            )
        }
        let separator = usesCRLF ? "\r\n" : "\n"
        guard !lines.isEmpty else { return "" }
        return lines.joined(separator: separator) + (hadTrailingNewline ? separator : "")
    }

    /// The first index at or after `start` where `pattern` matches, trying
    /// progressively looser comparisons: exact, then ignoring trailing
    /// whitespace, then ignoring surrounding whitespace, then with typographic
    /// punctuation folded to ASCII. Each pass scans the whole range before the
    /// next is tried, so an exact match always wins over a loose one.
    static func seek(_ lines: [String], _ pattern: [String], from start: Int, endOfFile: Bool) -> Int? {
        guard !pattern.isEmpty else { return start }
        guard pattern.count <= lines.count else { return nil }
        let last = lines.count - pattern.count
        let first = endOfFile ? last : start
        guard first <= last, first >= 0 else { return nil }
        let comparisons: [(String) -> String] = [
            { $0 },
            { Self.trimmingTrailingWhitespace($0) },
            { $0.trimmingCharacters(in: .whitespaces) },
            { Self.foldedPunctuation($0.trimmingCharacters(in: .whitespaces)) },
        ]
        for normalize in comparisons {
            let wanted = pattern.map(normalize)
            for index in first...last {
                var matches = true
                for offset in 0..<wanted.count where normalize(lines[index + offset]) != wanted[offset] {
                    matches = false
                    break
                }
                if matches { return index }
            }
        }
        return nil
    }

    private static func trimmingTrailingWhitespace(_ text: String) -> String {
        var scalars = text.unicodeScalars[...]
        while let last = scalars.last, CharacterSet.whitespaces.contains(last) {
            scalars = scalars.dropLast()
        }
        return String(String.UnicodeScalarView(scalars))
    }

    private static func foldedPunctuation(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212:
                out.append("-")
            case 0x2018, 0x2019, 0x201A, 0x201B:
                out.append("'")
            case 0x201C, 0x201D, 0x201E, 0x201F:
                out.append("\"")
            case 0x00A0, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x202F, 0x205F, 0x3000:
                out.append(" ")
            default:
                out.append(scalar)
            }
        }
        return String(out)
    }
}

// MARK: - Multi-edit

public enum MultiEditError: Error, Equatable, Sendable, CustomStringConvertible {
    case noEdits
    case editFailed(index: Int, underlying: TextPatchError)

    public var description: String {
        switch self {
        case .noEdits:
            return "multi_edit needs at least one edit."
        case let .editFailed(index, underlying):
            let reason: String
            switch underlying {
            case .targetNotFound:
                reason = "old_string was not found (edits apply in order, so it must exist after the earlier edits)"
            case let .ambiguousTarget(occurrences):
                reason = "old_string occurs \(occurrences) times; add surrounding lines to make it unique, or set replace_all"
            case .emptyTarget:
                reason = "old_string is empty"
            case .noChange:
                reason = "old_string and new_string are identical"
            }
            return "Edit \(index + 1): \(reason). No edit was applied."
        }
    }
}

public enum MultiEdit {
    /// Applies every edit in order, each to the result of the one before, or
    /// throws naming the first that fails — in which case nothing is applied.
    public static func apply(_ edits: [TextPatch], to content: String) throws -> String {
        guard !edits.isEmpty else { throw MultiEditError.noEdits }
        var result = content
        for (index, edit) in edits.enumerated() {
            do {
                result = try edit.apply(to: result)
            } catch let error as TextPatchError {
                throw MultiEditError.editFailed(index: index, underlying: error)
            }
        }
        return result
    }
}
