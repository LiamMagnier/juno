import SwiftUI

/// Juno's voice glow: the one light a voice call draws, and the call's status.
///
/// The native half of the web's `JunoVoiceGlow`
/// (`src/components/voice/voice-composer-glow.tsx`, over Libraries.dev's
/// `voice-glow`): a soft band of colour along the bottom edge of the composer
/// that rises and blooms with the voice, and, while the reply is being thought
/// through, gathers into one beam that travels side to side. The host clips it
/// to its own shape (the composer's `ContainerRelativeShape`), so the light
/// follows the shell's corners exactly and never spills onto the page.
///
/// **The glow is the status.** There is no meter and no phase label beside it:
/// whose turn it is, is the colour, and what is happening, is the motion.
/// - ``JunoVoiceGlowTone/caller``: you talking or listening. The warm dawn
///   hues (apricot, gold, clay, rose), rising with your level.
/// - ``JunoVoiceGlowTone/juno``: Juno speaking. The cool dusk hues (sky,
///   teal, sage, periwinkle), rising with Juno's level.
/// - ``JunoVoiceGlowTone/mixed`` with `processing`: thinking. The whole palette
///   gathered into one beam travelling side to side, not level-driven.
/// - ``JunoVoiceGlowTone/muted``: a still, low, grey band.
/// - `paused` (connecting, ended): held still and low.
/// A change of tone cross-fades over the slow rung (`--dur-slow`), and keeps
/// that fade under Reduce Motion: it is a change of colour, not travel.
///
/// **What it is not.** Not glass and not a material: it is light drawn over
/// the shell, like the border beam. No aura, no wash of the window.
///
/// - INPUT. `level` is a getter, read once per frame by the timeline, never
///   state: at display rate, state would re-render the composer to move light.
///   `bands`, when the host can measure them, makes the light articulate: the
///   centre lobe follows the lows, its neighbours the mids, the outer pair the
///   highs, so a vowel swells the middle and an "s" flicks the edges — the
///   motion follows the words, not a volume knob. Without them the lobes are
///   synthesised from the level, as before.
/// - REDUCE MOTION. A still, low band that brightens with the level. No flow,
///   no travel, no breathing.
/// - REDUCE TRANSPARENCY. The same band, quieter and without additive light.
///
/// Decorative to assistive technology: the host announces each phase in words.
public struct JunoVoiceGlow: View {
    private let level: () -> Double
    private let bands: (() -> JunoVoiceGlowBands)?
    private let processing: Bool
    private let paused: Bool
    private let tone: JunoVoiceGlowTone
    private let edgeInset: CGFloat

    /// - Parameters:
    ///   - level: The live level (0...1) of whoever is talking, read per frame.
    ///   - processing: The reply is being thought through: gather into a beam.
    ///   - paused: No live audio (connecting, ended, muted): hold still and low.
    ///   - tone: Whose light it is. Defaults to the whole palette, the web's.
    ///   - edgeInset: How far above the view's bottom the glow's ground line
    ///     (the host's bottom edge) sits. The bloom spills into that strip and
    ///     fades there, so on a phone the light never ends on a hard cut.
    public init(
        level: @escaping () -> Double,
        bands: (() -> JunoVoiceGlowBands)? = nil,
        processing: Bool = false,
        paused: Bool = false,
        tone: JunoVoiceGlowTone = .mixed,
        edgeInset: CGFloat = 0
    ) {
        self.level = level
        self.bands = bands
        self.processing = processing
        self.paused = paused
        self.tone = tone
        self.edgeInset = edgeInset
    }

    /// A still level (previews, a level held by the caller).
    public init(
        level: Double,
        processing: Bool = false,
        paused: Bool = false,
        tone: JunoVoiceGlowTone = .mixed,
        edgeInset: CGFloat = 0
    ) {
        self.init(level: { level }, processing: processing, paused: paused, tone: tone, edgeInset: edgeInset)
    }

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    /// The light's own memory: smoothed level, the processing morph, the flow,
    /// the colour fade. A reference, not state, because it moves every frame
    /// and nothing but the canvas reads it.
    @State private var engine = JunoVoiceGlowEngine()

