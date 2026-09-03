import AppKit
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

    /// ⌘1 · ⌘2 · ⌘3, in the switcher's own order.
    var keyboardDigit: Character {
        switch self {
        case .chat: "1"
        case .code: "2"
        case .work: "3"
        }
    }

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
/// **All three products, in every column.** There used to be two switchers
/// that disagreed — this one listed Chat and Code, and a titlebar picker
/// listed Chat and Work — so which products existed depended on where you
/// looked. One control, `allCases`, and the Product menu (⌘1 · ⌘2 · ⌘3) for
/// the keyboard.
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
        // Words only. The symbols stay on the enum for the menu bar item, but in
        // a 28pt segment beside a 12pt word the Code bracket pair rendered as a
        // lone "‹" — which reads as a back button at the top of a column, the
        // one place a back button would mean something. Three words need no
        // glyphs to tell apart.
        DesktopSegmented(
            options: DesktopProductMode.allCases.map { .init($0, $0.label) },
            selection: $selection,
            accessibilityLabel: "Juno product",
            optionAccessibilityIdentifier: { "juno.product-brand.\($0.rawValue)" }
        )
        .accessibilityIdentifier("Juno product")
    }
}

/// Shared measurements for the strip above the three native source lists.
/// Keeping this here prevents Chat, Code and Work from drifting when one of
/// their sidebars is refreshed.
///
/// There is deliberately no "traffic-light clearance" here any more. The strip
/// used to ignore the window's top safe area and pad itself down by a constant
/// 52pt — a hand-copied guess at the titlebar's height. Whenever the real safe
/// area was anything else (a `.searchable(placement: .sidebar)` field adds to
/// it; the toolbar's own metric varies with the window style) the guess was
/// wrong in one of two directions: content under the traffic lights, or a
/// search field drawn over the product switch. The strip now sits *in* the safe
/// area and the window says where that is.
enum DesktopSidebarChromeMetrics {
    /// The lockup row that gives the navigation column a stable product identity.
    /// The mark is intentionally a little larger than a row icon: it is the
    /// app's anchor, not another destination.
    static let brandRow: CGFloat = 28

    /// The switch's own row: ``DesktopSegmented``'s 28pt segment, the 2pt its
    /// track adds on each side, and the gap to the brand lockup.
    static let productSwitcherRow: CGFloat = 28 + 4 + JunoSpace.snug
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
    ///
    /// **Inside the safe area, never ignoring it.** The stack respects the
    /// column's top safe area — the titlebar and toolbar, plus a sidebar search
    /// field where the column declares one — and starts directly under it. The
    /// previous build ignored that inset and padded a constant instead, which
    /// is how the Code column's search field ended up drawn across the product
    /// switch and how, on a window whose titlebar measured differently, the
    /// column's first rows landed under the traffic lights.
    ///
    /// **And measured against the window, because the safe area lies.** After
    /// a product switch the freshly built Chat column reported a top safe area
    /// of 40pt under a 52pt toolbar — the titlebar band without the toolbar it
    /// was drawn under — and the strip landed across the traffic lights again.
    /// So the strip also asks AppKit where the window's chrome ends
    /// (`contentLayoutRect`) and pads by whatever the safe area left short. When
    /// the safe area is right the extra is zero; when it is short the strip
    /// still clears the chrome. Either way it never draws under it.
    func junoSidebarProductHeader(product: Binding<DesktopProductMode>) -> some View {
        modifier(DesktopSidebarProductHeaderLayout(product: product))
    }
}

/// The strip above the list, corrected against the window's own chrome.
///
/// Two readings, both cheap: the strip's own top in window space (a
/// `GeometryReader` behind the stack, whose top is fixed by the safe area and
/// so does not move when the padding inside it changes), and the height of
/// the window's titlebar-plus-toolbar band from AppKit. The difference, when
/// positive, is how far the safe area fell short.
private struct DesktopSidebarProductHeaderLayout: ViewModifier {
    let product: Binding<DesktopProductMode>

    @State private var chromeHeight: CGFloat = 0
    @State private var stripTop: CGFloat = 0

    private var shortfall: CGFloat {
        max(0, (chromeHeight - stripTop).rounded())
    }

    func body(content: Content) -> some View {
        VStack(spacing: 0) {
            DesktopSidebarProductHeader(product: product)
                .padding(.top, shortfall)
            content
        }
        .background {
            GeometryReader { proxy in
                Color.clear
                    .onChange(of: proxy.frame(in: .global).minY, initial: true) { _, top in
                        stripTop = top
                    }
            }
        }
        .background(DesktopWindowChromeReader(height: $chromeHeight))
    }
}

/// Reports how tall the window's titlebar-and-toolbar band is, from the
/// window itself: the content view's height less its `contentLayoutRect`,
/// which is exactly the region AppKit reserves for chrome above the content.
private struct DesktopWindowChromeReader: NSViewRepresentable {
    @Binding var height: CGFloat

    func makeNSView(context: Context) -> NSView {
        let view = ChromeObservingView()
        view.report = { height = $0 }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView as? ChromeObservingView)?.report = { height = $0 }
        (nsView as? ChromeObservingView)?.measure()
    }

    final class ChromeObservingView: NSView {
        var report: ((CGFloat) -> Void)?
        private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer {
                NotificationCenter.default.removeObserver(observer)
                self.observer = nil
            }
            guard let window else { return }
            observer = NotificationCenter.default.addObserver(
                forName: NSWindow.didResizeNotification, object: window, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.measure() }
            }
            measure()
        }

        override func layout() {
            super.layout()
            measure()
        }

        func measure() {
            guard let window, let contentView = window.contentView else { return }
            let chrome = contentView.bounds.maxY - window.contentLayoutRect.maxY
            let value = max(0, chrome.rounded())
            report?(value)
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
        .padding(.top, JunoSpace.snug)
        .padding(.bottom, JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
