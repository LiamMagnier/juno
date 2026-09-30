import Foundation
import SwiftUI

// An agent's face: its identity and its status bar in one drawing.
//
// docs/design/AGENTS.md §4 is the argument. Grok Bot's insight, taken whole:
// the face is how a roster is read peripherally, and the eyes are how it says
// what the agent is doing, so there is no spinner beside it.
//
// Every number below is from the table in AGENTS.md §4.2b, which the web's
// `src/components/agents/agent-face.tsx` draws from too. Nothing is traced
// from a picture, so the Mac, the iPhone and the browser cannot drift by eye.
// The vocabulary is `src/lib/agents/avatar.ts` and `src/lib/agents/domain.ts`,
// word for word and in the same order — the order is load-bearing, because the
// seeded default indexes into it.

// MARK: - Vocabulary

/// The body a face is drawn on. `avatar.ts` `AGENT_SHAPES`, in order.
public enum JunoAgentShape: String, CaseIterable, Identifiable, Sendable {
    case orb, pebble, capsule, petal, bloom, spark, tile, halo, prism

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .tile: "Tile"
        case .halo: "Halo"
        case .prism: "Prism"
        case .orb: "Orb"
        case .pebble: "Pebble"
        case .capsule: "Capsule"
        case .petal: "Petal"
        case .bloom: "Bloom"
        case .spark: "Spark"
        }
    }
}

/// The body's colour: the same six hues the account accent offers, so an
/// agent's tone is always a colour the product already owns. `AGENT_TONES`.
public enum JunoAgentTone: String, CaseIterable, Identifiable, Sendable {
    case coral, juniper, teal, violet, amber, sage

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .coral: "Coral"
        case .juniper: "Juniper"
        case .teal: "Teal"
        case .violet: "Violet"
        case .amber: "Amber"
        case .sage: "Sage"
        }
    }

    /// The `--agent-*` pair, projected from globals.css by
    /// `npm run design:tokens` — read, never transcribed, so a retuned tone on
    /// the web reaches both apps without an edit here.
    public var token: JunoGeneratedPair {
        switch self {
        case .coral: JunoGeneratedColors.agentCoral
        case .juniper: JunoGeneratedColors.agentJuniper
        case .teal: JunoGeneratedColors.agentTeal
        case .violet: JunoGeneratedColors.agentViolet
        case .amber: JunoGeneratedColors.agentAmber
        case .sage: JunoGeneratedColors.agentSage
        }
    }

    /// The tone as an appearance-adaptive colour, through the same mechanism
    /// every other projected token uses.
    public var color: Color {
        Color.junoAdaptive(light: token.light, dark: token.dark)
    }
}

/// The resting cut of the eyes. States reshape them from here. `AGENT_EYES`.
public enum JunoAgentEyes: String, CaseIterable, Identifiable, Sendable {
    case soft, round, tall, wide

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .soft: "Soft"
        case .round: "Round"
        case .tall: "Tall"
        case .wide: "Wide"
        }
    }
}

/// One optional accessory. `none` is a real choice and the default for most.
/// `AGENT_MARKS`.
///
/// Spell it `JunoAgentMark.none` wherever the type could be read as optional:
/// a bare `.none` there is `Optional.none`, which is a different value.
public enum JunoAgentMark: String, CaseIterable, Identifiable, Sendable {
    case none, ring, spark, leaf, antenna, visor

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .none: "None"
        case .ring: "Ring"
        case .spark: "Spark"
        case .leaf: "Leaf"
        case .antenna: "Antenna"
        case .visor: "Visor"
        }
    }
}

/// What the face shows (AGENTS.md §4.2). `domain.ts` `AGENT_STATES`.
///
/// Six are derived on the server from the agent and its newest task. Two —
/// `thinking` (a reply is streaming) and `listening` (voice is open) — exist
/// only on a client that is watching it happen.
public enum JunoAgentState: String, CaseIterable, Identifiable, Sendable {
    case idle, thinking, working, waiting, blocked, done, sleeping, listening

    public var id: String { rawValue }

    /// `AGENT_STATE_LABEL`: the word said beside the face, because the face is
    /// never the only carrier of its state.
    public var label: String {
        switch self {
        case .idle: "Ready"
        case .thinking: "Thinking"
        case .working: "Working"
        case .waiting: "Needs you"
        case .blocked: "Stopped"
        case .done: "Done"
        case .sleeping: "Paused"
        case .listening: "Listening"
        }
    }

    /// States whose eyes are closed or replaced, so there is nothing to blink
    /// (`NO_BLINK` in face-rig.ts).
    var blinks: Bool {
        self != .sleeping && self != .done && self != .blocked
    }
}

// MARK: - The avatar

/// A face as data: four independent choices, each from a closed list, and
/// nothing else. What the server stores and what `/api/agents` returns.
public struct JunoAgentAvatar: Hashable, Sendable {
    public var shape: JunoAgentShape
    public var tone: JunoAgentTone
    public var eyes: JunoAgentEyes
    public var mark: JunoAgentMark

    public init(
        shape: JunoAgentShape,
        tone: JunoAgentTone,
        eyes: JunoAgentEyes,
        mark: JunoAgentMark = JunoAgentMark.none
    ) {
        self.shape = shape
        self.tone = tone
        self.eyes = eyes
        self.mark = mark
    }

    /// Reads a stored or received face back into the vocabulary, part by part.
    ///
    /// `normalizeAgentAvatar` in avatar.ts, ported: a face written by a newer
    /// build that knows a seventh shape keeps its tone, eyes and mark here and
    /// loses only the shape this build cannot draw, which falls back to the
    /// seeded default. Replacing the whole face because one field was unknown
    /// would be an agent that changed colour for no reason anyone could see.
    public init(shape: String?, tone: String?, eyes: String?, mark: String?, seed: String) {
        let fallback = Self.seeded(seed)
        self.shape = shape.flatMap(JunoAgentShape.init(rawValue:)) ?? fallback.shape
        self.tone = tone.flatMap(JunoAgentTone.init(rawValue:)) ?? fallback.tone
        self.eyes = eyes.flatMap(JunoAgentEyes.init(rawValue:)) ?? fallback.eyes
        self.mark = mark.flatMap(JunoAgentMark.init(rawValue:)) ?? fallback.mark
    }

    /// The face an agent starts with when nobody chose one.
    ///
    /// `defaultAgentAvatar` in avatar.ts, bit for bit: FNV-1a over the seed's
    /// UTF-16 code units (what JavaScript's `charCodeAt` walks), then
    /// `% count`, `/ 7` and `/ 53` exactly as the TypeScript does. It has to
    /// match, because a client drawing a row before the server's copy arrives
    /// must draw the face the server will store. The mark stays `none`: an
    /// accessory is a choice a person makes, not a dice roll.
    public static func seeded(_ seed: String) -> JunoAgentAvatar {
        let hash = seedHash(seed.isEmpty ? "agent" : seed)
        let shapes = JunoAgentShape.allCases
        let tones = JunoAgentTone.allCases
        let eyes = JunoAgentEyes.allCases
        return JunoAgentAvatar(
            shape: shapes[Int(hash % 6)],
            tone: tones[Int((hash / 7) % UInt32(tones.count))],
            eyes: eyes[Int((hash / 53) % UInt32(eyes.count))],
            mark: JunoAgentMark.none
        )
    }

    /// 32-bit FNV-1a. `Math.imul` and `>>> 0` in the TypeScript are exactly
    /// wrapping multiplication and an unsigned read, which is what `&*` on a
    /// `UInt32` already is.
    static func seedHash(_ seed: String) -> UInt32 {
        var hash: UInt32 = 0x811c_9dc5
        for unit in seed.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x0100_0193
        }
        return hash
    }
}

