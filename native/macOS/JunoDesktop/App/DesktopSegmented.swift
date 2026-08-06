import JunoDesignSystem
import SwiftUI

// MARK: - Segmented control

/// The view switcher: a quiet capsule track with one knob of real Liquid Glass.
///
/// Replaces `Picker(...).pickerStyle(.segmented)`, whose AppKit chrome is the
/// wrong weight for a control sitting *inside* content — hard dividers and a
/// slab that announces itself louder than the thing it switches. That picker
/// also does not get Tahoe's glass for free: screenshotting the running window
/// showed `NSSegmentedControl` drawing its pre-Tahoe appearance inside a toolbar
/// item, a flat grey knob whose radius did not even match its track's.
///
/// **The knob is the only glass.** Glass is for the thing that floats, and the
/// knob is the thing that floats; the track stays a plain fill. Making both
/// glass flattens both, because glass cannot sample glass. `glassEffectID`
/// inside a `GlassEffectContainer` is what carries the knob between segments as
/// one continuous piece of material — it stretches and re-forms rather than
/// cross-fading in place, which is the motion the phone's Apple Music tab bar
/// has and a `matchedGeometryEffect` rectangle never will.
///
/// Two constraints here were found by looking at the window rather than by
/// reasoning, and both are easy to undo by accident:
///
/// * **The effect goes on the label, not behind it.** As a `.background` the
///   knob swallows its own text: inside a container the glass elements are
///   composited as a group, and that group draws above a label the modifier was
///   never attached to, so the selected segment renders as an empty capsule.
/// * **The container must not be `.focusable()`.** SwiftUI hands initial focus
///   to the first focusable view, so a focusable switcher wears a permanent
///   accent ring that reads as an error badge on a freshly opened window. The
///   segments are ordinary Buttons, so Full Keyboard Access still tabs to them
///   and Space activates them, each drawing the system ring only when focus is
///   really on it. Arrow keys between segments are the cost; VoiceOver keeps the
///   equivalent through the adjustable action below, and there is a
///   `CommandMenu("Product")` for the keyboard.
///
/// The phone's `JunoMobileSegmented` is the same control; the two are separate
/// only because the apps share no view layer.
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

    @Namespace private var knob
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var travel: Animation? {
        JunoMotion.reduced(DesktopChatMotion.segmentTravel, when: reduceMotion)
    }

    var body: some View {
        // spacing 0: the knob is a single element, so there is no second piece
        // of glass for it to blend with. The container is here to give that one
        // element a shared sampling region and somewhere to morph within.
        JunoDesktopGlass(spacing: 0) {
            HStack(spacing: 2) {
                ForEach(options) { option in
                    let selected = option.value == selection
                    Button {
                        withAnimation(travel) { selection = option.value }
                    } label: {
                        Text(option.title)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(
                                selected ? Color.primary : Color.junoMutedForeground
                            )
                            .padding(.horizontal, 12)
                            .frame(height: 28)
                            .modifier(GlassKnob(active: selected, namespace: knob))
                            .contentShape(.capsule)
                    }
                    .buttonStyle(DesktopSegmentStyle())
                    .accessibilityLabel(option.title)
                    .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
                }
            }
        }
        .padding(2)
        .background(Capsule(style: .continuous).fill(Color.junoMuted.opacity(0.55)))
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
            withAnimation(travel) { selection = options[next].value }
        }
    }
}

/// Glass, but only for the segment that is selected.
///
/// The id is shared across every segment on purpose. One element carrying one
/// id, present in a different position each time selection changes, is what the
/// container reads as "the same piece of material, moved" — which is the
/// travelling knob. Give each segment its own id and they materialise in place
/// instead, which is a different control.
private struct GlassKnob: ViewModifier {
    let active: Bool
    let namespace: Namespace.ID

    func body(content: Content) -> some View {
        if active {
            content
                .junoGlass(in: Capsule(style: .continuous), interactive: true)
                .junoGlassID("knob", in: namespace)
        } else {
            content
        }
    }
}

/// The web's `active:scale-[0.97]` on the same curve the knob travels on, so a
/// press and the throw it causes are one gesture rather than two animations.
///
/// Interactive glass already flexes under the pointer, so this stays subtle —
/// the two together should read as one press, not as a control that shrinks
/// twice.
private struct DesktopSegmentStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(
                JunoMotion.reduced(DesktopChatMotion.segmentTravel, when: reduceMotion),
                value: configuration.isPressed
            )
    }
}
