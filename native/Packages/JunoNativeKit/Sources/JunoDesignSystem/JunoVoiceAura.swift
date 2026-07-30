import SwiftUI

/// The voice field: light that runs along the bottom of a voice surface and up
/// its two sides, moving with whoever is talking.
///
/// This is the native half of `src/components/voice/voice-aura.tsx`, and the
/// maths is deliberately the same one — three travelling waves per edge on
/// periods that share no common factor, filled from the edge with a ramp and
/// finished with a bright crest. Matching the numbers is what makes the Mac,
/// the phone and the browser read as one product rather than three takes on an
/// idea.
///
/// It replaces an orb on both platforms. An orb is a thing to look *at* while
/// you talk, which is backwards: in a spoken conversation your attention
/// belongs to the words. Light at the edges reports the same state — is it
/// listening, is it hearing me, is Juno answering — without asking to be
/// watched.
///
/// **Whose voice it is, is the colour.** Your turn is the account's accent;
/// Juno's turn is a hue a little over a third of the way round the wheel from
/// it, derived from the accent rather than fixed so it still pairs when the
/// accent is teal or violet. The two crossfade, because a hard cut on every
/// turn boundary reads as a glitch rather than as an answer beginning.
public struct JunoVoiceAura: View {
    /// Live amplitude, 0…1. `JunoRealtimeVoiceController.level` already smooths
    /// this at 30Hz and already resolves mic against playback, so this view
    /// takes it as given rather than easing it a second time.
    private let level: Double
    /// True while Juno holds the floor.
    private let speaking: Bool
    /// False before the socket is live, or after it closes: the field drops to
    /// its resting hairline rather than disappearing, because a microphone that
    /// is open with nobody talking still has to look different from one that is
    /// not open at all.
    private let active: Bool

    public init(level: Double, speaking: Bool, active: Bool) {
        self.level = level
        self.speaking = speaking
        self.active = active
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    /// Where the crossfade started, and from what. Storing the origin as well
    /// as the moment is what lets a turn that changes again mid-fade continue
    /// from where it actually is instead of snapping back to the other colour.
    @State private var mixOrigin: Double = 0
    @State private var mixStartedAt = Date.distantPast

    private static let crossfade: TimeInterval = 0.4
    /// How far round the wheel Juno's voice sits from yours.
    private static let companionHueShift: Double = 152

    private struct Wave {
        let frequency: Double
        let speed: Double
        let phase: Double
        let weight: Double
        let alpha: Double
    }

    private static let waves: [Wave] = [
        Wave(frequency: 1.1, speed: 0.85, phase: 0, weight: 1, alpha: 0.5),
        Wave(frequency: 1.9, speed: -1.25, phase: 2.1, weight: 0.62, alpha: 0.34),
        Wave(frequency: 3.3, speed: 1.75, phase: 4.3, weight: 0.34, alpha: 0.22),
    ]

    public var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            Canvas(opaque: false) { canvas, size in
                draw(in: canvas, size: size, date: context.date)
            }
            // One blur over the whole field rather than a soft edge per wave:
            // the crests have to survive it, so it is deliberately light.
            .blur(radius: 9)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onChange(of: speaking) { _, _ in
            mixOrigin = mix(at: Date())
            mixStartedAt = Date()
        }
    }

    /// 0 = your voice, 1 = Juno's.
    ///
    /// Seeded from `speaking` rather than from zero, so opening the screen while
    /// Juno is already talking starts in Juno's colour instead of washing the
    /// answer in the listener's and then correcting itself.
    private func mix(at date: Date) -> Double {
        let target: Double = speaking ? 1 : 0
        guard mixStartedAt != .distantPast else { return target }
        let t = min(1, max(0, date.timeIntervalSince(mixStartedAt) / Self.crossfade))
        let eased = t * t * (3 - 2 * t)
        return mixOrigin + (target - mixOrigin) * eased
    }

