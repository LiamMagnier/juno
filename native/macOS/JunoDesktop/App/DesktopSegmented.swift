import JunoDesignSystem
import SwiftUI

// MARK: - Segmented control

/// The view switcher: a flat inset track with one raised thumb that slides.
///
/// Replaces `Picker(...).pickerStyle(.segmented)`, whose AppKit chrome is the
/// wrong weight for a control sitting *inside* content — hard dividers and a
/// slab that announces itself louder than the thing it switches.
///
/// **Tonal, not glass.** The Soft UI direction (`docs/design/SOFT_UI.md` §4)
/// states depth on Apple as tonal: a `junoSurface` tile with a hairline and a
/// very soft shadow, on a `junoWell` inset. That is exactly what a thumb on a
/// track is, so the thumb is that tile, carried between segments by
/// `matchedGeometryEffect` on `JunoMotion.spring`. It slides; it does not
/// stretch, and no glyph bounces.
///
/// Three things happen on a switch, and they are deliberately separate:
///
/// * the thumb **travels** — one spring, one piece of geometry;
/// * the label **ink cross-fades** — a tint-tier change that survives Reduce
///   Motion, because a word changing colour is feedback, not movement;
/// * the pressed segment **dips** — `JunoMotion.press`, the 70ms rung, on the
///   label alone.
///
/// **The container must not be `.focusable()`.** SwiftUI hands initial focus
/// to the first focusable view, so a focusable switcher wears a permanent
/// accent ring that reads as an error badge on a freshly opened window. The
/// segments are ordinary Buttons, so Full Keyboard Access still tabs to them
/// and Space activates them. VoiceOver keeps arrow-style traversal through the
/// adjustable action below, and there is a `CommandMenu("Product")` for the
/// keyboard.
struct DesktopSegmented<Value: Hashable>: View {
    struct Option: Identifiable {
        let value: Value
        let title: String
        /// An optional website mark shown before the title. A plain glyph in
        /// the label's ink; it never animates on its own.
        let icon: JunoIcon?
        var id: Value { value }

        init(_ value: Value, _ title: String, icon: JunoIcon? = nil) {
            self.value = value
            self.title = title
            self.icon = icon
        }
    }

    let options: [Option]
    @Binding var selection: Value
    var accessibilityLabel: String
    var optionAccessibilityIdentifier: ((Value) -> String)? = nil
    /// Whether the segments share the track's width equally rather than sizing
    /// to their labels. The product switch at the top of a sidebar fills the
    /// column; a filter inside a page hugs its words.
    var fills = false

    @Namespace private var thumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let selected = option.value == selection
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.spring, when: reduceMotion)) {
                        selection = option.value
                    }
                } label: {
                    HStack(spacing: 5) {
                        if let icon = option.icon {
                            JunoIconView(icon, size: 12)
                                .accessibilityHidden(true)
                        }
                        Text(option.title)
                            .junoFont(size: 12, relativeTo: .body, weight: .medium)
                            // A segment never truncates. A label that cannot fit
                            // is a layout bug to fix at the call site.
                            .lineLimit(1)
                            .fixedSize()
                    }
                    .foregroundStyle(
                        selected ? Color.junoForeground : Color.junoMutedForeground
                    )
                    // The ink is the one thing here that changes without moving,
                    // so it keeps its curve under Reduce Motion.
                    .animation(
                        JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint),
                        value: selected
                    )
                    .padding(.horizontal, option.icon == nil ? 12 : 10)
                    .frame(maxWidth: fills ? .infinity : nil)
                    .frame(height: 28)
                    .background {
                        if selected {
                            DesktopSegmentThumb()
                                .matchedGeometryEffect(id: "thumb", in: thumb)
                        }
                    }
                    .contentShape(.capsule)
                }
                .buttonStyle(DesktopSegmentStyle())
                .accessibilityLabel(option.title)
                .accessibilityIdentifier(
                    optionAccessibilityIdentifier?(option.value) ?? ""
                )
                .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(2)
        // The track is the well: the secondary fill with an inner hairline, so
        // the thumb has something to be raised *from*.
        .background {
            Capsule(style: .continuous)
                .fill(Color.junoMuted.opacity(0.55))
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(Color.junoHairline, lineWidth: 0.5)
                )
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
        // What `.focusable()` would have bought, without the permanent ring:
        // VoiceOver treats the switcher as one adjustable control.
        .accessibilityAdjustableAction { direction in
            guard let index = options.firstIndex(where: { $0.value == selection })
            else { return }
            let next: Int
            switch direction {
            case .increment: next = index + 1
            case .decrement: next = index - 1
            @unknown default: return
            }
            guard options.indices.contains(next) else { return }
            withAnimation(JunoMotion.reduced(JunoMotion.spring, when: reduceMotion)) {
                selection = options[next].value
            }
        }
    }
}

/// The raised thumb: the Soft UI tile — surface fill, hairline, the one
/// sanctioned soft throw — in a capsule.
///
/// One view, one `matchedGeometryEffect` id, present under whichever segment
/// is selected. That is what the layout reads as "the same tile, moved", which
/// is the sliding thumb.
private struct DesktopSegmentThumb: View {
    var body: some View {
        Capsule(style: .continuous)
            .fill(Color.junoSurface)
            .shadow(
                color: Color.junoCardShadow,
                radius: JunoElevation.cardBlur,
                y: JunoElevation.cardOffsetY
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(Color.junoHairline, lineWidth: 0.5)
            )
    }
}

/// The press dip: the web's `active:scale-[0.97]` on the 70ms press rung.
///
/// On the label only. The thumb travels on its own spring, and a press that
/// also scaled the thumb would read as the control shrinking twice.
private struct DesktopSegmentStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(
                JunoMotion.reduced(JunoMotion.press, when: reduceMotion),
                value: configuration.isPressed
            )
    }
}
