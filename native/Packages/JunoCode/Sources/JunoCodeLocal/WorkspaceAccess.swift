import Foundation
import JunoCodeCore

/// Security-scoped, bookmark-backed workspace access with canonical
/// containment enforcement on every resolution.
///
/// The bookmark is the only persisted capability; raw paths are display
/// hints. Containment is validated against the canonical (symlink-resolved)
/// root at resolution time, immediately before any filesystem operation.
public final class WorkspaceAccess: WorkspaceAccessing, @unchecked Sendable {
    public let workspaceID: WorkspaceID
    public let rootURL: URL

    private let canonicalRootPath: String
    private let securityScoped: Bool

    deinit {
        if securityScoped {
            rootURL.stopAccessingSecurityScopedResource()
        }
    }

    /// True when the bookmark that opened this workspace needs re-minting.
    ///
    /// Resolution still succeeded — the folder was found — but the stored data
    /// is out of date (the folder moved, or the app's identity changed). The
    /// caller should persist a fresh bookmark; see `WorkspaceDirectory.open`.
    public private(set) var bookmarkNeedsRefresh = false

    /// Opens a workspace from persisted bookmark data.
    ///
    /// **Resolution falls back from scoped to plain, and that is the fix for a
    /// real dead end.** A security-scoped bookmark is bound to the code identity
    /// of the app that created it: re-sign the app — ad-hoc to Developer ID, a
    /// changed team, a local build replacing an installed one — and resolving it
    /// throws. Juno Code surfaced that as `bookmarkInvalid` under the project
    /// list, and because no workspace opened, no session could start and the
    /// composer never appeared. The app looked broken rather than un-permitted.
    ///
    /// (Measured, not assumed: an unsandboxed process *can* both create and
    /// resolve scoped bookmarks. The sandbox is not what breaks this; changing
    /// the signature is.)
    ///
    /// A **plain** bookmark carries no such binding, and Juno for Mac is
    /// deliberately not sandboxed — it runs `git`, spawns test runners and walks
    /// sibling worktrees — so the security scope buys it nothing that the
    /// process does not already have. Preferring scoped and accepting plain
    /// keeps the app correct if it is ever sandboxed again, while making the
    /// stored grant survive a re-signing in the meantime.
    ///
    /// A *stale* bookmark is no longer fatal either. Staleness means "this
    /// resolved, but re-mint it" — throwing turned a folder that had merely
    /// moved into a dead end.
    public convenience init(workspaceID: WorkspaceID, bookmarkData: Data) throws {
        var isStale = false
        var scoped = false
        var resolved: URL?

        if let url = try? URL(
            resolvingBookmarkData: bookmarkData,
            options: [.withSecurityScope],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        ) {
            resolved = url
            scoped = true
        } else {
            var plainIsStale = false
            if let url = try? URL(
                resolvingBookmarkData: bookmarkData,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &plainIsStale
            ) {
                resolved = url
                isStale = plainIsStale
            }
        }

        guard let resolved else { throw WorkspaceAccessError.bookmarkInvalid }

        // Only meaningful for a scoped resolution; a plain bookmark in an
        // unsandboxed process needs no scope to be started or stopped.
        let didStart = scoped && resolved.startAccessingSecurityScopedResource()
        try self.init(workspaceID: workspaceID, rootURL: resolved, securityScoped: didStart)
        bookmarkNeedsRefresh = isStale
    }

    /// Opens a workspace from a directly granted URL (an open-panel result).
    public convenience init(workspaceID: WorkspaceID, grantedURL: URL) throws {
        try self.init(workspaceID: workspaceID, rootURL: grantedURL, securityScoped: false)
    }

