import SwiftUI

/// A status line that shimmers while something is happening — "Thinking…",
/// "Searching the web", "Running tests" — the web's `shimmer-text`.
///
/// One light band sweeps across the words on a loop. It is a *status* signal,
/// not decoration: the text is already the message, and the shimmer is what
/// says it is still true. Under Reduce Motion the sweep stops and the words
/// sit at their resting ink, because a looping animation is exactly what that
/// setting asks to be removed.
///
/// The sweep is a mask over a gradient rather than a moving overlay, so it
/// never brightens the canvas around the glyphs.
public struct JunoShimmerText: View {
    private let text: String
    private let font: Font
    private let active: Bool

    public init(_ text: String, font: Font = .subheadline.weight(.medium), active: Bool = true) {
        self.text = text
        self.font = font
        self.active = active
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period: TimeInterval = 1.8

    public var body: some View {
        if active, !reduceMotion {
            TimelineView(.animation) { context in
                let phase = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: Self.period) / Self.period
                base
                    .overlay {
                        GeometryReader { proxy in
                            let width = proxy.size.width
                            LinearGradient(
                                colors: [
                                    Color.junoForeground.opacity(0),
                                    Color.junoForeground,
                                    Color.junoForeground.opacity(0),
                                ],
                                startPoint: .leading, endPoint: .trailing
                            )
                            .frame(width: max(40, width * 0.55))
                            .offset(x: -width * 0.55 + (width * 1.55) * phase)
                        }
                        // The mask belongs to the whole overlay, laid out at
                        // the text's own size. Applied to the narrow, offset
                        // band it re-laid the words inside the band, so a
                        // second, shifted and truncated copy of the line
                        // ghosted over the first ("3 rums in progress").
                        .mask(base)
                    }
            }
            .accessibilityLabel(text)
        } else {
            base
        }
    }

    private var base: some View {
        Text(text)
            .font(font)
            .foregroundStyle(Color.junoMutedForeground)
            .lineLimit(1)
    }
}

#Preview("Shimmer") {
    VStack(alignment: .leading, spacing: 12) {
        JunoShimmerText("Thinking…")
        JunoShimmerText("Searching the web for Liquid Glass guidance")
        JunoShimmerText("Done", active: false)
    }
    .padding()
}
