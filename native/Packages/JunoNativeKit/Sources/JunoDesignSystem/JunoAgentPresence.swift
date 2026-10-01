import Foundation
import SwiftUI

// An agent's presence: its face on a halo of its own tone, and the one live
// sentence it is living. The web's `agent-presence.tsx` and the "Presence"
// and "The live sentence" sections of `agent-face.css`.
//
// Colour and light carry the state around the face, the way the voice glow
// does in Chat: the halo is quiet when the agent is idle, breathes while it
// works, turns a slow light while it thinks, and is fuller while it waits on
// you. No ring, no dot, no badge.

/// The halo's behaviour per state, as data a test can read.
enum JunoAgentHalo {
    /// The halo's resting opacity.
    static func opacity(_ state: JunoAgentState) -> Double {
        switch state {
        case .working, .waiting: 1
        case .thinking: 0.8
        case .sleeping: 0.25
        case .idle, .blocked, .done, .listening: 0.55
        }
    }

    /// Whether the turning light shows.
    static func turns(_ state: JunoAgentState) -> Bool { state == .thinking }

    /// While working, the halo breathes: 0.7 to 1 and 0.96 to 1.06 over 2.7s.
    static let breathe = JunoFaceKeyframes(2.7, JunoAgentFaceRig.breathe, [
        (0, JunoFaceTransform(scale: 0.96, opacity: 0.7)),
        (0.5, JunoFaceTransform(scale: 1.06, opacity: 1)),
        (1, JunoFaceTransform(scale: 0.96, opacity: 0.7)),
    ])

    /// One turn of the thinking light.
    static let turnPeriod: TimeInterval = 3.6
}

/// An agent's face on its halo.
///
/// The halo reaches `spread` of the face's size beyond it on every side and
/// takes no layout room of its own: the view is the face's size, so rows and
/// cards lay out around the face exactly as they would without it. Hovering
/// the control it sits in brightens and swells the halo a little.
public struct JunoAgentPresence: View {
    private let avatar: JunoAgentAvatar
    private let state: JunoAgentState
    private let size: CGFloat
    private let name: String?
    private let spread: CGFloat
    private let level: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoAgentFaceTrigger) private var trigger

    /// - Parameters:
    ///   - size: the face's size in points.
    ///   - spread: how far the halo reaches beyond the face, as a fraction of
    ///     its size.
    ///   - level: while `listening`, the caller's voice level (0...1).
    public init(
        avatar: JunoAgentAvatar,
        state: JunoAgentState = .idle,
        size: CGFloat,
        name: String? = nil,
        spread: CGFloat = 0.45,
        level: CGFloat = 0
    ) {
        self.avatar = avatar
        self.state = state
        self.size = size
        self.name = name
        self.spread = spread
        self.level = level
    }

    public var body: some View {
        JunoAgentFace(avatar: avatar, state: state, size: size, name: name, level: level)
    }

}

/// The agent's one live sentence ("Drafting the renewal comparison"). A new
/// sentence rises into place; while the agent is busy (working or thinking)
/// the words carry a slow light, so progress is seen without a spinner or a
/// pill. One line, truncated at the tail.
public struct JunoAgentStatusLine: View {
    private let text: String
    private let state: JunoAgentState
    private let type: JunoType
    private let color: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        _ text: String,
        state: JunoAgentState,
        type: JunoType = .ui,
        color: Color = .junoSecondaryInk
    ) {
        self.text = text
        self.state = state
        self.type = type
        self.color = color
    }

    /// States in which an agent is busy on its own: the line carries a light.
    static func isLive(_ state: JunoAgentState) -> Bool {
        state == .working || state == .thinking
    }

    /// The light's sweep across the line, in seconds.
    static let shinePeriod: TimeInterval = 2.8

    public var body: some View {
        ZStack(alignment: .leading) {
            line
                .id(text)
                .transition(
                    .asymmetric(
                        insertion: .modifier(
                            active: JunoRiseIn(offset: JunoMotion.shift(type.size * 0.45, reduceMotion: reduceMotion), blur: 2, opacity: 0),
                            identity: JunoRiseIn(offset: 0, blur: 0, opacity: 1)
                        ),
                        removal: .opacity
                    )
                )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
        .animation(JunoMotion.reduced(JunoMotion.outSoft(JunoMotion.Duration.slow), when: reduceMotion, tier: .tint), value: text)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: text))
    }

    private var line: some View {
        Text(verbatim: text)
            .junoType(type)
            .foregroundStyle(color)
            .lineLimit(1)
            .truncationMode(.tail)
            .overlay {
                if Self.isLive(state), !reduceMotion {
                    TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                        let now = context.date.timeIntervalSinceReferenceDate
                        let phase = now.truncatingRemainder(dividingBy: Self.shinePeriod) / Self.shinePeriod
                        Text(verbatim: text)
                            .junoType(type)
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .mask {
                                GeometryReader { proxy in
                                    let band = max(proxy.size.width * 0.35, 40)
                                    LinearGradient(
                                        colors: [.clear, .black, .clear],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                    .frame(width: band)
                                    .offset(x: -band + CGFloat(phase) * (proxy.size.width + band))
                                }
                            }
                    }
                    .allowsHitTesting(false)
                    .transition(.opacity)
                }
            }
    }
}

/// The rise-in: up from below, out of a slight blur.
private struct JunoRiseIn: ViewModifier {
    let offset: CGFloat
    let blur: CGFloat
    let opacity: Double

    func body(content: Content) -> some View {
        content
            .offset(y: offset)
            .blur(radius: blur)
            .opacity(opacity)
    }
}
