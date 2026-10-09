import SwiftUI

/// The empty state's mark, native: the construction in miniature, drawn in
/// the shared dot matrix. Three orbits at the 1.5 ratio on the number line,
/// and the presence trajectory a quarter of the way round the middle one —
/// the one blue thing in the state. Ported from
/// `src/components/ui/empty-mark.tsx` (geometry) and `editorial.css`
/// (`.empty-mark-dots`: pitch 2.7, strength .8 / .9 dark, floor .5).
///
/// It draws on once, ring by ring, and stops asking for frames; Reduce
/// Motion draws the final frame. Decorative and hidden from assistive
/// technology. Also the loading mark: a loading state that will become an
/// empty or filled list can show it while the first page arrives.
public struct JunoEmptyMark: View {
    public enum Size: Sendable {
        /// 208 × 76, above a page-size empty state's heading.
        case page
        /// 128 × 48, inside a card or a list.
        case panel

        public var frame: CGSize {
            switch self {
            case .page: CGSize(width: 208, height: 76)
            case .panel: CGSize(width: 128, height: 48)
            }
        }
    }

    public static let rings = [
        JunoDotRing(rx: 0.44 / 1.5 / 1.5, ry: 0.42 / 1.5 / 1.5),
        JunoDotRing(rx: 0.44 / 1.5, ry: 0.42 / 1.5),
        JunoDotRing(rx: 0.44, ry: 0.42, faint: true),
    ]
    public static let lines = [JunoDotLine(x1: 0.02, y1: 0.5, x2: 0.98, y2: 0.5, strength: 0.14)]
    public static let arcs = [JunoDotArc(ring: 1, from: -75, to: 25)]

    let size: Size
    @Environment(\.colorScheme) private var scheme

    public init(size: Size = .page) {
        self.size = size
    }

    /// `.empty-mark-dots` over the theme's own style.
    public static func style(for scheme: ColorScheme) -> JunoDotStyle {
        var style = JunoDotStyle.standard(for: scheme).strength(scheme == .dark ? 0.9 : 0.8)
        style.floor = 0.5
        return style
    }

    public var body: some View {
        JunoDotRings(
            rings: Self.rings, lines: Self.lines, arcs: Self.arcs,
            stagger: 0.1, draw: 1.2, delay: 0.1, start: 180,
            pitch: 2.7, style: Self.style(for: scheme)
        )
        .frame(width: size.frame.width, height: size.frame.height)
        .accessibilityHidden(true)
    }
}

#Preview("Empty mark") {
    VStack(spacing: 32) {
        JunoEmptyMark()
        JunoEmptyMark(size: .panel)
    }
    .padding(40)
}
