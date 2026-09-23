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
    /// ⇧⌘U: a screenshot into the composer. Chat's only; the other products
    /// leave it nil and the menu item disables.
    var attachScreenshot: (() -> Void)? = nil
    /// ⌘U: the composer's file picker. Nil wherever no composer is showing.
    var attachFiles: (() -> Void)? = nil
}

/// What the menu bar can do to the focused *window*, whichever product it is
/// showing.
///
/// Published by ``JunoDesktopWorkspaceView`` — the one view that sits above
/// every product and can change which one is showing — so ⇧⌘N reaches Chat's
/// private draft from Code, and Window › Tasks (Legacy) reaches the old Work
/// workspace from anywhere, without either product having to publish them.
struct DesktopShellActions {
    /// Switches the window to Chat on a new private draft.
    var newPrivateChat: () -> Void
    /// Swaps in the legacy Work workspace (§1.6). Phase 5 removes it.
    var openLegacyTasks: () -> Void
    var isShowingLegacyTasks: Bool
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

/// Juno's menu bar.
///
/// A Mac app is expected to be operable from the menu bar, and a menu is also the
/// only place a user reliably discovers a keyboard shortcut. The app previously
/// shipped one item — "New Chat" — which meant no way to switch product, reach
/// settings, toggle the sidebar or find help without a pointer.
///
/// Phase 1 of the Liquid Glass redesign makes the minimum changes (§7.8): the
/// products are Chat ⌘1 and Code ⌘2 in the View menu, with no ⌘3; New Private
/// Chat ⇧⌘N is always present; the screenshot moves to ⇧⌘U beside ⌘U Attach,
/// freeing ⇧⌘1; ⇧⌘O stays as the web's New chat alias; and the old Work
/// workspace is reachable only from Window › Tasks (Legacy). The full menu bar,
/// generated from one shortcut registry, is Phase 3.
struct JunoDesktopCommands: Commands {
    @FocusedValue(\.junoWorkspaceActions) private var actions
    @FocusedValue(\.junoCodeActions) private var codeActions
    @FocusedValue(\.junoShellActions) private var shellActions
    @Environment(\.openWindow) private var openWindow
    @State private var updater = DesktopUpdateModel.shared

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Section {
                updateStatusItem
                Button(updateActionTitle) { updateAction() }
                    .disabled(!updateActionEnabled)
            }
        }

        CommandGroup(replacing: .newItem) {
            Section {
                if let actions {
                    Button(Self.newItemTitle(for: actions.currentProduct)) {
                        actions.newItem()
                    }
                    .keyboardShortcut("n", modifiers: [.command])
                } else {
                    Button(JunoDesktopWindow.newWindowMenuTitle) {
                        openWindow(id: JunoDesktopWindow.mainID)
                    }
                    .keyboardShortcut("n", modifiers: [.command])
                }
                // Always present, whatever is focused (§7.8): private chat is
                // a mode of Chat now, not a window, so there is always
                // somewhere for it to open.
                Button("New Private Chat") { newPrivateChat() }
                    .keyboardShortcut("n", modifiers: [.command, .shift])
            }
        }

        CommandGroup(after: .newItem) {
            Section {
                // ⇧⌘O from every product, as the brief asks: a new conversation
                // is one keystroke away whatever the window is showing.
                Button("New Chat") {
                    actions?.newChat()
                }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(actions == nil)
            }
            Section {
                // ⌘O in Code, where the column's help text and the New task
                // screen's keycap both promise it.
                Button("Open Folder…") { codeActions?.openFolder() }
                    .keyboardShortcut("o", modifiers: [.command])
                    .disabled(codeActions == nil)
            }
            Section {
                // ⌘U, the key the composer's `+` menu teaches. Here as well so
                // it works with that menu closed.
                Button("Attach Files…") {
                    actions?.attachFiles?()
                }
                .keyboardShortcut("u", modifiers: [.command])
                .disabled(actions?.attachFiles == nil)
                // ⇧⌘U, beside ⌘U Attach: the pair a reader learns together.
                // It used to be ⇧⌘1, one key from the ⌘1 product shortcut.
                Button("Attach Screenshot…") {
                    actions?.attachScreenshot?()
                }
                .keyboardShortcut("u", modifiers: [.command, .shift])
                .disabled(actions?.attachScreenshot == nil)
            }
            Section {
                Button("Find in Juno…") {
                    actions?.openSearch()
                }
                .keyboardShortcut("f", modifiers: [.command, .shift])
                .disabled(actions == nil)
                Button("Ask Juno…") {
                    DesktopQuickEntryController.shared.toggle()
                }
                .keyboardShortcut(" ", modifiers: [.option])
            }
        }