    private init(workspaceID: WorkspaceID, rootURL: URL, securityScoped: Bool) throws {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: rootURL.path, isDirectory: &isDirectory) else {
            if securityScoped { rootURL.stopAccessingSecurityScopedResource() }
            throw WorkspaceAccessError.rootUnavailable
        }
        guard isDirectory.boolValue else {
            if securityScoped { rootURL.stopAccessingSecurityScopedResource() }
            throw WorkspaceAccessError.rootIsNotADirectory
        }
        self.workspaceID = workspaceID
        self.rootURL = rootURL
        self.securityScoped = securityScoped
        self.canonicalRootPath = rootURL.resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// Creates persistable bookmark data for a user-granted directory.
    ///
    /// **Plain, deliberately.** A security-scoped bookmark would tie the stored
    /// grant to this build's code signature, so the next re-signed build could
    /// not resolve it — which is precisely the failure that made Juno Code
    /// unusable. This app is not sandboxed, so the scope grants it nothing it
    /// does not already have; a plain bookmark tracks the folder by file id just
    /// as durably (it survives a rename or a move) without the binding.
    ///
    /// ``init(workspaceID:bookmarkData:)`` still *resolves* scoped bookmarks, so
    /// grants written by earlier builds keep working and a future sandboxed
    /// build would keep working too.
    public static func makeBookmark(for grantedURL: URL) throws -> Data {
        do {
            return try grantedURL.bookmarkData(
                options: [],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
        } catch {
            throw WorkspaceAccessError.bookmarkInvalid
        }
    }

    // MARK: - Resolution

    public func resolveForReading(_ path: WorkspacePath) throws -> URL {
        let candidate = rootURL.appendingPathComponent(path.value, isDirectory: false)
        let canonical = candidate.resolvingSymlinksInPath().standardizedFileURL.path
        guard isContained(canonical) else {
            throw WorkspaceAccessError.symlinkEscapesWorkspace(path: path.value)
        }
        return URL(fileURLWithPath: canonical)
    }

    public func resolveForMutation(_ path: WorkspacePath) throws -> URL {
        let candidate = rootURL.appendingPathComponent(path.value, isDirectory: false)
        if FileManager.default.fileExists(atPath: candidate.path) {
            // Existing target: its canonical location must be contained,
            // covering both parent symlinks and the leaf being a symlink.
            let canonical = candidate.resolvingSymlinksInPath().standardizedFileURL.path
            guard isContained(canonical) else {
                throw WorkspaceAccessError.symlinkEscapesWorkspace(path: path.value)
            }
            return URL(fileURLWithPath: canonical)
        }
        // New target: canonicalize the deepest existing ancestor, verify it,
        // then reattach the validated remaining components.
        var ancestor = candidate.deletingLastPathComponent()
        var remaining = [candidate.lastPathComponent]
        while !FileManager.default.fileExists(atPath: ancestor.path) {
            guard ancestor.path.count > 1, ancestor.path != canonicalRootPath else { break }
            remaining.append(ancestor.lastPathComponent)
            let parent = ancestor.deletingLastPathComponent()
            guard parent.path != ancestor.path else {
                throw WorkspaceAccessError.parentDoesNotExist(path: path.value)
            }
            ancestor = parent
        }
        let canonicalAncestor = ancestor.resolvingSymlinksInPath().standardizedFileURL.path
        guard isContained(canonicalAncestor) else {
            throw WorkspaceAccessError.symlinkEscapesWorkspace(path: path.value)
        }
        var resolved = URL(fileURLWithPath: canonicalAncestor)
        for component in remaining.reversed() {
            resolved.appendPathComponent(component)
        }
        return resolved
    }

    public func makeRelative(_ url: URL) throws -> WorkspacePath {
        let canonical = url.resolvingSymlinksInPath().standardizedFileURL.path
        guard canonical != canonicalRootPath else {
            throw WorkspaceAccessError.outsideWorkspace(path: url.path)
        }
        let prefix = canonicalRootPath.hasSuffix("/") ? canonicalRootPath : canonicalRootPath + "/"
        guard canonical.hasPrefix(prefix) else {
            throw WorkspaceAccessError.outsideWorkspace(path: url.path)
        }
        let relative = String(canonical.dropFirst(prefix.count))
        do {
            return try WorkspacePath(relative)
        } catch {
            throw WorkspaceAccessError.outsideWorkspace(path: url.path)
        }
    }

    // MARK: - Helpers

    private func isContained(_ canonicalPath: String) -> Bool {
        if canonicalPath == canonicalRootPath { return true }
        let prefix = canonicalRootPath.hasSuffix("/") ? canonicalRootPath : canonicalRootPath + "/"
        return canonicalPath.hasPrefix(prefix)
    }

    /// True when the workspace root contains a `.git` directory.
    public var isGitRepository: Bool {
        var isDirectory: ObjCBool = false
        let gitPath = rootURL.appendingPathComponent(".git").path
        return FileManager.default.fileExists(atPath: gitPath, isDirectory: &isDirectory)
    }
}
