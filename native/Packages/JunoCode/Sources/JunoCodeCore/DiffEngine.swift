import Foundation

public enum DiffLineKind: String, Codable, Sendable {
    case context
    case added
    case removed
}

public struct DiffLine: Hashable, Codable, Sendable {
    public let kind: DiffLineKind
    public let text: String
    /// 1-based line number in the old file; nil for added lines.
    public let oldLineNumber: Int?
    /// 1-based line number in the new file; nil for removed lines.
    public let newLineNumber: Int?

    public init(kind: DiffLineKind, text: String, oldLineNumber: Int?, newLineNumber: Int?) {
        self.kind = kind
        self.text = text
        self.oldLineNumber = oldLineNumber
        self.newLineNumber = newLineNumber
    }
}

public struct DiffHunk: Hashable, Codable, Sendable {
    public let oldStart: Int
    public let oldCount: Int
    public let newStart: Int
    public let newCount: Int
    public let lines: [DiffLine]

    public init(oldStart: Int, oldCount: Int, newStart: Int, newCount: Int, lines: [DiffLine]) {
        self.oldStart = oldStart
        self.oldCount = oldCount
        self.newStart = newStart
        self.newCount = newCount
        self.lines = lines
    }

    public var header: String {
        "@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@"
    }

    /// Stable within and across launches, unlike Swift's randomized `hashValue`.
    /// Review state uses this key so keeping one hunk does not accept the file.
    public var reviewIdentifier: String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        func feed(_ value: String) {
            for byte in value.utf8 {
                hash ^= UInt64(byte)
                hash &*= 1_099_511_628_211
            }
            hash ^= 0xff
            hash &*= 1_099_511_628_211
        }
        feed(String(oldStart))
        feed(String(oldCount))
        feed(String(newStart))
        feed(String(newCount))
        for line in lines {
            feed(line.kind.rawValue)
            feed(line.text)
            feed(line.oldLineNumber.map(String.init) ?? "-")
            feed(line.newLineNumber.map(String.init) ?? "-")
        }
        return String(hash, radix: 16)
    }
}

public struct TextDiff: Hashable, Codable, Sendable {
    public let hunks: [DiffHunk]
    public let linesAdded: Int
    public let linesRemoved: Int

    public init(hunks: [DiffHunk], linesAdded: Int, linesRemoved: Int) {
        self.hunks = hunks
        self.linesAdded = linesAdded
        self.linesRemoved = linesRemoved
    }

    public var isEmpty: Bool { hunks.isEmpty }
}

public enum DiffEngineError: Error, Equatable, Sendable {
    case inputTooLarge
}

public enum DiffHunkRevertError: Error, Equatable, Sendable {
    case hunkOutOfRange
    case currentContentDiverged
}

/// Pure inverse application for one hunk. The caller remains responsible for
/// fingerprint validation and an atomic checkpointed write.
public enum DiffHunkReverter {
    public static func reverting(
        hunkAt index: Int,
        in currentContent: String,
        from diff: TextDiff
    ) throws -> String {
        guard diff.hunks.indices.contains(index) else {
            throw DiffHunkRevertError.hunkOutOfRange
        }
        let hunk = diff.hunks[index]
        var currentLines = DiffEngine.splitLines(currentContent)
        let start = hunk.newStart > 0 ? hunk.newStart - 1 : 0
        let end = start + hunk.newCount
        guard start >= 0, start <= currentLines.count, end <= currentLines.count else {
            throw DiffHunkRevertError.currentContentDiverged
        }

        let expectedCurrentLines = hunk.lines.compactMap { line in
            line.kind == .removed ? nil : line.text
        }
        guard Array(currentLines[start..<end]) == expectedCurrentLines else {
            throw DiffHunkRevertError.currentContentDiverged
        }
        let restoredLines = hunk.lines.compactMap { line in
            line.kind == .added ? nil : line.text
        }
        currentLines.replaceSubrange(start..<end, with: restoredLines)

        let joined = currentLines.joined(separator: "\n")
        return currentContent.hasSuffix("\n") && !joined.isEmpty ? joined + "\n" : joined
    }
}

/// Pure line-based Myers diff with hunk assembly. No I/O.
public enum DiffEngine {
    /// Guard against pathological inputs; larger files are summarized, not
    /// diffed line by line.
    public static let maximumInputBytes = 4 * 1_024 * 1_024

    public static func diff(
        old: String,
        new: String,
        contextLines: Int = 3
    ) throws -> TextDiff {
        guard old.utf8.count <= maximumInputBytes, new.utf8.count <= maximumInputBytes else {
            throw DiffEngineError.inputTooLarge
        }
        let oldLines = splitLines(old)
        let newLines = splitLines(new)
        let operations = myers(old: oldLines, new: newLines)
        return assemble(
            operations: operations,
            oldLines: oldLines,
            newLines: newLines,
            contextLines: max(0, contextLines)
        )
    }

    public static func splitLines(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var lines = text.components(separatedBy: "\n")
        // A trailing newline produces one phantom empty element; drop it so
        // "a\n" is one line, matching git's line model.
        if lines.last == "" { lines.removeLast() }
        return lines
    }

    // MARK: - Myers O(ND)

