import JunoDesignSystem
import SwiftUI

enum DesktopProductMode: String, CaseIterable, Identifiable {
    case chat
    case code
    /// Juno Work — tasks that run somewhere, on a Mac or in the cloud, rather
    /// than a conversation that runs here. It is a third top-level product and
    /// not a Chat destination because it owns the window: its own source list of
    /// tasks, its own thread, and its own toolbar.
    case work

    var id: Self { self }

    var label: String {
        switch self {
        case .chat: "Chat"
        case .code: "Code"
        case .work: "Work"
        }
    }

    var symbol: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .work: "checklist"
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
/// without re-checking it against a screenshot. The control has since left the
/// toolbar for the sidebar (see ``DesktopSidebarProductHeader``), which retires
/// the *premise* of that note but not its finding: the traversal cost came from
/// the focusable container, and a container is focusable wherever it is put.
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

    /// Wide enough for "Chat"/"Code"/"Work" plus the shoulders a segmented
    /// control wants on each side. A minimum rather than a fixed size: the
    /// control may grow for a longer localisation or a larger text size, it may
    /// not shrink below legibility. The total is multiplied by
    /// `allCases.count` below, so adding a product widens the pill instead of
    /// squeezing the existing segments.
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

/// Shared measurements for the strip above the two native source lists. Keeping
/// this here prevents Chat and Code from drifting when one of their sidebars is
/// refreshed.
///
/// The strip used to be empty and had one number. It now carries the product
/// switch, so it has two: what the *window* owns and what *Juno* draws under it.
/// Stated separately because they answer to different things — the first to
/// AppKit's titlebar geometry, the second to the height of a segmented control —
/// and adding them at the bottom is what keeps a change to either from silently
/// moving the other.
enum DesktopSidebarChromeMetrics {
    /// The band the window's own chrome owns: the titlebar and the toolbar row
    /// under it, with the traffic lights centred across them.
    ///
    /// Nothing of Juno's may be drawn above this line. A source list starts at
    /// the very top of the window on macOS — it is inset downward, not laid out
    /// below the chrome — so anything not cleared past this point is drawn behind
    /// the toolbar and under the window controls, which is exactly what the Code
    /// column did before it was inset at all.
    static let trafficLightClearance: CGFloat = 52

    /// The product switch's own row: a `.regular` segmented control, the shoulder
    /// it needs to clear the traffic lights above it, and the gap to the first
    /// source-list row below.
    static let productSwitcherRow: CGFloat = 24 + JunoSpace.tight + JunoSpace.snug

    /// Everything above the first source-list row: the window's chrome, then the
    /// switch. Both columns inset by this and both draw
    /// ``DesktopSidebarProductHeader`` in it, so the switch cannot end up at two
    /// heights in the two products.
    static let titlebarClearance: CGFloat = trafficLightClearance + productSwitcherRow
}

/// The Chat / Code switch, at the top of a source list.
///
/// **Why it is here rather than in the toolbar.** It is a switch between two
/// halves of the app, and the thing it switches is the column it now sits on top
/// of — the website has always drawn it that way (`app-sidebar.tsx`, a segmented
/// control as the sidebar's first element). In the titlebar it read as a window
/// control, `.principal` placement put it in permanent competition with the
/// window's own title for the centre of the bar, and moving between products
/// meant travelling to the top of the *content* column to change what the
/// *navigation* column was listing.
///
/// **Why it is opaque, which is the whole of the engineering.** This is where the
/// switch was the first time, as a bare `safeAreaInset` with nothing painted
/// behind it, and scrolled rows slid under it and on under the traffic lights.
/// The inset positions the scrolling *content*; it does not shorten the list. A
/// `.sidebar` List additionally **pins** its section headers to the top of its own
/// bounds, and a pinned header is not subject to the inset at all — so "Today" or
/// "Cloud & devices" arrives level with the window controls the moment the reader
/// scrolls, whatever the inset is set to. Only something opaque across the full
/// strip hides both. `Color.junoSidebar` rather than an arbitrary fill: it is the
/// column's own colour — the same one ``DesktopCodeAddProjectLabel`` knocks its
/// badge out against — so the strip reads as the column continuing rather than as
/// a bar laid on it.
///
/// This is a deliberate, scoped exception to the desktop vocabulary's first rule
/// (nothing paints a background behind a sidebar). The rule is about the *column*,
/// which stays vibrant from this strip down; the platform's own answer for the
/// other end, the soft scroll-edge effect, has no counterpart that survives a
/// pinned header.
///
/// **When the sidebar is collapsed** the switch goes with it. The answer is the
/// Product menu in ``JunoDesktopCommands`` — an inline `Picker` in the menu bar
/// that reads and writes the focused window's mode — which is reachable with the
/// column closed and shows a checkmark against the mode the window is in.
struct DesktopSidebarProductHeader: View {
    @Binding var product: DesktopProductMode

    var body: some View {
        DesktopProductSwitcher(selection: $product)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.bottom, JunoSpace.snug)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(
                height: DesktopSidebarChromeMetrics.titlebarClearance,
                alignment: .bottom
            )
            .background(Color.junoSidebar)
    }
}