/// The five sizes a face is drawn at (AGENTS.md §4.3). The mark and the prop
/// are dropped below `sm`; the eyes never are.
public enum JunoAgentFaceSize {
    /// A sidebar row.
    public static let xs: CGFloat = 20
    /// A thread header, an activity row, a swatch.
    public static let sm: CGFloat = 28
    /// A roster card.
    public static let md: CGFloat = 48
    /// The agent page header, the hire preview.
    public static let lg: CGFloat = 96
    /// The hire arrival.
    public static let xl: CGFloat = 160
}

public extension Color {
    /// `--agent-ink`: the eyes, the happy arcs and the visor. One value in both
    /// appearances, because it is always drawn on a tone, never on the canvas.
    static let junoAgentInk = Color.junoAdaptive(
        light: JunoGeneratedColors.agentInk.light,
        dark: JunoGeneratedColors.agentInk.dark
    )

    /// `--agent-mark`: what is drawn OFF the body — the mark, the thinking
    /// dots, the laptop's strokes. The page is behind those rather than the
    /// tone, so they take the page's contrast: ink on paper in light, a warm
    /// off-white on charcoal in dark, where `junoAgentInk` would vanish.
    static let junoAgentMark = Color.junoAdaptive(
        light: JunoGeneratedColors.agentMark.light,
        dark: JunoGeneratedColors.agentMark.dark
    )
}

// MARK: - Geometry (AGENTS.md §4.2b)

/// Where a body puts its eyes, how large they are on it, and the box the body
/// fills: the web's fill-box, which is what its gradient and its
/// `transform-origin: 50% 100%` are measured against.
struct JunoAgentShapeSpec {
    let leftEye: CGPoint
    let rightEye: CGPoint
    let eyeScale: CGFloat
    let bounds: CGRect

    /// The centre the body breathes about.
    var center: CGPoint { CGPoint(x: bounds.midX, y: bounds.midY) }

    /// Bottom centre of the body, where the rig and the loops pivot.
    var foot: CGPoint { CGPoint(x: bounds.midX, y: bounds.maxY) }
}

extension JunoAgentShape {
    var spec: JunoAgentShapeSpec {
        switch self {
        case .tile:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 24, y: 32), rightEye: CGPoint(x: 40, y: 32),
                eyeScale: 0.9, bounds: CGRect(x: 6, y: 6, width: 52, height: 52)
            )
        case .halo:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 25, y: 33), rightEye: CGPoint(x: 39, y: 33),
                eyeScale: 0.85, bounds: CGRect(x: 4, y: 4, width: 56, height: 56)
            )
        case .prism:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 25, y: 32), rightEye: CGPoint(x: 39, y: 32),
                eyeScale: 0.85, bounds: CGRect(x: 4, y: 3.5, width: 56, height: 58)
            )
        case .orb:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 24, y: 31), rightEye: CGPoint(x: 40, y: 31),
                eyeScale: 1, bounds: CGRect(x: 6, y: 7, width: 52, height: 52)
            )
        case .pebble:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 24, y: 32), rightEye: CGPoint(x: 40, y: 32),
                eyeScale: 1, bounds: CGRect(x: 6, y: 9, width: 52, height: 48)
            )
        case .capsule:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 26, y: 29), rightEye: CGPoint(x: 38, y: 29),
                eyeScale: 0.9, bounds: CGRect(x: 12, y: 5, width: 40, height: 56)
            )
        case .petal:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 26, y: 34), rightEye: CGPoint(x: 42, y: 34),
                eyeScale: 1, bounds: CGRect(x: 8, y: 9, width: 50, height: 50)
            )
        case .bloom:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 25, y: 32), rightEye: CGPoint(x: 39, y: 32),
                eyeScale: 0.95, bounds: CGRect(x: 7, y: 8, width: 50, height: 50)
            )
        case .spark:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 27, y: 33), rightEye: CGPoint(x: 37, y: 33),
                eyeScale: 0.75, bounds: CGRect(x: 5, y: 5, width: 54, height: 56)
            )
        }
    }

    /// The body as one path in the 64-unit box. Bloom's five pieces are one
    /// path with every subpath wound the same way, so the nonzero fill is
    /// their union and one gradient lights all of it.
    var bodyPath: Path {
        switch self {
        case .tile:
            Path(roundedRect: CGRect(x: 6, y: 6, width: 52, height: 52), cornerRadius: 15, style: .circular)
        case .halo:
            Path { path in
                path.addEllipse(in: CGRect(x: 4, y: 4, width: 56, height: 56))
                path.addEllipse(in: CGRect(x: 27, y: 9, width: 10, height: 10))
            }
        case .prism:
            JunoAgentFacePath.path(.prism)
        case .orb:
            Path(ellipseIn: CGRect(x: 6, y: 7, width: 52, height: 52))
        case .pebble:
            Path(roundedRect: CGRect(x: 6, y: 9, width: 52, height: 48), cornerRadius: 20, style: .circular)
        case .capsule:
            Path(roundedRect: CGRect(x: 12, y: 5, width: 40, height: 56), cornerRadius: 20, style: .circular)
        case .petal:
            JunoAgentFacePath.path(.petal)
        case .bloom:
            Path { path in
                for centre in [CGPoint(x: 22, y: 23), CGPoint(x: 42, y: 23), CGPoint(x: 22, y: 43), CGPoint(x: 42, y: 43)] {
                    path.addEllipse(in: CGRect(x: centre.x - 15, y: centre.y - 15, width: 30, height: 30))
                }
                path.addRect(CGRect(x: 22, y: 23, width: 20, height: 20))
            }
        case .spark:
            JunoAgentFacePath.path(.spark)
        }
    }

    /// Halo's hole is cut with the even-odd rule, as the web's `fillRule`.
    var bodyFill: FillStyle {
        self == .halo ? FillStyle(eoFill: true) : FillStyle()
    }
}

/// An eye's resting cut, before the body's eye scale.
struct JunoAgentEyeCut {
    let width: CGFloat
    let height: CGFloat
    let radius: CGFloat
}

extension JunoAgentEyes {
    var cut: JunoAgentEyeCut {
        switch self {
        case .soft: JunoAgentEyeCut(width: 7, height: 9, radius: 2.5)
        case .round: JunoAgentEyeCut(width: 6.5, height: 6.5, radius: 3.25)
        case .tall: JunoAgentEyeCut(width: 5, height: 11, radius: 2.5)
        case .wide: JunoAgentEyeCut(width: 10, height: 5.5, radius: 2.75)
        }
    }
}

/// The paths of the face that are not primitives, in the 64-unit box.
enum JunoAgentFacePath {
    enum Kind: Equatable, Sendable {
        case petal
        case prism
        case spark
        case leaf
        case sparkMark
        case ringArc
        case antennaStem
        case happy(CGPoint, CGPoint)
    }

