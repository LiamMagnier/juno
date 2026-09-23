import SwiftUI

/// What a run is doing, as its signature draws it.
///
/// The web's run glyph phases (the Tool calls & research rework, DECISIONS
/// U2, SPEC §7.4): one mark for every working state, whose *pattern* says which
/// state it is.
public enum JunoRunGlyphPhase: Equatable, Sendable {
    /// Thinking, and the moment before anything is known: a point travels the
    /// perimeter clockwise, then the centre.
    case thinking
    /// A column sweeps left to right, then rests.
    case searching
    /// A row sweeps top to bottom.
    case reading
    /// The perimeter orbits twice a loop while the centre holds.
    case tool
    /// The bottom row types, left to right.
    case writing
    /// Blocked on the reader: still, with the centre in the accent — the one
    /// place a run wears it.
    case waiting
    /// Still, with the centre in the warning tone.
    case failed
    /// Done, stopped, or answering: the dots gather into one resting dot.
    case settled

    var moves: Bool {
        switch self {
        case .thinking, .searching, .reading, .tool, .writing: true
        case .waiting, .failed, .settled: false
        }
    }
}

/// Juno's run signature: an 18pt 3 × 3 grid of 4pt points, 3pt apart, in one
/// muted ink.
///
/// **Only opacity loops.** Each point has a quiet resting layer that never
/// leaves and a lit layer whose opacity follows the phase's pattern on one
/// shared period — ``JunoMotion/Loop/run``, 2.4s, locked to the clock rather
/// than to when the view appeared, so two signatures on screen agree and a
/// re-render never restarts the loop. After 20s of continuous work the run goes
/// **calm**: the same pattern at half the pace.
///
/// At ``JunoRunGlyphPhase/settled`` the outer eight travel into the centre,
/// shrink and fade over 360ms, and the centre grows into a 6pt resting dot —
/// the gather. The same view is there from send to done, so the gather is the
/// run ending rather than one mark being swapped for another.
///
/// Under Reduce Motion nothing loops: each phase shows its pattern's still
/// frame, and the gather is a fade.
public struct JunoRunSignature: View {
    private let phase: JunoRunGlyphPhase
    private let calm: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var gathered: Bool

    public init(phase: JunoRunGlyphPhase, calm: Bool = false) {
        self.phase = phase
        self.calm = calm
        _gathered = State(initialValue: phase == .settled)
    }

    static let dot: CGFloat = 4
    static let gap: CGFloat = 3
    public static let side: CGFloat = 3 * dot + 2 * gap
    static let restingDot: CGFloat = 6
    /// Clockwise around the perimeter, then the centre.
    static let perimeter = [0, 1, 2, 5, 8, 7, 6, 3]

