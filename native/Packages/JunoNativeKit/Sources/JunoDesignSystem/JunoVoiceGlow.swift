import SwiftUI

/// Juno's voice glow: the one light every native voice surface draws, and,
/// in a call, the only thing on screen that says what the call is doing.
///
/// The native half of `src/components/voice/voice-composer-glow.tsx`
/// (`JunoVoiceGlow`, Libraries.dev `voice-glow`), drawn the way that library
/// draws its "mobile" type: a soft band of colour pooled along the bottom edge
/// of the host, which rises and blooms with the voice, and which gathers into
/// one beam travelling side to side while the reply is being thought through.
///
/// - **Whose voice it is, is the colour** (``JunoVoiceGlowTone``). You: the
///   warm dawn inks, apricot, gold, clay and rose. Juno: the cool dusk inks,
///   sky, teal, sage and periwinkle. Thinking: the whole mixed palette
///   (`junoVoicePalette`, hex for hex), gathered into the travelling beam.
///   Muted: a low grey band, held still. A change of tone cross-fades over the
///   `--dur-slow` rung rather than cutting, because a hard cut on every turn
///   reads as a glitch rather than as an answer beginning.
/// - **Input.** A level source read once per frame, so a level republished at
///   30Hz never re-renders the host; a plain value works too.
/// - **State.** `processing` for the thinking gap; `paused` holds the light
///   still and low (connecting, ended, muted) and then stops the timeline, so a
///   paused glow costs nothing once it has settled.
/// - **Reduce Motion.** No flow and no travel: a still band whose brightness
///   follows the level and whose colour still says whose turn it is, because
///   both are state and only the movement is decoration.
///
/// Decorative to assistive technology: every host announces the phase in
/// words, so this is hidden from accessibility and never takes a touch.
public struct JunoVoiceGlow: View {
    private let level: () -> Double
    private let processing: Bool
    private let paused: Bool
    private let tone: JunoVoiceGlowTone
    private let edgeInset: CGFloat

    /// - Parameters:
    ///   - level: The live level (0...1) of whoever is talking, read per frame.
    ///   - processing: The gap after you stop, while the reply is thought through.
    ///   - paused: No voice to follow: the glow holds still and low, then the
    ///     timeline stops.
    ///   - tone: Whose voice the light is: yours, Juno's, both, or muted.
    ///   - edgeInset: How far above the view's bottom the glow's ground line
    ///     (the host's bottom edge) sits. The bloom spills below it into that
    ///     strip and fades out there, so the light never ends on a hard cut.
    public init(
        level: @escaping () -> Double,
        processing: Bool = false,
        paused: Bool = false,
        tone: JunoVoiceGlowTone = .mixed,
        edgeInset: CGFloat = 0
    ) {
        self.level = level
        self.processing = processing
        self.paused = paused
        self.tone = tone
        self.edgeInset = edgeInset
    }

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
    /// Frame-to-frame state (the smoothed level, the flow, the beam's clock,
    /// the inks mid-crossfade). A plain reference, not observable: it changes
    /// every frame and nothing but the canvas that owns it should hear of it.
    @State private var driver = JunoVoiceGlowDriver()
    /// True for a moment after any change of state, so a glow that has just
    /// been paused still draws the frames that fade it to its resting tone.
    @State private var settling = true

    private struct Settle: Hashable {
        let paused: Bool
        let processing: Bool
        let tone: JunoVoiceGlowTone
        let dark: Bool
    }