    static func path(_ kind: Kind) -> Path {
        var path = Path()
        switch kind {
        case .prism:
            path.move(to: CGPoint(x: 27, y: 5))
            path.addQuadCurve(to: CGPoint(x: 37, y: 5), control: CGPoint(x: 32, y: 2))
            path.addLine(to: CGPoint(x: 55, y: 16))
            path.addQuadCurve(to: CGPoint(x: 60, y: 25), control: CGPoint(x: 60, y: 19))
            path.addLine(to: CGPoint(x: 60, y: 40))
            path.addQuadCurve(to: CGPoint(x: 55, y: 49), control: CGPoint(x: 60, y: 46))
            path.addLine(to: CGPoint(x: 37, y: 60))
            path.addQuadCurve(to: CGPoint(x: 27, y: 60), control: CGPoint(x: 32, y: 63))
            path.addLine(to: CGPoint(x: 9, y: 49))
            path.addQuadCurve(to: CGPoint(x: 4, y: 40), control: CGPoint(x: 4, y: 46))
            path.addLine(to: CGPoint(x: 4, y: 25))
            path.addQuadCurve(to: CGPoint(x: 9, y: 16), control: CGPoint(x: 4, y: 19))
            path.closeSubpath()
        case .petal:
            // M8 9 H34 C48 9 58 21 58 35 C58 49 47 59 33 59 C19 59 8 48 8 34 Z
            path.move(to: CGPoint(x: 8, y: 9))
            path.addLine(to: CGPoint(x: 34, y: 9))
            path.addCurve(to: CGPoint(x: 58, y: 35), control1: CGPoint(x: 48, y: 9), control2: CGPoint(x: 58, y: 21))
            path.addCurve(to: CGPoint(x: 33, y: 59), control1: CGPoint(x: 58, y: 49), control2: CGPoint(x: 47, y: 59))
            path.addCurve(to: CGPoint(x: 8, y: 34), control1: CGPoint(x: 19, y: 59), control2: CGPoint(x: 8, y: 48))
            path.closeSubpath()
        case .spark:
            // M32 5 C36 22 42 28 59 33 C42 38 36 44 32 61 C28 44 22 38 5 33 C22 28 28 22 32 5 Z
            path.move(to: CGPoint(x: 32, y: 5))
            path.addCurve(to: CGPoint(x: 59, y: 33), control1: CGPoint(x: 36, y: 22), control2: CGPoint(x: 42, y: 28))
            path.addCurve(to: CGPoint(x: 32, y: 61), control1: CGPoint(x: 42, y: 38), control2: CGPoint(x: 36, y: 44))
            path.addCurve(to: CGPoint(x: 5, y: 33), control1: CGPoint(x: 28, y: 44), control2: CGPoint(x: 22, y: 38))
            path.addCurve(to: CGPoint(x: 32, y: 5), control1: CGPoint(x: 22, y: 28), control2: CGPoint(x: 28, y: 22))
            path.closeSubpath()
        case .leaf:
            // M44 18 C44 11 49 6 57 6 C57 13 52 18 44 18 Z
            path.move(to: CGPoint(x: 44, y: 18))
            path.addCurve(to: CGPoint(x: 57, y: 6), control1: CGPoint(x: 44, y: 11), control2: CGPoint(x: 49, y: 6))
            path.addCurve(to: CGPoint(x: 44, y: 18), control1: CGPoint(x: 57, y: 13), control2: CGPoint(x: 52, y: 18))
            path.closeSubpath()
        case .sparkMark:
            // M51 5 Q52.4 10.6 58 12 Q52.4 13.4 51 19 Q49.6 13.4 44 12 Q49.6 10.6 51 5 Z
            path.move(to: CGPoint(x: 51, y: 5))
            path.addQuadCurve(to: CGPoint(x: 58, y: 12), control: CGPoint(x: 52.4, y: 10.6))
            path.addQuadCurve(to: CGPoint(x: 51, y: 19), control: CGPoint(x: 52.4, y: 13.4))
            path.addQuadCurve(to: CGPoint(x: 44, y: 12), control: CGPoint(x: 49.6, y: 13.4))
            path.addQuadCurve(to: CGPoint(x: 51, y: 5), control: CGPoint(x: 49.6, y: 10.6))
            path.closeSubpath()
        case .ringArc:
            // The open ring centred (51, 12), r 5.5, open for 70° at the upper
            // right: the gap runs from -80° to -10°, so the stroke runs the
            // other 290°. Walked as points, so the direction is arithmetic.
            let points = stride(from: -10.0, through: 280.0, by: 5.0).map { degrees -> CGPoint in
                let radians = degrees * Double.pi / 180
                return CGPoint(x: 51 + 5.5 * cos(radians), y: 12 + 5.5 * sin(radians))
            }
            path.addLines(points)
        case .antennaStem:
            path.move(to: CGPoint(x: 32, y: 8))
            path.addLine(to: CGPoint(x: 32, y: 2.5))
        case .happy(let left, let right):
            // A happy arc per eye: (cx - 4, cy + 1.5) through (cx, cy - 3.5)
            // to (cx + 4, cy + 1.5).
            for eye in [left, right] {
                path.move(to: CGPoint(x: eye.x - 4, y: eye.y + 1.5))
                path.addQuadCurve(to: CGPoint(x: eye.x + 4, y: eye.y + 1.5), control: CGPoint(x: eye.x, y: eye.y - 3.5))
            }
        }
        return path
    }
}

// MARK: - Motion (face-rig.ts and agent-face.css)

/// One layer's transform in the drawing's 64-unit space, in the order CSS
/// composes `translate() rotate() scale()`: scale and rotate about the
/// layer's origin, then move. Plus the layer's opacity.
struct JunoFaceTransform: Equatable {
    var x: CGFloat = 0
    var y: CGFloat = 0
    /// Degrees, clockwise in the drawing's y-down space, as CSS `rotate()`.
    var rotation: Double = 0
    var scaleX: CGFloat = 1
    var scaleY: CGFloat = 1
    var opacity: Double = 1

    static let identity = JunoFaceTransform()

    init(x: CGFloat = 0, y: CGFloat = 0, rotation: Double = 0, scaleX: CGFloat = 1, scaleY: CGFloat = 1, opacity: Double = 1) {
        self.x = x
        self.y = y
        self.rotation = rotation
        self.scaleX = scaleX
        self.scaleY = scaleY
        self.opacity = opacity
    }

    init(x: CGFloat = 0, y: CGFloat = 0, rotation: Double = 0, scale: CGFloat, opacity: Double = 1) {
        self.init(x: x, y: y, rotation: rotation, scaleX: scale, scaleY: scale, opacity: opacity)
    }

    func interpolated(to other: JunoFaceTransform, _ t: Double) -> JunoFaceTransform {
        let f = CGFloat(t)
        return JunoFaceTransform(
            x: x + (other.x - x) * f,
            y: y + (other.y - y) * f,
            rotation: rotation + (other.rotation - rotation) * t,
            scaleX: scaleX + (other.scaleX - scaleX) * f,
            scaleY: scaleY + (other.scaleY - scaleY) * f,
            opacity: opacity + (other.opacity - opacity) * t
        )
    }

    /// This transform applied on top of `inner`: moves and turns add, scales
    /// and opacities multiply. Exact for the pairs the face stacks (a loop
    /// on a static tilt, a one-shot on a hover lift), which share an origin.
    func composed(with inner: JunoFaceTransform) -> JunoFaceTransform {
        JunoFaceTransform(
            x: x + inner.x,
            y: y + inner.y,
            rotation: rotation + inner.rotation,
            scaleX: scaleX * inner.scaleX,
            scaleY: scaleY * inner.scaleY,
            opacity: opacity * inner.opacity
        )
    }

    /// The affine transform about `anchor`, in the same units as the anchor.
    func affine(about anchor: CGPoint) -> CGAffineTransform {
        CGAffineTransform(translationX: anchor.x + x, y: anchor.y + y)
            .rotated(by: rotation * Double.pi / 180)
            .scaledBy(x: scaleX, y: scaleY)
            .translatedBy(x: -anchor.x, y: -anchor.y)
    }
}

/// A CSS `@keyframes` block: stops at fractions of the duration, with the
/// animation's timing function applied to each segment between two stops,
/// which is how CSS applies `animation-timing-function`.
struct JunoFaceKeyframes {
    let duration: TimeInterval
    let curve: UnitCurve
    let stops: [(at: Double, value: JunoFaceTransform)]

    init(_ duration: TimeInterval, _ curve: UnitCurve, _ stops: [(at: Double, value: JunoFaceTransform)]) {
        self.duration = duration
        self.curve = curve
        self.stops = stops
    }

    /// The value at `fraction` (0...1) of one pass.
    func sample(_ fraction: Double) -> JunoFaceTransform {
        guard let first = stops.first, let last = stops.last else { return .identity }
        let f = min(max(fraction, 0), 1)
        if f <= first.at { return first.value }
        if f >= last.at { return last.value }
        for index in 0..<(stops.count - 1) {
            let from = stops[index]
            let to = stops[index + 1]
            guard f >= from.at, f <= to.at else { continue }
            let span = to.at - from.at
            let local = span > 0 ? (f - from.at) / span : 1
            return from.value.interpolated(to: to.value, curve.value(at: local))
        }
        return last.value
    }

