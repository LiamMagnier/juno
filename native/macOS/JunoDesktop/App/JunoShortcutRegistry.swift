import JunoDesignSystem
import SwiftUI

// MARK: - The registry

/// Every chord the Chat and Code windows answer to, in one table (§7.8, §7.9;
/// Phase 3 brief A1).
///
/// The menu bar (``JunoDesktopCommands``) and the Keyboard Shortcuts window
/// (``DesktopShortcutsWindow``) are both built by reading this list, so a key
/// cannot be in one and missing from the other, and a chord cannot be typed
/// twice. Nothing else in the Chat window binds a chord the menu bar owns: a
/// view-level `.keyboardShortcut` that duplicates an entry here is a bug the
/// registry tests and the acceptance grep look for.
///
/// **Order is meaning.** Entries are listed in the order the menus draw them
/// and the Shortcuts window lists them; `section` splits a menu into its
/// divider-separated groups.
enum JunoShortcutRegistry {
    static let entries: [JunoShortcut] = everywhere + products + composer + responses + code

    /// The entry for an id. Every id has exactly one entry (a test proves it).
    static func entry(_ id: JunoShortcutID) -> JunoShortcut {
        guard let entry = entries.first(where: { $0.id == id }) else {
            preconditionFailure("JunoShortcutRegistry has no entry for \(id)")
        }
        return entry
    }

    /// A menu's entries, split into its sections in order.
    static func sections(in menu: JunoShortcutMenu) -> [[JunoShortcut]] {
        let inMenu = entries.filter { $0.menu == menu }
        let numbers = inMenu.map(\.section).reduce(into: [Int]()) { found, section in
            if !found.contains(section) { found.append(section) }
        }
        return numbers.sorted().map { number in inMenu.filter { $0.section == number } }
    }

    /// The Shortcuts window's groups: every listed entry, rows merged where two
    /// chords do one thing ("New chat" ⌘N and ⇧⌘O).
    static let groups: [JunoShortcutListGroup] = JunoShortcutGroup.allCases.compactMap { group in
        var rows: [JunoShortcutListRow] = []
        for entry in entries where entry.group == group {
            guard let label = entry.listLabel else { continue }
            if let index = rows.firstIndex(where: { $0.label == label }) {
                rows[index].chords.append(entry.keys)
                rows[index].ids.append(entry.id)
            } else {
                rows.append(JunoShortcutListRow(label: label, chords: [entry.keys], ids: [entry.id]))
            }
        }
        return rows.isEmpty ? nil : JunoShortcutListGroup(group: group, rows: rows)
    }

    // MARK: Everywhere

    private static let everywhere: [JunoShortcut] = [
        JunoShortcut(
            .commandMenu, menu: "Command Menu…", list: "Command menu",
            key: "k", [.command], group: .everywhere, in: .view, section: 1, glyph: .command
        ),
        JunoShortcut(
            .search, menu: "Search…", list: "Search",
            key: "f", [.command, .shift], group: .everywhere, in: .view, section: 1, glyph: .search
        ),
        // "New Task" in Code, and "New Window" with no window focused: see
        // ``DesktopCommandContext/title(for:)``.
        JunoShortcut(
            .newChat, menu: "New Chat", list: "New chat",
            key: "n", [.command], group: .everywhere, in: .file, section: 0, glyph: .new
        ),
        // The web's own chord for New chat, kept beside ⌘N (Phase 1).
        JunoShortcut(
            .newChatAlias, menu: "New Chat", list: "New chat",
            key: "o", [.command, .shift], group: .everywhere, in: .file, section: 1, glyph: .new
        ),
        JunoShortcut(
            .newPrivateChat, menu: "New Private Chat", list: "New private chat",
            key: "n", [.command, .shift], group: .everywhere, in: .file, section: 0, glyph: .privateChat
        ),
        // Quick Entry's global hotkey is installed by its controller; the menu
        // item shows the chord and opens the same panel.
        JunoShortcut(
            .askJuno, menu: "Ask Juno…", list: "Ask Juno from anywhere",
            key: " ", [.option], keys: ["⌥", "Space"],
            group: .everywhere, in: .file, section: 3, glyph: .home
        ),
        // Drawn by the system (`SidebarCommands`); ⇧⌘S stays Save As.
        JunoShortcut(
            .toggleSidebar, systemItem: "Toggle sidebar",
            key: "s", [.command, .control], group: .everywhere
        ),
        JunoShortcut(
            .toggleTheme, menu: "Switch to Dark Mode", list: "Toggle theme",
            key: "l", [.command, .shift], group: .everywhere, in: .view, section: 2, glyph: .moon
        ),
        // Drawn by the system (the `Settings` scene).
        JunoShortcut(
            .settings, systemItem: "Settings",
            key: ",", [.command], group: .everywhere
        ),
        // Help: Juno Help ↗ · Keyboard Shortcuts · Roadmap & Feature Requests ↗.
        // The two links have no chord, so they are not listed.
        JunoShortcut(.help, menuOnly: "Juno Help", in: .help, section: 0, glyph: .circleHelp),
        JunoShortcut(
            .keyboardShortcuts, menu: "Keyboard Shortcuts", list: "Keyboard shortcuts",
            key: "/", [.command], group: .everywhere, in: .help, section: 0, glyph: .keyboard
        ),
        JunoShortcut(.roadmap, menuOnly: "Roadmap & Feature Requests", in: .help, section: 0, glyph: .externalLink),
    ]

