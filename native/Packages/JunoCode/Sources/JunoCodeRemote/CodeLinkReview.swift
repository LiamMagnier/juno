import Foundation
import JunoCodeCore

/// Per-hunk revert: one hunk of a checkpoint diff as a standalone unified
/// diff, sent with `checkpoint.applyPatch {reverse:true}` (checked first with
/// `checkOnly`). The env server applies it in the session's folder, all or nothing.
public enum CodeLinkHunkRevert {
    /// The patch whose reverse undoes `hunk` of `file`.
    public static func patch(for hunk: DiffHunk, in file: CodeV2DiffFile) -> String {
        // A new file whose only hunk is reverted goes away; a deleted file comes back.
        let single = file.hunks.count == 1
        let old = file.change == .add && single ? "/dev/null" : "a/\(file.previousPath ?? file.path)"
        let new = file.change == .delete && single ? "/dev/null" : "b/\(file.path)"
        var lines = ["diff --git a/\(file.previousPath ?? file.path) b/\(file.path)", "--- \(old)", "+++ \(new)", hunk.header]
        for line in hunk.lines {
            switch line.kind {
            case .context: lines.append(" " + line.text)
            case .added: lines.append("+" + line.text)
            case .removed: lines.append("-" + line.text)
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// The thread's diff without a reverted hunk, so the list updates at once.
    public static func removing(_ hunk: DiffHunk, from files: [CodeV2DiffFile], path: String) -> [CodeV2DiffFile] {
        files.compactMap { file in
            guard file.path == path else { return file }
            var copy = file
            copy.hunks.removeAll { $0.reviewIdentifier == hunk.reviewIdentifier }
            return copy.hunks.isEmpty && !copy.isBinary ? nil : copy
        }
    }
}

/// The new-session folder browser over `fs.list`: starts at the folders the
/// Mac shares with Remote and never climbs above them (the Mac refuses
/// anything outside them anyway).
public struct CodeLinkFolderBrowser: Equatable, Sendable {
    public let sharedFolders: [String]
    /// nil at the root (the shared folders themselves).
    public private(set) var path: String?
    public private(set) var entries: [CodeV2.FsEntry] = []

    public init(sharedFolders: [String]) {
        self.sharedFolders = sharedFolders.map(Self.normalized)
    }

    static func normalized(_ path: String) -> String {
        guard path.count > 1, path.hasSuffix("/") else { return path }
        return String(path.dropLast())
    }

    public var isAtRoot: Bool { path == nil }

    /// The root's rows: the shared folders, by name.
    public var rootEntries: [CodeV2.FsEntry] {
        sharedFolders.map { CodeV2.FsEntry(name: Self.name(of: $0), path: $0, kind: .dir) }
    }

    /// What the browser lists now: folders only, repositories first, then by name.
    public var rows: [CodeV2.FsEntry] {
        let list = isAtRoot ? rootEntries : entries.filter { $0.kind == .dir }
        if isAtRoot { return list }
        return list.sorted { a, b in
            if (a.isRepo ?? false) != (b.isRepo ?? false) { return a.isRepo ?? false }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    public static func name(of path: String) -> String {
        let name = (path as NSString).lastPathComponent
        return name.isEmpty ? path : name
    }

    /// The shared folder `path` lies in, if any.
    public func sharedRoot(of path: String) -> String? {
        let candidate = Self.normalized(path)
        return sharedFolders
            .filter { candidate == $0 || candidate.hasPrefix($0 == "/" ? "/" : $0 + "/") }
            .max { $0.count < $1.count }
    }

    public func allows(_ path: String) -> Bool { sharedRoot(of: path) != nil }

    /// The folder Up goes to: the parent while inside a shared folder, the root from a shared folder itself.
    public var parent: String?? {
        guard let path else { return nil }
        if sharedFolders.contains(path) { return .some(nil) }
        let up = Self.normalized((path as NSString).deletingLastPathComponent)
        return allows(up) ? .some(up) : .some(nil)
    }

    /// A listing arrived for `listing.path`.
    public mutating func show(_ listing: CodeV2.FsListing) {
        let target = Self.normalized(listing.path)
        guard allows(target) else { return }
        path = target
        entries = listing.entries
    }

    public mutating func goToRoot() {
        path = nil
        entries = []
    }

    /// The current folder's label ("Folders" at the root).
    public var title: String { path.map(Self.name(of:)) ?? "Folders" }
}
