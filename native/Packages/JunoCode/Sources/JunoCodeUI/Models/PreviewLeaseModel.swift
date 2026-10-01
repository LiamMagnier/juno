import Foundation
import Observation

/// The session's lease on its Preview: the dev server it owns, which keeps
/// running across session switches, and the page the agent drives
/// (CODE_AGENT_SPEC §4.1).
///
/// Owned by Lane D (Preview and browser).
/// Empty in the seams commit (CODE_AGENT_SPEC §6.0): `SessionController` holds
/// one per session from the start, so the lane fills this type without editing
/// the controller.
@MainActor
@Observable
public final class PreviewLeaseModel {
    public init() {}
}