    // MARK: Products

    /// ⌘1 · ⌘2, the checkmark rows in View (``DesktopProductMode/switchable``).
    private static let products: [JunoShortcut] = [
        JunoShortcut(
            .productChat, menu: "Chat", list: "Chat",
            key: "1", [.command], group: .products, in: .view, section: 0, glyph: .home
        ),
        JunoShortcut(
            .productCode, menu: "Code", list: "Code",
            key: "2", [.command], group: .products, in: .view, section: 0, glyph: .code
        ),
    ]

    // MARK: Composer

    /// The composer's keys. Only what the Mac composer does today: the web's
    /// `/` Commands and `@` Tools and connectors wait for the palette (§7 of
    /// the Phase 3 brief).
    private static let composer: [JunoShortcut] = [
        JunoShortcut(.sendMessage, field: "Send message", keys: ["↩"], group: .composer, context: .chat),
        JunoShortcut(.newLine, field: "New line", keys: ["⇧", "↩"], group: .composer, context: .chat),
        JunoShortcut(
            .attachFiles, menu: "Attach Files…", list: "Attach files",
            key: "u", [.command], group: .composer, in: .chat, section: 0, context: .chat, glyph: .attach
        ),
        JunoShortcut(
            .attachScreenshot, menu: "Attach Screenshot…", list: "Attach a screenshot",
            key: "u", [.command, .shift], group: .composer, in: .chat, section: 0, context: .chat, glyph: .scan
        ),
        JunoShortcut(
            .editLastMessage, field: "Edit your last message (empty field)",
            keys: ["↑"], group: .composer, context: .chat
        ),
        JunoShortcut(
            .focusComposer, menu: "Focus Composer", list: "Focus the composer",
            key: .escape, [.shift],
            group: .composer, in: .chat, section: 1, context: .chat, glyph: .textCursor
        ),
        JunoShortcut(
            .stopGenerating, menu: "Stop Generating", list: "Stop generating",
            key: ".", [.command], group: .composer, in: .chat, section: 1, context: .chat, glyph: .circleStop
        ),
        // The composer's own Esc (`ChatComposer`), and Esc closing any menu.
        JunoShortcut(
            .stopWithEscape, field: "Stop generating · close a menu",
            keys: ["esc"], group: .composer, context: .chat
        ),
    ]

    // MARK: Responses

    private static let responses: [JunoShortcut] = [
        JunoShortcut(
            .copyLastResponse, menu: "Copy Last Response", list: "Copy the last response",
            key: "c", [.command, .shift], group: .responses, in: .chat, section: 2, context: .chat, glyph: .copy
        ),
        // ⇧⌘; — on a US layout the same press as ⌘:, AppKit's Show Spelling
        // and Grammar. This app adds no `TextEditingCommands`, so the chord is
        // free; `JunoShortcutRegistryTests` reads the built menu bar to prove it.
        JunoShortcut(
            .copyLastCodeBlock, menu: "Copy Last Code Block", list: "Copy the last code block",
            key: ";", [.command, .shift], group: .responses, in: .chat, section: 2, context: .chat,
            glyph: .codeBrackets
        ),
        JunoShortcut(
            .findInConversation, menu: "Find in Conversation…", list: "Find in conversation",
            key: "f", [.command], group: .responses, in: .edit, section: 0, context: .chat, glyph: .search
        ),
        JunoShortcut(
            .findNext, menu: "Find Next", list: "Find next",
            key: "g", [.command], group: .responses, in: .edit, section: 0, context: .chat, glyph: .chevronDown
        ),
        JunoShortcut(
            .findPrevious, menu: "Find Previous", list: "Find previous",
            key: "g", [.command, .shift], group: .responses, in: .edit, section: 0, context: .chat,
            glyph: .chevronUp
        ),
        JunoShortcut(
            .regenerate, menu: "Regenerate", list: "Regenerate",
            key: "r", [.command], group: .responses, in: .chat, section: 1, context: .chat, glyph: .refresh
        ),
    ]

