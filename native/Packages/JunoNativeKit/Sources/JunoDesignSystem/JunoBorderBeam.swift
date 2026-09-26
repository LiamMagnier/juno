import SwiftUI

/// How a ``JunoBorderBeam`` draws.
public enum JunoBorderBeamStyle: Sendable {
    /// A short lit segment of the accent travelling the edge, once every
    /// ``JunoMotion/Loop/runCalm`` seconds. For a surface that is **working**:
    /// a reply streaming, a Code run in flight.
    case line
    /// A faint glow breathing just outside the edge. For a surface that is
    /// **waiting to be used**: the empty state's composer before the first
    /// keystroke.
    case pulse
}

/// The border beam: the native equivalent of the web's libraries.dev "Border
/// beam" (`line` and `pulse-outside`), built from an angular-gradient stroke
/// and a `TimelineView` rather than a React package (premium pass brief,
/// "Libraries.dev placements").
///
/// **Only live state.** The beam is drawn only while `isActive` is true, and
/// callers wire that to something real — a streaming flag, a running session,
/// an empty draft — never to "always". It is an overlay on a stroke, never a
/// fill or a material, so it adds no glass and never sits under text.
///
/// **One effect per element.** Never pair it with another effect on the same
/// surface or on a neighbour (the brief's rule).
///
/// **Reduce Motion.** Nothing travels and nothing breathes: `line` becomes a
/// still hairline in the accent at low strength, which still says "working";
/// `pulse` draws nothing, because a waiting composer needs no signal at all.
/// The timeline is paused whenever the beam is inactive, so it costs nothing
/// off duty.
public struct JunoBorderBeam: View {
    private let cornerRadius: CGFloat
    private let style: JunoBorderBeamStyle
    private let isActive: Bool
    private let tint: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    public init(
        cornerRadius: CGFloat,
        style: JunoBorderBeamStyle = .line,
        isActive: Bool,
        tint: Color = .junoAccent
    ) {
        self.cornerRadius = cornerRadius
        self.style = style
        self.isActive = isActive
        self.tint = tint
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }

    public var body: some View {
        Group {
            if !isActive {
                Color.clear
            } else if reduceMotion {
                if style == .line {
                    shape.strokeBorder(tint.opacity(0.35), lineWidth: 1)
                } else {
                    Color.clear
                }
            } else {
                TimelineView(.animation(minimumInterval: 1 / 60, paused: !isActive)) { context in
                    let phase = Self.phase(at: context.date, period: JunoMotion.Loop.runCalm)
                    switch style {
                    case .line:
                        line(phase: phase)
                    case .pulse:
                        pulse(phase: phase)
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// Where in its loop the beam is, 0…1, locked to the clock so every beam
    /// on screen agrees and a re-render never restarts it.
    static func phase(at date: Date, period: TimeInterval) -> Double {
        let t = date.timeIntervalSinceReferenceDate / period
        return t - t.rounded(.down)
    }

    private func line(phase: Double) -> some View {
        // A lit arc about a fifth of the way round, bright at its head and
        // fading along its tail, plus a faint resting edge so the head never
        // appears to come out of nowhere.
        let gradient = AngularGradient(
            stops: [
                .init(color: tint.opacity(0), location: 0),
                .init(color: tint.opacity(0), location: 0.72),
                .init(color: tint.opacity(0.55), location: 0.9),
                .init(color: tint, location: 0.97),
                .init(color: tint.opacity(0), location: 1),
            ],
            center: .center,
            angle: .degrees(phase * 360)
        )
        return ZStack {
            shape.strokeBorder(tint.opacity(colorScheme == .dark ? 0.16 : 0.12), lineWidth: 1)
            shape.strokeBorder(gradient, lineWidth: 1.5)
            // The head's bloom: the same arc, blurred, just outside the edge.
            shape.stroke(gradient, lineWidth: 3)
                .blur(radius: 4)
                .opacity(0.5)
        }
    }

    private func pulse(phase: Double) -> some View {
        // A breathe on `--ease-breathe`'s shape (a raised cosine): 0 → 1 → 0
        // over the calm loop, at low strength.
        let breathe = 0.5 - 0.5 * cos(phase * 2 * .pi)
        return shape
            .stroke(tint.opacity(0.10 + 0.14 * breathe), lineWidth: 2)
            .blur(radius: 5 + 3 * breathe)
            .padding(-2)
    }
}

public extension View {
    /// Draws a ``JunoBorderBeam`` over this view's edge while `isActive`.
    func junoBorderBeam(
        cornerRadius: CGFloat,
        style: JunoBorderBeamStyle = .line,
        isActive: Bool,
        tint: Color = .junoAccent
    ) -> some View {
        overlay {
            JunoBorderBeam(cornerRadius: cornerRadius, style: style, isActive: isActive, tint: tint)
        }
    }
}