        SidebarCommands()
        ToolbarCommands()

        // View › Chat ⌘1 · Code ⌘2, above the system's sidebar items, with a
        // checkmark against the product the focused window shows. This is
        // also the way to switch while the sidebar — and the switch in its
        // toolbar segment — is hidden.
        CommandGroup(before: .sidebar) {
            Section {
                productItems
            }
        }

        // Window › Tasks (Legacy): the only door left to the old Work
        // workspace, so a task already running can still be answered (§1.6).
        // No shortcut, on purpose. Phase 5 removes it.
        CommandGroup(after: .windowArrangement) {
            Section {
                Button(DesktopProductMode.legacyWork.label) {
                    shellActions?.openLegacyTasks()
                }
                .disabled(shellActions == nil || shellActions?.isShowingLegacyTasks == true)
            }
        }

        CommandMenu("Session") {
            Section {
                Button("Command Palette…") { codeActions?.openPalette() }
                    .keyboardShortcut("k", modifiers: [.command])
                    .disabled(codeActions == nil)
            }
            Section {
                Button("Previous Session") { codeActions?.previousSession() }
                    .keyboardShortcut("[", modifiers: [.command, .shift])
                    .disabled(codeActions == nil)
                Button("Next Session") { codeActions?.nextSession() }
                    .keyboardShortcut("]", modifiers: [.command, .shift])
                    .disabled(codeActions == nil)
            }
            Section {
                Button("Toggle Review") { codeActions?.toggleReview() }
                    .keyboardShortcut("r", modifiers: [.command, .option])
                    .disabled(codeActions?.hasSession != true)
                Button("Toggle Console") { codeActions?.toggleConsole() }
                    .keyboardShortcut("c", modifiers: [.command, .option])
                    .disabled(codeActions?.hasSession != true)
                Button("Toggle Context Rail") { codeActions?.toggleInspector() }
                    .keyboardShortcut("i", modifiers: [.command, .option])
                    .disabled(codeActions?.hasSession != true)
                Button("Toggle Preview") { codeActions?.togglePreview() }
                    .keyboardShortcut("p", modifiers: [.command, .option])
                    .disabled(codeActions?.hasSession != true)
                Button("Open File…") { codeActions?.openFile() }
                    .keyboardShortcut("o", modifiers: [.command, .shift, .option])
                    .disabled(codeActions?.hasSession != true)
            }
            Section {
                Button("Create Pull Request…") { codeActions?.createPullRequest?() }
                    .disabled(codeActions?.createPullRequest == nil)
            }
        }

        CommandGroup(replacing: .help) {
            Section {
                Link(
                    "Juno Help",
                    destination: URL(string: "\(JunoBackend.productionURLString)/help")!
                )
                Button("Keyboard Shortcuts") {
                    openWindow(id: JunoDesktopWindow.shortcutsID)
                }
                .keyboardShortcut("/", modifiers: [.command])
            }
        }
    }

    /// One row per product, with the platform's own checkmark against the
    /// focused window's — a `Toggle` in a menu is how AppKit draws a checked
    /// item, so no glyph of ours is involved. Driven by
    /// ``DesktopProductMode/switchable``, so the legacy workspace never gets a
    /// row or a digit.
    @ViewBuilder
    private var productItems: some View {
        ForEach(DesktopProductMode.switchable) { mode in
            Toggle(
                mode.label,
                isOn: Binding(
                    get: { actions?.currentProduct == mode },
                    set: { isOn in if isOn { actions?.switchProduct(mode) } }
                )
            )
            .keyboardShortcut(mode.keyboardShortcut)
            .disabled(actions == nil)
        }
    }

    /// ⇧⌘N. Through the focused window when there is one; otherwise the request
    /// goes to whichever main window exists — brought forward rather than a
    /// second one opened — and only with none at all is a window opened for it.
    private func newPrivateChat() {
        if let shellActions {
            shellActions.newPrivateChat()
            return
        }
        DesktopWorkbenchRegistry.shared.request(.newChat(prompt: nil, isPrivate: true))
        JunoDesktopWindow.showMainWindow(using: openWindow)
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

    /// What ⌘N makes in each product.
    private static func newItemTitle(for product: DesktopProductMode) -> String {
        switch product {
        case .chat: "New Chat"
        case .code, .legacyWork: "New Task"
        }
    }
}
