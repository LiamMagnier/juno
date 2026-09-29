import Foundation
import SwiftUI

// An agent's face: its identity and its status bar in one drawing.
//
// docs/design/AGENTS.md §4 is the argument. Grok Bot's insight, taken whole:
// the face is how a roster is read peripherally, and the eyes are how it says
// what the agent is doing, so there is no spinner beside it. Muse's, in part:
// a prop says what KIND of work (the tiny laptop while a task runs).
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

    /// Only the live states loop. Nothing idle moves on its own
    /// (ICONS_AND_MOTION.md §2.2 rule 9).
    var loops: Bool {
        self == .working || self == .waiting || self == .thinking
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

/// Where a body puts its eyes, how large they are on it, and the centre it
/// breathes about — the fill-box centre the web's `transform-origin` uses.
struct JunoAgentShapeSpec {
    let leftEye: CGPoint
    let rightEye: CGPoint
    let eyeScale: CGFloat
    let center: CGPoint
}

extension JunoAgentShape {
    var spec: JunoAgentShapeSpec {
        switch self {
        case .tile:
            JunoAgentShapeSpec(leftEye: CGPoint(x: 24, y: 32), rightEye: CGPoint(x: 40, y: 32), eyeScale: 0.9, center: CGPoint(x: 32, y: 32))
        case .halo:
            JunoAgentShapeSpec(leftEye: CGPoint(x: 25, y: 33), rightEye: CGPoint(x: 39, y: 33), eyeScale: 0.85, center: CGPoint(x: 32, y: 32))
        case .prism:
            JunoAgentShapeSpec(leftEye: CGPoint(x: 25, y: 32), rightEye: CGPoint(x: 39, y: 32), eyeScale: 0.85, center: CGPoint(x: 32, y: 32))
        case .orb:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 24, y: 31), rightEye: CGPoint(x: 40, y: 31),
                eyeScale: 1, center: CGPoint(x: 32, y: 33)
            )
        case .pebble:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 24, y: 32), rightEye: CGPoint(x: 40, y: 32),
                eyeScale: 1, center: CGPoint(x: 32, y: 33)
            )
        case .capsule:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 26, y: 29), rightEye: CGPoint(x: 38, y: 29),
                eyeScale: 0.9, center: CGPoint(x: 32, y: 33)
            )
        case .petal:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 26, y: 34), rightEye: CGPoint(x: 42, y: 34),
                eyeScale: 1, center: CGPoint(x: 33, y: 34)
            )
        case .bloom:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 25, y: 32), rightEye: CGPoint(x: 39, y: 32),
                eyeScale: 0.95, center: CGPoint(x: 32, y: 33)
            )
        case .spark:
            JunoAgentShapeSpec(
                leftEye: CGPoint(x: 27, y: 33), rightEye: CGPoint(x: 37, y: 33),
                eyeScale: 0.75, center: CGPoint(x: 32, y: 33)
            )
        }
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

/// How a state reshapes the resting eye: a scale about the eye's own centre,
/// then a nudge, exactly as the web's per-state `transform` does it.
struct JunoAgentEyePose {
    var scaleX: CGFloat = 1
    var scaleY: CGFloat = 1
    var offset: CGSize = .zero
    var opacity: Double = 1

    /// - Parameter height: the eye's scaled resting height, so the two flat
    ///   states can squash it to a bar exactly 2 units tall.
    static func pose(for state: JunoAgentState, height: CGFloat) -> JunoAgentEyePose {
        let bar = height > 0 ? 2 / height : 1
        switch state {
        case .idle:
            return JunoAgentEyePose()
        case .thinking:
            return JunoAgentEyePose(scaleY: 0.7, offset: CGSize(width: 2, height: -2))
        case .working:
            return JunoAgentEyePose(scaleY: 0.75)
        case .waiting:
            return JunoAgentEyePose(scaleX: 1.2, scaleY: 1.2)
        case .listening:
            return JunoAgentEyePose(scaleX: 1.15, scaleY: 1.15)
        case .blocked:
            return JunoAgentEyePose(scaleX: 1.3, scaleY: bar)
        case .sleeping:
            return JunoAgentEyePose(scaleX: 1.3, scaleY: bar, offset: CGSize(width: 0, height: 2))
        case .done:
            // The happy arcs take over; the resting eyes shrink out beneath them.
            return JunoAgentEyePose(scaleX: 0.8, scaleY: 0.8, opacity: 0)
        }
    }
}

