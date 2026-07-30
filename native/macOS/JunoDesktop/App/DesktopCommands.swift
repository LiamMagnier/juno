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
}

private struct DesktopWorkspaceActionsKey: FocusedValueKey {
    typealias Value = DesktopWorkspaceActions
}

extension FocusedValues {
    var junoWorkspaceActions: DesktopWorkspaceActions? {
        get { self[DesktopWorkspaceActionsKey.self] }
        set { self[DesktopWorkspaceActionsKey.self] = newValue }
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
    @Environment(\.openWindow) private var openWindow
    /// The app-wide updater. `@State` rather than a bare reference so the menu
    /// re-evaluates when the phase changes — otherwise "Install Update" would
    /// only appear after something else happened to redraw the menu bar.
    @State private var updater = DesktopUpdateModel.shared

    var body: some Commands {
        // Where a Mac user looks for this: the application menu, under About.
        CommandGroup(after: .appInfo) {
            updateStatusItem
            Button(updateActionTitle) { updateAction() }
                .disabled(!updateActionEnabled)
            Divider()
        }

        CommandGroup(replacing: .newItem) {
            if let actions {
                Button(actions.currentProduct == .code ? "New Code Session" : "New Chat") {
                    actions.newItem()
                }
                .keyboardShortcut("n", modifiers: [.command])
            } else {
                // A SwiftUI macOS app may relaunch with no restored windows after
                // the reader closed its last one. The previous command was then
                // disabled because there was no focused workspace, leaving the
                // app alive in the menu bar with no way back to its UI.
                Button("New Incognito Window") {
                openWindow(id: JunoDesktopWindow.incognitoID)
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])

            Button("New Window") {
                    openWindow(id: JunoDesktopWindow.mainID)
                }
                .keyboardShortcut("n", modifiers: [.command])
            }
        }

        CommandGroup(after: .newItem) {
            if actions?.currentProduct == .code {
                Button("New Chat") {
                    actions?.newChat()
                }
                .keyboardShortcut("n", modifiers: [.command, .option])
                .disabled(actions == nil)
            }
            Divider()
            Button("Find in Juno…") {
                actions?.openSearch()
            }
            .keyboardShortcut("f", modifiers: [.command, .shift])
            .disabled(actions == nil)
        }

        // `SidebarCommands` and `ToolbarCommands` are the system's own View-menu
        // items for a NavigationSplitView and a window toolbar. Hand-writing
        // "Toggle Sidebar" would duplicate them and get the state wrong.
        SidebarCommands()
        ToolbarCommands()

        CommandMenu("Product") {
            Picker("Mode", selection: productSelection) {
                Text("Chat").tag(DesktopProductMode.chat)
                Text("Code").tag(DesktopProductMode.code)
            }
            .pickerStyle(.inline)
            .disabled(actions == nil)
        }

        CommandGroup(replacing: .help) {
            Link(
                "Juno Help",
                destination: URL(string: "\(JunoBackend.productionURLString)/help")!
            )
            Link(
                "Keyboard Shortcuts",
                destination: URL(string: "\(JunoBackend.productionURLString)/help/shortcuts")!
            )
        }
    }

    /// A disabled line stating what the updater knows.
    ///
    /// It is present in every state, including "nothing to say", because a menu
    /// that only sometimes has a status line is one the reader has to *check*
    /// for. What it must never do is imply an update exists when the check has
    /// not run — hence the plain "Juno is up to date" only after a real check.
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

    /// Reads the focused window's product and writes back through its action, so
    /// the menu shows a checkmark against the mode that window is actually in.
    private var productSelection: Binding<DesktopProductMode> {
        Binding(
            get: { actions?.currentProduct ?? .chat },
            set: { actions?.switchProduct($0) }
        )
    }
}
