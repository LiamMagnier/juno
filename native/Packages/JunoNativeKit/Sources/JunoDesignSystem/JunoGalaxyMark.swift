import SwiftUI

/// The working indicator: a tiny spiral galaxy, seen from a little above,
/// drawn entirely from dots.
///
/// It replaces the moving Continuum mark (and the 3 × 3 matrix before it)
/// wherever the product says "the model is thinking / working": the run line,
/// the thought-process strip, research's working state, a block being built.
/// The static Continuum stays the brand mark (``JunoMark``); the two are never
/// swapped for one another.
///
/// **One field on every platform.** The particles come from the shared spec's
/// deterministic generator (`GALAXY_SPEC.md`, mulberry32 seeded 0xA1E7) —
/// ``JunoGalaxyField`` — so the web's `GalaxyMark` and this view draw the same
/// galaxy. 120 particles, 72 below 18pt, two arms on a log-spiral winding, 18%
/// dust, a soft core and six tight core stars, the disc squashed to 0.62 and
/// turned −18° so it reads as a disc rather than a wheel.
///
/// **Motion is calm.** Differential rotation, inner faster — ω(r) = ω0 ·
/// (0.35 + 0.65 · (1 − r)) at its peak, ω0 = 2π / 5.5s — with the
/// differential part *oscillating* rather than accumulating, so the arms
/// wind and unwind instead of smearing into a ring after a minute. The core
/// breathes 0.75 ↔ 1 on 2.8s; each star twinkles ±15%. It enters by fading
/// and spiralling in from 0.6 of its radius over 420ms and leaves on a fade.
///
/// **Cheap.** One `Canvas` in one `TimelineView`; no per-particle views. The
/// clock pauses when the mark is off screen (a lazy stack has torn it down,
/// or it has disappeared), when the scene is not active, when it is not
/// ``active`` (it then holds a still frame), and under Reduce Motion, where
/// it draws one static frame (t = 1.2s) and nothing moves at all.
public struct JunoGalaxyMark: View {
    private let size: CGFloat
    private let active: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.junoGalaxyClock) private var fixedClock
    @State private var onScreen = false
    @State private var appearedAt: Date?

    /// - Parameters:
    ///   - size: the mark's side, in points. 14–28 inline with text; larger
    ///     for a hero working state.
    ///   - active: whether the work is happening now. False holds the still
    ///     frame — the shape of "working" without the motion, for a mark that
    ///     does not own the screen's one loop.
    public init(size: CGFloat = 18, active: Bool = true) {
        self.size = size
        self.active = active
    }

    private var moves: Bool {
        active && !reduceMotion && fixedClock == nil
    }

    public var body: some View {
        let field = JunoGalaxyField.field(forSize: size)
        let running = moves && onScreen && scenePhase != .background
        TimelineView(.animation(paused: !running)) { context in
            let clock = clock(at: context.date)
            Canvas { graphics, canvasSize in
                JunoGalaxyRenderer.draw(
                    field,
                    in: &graphics,
                    size: canvasSize,
                    clock: clock.time,
                    enter: clock.enter
                )
            }
        }
        .frame(width: size, height: size)
        .onAppear {
            onScreen = true
            if appearedAt == nil { appearedAt = .now }
        }
        .onDisappear { onScreen = false }
        .transition(.opacity.animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint)))
        .accessibilityHidden(true)
    }

    /// The galaxy's clock and how far its entrance has run, 0…1.
    private func clock(at date: Date) -> (time: Double, enter: Double) {
        if let fixedClock { return (fixedClock, 1) }
        guard moves else { return (JunoGalaxyRenderer.stillFrame, 1) }
        // Absolute time, so every galaxy on screen agrees and a re-render
        // never restarts the turn.
        let time = date.timeIntervalSinceReferenceDate
        let since = appearedAt.map { date.timeIntervalSince($0) } ?? JunoGalaxyRenderer.enterDuration
        return (time, min(max(since / JunoGalaxyRenderer.enterDuration, 0), 1))
    }
}

// MARK: - The field

/// The galaxy's particles, generated once per count from the shared spec.
///
/// Generation order, per particle `i` — the order the web's generator uses:
///
/// 1. `t = rand()^0.85`
/// 2. angle jitter `g1 = gaussian()`, radial jitter `g2 = gaussian()`, each a
///    Box–Muller pair `√(−2 ln u1) · cos(2π u2)` with `u1 = max(rand(), 1e−9)`
/// 3. `dust = rand() < 0.18`; dust then draws `θ = rand() · 2π`,
///    `r = 0.15 + rand() · 0.85`
/// 4. `size = 0.55 + (1 − t) · 0.9 + rand() · 0.35`
/// 5. `alpha = 0.35 + (1 − t) · 0.55 + (rand() − 0.5) · 0.2`
///
/// then the six core stars, each `r = rand() · 0.06`, `θ = rand() · 2π`.
public enum JunoGalaxyField {
    public struct Particle: Equatable, Sendable {
        public let index: Int
        /// Base angle, radians.
        public let angle: Double
        /// Radius, normalised to half the mark.
        public let radius: Double
        /// Diameter in units of size / 24.
        public let size: Double
        public let alpha: Double
        public let isDust: Bool
        /// One of the ~8% of arm stars in presence ink (`i % 13 == 0`).
        public let isAccent: Bool
    }