/// The parts of the face that are paths rather than primitives, written in the
/// 64-unit design box and scaled to whatever rect they are drawn in.
struct JunoAgentFacePath: Shape {
    enum Kind: Equatable, Sendable {
        case petal
        case prism
        case spark
        case leaf
        case sparkMark
        case ringArc
        case antennaStem
        case laptopBase
        case happy(CGPoint, CGPoint)
    }

    let kind: Kind

    // `nonisolated` to match `Shape.path(in:)`, which SwiftUI may call off the
    // main actor; a conformer is otherwise inferred `@MainActor` through
    // `View`. It reads nothing but the Sendable `kind`.
    nonisolated func path(in rect: CGRect) -> Path {
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
            path.addCurve(
                to: CGPoint(x: 58, y: 35),
                control1: CGPoint(x: 48, y: 9), control2: CGPoint(x: 58, y: 21)
            )
            path.addCurve(
                to: CGPoint(x: 33, y: 59),
                control1: CGPoint(x: 58, y: 49), control2: CGPoint(x: 47, y: 59)
            )
            path.addCurve(
                to: CGPoint(x: 8, y: 34),
                control1: CGPoint(x: 19, y: 59), control2: CGPoint(x: 8, y: 48)
            )
            path.closeSubpath()
        case .spark:
            // M32 5 C36 22 42 28 59 33 C42 38 36 44 32 61
            // C28 44 22 38 5 33 C22 28 28 22 32 5 Z
            path.move(to: CGPoint(x: 32, y: 5))
            path.addCurve(
                to: CGPoint(x: 59, y: 33),
                control1: CGPoint(x: 36, y: 22), control2: CGPoint(x: 42, y: 28)
            )
            path.addCurve(
                to: CGPoint(x: 32, y: 61),
                control1: CGPoint(x: 42, y: 38), control2: CGPoint(x: 36, y: 44)
            )
            path.addCurve(
                to: CGPoint(x: 5, y: 33),
                control1: CGPoint(x: 28, y: 44), control2: CGPoint(x: 22, y: 38)
            )
            path.addCurve(
                to: CGPoint(x: 32, y: 5),
                control1: CGPoint(x: 22, y: 28), control2: CGPoint(x: 28, y: 22)
            )
            path.closeSubpath()
        case .leaf:
            // M44 18 C44 11 49 6 57 6 C57 13 52 18 44 18 Z
            path.move(to: CGPoint(x: 44, y: 18))
            path.addCurve(
                to: CGPoint(x: 57, y: 6),
                control1: CGPoint(x: 44, y: 11), control2: CGPoint(x: 49, y: 6)
            )
            path.addCurve(
                to: CGPoint(x: 44, y: 18),
                control1: CGPoint(x: 57, y: 13), control2: CGPoint(x: 52, y: 18)
            )
            path.closeSubpath()
        case .sparkMark:
            // A four-point spark centred (51, 12), radius 7 — the web's
            // M51 5 Q52.4 10.6 58 12 Q52.4 13.4 51 19 Q49.6 13.4 44 12 Q49.6 10.6 51 5 Z
            path.move(to: CGPoint(x: 51, y: 5))
            path.addQuadCurve(to: CGPoint(x: 58, y: 12), control: CGPoint(x: 52.4, y: 10.6))
            path.addQuadCurve(to: CGPoint(x: 51, y: 19), control: CGPoint(x: 52.4, y: 13.4))
            path.addQuadCurve(to: CGPoint(x: 44, y: 12), control: CGPoint(x: 49.6, y: 13.4))
            path.addQuadCurve(to: CGPoint(x: 51, y: 5), control: CGPoint(x: 49.6, y: 10.6))
            path.closeSubpath()
        case .ringArc:
            // The open ring centred (51, 12), r 5.5, open for 70° at the upper
            // right: the gap runs from −80° to −10°, so the stroke runs the
            // other 290°. Walked as points rather than `addArc`, whose
            // clockwise flag reads backwards in a flipped coordinate space —
            // this way the direction is the arithmetic, not a convention.
            let points = stride(from: -10.0, through: 280.0, by: 5.0).map { degrees -> CGPoint in
                let radians = degrees * Double.pi / 180
                return CGPoint(x: 51 + 5.5 * cos(radians), y: 12 + 5.5 * sin(radians))
            }
            path.addLines(points)
        case .antennaStem:
            path.move(to: CGPoint(x: 32, y: 8))
            path.addLine(to: CGPoint(x: 32, y: 2.5))
        case .laptopBase:
            path.move(to: CGPoint(x: 43.5, y: 55.5))
            path.addLine(to: CGPoint(x: 60.5, y: 55.5))
        case .happy(let left, let right):
            // A happy arc per eye: (cx − 4, cy + 1.5) through (cx, cy − 3.5)
            // to (cx + 4, cy + 1.5).
            for eye in [left, right] {
                path.move(to: CGPoint(x: eye.x - 4, y: eye.y + 1.5))
                path.addQuadCurve(
                    to: CGPoint(x: eye.x + 4, y: eye.y + 1.5),
                    control: CGPoint(x: eye.x, y: eye.y - 3.5)
                )
            }
        }
        let transform = CGAffineTransform(translationX: rect.minX, y: rect.minY)
            .scaledBy(x: rect.width / 64, y: rect.height / 64)
        return path.applying(transform)
    }
}

