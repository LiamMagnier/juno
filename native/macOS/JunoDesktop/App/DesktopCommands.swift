import AppKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// The actions the menu bar can perform on **the focused window**.
///
/// The first version of this app routed its one command through a
/// `NotificationCenter` broadcast. That works with exactly one window open and
/// silently misbehaves with two: `⌘N` posted a notification every window
/// observed, so every window started a new chat and the user's other
/// conversation was replaced in a window they were not even looking at.
///
/// `FocusedValues` is the platform's answer. A window publishes its actions while
/// it is focused, the commands read whatever the focused window published, and a
/// command with no focused window is simply disabled — which is also why every
/// menu item below is `nil`-guarded rather than unconditionally enabled.
struct DesktopWorkspaceActions {
    var newItem: () -> Void
    var newChat: () -> Void
    var openSearch: () -> Void
    var switchProduct: (DesktopProductMode) -> Void
    var currentProduct: DesktopProductMode
    /// ⌘K, View › Command Menu…: Juno's panel, in Chat. Nil wherever the
    /// window has none; in Code the item opens Code's own palette
    /// (``DesktopCodeActions/openPalette``) instead, until the Code session
    /// retires it.
    var openCommandMenu: (() -> Void)? = nil
    /// ⌘F, ⌘G and ⇧⌘G: find in the conversation on screen. Nil wherever
    /// there is none, which disables the three items.
    var findInConversation: ((DesktopFindCommand.Kind) -> Void)? = nil
}

/// What the menu bar can do to the focused *window*, whichever product it is
/// showing.
///
/// Published by ``JunoDesktopWorkspaceView`` — the one view that sits above
/// every product and can change which one is showing — so ⇧⌘N reaches Chat's
/// private draft from Code without Code having to publish it.
struct DesktopShellActions {
    /// Switches the window to Chat on a new private draft.
    var newPrivateChat: () -> Void
    /// ⇧⌘L, View › Switch to Dark Mode / Switch to Light Mode: writes the
    /// account's theme, as the web's ⌘⇧L does. Nil without the account's
    /// settings to write to.
    var toggleTheme: ThemeToggle? = nil

    struct ThemeToggle {
        /// Whether the window is dark now, which names the item: the web's
        /// "Switch to {the other} mode".
        let isDark: Bool
        let perform: () -> Void
    }
}

/// What the Code window adds to the menu bar while it is focused.
///
/// Published separately from ``DesktopWorkspaceActions`` because only the Code
/// window has a session to step through, a review to toggle or a console to
/// show; the Chat window leaves this nil and the Session menu disables.
struct DesktopCodeActions {
    var openPalette: () -> Void
    var previousSession: () -> Void
    var nextSession: () -> Void
    var toggleReview: () -> Void
    var toggleConsole: () -> Void
    var toggleInspector: () -> Void
    var togglePreview: () -> Void
    var openFile: () -> Void
    /// ⌘O: grant a folder as a project.
    var openFolder: () -> Void
    var createPullRequest: (() -> Void)?
    /// ⌘.: stops the run on screen, or nil when nothing is running. A menu
    /// command rather than a shortcut on the composer's Stop button, which
    /// gives way to Send as soon as the draft has any text, taking ⌘. with it
    /// in exactly the moment a reader typing a correction decides to stop.
    var stop: (() -> Void)?
    var hasSession: Bool
}

private struct DesktopWorkspaceActionsKey: FocusedValueKey {
    typealias Value = DesktopWorkspaceActions
}

private struct DesktopCodeActionsKey: FocusedValueKey {
    typealias Value = DesktopCodeActions
}

private struct DesktopShellActionsKey: FocusedValueKey {
    typealias Value = DesktopShellActions
}

extension FocusedValues {
    var junoWorkspaceActions: DesktopWorkspaceActions? {
        get { self[DesktopWorkspaceActionsKey.self] }
        set { self[DesktopWorkspaceActionsKey.self] = newValue }
    }

    var junoCodeActions: DesktopCodeActions? {
        get { self[DesktopCodeActionsKey.self] }
        set { self[DesktopCodeActionsKey.self] = newValue }
    }

    var junoShellActions: DesktopShellActions? {
        get { self[DesktopShellActionsKey.self] }
        set { self[DesktopShellActionsKey.self] = newValue }
    }
}

// MARK: - Resolving an entry

