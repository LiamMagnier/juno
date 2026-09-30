import Foundation
import JunoCodeCore

/// Filesystem-walking implementation of workspace navigation and search.
/// Applies built-in exclusions plus every `.gitignore` on the way down, skips
/// other checkouts of the repository (worktrees), bounds file sizes for
/// content search, and checks for cancellation while walking.
public final class WorkspaceIndexService: WorkspaceIndexing, Sendable {
    /// Directories never traversed, regardless of gitignore.
    public static let builtinExcludedDirectories: Set<String> = [
        ".git", "node_modules", ".build", ".swiftpm", "DerivedData",
        ".next", "dist", ".venv", "__pycache__", ".DS_Store",
    ]

    /// Folders where tools keep extra checkouts of this same repository.
    /// Searching them returns every hit once per checkout, and the copies
    /// are not the files the reader is working on.
    public static let excludedWorktreeFolders: Set<String> = [
        ".juno/worktrees", ".claude/worktrees",
    ]

    public static let maximumGrepFileBytes = 1_024 * 1_024
    public static let maximumWalkEntries = 50_000

    private let access: any WorkspaceAccessing

    public init(access: any WorkspaceAccessing) {
        self.access = access
    }

    // MARK: - Listing

    public func listDirectory(_ path: WorkspacePath?) async throws -> [FileEntry] {
        let directoryURL: URL
        if let path {
            directoryURL = try access.resolveForReading(path)
        } else {
            directoryURL = access.rootURL
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: directoryURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else {
            throw WorkspaceIndexError.notADirectory(path: path?.value ?? ".")
        }
        let ignore = ignoreLayers(downTo: path)
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        var entries: [FileEntry] = []
        for url in contents {
            guard let entry = makeEntry(url: url, ignore: ignore) else { continue }
            entries.append(entry)
        }
        return entries.sorted { lhs, rhs in
            if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
            return lhs.path.value.localizedCaseInsensitiveCompare(rhs.path.value) == .orderedAscending
        }
    }

    // MARK: - Name search

    public func findFiles(nameContains query: String, limit: Int) async throws -> [FileEntry] {
        let needle = query.lowercased()
        guard !needle.isEmpty else { return [] }
        var results: [FileEntry] = []
        try await walk { entry in
            guard !entry.isDirectory else { return true }
            if entry.path.lastComponent.lowercased().contains(needle) {
                results.append(entry)
            }
            return results.count < max(1, limit)
        }
        return results
    }

    // MARK: - Glob

    public func glob(_ pattern: String, limit: Int) async throws -> [FileEntry] {
        let compiled: GlobPattern
        do {
            compiled = try GlobPattern(pattern)
        } catch {
            throw WorkspaceIndexError.invalidPattern
        }
        var results: [FileEntry] = []
        try await walk { entry in
            guard !entry.isDirectory else { return true }
            if compiled.matches(entry.path.value) {
                results.append(entry)
            }
            return results.count < max(1, limit)
        }
        return results
    }

    // MARK: - Grep

    public func grep(_ query: GrepQuery) async throws -> [GrepMatch] {
        guard !query.pattern.isEmpty else { return [] }
        let matcher = try LineMatcher(query)
        var matches: [GrepMatch] = []
        let limit = max(1, query.maximumMatches)
        try await walkSearchable(query) { entry, content in
            let context = (before: query.contextBefore, after: query.contextAfter)
            // Only as many as are still wanted: a pattern that hits every
            // line of a large file must not build a match, with its context,
            // for each of them first.
            matches += matcher.matches(
                in: content, path: entry.path, context: context, limit: limit - matches.count
            )
            return matches.count < limit
        }
        return matches
    }

    public func grepCounts(_ query: GrepQuery) async throws -> [GrepFileCount] {
        guard !query.pattern.isEmpty else { return [] }
        let matcher = try LineMatcher(query)
        var counts: [GrepFileCount] = []
        let limit = max(1, query.maximumMatches)
        try await walkSearchable(query) { entry, content in
            let count = matcher.count(in: content)
            if count > 0 {
                counts.append(GrepFileCount(path: entry.path, count: count))
            }
            return counts.count < limit
        }
        return counts.sorted { $0.path.value < $1.path.value }
    }

    /// Every text file the query may search, with its content: inside the
    /// query's path, matching its include glob, small enough, not binary.
    private func walkSearchable(
        _ query: GrepQuery,
        _ visit: (FileEntry, String) throws -> Bool
    ) async throws {
        let includeGlob: GlobPattern?
        if let include = query.includeGlob {
            guard let compiled = try? GlobPattern(include) else {
                throw WorkspaceIndexError.invalidPattern
            }
            includeGlob = compiled
        } else {
            includeGlob = nil
        }
        try await walk(from: query.path) { entry in
            guard !entry.isDirectory else { return true }
            if let includeGlob, !includeGlob.matches(entry.path.value) { return true }
            if let byteCount = entry.byteCount, byteCount > Self.maximumGrepFileBytes {
                return true
            }
            guard let url = try? self.access.resolveForReading(entry.path),
                  let data = try? Data(contentsOf: url),
                  data.count <= Self.maximumGrepFileBytes,
                  !data.contains(0),
                  let content = String(data: data, encoding: .utf8)
            else { return true }
            return try visit(entry, content)
        }
    }

    // MARK: - Walking

    /// One `.gitignore`, and the folder its patterns are relative to.
    private struct IgnoreLayer {
        /// Workspace-relative folder, "" for the root.
        let base: String
        let matcher: GitignoreMatcher
    }

    /// Depth-first walk honoring exclusions and every `.gitignore` from the
    /// root down. The visitor returns false to stop early. Checks
    /// cancellation between entries.
    ///
    /// - Parameter start: a folder to walk instead of the whole workspace, or
    ///   a single file to visit alone.
    private func walk(from start: WorkspacePath? = nil, _ visit: (FileEntry) throws -> Bool) async throws {
        var stack: [(url: URL, layers: [IgnoreLayer])] = []
        if let start {
            let url = try access.resolveForReading(start)
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
                throw WorkspaceIndexError.notADirectory(path: start.value)
            }
            if !isDirectory.boolValue {
                // One file: searched unless a `.gitignore` above it says not.
                let parent = start.value.lastIndex(of: "/").flatMap { try? WorkspacePath(String(start.value[..<$0])) }
                if let entry = makeEntry(url: url, ignore: ignoreLayers(downTo: parent)) {
                    _ = try visit(entry)
                }
                return
            }
            stack = [(url, ignoreLayers(downTo: start))]
        } else {
            stack = [(access.rootURL, ignoreLayers(downTo: nil))]
        }
        var visited = 0
        while let (directory, layers) = stack.popLast() {
            try Task.checkCancellation()
            let contents = (try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey],
                options: []
            )) ?? []
            for url in contents.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                try Task.checkCancellation()
                visited += 1
                guard visited <= Self.maximumWalkEntries else { return }
                guard let entry = makeEntry(url: url, ignore: layers) else { continue }
                guard try visit(entry) else { return }
                if entry.isDirectory {
                    // Never descend through directory symlinks: escaping
                    // targets are rejected and internal ones would duplicate.
                    let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey])
                    if values?.isSymbolicLink != true, !Self.isWorktreeCheckout(url) {
                        stack.append((url, layers + layer(at: url, relative: entry.path.value)))
                    }
                }
            }
        }
    }

    /// Builds an entry for a child URL, or nil when excluded or outside.
    private func makeEntry(url: URL, ignore: [IgnoreLayer]) -> FileEntry? {
        let name = url.lastPathComponent
        guard !Self.builtinExcludedDirectories.contains(name) else { return nil }
        guard let relative = try? access.makeRelative(url) else { return nil }
        guard !Self.excludedWorktreeFolders.contains(relative.value) else { return nil }
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
        let isDirectory = values?.isDirectory ?? false
        if Self.isIgnored(relative.value, isDirectory: isDirectory, by: ignore) {
            return nil
        }
        return FileEntry(
            path: relative,
            isDirectory: isDirectory,
            byteCount: values?.fileSize
        )
    }

    /// Git's precedence: every layer that speaks about the path is consulted,
    /// outermost first, and the deepest file's last matching rule wins.
    private static func isIgnored(_ path: String, isDirectory: Bool, by layers: [IgnoreLayer]) -> Bool {
        var ignored = false
        for layer in layers {
            let local: String
            if layer.base.isEmpty {
                local = path
            } else if path.hasPrefix(layer.base + "/") {
                local = String(path.dropFirst(layer.base.count + 1))
            } else {
                continue
            }
            if let verdict = layer.matcher.verdict(local, isDirectory: isDirectory) {
                ignored = verdict
            }
        }
        return ignored
    }

    /// The root's `.gitignore` and each one on the way down to `directory`,
    /// so a search or listing that starts below the root obeys them all.
    private func ignoreLayers(downTo directory: WorkspacePath?) -> [IgnoreLayer] {
        var layers = layer(at: access.rootURL, relative: "")
        guard let directory else { return layers }
        var relative = ""
        for component in directory.value.split(separator: "/") {
            relative = relative.isEmpty ? String(component) : relative + "/" + component
            layers += layer(at: access.rootURL.appendingPathComponent(relative), relative: relative)
        }
        return layers
    }

    private func layer(at directory: URL, relative: String) -> [IgnoreLayer] {
        let url = directory.appendingPathComponent(".gitignore")
        guard let contents = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        let matcher = GitignoreMatcher(contents: contents)
        return matcher.isEmpty ? [] : [IgnoreLayer(base: relative, matcher: matcher)]
    }

    /// A folder holding a linked worktree of some repository: its `.git` is a
    /// file pointing into another repository's `worktrees/`. A submodule's
    /// `.git` file points into `modules/` instead, and is searched as usual.
    static func isWorktreeCheckout(_ directory: URL) -> Bool {
        let marker = directory.appendingPathComponent(".git")
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: marker.path, isDirectory: &isDirectory),
              !isDirectory.boolValue,
              let handle = try? FileHandle(forReadingFrom: marker)
        else { return false }
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: 1_024)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        return head.hasPrefix("gitdir:") && head.contains("/worktrees/")
    }
}

