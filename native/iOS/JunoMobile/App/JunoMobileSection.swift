import SwiftUI

enum JunoMobileSection: String, CaseIterable, Hashable, Identifiable {
    case chat
    case search
    case projects
    case files
    case artifacts
    case tasks
    case connections
    case codeCloud
    case codeRemote
    case settings

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .chat: "navigation.chat"
        case .search: "navigation.search"
        case .projects: "navigation.projects"
        case .files: "navigation.files"
        case .artifacts: "navigation.artifacts"
        case .tasks: "navigation.tasks"
        case .connections: "navigation.connections"
        case .codeCloud: "navigation.codeCloud"
        case .codeRemote: "navigation.codeRemote"
        case .settings: "navigation.settings"
        }
    }

    var systemImage: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .search: "magnifyingglass"
        case .projects: "folder"
        case .files: "doc.on.doc"
        case .artifacts: "square.stack.3d.up"
        case .tasks: "checklist"
        case .connections: "link"
        case .codeCloud: "cloud"
        case .codeRemote: "laptopcomputer.and.iphone"
        case .settings: "gearshape"
        }
    }
}