    // MARK: Code

    /// Code's keys, moved as data from the table the window used to hold, one
    /// row per key: its three combined rows ("Previous · next session", the
    /// focused request's three answers, the slash commands) are split or
    /// shortened so each fits one line of its column. Its ⌘K row went: ⌘K is
    /// Command Menu… in View, which opens Code's own palette while Code is
    /// showing (decision 2).
    private static let code: [JunoShortcut] = [
        JunoShortcut(
            .codeOpenFolder, menu: "Open Folder…", list: "Open folder",
            key: "o", [.command], group: .code, in: .file, section: 2, context: .code, glyph: .folderOpen
        ),
        JunoShortcut(
            .codePreviousSession, menu: "Previous Session", list: "Previous session",
            key: "[", [.command, .shift], group: .code, in: .session, section: 1, context: .code,
            glyph: .arrowUp
        ),
        JunoShortcut(
            .codeNextSession, menu: "Next Session", list: "Next session",
            key: "]", [.command, .shift], group: .code, in: .session, section: 1, context: .code,
            glyph: .arrowDown
        ),
        JunoShortcut(.codeSend, field: "Send, steer or queue", keys: ["⌘", "↩"], group: .code, context: .code),
        JunoShortcut(
            .codeStop, menu: "Stop", list: "Stop the run",
            key: ".", [.command], group: .code, in: .session, section: 0, context: .code, glyph: .circleStop
        ),
        JunoShortcut(
            .codeAllow, field: "Allow the focused request",
            keys: ["↩"], group: .code, context: .code
        ),
        JunoShortcut(
            .codeAlwaysAllow, field: "Always allow the focused request",
            keys: ["⌘", "↩"], group: .code, context: .code
        ),
        JunoShortcut(
            .codeDecline, field: "Decline the focused request",
            keys: ["esc"], group: .code, context: .code
        ),
        JunoShortcut(
            .codeChanges, menu: "Changes", list: "Changes",
            key: "r", [.command, .option], group: .code, in: .session, section: 2, context: .code, glyph: .diff
        ),
        // ⌥⌘C, not ⌥⌘T: `ToolbarCommands` binds ⌥⌘T to Show/Hide Toolbar.
        JunoShortcut(
            .codeTerminal, menu: "Terminal", list: "Terminal",
            key: "c", [.command, .option], group: .code, in: .session, section: 2, context: .code,
            glyph: .terminal
        ),
        JunoShortcut(
            .codeSidePanel, menu: "Toggle Side Panel", list: "Side panel",
            key: "i", [.command, .option], group: .code, in: .session, section: 2, context: .code,
            glyph: .panelRight
        ),
        JunoShortcut(
            .codePreview, menu: "Toggle Preview", list: "Preview",
            key: "p", [.command, .option], group: .code, in: .session, section: 2, context: .code, glyph: .eye
        ),
        JunoShortcut(
            .codeOpenFile, menu: "Open File…", list: "Open file",
            key: "o", [.command, .shift, .option], group: .code, in: .session, section: 2, context: .code,
            glyph: .file
        ),
        JunoShortcut(
            .codeSendReview, field: "Send your review to Juno",
            keys: ["⇧", "⌘", "↩"], group: .code, context: .code
        ),
        JunoShortcut(
            .codeSlashCommands, field: "Slash commands, like /compact",
            keys: ["/"], group: .code, context: .code
        ),
        JunoShortcut(.codeMention, field: "Mention a file", keys: ["@"], group: .code, context: .code),
        JunoShortcut(
            .codeCreatePullRequest, menuOnly: "Create Pull Request…",
            in: .session, section: 3, context: .code, glyph: .pulls
        ),
    ]
}

