import SwiftUI

/// The two top-level products inside JunoMac.
///
/// A mode is a bigger thing than a `JunoMacSection`: each mode owns its own
/// sidebar *and* its own workspace, so switching modes replaces both columns.
/// Sections are destinations *within* Chat.
enum JunoMacProductMode: String, CaseIterable, Identifiable, Hashable {
    case chat
    case code

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .chat: "mode.chat"
        case .code: "mode.code"
        }
    }

    /// The same words as `title`, resolved to a `String` for AppKit, which
    /// takes labels rather than `LocalizedStringKey`.
    var shortTitle: String {
        switch self {
        case .chat: String(localized: "mode.chat")
        case .code: String(localized: "mode.code")
        }
    }

    var systemImage: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .code: "chevron.left.forwardslash.chevron.right"
        }
    }

    /// ⌘1 / ⌘2. Sections inside Chat moved to ⌥⌘n so these stay free for the
    /// switch people reach for most.
    var keyboardShortcut: KeyEquivalent {
        switch self {
        case .chat: "1"
        case .code: "2"
        }
    }

    /// Restores a persisted raw value, falling back to Chat for anything
    /// unrecognized — a value written by an older or newer build must never
    /// leave the app on a mode it cannot render.
    static func restored(from rawValue: String) -> JunoMacProductMode {
        JunoMacProductMode(rawValue: rawValue) ?? .chat
    }
}

#if DEBUG
extension JunoMacProductMode {
    /// `--juno-preview-mode <chat|code>`, so a QA pass can launch straight into
    /// either product instead of clicking. DEBUG-only, like the rest of the
    /// preview harness, and it seeds the initial value rather than pinning it —
    /// the switcher stays interactive.
    static var previewLaunchMode: JunoMacProductMode {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--juno-preview-mode"),
            arguments.indices.contains(index + 1)
        else { return .chat }
        return JunoMacProductMode(rawValue: arguments[index + 1]) ?? .chat
    }
}
#endif
