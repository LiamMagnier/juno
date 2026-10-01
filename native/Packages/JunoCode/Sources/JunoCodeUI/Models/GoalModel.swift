import Foundation
import Observation

/// A session's goal as the reader sees it: the progress row above the
/// composer, the goal sheet and the start card read it, and `/goal` and its
/// subcommands act through it (CODE_AGENT_SPEC §2).
///
/// Owned by Lane A (loop, stop check and goal).
/// Empty in the seams commit (CODE_AGENT_SPEC §6.0): `SessionController` holds
/// one per session from the start, so the lane fills this type without editing
/// the controller.
@MainActor
@Observable
public final class GoalModel {
    public init() {}
}
