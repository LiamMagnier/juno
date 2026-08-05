import JunoDesignSystem
import SwiftUI

/// Every top-level destination in the iOS/iPadOS app. Each case maps to a real,
/// working surface — nothing here navigates to a placeholder.
enum JunoMobileSection: String, CaseIterable, Hashable, Identifiable {
    case chat
    case search
    case code
    case work
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
        case .code: "navigation.code"
        // A literal rather than a `navigation.work` key. Every other title here
        // resolves through `Resources/Localizable.xcstrings`, and a dotted key
        // the catalog does not carry renders as the key itself — a row reading
        // "navigation.work" in the drawer. The literal is its own English
        // default and becomes a key the moment the catalog gains one.
        case .work: "Work"
        case .tasks: "navigation.tasks"
        case .projects: "navigation.projects"
        case .library: "navigation.library"
        case .artifacts: "navigation.artifacts"
        case .connections: "navigation.connections"
        case .settings: "navigation.settings"
        }
    }

    /// The website's own glyph for this destination.
    ///
    /// These come from `src/lib/app-icons.ts` by way of
    /// `scripts/generate-native-icons.mjs`, so a destination looks the same on
    /// the phone as it does in the browser — and, just as importantly, the same
    /// as it does on the Mac.
    ///
    /// Two marks were out of step and are not any more. Chat is `home`, which is
    /// what `AppIcons.home` draws for that destination on the web and what the
    /// Mac's sidebar has always used; `new` is a plus, and a plus belongs on the
    /// control that *starts* a chat, not on the destination that lists them.
    /// Settings is `settings`, now that the shared icon set carries one — it fell
    /// back to `gearshape` before, the only SF Symbol in an otherwise Lucide
    /// column, which read as a glyph borrowed from another product.
    var junoIcon: JunoIcon? {
        switch self {
        case .chat: .home
        case .search: .search
        case .code: .code
        case .work: .work
        case .tasks: .tasks
        case .projects: .projects
        case .library: .library
        case .artifacts: .artifacts
        case .connections: .connections
        case .settings: .settings
        }
    }

    /// The fallback system symbol, used only where ``junoIcon`` is nil.
    var systemImage: String {
        switch self {
        case .chat: "square.and.pencil"
        case .search: "magnifyingglass"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .work: "macbook.and.iphone"
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
    /// (projects, library, artifacts), then the three that *do work* for you
    /// (work, code, tasks), then the account-level one (connections).
    ///
    /// Work leads that second group because it is the one that goes and does
    /// something on your behalf while you are elsewhere — Code and Tasks are
    /// both things you sit with.
    static let drawerDestinations: [JunoMobileSection] = [
        .projects, .library, .artifacts, .work, .code, .tasks, .connections,
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
            case .workspace: [.chat, .search, .work, .code, .tasks]
            case .content: [.projects, .library, .artifacts, .connections]
            case .account: [.settings]
            }
        }
    }
}
