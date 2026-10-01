import Foundation
import JunoCodeCore

/// The goal tools: `get_goal`, `propose_goal` and `update_goal` (§2.5),
/// which replace `UpdateGoalTool`.
///
/// Owned by Lane A (loop, stop check and goal).
/// Empty in the seams commit (CODE_AGENT_SPEC §6.0): the lane registers its
/// tools here and the session reaches them through `CodeToolProviders`, so no
/// shared file changes when they land.
public struct GoalToolProvider: CodeToolProvider {
    public init() {}

    public func tools(for _: CodeToolProviderContext) async -> [any CodeTool] {
        []
    }
}
