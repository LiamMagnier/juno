import SwiftUI

/// Juno's thinking mark: a compact 3×3 matrix of points with one brighter point
/// travelling through it.
///
/// This is the *brand's* waiting signal, ported from the web's `ThinkingDots`
/// (`src/components/signature/thinking-dots.tsx`) — the same grid, the same
/// clockwise-then-centre path, the same 1.8s cycle and the same four-stop fade.
/// It replaces a pulsing `sparkles` glyph, which was a stock SF Symbol saying
/// "AI" rather than anything about Juno, and which drew the eye harder than the
/// sentence beside it.
///
/// Nine quiet points establish the mark and hold the footprint constant, so the
/// row never reflows while the animation runs. The resting points take the
/// ambient `foregroundStyle`; the travelling point is always full-contrast, as on
/// the web.
///
/// **Driven by `TimelineView`, not `withAnimation`.** The per-point opacity is a
/// four-stop curve derived from one clock — not something SwiftUI can interpolate
/// from a single animatable value — so the clock has to tick. Phase comes from
/// absolute time rather than from a mount date, which is what makes the matrix
/// already alive on its first frame instead of starting from a dark grid.
///
/// Under Reduce Motion the clock is paused and the centre point stays
/// emphasised: the mark still reads as "working" with nothing in motion.
public struct JunoThinkingMatrix: View {
    /// Clockwise around the perimeter, then through the centre. Staggered starts
    /// overlap slightly, so the bright point leaves a soft trail rather than the
    /// grid blinking nine separate times.
    private static let sequence = [0, 1, 2, 5, 8, 7, 6, 3, 4]
    private static let cycle: Double = 1.8

    private let dot: Double
    private let spacing: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - dot: the diameter of one point.
    ///   - spacing: the gap between points. The mark is `3 × dot + 2 × spacing`
    ///     on a side — 18pt at the defaults, matching the web's `h-[18px]`.
    public init(dot: Double = 4, spacing: Double = 3) {
        self.dot = dot
        self.spacing = spacing
    }

    public var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let phase = reduceMotion
                ? nil
                : context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: Self.cycle) / Self.cycle

            Grid(horizontalSpacing: spacing, verticalSpacing: spacing) {
                ForEach(0..<3, id: \.self) { row in
                    GridRow {
                        ForEach(0..<3, id: \.self) { column in
                            point(at: row * 3 + column, phase: phase)
                        }
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func point(at index: Int, phase: Double?) -> some View {
        Circle()
            // Was `.fill(.tertiary)`: a pure-neutral platform fill on a warm
            // canvas, next to an active dot that is now warm ink. The pair has
            // to agree or the grid reads as two greys.
            .fill(Color.junoForeground.opacity(0.25))
            .frame(width: dot, height: dot)
            .overlay {
                Circle()
                    .fill(Color.junoForeground)
                    .opacity(brightness(at: index, phase: phase))
            }
    }

    /// The travelling point's opacity for one cell, from the web's
    /// `thinking-matrix` keyframes: 0 → 0.28 at 8% → 0.95 at 15% → 0 at 30%, dark
    /// for the rest of the cycle. Cells enter in `sequence` order, one ninth of a
    /// cycle apart.
    private func brightness(at index: Int, phase: Double?) -> Double {
        guard let phase else { return index == 4 ? 0.9 : 0 }
        guard let step = Self.sequence.firstIndex(of: index) else { return 0 }
        let offset = (phase - Double(step) / 9).truncatingRemainder(dividingBy: 1)
        let t = offset < 0 ? offset + 1 : offset

        switch t {
        case ..<0.08: return lerp(0, 0.28, t / 0.08)
        case ..<0.15: return lerp(0.28, 0.95, (t - 0.08) / 0.07)
        case ..<0.30: return lerp(0.95, 0, (t - 0.15) / 0.15)
        default: return 0
        }
    }

    private func lerp(_ from: Double, _ to: Double, _ t: Double) -> Double {
        from + (to - from) * min(max(t, 0), 1)
    }
}

#if DEBUG
#Preview("Thinking matrix") {
    HStack(spacing: 20) {
        JunoThinkingMatrix()
        JunoThinkingMatrix(dot: 6, spacing: 4)
            .junoSecondaryInk()
    }
    .padding()
}
#endif
