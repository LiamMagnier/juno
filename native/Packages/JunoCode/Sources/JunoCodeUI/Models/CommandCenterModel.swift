import Foundation
import Observation

/// A session's command centre: the slash-command registry with project and
/// user commands, and the sheets they open (CODE_AGENT_SPEC §5.4).
///
/// Owned by Lane F (commands, hooks, MCP, agents and composer inputs).
/// Empty in the seams commit (CODE_AGENT_SPEC §6.0): `SessionController` holds
/// one per session from the start, so the lane fills this type without editing
/// the controller.
@MainActor
@Observable
public final class CommandCenterModel {
    public init() {}
}