/// One query compiled for line-by-line (or, in multiline mode, whole-file)
/// matching.
private struct LineMatcher {
    private let query: GrepQuery
    private let regex: NSRegularExpression?

    init(_ query: GrepQuery) throws {
        self.query = query
        if query.isRegex {
            var options: NSRegularExpression.Options = []
            if !query.caseSensitive { options.insert(.caseInsensitive) }
            if query.multiline { options.formUnion([.dotMatchesLineSeparators, .anchorsMatchLines]) }
            guard let compiled = try? NSRegularExpression(pattern: query.pattern, options: options) else {
                throw WorkspaceIndexError.invalidPattern
            }
            regex = compiled
        } else {
            regex = nil
        }
    }

    private func lineMatches(_ line: String) -> Bool {
        if let regex {
            let range = NSRange(line.startIndex..., in: line)
            return regex.firstMatch(in: line, options: [], range: range) != nil
        }
        if query.caseSensitive { return line.contains(query.pattern) }
        return line.range(of: query.pattern, options: .caseInsensitive) != nil
    }

    /// The file's lines; a final newline ends the last line rather than
    /// starting an empty one.
    private static func lines(of content: String) -> [String] {
        var lines = content.components(separatedBy: "\n")
        if lines.count > 1, lines.last == "" { lines.removeLast() }
        return lines
    }

