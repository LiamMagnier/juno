import Foundation

/// A unified diff, parsed into files, hunks and gutter-numbered lines.
///
/// The phone renders a change as a real diff view — a `+`/`−` gutter, old and
/// new line numbers, per-file navigation — and that needs structure the raw
/// text does not carry. The parser is deliberately lenient: hosts send a
/// `diff --git` header when they have one, a bare `---`/`+++` pair when they
/// do not, and occasionally a single hunk with no header at all. All three
/// parse, and anything unrecognised is kept as a context line rather than
/// dropped, so the reader always sees at least what the host sent.
public struct UnifiedDiff: Equatable, Sendable {
    public struct Line: Equatable, Sendable, Identifiable {
        public enum Kind: Equatable, Sendable {
            case context
            case addition
            case deletion
            /// `\ No newline at end of file` — kept so a diff round-trips.
            case marker
        }

        public let kind: Kind
        public let text: String
        public let oldNumber: Int?
        public let newNumber: Int?
        /// Stable within one file: the hunk index and the line's position.
        public let id: String

        public init(kind: Kind, text: String, oldNumber: Int?, newNumber: Int?, id: String) {
            self.kind = kind
            self.text = text
            self.oldNumber = oldNumber
            self.newNumber = newNumber
            self.id = id
        }
    }

    public struct Hunk: Equatable, Sendable, Identifiable {
        public let header: String
        public let oldStart: Int
        public let oldCount: Int
        public let newStart: Int
        public let newCount: Int
        public var lines: [Line]
        public let id: String

        public init(
            header: String, oldStart: Int, oldCount: Int, newStart: Int, newCount: Int,
            lines: [Line], id: String
        ) {
            self.header = header
            self.oldStart = oldStart
            self.oldCount = oldCount
            self.newStart = newStart
            self.newCount = newCount
            self.lines = lines
            self.id = id
        }

        public var additions: Int { lines.filter { $0.kind == .addition }.count }
        public var deletions: Int { lines.filter { $0.kind == .deletion }.count }
    }

    public struct File: Equatable, Sendable, Identifiable {
        public enum Status: Equatable, Sendable {
            case modified
            case added
            case deleted
            case renamed
            case binary
        }

        public let oldPath: String?
        public let newPath: String?
        public var status: Status
        public var hunks: [Hunk]

        public init(oldPath: String?, newPath: String?, status: Status, hunks: [Hunk]) {
            self.oldPath = oldPath
            self.newPath = newPath
            self.status = status
            self.hunks = hunks
        }

        /// What to call the file: the new name, then the old one, then nothing.
        public var path: String { newPath ?? oldPath ?? "" }
        public var id: String { "\(oldPath ?? "-")→\(newPath ?? "-")" }
        public var additions: Int { hunks.reduce(0) { $0 + $1.additions } }
        public var deletions: Int { hunks.reduce(0) { $0 + $1.deletions } }
    }

    public var files: [File]

    public init(files: [File]) {
        self.files = files
    }

    public var additions: Int { files.reduce(0) { $0 + $1.additions } }
    public var deletions: Int { files.reduce(0) { $0 + $1.deletions } }
    public var isEmpty: Bool { files.allSatisfy { $0.hunks.isEmpty && $0.status != .binary } }

