import SwiftUI

/// Every top-level destination in the macOS app. Each case maps to a real,
/// working surface — there is no catch-all screen. Sections are grouped for the
/// sidebar and carry their own symbol, keyboard shortcut and localized title.
enum JunoMacSection: String, CaseIterable, Hashable, Identifiable {
    case chat
    case search
    case projects
    case library
    case artifacts
    case code
    case settings

    var id: String { rawValue }

    /// Sidebar grouping. Settings is pinned on its own at the bottom.
    enum Group: String, CaseIterable, Identifiable {
        case workspace
        case content
        case develop
        case account

        var id: String { rawValue }

        var title: LocalizedStringKey {
            switch self {
            case .workspace: "sidebar.group.workspace"
            case .content: "sidebar.group.content"
            case .develop: "sidebar.group.develop"
            case .account: "sidebar.group.account"
            }
        }

        var sections: [JunoMacSection] {
            switch self {
            case .workspace: [.chat, .search]
            case .content: [.projects, .library, .artifacts]
            case .develop: [.code]
            case .account: [.settings]
            }
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .chat: "navigation.chat"
        case .search: "navigation.search"
        case .projects: "navigation.projects"
        case .library: "navigation.library"
        case .artifacts: "navigation.artifacts"
        case .code: "navigation.code"
        case .settings: "navigation.settings"
        }
    }

    var systemImage: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .search: "magnifyingglass"
        case .projects: "folder"
        case .library: "books.vertical"
        case .artifacts: "square.stack.3d.up"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .settings: "gearshape"
        }
    }

    var keyboardShortcut: KeyEquivalent {
        switch self {
        case .chat: "1"
        case .search: "2"
        case .projects: "3"
        case .library: "4"
        case .artifacts: "5"
        case .code: "6"
        case .settings: ","
        }
    }
}
