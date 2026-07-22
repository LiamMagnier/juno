import Foundation
import JunoCodeCore

/// Filesystem-walking implementation of workspace navigation and search.
/// Applies built-in exclusions plus the root `.gitignore`, bounds file sizes
/// for content search, and checks for cancellation while walking.
public final class WorkspaceIndexService: WorkspaceIndexing, Sendable {
    /// Directories never traversed, regardless of gitignore.
    public static let builtinExcludedDirectories: Set<String> = [
        ".git", "node_modules", ".build", ".swiftpm", "DerivedData",
        ".next", "dist", ".venv", "__pycache__", ".DS_Store",
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
        let ignore = loadGitignore()
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
        let includeGlob: GlobPattern?
        if let include = query.includeGlob {
            guard let compiled = try? GlobPattern(include) else {
                throw WorkspaceIndexError.invalidPattern
            }
            includeGlob = compiled
        } else {
            includeGlob = nil
        }
        let regex: NSRegularExpression?
        if query.isRegex {
            var options: NSRegularExpression.Options = []
            if !query.caseSensitive { options.insert(.caseInsensitive) }
            guard let compiled = try? NSRegularExpression(
                pattern: query.pattern,
                options: options
            ) else {
                throw WorkspaceIndexError.invalidPattern
            }
            regex = compiled
        } else {
            regex = nil
        }

        var matches: [GrepMatch] = []
        let limit = max(1, query.maximumMatches)
        try await walk { entry in
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

            var lineNumber = 0
            for line in content.components(separatedBy: "\n") {
                lineNumber += 1
                let isMatch: Bool
                if let regex {
                    let range = NSRange(line.startIndex..., in: line)
                    isMatch = regex.firstMatch(in: line, options: [], range: range) != nil
                } else if query.caseSensitive {
                    isMatch = line.contains(query.pattern)
                } else {
                    isMatch = line.range(of: query.pattern, options: .caseInsensitive) != nil
                }
                if isMatch {
                    let limited = OutputLimiter.apply(
                        OutputLimit(maximumBytes: 512, truncationNotice: "…"),
                        to: line
                    )
                    matches.append(
                        GrepMatch(path: entry.path, lineNumber: lineNumber, lineText: limited.text)
                    )
                    if matches.count >= limit { return false }
                }
            }
            return true
        }
        return matches
    }

    // MARK: - Walking

    /// Depth-first walk honoring exclusions and gitignore. The visitor
    /// returns false to stop early. Checks cancellation between entries.
    private func walk(_ visit: (FileEntry) throws -> Bool) async throws {
        let ignore = loadGitignore()
        var stack: [URL] = [access.rootURL]
        var visited = 0
        while let directory = stack.popLast() {
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
                guard let entry = makeEntry(url: url, ignore: ignore) else { continue }
                guard try visit(entry) else { return }
                if entry.isDirectory {
                    // Never descend through directory symlinks: escaping
                    // targets are rejected and internal ones would duplicate.
                    let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey])
                    if values?.isSymbolicLink != true {
                        stack.append(url)
                    }
                }
            }
        }
    }

    /// Builds an entry for a child URL, or nil when excluded or outside.
    private func makeEntry(url: URL, ignore: GitignoreMatcher?) -> FileEntry? {
        let name = url.lastPathComponent
        guard !Self.builtinExcludedDirectories.contains(name) else { return nil }
        guard let relative = try? access.makeRelative(url) else { return nil }
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
        let isDirectory = values?.isDirectory ?? false
        if let ignore, ignore.isIgnored(relative.value, isDirectory: isDirectory) {
            return nil
        }
        return FileEntry(
            path: relative,
            isDirectory: isDirectory,
            byteCount: values?.fileSize
        )
    }

    private func loadGitignore() -> GitignoreMatcher? {
        let url = access.rootURL.appendingPathComponent(".gitignore")
        guard let contents = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let matcher = GitignoreMatcher(contents: contents)
        return matcher.isEmpty ? nil : matcher
    }
}
