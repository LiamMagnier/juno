import Foundation

public enum WorkspaceAccessError: Error, Equatable, Sendable {
    case rootUnavailable
    case rootIsNotADirectory
    case bookmarkInvalid
    case bookmarkStale
    case outsideWorkspace(path: String)
    case symlinkEscapesWorkspace(path: String)
    case parentDoesNotExist(path: String)
}

/// The single gateway from validated relative paths to absolute filesystem
/// locations. Every resolution re-checks canonical containment; a
/// `WorkspacePath` alone never grants access.
public protocol WorkspaceAccessing: Sendable {
    var workspaceID: WorkspaceID { get }
    /// The workspace root as granted by the user.
    var rootURL: URL { get }

    /// Resolves a path for reading. The target must exist, and its canonical
    /// location (after resolving every symlink) must stay inside the
    /// canonical workspace root.
    func resolveForReading(_ path: WorkspacePath) throws -> URL

    /// Resolves a path for creating or mutating. The target may not exist
    /// yet; its deepest existing ancestor is canonicalized and containment is
    /// enforced immediately before the mutation.
    func resolveForMutation(_ path: WorkspacePath) throws -> URL

    /// Converts an absolute location back to a workspace-relative path,
    /// failing for locations outside the workspace.
    func makeRelative(_ url: URL) throws -> WorkspacePath
}
