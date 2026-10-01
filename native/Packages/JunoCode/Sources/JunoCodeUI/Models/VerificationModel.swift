import Foundation
import Observation

/// A session's verification state: the project's verify recipe and its
/// acceptance card, the checks recorded this run and the run report
/// (CODE_AGENT_SPEC §1.8–§1.10).
///
/// Owned by Lane B (verification, self-review and report).
/// Empty in the seams commit (CODE_AGENT_SPEC §6.0): `SessionController` holds
/// one per session from the start, so the lane fills this type without editing
/// the controller.
@MainActor
@Observable
public final class VerificationModel {
    public init() {}
}
