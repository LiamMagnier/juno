import JunoDesignSystem
import SwiftUI

/// The window's two products (§1.4).
///
/// Work stopped being a product in Phase 1 and its old workspace went in
/// Phase 5 Stage D: tasks live in the chats that started them, and one with no
/// chat opens in a sheet (register #63). A window an older build stored as
/// "work" restores to Chat, because `init(rawValue:)` no longer knows it and
/// the root falls back.
enum DesktopProductMode: String, CaseIterable, Identifiable {
    case chat
    case code

    var id: Self { self }

    /// The products the Chat/Code switch offers, in its order — ⌘1 and ⌘2:
    /// the web's `PRODUCTS`, read from the shell contract.
    static let switchable: [Self] = JunoShellProduct.allCases.map(Self.init)

    /// ⌘1 · ⌘2, in the switch's own order.
    var keyboardDigit: Character? {
        switch self {
        case .chat: "1"
        case .code: "2"
        }
    }

    /// ⌘ and the digit.
    var keyboardShortcut: KeyboardShortcut? {
        keyboardDigit.map { KeyboardShortcut(KeyEquivalent($0), modifiers: .command) }
    }

    /// The web's name for the product (the shell contract).
    var label: String { shell.label }

    /// The product's own mark from the generated symbol set, as the shell
    /// contract names it: Juno's bubble for Chat and the spark between
    /// chevrons for Code. Both have a solid cut, which the switch draws for
    /// the selected product — the web's "fill means on" rule — so selection
    /// never needs a colour.
    var icon: JunoIcon { shell.icon }

    /// The segment's tooltip: its name and its shortcut, two spaces apart, the
    /// way every other `.help` in the shell states a key.
    var help: String {
        guard let digit = keyboardDigit else { return label }
        return "\(label)  ⌘\(digit)"
    }
}

/// The Chat/Code switch (§1.4 of the redesign): a native `Picker`, icon-only,
/// in the sidebar's segment of the unified toolbar.
///
/// **A system control, not a Juno one.** The switch it replaces was a
/// segmented control labelled "Juno product" pinned in a strip above the
/// source list, which put a second band of chrome between the traffic lights
/// and the rows. In the toolbar the strip reads traffic lights · the system
/// sidebar toggle · space · the switch, and there is nothing else to draw.
///
/// **Selection is the fill cut and the system's own segment highlight — never
/// an accent.** Each label names its image by the product's regular or solid
/// drawing, so the chosen product is the one drawn solid; the control adds its
/// neutral highlight. No tint is applied here or above it (§0.4): the toolbar
/// owner sits above the one `.junoAccentTint()` in the window.
///
/// The selection is optional so a product outside ``DesktopProductMode/switchable``
/// would read as *no segment chosen* rather than as a selection with no tag,
/// which SwiftUI logs as an invalid state. Since Phase 5 Stage D every product
/// is switchable, so this is a guard, not a case that happens.
struct DesktopProductSwitch: View {
    @Binding var product: DesktopProductMode

    private var selection: Binding<DesktopProductMode?> {
        Binding(
            get: { DesktopProductMode.switchable.contains(product) ? product : nil },
            set: { if let value = $0 { product = value } }
        )
    }

    var body: some View {
        Picker("Product", selection: selection) {
            ForEach(DesktopProductMode.switchable) { mode in
                Label(
                    mode.label,
                    image: mode.icon.assetName(product == mode ? .fill : .regular)
                )
                .help(mode.help)
                .tag(Optional(mode))
                .accessibilityIdentifier("juno.product-brand.\(mode.rawValue)")
            }
        }
        .labelsHidden()
        .junoProductPickerStyle()
        // The identifier the launch UI suite already finds the switch by. It
        // is an automation handle, never shown or spoken: VoiceOver reads the
        // picker's own label, "Product".
        .accessibilityIdentifier("Juno product")
    }
}

extension View {
    /// `.tabs` where it exists, `.segmented` where it does not.
    ///
    /// On macOS 27 the tabs style is the right *semantic* as well as the right
    /// look: VoiceOver announces the segments as tabs, which is what a mode
    /// switch is. macOS 26 has no tabs style, and the segmented control is the
    /// closest the platform offers.
    @ViewBuilder
    func junoProductPickerStyle() -> some View {
        if #available(macOS 27, *) {
            pickerStyle(.tabs)
        } else {
            pickerStyle(.segmented)
        }
    }

    /// Installs the Chat/Code switch in the toolbar of the column this is
    /// applied to. Apply it to a product's **sidebar** content: an item
    /// declared by the sidebar column lands in the sidebar's segment of the
    /// unified toolbar, which is where §1.4 puts the switch.
    ///
    /// Declared once and unconditionally, per crash rule 3: the item's
    /// identity never changes, only the picker's selection does. A product
    /// swap rebuilds the whole workspace — and with it this toolbar — because
    /// only one `NavigationSplitView` is ever alive.
    func junoProductSwitch(product: Binding<DesktopProductMode>) -> some View {
        toolbar {
            ToolbarItem(placement: .primaryAction) {
                DesktopProductSwitch(product: product)
            }
        }
    }

    /// The name Code's column still calls.
    ///
    /// It used to pin a segmented control in a strip above the list; it now
    /// installs the same toolbar switch as ``junoProductSwitch(product:)``, so
    /// Code hosts the one switch component in the one position (§1.4) without
    /// its column being edited ahead of its own rework. The call sites are
    /// renamed when those columns are rewritten.
    func junoSidebarProductHeader(product: Binding<DesktopProductMode>) -> some View {
        junoProductSwitch(product: product)
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
