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

    /// Opens a workspace from persisted bookmark data.
    public convenience init(workspaceID: WorkspaceID, bookmarkData: Data) throws {
        var isStale = false
        let resolved: URL
        do {
            resolved = try URL(
                resolvingBookmarkData: bookmarkData,
                options: [.withSecurityScope],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
        } catch {
            throw WorkspaceAccessError.bookmarkInvalid
        }
        if isStale {
            throw WorkspaceAccessError.bookmarkStale
        }
        let didStart = resolved.startAccessingSecurityScopedResource()
        try self.init(workspaceID: workspaceID, rootURL: resolved, securityScoped: didStart)
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
    public static func makeBookmark(for grantedURL: URL) throws -> Data {
        do {
            return try grantedURL.bookmarkData(
                options: [.withSecurityScope],
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
