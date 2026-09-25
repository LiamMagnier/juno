import JunoCore
import SwiftUI

// MARK: - Tone

/// The five tones a status mark can take, and the whole vocabulary: the web's
/// `StatusTone` (`src/lib/conversation-status.ts`), which a Work run and a
/// Code run both map onto.
///
/// A tone is a meaning before it is a colour. `live` is the one that spends
/// the accent; `attention` is the warning ink, `good` success, `bad`
/// destructive, and everything else is the column's secondary ink.
public enum JunoStatusTone: String, CaseIterable, Sendable {
    case neutral
    case live
    case attention
    case good
    case bad

    /// A Work status's tone: `work-vocabulary.tsx` `STATUS_META`, verbatim.
    ///
    /// Read beside the dot rather than in each caller, so the sidebar row, the
    /// menu-bar extra and a snapshot can never paint one status two ways.
    /// `interrupted`, `budget_exceeded` and `timed_out` are attention rather
    /// than bad, as the web has them: each is over and still carries a choice
    /// (run it again, raise the budget), which is what the warning ink says.
    public init(_ status: JunoWorkStatus) {
        switch status {
        case .draft, .queued, .paused, .cancelled: self = .neutral
        case .preparing, .running: self = .live
        case .waitingInput, .waitingApproval, .interrupted, .hostOffline, .budgetExceeded, .timedOut:
            self = .attention
        case .completed: self = .good
        case .failed: self = .bad
        }
    }

    /// The ink the dot is filled with.
    public var color: Color {
        switch self {
        case .neutral: Color.junoSecondaryInk
        case .live: Color.junoAccent
        case .attention: Color.junoWarning
        case .good: Color.junoSuccess
        case .bad: Color.junoDestructive
        }
    }

    /// The glyph that stands in for the dot under Differentiate Without Color:
    /// a shape per tone, so the state survives without its hue.
    public var glyph: JunoIcon {
        switch self {
        case .neutral: .circle
        case .live: .loader
        case .attention: .error
        case .good: .circleCheck
        case .bad: .circleX
        }
    }
}

// MARK: - Dot

/// A toned 6pt dot with its meaning for VoiceOver, and nothing else: the
/// row-density mark (`StatusDot` in `work-vocabulary.tsx`).
///
/// **State, never decoration.** It is drawn only where something real is
/// happening — a run still open behind a sidebar row — and the row that
/// carries it says the same thing in words (its help and its value).
///
/// **One loop.** A `live` dot breathes between full and 45% on the
/// `status-glow` period (2.8s). It stops, fully lit, under Reduce Motion, and
/// wherever the caller says something else on screen owns the loop.
///
/// **Without colour.** Under Differentiate Without Color the dot becomes a
/// 10pt glyph in the same ink (a spinner ring, a warning circle, a tick, a
/// cross or a ring) so five states are five shapes. `bad` is always its cross,
/// so a failed run never reads as a running one that has stopped breathing.
public struct JunoStatusDot: View {
    /// The dot's diameter: the web's `size-1.5`.
    public static let diameter: CGFloat = 6
    /// The glyph's box under Differentiate Without Color.
    public static let glyphSize: CGFloat = 10
    /// How far a live dot fades: `status-glow`'s floor.
    static let breatheFloor: Double = 0.45

    private let tone: JunoStatusTone
    private let label: String?
    private let breathes: Bool
    private let glyphOverride: Bool?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @State private var dimmed = false

    private var withoutColor: Bool { glyphOverride ?? differentiateWithoutColor }

    /// - Parameters:
    ///   - label: what the dot means, for VoiceOver ("Needs approval"). Nil
    ///     hides the dot from assistive technology, for a caller that already
    ///     says the state in its own words.
    ///   - breathes: whether a live dot may move. Pass false where another
    ///     mark on screen owns the one loop.
    ///   - differentiatesWithoutColor: forces the glyph form on or off, for a
    ///     snapshot; nil follows the system setting.
    public init(
        _ tone: JunoStatusTone,
        label: String? = nil,
        breathes: Bool = true,
        differentiatesWithoutColor: Bool? = nil
    ) {
        self.tone = tone
        self.label = label
        self.breathes = breathes
        self.glyphOverride = differentiatesWithoutColor
    }

    private var isBreathing: Bool {
        tone == .live && breathes && !reduceMotion && !withoutColor
    }

    public var body: some View {
        Group {
            // A failed run is a cross at all times, not only without colour:
            // the destructive and accent inks are near twins at 6pt (the web's
            // --destructive and --primary), and under Reduce Motion a running
            // dot stops breathing, which left the two rows identical. The
            // Mac's addition (register #173).
            if withoutColor || tone == .bad {
                JunoIconView(tone.glyph, size: Self.glyphSize, weight: .bold)
                    .foregroundStyle(tone.color)
            } else {
                Circle()
                    .fill(tone.color)
                    .frame(width: Self.diameter, height: Self.diameter)
                    .opacity(isBreathing && dimmed ? Self.breatheFloor : 1)
                    .animation(
                        isBreathing
                            ? JunoMotion.ambient(
                                JunoMotion.breathe(period: JunoMotion.Loop.statusBreathe),
                                when: reduceMotion
                            )
                            : nil,
                        value: dimmed
                    )
            }
        }
        .frame(width: Self.glyphSize, height: Self.glyphSize)
        .onAppear { dimmed = isBreathing }
        .onChange(of: isBreathing) { _, breathing in dimmed = breathing }
        .accessibilityElement()
        .accessibilityLabel(label ?? "")
        .accessibilityHidden(label == nil)
    }
}
