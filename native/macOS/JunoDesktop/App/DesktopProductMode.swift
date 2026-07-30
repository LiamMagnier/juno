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

/// The top-level Chat / Code switch, as the platform's own segmented control.
///
/// This was a pair of `Button`s in a rounded rectangle, with a drop-shadowed
/// white pill standing in for the selected segment. That reproduces the *look* of
/// a segmented control on one OS version and then drifts: it misses the real
/// control's keyboard traversal, its focus ring, its pressed and disabled states,
/// and its Increase Contrast treatment. `Picker` in `.segmented` style is the
/// component; there is no reason to imitate it.
///
/// **A Liquid Glass rebuild was tried and reverted.** This comment used to claim
/// the system grants segmented controls glass for free on macOS 26; it does not,
/// at least not inside a toolbar item, where AppKit draws the pre-Tahoe track and
/// knob. A hand-built `GlassEffectContainer` version with a `glassEffectID` knob
/// did produce the glass capsule — and cost arrow-key traversal, because a
/// focusable container takes initial focus and wears a permanent accent ring. It
/// was reverted by preference: the native control's behaviour is worth more than
/// the material. Do not re-derive the glass version from the old comment's premise
/// without re-checking it against a screenshot.
///
/// **Metrics.** The control used to be pinned to a flat `.frame(width: 148)` by
/// its toolbar item, which is where the cramped look came from: 148pt split
/// between two segments leaves each label sitting on its own segment's edge, and
/// a fixed width cannot grow when the user turns up their text size. It now
/// asks for a per-segment measure instead, so the labels keep real shoulders and
/// the pill scales with Dynamic Type.
///
/// **Motion.** The knob's slide is the system's, but only if the change is
/// animated — a `@SceneStorage`-backed binding set outside a transaction moves
/// it in one frame. Writing through `withAnimation` is what makes the segment
/// travel, and it is also what drives the workspace transition on the other side
/// of the binding, so the pill and the content move together rather than the
/// content snapping while the pill glides.
struct DesktopProductSwitcher: View {
    @Binding var selection: DesktopProductMode
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Wide enough for "Chat"/"Code" plus the shoulders a segmented control
    /// wants on each side. A minimum rather than a fixed size: the control may
    /// grow for a longer localisation or a larger text size, it may not shrink
    /// below legibility.
    private static let minimumSegmentWidth: CGFloat = 58

    private var animatedSelection: Binding<DesktopProductMode> {
        Binding(
            get: { selection },
            set: { mode in
                guard mode != selection else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    selection = mode
                }
            }
        )
    }

    var body: some View {
        Picker("Juno product", selection: animatedSelection) {
            ForEach(DesktopProductMode.allCases) { mode in
                Text(mode.label)
                    .tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        // `.regular`, the size every other toolbar control uses.
        //
        // At `.large` the switch was the tallest and widest thing in the titlebar —
        // a chunky pill that dominated the window's own title, and, because two
        // leading toolbar items share the space before the title, one that squeezed
        // the session name into a slot narrow enough to truncate ("Fix the design of
        // Jun…") while the bar had obvious room to spare.
        .controlSize(.regular)
        .frame(
            minWidth: Self.minimumSegmentWidth * CGFloat(DesktopProductMode.allCases.count)
        )
        .fixedSize()
        .accessibilityIdentifier("Juno product")
    }
}