    /// A looping animation, `elapsed` seconds after it started (a negative
    /// `elapsed` is still inside its delay and loops from the start anyway,
    /// which keeps staggered parts in phase with each other).
    func loop(elapsed: TimeInterval, delay: TimeInterval = 0) -> JunoFaceTransform {
        let t = elapsed - delay
        let phase = t.truncatingRemainder(dividingBy: duration)
        return sample((phase < 0 ? phase + duration : phase) / duration)
    }

    /// A one-shot, `elapsed` seconds in; nil once it has finished or before
    /// it has begun, when the layer is at rest.
    func once(elapsed: TimeInterval) -> JunoFaceTransform? {
        guard elapsed >= 0, elapsed <= duration else { return nil }
        return sample(elapsed / duration)
    }
}

/// The face's motion as data: every number from `face-rig.ts` and
/// `agent-face.css`, and pure functions of time over them, so a test can hold
/// any moment still and the drawing is one function of its inputs.
enum JunoAgentFaceRig {
    // MARK: Curves

    static let breathe = JunoMotion.unitCurve(JunoGeneratedEasing.breathe)
    static let inOut = JunoMotion.unitCurve(JunoGeneratedEasing.inOut)
    static let outSoft = JunoMotion.unitCurve(JunoGeneratedEasing.outSoft)
    /// `--face-spring`: cubic-bezier(0.34, 1.4, 0.64, 1), the face's own
    /// overshoot for eye shapes and the hover lift.
    static let faceSpring = UnitCurve.bezier(
        startControlPoint: UnitPoint(x: 0.34, y: 1.4),
        endControlPoint: UnitPoint(x: 0.64, y: 1)
    )

    // MARK: Gaze

    /// How far the eyes travel at full strength, in drawing units.
    static let maxGazeX: CGFloat = 3.4
    static let maxGazeY: CGFloat = 2.6
    /// A pointer still for this long is no longer somebody there.
    static let pointerStale: TimeInterval = 5

    /// `GAZE_GAIN`: how much each state lets the pointer pull the eyes.
    static func gazeGain(_ state: JunoAgentState) -> CGFloat {
        switch state {
        case .idle: 1
        case .waiting: 1.15
        case .listening: 0.9
        case .done: 0.8
        case .thinking: 0.25
        case .working: 0.35
        case .blocked: 0.5
        case .sleeping: 0
        }
    }

    /// Where the eyes look, in drawing units: at the pointer while it is
    /// within reach (reach grows with the face), with an ease-out falloff, and
    /// straight at you when you are right on top of the face; otherwise at
    /// the idle glance. Both scaled by the state's gain. `update()` in
    /// face-rig.ts.
    static func gazeTarget(
        pointer: CGPoint?,
        faceFrame frame: CGRect,
        state: JunoAgentState,
        idle: CGPoint
    ) -> CGSize {
        let gain = gazeGain(state)
        if let pointer, gain > 0 {
            let dx = pointer.x - frame.midX
            let dy = pointer.y - frame.midY
            let distance = (dx * dx + dy * dy).squareRoot()
            let reach = max(280, frame.width * 6)
            if distance < reach {
                let t = 1 - distance / reach
                let strength = (1 - (1 - t) * (1 - t)) * gain
                let near = min(1, distance / max(24, frame.width * 0.6))
                let ux = distance > 0 ? dx / distance : 0
                let uy = distance > 0 ? dy / distance : 0
                return CGSize(width: ux * maxGazeX * strength * near, height: uy * maxGazeY * strength * near)
            }
        }
        return CGSize(width: idle.x * gain, height: idle.y * gain)
    }

    /// The next idle glance: mostly ahead, sometimes aside. Returns the delay
    /// before it and where it looks. `scheduleGlance`.
    static func nextGlance(using random: inout some RandomNumberGenerator) -> (delay: TimeInterval, target: CGPoint) {
        let delay = Double.random(in: 1.8...5.2, using: &random)
        let ahead = Double.random(in: 0..<1, using: &random) < 0.45
        if ahead { return (delay, .zero) }
        let x = CGFloat(Double.random(in: -1...1, using: &random)) * maxGazeX * 0.7
        let y = CGFloat(Double.random(in: -0.6...0.8, using: &random)) * maxGazeY * 0.6
        return (delay, CGPoint(x: x, y: y))
    }

    /// How long the eyes take to reach a new target: the web's 200ms on
    /// `--ease-out-soft`.
    static let gazeDuration: TimeInterval = 0.2

    // MARK: Blink

    /// The next blink: 2.6 to 6.4 seconds away, twice about one time in six.
    /// `scheduleBlink`.
    static func nextBlink(using random: inout some RandomNumberGenerator) -> (delay: TimeInterval, twice: Bool) {
        (Double.random(in: 2.6...6.4, using: &random), Double.random(in: 0..<1, using: &random) < 0.16)
    }

    /// Closed for 95ms (the lids take 80ms to get there), open over 80ms, and
    /// a second one 150ms after the first has opened.
    static let blinkClose: TimeInterval = 0.08
    static let blinkHold: TimeInterval = 0.095
    static let blinkGap: TimeInterval = 0.15

    /// When each blink of one starts, relative to the first.
    static func blinkStarts(twice: Bool) -> [TimeInterval] {
        twice ? [0, blinkHold + blinkGap] : [0]
    }

    /// The lids' height (1 open, 0.08 shut) `elapsed` seconds into a blink.
    static func lid(elapsed: TimeInterval) -> CGFloat {
        guard elapsed >= 0 else { return 1 }
        if elapsed < blinkHold {
            let p = inOut.value(at: min(elapsed / blinkClose, 1))
            return CGFloat(1 + (0.08 - 1) * p)
        }
        let opening = elapsed - blinkHold
        guard opening < blinkClose else { return 1 }
        let p = inOut.value(at: opening / blinkClose)
        return CGFloat(0.08 + (1 - 0.08) * p)
    }

    // MARK: State loops

    /// `.agent-face__all`'s loop per state, about the body's foot.
    static func loop(_ state: JunoAgentState) -> JunoFaceKeyframes? {
        switch state {
        case .idle:
            JunoFaceKeyframes(5.6, breathe, [
                (0, .identity), (0.5, JunoFaceTransform(scaleX: 1.014, scaleY: 1.022)), (1, .identity),
            ])
        case .sleeping:
            JunoFaceKeyframes(6.4, breathe, [
                (0, JunoFaceTransform(y: 0.8)), (0.5, JunoFaceTransform(y: 0.8, scaleX: 1.02, scaleY: 1.035)), (1, JunoFaceTransform(y: 0.8)),
            ])
        case .thinking:
            JunoFaceKeyframes(4.4, breathe, [
                (0, JunoFaceTransform(rotation: -2.2)), (0.5, JunoFaceTransform(rotation: 2.2)), (1, JunoFaceTransform(rotation: -2.2)),
            ])
        case .working:
            JunoFaceKeyframes(1.35, inOut, [
                (0, JunoFaceTransform(scaleX: 1.012, scaleY: 0.986)),
                (0.45, JunoFaceTransform(y: -1.6, scaleX: 0.994, scaleY: 1.008)),
                (1, JunoFaceTransform(scaleX: 1.012, scaleY: 0.986)),
            ])
        case .waiting:
            // Still for a while, then a small "over here", then still again.
            JunoFaceKeyframes(3.4, inOut, [
                (0, .identity), (0.62, .identity),
                (0.70, JunoFaceTransform(y: -2.6, rotation: -5)),
                (0.78, .identity),
                (0.85, JunoFaceTransform(y: -1.2, rotation: 3.5)),
                (0.92, .identity), (1, .identity),
            ])
        case .blocked, .done, .listening:
            nil
        }
    }

