import Foundation

/// One path's identity at a moment in time, cheap enough to take for a whole
/// workspace twice around every command.
public struct WorkspaceFileStamp: Hashable, Sendable {
    public let size: Int
    public let modifiedAt: Date

    public init(size: Int, modifiedAt: Date) {
        self.size = size
        self.modifiedAt = modifiedAt
    }
}

/// A workspace's shape at a moment in time.
public struct WorkspaceSnapshot: Sendable {
    public let stamps: [WorkspacePath: WorkspaceFileStamp]
    /// True when the scan hit its file ceiling, so the comparison below is a
    /// lower bound on what changed rather than the whole story.
    public let wasTruncated: Bool

    public init(stamps: [WorkspacePath: WorkspaceFileStamp], wasTruncated: Bool) {
        self.stamps = stamps
        self.wasTruncated = wasTruncated
    }
}

/// What a command did to the workspace, as far as a before/after scan can tell.
public struct WorkspaceChangeReport: Sendable {
    public let created: [WorkspacePath]
    public let modified: [WorkspacePath]
    public let deleted: [WorkspacePath]
    /// True when either scan was truncated. The lists are then incomplete, and
    /// callers must say so rather than presenting them as the full set.
    public let isPartial: Bool

    public init(
        created: [WorkspacePath],
        modified: [WorkspacePath],
        deleted: [WorkspacePath],
        isPartial: Bool
    ) {
        self.created = created
        self.modified = modified
        self.deleted = deleted
        self.isPartial = isPartial
    }

    public var isEmpty: Bool { created.isEmpty && modified.isEmpty && deleted.isEmpty }
    public var count: Int { created.count + modified.count + deleted.count }

    /// Compares two scans of the same workspace.
    ///
    /// Size *and* modification date, because either alone misses a real case: a
    /// formatter that swaps two lines leaves the size identical, and a build
    /// that rewrites a file with the same content inside one filesystem
    /// timestamp tick leaves the date identical.
    public static func comparing(
        before: WorkspaceSnapshot,
        after: WorkspaceSnapshot
    ) -> WorkspaceChangeReport {
        var created: [WorkspacePath] = []
        var modified: [WorkspacePath] = []
        var deleted: [WorkspacePath] = []

        for (path, afterStamp) in after.stamps {
            guard let beforeStamp = before.stamps[path] else {
                created.append(path)
                continue
            }
            if beforeStamp != afterStamp { modified.append(path) }
        }
        for path in before.stamps.keys where after.stamps[path] == nil {
            deleted.append(path)
        }

        return WorkspaceChangeReport(
            created: created.sorted { $0.value < $1.value },
            modified: modified.sorted { $0.value < $1.value },
            deleted: deleted.sorted { $0.value < $1.value },
            isPartial: before.wasTruncated || after.wasTruncated
        )
    }
}

/// Takes before/after scans of a workspace so that changes made by an
/// arbitrary command can at least be *reported*, even though they cannot be
/// undone.
///
/// This is the honest half of the undo story. The structured file tools write
/// checkpoints and can be reverted; a command's edits — a formatter, a codegen
/// step, a build writing into the tree — cannot. Detecting them does not make
/// them undoable, but it replaces "something may have happened" with a list.
public protocol WorkspaceChangeDetecting: Sendable {
    func snapshot() async -> WorkspaceSnapshot
}
