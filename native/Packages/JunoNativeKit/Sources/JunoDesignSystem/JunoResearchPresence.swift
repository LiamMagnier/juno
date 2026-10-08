import SwiftUI

/// Research's working indicator: the galaxy (``JunoGalaxyMark``), turning while
/// the run works and holding its still frame otherwise.
///
/// It used to be the Continuum mark passing tone blade by blade — the brand
/// mark doing double duty as a spinner. The owner's direction (2026-10-08)
/// moved every working state to the galaxy and left the Continuum to be the
/// brand. The signature is unchanged so research's call sites swap as they
/// stand; `eventKey` no longer drives anything, because the galaxy's motion is
/// continuous rather than a pass per event.
public struct JunoResearchPresence: View {
    private let active: Bool
    private let size: CGFloat

    public init(active: Bool, eventKey: String, size: CGFloat = 20) {
        self.active = active
        self.size = size
    }

    public var body: some View {
        JunoGalaxyMark(size: size, active: active)
    }
}