    private enum Operation: Equatable {
        case keep(oldIndex: Int, newIndex: Int)
        case remove(oldIndex: Int)
        case insert(newIndex: Int)
    }

    private static func myers(old: [String], new: [String]) -> [Operation] {
        let n = old.count
        let m = new.count
        if n == 0, m == 0 { return [] }
        if n == 0 { return (0..<m).map { .insert(newIndex: $0) } }
        if m == 0 { return (0..<n).map { .remove(oldIndex: $0) } }

        let maxD = n + m
        let offset = maxD
        var v = [Int](repeating: 0, count: 2 * maxD + 1)
        var trace: [[Int]] = []

        outer: for d in 0...maxD {
            trace.append(v)
            var k = -d
            while k <= d {
                var x: Int
                if k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1]) {
                    x = v[offset + k + 1]
                } else {
                    x = v[offset + k - 1] + 1
                }
                var y = x - k
                while x < n, y < m, old[x] == new[y] {
                    x += 1
                    y += 1
                }
                v[offset + k] = x
                if x >= n, y >= m {
                    trace[d] = v
                    break outer
                }
                k += 2
            }
        }

        // Backtrack.
        var operations: [Operation] = []
        var x = n
        var y = m
        var d = trace.count - 1
        while d >= 0 {
            let vd = trace[d]
            let k = x - y
            let previousK: Int
            if k == -d || (k != d && vd[offset + k - 1] < vd[offset + k + 1]) {
                previousK = k + 1
            } else {
                previousK = k - 1
            }
            let previousX = d == 0 ? 0 : vd[offset + previousK]
            let previousY = previousX - previousK

            while x > previousX, y > previousY {
                operations.append(.keep(oldIndex: x - 1, newIndex: y - 1))
                x -= 1
                y -= 1
            }
            if d > 0 {
                if x == previousX {
                    operations.append(.insert(newIndex: y - 1))
                    y -= 1
                } else {
                    operations.append(.remove(oldIndex: x - 1))
                    x -= 1
                }
            }
            d -= 1
        }
        return operations.reversed()
    }

    // MARK: - Hunk assembly

    private static func assemble(
        operations: [Operation],
        oldLines: [String],
        newLines: [String],
        contextLines: Int
    ) -> TextDiff {
        var allLines: [DiffLine] = []
        var added = 0
        var removed = 0
        for operation in operations {
            switch operation {
            case let .keep(oldIndex, newIndex):
                allLines.append(
                    DiffLine(
                        kind: .context,
                        text: oldLines[oldIndex],
                        oldLineNumber: oldIndex + 1,
                        newLineNumber: newIndex + 1
                    )
                )
            case let .remove(oldIndex):
                removed += 1
                allLines.append(
                    DiffLine(
                        kind: .removed,
                        text: oldLines[oldIndex],
                        oldLineNumber: oldIndex + 1,
                        newLineNumber: nil
                    )
                )
            case let .insert(newIndex):
                added += 1
                allLines.append(
                    DiffLine(
                        kind: .added,
                        text: newLines[newIndex],
                        oldLineNumber: nil,
                        newLineNumber: newIndex + 1
                    )
                )
            }
        }
        guard added > 0 || removed > 0 else {
            return TextDiff(hunks: [], linesAdded: 0, linesRemoved: 0)
        }

        // Group changed lines into hunks with surrounding context.
        var hunks: [DiffHunk] = []
        var index = 0
        while index < allLines.count {
            guard allLines[index].kind != .context else {
                index += 1
                continue
            }
            // Found a change; expand backward for context.
            var start = index
            var contextBefore = 0
            while start > 0, contextBefore < contextLines, allLines[start - 1].kind == .context {
                start -= 1
                contextBefore += 1
            }
            // Advance to include subsequent changes separated by small gaps.
            var end = index
            var scan = index
            while scan < allLines.count {
                if allLines[scan].kind != .context {
                    end = scan
                    scan += 1
                    continue
                }
                // Count the run of context lines.
                var run = 0
                var lookahead = scan
                while lookahead < allLines.count, allLines[lookahead].kind == .context {
                    run += 1
                    lookahead += 1
                }
                if lookahead < allLines.count, run <= contextLines * 2 {
                    scan = lookahead
                } else {
                    break
                }
            }
            var stop = end
            var contextAfter = 0
            while stop + 1 < allLines.count, contextAfter < contextLines,
                  allLines[stop + 1].kind == .context
            {
                stop += 1
                contextAfter += 1
            }
            let hunkLines = Array(allLines[start...stop])
            let oldNumbers = hunkLines.compactMap(\.oldLineNumber)
            let newNumbers = hunkLines.compactMap(\.newLineNumber)
            hunks.append(
                DiffHunk(
                    oldStart: oldNumbers.first ?? (oldNumbers.isEmpty ? 0 : 1),
                    oldCount: oldNumbers.count,
                    newStart: newNumbers.first ?? (newNumbers.isEmpty ? 0 : 1),
                    newCount: newNumbers.count,
                    lines: hunkLines
                )
            )
            index = stop + 1
        }
        return TextDiff(hunks: hunks, linesAdded: added, linesRemoved: removed)
    }
}