    public var body: some View {
        // Still light (held, or under Reduce Motion) only has a level and a
        // colour fade to follow, so the timeline drops to a calm rate.
        let calm = reduceMotion || paused
        TimelineView(.animation(minimumInterval: calm ? 1.0 / 30 : nil)) { timeline in
            Canvas(opaque: false, rendersAsynchronously: true) { context, size in
                let isDark = colorScheme == .dark
                let frame = engine.step(
                    to: timeline.date,
                    level: paused ? 0 : level(),
                    bands: paused ? nil : bands?(),
                    processing: processing && !paused,
                    still: reduceMotion || paused,
                    palette: JunoVoiceGlowPalette.palette(for: tone, dark: isDark)
                )
                JunoVoiceGlowRenderer(
                    isDark: isDark,
                    reduceMotion: reduceMotion,
                    reduceTransparency: reduceTransparency
                ).draw(
                    frame,
                    in: &context,
                    size: CGSize(width: size.width, height: max(0, size.height - edgeInset))
                )
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The voice's low / mid / high bands, each 0...1 (see the web's
/// `voice-glow` `bands`). The lobes follow these when the host has them.
public struct JunoVoiceGlowBands: Equatable, Sendable {
    public var low: Double
    public var mid: Double
    public var high: Double

    public init(low: Double, mid: Double, high: Double) {
        self.low = low
        self.mid = mid
        self.high = high
    }

    public static let silent = JunoVoiceGlowBands(low: 0, mid: 0, high: 0)
}

/// Whose light the glow is showing.
public enum JunoVoiceGlowTone: Equatable, Sendable {
    /// You: listening, or you talking. Warm.
    case caller
    /// Juno speaking. Cool.
    case juno
    /// The whole palette: thinking, and the web's default.
    case mixed
    /// The microphone is off. Grey.
    case muted
}

// MARK: - Palette

/// The web's `junoVoicePalette` (`src/components/effects/use-effect-theme.ts`).
///
/// `colors` is centre first, then the pairs outward, the package's order.
/// `core`, `above`, `mid` and `below` are the contour band's light and its
/// fringes. Kept as hex strings so the parity with the web is a string compare.
public struct JunoVoiceGlowPalette: Equatable, Sendable {
    public let colors: [String]
    public let core: String
    public let above: String
    public let mid: String
    public let below: String
    /// The web's `strength`: fuller on the dark ground, a notch softer on paper.
    public let strength: Double

    public static let light = JunoVoiceGlowPalette(
        colors: ["#f07f52", "#f2ad3f", "#ec6f5f", "#6fb383", "#e8839b", "#6f9fd8", "#5fb3ab"],
        core: "#ffd9bf", above: "#f07f52", mid: "#6fb383", below: "#6f9fd8",
        strength: 0.8
    )

    public static let dark = JunoVoiceGlowPalette(
        colors: ["#ff9a6b", "#ffc15f", "#ff7f73", "#86d19a", "#f59bb0", "#86b9f2", "#79d0c8"],
        core: "#fff1e4", above: "#ff9a6b", mid: "#86d19a", below: "#86b9f2",
        strength: 0.95
    )

    /// You: the dawn hues, apricot at the centre, then gold, clay and rose.
    public static let warmLight = JunoVoiceGlowPalette(
        colors: ["#f07f52", "#f2ad3f", "#ec6f5f", "#e8839b", "#f2ad3f", "#ec6f5f", "#e8839b"],
        core: "#ffd9bf", above: "#f07f52", mid: "#f2ad3f", below: "#e8839b",
        strength: 0.8
    )

    public static let warmDark = JunoVoiceGlowPalette(
        colors: ["#ff9a6b", "#ffc15f", "#ff7f73", "#f59bb0", "#ffc15f", "#ff7f73", "#f59bb0"],
        core: "#fff1e4", above: "#ff9a6b", mid: "#ffc15f", below: "#f59bb0",
        strength: 0.95
    )

    /// Juno: the dusk hues, sky at the centre, then teal, sage and periwinkle.
    public static let coolLight = JunoVoiceGlowPalette(
        colors: ["#6f9fd8", "#5fb3ab", "#6fb383", "#8e97dc", "#5fb3ab", "#6fb383", "#8e97dc"],
        core: "#dce9fa", above: "#6f9fd8", mid: "#5fb3ab", below: "#8e97dc",
        strength: 0.8
    )

    public static let coolDark = JunoVoiceGlowPalette(
        colors: ["#86b9f2", "#79d0c8", "#86d19a", "#a8aef5", "#79d0c8", "#86d19a", "#a8aef5"],
        core: "#eef5ff", above: "#86b9f2", mid: "#79d0c8", below: "#a8aef5",
        strength: 0.95
    )

    /// The microphone off: one quiet grey.
    public static let mutedLight = JunoVoiceGlowPalette(
        colors: Array(repeating: "#a8a29a", count: 7),
        core: "#d6d2cc", above: "#a8a29a", mid: "#a8a29a", below: "#a8a29a",
        strength: 0.55
    )

    public static let mutedDark = JunoVoiceGlowPalette(
        colors: Array(repeating: "#8c877f", count: 7),
        core: "#bdb8b0", above: "#8c877f", mid: "#8c877f", below: "#8c877f",
        strength: 0.55
    )

    public static func palette(for tone: JunoVoiceGlowTone, dark: Bool) -> JunoVoiceGlowPalette {
        switch tone {
        case .caller: dark ? warmDark : warmLight
        case .juno: dark ? coolDark : coolLight
        case .mixed: dark ? .dark : .light
        case .muted: dark ? mutedDark : mutedLight
        }
    }

    /// Every colour of this palette as linear components, in the renderer's
    /// order: the seven lobes, then core, above, below.
    var components: [JunoVoiceGlowRGB] {
        (colors + [core, above, below]).map(JunoVoiceGlowRGB.init(hex:))
    }
}

/// One colour, as sRGB components, so a fade between palettes is arithmetic.
struct JunoVoiceGlowRGB: Equatable {
    var red: Double
    var green: Double
    var blue: Double

    init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    /// A `#rrggbb` string. Invalid strings are black, which draws as nothing
    /// under additive light and as a shadow otherwise, so a test would see it.
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

// MARK: - Engine

/// One frame's worth of the glow's state.
struct JunoVoiceGlowFrame: Equatable {
    /// How lit the glow is, 0...1, with the idle breath and the processing hold.
    var lit: Double
    /// 0 = spread along the edge, 1 = gathered into the travelling beam.
    var gathered: Double
    /// The spectrum's sideways drift, in fractions of the range.
    var flow: Double
    /// The beam's place across the range, -1...1.
    var beam: Double
    /// Seconds on the glow's own clock, for the lobes' ripple.
    var clock: Double
    /// The seven lobes, then core, above and below, mid-fade if a tone is
    /// changing.
    var colors: [JunoVoiceGlowRGB]
    /// The palette's strength, faded with its colours.
    var strength: Double
    /// Each lobe's lift, 0...~1.2, centre first then the pairs outward. The
    /// renderer multiplies the rise by it.
    var lobes: [Double] = []
    /// How much of `lobes` is real audio (1) rather than synthesised (0):
    /// the ripple that fakes articulation fades out as real bands take over.
    var articulated: Double = 0
    /// The band's bell leans toward the highs on a sibilant and back on a
    /// vowel, -1...1 of a small offset.
    var lean: Double = 0
}

/// Smooths the raw level into light: a quick rise, a slower settle, the way
/// `voice-glow` answers a voice (`attack` 0.1s, `release` 0.5s), and eases the
/// processing morph in and out over its `processingEase` 0.6s.
public final class JunoVoiceGlowEngine {
    static let attack: Double = 0.1
    static let release: Double = 0.5
    static let processingEase: Double = 0.6
    /// `idle`: a soft presence while nobody is talking, so the call never
    /// looks dead.
    static let idle: Double = 0.18
    /// `processingLevel`: how lit the glow is held while it thinks.
    static let processingLevel: Double = 0.55
    /// `processingDuration`: seconds per pass of the beam.
    static let passDuration: Double = 1.1
    /// `processingCurve`: how the beam eases into each turn.
    static let turnCurve: Double = 2.1
    /// `flow` at full level, as a fraction of the range per second.
    static let flowRate: Double = 0.16

    private(set) var level: Double = 0
    private(set) var gathered: Double = 0
    /// Smoothed bands and how much they are in use.
    private var low: Double = 0
    private var mid: Double = 0
    private var high: Double = 0
    private var articulated: Double = 0
    private var flow: Double = 0
    private var travel: Double = 0
    private var clock: Double = 0
    private var lastDate: Date?
    private var stepped = false
    /// The colour fade: where it started from, where it is going, how far.
    private var fromColors: [JunoVoiceGlowRGB] = []
    private var fromStrength: Double = 0
    private var target: JunoVoiceGlowPalette?
    private var fade: Double = 1

    /// A tone change cross-fades over the slow rung, `--dur-slow`.
    static let toneFade = JunoMotion.Duration.slow

    /// Each lobe's response to one level when there are no bands: the centre
    /// loudest, the outer pair quietest.
    static let lobeGain: [Double] = [1, 0.82, 0.82, 0.66, 0.66, 0.5, 0.5]
    /// Bands are already smoothed by the meter; this only hides its 30 Hz
    /// steps at display rate.
    static let bandSmoothing: Double = 0.035

    func step(
        to date: Date,
        level target: Double,
        bands: JunoVoiceGlowBands? = nil,
        processing: Bool,
        still: Bool,
        palette: JunoVoiceGlowPalette
    ) -> JunoVoiceGlowFrame {
        let reduceMotion = still
        let dt = lastDate.map { min(0.1, max(0, date.timeIntervalSince($0))) } ?? 0
        lastDate = date
        let heard = min(1, max(0, target.isFinite ? target : 0))

        if !stepped {
            stepped = true
            level = heard
            gathered = processing ? 1 : 0
        } else {
            let tau = heard > level ? Self.attack : Self.release
            level += (heard - level) * (1 - exp(-dt / tau))
            gathered += ((processing ? 1 : 0) - gathered) * (1 - exp(-dt / (Self.processingEase / 3)))
        }

        if !reduceMotion {
            clock += dt
            flow = (flow + dt * Self.flowRate * level).truncatingRemainder(dividingBy: 1)
            if gathered > 0.001 { travel += dt } else { travel = 0 }
        }

        let (colors, strength) = fadeColors(toward: palette, dt: dt)
        let breath = reduceMotion ? 0 : 0.03 * sin(clock * 1.3)
        let spoken = max(Self.idle + breath, level)
        let lit = spoken + (Self.processingLevel - spoken) * gathered

        // Bands: eased toward what was heard, and the share of real
        // articulation eased in and out so a call that loses its bands (muted,
        // paused) slides back to the synthesised lobes instead of snapping.
        let k = dt == 0 ? 1 : 1 - exp(-dt / Self.bandSmoothing)
        let heardBands = bands ?? .silent
        low += (clamp(heardBands.low) - low) * k
        mid += (clamp(heardBands.mid) - mid) * k
        high += (clamp(heardBands.high) - high) * k
        let wantsBands: Double = bands != nil && !reduceMotion ? 1 : 0
        articulated += (wantsBands - articulated) * (dt == 0 ? 1 : 1 - exp(-dt / 0.25))
        let real = articulated * (1 - gathered)
        let perLobe = [low, mid, mid, (mid + high) / 2, (mid + high) / 2, high, high]
        let lobes = Self.lobeGain.indices.map { index -> Double in
            let synthetic = lit * Self.lobeGain[index]
            // A floor of the overall level keeps every lobe lit while anyone
            // talks; the band on top is what makes one side of the glow move
            // without the other.
            let measured = min(1.2, 0.3 * lit + 0.85 * perLobe[index] * (0.6 + 0.4 * Self.lobeGain[index]) + 0.1)
            return synthetic + (max(synthetic * 0.6, measured) - synthetic) * real
        }
        let lean = (high - low) * real

        return JunoVoiceGlowFrame(
            lit: min(1, max(0, lit)),
            gathered: gathered,
            flow: flow,
            beam: reduceMotion ? 0 : Self.beamPosition(at: travel),
            clock: clock,
            colors: colors,
            strength: strength,
            lobes: lobes,
            articulated: real,
            lean: lean
        )
    }

    private func clamp(_ value: Double) -> Double {
        value.isFinite ? min(1, max(0, value)) : 0
    }

    /// Moves the colour fade on by `dt`, restarting it from wherever it is
    /// when the palette changes mid-fade, so a quick turn never snaps.
    private func fadeColors(toward palette: JunoVoiceGlowPalette, dt: Double) -> ([JunoVoiceGlowRGB], Double) {
        if target == nil {
            target = palette
            fromColors = palette.components
            fromStrength = palette.strength
            fade = 1
        } else if target != palette, let current = target {
            let (now, strength) = blend(from: fromColors, fromStrength, to: current, fade)
            fromColors = now
            fromStrength = strength
            target = palette
            fade = 0
        }
        fade = min(1, fade + dt / Self.toneFade)
        return blend(from: fromColors, fromStrength, to: palette, fade)
    }

    private func blend(
        from colors: [JunoVoiceGlowRGB],
        _ strength: Double,
        to palette: JunoVoiceGlowPalette,
        _ t: Double
    ) -> ([JunoVoiceGlowRGB], Double) {
        let eased = t * t * (3 - 2 * t)
        let goal = palette.components
        let mixed = zip(colors, goal).map { $0.mixed(with: $1, eased) }
        return (mixed, strength + (palette.strength - strength) * eased)
    }

    /// Left to right and back, eased into each turn: `voice-glow`'s travelling
    /// line, as a pure function of time so it can be checked without a view.
    public static func beamPosition(at time: Double) -> Double {
        // Half a pass in, so the first frame of thinking starts at the centre
        // rather than jumping the light to the left edge.
        let pass = (max(0, time) / passDuration + 0.5).truncatingRemainder(dividingBy: 2)
        let along = pass < 1 ? pass : 2 - pass
        let a = pow(along, turnCurve)
        let b = pow(1 - along, turnCurve)
        let eased = a + b == 0 ? 0.5 : a / (a + b)
        return eased * 2 - 1
    }
}

// MARK: - Renderer

/// Draws one frame: blurred lobes rising from the bottom edge, and the
/// contour band over them.
struct JunoVoiceGlowRenderer {
    let isDark: Bool
    let reduceMotion: Bool
    let reduceTransparency: Bool

    func draw(_ frame: JunoVoiceGlowFrame, in context: inout GraphicsContext, size: CGSize) {
        guard size.width > 8, size.height > 8 else { return }
        let width = size.width
        let height = size.height
        let centre = width / 2
        // `rangeWidth` 0.75: the glow owns the middle three quarters, and fades
        // into the corners past that.
        let range = width * 0.75 / 2
        // Rise: a low band at rest, about 52pt at a loud syllable, never more
        // than half the host, so the light stays on the bottom edge.
        let rise = min(height * 0.5, 52)
        guard frame.colors.count == 10 else { return }
        let strength = frame.strength * (reduceTransparency ? 0.6 : 1)
        let lit = frame.lit
        let colors = frame.colors.prefix(7).map(\.color)

        var lobes = context
        if isDark, !reduceTransparency { lobes.blendMode = .plusLighter }
        lobes.addFilter(.blur(radius: 14))
        // A notch quieter on paper, where the same light reads louder.
        // Gathered, the seven lobes overlap in one place; without easing off
        // they add up to a white-hot spot on the dark ground.
        lobes.opacity = strength * (isDark ? 1 : 0.85) * (1 - 0.4 * frame.gathered)
            * (reduceMotion ? 0.35 + 0.65 * lit : 0.5 + 0.5 * lit)

        let spacing = range / 3 * 0.85
        let beamX = centre + frame.beam * range * 0.8
        for index in colors.indices {
            // Centre first, then the pairs outward: 0, -1, +1, -2, +2, -3, +3.
            let pair = (index + 1) / 2
            let side: Double = index == 0 ? 0 : (index % 2 == 1 ? -1 : 1)
            var slot = side * Double(pair) * spacing
            if !reduceMotion {
                // The spectrum drifts sideways with the voice, wrapping at the
                // range's ends, so every colour takes a turn at the centre.
                let span = range * 2
                slot = (slot + frame.flow * span + range).truncatingRemainder(dividingBy: span)
                if slot < 0 { slot += span }
                slot -= range
            }
            let spread = centre + slot
            let gatheredX = beamX + side * Double(pair) * spacing * 0.16
            let x = spread + (gatheredX - spread) * frame.gathered

            // Fade at the range's ends so a wrapping lobe never pops.
            let edge = smoothstep(range, range * 0.72, abs(x - centre))
            // The ripple fakes articulation when all there is is a level; with
            // real bands it drops to a shimmer so the voice leads.
            let rippleDepth = 0.22 - 0.16 * frame.articulated
            let ripple = reduceMotion
                ? 1
                : 1 - rippleDepth + rippleDepth * sin(frame.clock * (2.4 + Double(pair) * 0.9) + Double(index) * 1.7)
            let lift = index < frame.lobes.count ? frame.lobes[index] : lit * JunoVoiceGlowEngine.lobeGain[index]
            let lobeHeight = (10 + rise * lift * ripple) * (1 - 0.25 * frame.gathered)
            // A loud band also widens its lobe a touch, so a vowel reads as
            // the light opening rather than only climbing.
            let swell = 1 + 0.22 * frame.articulated * max(0, lift - lit)
            let lobeWidth = spacing * 1.35 * swell * (1 - 0.45 * frame.gathered)
            let rect = CGRect(
                x: x - lobeWidth,
                y: height - lobeHeight,
                width: lobeWidth * 2,
                height: lobeHeight * 2
            )
            let color = colors[index]
            lobes.fill(
                Path(ellipseIn: rect),
                with: .radialGradient(
                    Gradient(colors: [color.opacity(0.95 * edge), color.opacity(0.45 * edge), color.opacity(0)]),
                    center: CGPoint(x: x, y: height),
                    startRadius: 0,
                    endRadius: max(lobeWidth, lobeHeight)
                )
            )
        }

        drawBand(frame, in: context, width: width, height: height, centre: centre, range: range, rise: rise, strength: strength)
    }

    /// The light along the glow's contour: an organic bell,
    /// `exp(-(|x| / spread)^curve)`, flattening onto the edge at both ends, with
    /// a warm fringe above and a cool one below. Fades while the beam gathers.
    private func drawBand(
        _ frame: JunoVoiceGlowFrame,
        in context: GraphicsContext,
        width: Double,
        height: Double,
        centre: Double,
        range: Double,
        rise: Double,
        strength: Double
    ) {
        let presence = (1 - frame.gathered) * (0.2 + 0.8 * frame.lit)
        guard presence > 0.02 else { return }
        let peak = 4 + rise * 0.55 * frame.lit
        let bellSpread = range * 0.87
        // Sibilants pull the crest a little to the right, vowels back.
        let crest = centre + frame.lean * range * 0.12
        let steps = 64
        var points: [CGPoint] = []
        points.reserveCapacity(steps + 1)
        for step in 0...steps {
            let t = Double(step) / Double(steps)
            let x = centre - range + t * range * 2
            let bell = exp(-pow(abs(x - crest) / bellSpread, 1.75))
            points.append(CGPoint(x: x, y: height - 2 - peak * bell))
        }
        var curve = Path()
        curve.addLines(points)

        var band = context
        if isDark, !reduceTransparency { band.blendMode = .plusLighter }
        band.addFilter(.blur(radius: 1.6))
        band.opacity = strength * presence * 0.7
        let thickness = 1.2 + 1.4 * frame.lit
        let split = 1 + 2.5 * frame.lit
        let fade = Gradient(stops: [
            .init(color: .white.opacity(0), location: 0),
            .init(color: .white, location: 0.28),
            .init(color: .white, location: 0.72),
            .init(color: .white.opacity(0), location: 1),
        ])
        band.drawLayer { layer in
            layer.stroke(
                curve.offsetBy(dx: 0, dy: -split),
                with: .color(frame.colors[8].color.opacity(0.55)),
                lineWidth: thickness
            )
            layer.stroke(
                curve.offsetBy(dx: 0, dy: split),
                with: .color(frame.colors[9].color.opacity(0.55)),
                lineWidth: thickness
            )
            layer.stroke(curve, with: .color(frame.colors[7].color), lineWidth: thickness)
            // Flatten onto the edge at both ends.
            layer.blendMode = .destinationIn
            layer.fill(
                Path(CGRect(x: centre - range, y: 0, width: range * 2, height: height)),
                with: .linearGradient(
                    fade,
                    startPoint: CGPoint(x: centre - range, y: 0),
                    endPoint: CGPoint(x: centre + range, y: 0)
                )
            )
        }
    }

    private func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
        let t = min(1, max(0, (x - edge0) / (edge1 - edge0)))
        return t * t * (3 - 2 * t)
    }
}

#Preview("Voice glow") {
    struct Harness: View {
        @State private var processing = false
        let start = Date()

        var body: some View {
            VStack(spacing: 24) {
                JunoVoiceGlow(
                    level: {
                        let t = Date().timeIntervalSince(start)
                        let syllable = max(0, sin(t * 5.2))
                        return min(1, syllable * syllable * (0.55 + 0.45 * (0.5 + 0.5 * sin(t * 21))))
                    },
                    bands: {
                        let t = Date().timeIntervalSince(start)
                        let vowel = max(0, sin(t * 5.2))
                        let sibilant = max(0, sin(t * 9.1 + 1)) * max(0, sin(t * 1.3))
                        return JunoVoiceGlowBands(low: vowel, mid: vowel * 0.8, high: sibilant)
                    },
                    processing: processing
                )
                .frame(width: 560, height: 110)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.background))
                Toggle("Thinking", isOn: $processing)
            }
            .padding(40)
        }
    }
    return Harness()
}
