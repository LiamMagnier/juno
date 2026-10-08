import SwiftUI

/// What a run is doing, as its signature draws it.
///
/// The web's run glyph phases (the Tool calls & research rework, SPEC §7.4,
/// "Concept A"): one mark for every working state, whose *pattern* says which
/// state it is.
public enum JunoRunGlyphPhase: Equatable, Sendable {
    /// Thinking, and the moment before anything is known: a point travels the
    /// perimeter clockwise, then the centre.
    case thinking
    /// A column sweeps left to right in 600ms, then rests.
    case searching
    /// A row sweeps top to bottom.
    case reading
    /// The perimeter orbits twice a loop while the centre holds at 0.6.
    case tool
    /// The bottom row types, left to right (Research only).
    case writing
    /// Blocked on the reader: still, with the centre in the accent — the one
    /// place a run wears it.
    case waiting
    /// Still, with the centre in the warning tone.
    case failed
    /// Research, paused: the resting grid, no lit point, no accent.
    case paused
    /// Done, stopped, or answering: the dots gather into one resting dot.
    case settled

    var moves: Bool {
        switch self {
        case .thinking, .searching, .reading, .tool, .writing: true
        case .waiting, .failed, .paused, .settled: false
        }
    }
}

/// Juno's run signature. **While the run works** (``JunoRunGlyphPhase/moves``)
/// it is the galaxy, ``JunoGalaxyMark``; the grid below is what it rests,
/// waits, fails and settles as.
///
/// The grid: an 18pt 3 × 3 grid of 4pt points, 3pt apart (14pt of
/// 3pt points at ``Size/small``), in one muted ink.
///
/// **Only opacity loops.** Each point has a resting layer that never leaves
/// (`muted-foreground / 0.25`) and a lit layer in the foreground ink whose
/// opacity follows the phase's keyframes (SPEC §7.9: `run-lit`, `run-lit-bar`,
/// `run-lit-type`) on one shared period — ``JunoMotion/Loop/run``, 2.4s (the
/// tool orbit on the 1.2s beat) — locked to the clock rather than to when the
/// view appeared, so every signature on screen agrees and a re-render never
/// restarts the loop. After 20s of work the run goes **calm**: every period
/// doubles to 4.8s.
///
/// **One loop owner.** A signature that does not own the loop (``loops`` is
/// false: another run, or the Activity panel's live row, owns it) shows its
/// phase's *static signature* — the same still frame Reduce Motion shows —
/// never a paused arbitrary frame.
///
/// At ``JunoRunGlyphPhase/settled`` the outer eight travel into the centre,
/// shrink to 0.4 and fade over 360ms, and the centre grows into a 6pt resting
/// dot — the gather. Under Reduce Motion nothing travels or loops: each phase
/// shows its still frame, the loop owner breathes its opacity on 4.8s, and the
/// gather is a cross-fade.
public struct JunoRunSignature: View {
    public enum Size: Sendable {
        /// 18pt, the run line's.
        case regular
        /// 14pt, an artifact card's.
        case small
    }

    private let phase: JunoRunGlyphPhase
    private let calm: Bool
    private let loops: Bool
    private let size: Size

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var gathered: Bool
    /// The lit channel dims for 120ms and returns over 220ms on a phase swap.
    @State private var swapFade: Double = 1

    public init(phase: JunoRunGlyphPhase, calm: Bool = false, loops: Bool = true, size: Size = .regular) {
        self.phase = phase
        self.calm = calm
        self.loops = loops
        self.size = size
        _gathered = State(initialValue: phase == .settled)
    }

    static let dot: CGFloat = 4
    static let gap: CGFloat = 3
    public static let side: CGFloat = 3 * dot + 2 * gap
    static let restingDot: CGFloat = 6
    /// `--s`: the thinking sequence, perimeter clockwise 0–7, centre 8, by
    /// grid index.
    static let sequence = [0, 1, 2, 7, 8, 3, 6, 5, 4]

    private var dot: CGFloat { size == .small ? 3 : Self.dot }
    private var gap: CGFloat { size == .small ? 2.5 : Self.gap }
    private var side: CGFloat { 3 * dot + 2 * gap }
    private var pitch: CGFloat { dot + gap }

    private var animates: Bool { loops && !reduceMotion && phase.moves }

    /// The galaxy's side: the grid's, but never under the 16pt the galaxy needs
    /// to read as one. It overhangs the small grid's slot rather than moving
    /// the words beside it.
    private var galaxySide: CGFloat { max(side, 16) }