// MARK: - Entries

enum JunoShortcutID: String, CaseIterable, Sendable {
    // Everywhere
    case commandMenu, search, newChat, newChatAlias, newPrivateChat, askJuno
    case toggleSidebar, toggleTheme, settings, keyboardShortcuts
    // Products
    case productChat, productCode
    // Composer
    case sendMessage, newLine, attachFiles, attachScreenshot, editLastMessage
    case focusComposer, stopGenerating, stopWithEscape
    // Responses
    case copyLastResponse, copyLastCodeBlock, findInConversation, findNext, findPrevious, regenerate
    // Code
    case codeOpenFolder, codePreviousSession, codeNextSession, codeSend, codeStop
    case codeAllow, codeAlwaysAllow, codeDecline, codeChanges, codeTerminal, codeSidePanel
    case codePreview, codeOpenFile, codeSendReview, codeSlashCommands, codeMention
    // Menu items with no chord
    case codeCreatePullRequest, help, roadmap
}

/// The Shortcuts window's groups, in its order (§7.9 plus Code).
enum JunoShortcutGroup: String, CaseIterable, Identifiable, Sendable {
    case everywhere, products, composer, responses, code

    var id: Self { self }

    var title: String {
        switch self {
        case .everywhere: "Everywhere"
        case .products: "Products"
        case .composer: "Composer"
        case .responses: "Responses"
        case .code: "Code"
        }
    }
}

/// The menu an entry is drawn in.
enum JunoShortcutMenu: String, CaseIterable, Sendable {
    case file, edit, view, chat, session, help
}

/// Where a chord answers. Two entries may share a chord only when their
/// contexts cannot both be live: Chat's ⌘. and Code's ⌘. are two menu items
/// that are never enabled in the same window at once.
enum JunoShortcutContext: Sendable {
    case always, chat, code

    func overlaps(_ other: Self) -> Bool {
        self == .always || other == .always || self == other
    }
}

/// How a chord is bound.
enum JunoShortcutBinding: Equatable, Sendable {
    /// A menu bar item Juno declares.
    case menu(JunoShortcutMenu)
    /// A menu bar item the system draws (`SidebarCommands`, `Settings`).
    case system
    /// A key a focused control answers (Return in the composer, Esc). Never
    /// a menu item, so never allowed to share a menu item's chord.
    case field
    /// A menu item with no chord (Juno Help).
    case menuOnly(JunoShortcutMenu)
}

struct JunoShortcut: Identifiable, Sendable {
    let id: JunoShortcutID
    /// Title Case, with an ellipsis when it asks for more. Nil for a key that
    /// is not a menu item.
    let menuTitle: String?
    /// Sentence case, in the web's words where the web lists it. Nil for a
    /// menu item that has no chord to list.
    let listLabel: String?
    let key: KeyEquivalent?
    let modifiers: EventModifiers
    /// One keycap per key, in the Mac's modifier order (⌃ ⌥ ⇧ ⌘): "⇧", "⌘",
    /// "F" — the web's `splitKeys`. A key the keyboard names in words is its
    /// word: "Space", "esc".
    let keys: [String]
    let group: JunoShortcutGroup?
    let binding: JunoShortcutBinding
    let section: Int
    let context: JunoShortcutContext
    /// The row's 16pt glyph in its menu. Every menu entry has one.
    let glyph: JunoIcon?

    /// The menu this entry is drawn in, if Juno draws it.
    var menu: JunoShortcutMenu? {
        switch binding {
        case .menu(let menu), .menuOnly(let menu): menu
        case .system, .field: nil
        }
    }

    var keyboardShortcut: KeyboardShortcut? {
        key.map { KeyboardShortcut($0, modifiers: modifiers) }
    }

    /// The chord as VoiceOver reads it: "Shift Command F".
    var spokenKeys: String {
        JunoShortcutKeys.spoken(keys)
    }