/// What every menu item can do right now, resolved from what the focused
/// window published.
///
/// The menus are generated from ``JunoShortcutRegistry``; this is the one
/// place an entry's id becomes an action, a title and a glyph. A nil action
/// disables the item — and a disabled item does not claim its chord, which is
/// how Chat's ⌘. and Code's ⌘. share a key without ever both answering.
struct DesktopCommandContext {
    var workspace: DesktopWorkspaceActions?
    var code: DesktopCodeActions?
    var shell: DesktopShellActions?
    var chat: DesktopChatCommandActions?
    var composerStop: ChatComposerStopCommand?
    /// What the app can do with no window focused.
    var openMainWindow: () -> Void = {}
    var newPrivateChatWithoutWindow: () -> Void = {}
    var openShortcuts: () -> Void = {}
    var toggleQuickEntry: () -> Void = {}
    var openURL: (URL) -> Void = { _ in }

    var product: DesktopProductMode? { workspace?.currentProduct }

    /// Code's Session menu stands where the Chat menu does while the focused
    /// window shows Code, so the menu bar never offers both.
    var showsSessionMenu: Bool { product == .code }

    static let helpURL = URL(string: "\(JunoBackend.productionURLString)/help")!
    static let roadmapURL = URL(string: "\(JunoBackend.productionURLString)/roadmap")!

    /// The item's words: the registry's, except where the moment renames it.
    func title(for entry: JunoShortcut) -> String {
        switch entry.id {
        case .newChat:
            guard let product else { return JunoDesktopWindow.newWindowMenuTitle }
            return product == .chat ? "New Chat" : "New Task"
        case .toggleTheme:
            return isDark ? "Switch to Light Mode" : "Switch to Dark Mode"
        default:
            return entry.menuTitle ?? entry.listLabel ?? ""
        }
    }

    /// The item's glyph: the registry's, except the theme item, which shows
    /// where it goes (the web's Sun and Moon).
    func glyph(for entry: JunoShortcut) -> JunoIcon? {
        if entry.id == .toggleTheme { return isDark ? .sun : .moon }
        return entry.glyph
    }

    private var isDark: Bool { shell?.toggleTheme?.isDark ?? false }

    /// A checkmark row's state (View › Chat, Code), or nil for a plain item.
    func isOn(_ id: JunoShortcutID) -> Bool? {
        switch id {
        case .productChat: product == .chat
        case .productCode: product == .code
        default: nil
        }
    }

    /// What choosing the item does, or nil to disable it.
    func action(for id: JunoShortcutID) -> (() -> Void)? {
        switch id {
        // Everywhere
        case .commandMenu:
            return product == .code ? code?.openPalette : workspace?.openCommandMenu
        case .search:
            return workspace?.openSearch
        case .newChat:
            return workspace?.newItem ?? openMainWindow
        case .newChatAlias:
            return workspace?.newChat
        case .newPrivateChat:
            // Always present (§7.8): private chat is a mode of Chat, so there
            // is always somewhere for it to open.
            return shell?.newPrivateChat ?? newPrivateChatWithoutWindow
        case .askJuno:
            return toggleQuickEntry
        case .toggleTheme:
            return shell?.toggleTheme?.perform
        case .keyboardShortcuts:
            return openShortcuts
        case .help:
            return { openURL(Self.helpURL) }
        case .roadmap:
            return { openURL(Self.roadmapURL) }

        // Products
        case .productChat:
            return workspace.map { workspace in { workspace.switchProduct(.chat) } }
        case .productCode:
            return workspace.map { workspace in { workspace.switchProduct(.code) } }

        // Chat
        case .attachFiles:
            return chatAction(chat?.attachFiles)
        case .attachScreenshot:
            return chatAction(chat?.attachScreenshot)
        case .focusComposer:
            return chatAction(chat?.focusComposer)
        case .stopGenerating:
            // Only where the Chat window published its commands: ⌘. must never
            // reach a composer from Code, nor shadow Code's own Stop.
            return chat == nil ? nil : chatAction(composerStop?.perform)
        case .regenerate:
            return chatAction(chat?.regenerate?.perform)
        case .copyLastResponse:
            return chatAction(chat?.copyLastResponse)
        case .copyLastCodeBlock:
            return chatAction(chat?.copyLastCodeBlock)

        // Edit › Find: disabled — and so not claiming the keys — wherever no
        // conversation is on screen (§6.14).
        case .findInConversation:
            return workspace?.findInConversation.map { find in { find(.open) } }
        case .findNext:
            return workspace?.findInConversation.map { find in { find(.next) } }
        case .findPrevious:
            return workspace?.findInConversation.map { find in { find(.previous) } }

        // Code
        case .codeOpenFolder:
            return code?.openFolder
        case .codePreviousSession:
            return code?.previousSession
        case .codeNextSession:
            return code?.nextSession
        case .codeStop:
            // Belt and braces: Code's actions are only published by the Code
            // workspace, but ⌘. must never stop a Code run from Chat.
            return product == .code ? code?.stop : nil
        case .codeChanges:
            return sessionAction(code?.toggleReview)
        case .codeTerminal:
            return sessionAction(code?.toggleConsole)
        case .codeSidePanel:
            return sessionAction(code?.toggleInspector)
        case .codePreview:
            return sessionAction(code?.togglePreview)
        case .codeOpenFile:
            return sessionAction(code?.openFile)
        case .codeCreatePullRequest:
            return code?.createPullRequest

        // Drawn by the system, or answered by a focused control: never a
        // menu item of ours.
        case .toggleSidebar, .settings, .sendMessage, .newLine, .editLastMessage, .stopWithEscape,
            .codeSend, .codeAllow, .codeAlwaysAllow, .codeDecline, .codeSendReview,
            .codeSlashCommands, .codeMention:
            return nil
        }
    }