    public struct Field: Sendable {
        public let particles: [Particle]
        public let core: [Particle]
    }

    public static let seed: UInt32 = 0xA1E7

    /// The spec's count for a rendered size: 72 below 18pt, else 120.
    public static func count(forSize size: CGFloat) -> Int {
        size < 18 ? 72 : 120
    }

    public static func field(forSize size: CGFloat) -> Field {
        count(forSize: size) == 72 ? small : large
    }

    static let large = generate(count: 120)
    static let small = generate(count: 72)

    /// The spec's PRNG: mulberry32, bit for bit with the JavaScript.
    public struct Mulberry32: Sendable {
        private var state: UInt32

        public init(seed: UInt32) {
            state = seed
        }

        public mutating func next() -> Double {
            state = state &+ 0x6D2B_79F5
            var t = (state ^ (state >> 15)) &* (state | 1)
            t = (t &+ ((t ^ (t >> 7)) &* (t | 61))) ^ t
            return Double(t ^ (t >> 14)) / 4_294_967_296
        }

        public mutating func gaussian() -> Double {
            let u1 = max(next(), 1e-9)
            let u2 = next()
            return (-2 * log(u1)).squareRoot() * cos(2 * .pi * u2)
        }
    }

    public static func generate(count: Int) -> Field {
        var random = Mulberry32(seed: seed)
        var particles: [Particle] = []
        particles.reserveCapacity(count)
        for i in 0..<count {
            let arm = Double(i % 2)
            let t = pow(random.next(), 0.85)
            let g1 = random.gaussian()
            let g2 = random.gaussian()
            var angle = arm * .pi + t * 2.4 * .pi + g1 * (0.22 + 0.25 * (1 - t))
            var radius = 0.08 + 0.92 * t + g2 * 0.035
            let isDust = random.next() < 0.18
            if isDust {
                angle = random.next() * 2 * .pi
                radius = 0.15 + random.next() * 0.85
            }
            let size = 0.55 + (1 - t) * 0.9 + random.next() * 0.35
            var alpha = 0.35 + (1 - t) * 0.55 + (random.next() - 0.5) * 0.2
            if isDust { alpha *= 0.45 }
            particles.append(Particle(
                index: i,
                angle: angle,
                radius: max(radius, 0.02),
                size: size,
                alpha: min(max(alpha, 0), 1),
                isDust: isDust,
                isAccent: !isDust && i % 13 == 0
            ))
        }
        var core: [Particle] = []
        for k in 0..<6 {
            let radius = random.next() * 0.06
            let angle = random.next() * 2 * .pi
            core.append(Particle(
                index: count + k, angle: angle, radius: radius,
                size: 1.25, alpha: 0.85, isDust: false, isAccent: false
            ))
        }
        return Field(particles: particles, core: core)
    }
}

// MARK: - The renderer

/// Draws a field into a `GraphicsContext`. Separate from the view so the
/// motion is a pure function of the clock (and testable as one).
public enum JunoGalaxyRenderer {
    /// The still frame Reduce Motion and an inactive mark show.
    public static let stillFrame: Double = 1.2
    /// One core revolution at the peak rate: ω0 = 2π / 5.5s.
    public static let period: Double = 5.5
    /// The arms wind and unwind once over this many seconds.
    public static let windPeriod: Double = 11
    /// The core's breath, 0.75 ↔ 1.
    public static let breathPeriod: Double = JunoMotion.Loop.statusBreathe
    public static let enterDuration: Double = 0.42
    /// The disc seen from ~52° above, turned −18°.
    public static let tilt: Double = 0.62
    public static let turn: Double = -18 * .pi / 180
    /// The wake behind each arm star: how far back each ghost sits (radians at
    /// the rim) and how strongly it is drawn.
    static let trailStep: Double = 0.075
    static let trailFades: [Double] = [0.42, 0.22, 0.1]

    /// Where a star of base `angle` and `radius` is at `clock`: a rigid turn at
    /// the spec's outer rate plus a differential term whose instantaneous speed
    /// peaks at ω0 · 0.65 · (1 − r) and integrates to an oscillation. The turn
    /// runs against the arms' winding (screen counter-clockwise), so the arms
    /// trail as a real galaxy's do.
    public static func angle(_ angle: Double, radius: Double, clock: Double) -> Double {
        let omega = 2 * .pi / period
        let inner = 1 - min(radius, 1)
        let wind = 0.65 * inner * omega * (windPeriod / (2 * .pi)) * sin(2 * .pi * clock / windPeriod)
        return angle - (omega * 0.35 * clock + wind)
    }