    /// `.agent-face__all`'s resting transform, under any loop: blocked tilts.
    static func allRest(_ state: JunoAgentState) -> JunoFaceTransform {
        state == .blocked ? JunoFaceTransform(y: 0.6, rotation: -4) : .identity
    }

    /// `.agent-face__eyes`'s loop: reading along lines while working, a
    /// slow ponder while thinking.
    static func eyesLoop(_ state: JunoAgentState) -> JunoFaceKeyframes? {
        switch state {
        case .working:
            JunoFaceKeyframes(2.7, inOut, [
                (0, JunoFaceTransform(x: -2.2, y: -0.5)),
                (0.4, JunoFaceTransform(x: 2.2, y: -0.5)),
                (0.5, JunoFaceTransform(x: -2.2, y: 0.7)),
                (0.9, JunoFaceTransform(x: 2.2, y: 0.7)),
                (1, JunoFaceTransform(x: -2.2, y: -0.5)),
            ])
        case .thinking:
            JunoFaceKeyframes(3.6, breathe, [
                (0, .identity), (0.35, JunoFaceTransform(x: 0.9, y: -0.5)), (0.7, JunoFaceTransform(x: -0.4, y: 0.3)), (1, .identity),
            ])
        default:
            nil
        }
    }

    /// The ground shadow while working: it tightens as the body lifts.
    static let groundBob = JunoFaceKeyframes(1.35, inOut, [
        (0, .identity), (0.45, JunoFaceTransform(scale: 0.86, opacity: 0.7)), (1, .identity),
    ])

    /// One rising thought dot. The three run 0.22s apart.
    static let thought = JunoFaceKeyframes(2.1, outSoft, [
        (0, JunoFaceTransform(x: -2.5, y: 2.5, scale: 0.4, opacity: 0)),
        (0.3, JunoFaceTransform(scale: 1, opacity: 0.85)),
        (0.7, JunoFaceTransform(x: 0.4, y: -0.4, scale: 1, opacity: 0.85)),
        (1, JunoFaceTransform(x: 1, y: -1.5, scale: 0.8, opacity: 0)),
    ])
    static let thoughtDelays: [TimeInterval] = [0, 0.22, 0.44]

    /// One work bar's glow. The three run 0.16s apart.
    static let workBar = JunoFaceKeyframes(1.35, inOut, [
        (0, JunoFaceTransform(opacity: 0.25)), (0.4, JunoFaceTransform(opacity: 0.85)), (1, JunoFaceTransform(opacity: 0.25)),
    ])
    static let workBarDelays: [TimeInterval] = [0, 0.16, 0.32]

    // MARK: One-shots

    /// Done: one hop with a squash either side of it.
    static let hop = JunoFaceKeyframes(0.76, outSoft, [
        (0, .identity),
        (0.16, JunoFaceTransform(y: 0.6, scaleX: 1.07, scaleY: 0.9)),
        (0.44, JunoFaceTransform(y: -5.5, scaleX: 0.95, scaleY: 1.06)),
        (0.70, JunoFaceTransform(scaleX: 1.06, scaleY: 0.93)),
        (0.86, JunoFaceTransform(scaleX: 0.99, scaleY: 1.01)),
        (1, .identity),
    ])

    static let hopGround = JunoFaceKeyframes(0.76, outSoft, [
        (0, .identity), (0.16, .identity), (0.44, JunoFaceTransform(scale: 0.7, opacity: 0.5)), (0.70, .identity), (1, .identity),
    ])

    /// Any other change of state: a small settle, so the change is seen.
    static let react = JunoFaceKeyframes(0.52, outSoft, [
        (0, JunoFaceTransform(scale: 0.94)), (0.55, JunoFaceTransform(scale: 1.04)), (1, .identity),
    ])

    // MARK: Eye shapes

    /// Each eye's resting shape for a state, about its own centre. `h` is the
    /// eye's scaled height, so the flat states squash it to a 2-unit bar.
    static func eyeRest(_ state: JunoAgentState, height h: CGFloat, level: CGFloat = 0) -> JunoFaceTransform {
        let bar = h > 0 ? 2 / h : 1
        switch state {
        case .idle, .done:
            return .identity
        case .thinking:
            return JunoFaceTransform(x: 1.6, y: -2.4, scaleX: 1, scaleY: 0.8)
        case .working:
            return JunoFaceTransform(scaleX: 1.02, scaleY: 0.74)
        case .waiting:
            return JunoFaceTransform(scale: 1.2)
        case .listening:
            return JunoFaceTransform(scale: 1.15 + min(max(level, 0), 1) * 0.3)
        case .blocked:
            return JunoFaceTransform(scaleX: 1.3, scaleY: bar)
        case .sleeping:
            return JunoFaceTransform(y: 2, scaleX: 1.3, scaleY: bar)
        }
    }

    static let eyeShapeDuration: TimeInterval = 0.26
    static let happyDuration: TimeInterval = 0.32
    static let lidFadeDuration: TimeInterval = 0.16

    // MARK: Hover and press

    /// The hover lift and the press squash, on `.agent-face__rig`.
    static let hoverLift = JunoFaceTransform(y: -1.8)
    static let pressSquash = JunoFaceTransform(y: 0.5, scaleX: 1.06, scaleY: 0.92)
    static let hoverDuration: TimeInterval = 0.42
    static let pressDuration: TimeInterval = 0.09

    /// Whether hovering widens the eyes in this state.
    static func widensOnHover(_ state: JunoAgentState) -> Bool {
        state == .idle || state == .waiting || state == .done
    }

    /// A transition from `from` to `to` begun `elapsed` seconds ago over
    /// `duration` on `curve`.
    static func transition(
        from: JunoFaceTransform,
        to: JunoFaceTransform,
        elapsed: TimeInterval,
        duration: TimeInterval,
        curve: UnitCurve
    ) -> JunoFaceTransform {
        guard duration > 0, elapsed < duration else { return to }
        guard elapsed > 0 else { return from }
        return from.interpolated(to: to, curve.value(at: elapsed / duration))
    }
}

/// Everything that moves, for one frame: each layer's transform in the order
/// the web stacks them (rig > all > gaze > eyes > lids > eye).
struct JunoAgentFacePose: Equatable {
    var rig: JunoFaceTransform = .identity
    var all: JunoFaceTransform = .identity
    var gaze: CGSize = .zero
    var eyes: JunoFaceTransform = .identity
    var eye: JunoFaceTransform = .identity
    var lids: CGFloat = 1
    var lidsOpacity: Double = 1
    var happy: JunoFaceTransform = JunoFaceTransform(scale: 0.7, opacity: 0)
    var glintOpacity: Double = 1
    var ground: JunoFaceTransform = .identity
    var thoughts: [JunoFaceTransform] = Array(repeating: JunoFaceTransform(opacity: 0), count: 3)
    var bars: [Double] = [0, 0, 0]

    /// The pose a state holds with nothing moving: the eyes' shape still
    /// says the state under Reduce Motion, as the web's does.
    static func still(_ state: JunoAgentState, eyeHeight: CGFloat, level: CGFloat = 0) -> JunoAgentFacePose {
        var pose = JunoAgentFacePose()
        pose.all = JunoAgentFaceRig.allRest(state)
        pose.eye = JunoAgentFaceRig.eyeRest(state, height: eyeHeight, level: level)
        if state == .done {
            pose.lidsOpacity = 0
            pose.happy = .identity
        }
        if state == .sleeping { pose.glintOpacity = 0 }
        if state == .thinking {
            pose.thoughts = Array(repeating: JunoFaceTransform(opacity: 0.6), count: 3)
        }
        if state == .working { pose.bars = [0.55, 0.55, 0.55] }
        return pose
    }
}

