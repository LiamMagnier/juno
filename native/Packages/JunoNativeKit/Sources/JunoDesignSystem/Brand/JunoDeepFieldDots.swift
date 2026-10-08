import SwiftUI

/// Deep Field's orbits in the dot matrix: the web's `FIELD_RINGS` (three
/// rings at .2 / .33 / .46 of the box, flattened to .94, the outer faint)
/// with a run of dots from the question to every cited source, and a
/// presence run to the page being read now. Ported from
/// `src/components/research/deep-field.tsx` and `research.css`
/// (`.rf-dots`: pitch 3.6, strength .7 / .82 dark).
///
/// Points and labels stay the caller's (they are views, laid out on top);
/// this only draws the ground they sit on. A finished run passes
/// `animate: false` so history never replays its arrival.
public struct JunoDeepFieldDots: View {
    /// A source on the map, in fractions of the box.
    public struct Target: Sendable, Equatable {
        public var x: Double
        public var y: Double
        /// The page being read now: drawn in presence blue.
        public var current: Bool

        public init(x: Double, y: Double, current: Bool = false) {
            self.x = x
            self.y = y
            self.current = current
        }
    }

    public static let centre = (x: 0.5, y: 0.5)
    public static let rings = [0.2, 0.33, 0.46].enumerated().map { k, r in
        JunoDotRing(cx: 0.5, cy: 0.5, rx: r, ry: r * 0.94, faint: k == 2)
    }

    let targets: [Target]
    let animate: Bool
    @Environment(\.colorScheme) private var scheme

    public init(targets: [Target] = [], animate: Bool = true) {
        self.targets = targets
        self.animate = animate
    }

    /// The web's lines: ink at .18 to a cited source, presence at .55 to the current page.
    public static func lines(for targets: [Target]) -> [JunoDotLine] {
        targets.map {
            JunoDotLine(x1: centre.x, y1: centre.y, x2: $0.x, y2: $0.y, presence: $0.current, strength: $0.current ? 0.55 : 0.18)
        }
    }

    public var body: some View {
        JunoDotRings(
            rings: Self.rings,
            lines: Self.lines(for: targets),
            animate: animate,
            pitch: 3.6,
            style: JunoDotStyle.standard(for: scheme).strength(scheme == .dark ? 0.82 : 0.7)
        )
        .accessibilityHidden(true)
    }
}

#Preview("Deep Field dots") {
    JunoDeepFieldDots(targets: [.init(x: 0.7, y: 0.35), .init(x: 0.28, y: 0.62, current: true)])
        .aspectRatio(16.0 / 11.0, contentMode: .fit)
        .frame(width: 420)
        .padding(24)
}
