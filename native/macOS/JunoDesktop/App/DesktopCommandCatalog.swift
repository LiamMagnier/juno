import Foundation
import JunoChatKit
import JunoCodeCore
import JunoCodeUI
import JunoDesignSystem

// MARK: - Rows and what they do

/// A page the ⌘K panel can open that this base does not route yet. Each is a
/// hook (seam 5 of the Phase 3 brief): while ``DesktopCommandCatalog/Hooks/openPage``
/// is nil the rows that need it are absent, never disabled — except the three
/// with a page of their own already (Designs, New design, New agent), which
/// fall back to it.
enum DesktopPanelPage: String, CaseIterable, Equatable, Sendable {
    case skills
    case automations
    case newAutomation
    case assistants
    case newAssistant
    case permissions
    case designs
    case newDesign
    case newAgent
}

/// What running a row does. A value rather than a closure so the catalog, the
/// search results and the hit routing can be asserted without a window; the
/// Chat window maps each case onto its own actions
/// (`DesktopChatWorkspace.performPanelAction`).
enum DesktopPanelAction: Equatable {
    case newChat
    case newPrivateChat
    case newCodeSession
    /// A hooked page, or its fallback when the hook is not wired.
    case page(DesktopPanelPage)
    /// Switch the panel to Search, keeping the query.
    case searchEverything
    case toggleSidebar
    case openNotifications
    case openCode
    /// A Chat-window destination: Agents, Artifacts, Library, Connections,
    /// Memory, Projects ("All projects"), Design.
    case destination(DesktopDestination)
    case roadmap
    case conversation(id: String, messageID: String? = nil)
    case codeSession(CodeSessionID)
    case project(String)
    case settings
    case upgrade
    case toggleTheme
    case keyboardShortcuts
    /// An artifact: its conversation with the canvas open when the
    /// conversation is known, the Artifacts page otherwise.
    case artifact(id: String, conversationID: String?)
    case taskRecord(sessionID: String)
    /// A path on the web app, opened in the browser.
    case web(path: String)
}

/// One row in either of the panel's lists.
struct DesktopPanelRow: Identifiable, Equatable {
    let id: String
    /// The group header this row sits under ("Actions", "Chats", "Recent"…).
    let group: String
    let label: String
    /// Matched spans in `label` (UTF-16 offsets, as the server sends them).
    var labelMarks: [NativeSearchMark] = []
    var snippet: NativeSearchSnippet? = nil
    /// Trailing muted text: a relative time, "Pinned", a locator.
    var meta: String? = nil
    /// Keycaps, one per key ("⇧", "⌘", "N"), read from
    /// ``JunoShortcutRegistry`` so the panel, the menu bar and the Keyboard
    /// Shortcuts window cannot disagree (Phase 3 seam 2).
    var hint: [String] = []
    let icon: JunoIcon
    /// Leaves the app (the web's roadmap): a trailing ↗.
    var isExternal = false
    let action: DesktopPanelAction

    /// Two lines when there is a snippet worth showing.
    var hasSnippet: Bool {
        guard let snippet else { return false }
        return !snippet.text.isEmpty && snippet.text != label
    }
}

/// A Code session the Command menu can list: the local workbench's.
struct DesktopPanelCodeSession: Equatable {
    let id: CodeSessionID
    let title: String
    let workspaceName: String?
    let updatedAt: Date

    /// The live workbench's sessions, when Code has one.
    @MainActor
    static func fromWorkbench(_ registry: DesktopWorkbenchRegistry = .shared) -> [DesktopPanelCodeSession] {
        guard let workbench = registry.workbench else { return [] }
        return workbench.visibleSessions.map { session in
            DesktopPanelCodeSession(
                id: session.id,
                title: session.title,
                workspaceName: workbench.workspaceName(for: session.workspaceID),
                updatedAt: session.updatedAt
            )
        }
    }
}

// MARK: - The command list

