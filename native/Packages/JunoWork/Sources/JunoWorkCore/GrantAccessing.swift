import Foundation

/// Every way a location can fail to be usable under a grant.
///
/// The paths carried here are always grant-relative. An absolute path names the
/// person's home directory and their disk layout, and these values reach an
/// error banner on a phone.
public enum WorkGrantAccessError: Error, Equatable, Sendable {
    /// The location is not inside the granted folder at all.
    case outsideGrant(path: String)
    /// The location is inside the granted folder by name, but the filesystem
    /// resolves it somewhere else.
    case symlinkEscapesGrant(path: String)
    /// The folder that would contain a new item does not exist.
    case parentDoesNotExist(path: String)
    case modeForbidsWrite(path: String, mode: WorkAccessMode)
    case modeForbidsTrash(path: String, mode: WorkAccessMode)
    /// Raised when something attempts a permanent delete without an approval
    /// bound to that exact action. There is no mode that makes this go away.
    case permanentDeleteRequiresApproval(path: String)
    case grantRevoked(grantID: WorkGrantID)

    /// True when the person can fix this by widening or re-granting access.
    ///
    /// Separated from the rest because the two groups need opposite copy. A
    /// refused symlink is Juno protecting a boundary and the person should not
    /// be invited to "fix" it; a revoked grant or a read-only mode is a decision
    /// they made and can revisit, and saying nothing about that leaves them
    /// staring at a refusal with no next step.
    public var isResolvableByChangingTheGrant: Bool {
        switch self {
        case .modeForbidsWrite, .modeForbidsTrash, .grantRevoked: true
        case .outsideGrant, .symlinkEscapesGrant, .parentDoesNotExist,
            .permanentDeleteRequiresApproval:
            false
        }
    }
}

extension WorkGrantAccessError: LocalizedError {
    /// Written for the person who hit it, not for the log.
    ///
    /// These reach the phone as the reason a task stopped. Rendered as
    /// `"\(error)"` they would print the enum case, and a reader would see the
    /// literal word **modeForbidsTrash** under a half-finished task with no
    /// indication that they had chosen the mode that caused it.
    public var errorDescription: String? {
        switch self {
        case .outsideGrant(let path):
            "\(path) is outside the folder you gave Juno, so Juno did not open it."
        case .symlinkEscapesGrant(let path):
            "\(path) is a link pointing outside the folder you gave Juno, so Juno did not follow it."
        case .parentDoesNotExist(let path):
            "The folder that would hold \(path) does not exist."
        case .modeForbidsWrite(let path, _):
            "Juno can read \(path) but was not given permission to change anything in this folder."
        case .modeForbidsTrash(let path, _):
            "Juno was asked to move \(path) to the Trash, but this folder was shared without permission to remove anything."
        case .permanentDeleteRequiresApproval(let path):
            "Deleting \(path) for good cannot be undone, so Juno will not do it without you saying yes to this exact item."
        case .grantRevoked:
            "You took back Juno's access to this folder, so it stopped."
        }
    }

    public var recoverySuggestion: String? {
        switch self {
        case .modeForbidsWrite, .modeForbidsTrash:
            "Change this folder's permission in Juno Work settings if you want Juno to do this."
        case .grantRevoked:
            "Share the folder with Juno again to continue."
        case .outsideGrant, .symlinkEscapesGrant, .parentDoesNotExist,
            .permanentDeleteRequiresApproval:
            nil
        }
    }
}

/// The single gateway from a validated ``GrantedPath`` to a real location on
/// disk.
///
/// Every resolution re-checks canonical containment against the live grant root.
/// A `GrantedPath` on its own never grants access, and a resolution is never
/// cached: the answer is only true for as long as the filesystem does not move
/// underneath it, which on a Mac with a sync client running is not long.
///
/// Implementations live in the local layer because containment is a filesystem
/// fact, not a value-level one. Core owns the contract so the rules can be
/// stated once and pinned by tests that build real symlinks.
public protocol GrantAccessing: Sendable {
    /// Which grant this access came from, so a refusal can name the folder the
    /// person shared and an audit row can point at the right grant.
    var grantID: WorkGrantID { get }

    /// How much the grant permits. Read by callers before they propose a
    /// mutation, and re-checked by ``requireWrite(for:)`` before they perform
    /// one.
    var mode: WorkAccessMode { get }

    /// The granted folder as the person chose it.
    var rootURL: URL { get }

    /// Resolves a location for reading. The target must exist, and its canonical
    /// location — after every symlink in it has been resolved — must still be
    /// inside the canonical grant root.
    func resolveForReading(_ path: GrantedPath) throws -> URL

    /// Resolves a location for creating or changing. The target need not exist
    /// yet: its deepest existing ancestor is canonicalized and contained, and
    /// the remaining components are re-appended to that verified location.
    ///
    /// This differs from ``resolveForReading(_:)`` because canonicalizing a path
    /// that does not exist yet silently returns it unchanged, which would let a
    /// not-yet-created file under a symlinked folder pass a check that only ever
    /// looked at the leaf.
    func resolveForMutation(_ path: GrantedPath) throws -> URL

    /// Converts a real location back to a grant-relative path, failing for
    /// anything outside the grant.
    func makeRelative(_ url: URL) throws -> GrantedPath
}

extension GrantAccessing {
    /// Refuses the operation when the grant's mode does not cover it.
    ///
    /// A default implementation rather than a rule each call site restates,
    /// because a mode check that has to be remembered is a mode check that is
    /// eventually forgotten in exactly one branch.
    public func requireMode(for kind: WorkFileOperation.Kind, path: GrantedPath) throws {
        guard mode.permits(kind) else {
            throw kind == .trash
                ? WorkGrantAccessError.modeForbidsTrash(path: path.value, mode: mode)
                : WorkGrantAccessError.modeForbidsWrite(path: path.value, mode: mode)
        }
    }
}