    public var body: some View {
        let dark = colorScheme == .dark
        let inks = JunoVoiceGlowInks.inks(for: tone, dark: dark)
        TimelineView(
            .animation(minimumInterval: reduceMotion ? 1.0 / 15 : nil, paused: paused && !settling)
        ) { context in
            Canvas(opaque: false, rendersAsynchronously: true) { canvas, size in
                let frame = driver.step(
                    to: context.date,
                    level: level(),
                    processing: processing,
                    paused: paused,
                    still: reduceMotion,
                    inks: inks
                )
                JunoVoiceGlowPainter(
                    strength: dark ? 0.95 : 0.8,
                    additive: dark,
                    still: reduceMotion,
                    edgeInset: edgeInset
                ).paint(frame, in: &canvas, size: size)
            }
        }
        // Soft at every edge the light can reach: the top fades as the lobes
        // do, and the strip under the ground line fades to nothing.
        .mask {
            VStack(spacing: 0) {
                Rectangle()
                if edgeInset > 0 {
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: edgeInset)
                }
            }
        }
        .task(id: Settle(paused: paused, processing: processing, tone: tone, dark: dark)) {
            settling = true
            try? await Task.sleep(for: .seconds(JunoVoiceGlowDriver.settleTime))
            guard !Task.isCancelled else { return }
            settling = false
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Whose voice the glow is showing.
public enum JunoVoiceGlowTone: Hashable, Sendable {
    /// Both: the whole palette. Thinking, and any host with no speaker.
    case mixed
    /// You: the warm dawn inks.
    case user
    /// Juno: the cool dusk inks.
    case assistant
    /// A closed microphone: a low grey band.
    case muted
}

// MARK: - Palette

/// One colour as three numbers, so two palettes can be mixed per frame.
struct JunoVoiceRGB: Equatable {
    var r: Double
    var g: Double
    var b: Double

    init(_ hex: Int) {
        r = Double((hex >> 16) & 0xFF) / 255
        g = Double((hex >> 8) & 0xFF) / 255
        b = Double(hex & 0xFF) / 255
    }

    init(r: Double, g: Double, b: Double) {
        self.r = r
        self.g = g
        self.b = b
    }

    func mixed(toward other: JunoVoiceRGB, by t: Double) -> JunoVoiceRGB {
        JunoVoiceRGB(r: r + (other.r - r) * t, g: g + (other.g - g) * t, b: b + (other.b - b) * t)
    }

    var color: Color { Color(red: r, green: g, blue: b) }
}

/// The seven lobe inks and the band's four, for one tone on one ground.
///
/// `mixed` is `junoVoicePalette(theme)` from `use-effect-theme.ts`, digit for
/// digit. The warm and cool sets are drawn from the same plate: the dawn hues
/// for you, the dusk hues for Juno, each with a periwinkle or rose of its own
/// so seven lobes never read as one repeated colour.
struct JunoVoiceGlowInks: Equatable {
    var lobes: [JunoVoiceRGB]
    var core: JunoVoiceRGB
    var above: JunoVoiceRGB
    var mid: JunoVoiceRGB
    var below: JunoVoiceRGB
    /// How lit the tone sits at rest: a muted microphone is a low band.
    var brightness: Double

    static func inks(for tone: JunoVoiceGlowTone, dark: Bool) -> JunoVoiceGlowInks {
        switch (tone, dark) {
        case (.mixed, true):
            make([0xFF9A6B, 0xFFC15F, 0xFF7F73, 0x86D19A, 0xF59BB0, 0x86B9F2, 0x79D0C8],
                 core: 0xFFF1E4, above: 0xFF9A6B, mid: 0x86D19A, below: 0x86B9F2)
        case (.mixed, false):
            make([0xF07F52, 0xF2AD3F, 0xEC6F5F, 0x6FB383, 0xE8839B, 0x6F9FD8, 0x5FB3AB],
                 core: 0xFFD9BF, above: 0xF07F52, mid: 0x6FB383, below: 0x6F9FD8)
        case (.user, true):
            make([0xFF9A6B, 0xFFC15F, 0xFF7F73, 0xF59BB0, 0xFF9A6B, 0xFFC15F, 0xFF7F73],
                 core: 0xFFF1E4, above: 0xFF9A6B, mid: 0xFFC15F, below: 0xF59BB0)
        case (.user, false):
            make([0xF07F52, 0xF2AD3F, 0xEC6F5F, 0xE8839B, 0xF07F52, 0xF2AD3F, 0xEC6F5F],
                 core: 0xFFD9BF, above: 0xF07F52, mid: 0xF2AD3F, below: 0xE8839B)
        case (.assistant, true):
            make([0x86B9F2, 0x79D0C8, 0x86D19A, 0xA9B0F5, 0x86B9F2, 0x79D0C8, 0x86D19A],
                 core: 0xEAF4FF, above: 0x86B9F2, mid: 0x86D19A, below: 0x79D0C8)
        case (.assistant, false):
            make([0x6F9FD8, 0x5FB3AB, 0x6FB383, 0x8E93E0, 0x6F9FD8, 0x5FB3AB, 0x6FB383],
                 core: 0xD6E8FB, above: 0x6F9FD8, mid: 0x6FB383, below: 0x5FB3AB)
        case (.muted, true):
            make(Array(repeating: 0x8C8A87, count: 7),
                 core: 0xB9B6B1, above: 0x8C8A87, mid: 0x8C8A87, below: 0x8C8A87, brightness: 0.45)
        case (.muted, false):
            make(Array(repeating: 0xA8A29A, count: 7),
                 core: 0xD9D4CC, above: 0xA8A29A, mid: 0xA8A29A, below: 0xA8A29A, brightness: 0.5)
        }
    }

    private static func make(
        _ lobes: [Int], core: Int, above: Int, mid: Int, below: Int, brightness: Double = 1
    ) -> JunoVoiceGlowInks {
        JunoVoiceGlowInks(
            lobes: lobes.map(JunoVoiceRGB.init),
            core: JunoVoiceRGB(core),
            above: JunoVoiceRGB(above),
            mid: JunoVoiceRGB(mid),
            below: JunoVoiceRGB(below),
            brightness: brightness
        )
    }

    func mixed(toward other: JunoVoiceGlowInks, by t: Double) -> JunoVoiceGlowInks {
        JunoVoiceGlowInks(
            lobes: zip(lobes, other.lobes).map { $0.mixed(toward: $1, by: t) },
            core: core.mixed(toward: other.core, by: t),
            above: above.mixed(toward: other.above, by: t),
            mid: mid.mixed(toward: other.mid, by: t),
            below: below.mixed(toward: other.below, by: t),
            brightness: brightness + (other.brightness - brightness) * t
        )
    }
}

// MARK: - Driver

/// One frame's worth of the glow's state, already eased.
struct JunoVoiceGlowFrame {
    /// The level the light follows, after the gate, the envelope and the
    /// processing hold.
    var level: Double
    /// Low, mid and high: the centre lobe follows the lows, its neighbours the
    /// mids, the outer pair the highs. Synthesised from one level, so the lobes
    /// ripple outward rather than one blob pumping.
    var bands: (low: Double, mid: Double, high: Double)
    /// How far the spectrum has flowed sideways, in lobe widths.
    var flow: Double
    /// 0 listening/speaking, 1 fully gathered into the travelling beam.
    var processing: Double
    /// Where the beam is on its pass, -1...1.
    var beam: Double
    /// The glow's own clock, for the idle breath.
    var time: Double
    /// The inks this frame, part way through any crossfade.
    var inks: JunoVoiceGlowInks
}

/// The web package's response knobs, integrated per frame: a noise gate, a
/// 0.1s attack and a 0.5s release, a flow at up to one lobe per second, and a
/// 0.6s morph into and out of processing. Paused, the clock, the flow and the
/// beam stop where they are while the level and the inks still ease down to
/// their resting values, which is what "held still and low" means.
final class JunoVoiceGlowDriver {
    /// How long a change of state keeps the timeline running after a pause,
    /// long enough for the crossfade and the release to land.
    static let settleTime = 0.9
    private var inks: JunoVoiceGlowInks?
    private var last: Date?
    private var smoothed: Double = 0
    private var processingMix: Double = 0
    private var flow: Double = 0
    private var time: Double = 0
    private var beamClock: Double = 0

    private static let sensitivity = 1.6
    private static let threshold = 0.03
    private static let attack = 0.1
    private static let release = 0.5
    private static let processingEase = 0.6
    private static let processingLevel = 0.55
    /// Seconds per pass of the beam.
    private static let processingDuration = 1.1
    /// Lobe widths per second at full level.
    private static let flowRate = 0.9

    /// The tone crossfade: `--dur-slow`, as a time constant a third of it so
    /// the change has landed by the time the rung would have.
    private static var crossfade: Double { JunoMotion.Duration.slow / 3 }

    func step(
        to date: Date,
        level raw: Double,
        processing: Bool,
        paused: Bool,
        still: Bool,
        inks target: JunoVoiceGlowInks
    ) -> JunoVoiceGlowFrame {
        let first = last == nil
        var ease = last.map { date.timeIntervalSince($0) } ?? 0
        last = date
        ease = min(max(ease, 0), 0.1)
        // Motion stops while paused; easing (level, colour) does not.
        let dt = paused ? 0 : ease

        let current = inks ?? target
        let blended = current.mixed(toward: target, by: 1 - exp(-ease / Self.crossfade))
        inks = blended

        let gated = !paused && raw.isFinite && raw > Self.threshold ? min(1, raw * Self.sensitivity) : 0
        let tau = gated > smoothed ? Self.attack : Self.release
        smoothed += (gated - smoothed) * (1 - exp(-ease / tau))
        // The first frame lands where the level already is, so a glow that
        // mounts mid-sentence (or is rendered once) is not a frame of dark.
        if first { smoothed = gated }

        let target = processing && !paused ? 1.0 : 0.0
        if first { processingMix = target }
        processingMix += (target - processingMix) * (1 - exp(-ease / (Self.processingEase / 3)))
        if abs(processingMix - target) < 0.001 { processingMix = target }

        time += dt
        if !still {
            flow += dt * Self.flowRate * smoothed
            if processingMix > 0.001 { beamClock += dt }
        }

        let level = max(smoothed, Self.processingLevel * processingMix)
        // Three bands from one level: small detuned wobbles, so a steady
        // voice still moves the lobes against each other.
        let t = still ? 0 : time
        let bands = (
            low: level * (0.86 + 0.14 * sin(t * 2.3)),
            mid: level * (0.8 + 0.2 * sin(t * 3.7 + 1.1)),
            high: level * (0.72 + 0.28 * sin(t * 5.3 + 2.4))
        )

        // One pass left to right and back, eased into each turn: a cosine
        // ping-pong sharpened toward the ends (`processingCurve` 2.1).
        let phase = beamClock / Self.processingDuration * .pi
        let swing = -cos(phase)
        let beam = still ? 0 : copysign(pow(abs(swing), 1 / 1.35), swing)

        return JunoVoiceGlowFrame(
            level: level,
            bands: bands,
            flow: flow,
            processing: processingMix,
            beam: beam,
            time: time,
            inks: blended
        )
    }
}

// MARK: - Painter

/// Draws one frame: blurred lobes pooled on the bottom edge (the bloom), then
/// the band along the top of the hump in its core ink with the warm and cool
/// fringes splitting off it as the level rises.
struct JunoVoiceGlowPainter {
    /// The web's `strength`: 0.95 on dark, 0.8 on light, where the same light
    /// reads louder.
    let strength: Double
    /// Light adds on a dark ground and paints on a light one.
    let additive: Bool
    let still: Bool
    var edgeInset: CGFloat = 0

    func paint(_ frame: JunoVoiceGlowFrame, in canvas: inout GraphicsContext, size: CGSize) {
        guard size.width > 1, size.height > 1 else { return }
        let width = size.width
        // Everything is laid out on the ground line; the strip below it only
        // catches the spill.
        let ground = max(1, size.height - edgeInset)
        let height = ground
        let inks = frame.inks
        let count = inks.lobes.count
        let lit = frame.level
        // Never dead: a soft breath while silent, as the web's `idle` keeps.
        let breath = still ? 0.16 : 0.15 + 0.035 * sin(frame.time * 1.4)
        let presence = max(lit, breath)

        // Reduce Motion reads the level as brightness instead of height.
        let brightness = still ? 0.45 + 0.55 * presence : 1
        let opacity = strength * brightness * inks.brightness

        // The range the lobes flow across: wider than the host, so the outer
        // pair sit in the corners and wrap out of sight.
        let range = width * 1.25
        let spacing = range / Double(count)
        let centre = width / 2
        let beamX = centre + frame.beam * width * 0.3
        let p = frame.processing

        canvas.drawLayer { layer in
            // Gathered, seven lobes stack on one spot; on the additive dark
            // ground that would sum to white, so each gives up its share.
            layer.opacity = opacity / (1 + (additive ? 2.2 : 1.2) * p)
            if additive { layer.blendMode = .plusLighter }
            layer.addFilter(.blur(radius: min(28, height * 0.16)))

            for index in 0..<count {
                // Flowing positions, wrapped into the range.
                var slot = Double(index) + (still ? 0 : frame.flow)
                slot = slot.truncatingRemainder(dividingBy: Double(count))
                if slot < 0 { slot += Double(count) }
                let spread = (slot + 0.5) * spacing - range / 2
                let restingX = centre + spread
                // How far from the middle, 0 at the centre, 1 at the edge.
                let distance = min(1, abs(spread) / (range / 2))
                let band =
                    distance < 0.22 ? frame.bands.low
                    : distance < 0.58 ? frame.bands.mid
                    : frame.bands.high
                let rise = max(breath, band)

                // Gathered: every lobe converges on the beam, narrower and held.
                let gatheredX = beamX + (Double(index) - Double(count - 1) / 2) * spacing * 0.3
                let x = restingX + (gatheredX - restingX) * p
                let restingHeight = height * (0.2 + 0.72 * rise) * (1 - 0.45 * distance)
                let gatheredHeight = height * 0.5
                let lobeHeight = restingHeight + (gatheredHeight - restingHeight) * p
                let restingWidth = spacing * (1.05 + 0.5 * rise)
                let lobeWidth = restingWidth + (spacing * 0.7 - restingWidth) * p

                let rect = CGRect(
                    x: x - lobeWidth,
                    y: height - lobeHeight * 0.92,
                    width: lobeWidth * 2,
                    height: lobeHeight * 1.84
                )
                let colour = inks.lobes[index].color
                layer.fill(
                    Path(ellipseIn: rect),
                    with: .radialGradient(
                        Gradient(stops: [
                            .init(color: colour.opacity(0.95), location: 0),
                            .init(color: colour.opacity(0.55), location: 0.45),
                            .init(color: colour.opacity(0), location: 1),
                        ]),
                        center: CGPoint(x: x, y: height),
                        startRadius: 0,
                        endRadius: max(lobeWidth, lobeHeight)
                    )
                )
            }
        }

        // The band: a bell along the hump's crest, flattening onto the edge at
        // both ends, its fringes splitting further as the voice rises.
        let bandCentre = centre + (beamX - centre) * p
        let bellHalf = width * (0.42 + 0.1 * presence) * (1 - 0.5 * p)
        let peak = height * (0.12 + 0.34 * presence)
        let base = height - 2
        func bell(_ x: Double) -> Double {
            let u = abs(x - bandCentre) / bellHalf
            return exp(-pow(u, 1.75))
        }
        func crest(offset: Double) -> Path {
            var path = Path()
            let steps = 48
            for step in 0...steps {
                let x = Double(step) / Double(steps) * width
                let y = base - peak * bell(x) + offset
                if step == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
            }
            return path
        }
        func fade(_ colour: Color, _ alpha: Double) -> GraphicsContext.Shading {
            let left = max(0, (bandCentre - bellHalf * 1.6) / width)
            let mid = min(1, max(0, bandCentre / width))
            let right = min(1, (bandCentre + bellHalf * 1.6) / width)
            return .linearGradient(
                Gradient(stops: [
                    .init(color: colour.opacity(0), location: left),
                    .init(color: colour.opacity(alpha), location: mid),
                    .init(color: colour.opacity(0), location: right),
                ]),
                startPoint: .zero,
                endPoint: CGPoint(x: width, y: 0)
            )
        }

        let split = 1.5 + 3.5 * presence
        let thickness = 1.6 + 2.2 * presence
        canvas.drawLayer { layer in
            layer.opacity = opacity
            if additive { layer.blendMode = .plusLighter }
            layer.addFilter(.blur(radius: 2 + 2 * presence))
            layer.stroke(crest(offset: -split), with: fade(inks.above.color, 0.8), lineWidth: thickness)
            layer.stroke(crest(offset: split), with: fade(inks.below.color, 0.8), lineWidth: thickness)
            layer.stroke(crest(offset: 0), with: fade(inks.mid.color, 0.35), lineWidth: thickness * 2.4)
            layer.stroke(crest(offset: 0), with: fade(inks.core.color, 0.95), lineWidth: thickness * 0.8)
        }
    }
}