/// The web's command menu (`command-palette.tsx`, `CommandMenu`): Actions,
/// Chats, Code sessions, Projects and Settings, filtered by a word-start
/// match over each row's label and keywords.
///
/// Keywords are the web's, verbatim, so the words people type find the same
/// rows on both. Rows whose page this base does not route are absent while
/// their hook is nil (decision 10); "Open pull requests" and "Compare models"
/// are left out on the Mac (P3-13), and "New incognito chat" is the Mac's own
/// (P3-14).
enum DesktopCommandCatalog {
    /// The seams the integration wires (§2.3, rows 3–6). Each is optional; a
    /// row that needs one is absent while it is nil.
    struct Hooks {
        var openNotifications: (() -> Void)? = nil
        var openUpgrade: (() -> Void)? = nil
        var openPage: ((DesktopPanelPage) -> Void)? = nil
        var openTaskRecord: ((String) -> Void)? = nil

        static var none: Hooks { Hooks() }
    }

    /// What the Command menu lists besides its fixed rows.
    struct Context {
        var conversations: [NativeConversation] = []
        var codeSessions: [DesktopPanelCodeSession] = []
        var projects: [NativeProject] = []
        /// The theme as drawn right now, which picks "Switch to light mode"
        /// over "Switch to dark mode".
        var isDark = false
        var hooks = Hooks.none
        var now = Date()
    }

    /// A fixed row before filtering: its words, its glyph and what it needs.
    private struct Command {
        let id: String
        let label: String
        var hint: [String] = []
        let icon: JunoIcon
        let keywords: String
        var isExternal = false
        let action: DesktopPanelAction
        /// Present only when this is true for the context.
        var isAvailable: (Hooks) -> Bool = { _ in true }
    }

    // MARK: Matching

    /// A query matches at a word start, never inside one — the web's
    /// `atWordStart`. `hay` and `needle` are expected lowercased.
    ///
    /// A raw substring test matched "rate" inside "gene-RATE-d" and sent a
    /// chat's exact title to the Artifacts page; a word start still finds
    /// "doc" in "documents" and "pull req" in "Open pull requests".
    /// A command's keycaps, as the registry binds them.
    static func keys(_ id: JunoShortcutID) -> [String] {
        JunoShortcutRegistry.entry(id).keys
    }

    static func atWordStart(_ hay: String, _ needle: String) -> Bool {
        guard !needle.isEmpty else { return true }
        var searchStart = hay.startIndex
        while searchStart < hay.endIndex,
            let found = hay.range(of: needle, range: searchStart..<hay.endIndex)
        {
            if found.lowerBound == hay.startIndex {
                return true
            }
            let before = hay[hay.index(before: found.lowerBound)]
            if !isWordCharacter(before) { return true }
            searchStart = hay.index(after: found.lowerBound)
        }
        return false
    }

    /// The web's `/[a-z0-9]/` — ASCII only, so an accented letter before a
    /// match counts as a boundary there too.
    private static func isWordCharacter(_ character: Character) -> Bool {
        guard let scalar = character.unicodeScalars.first, character.unicodeScalars.count == 1 else { return false }
        return ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
    }

    /// Whether a row with this label and keywords survives `query` (already
    /// trimmed and lowercased).
    static func matches(label: String, keywords: String?, query: String) -> Bool {
        query.isEmpty
            || atWordStart(label.lowercased(), query)
            || (keywords.map { atWordStart($0, query) } ?? false)
    }

    // MARK: Rows

    /// Every row for `query`, in the web's order.
    static func rows(query rawQuery: String, context: Context) -> [DesktopPanelRow] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let hooks = context.hooks

        let actions: [DesktopPanelRow] = actionCommands
            .filter { $0.isAvailable(hooks) && matches(label: $0.label, keywords: $0.keywords, query: query) }
            .map { row($0, group: "Actions") }

        let live = context.conversations.filter { !$0.isArchived }
        let chatRows = live.filter { $0.kind != "code" }
        let chats: [DesktopPanelRow] = (
            query.isEmpty
                ? Array(chatRows.sorted { $0.lastMessageAt > $1.lastMessageAt }.prefix(5))
                : Array(chatRows.filter { $0.title.lowercased().contains(query) }.prefix(6))
        ).map { conversation in
            DesktopPanelRow(
                id: "recent-\(conversation.id)",
                group: "Chats",
                label: conversation.title.isEmpty ? "New chat" : conversation.title,
                meta: relativeTime(conversation.lastMessageAt, now: context.now),
                icon: .conversation,
                action: .conversation(id: conversation.id)
            )
        }

