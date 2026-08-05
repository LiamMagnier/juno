import Foundation
import JunoCodeCore

/// Aggregates `fileChanged` events into the per-path rows the Changes and Diff
/// tabs show.
///
/// The third pure piece of ``SessionController``, and the one with the most to
/// get wrong. A single file is usually touched several times in one run — an
/// `apply_patch`, then a follow-up edit, then a revert of one hunk — and the row
/// the reader sees has to be the *sum* of those, in the order the paths were
/// first touched, with the reviewer's own decisions layered on top.
///
/// Kept as a free function over its inputs rather than a method on the
/// controller so the layering order can be tested directly: overrides beat the
/// aggregate, and review state is applied last because a reviewer's accept or
/// reject is a fact about the file, not about any one event in it.
enum TrackedChangeProjection {
    /// Per-file line counts a hunk action already recomputed, keyed by path.
    /// They replace the aggregate rather than adding to it: after accepting one
    /// hunk of five, the honest number is the diff that is actually left on
    /// disk, not the running total of everything the agent ever wrote.
    typealias LineStats = (added: Int, removed: Int)

    static func project(
        events: [SessionEvent],
        reviewStates: [String: TrackedChange.ReviewState],
        lineStatsOverrides: [String: LineStats]
    ) -> [TrackedChange] {
        var byPath: [String: TrackedChange] = [:]
        // Insertion order, kept separately: a dictionary has none, and the list
        // the reader sees should be the order the run touched things.
        var order: [String] = []

        for event in events {
            guard case let .fileChanged(change) = event.payload else { continue }
            let key = change.path.value
            if var existing = byPath[key] {
                // The latest kind wins — a file created then edited is an edit
                // as far as the row is concerned — while the line counts and
                // checkpoints accumulate, because undo needs every one of them.
                existing.kind = change.kind
                existing.linesAdded += change.linesAdded
                existing.linesRemoved += change.linesRemoved
                if let checkpointID = change.checkpointID {
                    existing.checkpointIDs.append(checkpointID)
                }
                byPath[key] = existing
            } else {
                order.append(key)
                byPath[key] = TrackedChange(
                    path: key,
                    kind: change.kind,
                    linesAdded: change.linesAdded,
                    linesRemoved: change.linesRemoved,
                    checkpointIDs: change.checkpointID.map { [$0] } ?? []
                )
            }
        }

        return order.compactMap { key in
            guard var change = byPath[key] else { return nil }
            if let stats = lineStatsOverrides[key] {
                change.linesAdded = stats.added
                change.linesRemoved = stats.removed
            }
            change.reviewState = reviewStates[key] ?? .pending
            return change
        }
    }
}
