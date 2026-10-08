import Foundation

/// A git-style unified diff, parsed into files and hunks (DESIGN §5.16
/// Changes; SPEC §3.8 checkpoint diffs).
///
/// The env server's `checkpoint.diff` and every `file_change` item carry their
/// change as unified-diff text. The dock renders hunks with Accept / Reject;
/// Reject reverts one hunk in the working file through
/// ``DiffHunkReverter``, so a parsed hunk is the existing ``DiffHunk``.
public struct CodeV2DiffFile: Identifiable, Equatable, Sendable {
    public var id: String { path }
    public var path: String
    public var previousPath: String?
    public var change: CodeV2.FileChangeEntry.Change
    public var hunks: [DiffHunk]
    public var isBinary: Bool

    public var additions: Int { hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == .added }.count } }
    public var deletions: Int { hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == .removed }.count } }

    /// "total.ts" and "src/server/cart/" for the sticky file header.
    public var fileName: String { (path as NSString).lastPathComponent }
    public var directory: String {
        let dir = (path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir + "/"
    }

    public var textDiff: TextDiff { TextDiff(hunks: hunks, linesAdded: additions, linesRemoved: deletions) }
}

public enum CodeV2UnifiedDiff {
    public static func parse(_ text: String) -> [CodeV2DiffFile] {
        var files: [CodeV2DiffFile] = []
        var current: CodeV2DiffFile?
        var hunkHeader: (oldStart: Int, oldCount: Int, newStart: Int, newCount: Int)?
        var hunkLines: [DiffLine] = []
        var oldLine = 0
        var newLine = 0

        func closeHunk() {
            if let header = hunkHeader, current != nil {
                current?.hunks.append(DiffHunk(
                    oldStart: header.oldStart, oldCount: header.oldCount,
                    newStart: header.newStart, newCount: header.newCount, lines: hunkLines
                ))
            }
            hunkHeader = nil
            hunkLines = []
        }

        func closeFile() {
            closeHunk()
            if let file = current { files.append(file) }
            current = nil
        }

        for raw in text.components(separatedBy: "\n") {
            let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
            if line.hasPrefix("diff --git ") {
                closeFile()
                let paths = gitPaths(line)
                current = CodeV2DiffFile(path: paths.new, previousPath: nil, change: .modify, hunks: [], isBinary: false)
                if paths.old != paths.new { current?.previousPath = paths.old; current?.change = .rename }
                continue
            }
            if line.hasPrefix("--- ") && hunkHeader == nil {
                if current == nil {
                    current = CodeV2DiffFile(path: "", previousPath: nil, change: .modify, hunks: [], isBinary: false)
                }
                let path = stripPrefix(String(line.dropFirst(4)))
                if path == "/dev/null" { current?.change = .add } else if current?.path.isEmpty == true { current?.path = path }
                continue
            }
            if line.hasPrefix("+++ ") && hunkHeader == nil {
                let path = stripPrefix(String(line.dropFirst(4)))
                if path == "/dev/null" { current?.change = .delete } else { current?.path = path }
                continue
            }
            if line.hasPrefix("new file mode") { current?.change = .add; continue }
            if line.hasPrefix("deleted file mode") { current?.change = .delete; continue }
            if line.hasPrefix("rename from ") { current?.previousPath = String(line.dropFirst(12)); current?.change = .rename; continue }
            if line.hasPrefix("rename to ") { current?.path = String(line.dropFirst(10)); continue }
            if line.hasPrefix("Binary files ") { current?.isBinary = true; continue }
            if line.hasPrefix("@@") {
                closeHunk()
                if let header = parseHunkHeader(line) {
                    hunkHeader = header
                    oldLine = header.oldStart
                    newLine = header.newStart
                }
                continue
            }
            guard hunkHeader != nil else { continue }
            if line.hasPrefix("+") {
                hunkLines.append(DiffLine(kind: .added, text: String(line.dropFirst()), oldLineNumber: nil, newLineNumber: newLine))
                newLine += 1
            } else if line.hasPrefix("-") {
                hunkLines.append(DiffLine(kind: .removed, text: String(line.dropFirst()), oldLineNumber: oldLine, newLineNumber: nil))
                oldLine += 1
            } else if line.hasPrefix(" ") {
                hunkLines.append(DiffLine(kind: .context, text: String(line.dropFirst()), oldLineNumber: oldLine, newLineNumber: newLine))
                oldLine += 1
                newLine += 1
            } else if line.hasPrefix("\\") {
                continue // "\ No newline at end of file"
            } else if line.isEmpty {
                // A blank line inside a hunk is a context line whose leading
                // space a tool trimmed; outside the counted range it ends it.
                if let header = hunkHeader, newLine < header.newStart + header.newCount {
                    hunkLines.append(DiffLine(kind: .context, text: "", oldLineNumber: oldLine, newLineNumber: newLine))
                    oldLine += 1
                    newLine += 1
                }
            }
        }
        closeFile()
        return files.filter { !$0.path.isEmpty }
    }