    public var body: some View {
        ZStack {
            if phase.moves {
                // Every working phase is the galaxy (owner, 2026-10-08): the
                // run's words already say *which* work it is, and one calm
                // mark reads better than five patterns on nine dots. It holds
                // its still frame when this line does not own the loop.
                JunoGalaxyMark(size: galaxySide, active: loops)
                    .frame(width: side, height: side)
                    .transition(.opacity)
            } else {
                grid
                    .transition(.opacity)
            }
        }
        .frame(width: side, height: side)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: phase.moves)
        .onChange(of: phase == .settled) { _, settled in
            withAnimation(JunoMotion.reduced(settled ? JunoMotion.riseIn : JunoMotion.base, when: reduceMotion, tier: .tint)) {
                gathered = settled
            }
        }
        .onChange(of: phase) { _, _ in
            swapFade = 0.35
            withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint)) {
                swapFade = 1
            }
        }
        .accessibilityHidden(true)
    }

    /// The nine-point grid: the resting, waiting, failed and settled states.
    private var grid: some View {
        TimelineView(.animation(paused: !(animates || (reduceMotion && loops && phase.moves)))) { context in
            let now = context.date.timeIntervalSinceReferenceDate
            ZStack {
                ForEach(0..<9, id: \.self) { index in
                    point(index, now: animates ? now : nil)
                }
            }
            .frame(width: side, height: side)
            // Reduce Motion: the loop owner's opacity breath, so the run still
            // reads as live.
            .opacity(reduceMotion && loops && phase.moves ? Self.breath(now) : 1)
        }
        .frame(width: side, height: side)
    }

    private func point(_ index: Int, now: TimeInterval?) -> some View {
        let row = index / 3
        let column = index % 3
        let isCentre = index == 4
        let position = CGPoint(
            x: CGFloat(column) * pitch + dot / 2,
            y: CGFloat(row) * pitch + dot / 2
        )
        let toCentre = CGSize(width: CGFloat(1 - column) * pitch, height: CGFloat(1 - row) * pitch)
        let travel = !reduceMotion
        return ZStack {
            Circle()
                .fill(restingInk(isCentre: isCentre))
            Circle()
                .fill(Color.junoForeground)
                .opacity(gathered ? 0 : litOpacity(index, now: now) * swapFade)
        }
        .frame(width: dot, height: dot)
        .scaleEffect(
            isCentre
                ? (gathered ? Self.restingDot / dot : 1)
                : (gathered && travel ? 0.4 : 1)
        )
        .opacity(isCentre || !gathered ? 1 : 0)
        .offset(
            x: gathered && !isCentre && travel ? toCentre.width : 0,
            y: gathered && !isCentre && travel ? toCentre.height : 0
        )
        .position(position)
    }

    private func restingInk(isCentre: Bool) -> Color {
        if isCentre {
            if gathered { return Color.junoSecondaryInk.opacity(0.45) }
            switch phase {
            case .waiting: return Color.junoAccent
            case .failed: return Color.junoWarning
            default: break
            }
        }
        return Color.junoSecondaryInk.opacity(0.25)
    }

    /// The lit layer's opacity for one point at clock time `now`, or the
    /// phase's static signature when `now` is nil.
    func litOpacity(_ index: Int, now: TimeInterval?) -> Double {
        let row = index / 3
        let column = index % 3
        guard let now else { return Self.staticSignature(phase, row: row, column: column) }
        let period = calm ? JunoMotion.Loop.runCalm : JunoMotion.Loop.run
        switch phase {
        case .thinking:
            return Self.keyframes(Self.lit, at: Self.progress(now, delay: Double(Self.sequence[index]) * 0.266, period: period))
        case .searching:
            return Self.keyframes(Self.litBar, at: Self.progress(now, delay: Double(column) * 0.2, period: period))
        case .reading:
            return Self.keyframes(Self.litBar, at: Self.progress(now, delay: Double(row) * 0.2, period: period))
        case .tool:
            if index == 4 { return 0.6 }
            let beat = calm ? JunoMotion.Loop.runCalm : JunoMotion.Loop.run / 2
            return Self.keyframes(Self.lit, at: Self.progress(now, delay: Double(Self.sequence[index]) * 0.15, period: beat))
        case .writing:
            guard row == 2 else { return 0 }
            return Self.keyframes(Self.litType, at: Self.progress(now, delay: Double(column) * 0.2, period: period))
        case .waiting, .failed, .paused, .settled:
            return 0
        }
    }

    /// The still frame a phase shows under Reduce Motion and when it does not
    /// own the loop (SPEC §7.9's reduced-motion block).
    public static func staticSignature(_ phase: JunoRunGlyphPhase, row: Int, column: Int) -> Double {
        switch phase {
        case .thinking: return row == 1 && column == 1 ? 1 : 0
        case .searching: return column == 1 ? 1 : 0
        case .reading: return row == 1 ? 1 : 0
        case .tool:
            if row == 1 && column == 1 { return 0.6 }
            return (row == 0 || row == 2) && (column == 0 || column == 2) ? 1 : 0
        case .writing: return row == 2 ? 1 : 0
        case .waiting, .failed, .paused, .settled: return 0
        }
    }

    // MARK: Keyframes

    public typealias Keyframes = [(at: Double, opacity: Double)]
    /// `run-lit`: 0% 0 · 6% 1 · 30% .3 · 42%–100% 0.
    public static let lit: Keyframes = [(0, 0), (0.06, 1), (0.30, 0.3), (0.42, 0), (1, 0)]
    /// `run-lit-bar`: 0% 0 · 8% 1 · 28% .25 · 40%–100% 0.
    static let litBar: Keyframes = [(0, 0), (0.08, 1), (0.28, 0.25), (0.40, 0), (1, 0)]
    /// `run-lit-type`: 0% 0 · 4% 1 · 60% .7 · 80%–100% 0.
    static let litType: Keyframes = [(0, 0), (0.04, 1), (0.60, 0.7), (0.80, 0), (1, 0)]

    /// Where a looping animation with this delay and period is, 0…1, on the
    /// shared clock.
    static func progress(_ now: TimeInterval, delay: TimeInterval, period: TimeInterval) -> Double {
        var x = (now - delay).truncatingRemainder(dividingBy: period) / period
        if x < 0 { x += 1 }
        return x
    }

    /// Linear interpolation between keyframes, as CSS does with `linear`.
    public static func keyframes(_ frames: Keyframes, at progress: Double) -> Double {
        for (current, next) in zip(frames, frames.dropFirst()) where progress <= next.at {
            let span = next.at - current.at
            guard span > 0 else { return next.opacity }
            return current.opacity + (next.opacity - current.opacity) * (progress - current.at) / span
        }
        return frames.last?.opacity ?? 0
    }

    /// `run-breathe-opacity`: 0.55 ↔ 1 over the calm loop.
    static func breath(_ now: TimeInterval) -> Double {
        let x = progress(now, delay: 0, period: JunoMotion.Loop.runCalm)
        let wave = (1 - cos(x * 2 * .pi)) / 2
        return 0.55 + 0.45 * wave
    }
}