    func count(in content: String) -> Int {
        if query.multiline {
            var count = 0
            forEachMatch(in: content) { _ in
                count += 1
                return true
            }
            return count
        }
        return Self.lines(of: content).reduce(0) { $0 + (lineMatches($1) ? 1 : 0) }
    }

    /// At most `limit` matches, in file order.
    func matches(
        in content: String,
        path: WorkspacePath,
        context: (before: Int, after: Int),
        limit: Int
    ) -> [GrepMatch] {
        guard limit > 0 else { return [] }
        let lines = Self.lines(of: content)
        func bounded(_ text: String, bytes: Int = 512) -> String {
            OutputLimiter.apply(OutputLimit(maximumBytes: bytes, truncationNotice: "…"), to: text).text
        }
        func surrounding(first: Int, last: Int) -> ([String], [String]) {
            let before = lines[max(0, first - context.before)..<first].map { bounded($0) }
            let afterStart = min(lines.count, last + 1)
            let after = lines[afterStart..<min(lines.count, afterStart + context.after)].map { bounded($0) }
            return (before, after)
        }
        if query.multiline {
            return spans(in: content, limit: limit).map { span in
                let (before, after) = surrounding(first: span.first, last: span.last)
                return GrepMatch(
                    path: path,
                    lineNumber: span.first + 1,
                    lineText: bounded(lines[span.first...span.last].joined(separator: "\n"), bytes: 2_048),
                    endLineNumber: span.last > span.first ? span.last + 1 : nil,
                    contextBefore: before,
                    contextAfter: after
                )
            }
        }
        var found: [GrepMatch] = []
        for (index, line) in lines.enumerated() where lineMatches(line) {
            let (before, after) = surrounding(first: index, last: index)
            found.append(GrepMatch(
                path: path,
                lineNumber: index + 1,
                lineText: bounded(line),
                contextBefore: before,
                contextAfter: after
            ))
            if found.count >= limit { break }
        }
        return found
    }