/// What the rig knows about one face at one moment, beyond the clock.
struct JunoAgentFaceRigInput {
    var state: JunoAgentState
    var previousState: JunoAgentState?
    /// When the state last changed (or the face appeared), on the clock.
    var stateSince: TimeInterval
    /// Whether the face appeared in this state rather than changed into it:
    /// the done hop plays either way, the settle only on a change.
    var appeared: Bool
    var eyeHeight: CGFloat
    var level: CGFloat = 0
    var hovered: Bool = false
    var hoverSince: TimeInterval = -.infinity
    var pressed: Bool = false
    var pressSince: TimeInterval = -.infinity
    var gazeFrom: CGSize = .zero
    var gazeTo: CGSize = .zero
    var gazeSince: TimeInterval = -.infinity
    /// Start times of the blinks in flight.
    var blinks: [TimeInterval] = []
}

extension JunoAgentFaceRig {
    /// The whole face at `now`. Under Reduce Motion, the still pose.
    static func pose(_ input: JunoAgentFaceRigInput, now: TimeInterval, reduceMotion: Bool) -> JunoAgentFacePose {
        let state = input.state
        var pose = JunoAgentFacePose.still(state, eyeHeight: input.eyeHeight, level: input.level)
        guard !reduceMotion else { return pose }
        let elapsed = now - input.stateSince

        // The loop on `all`, over the state's resting tilt.
        if let loop = loop(state) {
            pose.all = loop.loop(elapsed: elapsed).composed(with: allRest(state))
        }
        if let eyes = eyesLoop(state) {
            pose.eyes = eyes.loop(elapsed: elapsed)
        }
        if state == .working {
            pose.ground = groundBob.loop(elapsed: elapsed)
            pose.bars = workBarDelays.map { workBar.loop(elapsed: elapsed, delay: $0).opacity }
        }
        if state == .thinking {
            pose.thoughts = thoughtDelays.map { thought.loop(elapsed: elapsed, delay: $0) }
        }

        // Eye shape: from the last state's to this one's, on the face spring.
        if let previous = input.previousState, previous != state {
            pose.eye = transition(
                from: eyeRest(previous, height: input.eyeHeight, level: input.level),
                to: pose.eye,
                elapsed: elapsed,
                duration: eyeShapeDuration,
                curve: faceSpring
            )
            if state == .done {
                let shape = transition(from: JunoFaceTransform(scale: 0.7), to: .identity, elapsed: elapsed, duration: happyDuration, curve: faceSpring)
                let fade = transition(from: JunoFaceTransform(opacity: 0), to: .identity, elapsed: elapsed, duration: lidFadeDuration, curve: outSoft)
                pose.happy = JunoFaceTransform(scaleX: shape.scaleX, scaleY: shape.scaleY, opacity: fade.opacity)
            }
            if state == .done || previous == .done {
                let from = previous == .done ? 0.0 : 1.0
                let to = state == .done ? 0.0 : 1.0
                pose.lidsOpacity = transition(
                    from: JunoFaceTransform(opacity: from), to: JunoFaceTransform(opacity: to),
                    elapsed: elapsed, duration: lidFadeDuration, curve: outSoft
                ).opacity
            }
        }

        // Hover and press on the rig; the hovered eyes widen.
        if state != .sleeping {
            let lift = transition(
                from: input.hovered ? .identity : hoverLift,
                to: input.hovered ? hoverLift : .identity,
                elapsed: now - input.hoverSince,
                duration: hoverDuration,
                curve: faceSpring
            )
            pose.rig = lift
            if widensOnHover(state) {
                let widen = transition(
                    from: JunoFaceTransform(scale: input.hovered ? 1 : 1.1),
                    to: JunoFaceTransform(scale: input.hovered ? 1.1 : 1),
                    elapsed: now - input.hoverSince,
                    duration: eyeShapeDuration,
                    curve: faceSpring
                )
                pose.eyes = pose.eyes.composed(with: widen)
            }
        }
        let squash = transition(
            from: input.pressed ? .identity : pressSquash,
            to: input.pressed ? pressSquash : .identity,
            elapsed: now - input.pressSince,
            duration: pressDuration,
            curve: faceSpring
        )
        if input.pressed || now - input.pressSince < pressDuration {
            pose.rig = squash
        }

        // One-shots on the rig: the done hop, or a settle on any other change.
        if state == .done, let hop = hop.once(elapsed: elapsed) {
            pose.rig = hop
            pose.ground = hopGround.once(elapsed: elapsed) ?? .identity
        } else if !input.appeared, input.previousState != nil, input.previousState != state,
            let settle = react.once(elapsed: elapsed)
        {
            pose.rig = settle.composed(with: pose.rig)
        }

        // Gaze, eased toward its target; blinks on the lids.
        pose.gaze = {
            let t = transition(
                from: JunoFaceTransform(x: input.gazeFrom.width, y: input.gazeFrom.height),
                to: JunoFaceTransform(x: input.gazeTo.width, y: input.gazeTo.height),
                elapsed: now - input.gazeSince,
                duration: gazeDuration,
                curve: outSoft
            )
            return CGSize(width: t.x, height: t.y)
        }()
        if state.blinks {
            pose.lids = input.blinks.map { lid(elapsed: now - $0) }.min() ?? 1
        }
        return pose
    }
}

// MARK: - Pointer and trigger

/// The pointer, as the faces inside a region see it: one hover tracker for
/// the whole region, so a roster of faces all look at the same pointer, and
/// each face reads its own frame in the region's space. The web's single
/// shared listener in `face-rig.ts`.
@MainActor
@Observable
public final class JunoAgentGazeField {
    /// The coordinate space the region names.
    public static let space = "juno.agent-gaze"

    /// The pointer in the region's space, or nil when it is outside it.
    public internal(set) var pointer: CGPoint?
    /// When the pointer last moved.
    public internal(set) var movedAt: Date = .distantPast

    public init() {}

    /// The pointer if it moved recently enough to be somebody there.
    func livePointer(at now: Date) -> CGPoint? {
        guard let pointer, now.timeIntervalSince(movedAt) < JunoAgentFaceRig.pointerStale else { return nil }
        return pointer
    }
}

public extension EnvironmentValues {
    /// The gaze region the face is in, if any.
    @Entry var junoAgentGazeField: JunoAgentGazeField? = nil
    /// The control a face belongs to, hovered or pressed: the face notices.
    @Entry var junoAgentFaceTrigger: JunoAgentFaceTrigger = JunoAgentFaceTrigger()
}

/// Whether the control a face sits in is hovered or pressed.
public struct JunoAgentFaceTrigger: Equatable, Sendable {
    public var hovered = false
    public var pressed = false

    public init(hovered: Bool = false, pressed: Bool = false) {
        self.hovered = hovered
        self.pressed = pressed
    }
}

public extension View {
    /// Makes this view a region whose faces look at the pointer: the web's
    /// window-wide gaze, scoped to the page that holds the faces.
    func junoAgentGazeField() -> some View {
        modifier(JunoAgentGazeFieldModifier())
    }

    /// Makes this view the control its faces belong to: hovering it lifts
    /// them and makes them blink, as the web's `data-face-trigger` does.
    /// Buttons take ``JunoAgentFaceButtonStyle`` instead, which also squashes
    /// the face on press.
    func junoAgentFaceTrigger() -> some View {
        modifier(JunoAgentFaceTriggerModifier())
    }
}

private struct JunoAgentGazeFieldModifier: ViewModifier {
    @State private var field = JunoAgentGazeField()

    func body(content: Content) -> some View {
        content
            .coordinateSpace(.named(JunoAgentGazeField.space))
            .onContinuousHover(coordinateSpace: .named(JunoAgentGazeField.space)) { phase in
                switch phase {
                case .active(let location):
                    field.pointer = location
                    field.movedAt = Date()
                case .ended:
                    field.pointer = nil
                }
            }
            .environment(\.junoAgentGazeField, field)
    }
}

private struct JunoAgentFaceTriggerModifier: ViewModifier {
    @State private var hovered = false
    @Environment(\.junoAgentFaceTrigger) private var outer

