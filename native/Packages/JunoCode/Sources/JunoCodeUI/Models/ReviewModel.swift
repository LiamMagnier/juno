import Foundation
import Observation
import JunoCodeCore

/// Which hunk or line a new review note is being written against.
public struct ReviewCommentTarget: Hashable, Sendable {
    public let path: String
    public let hunkIdentifier: String
    public let hunkHeader: String
    public let lineNumber: Int?
    public let quotedLine: String?

    public init(
        path: String,
        hunkIdentifier: String,
        hunkHeader: String,
        lineNumber: Int? = nil,
        quotedLine: String? = nil
    ) {
        self.path = path
        self.hunkIdentifier = hunkIdentifier
        self.hunkHeader = hunkHeader
        self.lineNumber = lineNumber
        self.quotedLine = quotedLine
    }
}

/// The state of one review: which diffs are loaded, how they are laid out,
/// which file the reader is looking at, and any file opened from Open Quickly.
///
/// It is a model rather than view state because three surfaces have to agree on
/// one review — the inspector's Changes list picks a file, the detail column
/// shows it, and the window's Review command opens and closes it. Keeping that
/// in the views is what previously let a run be listed in one place and opened
/// in another.
@MainActor
@Observable
public final class ReviewModel {
    public enum Layout: String, CaseIterable, Identifiable, Sendable {
        case unified
        case sideBySide

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .unified: "Unified"
            case .sideBySide: "Side by side"
            }
        }

        public var systemImage: String {
            switch self {
            case .unified: "list.bullet"
            case .sideBySide: "rectangle.split.2x1"
            }
        }
    }

    /// Whether the detail column is showing Review instead of the transcript.
    /// The window binds its Review command and its detail switch to this, so
    /// there is exactly one answer to "is the reader reviewing?".
    public var isPresented = false
    public var layout: Layout = .unified
    /// The file the canvas should scroll to. Cleared once the scroll happens so
    /// a later selection of the same file scrolls again.
    public var focusedPath: String?
    /// A workspace file opened for reading or editing. While set, it takes the
    /// canvas: a document and a diff review cannot share one column honestly.
    public var openDocument: WorkspaceEditorDocument?
    public var commentTarget: ReviewCommentTarget?

    public private(set) var diffs: [String: TextDiff] = [:]
    public private(set) var loadingPaths: Set<String> = []
    /// Files whose diff cannot be computed — no checkpoint, or content that is
    /// unreadable as text. Reported in place rather than shown as "no changes".
    public private(set) var unavailablePaths: Set<String> = []
    public private(set) var revertingHunkID: String?
    /// Why the last per-hunk revert failed, keyed by the hunk that refused it.
    /// A divergence belongs on the hunk it happened to, not in a window-wide
    /// error bar the reader has to map back onto the diff themselves.
    public private(set) var revertFailures: [String: String] = [:]
    public private(set) var checkpoints: [String: [Checkpoint]] = [:]

    private var loadedSessionID: CodeSessionID?
    private var loadedSignatures: [String: String] = [:]

    public init() {}

    // MARK: - Presentation

    public func present(path: String? = nil) {
        isPresented = true
        openDocument = nil
        if let path {
            focusedPath = path
        }
    }

    public func dismiss() {
        isPresented = false
    }

    public func consumeFocus() -> String? {
        defer { focusedPath = nil }
        return focusedPath
    }

    // MARK: - Diffs

    /// What a file's diff depends on. Reloading is driven by this rather than by
    /// "have I loaded this path", so a file the agent edits a second time gets a
    /// fresh diff instead of the one from its first edit.
    public static func signature(of change: TrackedChange) -> String {
        "\(change.path)|\(change.checkpointIDs.count)|\(change.linesAdded)|\(change.linesRemoved)"
    }

    public static func signature(of changes: [TrackedChange]) -> String {
        changes.map(signature(of:)).joined(separator: "\u{1f}")
    }

    /// Loads the diff for every tracked change whose content moved, and forgets
    /// files that are no longer changed so a reverted file cannot linger as a
    /// stale diff.
    public func load(from controller: SessionController) async {
        adopt(controller.sessionID)
        let live = Set(controller.changes.map(\.path))
        diffs = diffs.filter { live.contains($0.key) }
        unavailablePaths = unavailablePaths.intersection(live)
        checkpoints = checkpoints.filter { live.contains($0.key) }
        loadedSignatures = loadedSignatures.filter { live.contains($0.key) }
        for change in controller.changes {
            let signature = Self.signature(of: change)
            guard loadedSignatures[change.path] != signature else { continue }
            loadedSignatures[change.path] = signature
            await reload(path: change.path, from: controller)
        }
    }

    public func reload(path: String, from controller: SessionController) async {
        loadingPaths.insert(path)
        let diff = await controller.diff(for: path)
        loadingPaths.remove(path)
        if let diff {
            diffs[path] = diff
            unavailablePaths.remove(path)
        } else {
            diffs[path] = nil
            unavailablePaths.insert(path)
        }
    }

    /// Reverts one hunk through the controller's fingerprint-checked,
    /// checkpointed write, then reloads that file so the remaining hunks and
    /// their indices match what is on disk.
    public func revertHunk(
        at index: Int,
        in path: String,
        hunk: DiffHunk,
        using controller: SessionController
    ) async {
        revertingHunkID = hunk.reviewIdentifier
        revertFailures[hunk.reviewIdentifier] = nil
        if await controller.rejectHunk(path: path, index: index) {
            await reload(path: path, from: controller)
        } else {
            revertFailures[hunk.reviewIdentifier] =
                controller.transientError ?? "That hunk could not be reverted."
        }
        revertingHunkID = nil
    }

    public func dismissRevertFailure(for hunkID: String) {
        revertFailures[hunkID] = nil
    }

    public func revertFile(_ path: String, using controller: SessionController) async {
        await controller.rejectChange(path: path)
        await reload(path: path, from: controller)
    }

    // MARK: - File history

    public func loadCheckpoints(for path: String, from controller: SessionController) async {
        checkpoints[path] = await controller.checkpointHistory(for: path)
    }

    public func restore(
        checkpointID: String,
        path: String,
        force: Bool,
        using controller: SessionController
    ) async -> Bool {
        let restored = await controller.restoreCheckpoint(checkpointID, force: force)
        if restored {
            await reload(path: path, from: controller)
            await loadCheckpoints(for: path, from: controller)
        }
        return restored
    }

    // MARK: - Documents

    public func open(_ path: WorkspacePath, using controller: SessionController) async {
        guard let document = await controller.openWorkspaceFile(path) else { return }
        openDocument = document
        isPresented = true
    }

    public func closeDocument() {
        openDocument = nil
    }

    // MARK: - Session identity

    /// A review belongs to one session. Moving to another session drops every
    /// cached diff instead of showing the previous session's changes.
    private func adopt(_ sessionID: CodeSessionID) {
        guard loadedSessionID != sessionID else { return }
        loadedSessionID = sessionID
        diffs = [:]
        loadedSignatures = [:]
        loadingPaths = []
        unavailablePaths = []
        checkpoints = [:]
        openDocument = nil
        commentTarget = nil
        focusedPath = nil
        revertingHunkID = nil
        revertFailures = [:]
    }
}
