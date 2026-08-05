import JunoDesignSystem
import SwiftUI

// MARK: - Segmented control

/// The website's view switcher: a quiet track with one raised thumb.
///
/// Replaces `Picker(...).pickerStyle(.segmented)`, whose AppKit chrome is the
/// wrong weight for a control sitting *inside* content — hard dividers and a
/// slab that announces itself louder than the thing it switches. The web's is
/// a `bg-muted/70` track with a `bg-card` thumb that carries the pop shadow, and
/// the thumb is one view that **moves** between slots rather than two that
/// cross-fade, so the switch reads as a physical throw. The phone's
/// `JunoMobileSegmented` is the same control; the two are separate only because
/// the apps share no view layer.
///
/// It lived in `DesktopArtifactCanvas.swift` under a canvas-specific name until
/// the product switch needed it too, which is the moment the name stopped being
/// true. Both of its callers are the same case: a switcher sitting *in* the
/// content rather than in the window's chrome. The product switch shipped once
/// with AppKit's picker on the sidebar's own material and read as a flat, dim
/// slab — the exact complaint this control was written to answer, made twice
/// because it was a file away from the surface that needed it.
struct DesktopSegmented<Value: Hashable>: View {
    struct Option: Identifiable {
        let value: Value
        let title: String
        var id: Value { value }

        init(_ value: Value, _ title: String) {
            self.value = value
            self.title = title
        }
    }

    let options: [Option]
    @Binding var selection: Value
    var accessibilityLabel: String

    /// The track's radius is the thumb's plus the track's own padding, so the two
    /// curves are concentric rather than merely both rounded.
    private static var trackRadius: CGFloat { JunoCornerRadius.control + 2 }

    @Namespace private var thumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let selected = option.value == selection
                Button {
                    withAnimation(
                        JunoMotion.reduced(
                            DesktopChatMotion.segmentTravel,
                            when: reduceMotion
                        )
                    ) {
                        selection = option.value
                    }
                } label: {
                    Text(option.title)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(selected ? Color.primary : Color.junoMutedForeground)
                        .padding(.horizontal, 10)
                        .frame(height: 28)
                        .background {
                            if selected {
                                RoundedRectangle(
                                    cornerRadius: JunoCornerRadius.control,
                                    style: .continuous
                                )
                                .fill(Color.junoRaised)
                                .shadow(color: .junoCardShadow, radius: 2, y: 1)
                                .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(.rect)
                }
                .buttonStyle(DesktopSegmentStyle())
                .accessibilityLabel(option.title)
                .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: Self.trackRadius, style: .continuous)
                .fill(Color.junoMuted.opacity(0.7))
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// The web's `active:scale-[0.97]` on the same curve the thumb travels on, so a
/// press and the throw it causes are one gesture rather than two animations.
private struct DesktopSegmentStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(
                JunoMotion.reduced(DesktopChatMotion.segmentTravel, when: reduceMotion),
                value: configuration.isPressed
            )
    }
}
