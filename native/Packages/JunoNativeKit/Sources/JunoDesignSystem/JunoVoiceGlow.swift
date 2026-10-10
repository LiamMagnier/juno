import SwiftUI

/// The voice light: the one light every voice surface draws, on iPhone, iPad
/// and Mac — the composer in a call, dictation, the full-screen call.
///
/// A port of the website's light (`src/components/voice/voice-glow-engine.ts`,
/// `voice-glow-renderer.ts`, `voice-glow-palette.ts`), not a reinterpretation:
/// the same state model, the same timings, the same two inks, the same shape.
///
/// **The light lives on the edge, never over the field.** The surface's own
/// outline takes the speaker's ink where it is lit, a short falloff blooms
/// outward from it, and inside there is nothing but a hairline rim — the
/// words and the controls stay exactly as crisp as at rest. It replaces the
/// old multi-hue band that rose up through the glass (and the orb and aura
/// of the full-screen call), which read as a wash over the composer.
///
/// **State is the light.** Ember while you speak, presence ink while Alevr
/// speaks, one beam handed from your end to Alevr's while it thinks (the
/// Continuum handoff, ember to presence), graphite held still when muted.
/// Each voice follows its own audio, so talking over Alevr shows both, parted
/// toward their own sides. Silence is still: whoever holds the floor keeps a
/// faint, unmoving light, and it never breathes.
///
/// - Reduce Motion: every level is ignored and each state is a static pose,
///   reached by a 120 ms fade.
/// - Reduce Transparency: the lit stretch of the edge, solid and crisp, with
///   no falloff.
///
/// Decorative to assistive technology: the host says each state in words.
public struct JunoVoiceGlow: View {
    private let mode: JunoVoiceGlowMode
    private let you: () -> Double
    private let alevr: () -> Double
    private let cornerRadius: CGFloat
    private let margin: CGFloat

    /// - Parameters:
    ///   - mode: Who holds the floor (see ``JunoVoiceGlowMode``).
    ///   - you: Your microphone, 0...1 on the speech-loudness window
    ///     (``RealtimeLoudness``: -52...-12 dBFS), read once per frame.
    ///   - alevr: Alevr's voice as heard, the same scale.
    ///   - cornerRadius: The surface's radius. A circle passes half its side.
    ///   - margin: How far outside the surface the light may reach.
    public init(
        mode: JunoVoiceGlowMode,
        you: @escaping () -> Double,
        alevr: @escaping () -> Double = { 0 },
        cornerRadius: CGFloat,
        margin: CGFloat = JunoVoiceGlowRenderer.margin
    ) {
        self.mode = mode
        self.you = you
        self.alevr = alevr
        self.cornerRadius = cornerRadius
        self.margin = margin
    }

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    /// The light's memory. A reference, not state: it moves every frame and
    /// nothing but the canvas reads it.
    @State private var engine = JunoVoiceGlowEngine()

