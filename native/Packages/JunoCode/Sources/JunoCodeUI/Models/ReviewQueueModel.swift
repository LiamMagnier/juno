import Foundation
import Observation

/// The reader's review queue for a session: line comments waiting to be
/// sent, the reviewer's findings shown in the diff, and the CI bar
/// (CODE_AGENT_SPEC §5.10, §5.3). Held as `SessionController.reviewQueue`;
/// `SessionController.review` is the older document-review state.
///
/// Owned by Lane E (review, ship, sessions and away).
/// Empty in the seams commit (CODE_AGENT_SPEC §6.0): `SessionController` holds
/// one per session from the start, so the lane fills this type without editing
/// the controller.
@MainActor
@Observable
public final class ReviewQueueModel {
    public init() {}
}
