import SwiftUI

/// Every destination inside Chat mode.
///
/// Juno Code is deliberately absent: it is a `JunoMacProductMode`, not a
/// section, because it brings its own sidebar and workspace rather than filling
/// this one's detail column.
///
/// Each case maps to a real, working surface — there is no catch-all screen.
/// Sections are grouped for the sidebar and carry their own symbol, keyboard
/// shortcut and localized title.
enum JunoMacSection: String, CaseIterable, Hashable, Identifiable {
    case chat
    case search
    case projects
    case library
    case artifacts
    case settings

    var id: String { rawValue }

    /// Sidebar grouping. Settings is pinned on its own at the bottom.
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

        var sections: [JunoMacSection] {
            switch self {
            case .workspace: [.chat, .search]
            case .content: [.projects, .library, .artifacts]
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
        case .settings: "gearshape"
        }
    }

    /// Sections are reached with ⌥⌘n. Plain ⌘1/⌘2 belong to the Chat/Code
    /// product switch, which is the more frequent move, so the destinations
    /// inside Chat take the modified form.
    var keyboardShortcut: KeyEquivalent {
        switch self {
        case .chat: "1"
        case .search: "2"
        case .projects: "3"
        case .library: "4"
        case .artifacts: "5"
        case .settings: ","
        }
    }

    /// Settings keeps the conventional plain ⌘, ; every other destination uses
    /// ⌥⌘n so it cannot collide with the product switch.
    var keyboardModifiers: EventModifiers {
        self == .settings ? .command : [.command, .option]
    }
}
