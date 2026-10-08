import SwiftUI

/// The signature dot field, native: a faint grid of dots behind an editorial
/// surface (the web's `components/signature/dot-field.tsx`, used behind the
/// onboarding welcome). One dot every `spacing` points from `spacing / 2`,
/// radius 0.7, the foreground at 5% — so it reads as paper texture, never as
/// a pattern.
///
/// Static: drawn once for its size and redrawn by SwiftUI on every size,
/// scale or appearance change, so it cannot be left at a stale size the way
/// a retained bitmap can. On the Mac it can follow the pointer (`interactive`):
/// dots within 120pt lift toward the account accent (the web's `--primary`).
public struct JunoDotGrid: View {
    let spacing: CGFloat
    let interactive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pointer: CGPoint?

    public init(spacing: CGFloat = 24, interactive: Bool = false) {
        self.spacing = max(4, spacing)
        self.interactive = interactive
    }

    /// The dot centres for a box: the web's two loops, columns then rows.
    public static func points(in size: CGSize, spacing: CGFloat) -> [CGPoint] {
        guard size.width > 0, size.height > 0, spacing > 0 else { return [] }
        var points: [CGPoint] = []
        var x = spacing / 2
        while x < size.width {
            var y = spacing / 2
            while y < size.height {
                points.append(CGPoint(x: x, y: y))
                y += spacing
            }
            x += spacing
        }
        return points
    }

    public var body: some View {
        let pointer = interactive && !reduceMotion ? pointer : nil
        Canvas { context, size in
            var faint = Path()
            for p in Self.points(in: size, spacing: spacing) {
                var t = 0.0
                if let pointer {
                    let d = hypot(p.x - pointer.x, p.y - pointer.y)
                    t = d < 120 ? 1 - d / 120 : 0
                }
                if t > 0.02 {
                    let r = 0.7 + t * 1.9
                    context.fill(
                        Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)),
                        with: .color(Color.junoAccent.opacity(0.18 + t * 0.7))
                    )
                } else {
                    faint.addEllipse(in: CGRect(x: p.x - 0.7, y: p.y - 0.7, width: 1.4, height: 1.4))
                }
            }
            context.fill(faint, with: .color(Color.junoForeground.opacity(0.05)))
        }
        .allowsHitTesting(interactive)
        .onContinuousHover { phase in
            guard interactive else { return }
            switch phase {
            case let .active(location): self.pointer = location
            case .ended: self.pointer = nil
            }
        }
        .accessibilityHidden(true)
    }
}

#Preview("Dot grid") {
    JunoDotGrid(spacing: 26, interactive: true)
        .frame(width: 360, height: 220)
}
