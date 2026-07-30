import JunoDesignSystem
import SwiftUI

/// Every top-level destination in the iOS/iPadOS app. Each case maps to a real,
/// working surface — nothing here navigates to a placeholder.
enum JunoMobileSection: String, CaseIterable, Hashable, Identifiable {
    case chat
    case search
    /// One prompt, two or three models, side by side. Its own destination rather
    /// than a mode inside Chat: a comparison is never saved and never becomes a
    /// conversation, so putting it behind the conversation list would promise a
    /// history it does not have.
    case compare
    case code
    case tasks
    case projects
    case library
    case artifacts
    case connections
    case settings

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .chat: "navigation.chat"
        case .search: "navigation.search"
        case .compare: "navigation.compare"
        case .code: "navigation.code"
        case .tasks: "navigation.tasks"
        case .projects: "navigation.projects"
        case .library: "navigation.library"
        case .artifacts: "navigation.artifacts"
        case .connections: "navigation.connections"
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
        case .search: .search
        // No Juno-drawn glyph for Compare yet, so it falls back to the SF Symbol
        // rather than borrowing another destination's mark.
        case .compare: nil
        case .code: .code
        case .tasks: .tasks
        case .projects: .projects
        case .library: .library
        case .artifacts: .artifacts
        case .connections: .connections
        case .settings: nil
        }
    }

    /// The fallback system symbol, used only where ``junoIcon`` is nil.
    var systemImage: String {
        switch self {
        case .chat: "square.and.pencil"
        case .search: "magnifyingglass"
        case .compare: "rectangle.split.2x1"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .tasks: "clock.badge.checkmark"
        case .projects: "folder"
        case .library: "books.vertical"
        case .artifacts: "square.stack.3d.up"
        case .connections: "powerplug"
        case .settings: "gearshape"
        }
    }

    /// The destinations the drawer lists, in order. Chat is absent because the
    /// drawer's conversation list *is* chat, and Search and Settings have their
    /// own controls in its header and footer.
    ///
    /// The order is the owner's: the three places your *content* lives first
    /// (projects, library, artifacts), then the two that *do work* for you
    /// (code, tasks), then the account-level one (connections).
    static let drawerDestinations: [JunoMobileSection] = [
        .compare, .projects, .library, .artifacts, .code, .tasks, .connections,
    ]

    /// Sidebar-adaptable grouping used on regular width (iPad). On iPhone the
    /// drawer shows the flat set.
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
            case .workspace: [.chat, .search, .compare, .code, .tasks]
            case .content: [.projects, .library, .artifacts, .connections]
            case .account: [.settings]
            }
        }
    }
}