    public var body: some View {
        TimelineView(.animation(paused: reduceMotion || !phase.moves)) { context in
            let period = calm ? JunoMotion.Loop.runCalm : JunoMotion.Loop.run
            let t = context.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: period) / period
            ZStack {
                ForEach(0..<9, id: \.self) { index in
                    point(index, t: reduceMotion ? nil : t)
                }
            }
            .frame(width: Self.side, height: Self.side)
        }
        .onChange(of: phase == .settled) { _, settled in
            withAnimation(JunoMotion.reduced(settled ? JunoMotion.slow : JunoMotion.base, when: reduceMotion)) {
                gathered = settled
            }
        }
        .accessibilityHidden(true)
    }

    private func point(_ index: Int, t: Double?) -> some View {
        let row = index / 3
        let column = index % 3
        let isCentre = index == 4
        let position = CGPoint(
            x: CGFloat(column) * (Self.dot + Self.gap) + Self.dot / 2,
            y: CGFloat(row) * (Self.dot + Self.gap) + Self.dot / 2
        )
        let centre = Self.side / 2
        let toCentre = CGSize(width: centre - position.x, height: centre - position.y)
        return ZStack {
            Circle()
                .fill(restingInk(isCentre: isCentre))
            Circle()
                .fill(litInk(isCentre: isCentre))
                .opacity(gathered ? 0 : litOpacity(index, t: t))
        }
        .frame(width: Self.dot, height: Self.dot)
        .scaleEffect(isCentre ? (gathered ? Self.restingDot / Self.dot : 1) : (gathered ? JunoMotion.scaleFrom(0.4, reduceMotion: reduceMotion) : 1))
        .opacity(isCentre || !gathered ? 1 : 0)
        .offset(
            x: gathered && !isCentre ? JunoMotion.shift(toCentre.width, reduceMotion: reduceMotion) : 0,
            y: gathered && !isCentre ? JunoMotion.shift(toCentre.height, reduceMotion: reduceMotion) : 0
        )
        .position(position)
    }

    private func restingInk(isCentre: Bool) -> Color {
        if isCentre, gathered { return Color.junoSecondaryInk.opacity(0.45) }
        return Color.junoForeground.opacity(0.16)
    }

    private func litInk(isCentre: Bool) -> Color {
        guard isCentre else { return Color.junoSecondaryInk }
        switch phase {
        case .waiting: return Color.junoAccent
        case .failed: return Color.junoWarning
        default: return Color.junoSecondaryInk
        }
    }

    /// The lit layer's opacity for one point at loop position `t` (0…1), or
    /// the phase's still frame when `t` is nil.
    func litOpacity(_ index: Int, t: Double?) -> Double {
        let row = index / 3
        let column = index % 3
        switch phase {
        case .settled:
            return 0
        case .waiting, .failed:
            return index == 4 ? 1 : 0
        case .thinking:
            guard let t else { return index == 4 ? 0.9 : 0 }
            let sequence = Self.perimeter + [4]
            guard let step = sequence.firstIndex(of: index) else { return 0 }
            return Self.pulse(t - Double(step) / 9, width: 0.3)
        case .searching:
            // A column sweeps in 600ms of the 2.4s loop, then rests.
            guard let t else { return column == 1 ? 0.9 : 0 }
            return Self.pulse(t - Double(column) * 0.2 / 2.4, width: 0.25)
        case .reading:
            guard let t else { return row == 1 ? 0.9 : 0 }
            return Self.pulse(t - Double(row) * 0.2 / 2.4, width: 0.25)
        case .tool:
            if index == 4 { return 0.6 }
            guard let t else { return [1, 5, 7, 3].contains(index) ? 0.7 : 0 }
            guard let step = Self.perimeter.firstIndex(of: index) else { return 0 }
            // Twice around per loop: each lap is half of it.
            let lap = (t * 2).truncatingRemainder(dividingBy: 1)
            return Self.pulse(lap - Double(step) / 8, width: 0.35)
        case .writing:
            guard row == 2 else { return 0 }
            guard let t else { return 0.9 }
            // Each of the bottom three lights in turn and holds until the loop
            // turns over.
            let lit = Double(column) * 0.2 / 2.4
            return t >= lit && t < 0.85 ? 0.9 : 0
        }
    }

    /// The web's `thinking-matrix` curve on a window of `width` of the loop:
    /// up to 0.28, to 0.95, then down to dark, and dark for the rest.
    static func pulse(_ position: Double, width: Double) -> Double {
        var x = position.truncatingRemainder(dividingBy: 1)
        if x < 0 { x += 1 }
        let local = x / width
        switch local {
        case ..<0.27: return lerp(0, 0.28, local / 0.27)
        case ..<0.5: return lerp(0.28, 0.95, (local - 0.27) / 0.23)
        case ..<1: return lerp(0.95, 0, (local - 0.5) / 0.5)
        default: return 0
        }
    }

    private static func lerp(_ from: Double, _ to: Double, _ t: Double) -> Double {
        from + (to - from) * min(max(t, 0), 1)
    }
}

/// A run's phase label, with the one shimmer the run is allowed.
///
/// The words are set in the secondary ink; a band of the foreground crosses
/// them once per loop (``JunoMotion/Loop/run``), clipped to the glyphs so the
/// canvas around them never brightens. Transform and opacity only. The band
/// stops when the run goes **calm** (20s of work: the pace halves and the
/// shimmer ends), when it settles, and under Reduce Motion.
public struct JunoRunLabel: View {
    private let text: String
    private let shimmers: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ text: String, shimmers: Bool) {
        self.text = text
        self.shimmers = shimmers
    }

    public var body: some View {
        if shimmers, !reduceMotion {
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: JunoMotion.Loop.run) / JunoMotion.Loop.run
                base
                    .overlay {
                        GeometryReader { proxy in
                            let width = proxy.size.width
                            let band = max(48, width * 0.45)
                            LinearGradient(
                                colors: [
                                    Color.junoForeground.opacity(0),
                                    Color.junoForeground,
                                    Color.junoForeground.opacity(0),
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                            .frame(width: band)
                            .offset(x: -band + (width + band) * t)
                        }
                        .mask(base)
                        .allowsHitTesting(false)
                    }
            }
        } else {
            base
        }
    }

    private var base: some View {
        Text(text)
            .foregroundStyle(Color.junoSecondaryInk)
            .lineLimit(1)
            .truncationMode(.tail)
    }
}
