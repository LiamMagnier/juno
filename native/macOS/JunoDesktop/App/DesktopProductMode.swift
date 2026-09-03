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

/// The top-level Chat / Code / Work switch, using the platform segmented control.
///
/// **All three products, in every column.** One control, `allCases`, and the
/// Product menu (⌘1 · ⌘2 · ⌘3) for the keyboard — the menu is also the answer
/// while the sidebar is collapsed, which the control itself cannot be.
///
struct DesktopProductSwitcher: View {
    @Binding var selection: DesktopProductMode

    var body: some View {
        Picker("Juno product", selection: $selection) {
            ForEach(DesktopProductMode.allCases) { product in
                JunoIconLabel(verbatim: product.label, icon: product.icon, size: 16)
                    .tag(product)
                    .accessibilityIdentifier("juno.product-brand.\(product.rawValue)")
            }
        }
        .pickerStyle(.segmented)
        .controlSize(.large)
        .accessibilityIdentifier("Juno product")
    }
}

extension View {
    /// Pins the native product switch inside the List's top safe area so source
    /// list content scrolls beneath it and the window chrome owns its placement.
    func junoSidebarProductHeader(product: Binding<DesktopProductMode>) -> some View {
        safeAreaInset(edge: .top, spacing: 0) {
            DesktopSidebarProductHeader(product: product)
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
        field.controlSize = .regular
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

/// The Chat / Code / Work switch in a List-owned safe-area inset.
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
            .padding(.vertical, JunoSpace.snug)
            .frame(maxWidth: .infinity)
    }
}
