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

    /// The website's mark for this product, from the shared Lucide catalog.
    ///
    /// The pair says TALK versus ACT: a bubble is you asking; a bolt is Juno
    /// going and doing. Code keeps its bracket pair, which is the web's `Code2`.
    var icon: JunoIcon {
        switch self {
        case .chat: .home
        case .code: .code
        case .work: .work
        }
    }
}

/// The top-level Chat / Code / Work switch, in the app's own segmented control.
///
/// **All three products, in every column.** One control, `allCases`, and the
/// Product menu (⌘1 · ⌘2 · ⌘3) for the keyboard — the menu is also the answer
/// while the sidebar is collapsed, which the control itself cannot be.
///
/// **Motion.** The switch animates its own thumb, on its own curve
/// (``DesktopSegmented``), and this wrapper stays out of it. The workspace on
/// the other side of the binding reacts in `onChange`, not to an animated value.
struct DesktopProductSwitcher: View {
    @Binding var selection: DesktopProductMode

    var body: some View {
        DesktopSegmented(
            options: DesktopProductMode.allCases.map { .init($0, $0.label, icon: $0.icon) },
            selection: $selection,
            accessibilityLabel: "Juno product",
            optionAccessibilityIdentifier: { "juno.product-brand.\($0.rawValue)" },
            fills: true
        )
        .accessibilityIdentifier("Juno product")
    }
}

/// Shared measurements for the strip above the three native source lists.
/// Keeping this here prevents Chat, Code and Work from drifting when one of
/// their sidebars is refreshed.
enum DesktopSidebarChromeMetrics {
    /// The switch's own row: the 32pt pill and the air above and below it. The
    /// Chat and Code columns reserve exactly this much above their lists.
    static let productSwitcherRow: CGFloat = 44
}

extension View {
    /// Puts the product switch above this source list.
    ///
    /// **Above, not inset into.** An inset is measured against the *content's*
    /// safe area, and each column's list resolves that differently — Chat's
    /// begins with an unheaded `Section`, Code's with bare rows — so the one
    /// control that must occupy the same spot in every product was being
    /// positioned by whatever its list happened to start with. Laid out above
    /// the list, all three agree by construction, and a `.sidebar` List's
    /// pinned section headers can never reach the strip.
    ///
    /// **Inside the safe area, never ignoring it — and measured against the
    /// window, because the safe area lies.** After a product switch a freshly
    /// built column can report a top safe area shorter than the titlebar it is
    /// drawn under, and the strip would land across the traffic lights. So the
    /// strip also asks AppKit where the window's chrome ends
    /// (`contentLayoutRect`) and pads by whatever the safe area left short.
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

/// The search field a column pins under its brand row.
///
/// **Not `.searchable(placement: .sidebar)`.** That placement hoists the field
/// to the very top of the split-view column — above the product strip and the
/// brand row, whatever order the column's own content states — which is how
/// the Code column came to read search → switcher → brand. This is the
/// platform's own `NSSearchField`, laid out where the column wants it: the
/// rounded field, the cancel button, Escape to clear and the `searchField`
/// accessibility role, without the hoisting.
///
/// `isFocused` is a request as much as a report. Setting it `true` — the brand
/// row's search glyph does — makes the field first responder; the field sets it
/// back to `false` when editing ends, so the glyph works again next time.
struct DesktopSidebarSearchField: NSViewRepresentable {
    @Binding var text: String
    let prompt: String
    @Binding var isFocused: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSSearchField {
        let field = NSSearchField()
        field.delegate = context.coordinator
        field.placeholderString = prompt
        field.controlSize = .large
        field.sendsSearchStringImmediately = true
        field.sendsWholeSearchString = false
        field.setAccessibilityLabel(prompt)
        field.setAccessibilityIdentifier("juno.code.sidebar-search-field")
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return field
    }

    func updateNSView(_ field: NSSearchField, context: Context) {
        context.coordinator.parent = self
        if field.stringValue != text {
            field.stringValue = text
        }
        field.placeholderString = prompt
        if isFocused, field.currentEditor() == nil, let window = field.window {
            DispatchQueue.main.async {
                window.makeFirstResponder(field)
            }
        }
    }

    final class Coordinator: NSObject, NSSearchFieldDelegate {
        var parent: DesktopSidebarSearchField

        init(_ parent: DesktopSidebarSearchField) {
            self.parent = parent
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSSearchField else { return }
            parent.text = field.stringValue
        }

        func controlTextDidBeginEditing(_ notification: Notification) {
            parent.isFocused = true
        }

        func controlTextDidEndEditing(_ notification: Notification) {
            parent.isFocused = false
        }
    }
}

/// The Chat / Code / Work switch, in the 44pt strip above a source list.
///
/// **The strip paints nothing.** The column is a vibrant region and stays one
/// all the way up; an opaque band here would be a grey slab on translucency,
/// lit from nowhere the rest of the surface is lit from.
///
/// **No lockup.** The window's title bar already says which app this is, and
/// a mark beside the switch pushed the pill off the column's own left edge.
/// One control, full width, on the same inset every row below it uses.
struct DesktopSidebarProductHeader: View {
    @Binding var product: DesktopProductMode

    var body: some View {
        DesktopProductSwitcher(selection: $product)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: DesktopSidebarChromeMetrics.productSwitcherRow)
            .frame(maxWidth: .infinity)
    }
}
