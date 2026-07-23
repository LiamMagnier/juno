import JunoDesignSystem
import SwiftUI

/// Every top-level destination in the iOS/iPadOS app. Each case maps to a real,
/// working surface — the unbuilt Tasks and Connections sections are
/// intentionally absent until their backends exist, so there is no navigation
/// that leads nowhere.
///
/// Code is present because its backend now is: the relay routes under
/// `/api/code/devices/**` shipped, `CodeRemoteBrowserModel` drives the phone's
/// side of them, and the screen shows the account's real hosts and sessions. It
/// is a genuine surface, not a placeholder.
enum JunoMobileSection: String, CaseIterable, Hashable, Identifiable {
    case chat
    case code
    case search
    case projects
    case library
    case artifacts
    case settings

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .chat: "navigation.chat"
        case .code: "navigation.code"
        case .search: "navigation.search"
        case .projects: "navigation.projects"
        case .library: "navigation.library"
        case .artifacts: "navigation.artifacts"
        case .settings: "navigation.settings"
        }
    }

    /// The website's own glyph for this destination, or nil where the web has
    /// none and a system symbol is the honest choice.
    ///
    /// These come from `src/lib/app-icons.ts` by way of
    /// `scripts/generate-native-icons.mjs`, so a destination looks the same on
    /// the phone as it does in the browser. Settings is deliberately absent: the
    /// web shell has no Settings glyph in that module, and `gearshape` is what a
    /// person already recognises.
    var junoIcon: JunoIcon? {
        switch self {
        case .chat: .new
        case .code: .code
        case .search: .search
        case .projects: .projects
        case .library: .library
        case .artifacts: .artifacts
        case .settings: nil
        }
    }

    /// The fallback system symbol, used only where ``junoIcon`` is nil.
    var systemImage: String {
        switch self {
        case .chat: "square.and.pencil"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .search: "magnifyingglass"
        case .projects: "folder"
        case .library: "books.vertical"
        case .artifacts: "square.stack.3d.up"
        case .settings: "gearshape"
        }
    }

    /// Sidebar-adaptable grouping used on regular width (iPad). On iPhone the
    /// tab bar shows the flat set.
    enum Group: String, CaseIterable, Identifiable {
        case workspace
        case content
        case account

        var id: String { rawValue }

        var title: LocalizedStringKey {
            switch self {
            case .workspace: "sidebar.group.workspace"
            case .content: "sidebar.group.content"
            case .account: "sidebar.group.account"
            }
        }

        var sections: [JunoMobileSection] {
            switch self {
            case .workspace: [.chat, .code, .search]
            case .content: [.projects, .library, .artifacts]
            case .account: [.settings]
            }
        }
    }
}
