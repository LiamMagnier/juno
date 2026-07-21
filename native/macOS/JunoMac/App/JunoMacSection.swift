import SwiftUI

enum JunoMacSection: String, CaseIterable, Hashable, Identifiable {
    case chat
    case projects
    case library
    case artifacts
    case tasks
    case connections
    case search
    case code
    case settings

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .chat: "navigation.chat"
        case .projects: "navigation.projects"
        case .library: "navigation.library"
        case .artifacts: "navigation.artifacts"
        case .tasks: "navigation.tasks"
        case .connections: "navigation.connections"
        case .search: "navigation.search"
        case .code: "navigation.code"
        case .settings: "navigation.settings"
        }
    }

    var systemImage: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .projects: "folder"
        case .library: "books.vertical"
        case .artifacts: "square.stack.3d.up"
        case .tasks: "checklist"
        case .connections: "link"
        case .search: "magnifyingglass"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .settings: "gearshape"
        }
    }

    var keyboardShortcut: KeyEquivalent {
        switch self {
        case .chat: "1"
        case .projects: "2"
        case .library: "3"
        case .artifacts: "4"
        case .tasks: "5"
        case .connections: "6"
        case .search: "7"
        case .code: "8"
        case .settings: "9"
        }
    }
}