    // A menu item with a chord.
    init(
        _ id: JunoShortcutID,
        menu title: String,
        list label: String,
        key: KeyEquivalent,
        _ modifiers: EventModifiers,
        keys: [String]? = nil,
        group: JunoShortcutGroup,
        in menu: JunoShortcutMenu,
        section: Int,
        context: JunoShortcutContext = .always,
        glyph: JunoIcon
    ) {
        self.id = id
        self.menuTitle = title
        self.listLabel = label
        self.key = key
        self.modifiers = modifiers
        self.keys = keys ?? JunoShortcutKeys.caps(key: key, modifiers: modifiers)
        self.group = group
        self.binding = .menu(menu)
        self.section = section
        self.context = context
        self.glyph = glyph
    }

    // A menu bar item the system draws.
    init(
        _ id: JunoShortcutID,
        systemItem label: String,
        key: KeyEquivalent,
        _ modifiers: EventModifiers,
        group: JunoShortcutGroup
    ) {
        self.id = id
        self.menuTitle = nil
        self.listLabel = label
        self.key = key
        self.modifiers = modifiers
        self.keys = JunoShortcutKeys.caps(key: key, modifiers: modifiers)
        self.group = group
        self.binding = .system
        self.section = 0
        self.context = .always
        self.glyph = nil
    }

    // A key a focused control answers.
    init(
        _ id: JunoShortcutID,
        field label: String,
        keys: [String],
        group: JunoShortcutGroup,
        context: JunoShortcutContext
    ) {
        self.id = id
        self.menuTitle = nil
        self.listLabel = label
        self.key = nil
        self.modifiers = []
        self.keys = keys
        self.group = group
        self.binding = .field
        self.section = 0
        self.context = context
        self.glyph = nil
    }

    // A menu item with no chord.
    init(
        _ id: JunoShortcutID,
        menuOnly title: String,
        in menu: JunoShortcutMenu,
        section: Int,
        context: JunoShortcutContext = .always,
        glyph: JunoIcon
    ) {
        self.id = id
        self.menuTitle = title
        self.listLabel = nil
        self.key = nil
        self.modifiers = []
        self.keys = []
        self.group = nil
        self.binding = .menuOnly(menu)
        self.section = section
        self.context = context
        self.glyph = glyph
    }
}

// MARK: - The Shortcuts window's rows

struct JunoShortcutListGroup: Identifiable, Sendable {
    let group: JunoShortcutGroup
    let rows: [JunoShortcutListRow]

    var id: JunoShortcutGroup { group }
    var title: String { group.title }
}

/// One row: a label and every chord that does it.
struct JunoShortcutListRow: Identifiable, Sendable {
    let label: String
    var chords: [[String]]
    var ids: [JunoShortcutID]

    var id: String { label }

    /// "Search, Shift Command F"; alternatives joined with "or".
    var accessibilityLabel: String {
        let spoken = chords.map(JunoShortcutKeys.spoken).joined(separator: ", or ")
        return "\(label), \(spoken)"
    }
}

// MARK: - Keycaps

enum JunoShortcutKeys {
    /// The Mac's modifier order: Control, Option, Shift, Command.
    static func caps(key: KeyEquivalent, modifiers: EventModifiers) -> [String] {
        var caps: [String] = []
        if modifiers.contains(.control) { caps.append("⌃") }
        if modifiers.contains(.option) { caps.append("⌥") }
        if modifiers.contains(.shift) { caps.append("⇧") }
        if modifiers.contains(.command) { caps.append("⌘") }
        caps.append(cap(for: key))
        return caps
    }

    static func cap(for key: KeyEquivalent) -> String {
        switch key {
        // The word the key wears on a Mac keyboard: at the keycap's 10.5pt
        // the ⎋ glyph reads as a stray circle.
        case .escape: "esc"
        case .return: "↩"
        case .upArrow: "↑"
        case .downArrow: "↓"
        case .space: "Space"
        case .tab: "⇥"
        case .delete: "⌫"
        default: String(key.character).uppercased()
        }
    }

    private static let names: [String: String] = [
        "⌃": "Control", "⌥": "Option", "⇧": "Shift", "⌘": "Command",
        "↩": "Return", "esc": "Escape", "↑": "Up Arrow", "↓": "Down Arrow",
        "⇥": "Tab", "⌫": "Delete", "Space": "Space",
        ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon",
        "[": "Left Bracket", "]": "Right Bracket", "@": "At",
    ]

    /// Each cap by name, so "⇧⌘F" is read as three keys.
    static func spoken(_ caps: [String]) -> String {
        caps.map { names[$0] ?? $0 }.joined(separator: " ")
    }
}
