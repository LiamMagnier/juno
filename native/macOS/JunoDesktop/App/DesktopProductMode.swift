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

/// The Chat/Code switch (§1.4 of the redesign, reworked in the premium pass):
/// a **labelled** native segmented picker in the sidebar's segment of the
/// unified toolbar — each product's mark and its name.
///
/// **Why labelled.** The icon-only picker it replaces read as two anonymous
/// glyphs beside the traffic lights: the one control that changes what the
/// whole window is for said nothing about it until hovered.
///
/// **The system's control and the system's glass** (owner directive: native
/// Liquid Glass on macOS). The toolbar draws the item's glass capsule and the
/// picker's own selection; nothing here paints chrome. On macOS 27 the tabs
/// style gives VoiceOver the right semantics; macOS 26 has only segmented.
///
/// **Selection is the system's segment highlight and the solid cut of the
/// mark — never an accent.** The toolbar owner sits above the one
/// `.junoAccentTint()` in the window (§0.4).
///
/// The product is set **outside** any animation: a product change swaps the
/// whole workspace, and animated, that swap would keep two split views alive
/// for the length of the transition — crash rule 1
/// (`MACOS_CRASH_ROOT_CAUSE.md`). The arriving workspace has its own rise
/// (``JunoDesktopWorkspaceView``).
struct DesktopProductSwitch: View {
    @Binding var product: DesktopProductMode

    private var selection: Binding<DesktopProductMode?> {
        Binding(
            get: { DesktopProductMode.switchable.contains(product) ? product : nil },
            set: { next in
                guard let next else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { product = next }
            }
        )
    }

    var body: some View {
        // The web's product switch (round 2, brand motifs): Chat and Code in
        // the serif at the two ends of a dot orbit, the presence trail running
        // to the one you are in. Code below Pro is shown locked and asks for
        // the plan, as the web's does.
        JunoProductOrbit(
            active: product == .code ? .code : .chat,
            locked: DesktopPlanGate.shared.allows(.code) ? [] : [.code]
        ) { chosen in
            let next: DesktopProductMode = chosen == .code ? .code : .chat
            if next == .code, !DesktopPlanGate.shared.require(.code) { return }
            selection.wrappedValue = next
        }
        .fixedSize()
        // The identifier the launch UI suite already finds the switch by. It
        // is an automation handle, never shown or spoken.
        .accessibilityIdentifier("Juno product")
    }
}

extension View {
    /// `.tabs` where it exists, `.segmented` where it does not.
    @ViewBuilder
    func junoProductPickerStyle() -> some View {
        if #available(macOS 27, *) {
            pickerStyle(.tabs)
        } else {
            pickerStyle(.segmented)
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
