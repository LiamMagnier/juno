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

/// The top-level Chat / Code / Work switch, in the app's own segmented control.
///
/// **Why not AppKit's.** For as long as this lived in the toolbar it was
/// `Picker(...).pickerStyle(.segmented)`, and that was the right call there:
/// window chrome is exactly where AppKit's chrome belongs, and imitating a
/// system control that sits among system controls is how a window ends up
/// looking like a rendering of itself. Moving it to the top of the sidebar
/// changed the question. On the sidebar's own material the same picker draws a
/// flat, dim slab with hard dividers — louder than the column it heads and
/// lit from nowhere the rest of the surface is lit from. That is verbatim the
/// complaint ``DesktopSegmented`` was written to answer for the artifact
/// canvas, and it went unanswered here only because the control was in another
/// file under a name that claimed to be about canvases.
///
/// **What that costs, stated plainly.** AppKit's control gives arrow-key
/// traversal across segments from one tab stop; a row of buttons gives one tab
/// stop per segment and no arrow keys. The keyboard answer is not the control,
/// it is the Product menu in ``JunoDesktopCommands`` — an inline `Picker` in the
/// menu bar that shows a checkmark against the current mode and works with the
/// column collapsed, which the control itself cannot do at all.
///
/// This is also the note that used to warn against hand-building. It was written
/// about a `GlassEffectContainer` version whose knob carried a `glassEffectID`,
/// and its finding was specific: a *focusable container* takes initial focus and
/// wears a permanent accent ring. ``DesktopSegmented`` has no container to focus
/// — it is an `HStack` of ordinary buttons — so the finding does not reach it.
/// Do not read the old warning as a general one; it was about a shape, not about
/// hand-building.
///
/// **Motion.** The binding is written through `withAnimation` because that
/// transaction drives two things at once: the thumb's throw between segments and
/// the workspace veil on the other side of the binding. Set outside one, the
/// thumb jumps and the window changes under it as two separate events.
struct DesktopProductSwitcher: View {
    @Binding var selection: DesktopProductMode
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
        DesktopSegmented(
            options: DesktopProductMode.allCases.map { .init($0, $0.label) },
            selection: animatedSelection,
            accessibilityLabel: "Juno product"
        )
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
    /// The band the window's own chrome owns above the *sidebar*: the traffic
    /// lights, and nothing else.
    ///
    /// 52 at first, which was the toolbar's height — and wrong, because the
    /// toolbar is over the *detail* column. Above the navigation column the only
    /// thing to clear is the three buttons, whose 12pt circles are centred about
    /// 20pt down, so they end by 26. 38 leaves a dozen points of air over them
    /// and no more; at 52 the switch sat a control's height below the lights it
    /// was supposed to sit beside, which is what a reader reads as the column
    /// starting late.
    static let trafficLightClearance: CGFloat = 38

    /// The switch's own row: ``DesktopSegmented``'s 28pt segment, the 2pt its
    /// track adds on each side, and the gap to the first source-list row.
    static let productSwitcherRow: CGFloat = 28 + 4 + JunoSpace.snug

    static let titlebarClearance: CGFloat = trafficLightClearance + productSwitcherRow
}

extension View {
    /// Puts the product switch above this source list.
    ///
    /// **Above, not inset into.** This was a `safeAreaInset(edge: .top)`, and it
    /// placed the same header at two different heights: 38pt down the Code
    /// column and 90pt down the Chat one, from one constant and one view. An
    /// inset is measured against the *content's* safe area, and each column's
    /// list resolves that differently — Chat's begins with an unheaded
    /// `Section`, Code's with bare rows — so the one control that must occupy
    /// the same spot in every product was being positioned by whatever its list
    /// happened to start with. Laid out above the list, all three agree by
    /// construction.
    ///
    /// It also retires the hazard the opaque backing was working around. A
    /// `.sidebar` List pins its section headers to the top of *its own* bounds,
    /// where a top inset never reaches them — which is how "Today" or "Waiting
    /// on you" arrived level with the traffic lights on a scrolled column. The
    /// list's bounds now begin below the strip, so there is nothing above it to
    /// pin over.
    func junoSidebarProductHeader(product: Binding<DesktopProductMode>) -> some View {
        VStack(spacing: 0) {
            DesktopSidebarProductHeader(product: product)
            self
        }
        // The strip measures from the window's top edge, not from wherever the
        // column's safe area happens to begin.
        //
        // This is the second half of the same bug. Chat's sidebar carries a
        // ~48pt titlebar inset and Code's does not, so a clearance *added* to
        // the safe area put the switch 38pt down one column and 86pt down the
        // other — the strip painting up into the inset all the while, which is
        // why it looked like one tall band rather than a control sitting low.
        // Taking the top safe area here makes the arithmetic absolute: the strip
        // owns the band from the window's edge to `titlebarClearance`, the
        // traffic lights sit inside it, and the list starts under it. The list
        // keeps its own bottom safe area, which is what the footer is measured
        // against.
        .ignoresSafeArea(.container, edges: .top)
    }
}

/// The Chat / Code / Work switch, in the strip above a source list.
///
/// **Why the strip is opaque.** It is the column's own colour rather than
/// nothing, so the switch reads as the column continuing rather than as a bar
/// laid on it — `Color.junoSidebar` is the same fill ``DesktopCodeAddProjectLabel``
/// knocks its badge out against. This is a deliberate, scoped exception to the
/// desktop vocabulary's rule that nothing paints a background behind a sidebar:
/// the rule is about the *column*, which stays vibrant from this strip down.
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
