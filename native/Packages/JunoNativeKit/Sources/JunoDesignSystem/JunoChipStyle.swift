import SwiftUI

/// The chip's numbers (§4.3 of `docs/native/MACOS_LIQUID_GLASS_REDESIGN.md`):
/// the web's `starter-chips.tsx`, `h-8 pl-2.5 pr-3 gap-2` at the Mac's pointer
/// height rather than its 32px.
public enum JunoChipMetrics {
    /// A pointer control, not a touch target (§0.6).
    public static let height: CGFloat = 28
    /// The glyph side sits nearer the rim than the label side, so the glyph's
    /// own side bearing does not read as extra padding.
    public static let leadingPadding: CGFloat = 10
    public static let trailingPadding: CGFloat = 12
    public static let glyphSize: CGFloat = 16
    public static let glyphGap: CGFloat = 6
    /// Between chips in a row, and between wrapped rows.
    public static let spacing: CGFloat = 8
}

/// A chip on content: an outlined capsule that fills on hover.
///
/// **Content, not chrome, so never glass** (§0.1). A chip sits on the warm
/// canvas beside the greeting or under a reply, and a pane of glass there would
/// sample whatever the transcript happens to be behind it; the clear fill and a
/// hairline read the same over everything.
///
/// **Never coral** (§0.4). Its ink is secondary at rest and foreground under
/// the pointer — the web's `text-muted-foreground hover:text-foreground` — and
/// the glyph takes the same ink, so the two cross-fade as one.
///
/// Apply it to a `Button` whose label is a `Label`: the style sets the glyph's
/// box and the gap, so every chip in the product has the same geometry without
/// each call site restating it.
public struct JunoChipStyle: ButtonStyle {
    /// Open, as a starter chip whose examples are showing: the selected tone,
    /// one step past hover, with foreground ink (the web's `aria-expanded`).
    let isSelected: Bool

    public init(isSelected: Bool = false) {
        self.isSelected = isSelected
    }

    public func makeBody(configuration: Configuration) -> some View {
        Chip(configuration: configuration, isSelected: isSelected)
    }

    private struct Chip: View {
        let configuration: ButtonStyleConfiguration
        let isSelected: Bool
        @State private var hovered = false
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.colorSchemeContrast) private var contrast

        private var fill: Color {
            if configuration.isPressed { return Color.junoSecondary }
            if isSelected { return Color.junoSelectedFill }
            return hovered ? Color.junoHover : Color.clear
        }

        var body: some View {
            configuration.label
                .labelStyle(JunoChipLabelStyle())
                .junoType(.ui)
                .lineLimit(1)
                .foregroundStyle(hovered || isSelected || configuration.isPressed ? Color.junoForeground : Color.junoSecondaryInk)
                .padding(.leading, JunoChipMetrics.leadingPadding)
                .padding(.trailing, JunoChipMetrics.trailingPadding)
                .frame(height: JunoChipMetrics.height)
                .background(Capsule().fill(fill))
                .overlay {
                    Capsule().strokeBorder(
                        Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased)),
                        lineWidth: 1
                    )
                }
                .contentShape(Capsule())
                .opacity(isEnabled ? 1 : 0.5)
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1)
                .onHover { hovered = $0 && isEnabled }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

/// The chip's label: a 16pt glyph, 6pt, then the words.
private struct JunoChipLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: JunoChipMetrics.glyphGap) {
            configuration.icon
                .frame(width: JunoChipMetrics.glyphSize, height: JunoChipMetrics.glyphSize)
            configuration.title
        }
    }
}
