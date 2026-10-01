import Foundation
import Observation

/// A session's screen control: app grants, the lock, the presence row with
/// Stop and Take over, and the step rows (CODE_AGENT_SPEC §3).
///
/// Owned by Lane C (computer use and Simulator tools).
/// Empty in the seams commit (CODE_AGENT_SPEC §6.0): `SessionController` holds
/// one per session from the start, so the lane fills this type without editing
/// the controller.
@MainActor
@Observable
public final class ScreenControlModel {
    public init() {}
}
