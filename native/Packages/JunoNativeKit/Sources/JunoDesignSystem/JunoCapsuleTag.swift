import SwiftUI

/// A small word in a capsule: a capability chip, a "Smart" badge, a
/// "Recommended" mark.
///
/// Text first, with an optional Lucide mark before it — the mark is a
/// clarifier, never the whole chip, so a row of them still reads as words.
/// Neutral by default (`junoMuted` ground, muted ink); `tint` paints the ink
/// and a thin wash of the same colour for the one chip on a surface that is
/// an emphasis rather than a fact.
public struct JunoCapsuleTag: View {
    private let text: String
    private let icon: JunoIcon?
    private let tint: Color?

    public init(_ text: String, icon: JunoIcon? = nil, tint: Color? = nil) {
        self.text = text
        self.icon = icon
        self.tint = tint
    }

    public var body: some View {
        HStack(spacing: JunoSpace.hairline) {
            if let icon {
                JunoIconView(icon, size: 10)
                    .opacity(0.8)
            }
            Text(text)
        }
        .junoFont(size: 10, relativeTo: .caption2, weight: .medium)
        .foregroundStyle(tint ?? Color.junoMutedForeground)
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, JunoSpace.tight)
        .padding(.vertical, 2)
        .background {
            Capsule()
                .fill(tint.map { $0.opacity(0.12) } ?? Color.junoMuted.opacity(0.5))
        }
        .overlay {
            if tint == nil {
                Capsule().strokeBorder(Color.junoHairline, lineWidth: 0.5)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }
}
