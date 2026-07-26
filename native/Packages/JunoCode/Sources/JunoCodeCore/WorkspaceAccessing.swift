import Foundation

public enum WorkspaceAccessError: Error, Equatable, Sendable {
    case rootUnavailable
    case rootIsNotADirectory
    case bookmarkInvalid
    case bookmarkStale
    case outsideWorkspace(path: String)
    case symlinkEscapesWorkspace(path: String)
    case parentDoesNotExist(path: String)

    /// True when re-choosing the folder in a file dialog would fix this.
    ///
    /// macOS hands a sandboxed app a *security-scoped bookmark* when the user
    /// picks a folder, and that bookmark stops resolving when the app's code
    /// identity changes (a rebuild, a re-sign) or the folder moves. Nothing the
    /// app can do repairs it — only the user picking the folder again can, which
    /// is why this case has to be distinguishable from a genuine error rather
    /// than reported as one more failure string.
    public var isRecoverableByRegrantingAccess: Bool {
        switch self {
        case .bookmarkInvalid, .bookmarkStale, .rootUnavailable: true
        case .rootIsNotADirectory, .outsideWorkspace, .symlinkEscapesWorkspace,
            .parentDoesNotExist:
            false
        }
    }
}

extension WorkspaceAccessError: LocalizedError {
    /// Written for the person who hit it, not for the log.
    ///
    /// These used to reach the sidebar as `"\(error)"`, which printed the enum
    /// case — a reader saw the literal word **bookmarkInvalid** under their
    /// project list, with no indication that their folder grant had lapsed or
    /// that re-choosing the folder was the fix.
    public var errorDescription: String? {
        switch self {
        case .bookmarkInvalid:
            "Juno's permission to open this folder is no longer valid. macOS withdraws a folder grant when the app is rebuilt, re-signed, or the folder is moved."
        case .bookmarkStale:
            "Juno's permission to open this folder has expired and could not be renewed."
        case .rootUnavailable:
            "Juno could not reach this folder. It may have been moved, renamed, or be on a disk that is not mounted."
        case .rootIsNotADirectory:
            "That is a file, not a folder. Juno Code opens a project folder."
        case .outsideWorkspace(let path):
            "\(path) is outside this project folder, so Juno did not open it."
        case .symlinkEscapesWorkspace(let path):
            "\(path) is a link pointing outside this project folder, so Juno did not follow it."
        case .parentDoesNotExist(let path):
            "The folder that would contain \(path) does not exist."
        }
    }

    public var recoverySuggestion: String? {
        isRecoverableByRegrantingAccess ? "Choose the folder again to restore access." : nil
    }
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