/// Everything that moves on a clock, sampled for one frame.
struct JunoAgentFaceMotion {
    var lookX: CGFloat = 0
    var breathe: CGFloat = 1
    var liftY: CGFloat = 0
    var settle: CGFloat = 1
    var blink: CGFloat = 1
    var workBars: [Double] = [0.5, 0.5, 0.5]
    var dots: [Double] = [0.55, 0.55, 0.55]

    /// 0 → 1 → 0 over one period, eased in and out: a raised cosine, which is
    /// the shape the web's `--ease-in-out` keyframes trace between 0% and 50%.
    static func wave(_ time: TimeInterval, period: TimeInterval) -> CGFloat {
        let phase = time.truncatingRemainder(dividingBy: period) / period
        return CGFloat((1 - cos(2 * Double.pi * phase)) / 2)
    }

    /// The `done` arrival: 0.94 → 1.03 → 1 over the emphasis rung, the
    /// overshoot landing at 60% as the web's `agent-face-settle` keyframes do.
    static func settleScale(elapsed: TimeInterval) -> CGFloat {
        let progress = min(max(elapsed / JunoMotion.Duration.emphasis, 0), 1)
        if progress < 0.6 {
            let unit = progress / 0.6
            let eased = 1 - (1 - unit) * (1 - unit)
            return CGFloat(0.94 + (1.03 - 0.94) * eased)
        }
        let unit = (progress - 0.6) / 0.4
        let eased = unit * unit * (3 - 2 * unit)
        return CGFloat(1.03 + (1 - 1.03) * eased)
    }

    /// The idle blink: the eyes scale to 0.1 tall and back in 180ms — one and
    /// a half fast rungs, so it is on the ladder rather than beside it.
    static let blinkDuration: TimeInterval = JunoMotion.Duration.fast * 1.5

    static func blinkScale(elapsed: TimeInterval) -> CGFloat {
        let progress = min(max(elapsed / blinkDuration, 0), 1)
        return CGFloat(1 - 0.9 * ((1 - cos(2 * Double.pi * progress)) / 2))
    }
}

// MARK: - The face

/// An agent's face, drawn natively from the numbers in AGENTS.md §4.2b.
///
/// **Motion.** Only transform and opacity move. A state change cross-fades the
/// eyes on the fast rung. The three live states loop — `working` looks left and
/// right and breathes, `waiting` lifts, `thinking` pulses its dots — and are
/// driven by a paused-when-still `TimelineView` rather than by
/// `repeatForever`, so a loop is a function of the clock that stops the moment
/// the state or Reduce Motion says so, with no animation left in flight.
/// `done` plays a one-shot settle on arrival, and `idle` blinks only under the
/// pointer. Under Reduce Motion every loop and the settle stop; the eyes'
/// *shape* still carries the state, and the cross-fade keeps its timing.
///
/// **Words.** The state is also said: with a `name`, the face is one image
/// labelled "Atlas, working". Without one it is hidden from assistive
/// technology, because a caller that omits the name is printing the name and
/// the state sentence beside it — the web's rule too.
public struct JunoAgentFace: View {
    @State private var hovering = false
    private let avatar: JunoAgentAvatar
    private let state: JunoAgentState
    private let size: CGFloat
    private let name: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settleStartedAt: Date?
    @State private var blinkStartedAt: Date?