    /// Visits each whole-content match in order until `visit` returns false.
    /// One at a time, and no further than wanted: a pattern like `.` over a
    /// large file matches every character, and gathering all of them first —
    /// each then counted back to the top of the file for its line — took
    /// hours.
    private func forEachMatch(in content: String, _ visit: (Range<String.Index>) -> Bool) {
        if let regex {
            let whole = NSRange(content.startIndex..., in: content)
            regex.enumerateMatches(in: content, options: [], range: whole) { result, _, stop in
                guard let result, result.range.length > 0,
                      let range = Range(result.range, in: content)
                else { return }
                if !visit(range) { stop.pointee = true }
            }
        } else {
            var searchStart = content.startIndex
            let options: String.CompareOptions = query.caseSensitive ? [] : [.caseInsensitive]
            while searchStart < content.endIndex,
                  let range = content.range(of: query.pattern, options: options, range: searchStart..<content.endIndex)
            {
                guard visit(range) else { return }
                searchStart = range.upperBound > range.lowerBound ? range.upperBound : content.index(after: range.lowerBound)
            }
        }
    }

    /// Zero-based first and last line of the first `limit` whole-content
    /// matches.
    private func spans(in content: String, limit: Int) -> [(first: Int, last: Int)] {
        // Matches come in order and do not overlap, so one pass down the file
        // counts every line: "\n" code units from where the last match began.
        let utf8 = content.utf8
        let newline = UInt8(ascii: "\n")
        var position = content.startIndex
        var line = 0
        var spans: [(first: Int, last: Int)] = []
        forEachMatch(in: content) { range in
            line += utf8[position..<range.lowerBound].reduce(0) { $1 == newline ? $0 + 1 : $0 }
            position = range.lowerBound
            // The last character matched, not the position after it: a match
            // ending with its newline still ends on that line.
            let lastIndex = content.index(before: range.upperBound)
            let inside = utf8[range.lowerBound..<lastIndex].reduce(0) { $1 == newline ? $0 + 1 : $0 }
            spans.append((line, line + inside))
            return spans.count < limit
        }
        return spans
    }
}