    /// Parses `text`. Never throws: an unparseable input becomes one file with
    /// one hunk of context lines, so the reader still sees the host's words.
    public static func parse(_ text: String) -> UnifiedDiff {
        var parser = Parser()
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            parser.consume(String(rawLine))
        }
        return UnifiedDiff(files: parser.finish())
    }

    // MARK: - Parser

    private struct Parser {
        private var files: [File] = []
        private var currentFile: File?
        private var currentHunk: Hunk?
        private var oldLine = 0
        private var newLine = 0
        private var lineIndex = 0
        private var pendingOldPath: String?
        /// `--- a/x` seen and waiting for its `+++ b/x`.
        private var sawOldHeader = false

        mutating func consume(_ line: String) {
            if line.hasPrefix("diff --git ") {
                closeFile()
                let paths = Self.gitPaths(line)
                currentFile = File(
                    oldPath: paths.old, newPath: paths.new, status: .modified, hunks: []
                )
                return
            }
            if line.hasPrefix("Binary files ") {
                if currentFile == nil {
                    currentFile = File(oldPath: nil, newPath: nil, status: .binary, hunks: [])
                }
                currentFile?.status = .binary
                return
            }
            if line.hasPrefix("--- ") {
                closeHunk()
                let path = Self.headerPath(String(line.dropFirst(4)))
                if let open = currentFile, !open.hunks.isEmpty {
                    // A second `---` in a headerless diff starts the next file.
                    closeFile()
                }
                if let open = currentFile {
                    currentFile = File(
                        oldPath: open.oldPath ?? path, newPath: open.newPath,
                        status: open.status, hunks: open.hunks
                    )
                } else {
                    currentFile = File(oldPath: path, newPath: nil, status: .modified, hunks: [])
                }
                if path == nil { currentFile?.status = .added }
                sawOldHeader = true
                return
            }
            if line.hasPrefix("+++ "), sawOldHeader {
                let path = Self.headerPath(String(line.dropFirst(4)))
                let existing = currentFile ?? File(oldPath: nil, newPath: nil, status: .modified, hunks: [])
                var status = existing.status
                if path == nil { status = .deleted }
                if let old = existing.oldPath, let new = path, old != new, status == .modified {
                    status = .renamed
                }
                currentFile = File(
                    oldPath: existing.oldPath, newPath: path, status: status, hunks: existing.hunks
                )
                sawOldHeader = false
                return
            }
            if line.hasPrefix("@@") {
                closeHunk()
                let header = Self.parseHunkHeader(line)
                if currentFile == nil {
                    currentFile = File(oldPath: nil, newPath: nil, status: .modified, hunks: [])
                }
                let hunkIndex = currentFile?.hunks.count ?? 0
                currentHunk = Hunk(
                    header: line,
                    oldStart: header.oldStart, oldCount: header.oldCount,
                    newStart: header.newStart, newCount: header.newCount,
                    lines: [], id: "h\(hunkIndex)"
                )
                oldLine = header.oldStart
                newLine = header.newStart
                lineIndex = 0
                return
            }
            if line.hasPrefix("rename from ") {
                currentFile?.status = .renamed
                return
            }
            if line.hasPrefix("new file mode") {
                currentFile?.status = .added
                return
            }
            if line.hasPrefix("deleted file mode") {
                currentFile?.status = .deleted
                return
            }
            if line.hasPrefix("index ") || line.hasPrefix("similarity index")
                || line.hasPrefix("rename to ") || line.hasPrefix("old mode")
                || line.hasPrefix("new mode")
            {
                return
            }

            // A body line. Without a hunk, a `+`/`-`/` ` line still counts —
            // some hosts send the hunk body alone.
            if currentHunk == nil {
                guard !line.isEmpty || currentFile != nil else { return }
                if line.isEmpty { return }
                if currentFile == nil {
                    currentFile = File(oldPath: nil, newPath: nil, status: .modified, hunks: [])
                }
                currentHunk = Hunk(
                    header: "", oldStart: 1, oldCount: 0, newStart: 1, newCount: 0,
                    lines: [], id: "h\(currentFile?.hunks.count ?? 0)"
                )
                oldLine = 1
                newLine = 1
                lineIndex = 0
            }
            appendBodyLine(line)
        }

        private mutating func appendBodyLine(_ line: String) {
            let id = "\(currentHunk?.id ?? "h0")-\(lineIndex)"
            lineIndex += 1
            if line.hasPrefix("\\") {
                currentHunk?.lines.append(
                    Line(kind: .marker, text: String(line.dropFirst(2)), oldNumber: nil, newNumber: nil, id: id)
                )
                return
            }
            let first = line.first
            let body = line.isEmpty ? "" : String(line.dropFirst())
            switch first {
            case "+":
                currentHunk?.lines.append(
                    Line(kind: .addition, text: body, oldNumber: nil, newNumber: newLine, id: id)
                )
                newLine += 1
            case "-":
                currentHunk?.lines.append(
                    Line(kind: .deletion, text: body, oldNumber: oldLine, newNumber: nil, id: id)
                )
                oldLine += 1
            default:
                // A context line begins with a space; a line that begins with
                // anything else is treated as context too, so nothing is lost.
                let text = first == " " ? body : line
                currentHunk?.lines.append(
                    Line(kind: .context, text: text, oldNumber: oldLine, newNumber: newLine, id: id)
                )
                oldLine += 1
                newLine += 1
            }
        }

        private mutating func closeHunk() {
            guard let hunk = currentHunk else { return }
            currentHunk = nil
            guard !hunk.lines.isEmpty else { return }
            currentFile?.hunks.append(hunk)
        }

        private mutating func closeFile() {
            closeHunk()
            guard let file = currentFile else { return }
            currentFile = nil
            sawOldHeader = false
            // A file with no body is still worth a row when it is binary or
            // named — an empty file added, say. An anonymous, empty one is
            // parser residue and is dropped.
            guard !file.hunks.isEmpty || file.status == .binary || !file.path.isEmpty else {
                return
            }
            files.append(file)
        }

        mutating func finish() -> [File] {
            closeFile()
            return files
        }

        private static func gitPaths(_ line: String) -> (old: String?, new: String?) {
            // `diff --git a/path b/path`
            let rest = line.dropFirst("diff --git ".count)
            let parts = rest.split(separator: " ", maxSplits: 1)
            guard parts.count == 2 else { return (nil, nil) }
            return (stripPrefix(String(parts[0])), stripPrefix(String(parts[1])))
        }

        private static func headerPath(_ raw: String) -> String? {
            var value = raw
            if let tab = value.firstIndex(of: "\t") { value = String(value[..<tab]) }
            value = value.trimmingCharacters(in: .whitespaces)
            if value == "/dev/null" || value.isEmpty { return nil }
            return stripPrefix(value)
        }

        private static func stripPrefix(_ path: String) -> String {
            if path.hasPrefix("a/") || path.hasPrefix("b/") { return String(path.dropFirst(2)) }
            return path
        }

        private static func parseHunkHeader(_ line: String)
            -> (oldStart: Int, oldCount: Int, newStart: Int, newCount: Int)
        {
            // `@@ -12,7 +12,9 @@ optional context`
            let scanner = Scanner(string: line)
            scanner.charactersToBeSkipped = nil
            _ = scanner.scanString("@@")
            _ = scanner.scanCharacters(from: .whitespaces)
            var oldStart = 1, oldCount = 1, newStart = 1, newCount = 1
            if scanner.scanString("-") != nil {
                oldStart = scanner.scanInt() ?? 1
                if scanner.scanString(",") != nil { oldCount = scanner.scanInt() ?? 1 }
            }
            _ = scanner.scanCharacters(from: .whitespaces)
            if scanner.scanString("+") != nil {
                newStart = scanner.scanInt() ?? 1
                if scanner.scanString(",") != nil { newCount = scanner.scanInt() ?? 1 }
            }
            return (oldStart, oldCount, newStart, newCount)
        }
    }
}
