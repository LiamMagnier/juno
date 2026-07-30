import JunoDesignSystem
import SwiftUI

enum DesktopProductMode: String, CaseIterable, Identifiable {
    case chat
    case code

    var id: Self { self }

    var label: String {
        switch self {
        case .chat: "Chat"
        case .code: "Code"
        }
    }

    var symbol: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .code: "chevron.left.forwardslash.chevron.right"
        }
    }
}

/// The top-level Chat / Code switch, built from Liquid Glass.
///
/// **Why this is hand-built, after an explicit decision not to.** The version this
/// replaces was `Picker` in `.segmented` style, and the argument for it was sound
/// as far as it went: a real control brings keyboard traversal, the focus ring,
/// pressed and disabled states, Increase Contrast — "and on macOS 26 the glass the
/// system now gives segmented controls for free."
///
/// That last clause turned out to be false here. Screenshotting the running window
/// showed `NSSegmentedControl` drawing its pre-Tahoe appearance inside a toolbar
/// item: a flat grey track with a flat grey knob whose corner radius does not even
/// match the track's, which is what read as "a rectangle inside the pill". No glass
/// was being granted, so the trade the old comment described was not on offer — the
/// native control was costing the look without paying for it.
///
/// What it *did* bring is re-implemented rather than dropped, and that is the price
/// of this decision: arrow-key traversal, a focus ring, an Increase Contrast border,
/// Reduce Motion, and a single adjustable accessibility element that reads as one
/// control to VoiceOver instead of two buttons.
///
/// **The knob is the only glass.** `JunoSurfaces` says glass is for things that
/// float, and the knob is the thing that floats; the track is a plain fill. Making
/// both glass would flatten both, which is the same rule the computer-use indicator
/// follows when it puts a plain button inside a glass pill. `glassEffectID` inside a
/// `GlassEffectContainer` is what makes the knob *travel* between the segments as
/// one continuous piece of material rather than cross-fading in place.
struct DesktopProductSwitcher: View {
    @Binding var selection: DesktopProductMode
    @Namespace private var knob
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    /// Wide enough for "Chat"/"Code" plus the shoulders a segmented control wants.
    /// A minimum rather than a fixed size: the control may grow for a longer
    /// localisation or a larger text size, it may not shrink below legibility.
    private static let minimumSegmentWidth: CGFloat = 58
    private static let height: CGFloat = 24

    /// Optional because `JunoMotion.reduced` returns nil under Reduce Motion, and
    /// nil is exactly what both `withAnimation` and `.animation(_:value:)` want for
    /// "change this instantly".
    private var motion: Animation? {
        JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)
    }

    private func select(_ mode: DesktopProductMode) {
        guard mode != selection else { return }
        // The write is animated because two things read it: the knob's travel here,
        // and the workspace veil on the other side of the binding. Setting it
        // outside a transaction moves both in one frame.
        withAnimation(motion) { selection = mode }
    }

    private func move(_ delta: Int) {
        let modes = DesktopProductMode.allCases
        guard let index = modes.firstIndex(of: selection) else { return }
        // Clamped rather than wrapping: two segments that cycle make ← and → feel
        // like the same key.
        select(modes[min(max(index + delta, 0), modes.count - 1)])
    }

    var body: some View {
        GlassEffectContainer(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(DesktopProductMode.allCases) { mode in
                    segment(mode)
                }
            }
        }
        .background {
            Capsule(style: .continuous).fill(Color.junoRaised)
        }
        .overlay {
            // Increase Contrast wants an explicit edge; glass alone is too subtle
            // to satisfy it, and the system control drew one here for free.
            if contrast == .increased {
                Capsule(style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.4), lineWidth: 1)
            }
        }
        .clipShape(Capsule(style: .continuous))
        // Deliberately **not** `.focusable()`.
        //
        // Making the container focusable put a permanent accent ring around the
        // control: SwiftUI hands initial focus to the first focusable view, the
        // switcher is it, and the ring then reads as an error badge on a window that
        // has only just opened. That was true of a hand-drawn ring and equally true
        // of the platform's own.
        //
        // Keyboard access is not lost, it moves down a level: the two segments are
        // ordinary `Button`s, so Full Keyboard Access tabs to them and Space
        // activates them, each drawing the system focus ring only when focus is
        // genuinely on it. What that costs is ←/→ *between* segments, which the
        // `NSSegmentedControl` did offer. VoiceOver keeps the equivalent through the
        // adjustable action below, which is the interaction that actually matters
        // for a two-value control.
        // One element, not two buttons: a segmented control is a single value the
        // reader adjusts, and VoiceOver should read it as "Juno product, Code".
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Juno product")
        .accessibilityValue(selection.label)
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: move(1)
            case .decrement: move(-1)
            @unknown default: break
            }
        }
        .accessibilityIdentifier("Juno product")
    }

    /// The glass is applied **to the label**, not behind it.
    ///
    /// As a `.background` the knob swallowed its own text: inside a
    /// `GlassEffectContainer` the glass elements are composited as a group, and that
    /// group draws above a label the modifier was never attached to — so the
    /// selected segment rendered as an empty capsule. Attaching the effect to the
    /// text makes the material that text's own background, which is the shape the
    /// container expects and the only one that keeps the label on top.
    @ViewBuilder
    private func segment(_ mode: DesktopProductMode) -> some View {
        let isSelected = mode == selection
        Button {
            select(mode)
        } label: {
            let label = Text(mode.label)
                .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                .frame(minWidth: Self.minimumSegmentWidth, minHeight: Self.height)

            if isSelected {
                label
                    .junoGlass(in: Capsule(style: .continuous), interactive: true)
                    .glassEffectID("product", in: knob)
                    .contentShape(Capsule(style: .continuous))
            } else {
                label.contentShape(Capsule(style: .continuous))
            }
        }
        .buttonStyle(.plain)
        // The container above is the accessibility element; leaving these visible
        // would make VoiceOver announce the control three times.
        .accessibilityHidden(true)
    }
}
