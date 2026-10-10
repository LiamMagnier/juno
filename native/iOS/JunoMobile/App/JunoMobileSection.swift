import JunoDesignSystem
import SwiftUI

/// Every top-level destination in the iOS/iPadOS app. Each case maps to a real,
/// working surface — nothing here navigates to a placeholder.
enum JunoMobileSection: String, CaseIterable, Hashable, Identifiable {
    case chat
    case search
    case code
    case work
    case agents
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
        // A literal for the reason Work's is: the catalog has no
        // `navigation.agents` key, and a missing dotted key renders as itself.
        case .agents: "Orbit"
        case .tasks: "Routines"
        case .projects: "navigation.projects"
        case .library: "navigation.library"
        case .artifacts: "navigation.artifacts"
        case .connections: "Apps"
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
    /// back to `gearshape` before, the only SF Symbol in a column of the web's
    /// own marks, which read as a glyph borrowed from another product.
    var junoIcon: JunoIcon {
        switch self {
        case .chat: .home
        case .search: .search
        case .code: .code
        case .work: .work
        case .agents: .agents
        case .tasks: .tasks
        case .projects: .projects
        case .library: .library
        case .artifacts: .artifacts
        case .connections: .connections
        case .settings: .settings
        }
    }

    /// Legacy symbol names kept for older navigation tests and integrations.
    /// The production drawer never renders this value; it always uses
    /// ``junoIcon`` so the visible rail stays on the website's own geometry.
    var systemImage: String {
        switch self {
        case .chat: "square.and.pencil"
        case .search: "magnifyingglass"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .work: "macbook.and.iphone"
        case .agents: "person.2"
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
    /// both things you sit with. Agents sits beside it for the same reason:
    /// an agent is who that work is delegated to (docs/design/AGENTS.md §3.1).
    ///
    /// Round 2 (Oct 2026) cut the column to ChatGPT's length — six
    /// destinations plus Research — by folding the two that are views of
    /// another: Artifacts are things in your Library, and Work sessions are
    /// runs you watch from Code. See ``foldedDestinations``.
    static let drawerDestinations: [JunoMobileSection] = [
        .library, .projects, .code, .agents, .tasks, .connections,
    ]

    /// The phone drawer's column: ``drawerDestinations`` without Code.
    ///
    /// On iPhone the chat's top bar carries the Chat | Code switch, so a Code
    /// row in the drawer was a second door to the same room (owner, Oct 10:
    /// "remove the research and code since you can switch directly in the
    /// chat window"). The iPad sidebar has no such switch and keeps the row.
    static let phoneDrawerDestinations: [JunoMobileSection] = drawerDestinations.filter {
        !phoneTopBarDestinations.contains($0)
    }

    /// Destinations the phone reaches from the chat's top bar.
    static let phoneTopBarDestinations: Set<JunoMobileSection> = [.code]

    /// Destinations reached from inside another rather than from the drawer:
    /// the value is where the way in lives.
    static let foldedDestinations: [JunoMobileSection: JunoMobileSection] = [
        .artifacts: .library,
        .work: .code,
    ]


    /// The surfaces that are not products. On iPhone they push on the Chat
    /// stack from the history sheet; on iPad they are the hidden sidebar
    /// group under the three product tabs. Work and Code are products and so
    /// are tabs on both, which is why they are absent here.
    ///
    /// Agents is here rather than a tab: it is not a product of its own. An
    /// agent lives in Chat — its thread is an ordinary conversation — and its
    /// tasks are Work's, so it is reached the way the other surfaces are.
    static let workspaceDestinations: [JunoMobileSection] = [
        .library, .projects, .connections,
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
            case .workspace: [.chat, .search, .work, .agents, .code, .tasks]
            case .content: [.projects, .library, .artifacts, .connections]
            case .account: [.settings]
            }
        }
    }
}