    public init(
        avatar: JunoAgentAvatar,
        state: JunoAgentState = .idle,
        size: CGFloat = JunoAgentFaceSize.md,
        name: String? = nil
    ) {
        self.avatar = avatar
        self.state = state
        self.size = size
        self.name = name
    }

    /// Whether anything is moving on a clock right now. The timeline is paused
    /// otherwise, so a roster of idle faces costs no frames at all.
    private var isAnimating: Bool {
        guard !reduceMotion else { return false }
        return state.loops || settleStartedAt != nil || blinkStartedAt != nil
    }

    private var accessibilityText: String {
        guard let name else { return state.label }
        return "\(name), \(state.label.lowercased())"
    }

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !isAnimating)) { context in
            face(motion: motion(at: context.date))
        }
        .frame(width: size, height: size)
        // The state swap: eyes reshape and cross-fade on the fast rung. `.tint`
        // because it is a change of shape and opacity in place — the one
        // gesture ICONS_AND_MOTION.md §2.2 allows a state swap — and Reduce
        // Motion keeps its timing.
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: state)
        .scaleEffect(hovering && !reduceMotion ? 1.045 : 1)
        .offset(y: hovering && !reduceMotion ? -1 : 0)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: hovering)
        .onHover { hovering in
            self.hovering = hovering
            guard hovering, state == .idle, !reduceMotion else { return }
            blinkStartedAt = Date()
        }
        .task(id: blinkStartedAt) {
            guard blinkStartedAt != nil else { return }
            try? await Task.sleep(for: .seconds(JunoAgentFaceMotion.blinkDuration))
            guard !Task.isCancelled else { return }
            blinkStartedAt = nil
        }
        // Keyed on the state, so the settle plays when a run finishes and also
        // when a face first appears already `done` — the web's animation runs
        // on mount for the same reason.
        .task(id: state) {
            guard state == .done, !reduceMotion else {
                settleStartedAt = nil
                return
            }
            settleStartedAt = Date()
            try? await Task.sleep(for: .seconds(JunoMotion.Duration.emphasis))
            guard !Task.isCancelled else { return }
            settleStartedAt = nil
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: accessibilityText))
        .accessibilityAddTraits(.isImage)
        .accessibilityHidden(name == nil)
    }

    private func motion(at date: Date) -> JunoAgentFaceMotion {
        var motion = JunoAgentFaceMotion()
        guard !reduceMotion else { return motion }
        let time = date.timeIntervalSinceReferenceDate
        switch state {
        case .working:
            let wave = JunoAgentFaceMotion.wave(time, period: 2.4)
            motion.lookX = -1.8 + 3.6 * wave
            motion.breathe = 1 + 0.02 * wave
            motion.workBars = (0..<3).map { 0.25 + 0.55 * Double(JunoAgentFaceMotion.wave(time - Double($0) * 0.18, period: 1.4)) }
        case .waiting:
            motion.liftY = -1.5 * JunoAgentFaceMotion.wave(time, period: 2.4)
        case .thinking:
            motion.liftY = -0.8 * JunoAgentFaceMotion.wave(time, period: 3.2)
            motion.breathe = 1 + 0.012 * JunoAgentFaceMotion.wave(time, period: 3.2)
            motion.dots = (0..<3).map { index in
                0.3 + 0.7 * Double(JunoAgentFaceMotion.wave(time - 0.2 * Double(index), period: 1.2))
            }
        case .idle, .blocked, .done, .sleeping, .listening:
            break
        }
        if let settleStartedAt {
            motion.settle = JunoAgentFaceMotion.settleScale(elapsed: date.timeIntervalSince(settleStartedAt))
        }
        if let blinkStartedAt {
            motion.blink = JunoAgentFaceMotion.blinkScale(elapsed: date.timeIntervalSince(blinkStartedAt))
        }
        return motion
    }

    // MARK: Drawing

    private var unit: CGFloat { size / 64 }

    /// The mark, the dots and the laptop are dropped below `sm`: at 20pt they
    /// are noise around a pair of eyes that still has to read.
    private var isDetailed: Bool { size >= JunoAgentFaceSize.sm }

    private func face(motion: JunoAgentFaceMotion) -> some View {
        let spec = avatar.shape.spec
        return ZStack(alignment: .topLeading) {
            bodyShape
                .scaleEffect(
                    motion.breathe,
                    anchor: UnitPoint(x: spec.center.x / 64, y: spec.center.y / 64)
                )
            if isDetailed, avatar.mark == JunoAgentMark.visor {
                visor(spec: spec)
            }
            eyes(spec: spec, motion: motion)
            happyEyes(spec: spec)
            if isDetailed, avatar.mark != JunoAgentMark.visor {
                markView
            }
            if isDetailed {
                thinkingDots(motion: motion)
            }
            if isDetailed, state == .working {
                ForEach(0..<3, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 1.5 * unit)
                        .fill(Color.junoAgentInk)
                        .frame(width: 3 * unit, height: 3 * unit)
                        .position(x: (26.5 + 6 * CGFloat(index)) * unit, y: 45.5 * unit)
                        .opacity(motion.workBars[index])
                }
            }
        }
        .frame(width: size, height: size, alignment: .topLeading)
        .offset(y: motion.liftY * unit)
        .scaleEffect(motion.settle)
    }

    @ViewBuilder
    private var bodyShape: some View {
        let tone = avatar.tone.color
        switch avatar.shape {
        case .tile:
            RoundedRectangle(cornerRadius: 15 * unit, style: .circular)
                .fill(tone).frame(width: 52 * unit, height: 52 * unit).position(x: 32 * unit, y: 32 * unit)
        case .halo:
            Path { path in
                path.addEllipse(in: CGRect(x: 4 * unit, y: 4 * unit, width: 56 * unit, height: 56 * unit))
                path.addEllipse(in: CGRect(x: 27 * unit, y: 9 * unit, width: 10 * unit, height: 10 * unit))
            }.fill(tone, style: FillStyle(eoFill: true))
        case .prism:
            JunoAgentFacePath(kind: .prism).fill(tone)
        case .orb:
            Circle()
                .fill(tone)
                .frame(width: 52 * unit, height: 52 * unit)
                .position(x: 32 * unit, y: 33 * unit)
        case .pebble:
            RoundedRectangle(cornerRadius: 20 * unit, style: .circular)
                .fill(tone)
                .frame(width: 52 * unit, height: 48 * unit)
                .position(x: 32 * unit, y: 33 * unit)
        case .capsule:
            RoundedRectangle(cornerRadius: 20 * unit, style: .circular)
                .fill(tone)
                .frame(width: 40 * unit, height: 56 * unit)
                .position(x: 32 * unit, y: 33 * unit)
        case .petal:
            JunoAgentFacePath(kind: .petal)
                .fill(tone)
        case .bloom:
            // Five opaque pieces of one colour rather than one path: the union
            // of overlapping subpaths depends on their winding, and separate
            // fills are what the web's five SVG elements draw anyway.
            ZStack(alignment: .topLeading) {
                ForEach(Self.bloomLobes, id: \.self) { centre in
                    Circle()
                        .fill(tone)
                        .frame(width: 30 * unit, height: 30 * unit)
                        .position(x: centre.x * unit, y: centre.y * unit)
                }
                Rectangle()
                    .fill(tone)
                    .frame(width: 20 * unit, height: 20 * unit)
                    .position(x: 32 * unit, y: 33 * unit)
            }
        case .spark:
            JunoAgentFacePath(kind: .spark)
                .fill(tone)
        }
    }

    private static let bloomLobes: [JunoAgentLobe] = [
        JunoAgentLobe(x: 22, y: 23),
        JunoAgentLobe(x: 42, y: 23),
        JunoAgentLobe(x: 22, y: 43),
        JunoAgentLobe(x: 42, y: 43),
    ]

    private func eyes(spec: JunoAgentShapeSpec, motion: JunoAgentFaceMotion) -> some View {
        let cut = avatar.eyes.cut
        let width = cut.width * spec.eyeScale
        let height = cut.height * spec.eyeScale
        let radius = cut.radius * spec.eyeScale
        let pose = JunoAgentEyePose.pose(for: state, height: height)
        return ZStack(alignment: .topLeading) {
            ForEach([spec.leftEye, spec.rightEye].map { JunoAgentLobe(x: $0.x, y: $0.y) }, id: \.self) { centre in
                RoundedRectangle(cornerRadius: radius * unit, style: .circular)
                    .fill(Color.junoAgentInk)
                    .frame(width: width * unit, height: height * unit)
                    .scaleEffect(x: pose.scaleX, y: pose.scaleY * motion.blink)
                    .offset(x: (pose.offset.width + motion.lookX) * unit, y: pose.offset.height * unit)
                    .position(x: centre.x * unit, y: centre.y * unit)
            }
        }
        .opacity(pose.opacity)
    }

    private func happyEyes(spec: JunoAgentShapeSpec) -> some View {
        let isDone = state == .done
        let anchor = UnitPoint(
            x: (spec.leftEye.x + spec.rightEye.x) / 2 / 64,
            y: spec.leftEye.y / 64
        )
        return JunoAgentFacePath(kind: .happy(spec.leftEye, spec.rightEye))
            .stroke(
                Color.junoAgentInk,
                style: StrokeStyle(lineWidth: 2.4 * unit, lineCap: .round, lineJoin: .round)
            )
            .scaleEffect(isDone ? 1 : 0.8, anchor: anchor)
            .opacity(isDone ? 1 : 0)
    }

    /// A rounded band behind the eyes: 7 units beyond each eye, 6 above and
    /// below the eye line, fully rounded, ink at 18%.
    private func visor(spec: JunoAgentShapeSpec) -> some View {
        let width = spec.rightEye.x - spec.leftEye.x + 14
        return RoundedRectangle(cornerRadius: 6 * unit, style: .circular)
            .fill(Color.junoAgentInk.opacity(0.18))
            .frame(width: width * unit, height: 12 * unit)
            .position(x: (spec.leftEye.x + spec.rightEye.x) / 2 * unit, y: spec.leftEye.y * unit)
    }

    /// Every mark sits at the body's edge or above it, so the page is behind
    /// it: `junoAgentMark`, not the eyes' ink (`.agent-face__mark`).
    @ViewBuilder
    private var markView: some View {
        switch avatar.mark {
        case JunoAgentMark.none, .visor:
            EmptyView()
        case .ring:
            ZStack(alignment: .topLeading) {
                JunoAgentFacePath(kind: .ringArc)
                    .stroke(
                        Color.junoAgentMark,
                        style: StrokeStyle(lineWidth: 2.2 * unit, lineCap: .round, lineJoin: .round)
                    )
                // The ball terminal, at −45° — where the web puts it.
                Circle()
                    .fill(Color.junoAgentMark)
                    .frame(width: 3.6 * unit, height: 3.6 * unit)
                    .position(x: 54.89 * unit, y: 8.11 * unit)
            }
        case .spark:
            JunoAgentFacePath(kind: .sparkMark)
                .fill(Color.junoAgentMark)
        case .leaf:
            JunoAgentFacePath(kind: .leaf)
                .fill(Color.junoAgentMark)
        case .antenna:
            ZStack(alignment: .topLeading) {
                JunoAgentFacePath(kind: .antennaStem)
                    .stroke(Color.junoAgentMark, style: StrokeStyle(lineWidth: 2 * unit, lineCap: .round))
                Circle()
                    .fill(Color.junoAgentMark)
                    .frame(width: 4.4 * unit, height: 4.4 * unit)
                    .position(x: 32 * unit, y: 2.5 * unit)
            }
        }
    }

    /// Three dots beside the head while a reply streams. Still, at 55%, under
    /// Reduce Motion: they are the state, not the loop. Off the body, so
    /// `junoAgentMark` (`.agent-face__dots`).
    private func thinkingDots(motion: JunoAgentFaceMotion) -> some View {
        let isThinking = state == .thinking
        return ZStack(alignment: .topLeading) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.junoAgentMark)
                    .frame(width: 3.2 * unit, height: 3.2 * unit)
                    .position(x: (50 + 5 * CGFloat(index)) * unit, y: 12 * unit)
                    .opacity(isThinking ? motion.dots[index] : 0)
            }
        }
    }


}

/// A point in the design box that can be a `ForEach` identity. `CGPoint` is
/// not `Hashable` on every SDK this package builds against.
struct JunoAgentLobe: Hashable {
    let x: CGFloat
    let y: CGFloat
}