        let codeSessions: [DesktopPanelRow] = (
            query.isEmpty
                ? Array(context.codeSessions.sorted { $0.updatedAt > $1.updatedAt }.prefix(4))
                : Array(context.codeSessions.filter { $0.title.lowercased().contains(query) }.prefix(6))
        ).map { session in
            let workspace = session.workspaceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return DesktopPanelRow(
                id: "code-session-\(session.id.value)",
                group: "Code sessions",
                label: session.title.isEmpty ? "Untitled session" : session.title,
                meta: workspace.isEmpty ? relativeTime(session.updatedAt, now: context.now) : workspace,
                icon: .code,
                action: .codeSession(session.id)
            )
        }

        var projectRows: [DesktopPanelRow] = (
            query.isEmpty
                ? Array(
                    context.projects.sorted {
                        $0.starred != $1.starred ? $0.starred : $0.updatedAt > $1.updatedAt
                    }.prefix(4)
                )
                : Array(context.projects.filter { $0.name.lowercased().contains(query) }.prefix(6))
        ).map { project in
            DesktopPanelRow(
                id: "project-\(project.id)",
                group: "Projects",
                label: project.name.isEmpty ? "Untitled project" : project.name,
                meta: project.starred ? "Pinned" : relativeTime(project.updatedAt, now: context.now),
                icon: .projects,
                action: .project(project.id)
            )
        }
        if matches(label: "All projects", keywords: "projects workspaces group", query: query) {
            projectRows.append(
                DesktopPanelRow(
                    id: "projects",
                    group: "Projects",
                    label: "All projects",
                    icon: .projects,
                    action: .destination(.projects)
                )
            )
        }

        let settings: [DesktopPanelRow] = settingsCommands(isDark: context.isDark)
            .filter { $0.isAvailable(hooks) && matches(label: $0.label, keywords: $0.keywords, query: query) }
            .map { row($0, group: "Settings") }

