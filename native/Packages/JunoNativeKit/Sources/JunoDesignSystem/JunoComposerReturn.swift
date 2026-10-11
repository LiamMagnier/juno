import SwiftUI
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// What the Return key does in a message composer, one rule for every one of
/// them: Mac Chat and Code, Quick Entry, the iPhone with a hardware keyboard,
/// and the web (`src/lib/composer-keys.ts` says the same thing).
///
/// - Return sends.
/// - Shift-Return and Option-Return break the line.
/// - While an input method is composing (Japanese, Chinese, Korean and the
///   like), Return belongs to the input method: it confirms the text and
///   never sends.
///
/// A vertical `TextField` does not reliably break the line by itself on
/// Shift-Return (the Mac's field editor treats it as Return), so a composer
/// that answers ``newline`` inserts the break through ``JunoTextEditing``
/// rather than leaving the key to the field.
public enum JunoComposerReturn: Equatable, Sendable {
    case send
    case newline
    case inputMethod

    public static func resolve(shift: Bool, option: Bool, composing: Bool) -> JunoComposerReturn {
        if composing { return .inputMethod }
        if shift || option { return .newline }
        return .send
    }

    public static func resolve(_ modifiers: EventModifiers, composing: Bool) -> JunoComposerReturn {
        resolve(shift: modifiers.contains(.shift), option: modifiers.contains(.option), composing: composing)
    }

    /// The key press as the focused field sees it now.
    @MainActor
    public static func resolve(_ press: KeyPress) -> JunoComposerReturn {
        resolve(press.modifiers, composing: JunoTextEditing.isComposing)
    }
}

/// The focused text field's editor, for what SwiftUI's `TextField` does not
/// expose: whether an input method holds marked text, and inserting a line
/// break at the caret (replacing the selection, undoable, as typing would).
@MainActor
public enum JunoTextEditing {
    /// True while an input method is composing in the focused field.
    public static var isComposing: Bool {
        #if canImport(AppKit)
        return (NSApp?.keyWindow?.firstResponder as? NSTextView)?.hasMarkedText() == true
        #elseif canImport(UIKit)
        return (currentFirstResponder() as? UITextInput)?.markedTextRange != nil
        #else
        return false
        #endif
    }

    /// Inserts a line break where the caret is. Returns false when no text
    /// field is focused, so the caller can let the key through instead.
    @discardableResult
    public static func insertLineBreak() -> Bool {
        #if canImport(AppKit)
        return insertLineBreak(in: NSApp?.keyWindow?.firstResponder as? NSTextView)
        #elseif canImport(UIKit)
        guard let input = currentFirstResponder() as? (UIResponder & UIKeyInput) else { return false }
        input.insertText("\n")
        return true
        #else
        return false
        #endif
    }

    #if canImport(AppKit)
    static func insertLineBreak(in editor: NSTextView?) -> Bool {
        guard let editor, editor.isEditable else { return false }
        // The field editor's own "literal newline", what Option-Return does in any Mac text field.
        editor.insertNewlineIgnoringFieldEditor(nil)
        return true
    }
    #endif

    #if canImport(UIKit) && !canImport(AppKit)
    private static weak var probed: UIResponder?

    private static func currentFirstResponder() -> UIResponder? {
        probed = nil
        UIApplication.shared.sendAction(#selector(UIResponder.junoReportFirstResponder(_:)), to: nil, from: nil, for: nil)
        return probed
    }

    fileprivate static func report(_ responder: UIResponder) { probed = responder }
    #endif
}

#if canImport(UIKit) && !canImport(AppKit)
extension UIResponder {
    @objc fileprivate func junoReportFirstResponder(_ sender: Any?) {
        MainActor.assumeIsolated { JunoTextEditing.report(self) }
    }
}
#endif