    static func parseHunkHeader(_ line: String) -> (oldStart: Int, oldCount: Int, newStart: Int, newCount: Int)? {
        // @@ -12,14 +12,18 @@ optional section
        let parts = line.split(separator: " ")
        guard parts.count >= 3, parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
        func range(_ token: Substring) -> (Int, Int)? {
            let body = token.dropFirst()
            let pieces = body.split(separator: ",", omittingEmptySubsequences: false)
            guard let start = Int(pieces[0]) else { return nil }
            let count = pieces.count > 1 ? Int(pieces[1]) ?? 1 : 1
            return (start, count)
        }
        guard let old = range(parts[1]), let new = range(parts[2]) else { return nil }
        return (old.0, old.1, new.0, new.1)
    }

    static func gitPaths(_ line: String) -> (old: String, new: String) {
        // diff --git a/src/x.ts b/src/x.ts
        let rest = line.dropFirst("diff --git ".count)
        if let range = rest.range(of: " b/") {
            let old = stripPrefix(String(rest[..<range.lowerBound]))
            let new = String(rest[range.upperBound...])
            return (old, new)
        }
        let pieces = rest.split(separator: " ").map(String.init)
        let old = stripPrefix(pieces.first ?? "")
        let new = stripPrefix(pieces.last ?? old)
        return (old, new)
    }

    static func stripPrefix(_ path: String) -> String {
        var trimmed = path
        if let tab = trimmed.firstIndex(of: "\t") { trimmed = String(trimmed[..<tab]) }
        if trimmed.hasPrefix("a/") || trimmed.hasPrefix("b/") { return String(trimmed.dropFirst(2)) }
        return trimmed
    }

    /// One hunk as a standalone patch for `path`, for `git apply [-R]`.
    public static func patch(for hunk: DiffHunk, path: String) -> String {
        var lines = ["--- a/\(path)", "+++ b/\(path)", hunk.header]
        for line in hunk.lines {
            switch line.kind {
            case .context: lines.append(" " + line.text)
            case .added: lines.append("+" + line.text)
            case .removed: lines.append("-" + line.text)
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// Word-level highlight ranges for a removed/added line pair (DESIGN §5.16:
    /// `--diff-add-strong` / `--diff-del-strong`). Returns the changed middle
    /// of each line after trimming the common prefix and suffix.
    public static func wordChange(old: String, new: String) -> (old: Range<Int>, new: Range<Int>)? {
        let a = Array(old)
        let b = Array(new)
        var prefix = 0
        while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < a.count - prefix, suffix < b.count - prefix,
              a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        let oldRange = prefix..<(a.count - suffix)
        let newRange = prefix..<(b.count - suffix)
        if oldRange.isEmpty && newRange.isEmpty { return nil }
        // A change that rewrites most of the line is not worth highlighting.
        if Double(max(oldRange.count, newRange.count)) > 0.7 * Double(max(a.count, b.count)) { return nil }
        return (oldRange, newRange)
    }
}

/// Accept / Reject state per hunk, keyed by ``DiffHunk/reviewIdentifier``.
public struct CodeV2HunkDecisions: Equatable, Sendable {
    public enum Decision: String, Equatable, Sendable, Codable { case accepted, rejected }
    public private(set) var decisions: [String: Decision] = [:]

    public init() {}

    public func decision(for hunk: DiffHunk) -> Decision? { decisions[hunk.reviewIdentifier] }

    public mutating func set(_ decision: Decision?, for hunk: DiffHunk) {
        decisions[hunk.reviewIdentifier] = decision
    }

    /// The next undecided hunk after `index` in `hunks`, for `]`.
    public func nextUndecided(after index: Int?, in hunks: [DiffHunk]) -> Int? {
        let start = (index ?? -1) + 1
        guard start < hunks.count else { return nil }
        return hunks[start...].firstIndex { decisions[$0.reviewIdentifier] == nil }
    }
}