/// A run's phase label, with the one shimmer the run is allowed — the
/// compositor sweep (SPEC §7.9 `.run-sweep`).
///
/// The words are set in the secondary ink; a window of the foreground ink
/// (`transparent 35%, black 50%, transparent 65%` of the label's width)
/// crosses them from −65% to +65% over the first three quarters of each loop
/// and rests for the last, clipped to the glyphs so the canvas around them
/// never brightens. Transform and opacity only. The window is gone when the
/// run is **calm**, when it settles, when it does not own the loop, and under
/// Reduce Motion.
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
                let travel = min(1, t / 0.75)
                base
                    .overlay {
                        GeometryReader { proxy in
                            let width = proxy.size.width
                            Text(text)
                                .foregroundStyle(Color.junoForeground)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .frame(width: width, alignment: .leading)
                                .mask(
                                    LinearGradient(
                                        stops: [
                                            .init(color: .clear, location: 0.35),
                                            .init(color: .black, location: 0.5),
                                            .init(color: .clear, location: 0.65),
                                        ],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                    .frame(width: width)
                                    .offset(x: width * (-0.65 + 1.3 * travel))
                                )
                        }
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
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

/// A running tool call's marker: a ring, never the tool's icon (SPEC §7.9
/// `.run-marker`). The loop owner's ring breathes on the run loop; every other
/// one — the peek's, and any row while something else owns the loop — is a
/// static open ring. Waiting for approval is a ring in the accent.
public struct JunoRunMarker: View {
    public enum State: Sendable { case running, waiting }

    private let state: State
    private let loops: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ state: State, loops: Bool = false) {
        self.state = state
        self.loops = loops
    }

    public var body: some View {
        TimelineView(.animation(paused: !(loops && state == .running))) { context in
            let now = context.date.timeIntervalSinceReferenceDate
            let x = JunoRunSignature.progress(
                now, delay: 0, period: reduceMotion ? JunoMotion.Loop.runCalm : JunoMotion.Loop.run
            )
            let wave = (1 - cos(x * 2 * .pi)) / 2
            let breathing = loops && state == .running
            Circle()
                .strokeBorder(
                    state == .waiting ? Color.junoAccent : Color.junoForeground.opacity(0.5),
                    lineWidth: 1.5
                )
                .opacity(breathing ? (reduceMotion ? 0.55 + 0.45 * wave : 0.45 + 0.55 * wave) : 0.8)
                .scaleEffect(breathing && !reduceMotion ? 0.8 + 0.2 * wave : 1)
        }
        .frame(width: 12, height: 12)
        .accessibilityHidden(true)
    }
}