    /// A Chat item acts only while the focused window shows Chat.
    private func chatAction(_ action: (() -> Void)?) -> (() -> Void)? {
        product == .code ? nil : action
    }

    /// A Session item that needs a session open.
    private func sessionAction(_ action: (() -> Void)?) -> (() -> Void)? {
        code?.hasSession == true ? action : nil
    }
}

// MARK: - The menu bar

/// Juno's menu bar, generated from ``JunoShortcutRegistry`` (§7.8; Phase 3
/// brief A2).
///
/// A Mac app is expected to be operable from the menu bar, and a menu is also
/// the only place a user reliably discovers a keyboard shortcut. Every item
/// below comes from the registry — its words, its glyph, its chord and its
/// place — so the menu bar and the Keyboard Shortcuts window cannot drift, and
/// no chord is typed twice. Hand-listed here are only the system's groups and
/// the updater's status. (Window › Tasks (Legacy) went with the old Work
/// workspace in Phase 5 Stage D.)
///
/// **Chat or Session.** While the focused window shows Code the menu bar
/// carries Code's Session menu; otherwise it carries Chat. The two never stand
/// together, so Chat's ⌘. Stop Generating and Code's ⌘. Stop cannot both be
/// on screen.
struct JunoDesktopCommands: Commands {
    @FocusedValue(\.junoWorkspaceActions) private var actions
    @FocusedValue(\.junoCodeActions) private var codeActions
    @FocusedValue(\.junoShellActions) private var shellActions
    @FocusedValue(\.junoChatCommands) private var chatCommands
    @FocusedValue(\.junoComposerStop) private var composerStop
    @Environment(\.openWindow) private var openWindow
    @State private var updater = DesktopUpdateModel.shared

