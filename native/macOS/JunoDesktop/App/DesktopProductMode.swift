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

    /// Chat and Code share the navigation column. Work is a separate operating
    /// mode selected from the window toolbar, so it must not appear in the
    /// sidebar switch as though it were another kind of conversation.
    static let sidebarModes: [Self] = [.chat, .code]

    var label: String {
        switch self {
        case .chat: "Chat"
        case .code: "Code"
        case .work: "Work"
        }
    }

    /// The SF Symbol for this mode, chosen to match the web's mark rather than
    /// to be the most literal SF glyph.
    ///
    /// The website switched `home` to a single rounded speech bubble and `work`
    /// to a bolt, for one reason worth preserving across platforms: the pair
    /// says TALK versus ACT. A bubble is you asking; a bolt is Juno going and
    /// doing. `bubble.left.and.bubble.right` was two bubbles — a conversation
    /// between other people — and `checklist` was a to-do list, which describes
    /// the artefact Work leaves behind rather than the act of it running.
    ///
    /// Code keeps its bracket pair, which already matches the web's `Code2`.
    var symbol: String {
        switch self {
        case .chat: "bubble.left"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .work: "bolt"
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
/// **Motion.** The switch animates its own knob, on its own curve, and this
/// wrapper stays out of it. It used to wrap the binding in a second
/// `withAnimation(JunoMotion.standard)`, which nested around the one inside
/// ``DesktopSegmented`` — and the outer transaction wins, so the knob travelled
/// on `snappy(0.26)` while the file two doors down declared the curve it was
/// supposed to use and was quietly ignored. The same control then animated
/// differently depending on which of its two call sites you were looking at.
/// The workspace on the other side of the binding does not need this
/// transaction either: it reacts in `onChange`, not to an animated value.
struct DesktopProductSwitcher: View {
    @Binding var selection: DesktopProductMode

    var body: some View {
        DesktopSegmented(
            options: DesktopProductMode.sidebarModes.map { .init($0, $0.label, symbol: $0.symbol) },
            selection: $selection,
            accessibilityLabel: "Juno product",
            optionAccessibilityIdentifier: { "juno.product-brand.\($0.rawValue)" }
        )
        .accessibilityIdentifier("Juno product")
    }
}

/// The window-level Chat / Work mode switch.
///
/// This intentionally uses the platform segmented picker. It lives in the
/// titlebar among system controls, where macOS supplies the Liquid Glass
/// material, keyboard traversal, focus behavior, and toolbar geometry. Code is
/// represented as Chat here because it is selected one level down in the
/// sidebar, alongside conversations and projects.
struct DesktopChatWorkSwitcher: View {
    @Binding var selection: DesktopProductMode

    private enum Mode: String, CaseIterable, Identifiable {
        case chat
        case work

        var id: Self { self }
        var label: String { rawValue.capitalized }
        var symbol: String { self == .chat ? "bubble.left" : "bolt" }
    }

    private var mode: Binding<Mode> {
        Binding(
            get: { selection == .work ? .work : .chat },
            set: { selection = $0 == .work ? .work : .chat }
        )
    }

    var body: some View {
        Picker("Mode", selection: mode) {
            ForEach(Mode.allCases) { mode in
                Text(mode.label)
                    .tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
        .frame(width: 168)
        .help("Switch between Chat and Work")
        .accessibilityIdentifier("juno.window-mode")
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

    /// The lockup row that gives the navigation column a stable product identity.
    /// The mark is intentionally a little larger than a row icon: it is the
    /// app's anchor, not another destination.
    static let brandRow: CGFloat = 28

    /// The switch's own row: ``DesktopSegmented``'s 28pt segment, the 2pt its
    /// track adds on each side, and the gap to the brand lockup.
    static let productSwitcherRow: CGFloat = 28 + 4 + JunoSpace.snug

    /// One restrained header for all three products. Keeping this geometry in
    /// one place prevents Chat, Code and Work from looking like separate apps.
    static let titlebarClearance: CGFloat =
        trafficLightClearance + brandRow + JunoSpace.snug + productSwitcherRow + JunoSpace.snug
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
                .padding(.top, 32)
            self
        }
    }
}

/// The Chat / Code / Work switch, in the strip above a source list.
///
/// **The strip paints nothing.** It used to fill `Color.junoSidebar` at full
/// opacity, which was working around a `.sidebar` List pinning its headers to
/// the top of its own bounds — and those bounds now begin *below* this strip,
/// so there is nothing left to work around. What the fill did in the meantime
/// was switch off vibrancy for the one band at the top of the window: an opaque
/// rectangle sitting on a translucent column, lit from nowhere the rest of the
/// surface is lit from, with the knob's glass sampling flat paint instead of
/// the desktop behind it. Removing it is what lets the glass actually refract
/// something.
///
/// **When the sidebar is collapsed** the switch goes with it. The answer is the
/// Product menu in ``JunoDesktopCommands`` — an inline `Picker` in the menu bar
/// that reads and writes the focused window's mode — which is reachable with the
/// column closed and shows a checkmark against the mode the window is in.
struct DesktopSidebarProductHeader: View {
    @Binding var product: DesktopProductMode

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                JunoLogo()
                    .foregroundStyle(Color.junoForeground)
                Spacer(minLength: 0)
            }

            DesktopProductSwitcher(selection: $product)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.bottom, JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(
            height: DesktopSidebarChromeMetrics.titlebarClearance,
            alignment: .bottom
        )
    }
}
