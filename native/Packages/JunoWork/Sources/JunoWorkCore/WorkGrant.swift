import Foundation

/// Identifier for one grant: one folder or one file a person handed to Juno.
public struct WorkGrantID: Hashable, Codable, Sendable, CustomStringConvertible {
    public let value: String

    public init(value: String = UUID().uuidString.lowercased()) {
        self.value = value
    }

    public var description: String { value }
}

/// What kind of thing was granted.
///
/// Raw values match `WORK_GRANT_KINDS` in `src/lib/work/domain.ts`. The same
/// strings are written to the `WorkGrant` row and replayed to the phone, so a
/// mismatch here is not a naming preference — it is a grant the web app cannot
/// recognise and therefore cannot show or revoke.
public enum WorkGrantKind: String, Codable, CaseIterable, Sendable {
    case localFolder = "local_folder"
    case localFile = "local_file"
    case cloudFolder = "cloud_folder"
    case cloudFile = "cloud_file"
    case connectorScope = "connector_scope"
}

/// How much a grant permits.
///
/// Raw values match `WORK_ACCESS_MODES` in `src/lib/work/domain.ts`.
///
/// **There is no case that permits a permanent delete, and adding one would not
/// be enough to enable it.** Permanent delete is not a `WorkFileOperation`, so
/// no mode can be consulted about it: see ``WorkIrreversibleAction``. The
/// absence is structural on purpose — a boolean named `allowsPermanentDelete`
/// is a boolean somebody eventually flips.
public enum WorkAccessMode: String, Codable, CaseIterable, Sendable, Comparable {
    /// Look, search, summarise. Nothing on disk changes.
    case read
    /// Create, copy, move, rename, write and tag — but nothing leaves the
    /// folder, not even to the Trash.
    case readWriteNoDelete = "read_write_no_delete"
    /// Everything above, plus moving items to the Trash, where the person can
    /// still get them back.
    case readWrite = "read_write"

    private var rank: Int {
        switch self {
        case .read: 0
        case .readWriteNoDelete: 1
        case .readWrite: 2
        }
    }

    public static func < (lhs: WorkAccessMode, rhs: WorkAccessMode) -> Bool {
        lhs.rank < rhs.rank
    }

    /// Whether this mode permits creating or changing content.
    public var allowsWrite: Bool { self >= .readWriteNoDelete }

    /// Whether this mode permits moving an item to the Trash.
    ///
    /// `readWriteNoDelete` deliberately does not. A "no delete" mode that still
    /// let Juno move a file to the Trash is not a mode anybody would recognise
    /// as no-delete: the file is gone from where they left it either way, and
    /// the difference only shows up if they think to look in the Trash.
    public var allowsTrash: Bool { self == .readWrite }

    /// Whether this mode permits one file operation, exhaustively.
    ///
    /// The parameter is a ``WorkFileOperation/Kind``, and that type has no
    /// permanent-delete case. Permanent delete is therefore not merely refused
    /// here — it cannot be asked about, which is the only version of this rule
    /// that survives someone adding a mode.
    public func permits(_ kind: WorkFileOperation.Kind) -> Bool {
        switch kind {
        case .createFolder, .copy, .move, .rename, .write, .tag, .archive, .unarchive:
            return allowsWrite
        case .trash:
            return allowsTrash
        }
    }
}

/// One folder or file a person granted to Juno on one Mac, with the mode they
/// chose and the moment they took it back.
///
/// The bookmark or security-scoped token that makes the grant *usable* lives in
/// the local layer and never appears here: this type is replayed to the phone
/// and written to sync, and a capability that travels is a capability that
/// leaks. What travels is the fact that a grant exists.
public struct WorkGrant: Hashable, Codable, Sendable {
    public let id: WorkGrantID
    public let kind: WorkGrantKind
    public let mode: WorkAccessMode
    /// The folder's name as the person would recognise it. Never the path: this
    /// value is rendered on a phone, and a home directory path names its owner.
    public let displayName: String
    public let hostID: String
    public let grantedAt: Date
    public let revokedAt: Date?

    public init(
        id: WorkGrantID = WorkGrantID(),
        kind: WorkGrantKind,
        mode: WorkAccessMode,
        displayName: String,
        hostID: String,
        grantedAt: Date,
        revokedAt: Date? = nil
    ) {
        self.id = id
        self.kind = kind
        self.mode = mode
        self.displayName = displayName
        self.hostID = hostID
        self.grantedAt = grantedAt
        self.revokedAt = revokedAt
    }

    /// Whether the grant is live at a given moment.
    ///
    /// Takes the date rather than reading the clock so a revocation that lands
    /// mid-batch is decided by the timestamp of the operation being authorised,
    /// not by whenever the check happened to run.
    public func isActive(at date: Date) -> Bool {
        guard let revokedAt else { return true }
        return date < revokedAt
    }

    /// The same grant with the revocation recorded.
    public func revoked(at date: Date) -> WorkGrant {
        WorkGrant(
            id: id,
            kind: kind,
            mode: mode,
            displayName: displayName,
            hostID: hostID,
            grantedAt: grantedAt,
            revokedAt: revokedAt ?? date
        )
    }
}
