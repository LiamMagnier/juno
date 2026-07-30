import SwiftUI

/* ─────────────────────────────────────────────────────────────────────────────
 * AIcss on Apple platforms.
 *
 * Ported from aicss.dev (Kevin, @kvnkld; Beta V1.2, free tier) — the same blocks
 * the website adopted, so a run reads the same on a phone, a Mac and the web.
 * The library ships plain CSS; what is shared with the web build is therefore not
 * code but the SPECIFICATION: the same geometry, the same easing curves, the same
 * keyframe stops, expressed here in SwiftUI. Where a number appears in both, the
 * web's `.aicss-*` rules in `src/app/globals.css` are the reference.
 *
 * Two things are Juno's rather than AIcss's, in both builds:
 *   - Colours are tokens (`Color.junoMutedForeground`, `.junoHairline`, …), never
 *     the library's literals, so these follow the app's appearance and accent.
 *   - Motion answers Reduce Motion. Everything here says what it means with a
 *     glyph, a number or a state as well as with movement, so stopping the
 *     movement costs nothing.
 * ───────────────────────────────────────────────────────────────────────────── */

/// THE SHINE — one valley of reduced alpha sweeping through text.
///
/// Not a bright band travelling over the words: a *dimmer* patch moving through
/// them, which is what makes it read as breathing rather than as a loading
/// skeleton. A skeleton says "there will be content here"; this says "something
/// is happening now", which is the only claim a thinking label should make.
///
/// The web does it with `background-clip: text` and a 300%-wide gradient whose
/// `background-position` animates from 100% to 0% over 2.25s, holding at each end
/// (0–18% and 82–100% of the cycle). That maths is reproduced exactly below:
/// a gradient three times the text's width puts its valley at 1.5× the width from
/// its own left edge, and a background-position of `p` places that edge at
/// `p × (W − 3W)`. So the valley's centre travels from −0.5W to +1.5W — entering
/// from the left, crossing, and leaving to the right.
///
/// Driven by `TimelineView`, not `withAnimation`, for the same reason
/// `JunoThinkingMatrix` is: the gradient's stops are recomputed from one clock
/// each frame, and SwiftUI cannot interpolate a stop array from a single
/// animatable value. Phase comes from absolute time, so a label that appears
/// mid-run is already in motion rather than starting from a standstill.
public struct JunoAIcssShine: ViewModifier {
    /// Where the text rests: the colour the sweep returns to, and the colour it
    /// settles at.
    private let color: Color
    /// The work is over. The sweep stops; the box and the colour do not change,
    /// so nothing reflows and nothing re-tints at the moment a run completes.
    private let settled: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(color: Color, settled: Bool) {
        self.color = color
        self.settled = settled
    }

    /// 2.25s, from `@keyframes aicss-shine`.
    private static let cycle: Double = 2.25
    /// The holds at each end of the cycle: `0%, 18%` and `82%, 100%`.
    private static let holdIn: Double = 0.18
    private static let holdOut: Double = 0.82
    /// CSS `cubic-bezier(0.25, 0.1, 0.25, 1)` — the `ease` keyword, exactly.
    private static let curve = UnitCurve.bezier(
        startControlPoint: UnitPoint(x: 0.25, y: 0.1),
        endControlPoint: UnitPoint(x: 0.25, y: 1)
    )

    public func body(content: Content) -> some View {
        if settled || reduceMotion {
            content.foregroundStyle(color)
        } else {
            TimelineView(.animation) { context in
                content.foregroundStyle(
                    LinearGradient(
                        stops: Self.stops(
                            at: context.date.timeIntervalSinceReferenceDate,
                            color: color
                        ),
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
            }
        }
    }

    /// The gradient for one instant, in fractions of the text's own width.
    static func stops(at time: TimeInterval, color: Color) -> [Gradient.Stop] {
        let phase = time.truncatingRemainder(dividingBy: cycle) / cycle
        // The two holds are what stop the sweep looking like a metronome: the
        // valley waits off-screen at each end rather than turning around on the
        // edge of the word.
        let travelled = min(max((phase - holdIn) / (holdOut - holdIn), 0), 1)
        let centre = -0.5 + 2.0 * Double(curve.value(at: travelled))

        // From the web's stops: solid to 30%, valley 45–55%, solid from 70% — a
        // 0.15W ramp either side of a 0.10W floor, scaled out of the 3W band.
        let ramp = 0.15
        let floor = 0.05
        let dim = color.opacity(0.45)
        func clamped(_ location: Double) -> Double { min(max(location, 0), 1) }

        return [
            Gradient.Stop(color: color, location: 0),
            Gradient.Stop(color: color, location: clamped(centre - ramp)),
            Gradient.Stop(color: dim, location: clamped(centre - floor)),
            Gradient.Stop(color: dim, location: clamped(centre + floor)),
            Gradient.Stop(color: color, location: clamped(centre + ramp)),
            Gradient.Stop(color: color, location: 1),
        ]
    }
}

public extension View {
    /// Sweep AIcss's shine through this text. See ``JunoAIcssShine``.
    func junoAIcssShine(color: Color = .junoMutedForeground, settled: Bool = false) -> some View {
        modifier(JunoAIcssShine(color: color, settled: settled))
    }
}

/// AIcss "Thinking State" — the shimmering label, at the library's own type size.
///
/// This is what replaced a pulsing `sparkles` glyph on the phone and an opacity
/// breathe on the web. The breathe dimmed the whole sentence, including the part
/// being read; the shine moves a valley *through* text that stays at full weight.
public struct JunoAIcssThinkingLabel: View {
    /// Which token the label rests at. `.strong` for a label that leads a block
    /// (a search, a generation); `.muted` for one that annotates a transcript.
    public enum Tone {
        case muted
        case strong

        var color: Color {
            switch self {
            case .muted: .junoMutedForeground
            case .strong: .primary
            }
        }
    }

    private let text: String
    private let tone: Tone
    private let settled: Bool
    private let size: Double

    public init(_ text: String, tone: Tone = .muted, settled: Bool = false, size: Double = 13) {
        self.text = text
        self.tone = tone
        self.settled = settled
        self.size = size
    }

    public var body: some View {
        Text(text)
            .font(.system(size: size, weight: .medium))
            .monospacedDigit()
            .junoAIcssShine(color: tone.color, settled: settled)
    }
}


#if DEBUG
#Preview("AIcss shine") {
    VStack(alignment: .leading, spacing: 14) {
        JunoAIcssThinkingLabel("Thinking")
        JunoAIcssThinkingLabel("Thinking about your request · 4s")
        JunoAIcssThinkingLabel("Thought for 8.4s", settled: true)
        JunoAIcssThinkingLabel("Generating image", tone: .strong, size: 14)
    }
    .padding(20)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.junoCanvas)
}
#endif