    public static func draw(
        _ field: JunoGalaxyField.Field,
        in graphics: inout GraphicsContext,
        size: CGSize,
        clock: Double,
        enter: Double
    ) {
        let side = min(size.width, size.height)
        guard side > 0 else { return }
        let centre = CGPoint(x: size.width / 2, y: size.height / 2)
        let reach = side / 2 * 0.94
        // The spec's dot unit is size / 24 — exact at inline sizes. Above 24pt
        // it grows with the square root instead, so a hero galaxy is made of
        // fine stars rather than of the same dots blown up into blobs.
        let unit = side <= 24 ? side / 24 : (side / 24).squareRoot()
        // ease-out cubic
        let eased = 1 - pow(1 - enter, 3)
        let spread = 0.6 + 0.4 * eased
        let swirl = (1 - eased) * 0.9
        let cosTurn = cos(turn), sinTurn = sin(turn)

        let ink = Color.junoForeground.resolve(in: graphics.environment)
        let accent = Color.junoPresence.resolve(in: graphics.environment)
        let warm = Color.junoGalaxyCore.resolve(in: graphics.environment)
        let coreInk = mix(ink, warm, 0.12)

        func place(_ particle: JunoGalaxyField.Particle, lag: Double = 0) -> CGPoint {
            let r = particle.radius * spread
            let a = angle(particle.angle, radius: particle.radius, clock: clock) + swirl + lag
            let x = r * cos(a)
            let y = r * sin(a) * tilt
            return CGPoint(
                x: centre.x + CGFloat(x * cosTurn - y * sinTurn) * reach,
                y: centre.y + CGFloat(x * sinTurn + y * cosTurn) * reach
            )
        }

        func dot(_ point: CGPoint, diameter: CGFloat, colour: Color.Resolved, alpha: Double) {
            guard alpha > 0.005 else { return }
            var shade = colour
            shade.opacity = Float(alpha) * colour.opacity
            let d = max(diameter, 0.35)
            graphics.fill(
                Path(ellipseIn: CGRect(x: point.x - d / 2, y: point.y - d / 2, width: d, height: d)),
                with: .color(Color(shade))
            )
        }

        for particle in field.particles {
            let twinkle = 0.85 + 0.15 * sin(clock * 1.7 + Double(particle.index))
            let colour = particle.isAccent ? accent : ink
            let alpha = particle.alpha * twinkle * eased
            let diameter = CGFloat(particle.size) * unit
            // Arm stars draw a short wake along their orbit, behind the turn:
            // it is what makes a field of dots read as a disc that *spins*,
            // and it traces the arms the jitter otherwise scatters. Inner
            // stars, which turn faster, leave longer wakes. Dust has none.
            if !particle.isDust {
                let step = trailStep * (0.6 + 0.8 * (1 - min(particle.radius, 1)))
                for (k, fade) in trailFades.enumerated() {
                    dot(
                        place(particle, lag: step * Double(k + 1)),
                        diameter: diameter * (0.85 - 0.12 * CGFloat(k)),
                        colour: colour,
                        alpha: alpha * fade
                    )
                }
            }
            dot(place(particle), diameter: diameter, colour: colour, alpha: alpha)
        }

        // The core: a soft disc that breathes, and six tight stars.
        let breath = 0.875 - 0.125 * cos(2 * .pi * clock / breathPeriod)
        let coreRadius = 0.11 * reach * spread
        var disc = coreInk
        disc.opacity = Float(0.9 * breath * eased) * coreInk.opacity
        var rim = coreInk
        rim.opacity = 0
        graphics.fill(
            Path(ellipseIn: CGRect(
                x: centre.x - coreRadius * 1.6, y: centre.y - coreRadius * 1.6 * CGFloat(tilt + 0.2),
                width: coreRadius * 3.2, height: coreRadius * 3.2 * CGFloat(tilt + 0.2)
            )),
            with: .radialGradient(
                Gradient(stops: [
                    .init(color: Color(disc), location: 0),
                    .init(color: Color(disc), location: 0.45),
                    .init(color: Color(rim), location: 1),
                ]),
                center: centre, startRadius: 0, endRadius: coreRadius * 1.6
            )
        )
        for star in field.core {
            dot(place(star), diameter: CGFloat(star.size) * unit, colour: coreInk, alpha: star.alpha * breath * eased)
        }
    }

    static func mix(_ a: Color.Resolved, _ b: Color.Resolved, _ amount: Float) -> Color.Resolved {
        Color.Resolved(
            colorSpace: .sRGBLinear,
            red: a.linearRed + (b.linearRed - a.linearRed) * amount,
            green: a.linearGreen + (b.linearGreen - a.linearGreen) * amount,
            blue: a.linearBlue + (b.linearBlue - a.linearBlue) * amount,
            opacity: a.opacity
        )
    }
}

// MARK: - Snapshot clock

public extension EnvironmentValues {
    /// A fixed clock for the galaxy, in seconds — offscreen snapshots render
    /// one exact frame. Nil (the default) runs on the real clock.
    @Entry var junoGalaxyClock: Double? = nil
}

#if DEBUG
#Preview("Galaxy") {
    HStack(spacing: 24) {
        JunoGalaxyMark(size: 16)
        JunoGalaxyMark(size: 24)
        JunoGalaxyMark(size: 64)
        JunoGalaxyMark(size: 64, active: false)
    }
    .padding()
}
#endif