    private var context: DesktopCommandContext {
        let openWindow = openWindow
        return DesktopCommandContext(
            workspace: actions,
            code: codeActions,
            shell: shellActions,
            chat: chatCommands,
            composerStop: composerStop,
            openMainWindow: { openWindow(id: JunoDesktopWindow.mainID) },
            newPrivateChatWithoutWindow: {
                // The request goes to whichever main window exists — brought
                // forward rather than a second one opened — and only with none
                // at all is a window opened for it.
                DesktopWorkbenchRegistry.shared.request(.newChat(prompt: nil, isPrivate: true))
                JunoDesktopWindow.showMainWindow(using: openWindow)
            },
            openShortcuts: { openWindow(id: JunoDesktopWindow.shortcutsID) },
            toggleQuickEntry: { DesktopQuickEntryController.shared.toggle() },
            openURL: { NSWorkspace.shared.open($0) }
        )
    }

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Section {
                updateStatusItem
                Button(updateActionTitle) { updateAction() }
                    .disabled(!updateActionEnabled)
            }
        }

        // File: New Chat ⌘N (New Task in Code, New Window with nothing
        // focused) · New Private Chat ⇧⌘N, then New Chat ⇧⌘O, Open Folder…
        // ⌘O and Ask Juno… ⌥Space.
        CommandGroup(replacing: .newItem) {
            DesktopMenuSections(menu: .file, context: context, part: .first)
        }
        CommandGroup(after: .newItem) {
            DesktopMenuSections(menu: .file, context: context, part: .rest)
        }

        // Edit › Find in Conversation… ⌘F · Find Next ⌘G · Find Previous ⇧⌘G.
        CommandGroup(after: .pasteboard) {
            DesktopMenuSections(menu: .edit, context: context)
        }

        SidebarCommands()
        ToolbarCommands()

        // View › Chat ⌘1 · Code ⌘2 (checkmarks), Command Menu… ⌘K · Search…
        // ⇧⌘F, Switch to Dark/Light Mode ⇧⌘L — above the system's sidebar and
        // toolbar items. Also the way to switch product while the sidebar,
        // and the switch in its toolbar segment, is hidden.
        CommandGroup(before: .sidebar) {
            DesktopMenuSections(menu: .view, context: context)
        }

        if context.showsSessionMenu {
            CommandMenu("Session") {
                DesktopMenuSections(menu: .session, context: context)
            }
        } else {
            CommandMenu("Chat") {
                DesktopMenuSections(menu: .chat, context: context)
                // The conversation on screen: the same list, in the same order,
                // as its row, its hover menu and the title menu. No shortcuts:
                // menu shortcuts fire before the focused text field, and ⌘⌫ is
                // delete-to-line-start in the composer.
                DesktopConversationMenu(
                    conversation: chatCommands?.conversation,
                    projects: chatCommands?.projects ?? [],
                    actions: chatCommands?.conversationActions,
                    renameTitle: "Rename…"
                )
            }
        }

        CommandGroup(replacing: .help) {
            DesktopMenuSections(menu: .help, context: context)
        }
    }

    @ViewBuilder
    private var updateStatusItem: some View {
        switch updater.phase {
        case .idle:
            EmptyView()
        case .checking:
            Text("Checking for updates…")
        case .current:
            Text("Juno \(JunoBuildInfo.current.version) is up to date")
        case .downloading(let version, let fraction):
            if let fraction {
                Text("Downloading \(version) — \(Int((fraction * 100).rounded()))%")
            } else {
                Text("Downloading \(version)…")
            }
        case .ready(let version):
            Text("Juno \(version) is ready to install")
        case .failed(let message):
            Text(message)
        case .unsupported(let reason):
            Text(reason)
        }
    }

    private var updateActionTitle: String {
        if case .ready = updater.phase { return "Install Update and Relaunch" }
        return "Check for Updates…"
    }

    private var updateActionEnabled: Bool {
        switch updater.phase {
        case .checking, .downloading, .unsupported: false
        default: true
        }
    }

    private func updateAction() {
        if case .ready = updater.phase {
            updater.installAndRelaunch()
        } else {
            updater.checkNow()
        }
    }
}

// MARK: - Generated sections

/// One menu's items from the registry, a `Section` per registry section so
/// the system draws the dividers between them.
struct DesktopMenuSections: View {
    enum Part {
        case all
        /// The first section only (File's New Chat and New Private Chat, which
        /// replace the system's New group).
        case first
        /// Every section after the first.
        case rest
    }

    let menu: JunoShortcutMenu
    let context: DesktopCommandContext
    var part: Part = .all

    var body: some View {
        ForEach(Array(sections.enumerated()), id: \.offset) { _, entries in
            DesktopMenuSection(entries: entries, context: context)
        }
    }

    private var sections: [[JunoShortcut]] {
        let all = JunoShortcutRegistry.sections(in: menu)
        switch part {
        case .all: return all
        case .first: return Array(all.prefix(1))
        case .rest: return Array(all.dropFirst())
        }
    }
}

/// One registry section as menu rows: a `Label` with the entry's 16pt glyph,
/// its chord, and a checkmark `Toggle` where the row has a state.
///
/// One `Section`, which a menu draws as a divider-bounded group and nothing
/// more: it is also what tells the targets gate these are system-drawn menu
/// rows, not views laid out here.
struct DesktopMenuSection: View {
    let entries: [JunoShortcut]
    let context: DesktopCommandContext

    var body: some View {
        Section {
            ForEach(entries) { entry in
                let action = context.action(for: entry.id)
                if let isOn = context.isOn(entry.id) {
                    Toggle(isOn: Binding(get: { isOn }, set: { if $0 { action?() } })) {
                        label(for: entry)
                    }
                    .keyboardShortcut(entry.keyboardShortcut)
                    .disabled(action == nil)
                } else {
                    Button { action?() } label: {
                        label(for: entry)
                    }
                    .keyboardShortcut(entry.keyboardShortcut)
                    .disabled(action == nil)
                }
            }
        }
    }

    @ViewBuilder
    private func label(for entry: JunoShortcut) -> some View {
        if let glyph = context.glyph(for: entry) {
            Label {
                Text(context.title(for: entry))
            } icon: {
                Image(glyph.assetName)
            }
        } else {
            Text(context.title(for: entry))
        }
    }
}