    private func draw(in canvas: GraphicsContext, size: CGSize, date: Date) {
        guard size.width > 1, size.height > 1 else { return }

        // Phase from absolute time, not from an accumulated counter — the same
        // convention JunoThinkingMatrix uses, and the reason the field is
        // already mid-cycle on its first frame instead of starting flat.
        let clock = reduceMotion ? 0 : date.timeIntervalSinceReferenceDate
        let isDark = colorScheme == .dark
        let amplitude = min(1, max(0, level))
        let floor = active ? (speaking ? 0.14 : 0.07) : 0.02
        let lit = max(floor, amplitude) * (isDark ? 1.35 : 1.15)

        let accent = JunoAccentSelection.shared.current.hsl(dark: isDark)
        let blend = mix(at: date)
        let hue = (accent.h + Self.companionHueShift * blend)
            .truncatingRemainder(dividingBy: 360)
        let saturation = accent.s * (1 - 0.1 * blend)
        let lightness = min(0.92, accent.l + 0.06 * blend)

        func tint(_ alpha: Double) -> Color {
            Color(juno: JunoColorToken(hsl: (h: hue, s: saturation, l: lightness)))
                .opacity(alpha)
        }
        // The crest is the same hue lifted toward the light, so it reads as the
        // bright edge of one body rather than as a second colour.
        func crest(_ alpha: Double) -> Color {
            Color(
                juno: JunoColorToken(
                    hsl: (
                        h: hue,
                        s: min(1, saturation * 1.1),
                        l: min(0.92, lightness + (isDark ? 0.22 : 0.1))
                    )
                )
            )
            .opacity(alpha)
        }

        // Wide dynamic range on purpose: at rest a hairline, and a loud
        // syllable unmistakable from across the room.
        let armReach = min(size.width * 0.15, 96) * (0.2 + 0.8 * lit)
        let bandReach = min(size.height * 0.46, 150) * (0.18 + 0.82 * lit)

        // Bottom: `along` runs left to right, `out` climbs.
        drawEdge(
            in: canvas,
            length: size.width,
            project: { CGPoint(x: $0, y: size.height - $1) },
            reach: bandReach,
            fade: { smoothstep(0, 0.2, $0) * smoothstep(0, 0.2, 1 - $0) },
            gradient: Gradient(colors: [tint(0.34), tint(0.14), tint(0)]),
            gradientFrom: CGPoint(x: size.width / 2, y: size.height),
            gradientTo: CGPoint(x: size.width / 2, y: size.height - bandReach * 1.5),
            crest: crest,
            clock: clock
        )

        // Arms: `along` runs bottom to top, `out` pushes into the surface. They
        // are gone by roughly three-quarters of the way up, so they frame the
        // reading area rather than enclosing it.
        let armFade: (Double) -> Double = { smoothstep(0, 0.5, 0.78 - $0) }
        drawEdge(
            in: canvas,
            length: size.height,
            project: { CGPoint(x: $1, y: size.height - $0) },
            reach: armReach,
            fade: armFade,
            gradient: Gradient(colors: [tint(0.32), tint(0.11), tint(0)]),
            gradientFrom: CGPoint(x: 0, y: size.height / 2),
            gradientTo: CGPoint(x: armReach * 1.6, y: size.height / 2),
            crest: crest,
            clock: clock
        )
        drawEdge(
            in: canvas,
            length: size.height,
            project: { CGPoint(x: size.width - $1, y: size.height - $0) },
            reach: armReach,
            fade: armFade,
            gradient: Gradient(colors: [tint(0.32), tint(0.11), tint(0)]),
            gradientFrom: CGPoint(x: size.width, y: size.height / 2),
            gradientTo: CGPoint(x: size.width - armReach * 1.6, y: size.height / 2),
            crest: crest,
            clock: clock
        )
    }

    /// Fills one edge with the wave stack.
    ///
    /// `project` maps (distance along the edge, height above it) to a point, so
    /// the same maths draws the bottom band and both arms — the arms are the
    /// band stood on end, which is also why they read as one effect.
    private func drawEdge(
        in canvas: GraphicsContext,
        length: Double,
        project: (Double, Double) -> CGPoint,
        reach: Double,
        fade: (Double) -> Double,
        gradient: Gradient,
        gradientFrom: CGPoint,
        gradientTo: CGPoint,
        crest: (Double) -> Color,
        clock: Double
    ) {
        let steps = max(24, min(120, Int(length / 6)))
        for wave in Self.waves {
            var points: [CGPoint] = []
            points.reserveCapacity(steps + 1)
            for index in 0...steps {
                let t = Double(index) / Double(steps)
                let swell = 0.52 + 0.48 * sin(
                    t * wave.frequency * 2 * .pi + wave.phase + clock * wave.speed
                )
                points.append(project(t * length, reach * wave.weight * swell * fade(t)))
            }

            // The body: everything between the edge and the wave, ramped out so
            // the light looks like it is coming from the edge.
            var area = Path()
            area.move(to: project(0, 0))
            for point in points { area.addLine(to: point) }
            area.addLine(to: project(length, 0))
            area.closeSubpath()
            // A copy per layer: `GraphicsContext` is a value type, so setting
            // opacity on a local is both legal and correctly scoped — the crest
            // below must not inherit the body's transparency.
            var body = canvas
            body.opacity = wave.alpha
            body.fill(
                area,
                with: .linearGradient(gradient, startPoint: gradientFrom, endPoint: gradientTo)
            )

            // The crest. Without it the whole effect reads as a lamp: the fill's
            // outer edge is where the ramp has already faded to nothing, so the
            // one part of the shape carrying the motion — the moving boundary —
            // is invisible.
            var curve = Path()
            curve.addLines(points)
            canvas.stroke(
                curve,
                with: .color(crest(wave.alpha * 0.62)),
                style: StrokeStyle(lineWidth: 1.4, lineJoin: .round)
            )
        }
    }

    /// 0 → 1 with the ends eased, so an envelope has no visible corner.
    private func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
        let t = min(1, max(0, (x - edge0) / (edge1 - edge0)))
        return t * t * (3 - 2 * t)
    }
}

/// A live-looking session without a session.
///
/// The aura only exists during a realtime call, which needs a microphone, the
/// relay and someone talking — so without this the only way to look at it is to
/// hold a conversation with it, and the only way to compare "you talking"
/// against "Juno talking" is to take turns. This is the native counterpart of
/// the web's `/dev/voice` gallery.
#Preview("Voice aura") {
    struct Harness: View {
        @State private var level: Double = 0
        @State private var speaking = false
        let start = Date()

        var body: some View {
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSince(start)
                // A jittery envelope rather than a clean sine, so the wide
                // dynamic range is actually exercised.
                let syllable = max(0, sin(t * 5.2))
                let jitter = 0.5 + 0.5 * sin(t * 21)
                let value = min(1, syllable * syllable * (0.55 + 0.45 * jitter))
                VStack(spacing: 0) {
                    Text(speaking ? "Juno is speaking" : "Listening")
                        .font(.title3.weight(.semibold))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    Button(speaking ? "Hand back to you" : "Let Juno answer") {
                        speaking.toggle()
                    }
                    .padding(.bottom, 28)
                }
                .frame(width: 420, height: 460)
                .background(alignment: .bottom) {
                    JunoVoiceAura(level: value, speaking: speaking, active: true)
                        .frame(height: 300)
                }
            }
        }
    }
    return Harness()
}