        return actions + chats + codeSessions + projectRows + settings
    }

    private static func row(_ command: Command, group: String) -> DesktopPanelRow {
        DesktopPanelRow(
            id: command.id,
            group: group,
            label: command.label,
            hint: command.hint,
            icon: command.icon,
            isExternal: command.isExternal,
            action: command.action
        )
    }

    /// The Actions group: the web's rows and keywords, in its order.
    private static var actionCommands: [Command] { [
        Command(
            id: "new-chat", label: "New chat", hint: Self.keys(.newChat), icon: .new,
            keywords: "start compose message", action: .newChat
        ),
        // The Mac's own (P3-14): ⇧⌘N, private mode inline.
        Command(
            id: "new-private-chat", label: "New incognito chat", hint: Self.keys(.newPrivateChat), icon: .privateChat,
            keywords: "private incognito temporary unsaved", action: .newPrivateChat
        ),
        Command(
            id: "new-code", label: "New code session", icon: .code,
            keywords: "code start workspace session mac task agent", action: .newCodeSession
        ),
        Command(
            id: "new-design", label: "New design", icon: .design,
            keywords: "mockup wireframe prototype", action: .page(.newDesign)
        ),
        Command(
            id: "new-automation", label: "New automation", icon: .automations,
            keywords: "schedule scheduled task recurring automation cron reminder trigger",
            action: .page(.newAutomation), isAvailable: { $0.openPage != nil }
        ),
        Command(
            id: "new-assistant", label: "New assistant", icon: .assistants,
            keywords: "create custom assistant bot gem gpt instructions",
            action: .page(.newAssistant), isAvailable: { $0.openPage != nil }
        ),
        Command(
            id: "new-agent", label: "New agent", icon: .agents,
            keywords: "hire agent teammate bot muse grok delegate", action: .page(.newAgent)
        ),
        Command(
            id: "search-everything", label: "Search everything", icon: .search,
            keywords: "find messages files artifacts memory", action: .searchEverything
        ),
        Command(
            id: "toggle-sidebar", label: "Toggle sidebar", hint: Self.keys(.toggleSidebar), icon: .panelLeft,
            keywords: "collapse expand rail panel", action: .toggleSidebar
        ),
        Command(
            id: "notifications", label: "Open notifications", icon: .notifications,
            keywords: "inbox alerts unread activity bell updates",
            action: .openNotifications, isAvailable: { $0.openNotifications != nil }
        ),
        Command(
            id: "assistants", label: "Open Assistants", icon: .assistants,
            keywords: "custom assistants bots gpt gems prompts",
            action: .page(.assistants), isAvailable: { $0.openPage != nil }
        ),
        Command(
            id: "agents", label: "Open Agents", icon: .agents,
            keywords: "agents teammates roster delegate goals routines", action: .destination(.agents)
        ),
        Command(
            id: "code-runs", label: "Open Code", icon: .code,
            keywords: "sessions runs agents executions tasks juno code", action: .openCode
        ),
        Command(
            id: "design", label: "Open Designs", icon: .design,
            keywords: "canvas frames screens figma", action: .page(.designs)
        ),
        Command(
            id: "artifacts", label: "Open Artifacts", icon: .artifacts,
            keywords: "documents generated made", action: .destination(.artifacts)
        ),
        Command(
            id: "library", label: "Open Library", icon: .library,
            keywords: "saved prompts snippets", action: .destination(.library)
        ),
        Command(
            id: "connections", label: "Open Connections", icon: .connections,
            keywords: "plugins integrations github mcp connectors", action: .destination(.connections)
        ),
        Command(
            id: "skills", label: "Open Skills", icon: .skills,
            keywords: "instructions reusable slash capability library",
            action: .page(.skills), isAvailable: { $0.openPage != nil }
        ),
        Command(
            id: "automations", label: "Open Automations", icon: .automations,
            keywords: "schedule scheduled tasks recurring trigger cron email calendar monitor",
            action: .page(.automations), isAvailable: { $0.openPage != nil }
        ),
        Command(
            id: "permissions", label: "Open Permissions", icon: .permissions,
            keywords: "approvals allow ask macs hosts security",
            action: .page(.permissions), isAvailable: { $0.openPage != nil }
        ),
        Command(
            id: "memory", label: "Open Memory", icon: .memory,
            keywords: "remember facts", action: .destination(.memory)
        ),
        Command(
            id: "roadmap", label: "Roadmap & feature requests", icon: .mapTrifold,
            keywords: "feedback vote ideas", isExternal: true, action: .roadmap
        ),
    ] }

    /// The Settings group. The theme row names the theme it switches to.
    private static func settingsCommands(isDark: Bool) -> [Command] {
        [
            Command(
                id: "settings", label: "Settings", hint: Self.keys(.settings), icon: .settings,
                keywords: "preferences account theme", action: .settings
            ),
            Command(
                id: "upgrade", label: "Plans & upgrade", icon: .billing,
                keywords: "billing pro max pricing", action: .upgrade,
                isAvailable: { $0.openUpgrade != nil }
            ),
            Command(
                id: "theme", label: isDark ? "Switch to light mode" : "Switch to dark mode",
                hint: Self.keys(.toggleTheme), icon: isDark ? .sun : .moon,
                keywords: "theme dark light appearance", action: .toggleTheme
            ),
            Command(
                id: "shortcuts", label: "Keyboard shortcuts", hint: Self.keys(.keyboardShortcuts), icon: .keyboard,
                keywords: "keys help", action: .keyboardShortcuts
            ),
        ]
    }

    // MARK: Time

    /// Compact relative time for trailing meta — the web's `relativeTime`:
    /// "Just now", "5m", "2h", "Yesterday", "3d", "2w", "4mo", "1y".
    static func relativeTime(_ date: Date, now: Date = Date()) -> String {
        guard date.timeIntervalSince1970 > 0 else { return "" }
        let diff = now.timeIntervalSince(date) * 1000
        if diff < 60_000 { return "Just now" }
        let minutes = Int(diff / 60_000)
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        if days == 1 { return "Yesterday" }
        if days < 7 { return "\(days)d" }
        if days < 30 { return "\(days / 7)w" }
        if days < 365 { return "\(days / 30)mo" }
        return "\(days / 365)y"
    }
}
