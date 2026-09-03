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
    /// ⇧⌘1: a screenshot into the composer. Chat's only; the other products
    /// leave it nil and the menu item disables.
    var attachScreenshot: (() -> Void)? = nil
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

extension FocusedValues {
    var junoWorkspaceActions: DesktopWorkspaceActions? {
        get { self[DesktopWorkspaceActionsKey.self] }
        set { self[DesktopWorkspaceActionsKey.self] = newValue }
    }

    var junoCodeActions: DesktopCodeActions? {
        get { self[DesktopCodeActionsKey.self] }
        set { self[DesktopCodeActionsKey.self] = newValue }
    }
}

/// Juno's menu bar.
///
/// A Mac app is expected to be operable from the menu bar, and a menu is also the
/// only place a user reliably discovers a keyboard shortcut. The app previously
/// shipped one item — "New Chat" — which meant no way to switch product, reach
/// settings, toggle the sidebar or find help without a pointer.
struct JunoDesktopCommands: Commands {
    @FocusedValue(\.junoWorkspaceActions) private var actions
    @FocusedValue(\.junoCodeActions) private var codeActions
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
                    Button("New Incognito Window") {
                        openWindow(id: JunoDesktopWindow.incognitoID)
                    }
                    .keyboardShortcut("n", modifiers: [.command, .shift])

                    Button(JunoDesktopWindow.newWindowMenuTitle) {
                        openWindow(id: JunoDesktopWindow.mainID)
                    }
                    .keyboardShortcut("n", modifiers: [.command])
                }
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
                Button("Attach Screenshot…") {
                    actions?.attachScreenshot?()
                }
                .keyboardShortcut("1", modifiers: [.command, .shift])
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

        // ⌘1 · ⌘2 · ⌘3, and a checkmark against the mode the focused window
        // is in. Driven by `allCases`, so a product added to the enum appears
        // here without anyone remembering to add a row.
        CommandMenu("Product") {
            Section {
                productItems
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
    /// item, so no glyph of ours is involved.
    @ViewBuilder
    private var productItems: some View {
        Section {
            ForEach(DesktopProductMode.allCases) { mode in
                Toggle(
                    mode.label,
                    isOn: Binding(
                        get: { actions?.currentProduct == mode },
                        set: { isOn in if isOn { actions?.switchProduct(mode) } }
                    )
                )
                .keyboardShortcut(KeyEquivalent(mode.keyboardDigit), modifiers: [.command])
                .disabled(actions == nil)
            }
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

    /// What ⌘N makes in each product.
    private static func newItemTitle(for product: DesktopProductMode) -> String {
        switch product {
        case .chat: "New Chat"
        case .code: "New Task"
        case .work: "New Task"
        }
    }
}