    public var body: some View {
        TimelineView(.animation(minimumInterval: reduceMotion ? 1.0 / 30 : nil)) { timeline in
            Canvas(opaque: false, rendersAsynchronously: true) { context, size in
                let frame = engine.step(
                    to: timeline.date,
                    input: JunoVoiceGlowInput(
                        mode: mode,
                        you: mode == .off ? 0 : you(),
                        alevr: mode == .off ? 0 : alevr(),
                        reduced: reduceMotion
                    )
                )
                let rect = CGRect(
                    x: margin, y: margin,
                    width: max(0, size.width - margin * 2),
                    height: max(0, size.height - margin * 2)
                )
                JunoVoiceGlowRenderer(
                    palette: colorScheme == .dark ? .dark : .light,
                    solid: reduceTransparency
                )
                .draw(frame, in: &context, rect: rect, radius: cornerRadius)
            }
        }
        .padding(-margin)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

extension View {
    /// Lays the voice light on this view's edge. The view must be the
    /// surface (the composer card, the call disc) and `cornerRadius` its own.
    public func junoVoiceGlow(
        _ mode: JunoVoiceGlowMode,
        you: @escaping () -> Double,
        alevr: @escaping () -> Double = { 0 },
        cornerRadius: CGFloat
    ) -> some View {
        overlay {
            JunoVoiceGlow(mode: mode, you: you, alevr: alevr, cornerRadius: cornerRadius)
        }
    }
}

/// Who holds the floor: the web's `GlowMode`.
public enum JunoVoiceGlowMode: Equatable, Sendable {
    /// You are speaking, or it is your turn. Ember.
    case you
    /// Alevr is speaking. Presence ink.
    case alevr
    /// The gap between your turn and Alevr's: the handoff beam.
    case thinking
    /// The microphone is off. Graphite, held still.
    case muted
    /// Connecting, reconnecting, ended, a closing dictation: no light.
    case off
}

// MARK: - Palette

/// The web's `GLOW_PALETTE`, kept as hex so parity is a string compare.
///
/// Alevr is presence ink, the brand's one live colour; you are ember, a burnt
/// orange chosen opposite it (OKLCH hue 50, between danger's red and
/// attention's amber), matched in chroma so the two voices weigh the same.
/// `line` paints the edge, `glow` the falloff outside it, `hot` the core of a
/// lit edge at a peak on charcoal (on ivory a peak is deeper, never whiter).
public struct JunoVoiceGlowPalette: Equatable, Sendable {
    public struct Voice: Equatable, Sendable {
        public let line: String
        public let glow: String
        public let hot: String
    }

    public let you: Voice
    public let alevr: Voice
    public let muted: String
    public let dark: Bool

    public static let light = JunoVoiceGlowPalette(
        you: Voice(line: "#bc5806", glow: "#f69147", hot: "#bc5806"),
        alevr: Voice(line: "#2d49c9", glow: "#6782f2", hot: "#2d49c9"),
        muted: "#9a9ca0",
        dark: false
    )

    public static let dark = JunoVoiceGlowPalette(
        you: Voice(line: "#f3a26b", glow: "#fba962", hot: "#fdcfa6"),
        alevr: Voice(line: "#97a6e6", glow: "#90a6f7", hot: "#ced7fb"),
        muted: "#84868a",
        dark: true
    )
}

/// One colour as sRGB components, so the hot-core mix is arithmetic.
struct JunoVoiceGlowRGB: Equatable {
    var red: Double
    var green: Double
    var blue: Double

    init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    init(hex: String) {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let value = digits.count == 6 ? UInt32(digits, radix: 16) ?? 0 : 0
        red = Double((value >> 16) & 0xFF) / 255
        green = Double((value >> 8) & 0xFF) / 255
        blue = Double(value & 0xFF) / 255
    }

    func mixed(with other: JunoVoiceGlowRGB, _ t: Double) -> JunoVoiceGlowRGB {
        JunoVoiceGlowRGB(
            red: red + (other.red - red) * t,
            green: green + (other.green - green) * t,
            blue: blue + (other.blue - blue) * t
        )
    }

    var color: Color { Color(.sRGB, red: red, green: green, blue: blue) }
}

// MARK: - State model

/// What one frame is given.
public struct JunoVoiceGlowInput: Equatable, Sendable {
    public var mode: JunoVoiceGlowMode
    public var you: Double
    public var alevr: Double
    public var reduced: Bool

    public init(mode: JunoVoiceGlowMode, you: Double, alevr: Double, reduced: Bool) {
        self.mode = mode
        self.you = you
        self.alevr = alevr
        self.reduced = reduced
    }
}

/// What the renderer draws: the web's `GlowFrame`.
public struct JunoVoiceGlowFrame: Equatable, Sendable {
    public struct Voice: Equatable, Sendable {
        /// 0...1 brightness.
        public var amp: Double
        /// 0...1 spread and bloom, from the voice's own envelope.
        public var lift: Double
    }

    public struct Beam: Equatable, Sendable {
        public var amp: Double
        /// 0 = your end of the edge, 1 = Alevr's end.
        public var pos: Double
        /// 0 = ember, 1 = presence.
        public var mix: Double
    }

    public var you: Voice
    public var alevr: Voice
    public var muted: Double
    public var beams: [Beam]

    /// Nothing lit: the canvas is left empty.
    public var isDark: Bool {
        you.amp < 1e-3 && alevr.amp < 1e-3 && muted < 1e-3
            && beams.allSatisfy { $0.amp < 1e-3 }
    }
}

/// The web's `voice-glow-engine.ts`, line for line. Pure: a frame is a function
/// of the previous state, the input and the time step, so tests can drive any
/// moment exactly.
public struct JunoVoiceGlowState: Equatable, Sendable {
    /// Brightness envelopes: they follow the syllables.
    var envYou = 0.0
    var envAlevr = 0.0
    /// Extent envelopes: slower, they follow the phrase.
    var liftYou = 0.0
    var liftAlevr = 0.0
    /// Rest weights: who holds the floor, muted, thinking.
    var wYou = 0.0
    var wAlevr = 0.0
    var wMuted = 0.0
    var wThink = 0.0
    /// The whole light's presence: 0 when off.
    var on = 0.0
    /// Seconds spent in the current thinking spell; -1 outside one.
    var thinkT = -1.0

    public init() {}

    /// V3 timings and the Continuum handoff, in seconds.
    public enum Timing {
        public static let fast = 0.12
        public static let base = 0.22
        public static let slow = 0.36
        public static let exit = 0.16
        public static let handoffTone = 0.22
        public static let handoffStagger = 0.07
        public static let handoffSegments = 6.0
        public static let repass = 1.6
        /// One pass end to end: the last segment starts 5 × 70 ms in.
        public static let handoffPass = (handoffSegments - 1) * handoffStagger + handoffTone
    }

    /// The still light whoever holds the floor keeps while silent.
    public static let restAmp = 0.3
    static let mutedAmp = 0.55
    static let beamRest = 0.42
    static let staticAmp = 0.62
    static let staticLift = 0.28

    /// Speech loudness to light: below the floor is a room, not a voice, and
    /// a soft knee lets a word's onset rise rather than switch on.
    public static func gate(_ raw: Double) -> Double {
        let floor = 0.16, ceil = 0.84, knee = 0.08
        guard raw > floor else { return 0 }
        let x = raw - floor
        let span = ceil - floor
        let y = x < knee ? (x * x) / (2 * knee) : x - knee / 2
        return min(1, y / (span - knee / 2))
    }

    /// Exponential approach landing on the target within `duration`.
    static func approach(_ value: Double, _ target: Double, _ dt: Double, _ duration: Double) -> Double {
        guard duration > 0 else { return target }
        let next = target + (value - target) * exp(-3 * dt / duration)
        return abs(next - target) < 1e-3 ? target : next
    }

    /// Fast attack, slower release, snapped to exactly 0 in silence.
    static func envelope(
        _ value: Double, _ target: Double, _ dt: Double,
        attack: Double = 0.045, release: Double = 0.15
    ) -> Double {
        let tau = target > value ? attack : release
        let next = target + (value - target) * exp(-dt / tau)
        if target == 0, next < 0.004 { return 0 }
        return abs(next - target) < 1e-4 ? target : next
    }

    /// One step. `dt` in seconds, clamped to 0.1.
    public mutating func step(_ input: JunoVoiceGlowInput, dt rawDT: Double) {
        let dt = min(max(rawDT, 0), 0.1)
        let mode = input.mode
        let reduced = input.reduced
        let fade = reduced ? Timing.fast : Timing.base

        on = Self.approach(
            on, mode == .off ? 0 : 1, dt,
            mode == .off ? Timing.exit : (reduced ? Timing.fast : Timing.slow)
        )
        wYou = Self.approach(wYou, mode == .you ? 1 : 0, dt, fade)
        wAlevr = Self.approach(wAlevr, mode == .alevr ? 1 : 0, dt, fade)
        wMuted = Self.approach(wMuted, mode == .muted ? 1 : 0, dt, fade)
        wThink = Self.approach(wThink, mode == .thinking ? 1 : 0, dt, fade)

        let youTarget = reduced || mode == .muted || mode == .off ? 0 : Self.gate(input.you)
        let alevrTarget = reduced || mode == .off ? 0 : Self.gate(input.alevr)
        envYou = Self.envelope(envYou, youTarget, dt)
        envAlevr = Self.envelope(envAlevr, alevrTarget, dt)
        liftYou = Self.envelope(liftYou, youTarget, dt, attack: 0.08, release: 0.3)
        liftAlevr = Self.envelope(liftAlevr, alevrTarget, dt, attack: 0.08, release: 0.3)

        if mode == .thinking {
            thinkT = thinkT < 0 ? 0 : thinkT + dt
        } else if wThink == 0 {
            thinkT = -1
        } else if thinkT >= 0 {
            thinkT += dt
        }
    }

    private static func voice(
        rest: Double, env: Double, lift: Double, on: Double, reduced: Bool
    ) -> JunoVoiceGlowFrame.Voice {
        if reduced { return .init(amp: on * rest * staticAmp, lift: rest * staticLift) }
        let restLight = restAmp * rest
        let shaped = env > 0 ? pow(env, 0.8) : 0
        return .init(amp: on * (restLight + (1 - restLight) * shaped), lift: lift)
    }

    /// The beams of a thinking spell `t` seconds in: the pass under way, and
    /// the previous one resting at Alevr's end, fading as the next leaves.
    public static func handoffBeams(_ t: Double) -> [JunoVoiceGlowFrame.Beam] {
        let cycle = (t / Timing.repass).rounded(.down)
        let u = t - cycle * Timing.repass
        let travel = min(1, u / Timing.handoffPass)
        let pos = JunoVoiceGlowCurve.easeInOut(travel)
        let mix = JunoVoiceGlowCurve.easeOutSoft(
            min(1, max(0, (u - Timing.handoffStagger) / Timing.handoffTone))
        )
        let amp: Double
        if u < Timing.handoffTone {
            amp = JunoVoiceGlowCurve.easeOutSoft(u / Timing.handoffTone)
        } else if u < Timing.handoffPass {
            amp = 1
        } else {
            amp = 1 - (1 - beamRest) * JunoVoiceGlowCurve.easeOutSoft(
                min(1, (u - Timing.handoffPass) / Timing.slow)
            )
        }
        let previous: JunoVoiceGlowFrame.Beam = cycle > 0
            ? .init(
                amp: beamRest * (1 - JunoVoiceGlowCurve.easeOutSoft(min(1, u / Timing.handoffTone))),
                pos: 1, mix: 1
            )
            : .init(amp: 0, pos: 1, mix: 1)
        return [.init(amp: amp, pos: pos, mix: mix), previous]
    }

    /// The frame the renderer draws.
    public func frame(reduced: Bool) -> JunoVoiceGlowFrame {
        let you = Self.voice(rest: wYou, env: envYou, lift: liftYou, on: on, reduced: reduced)
        let alevr = Self.voice(rest: wAlevr, env: envAlevr, lift: liftAlevr, on: on, reduced: reduced)
        let beams: [JunoVoiceGlowFrame.Beam]
        if wThink == 0 {
            beams = [.init(amp: 0, pos: 0, mix: 0), .init(amp: 0, pos: 1, mix: 1)]
        } else if reduced {
            let a = on * wThink * Self.beamRest
            beams = [.init(amp: a, pos: 0, mix: 0), .init(amp: a, pos: 1, mix: 1)]
        } else {
            let k = on * wThink
            beams = Self.handoffBeams(max(0, thinkT)).map {
                .init(amp: $0.amp * k, pos: $0.pos, mix: $0.mix)
            }
        }
        return JunoVoiceGlowFrame(
            you: you, alevr: alevr, muted: on * wMuted * Self.mutedAmp, beams: beams
        )
    }

    /// Runs from silence for `seconds` at 60 Hz: a deterministic still, the
    /// same picture every time (snapshots, previews).
    public static func simulated(
        seconds: Double,
        _ input: (Double) -> JunoVoiceGlowInput
    ) -> JunoVoiceGlowState {
        var state = JunoVoiceGlowState()
        let step = 1.0 / 60
        var t = step
        while t <= seconds + 1e-6 {
            state.step(input(t), dt: step)
            t += step
        }
        return state
    }
}

/// The shell's motion curves, as functions of progress.
enum JunoVoiceGlowCurve {
    /// A CSS `cubic-bezier(x1, y1, x2, y2)`.
    static func cubicBezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> @Sendable (Double) -> Double {
        let ax = 3 * x1 - 3 * x2 + 1, bx = 3 * x2 - 6 * x1, cx = 3 * x1
        let ay = 3 * y1 - 3 * y2 + 1, by = 3 * y2 - 6 * y1, cy = 3 * y1
        return { t in
            if t <= 0 { return 0 }
            if t >= 1 { return 1 }
            var u = t
            for _ in 0..<6 {
                let x = ((ax * u + bx) * u + cx) * u - t
                let slope = (3 * ax * u + 2 * bx) * u + cx
                if abs(x) < 1e-5 || abs(slope) < 1e-6 { break }
                u -= x / slope
            }
            u = min(1, max(0, u))
            return ((ay * u + by) * u + cy) * u
        }
    }

    /// `--ease-out-soft` and `--ease-in-out`.
    static let easeOutSoft = cubicBezier(0.33, 1, 0.68, 1)
    static let easeInOut = cubicBezier(0.65, 0, 0.35, 1)
}

/// The state and its clock, held by a view across frames.
@MainActor
public final class JunoVoiceGlowEngine {
    public private(set) var state = JunoVoiceGlowState()
    private var lastDate: Date?

    public init() {}

    public func step(to date: Date, input: JunoVoiceGlowInput) -> JunoVoiceGlowFrame {
        let dt = lastDate.map { date.timeIntervalSince($0) } ?? (1.0 / 60)
        lastDate = date
        state.step(input, dt: dt)
        return state.frame(reduced: input.reduced)
    }
}

// MARK: - Renderer

/// Draws a frame around a rounded rectangle: a 1px tone on the edge, a short
/// falloff outside it, and a hairline rim inside. The web draws the same thing
/// with a distance field; here the outline is walked by arc length, so the
/// light hugs the corners exactly the same way.
public struct JunoVoiceGlowRenderer {
    /// How far outside the surface the light may reach.
    public static let margin: CGFloat = 32

    let palette: JunoVoiceGlowPalette
    let solid: Bool

    public init(palette: JunoVoiceGlowPalette, solid: Bool = false) {
        self.palette = palette
        self.solid = solid
    }

    private struct Light {
        var amp: Double
        /// Brightness along the outline at signed arc length `s`.
        var along: (Double) -> Double
        /// Falloff length outside the edge, in points.
        var falloff: Double
        var line: JunoVoiceGlowRGB
        var glow: JunoVoiceGlowRGB
        var hot: JunoVoiceGlowRGB
        var haloK: Double
        var lineK: Double
    }

    public func draw(
        _ frame: JunoVoiceGlowFrame,
        in context: inout GraphicsContext,
        rect: CGRect,
        radius: CGFloat
    ) {
        guard !frame.isDark, rect.width > 2, rect.height > 2 else { return }
        let outline = JunoVoiceGlowOutline(rect: rect, radius: radius)
        let width = Double(rect.width)
        let dark = palette.dark
        let haloK = dark ? 0.6 : 0.5
        let lineK = dark ? 1.0 : 0.92
        let f0 = dark ? 3.0 : 2.5
        let f1 = dark ? 11.0 : 10.0

        let you = rgb(palette.you)
        let alevr = rgb(palette.alevr)
        let muted = JunoVoiceGlowRGB(hex: palette.muted)

        // One voice is centred; two at once part toward their own sides.
        let both = smoothstep(0.04, 0.3, min(frame.you.amp, frame.alevr.amp))
        let aYou = both * 0.21 * width
        let aAlevr = -aYou
        let sMuted = 0.32 * width
        let sAlevr = width * (0.08 + 0.30 * frame.alevr.lift)
        let sYou = width * (0.08 + 0.30 * frame.you.lift)
        let beamFrom = outline.straightHalf
        let beamTo = -outline.straightHalf
        let beamWidth = max(0.075 * width, 20)

        var lights: [Light] = [
            Light(
                amp: frame.muted, along: { gauss($0 / sMuted) }, falloff: 3,
                line: muted, glow: muted, hot: muted, haloK: 0.18, lineK: 0.9
            ),
            Light(
                amp: frame.alevr.amp, along: { gauss(($0 - aAlevr) / sAlevr) },
                falloff: f0 + f1 * frame.alevr.lift,
                line: alevr.line, glow: alevr.glow, hot: alevr.hot, haloK: haloK, lineK: lineK
            ),
            Light(
                amp: frame.you.amp, along: { gauss(($0 - aYou) / sYou) },
                falloff: f0 + f1 * frame.you.lift,
                line: you.line, glow: you.glow, hot: you.hot, haloK: haloK, lineK: lineK
            ),
        ]
        // The previous beam first, the travelling one over it. Ember trails
        // the presence head by a beam's width, so the handoff reads as one
        // light passing to the next rather than two mixing.
        for beam in frame.beams.reversed() {
            let head = beamFrom + (beamTo - beamFrom) * beam.pos
            let tail = beamFrom + (beamTo - beamFrom) * max(beam.pos - 0.12, 0)
            lights.append(Light(
                amp: beam.amp * (1 - beam.mix), along: { gauss(($0 - tail) / beamWidth) },
                falloff: f0 + 0.4 * f1,
                line: you.line, glow: you.glow, hot: you.hot, haloK: haloK, lineK: lineK
            ))
            lights.append(Light(
                amp: beam.amp * beam.mix, along: { gauss(($0 - head) / beamWidth) },
                falloff: f0 + 0.4 * f1,
                line: alevr.line, glow: alevr.glow, hot: alevr.hot, haloK: haloK, lineK: lineK
            ))
        }

        let segments = outline.segments()
        for light in lights where light.amp > 0.0005 {
            draw(light, segments: segments, outline: outline, in: &context)
        }
    }

    private func draw(
        _ light: Light,
        segments: [JunoVoiceGlowOutline.Segment],
        outline: JunoVoiceGlowOutline,
        in context: inout GraphicsContext
    ) {
        let lit: [(segment: JunoVoiceGlowOutline.Segment, k: Double)] = segments.compactMap {
            let k = light.amp * light.along($0.arc)
            return k > 0.003 ? ($0, k) : nil
        }
        guard !lit.isEmpty else { return }
        let dark = palette.dark

        if solid {
            // Reduced transparency: the lit stretch of the edge, solid.
            for (segment, k) in lit where k >= 0.32 {
                context.stroke(segment.inner, with: .color(light.line.color), lineWidth: 1)
            }
            return
        }

        let blend: GraphicsContext.BlendMode = dark ? .plusLighter : .normal

        // The falloff, outside the edge only: a tight core that reads as the
        // edge emitting, and a wider shoulder that reads as light in the air.
        context.drawLayer { layer in
            layer.clip(to: outline.outside, style: FillStyle(eoFill: true))
            layer.blendMode = blend
            layer.drawLayer { core in
                core.addFilter(.blur(radius: light.falloff * 0.75))
                for (segment, k) in lit {
                    core.stroke(
                        segment.path,
                        with: .color(light.glow.color.opacity(min(1, k * light.haloK * 0.9))),
                        style: StrokeStyle(lineWidth: light.falloff * 1.6, lineCap: .round)
                    )
                }
            }
            layer.drawLayer { shoulder in
                shoulder.addFilter(.blur(radius: light.falloff * 1.9))
                for (segment, k) in lit {
                    shoulder.stroke(
                        segment.path,
                        with: .color(light.glow.color.opacity(min(1, k * light.haloK * 0.4))),
                        style: StrokeStyle(lineWidth: light.falloff * 3, lineCap: .round)
                    )
                }
            }
        }

        // The rim: a hairline of light just inside, never a haze.
        context.drawLayer { layer in
            layer.clip(to: outline.shape)
            layer.blendMode = blend
            layer.addFilter(.blur(radius: 1.5))
            for (segment, k) in lit {
                layer.stroke(
                    segment.path,
                    with: .color(light.glow.color.opacity(min(1, k * (dark ? 0.32 : 0.26)))),
                    style: StrokeStyle(lineWidth: 5, lineCap: .round)
                )
            }
        }

        // The edge itself, 1pt, on the border band. A peak on charcoal runs
        // hot; on ivory it only deepens.
        context.drawLayer { layer in
            layer.blendMode = blend
            for (segment, k) in lit {
                let hot = dark ? smoothstep(0.5, 1, k) : 0
                let ink = light.line.mixed(with: light.hot, hot * 0.8)
                layer.stroke(
                    segment.inner,
                    with: .color(ink.color.opacity(min(1, k * light.lineK))),
                    style: StrokeStyle(lineWidth: 1, lineCap: .butt)
                )
            }
        }
    }

    private func rgb(_ voice: JunoVoiceGlowPalette.Voice) -> (line: JunoVoiceGlowRGB, glow: JunoVoiceGlowRGB, hot: JunoVoiceGlowRGB) {
        (JunoVoiceGlowRGB(hex: voice.line), JunoVoiceGlowRGB(hex: voice.glow), JunoVoiceGlowRGB(hex: voice.hot))
    }
}

/// The surface's outline, walked from the bottom centre: right is positive arc
/// length, left negative, so a light can be placed and spread by distance
/// along the edge the way the web's `arcPos` does.
struct JunoVoiceGlowOutline {
    struct Segment {
        /// Signed arc length at the segment's middle.
        let arc: Double
        /// On the outline.
        let path: Path
        /// Half a point inside: the 1pt border band.
        let inner: Path
    }

    let rect: CGRect
    let radius: CGFloat

    init(rect: CGRect, radius: CGFloat) {
        self.rect = rect
        self.radius = min(radius, rect.width / 2, rect.height / 2)
    }

    /// From the bottom centre to where the bottom edge meets its corner.
    var straightHalf: Double { Double(rect.width / 2 - radius) }

    var halfLength: Double {
        let hx = Double(rect.width / 2 - radius)
        let hy = Double(rect.height / 2 - radius)
        return 2 * hx + 2 * hy + .pi * Double(radius)
    }

    var shape: Path {
        Path(roundedRect: rect, cornerRadius: radius, style: .circular)
    }

    /// Everything outside the surface, as an even-odd clip.
    var outside: Path {
        var path = Path(rect.insetBy(dx: -200, dy: -200))
        path.addPath(shape)
        return path
    }

    /// One half of the outline, bottom centre to top centre, on `side` (+1
    /// right, -1 left), inset by `inset`.
    func half(side: CGFloat, inset: CGFloat) -> Path {
        let r = max(0, radius - inset)
        let box = rect.insetBy(dx: inset, dy: inset)
        let mid = box.midX
        let edgeX = side > 0 ? box.maxX : box.minX
        let cornerX = edgeX - side * r
        var path = Path()
        path.move(to: CGPoint(x: mid, y: box.maxY))
        path.addLine(to: CGPoint(x: cornerX, y: box.maxY))
        path.addArc(
            center: CGPoint(x: cornerX, y: box.maxY - r), radius: r,
            startAngle: .degrees(90), endAngle: .degrees(side > 0 ? 0 : 180),
            clockwise: side > 0
        )
        path.addLine(to: CGPoint(x: edgeX, y: box.minY + r))
        path.addArc(
            center: CGPoint(x: cornerX, y: box.minY + r), radius: r,
            startAngle: .degrees(side > 0 ? 0 : 180), endAngle: .degrees(270),
            clockwise: side > 0
        )
        path.addLine(to: CGPoint(x: mid, y: box.minY))
        return path
    }

    /// The outline cut into short pieces, each tagged with where it sits.
    func segments() -> [Segment] {
        let length = halfLength
        guard length > 0 else { return [] }
        // About one piece per 5pt: fine enough that a gaussian a beam wide
        // reads as smooth, coarse enough to stay cheap per frame.
        let count = max(24, min(160, Int(length / 5)))
        var result: [Segment] = []
        result.reserveCapacity(count * 2)
        for side in [CGFloat(1), -1] {
            let outer = half(side: side, inset: 0)
            let inner = half(side: side, inset: 0.5)
            for index in 0..<count {
                let from = CGFloat(index) / CGFloat(count)
                let to = CGFloat(index + 1) / CGFloat(count)
                let arc = (Double(index) + 0.5) / Double(count) * length * Double(side)
                result.append(Segment(
                    arc: arc,
                    path: outer.trimmedPath(from: from, to: to),
                    inner: inner.trimmedPath(from: from, to: to)
                ))
            }
        }
        return result
    }
}

private func gauss(_ x: Double) -> Double { exp(-x * x) }

private func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
    let t = min(1, max(0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
}