    func body(content: Content) -> some View {
        content
            .onHover { hovered = $0 }
            .environment(\.junoAgentFaceTrigger, JunoAgentFaceTrigger(hovered: hovered || outer.hovered, pressed: outer.pressed))
    }
}

/// A plain button whose label's faces notice it: hover lifts them, press
/// squashes them. No chrome of its own; the label draws the control.
public struct JunoAgentFaceButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        Styled(configuration: configuration)
    }

    private struct Styled: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovered = false

        var body: some View {
            configuration.label
                .contentShape(.rect)
                .onHover { hovered = $0 }
                .environment(
                    \.junoAgentFaceTrigger,
                    JunoAgentFaceTrigger(hovered: hovered, pressed: configuration.isPressed)
                )
        }
    }
}

public extension ButtonStyle where Self == JunoAgentFaceButtonStyle {
    static var junoAgentFace: JunoAgentFaceButtonStyle { JunoAgentFaceButtonStyle() }
}

// MARK: - The face

/// An agent's face, drawn natively from the numbers in AGENTS.md §4.2b and
/// moved by the web's face rig.
///
/// **Drawing.** The body is lit: a soft top-left key, the tone itself, a
/// deeper rim. The eyes carry catchlights and the face stands on a ground
/// shadow once it is 40pt or larger; the mark and the thinking and working
/// details are dropped below 28pt. The eyes never are.
///
/// **Motion.** Three layers, as on the web. The rig makes every face present:
/// it blinks every few seconds (sometimes twice), glances around, looks at
/// the pointer inside a ``SwiftUI/View/junoAgentGazeField()`` region, and
/// notices when its control is hovered (lifts, eyes widen, one blink) or
/// pressed (squash). The state is a behaviour: idle breathes, working bobs
/// and reads with its work bars glowing, thinking sways and ponders with
/// thought dots rising, waiting lifts and tilts "over here" every 3.4s, done
/// squints happily and hops once, sleeping breathes slowly with its eyes
/// shut, blocked tilts with flat eyes, listening follows `level`. A change of
/// state is a visible settle, not a cut. Everything is a pure function of
/// time (``JunoAgentFaceRig``), drawn in one `Canvas` on a `TimelineView`.
///
/// **Reduce Motion** stops all of it: the shapes still carry the state.
///
/// **Words.** With a `name`, the face is one image labelled "Atlas,
/// working". Without one it is hidden from assistive technology, because a
/// caller that omits the name prints the name and the sentence beside it.
public struct JunoAgentFace: View {
    private let avatar: JunoAgentAvatar
    private let state: JunoAgentState
    private let size: CGFloat
    private let name: String?
    private let level: CGFloat
    private let live: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.junoAgentGazeField) private var gazeField
    @Environment(\.junoAgentFaceTrigger) private var trigger

    @State private var epoch = Date.timeIntervalSinceReferenceDate
    @State private var previousState: JunoAgentState?
    @State private var appeared = true
    @State private var ownHover = false
    @State private var ownPointer: CGPoint?
    @State private var hoverSince: TimeInterval = -.infinity
    @State private var pressSince: TimeInterval = -.infinity
    @State private var frameInField: CGRect = .zero
    @State private var idleGlance: CGPoint = .zero
    @State private var gazeFrom: CGSize = .zero
    @State private var gazeTo: CGSize = .zero
    @State private var gazeSince: TimeInterval = -.infinity
    @State private var blinks: [TimeInterval] = []

    /// - Parameters:
    ///   - level: while `listening`, the caller's voice level (0...1); the
    ///     eyes widen with it.
    ///   - live: on the rig (blinks, glances, gaze, hover). Off for faces that
    ///     are pictures of a choice, like the face builder's swatches.
    public init(
        avatar: JunoAgentAvatar,
        state: JunoAgentState = .idle,
        size: CGFloat = JunoAgentFaceSize.md,
        name: String? = nil,
        level: CGFloat = 0,
        live: Bool = true
    ) {
        self.avatar = avatar
        self.state = state
        self.size = size
        self.name = name
        self.level = level
        self.live = live
    }

    private var accessibilityText: String {
        guard let name else { return state.label }
        return "\(name), \(state.label.lowercased())"
    }

    /// The mark and the thinking and working details need 28pt.
    private var isDetailed: Bool { size >= JunoAgentFaceSize.sm }
    /// Light, catchlights and the ground shadow need 40pt.
    private var isRich: Bool { size >= 40 }

    private var eyeHeight: CGFloat {
        avatar.eyes.cut.height * avatar.shape.spec.eyeScale
    }

    private var hovered: Bool { ownHover || trigger.hovered }

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { context in
            let now = context.date.timeIntervalSinceReferenceDate
            let pose = JunoAgentFaceRig.pose(rigInput, now: now, reduceMotion: reduceMotion)
            Canvas(opaque: false, rendersAsynchronously: false) { canvas, _ in
                draw(pose, in: &canvas)
            }
        }
        .frame(width: size, height: size)
        .onContinuousHover { phase in
            switch phase {
            case .active(let location):
                ownPointer = location
                if !ownHover { ownHover = true }
            case .ended:
                ownPointer = nil
                ownHover = false
            }
        }
        .onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .named(JunoAgentGazeField.space))
        } action: { frame in
            frameInField = frame
        }
        .onChange(of: state) { old, _ in
            previousState = old
            appeared = false
            epoch = Date.timeIntervalSinceReferenceDate
            aim()
        }
        .onChange(of: hovered) { _, now in
            hoverSince = Date.timeIntervalSinceReferenceDate
            // Hovering the control it belongs to: it noticed.
            if now { blink(twice: false) }
        }
        .onChange(of: trigger.pressed) { _, _ in
            pressSince = Date.timeIntervalSinceReferenceDate
        }
        .onChange(of: gazeField?.pointer) { _, _ in aim() }
        .onChange(of: ownPointer) { _, _ in aim() }
        .task(id: live && !reduceMotion) { await blinkLoop() }
        .task(id: live && !reduceMotion) { await glanceLoop() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: accessibilityText))
        .accessibilityAddTraits(.isImage)
        .accessibilityHidden(name == nil)
    }

    private var rigInput: JunoAgentFaceRigInput {
        JunoAgentFaceRigInput(
            state: state,
            previousState: previousState,
            stateSince: epoch,
            appeared: appeared,
            eyeHeight: eyeHeight,
            level: level,
            hovered: live && hovered,
            hoverSince: hoverSince,
            pressed: live && trigger.pressed,
            pressSince: pressSince,
            gazeFrom: gazeFrom,
            gazeTo: gazeTo,
            gazeSince: gazeSince,
            blinks: blinks
        )
    }

    // MARK: Rig loops

    /// Points the eyes at the pointer, or at the idle glance, easing from
    /// wherever they are now.
    private func aim() {
        guard live, !reduceMotion else { return }
        let now = Date()
        let target: CGSize
        if let pointer = gazeField?.livePointer(at: now), frameInField != .zero {
            target = JunoAgentFaceRig.gazeTarget(pointer: pointer, faceFrame: frameInField, state: state, idle: idleGlance)
        } else if let ownPointer {
            let local = CGRect(x: 0, y: 0, width: size, height: size)
            target = JunoAgentFaceRig.gazeTarget(pointer: ownPointer, faceFrame: local, state: state, idle: idleGlance)
        } else {
            target = JunoAgentFaceRig.gazeTarget(pointer: nil, faceFrame: .zero, state: state, idle: idleGlance)
        }
        guard abs(target.width - gazeTo.width) > 0.02 || abs(target.height - gazeTo.height) > 0.02 else { return }
        let t = now.timeIntervalSinceReferenceDate
        let current = JunoAgentFaceRig.pose(rigInput, now: t, reduceMotion: false).gaze
        gazeFrom = current
        gazeTo = target
        gazeSince = t
    }

    private func blink(twice: Bool) {
        guard live, !reduceMotion, state.blinks else { return }
        let now = Date.timeIntervalSinceReferenceDate
        let fresh = JunoAgentFaceRig.blinkStarts(twice: twice).map { now + $0 }
        blinks = blinks.filter { now - $0 < 1 } + fresh
    }

    private func blinkLoop() async {
        guard live, !reduceMotion else { return }
        var random = SystemRandomNumberGenerator()
        while !Task.isCancelled {
            let next = JunoAgentFaceRig.nextBlink(using: &random)
            try? await Task.sleep(for: .seconds(next.delay))
            guard !Task.isCancelled else { return }
            blink(twice: next.twice)
        }
    }

    private func glanceLoop() async {
        guard live, !reduceMotion else { return }
        var random = SystemRandomNumberGenerator()
        while !Task.isCancelled {
            let next = JunoAgentFaceRig.nextGlance(using: &random)
            try? await Task.sleep(for: .seconds(next.delay))
            guard !Task.isCancelled else { return }
            idleGlance = next.target
            aim()
        }
    }

    // MARK: Drawing

    private func draw(_ pose: JunoAgentFacePose, in canvas: inout GraphicsContext) {
        let spec = avatar.shape.spec
        let unit = size / 64
        canvas.scaleBy(x: unit, y: unit)
        let tone = avatar.tone.color

        if isRich {
            var ground = canvas
            ground.concatenate(pose.ground.affine(about: CGPoint(x: 32, y: 62.5)))
            ground.opacity = pose.ground.opacity
            let shadow = colorScheme == .dark ? Color.black.opacity(0.32) : Color.junoAgentInk.opacity(0.14)
            ground.fill(Path(ellipseIn: CGRect(x: 16, y: 60.1, width: 32, height: 4.8)), with: .color(shadow))
        }

        var rig = canvas
        rig.concatenate(pose.rig.affine(about: spec.foot))
        var all = rig
        all.concatenate(pose.all.affine(about: spec.foot))

        // The body, lit on a large face.
        let body = avatar.shape.bodyPath
        if isRich {
            let bounds = spec.bounds
            let gradient = Gradient(stops: [
                .init(color: tone.mix(with: .white, by: 0.36), location: 0),
                .init(color: tone, location: 0.52),
                .init(color: tone.mix(with: .black, by: 0.2), location: 1),
            ])
            all.fill(
                body,
                with: .radialGradient(
                    gradient,
                    center: CGPoint(x: bounds.minX + bounds.width * 0.34, y: bounds.minY + bounds.height * 0.26),
                    startRadius: 0,
                    endRadius: max(bounds.width, bounds.height) * 0.86
                ),
                style: avatar.shape.bodyFill
            )
        } else {
            all.fill(body, with: .color(tone), style: avatar.shape.bodyFill)
        }

        if isDetailed, avatar.mark == JunoAgentMark.visor {
            let width = spec.rightEye.x - spec.leftEye.x + 14
            all.fill(
                Path(roundedRect: CGRect(x: spec.leftEye.x - 7, y: spec.leftEye.y - 6, width: width, height: 12), cornerRadius: 6),
                with: .color(Color.junoAgentInk.opacity(0.18))
            )
        }

        drawEyes(pose, spec: spec, in: all)

        if isDetailed, avatar.mark != JunoAgentMark.visor {
            drawMark(in: all)
        }
        if isDetailed {
            let dots: [(CGPoint, CGFloat)] = [(CGPoint(x: 49, y: 13), 1.5), (CGPoint(x: 54, y: 8.5), 2), (CGPoint(x: 60, y: 3.5), 2.6)]
            for (index, dot) in dots.enumerated() where pose.thoughts[index].opacity > 0.001 {
                var layer = all
                layer.concatenate(pose.thoughts[index].affine(about: dot.0))
                layer.opacity = pose.thoughts[index].opacity
                layer.fill(
                    Path(ellipseIn: CGRect(x: dot.0.x - dot.1, y: dot.0.y - dot.1, width: dot.1 * 2, height: dot.1 * 2)),
                    with: .color(Color.junoAgentMark)
                )
            }
            for (index, x) in [25.0, 30.5, 36.0].enumerated() where pose.bars[index] > 0.001 {
                var layer = all
                layer.opacity = pose.bars[index]
                layer.fill(
                    Path(roundedRect: CGRect(x: x, y: 45, width: 3, height: 3), cornerRadius: 1.5),
                    with: .color(Color.junoAgentInk)
                )
            }
        }
    }

    private func drawEyes(_ pose: JunoAgentFacePose, spec: JunoAgentShapeSpec, in all: GraphicsContext) {
        let cut = avatar.eyes.cut
        let width = cut.width * spec.eyeScale
        let height = cut.height * spec.eyeScale
        let radius = cut.radius * spec.eyeScale
        let eyeLine = CGPoint(x: (spec.leftEye.x + spec.rightEye.x) / 2, y: spec.leftEye.y)

        var eyes = all
        eyes.translateBy(x: pose.gaze.width, y: pose.gaze.height)
        eyes.concatenate(pose.eyes.affine(about: eyeLine))

        if pose.lidsOpacity > 0.001 {
            var lids = eyes
            lids.opacity = pose.lidsOpacity
            lids.concatenate(JunoFaceTransform(scaleX: 1, scaleY: pose.lids).affine(about: eyeLine))
            for centre in [spec.leftEye, spec.rightEye] {
                var eye = lids
                eye.concatenate(pose.eye.affine(about: centre))
                eye.fill(
                    Path(
                        roundedRect: CGRect(x: centre.x - width / 2, y: centre.y - height / 2, width: width, height: height),
                        cornerRadius: radius,
                        style: .circular
                    ),
                    with: .color(Color.junoAgentInk)
                )
                if isRich, pose.glintOpacity > 0.001 {
                    let short = min(width, height)
                    let r = max(0.8, short * 0.17)
                    let glint = CGPoint(x: centre.x - width / 2 + short * 0.34, y: centre.y - height / 2 + short * 0.34)
                    var light = eye
                    light.opacity = pose.glintOpacity
                    light.fill(
                        Path(ellipseIn: CGRect(x: glint.x - r, y: glint.y - r, width: r * 2, height: r * 2)),
                        with: .color(Color.white.opacity(0.9))
                    )
                }
            }
        }

        if pose.happy.opacity > 0.001 {
            var happy = eyes
            happy.opacity = pose.happy.opacity
            happy.concatenate(pose.happy.affine(about: eyeLine))
            happy.stroke(
                JunoAgentFacePath.path(.happy(spec.leftEye, spec.rightEye)),
                with: .color(Color.junoAgentInk),
                style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round)
            )
        }
    }

    /// Every mark sits at the body's edge or above it, so the page is behind
    /// it: `junoAgentMark`, not the eyes' ink.
    private func drawMark(in all: GraphicsContext) {
        let mark = Color.junoAgentMark
        switch avatar.mark {
        case JunoAgentMark.none, .visor:
            break
        case .ring:
            all.stroke(
                JunoAgentFacePath.path(.ringArc),
                with: .color(mark),
                style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round)
            )
            // The ball terminal, at -45°.
            all.fill(Path(ellipseIn: CGRect(x: 54.89 - 1.8, y: 8.11 - 1.8, width: 3.6, height: 3.6)), with: .color(mark))
        case .spark:
            all.fill(JunoAgentFacePath.path(.sparkMark), with: .color(mark))
        case .leaf:
            all.fill(JunoAgentFacePath.path(.leaf), with: .color(mark))
        case .antenna:
            all.stroke(JunoAgentFacePath.path(.antennaStem), with: .color(mark), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            all.fill(Path(ellipseIn: CGRect(x: 32 - 2.2, y: 2.5 - 2.2, width: 4.4, height: 4.4)), with: .color(mark))
        }
    }
}
