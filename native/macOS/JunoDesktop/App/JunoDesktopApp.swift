import AppKit
import JunoDesignSystem
import JunoCodeUI
import SwiftUI
#if DEBUG
import JunoPreviewSupport
#endif

enum JunoDesktopWindow {
    static let mainID = "juno.main"
    /// Incognito is a WINDOW on this platform, not a mode inside the main one.
    /// Closing it is what erases the conversation, and that reads as a promise
    /// only if the thing you close is the thing that held it.
    static let incognitoID = "juno.incognito"
    /// The ⌘/ list of every shortcut the app answers.
    static let shortcutsID = "juno.shortcuts"
    /// The File menu's item that opens another main window. Named here because
    /// ``JunoDesktopAppDelegate`` invokes it by title when a launch comes up
    /// with no window at all.
    static let newWindowMenuTitle = "New Window"
}

/// Two things only AppKit can tell us: the app finished launching, and the app
/// is about to quit.
///
/// Both are the updater's. Launch starts the ten-minute poll; termination is the
/// moment a staged update can be swapped in without interrupting anyone, which
/// is the whole reason the updater does not restart the app on its own.
private final class JunoDesktopAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            DispatchQueue.main.async { Self.presentMainWindowIfWithheld() }
            #if DEBUG
            if JunoPreviewEnvironment.isActive {
                // The harness never polls, downloads or stages anything. It only
                // seeds the phase the footer card draws, so that card can be
                // looked at in both appearances instead of reasoned about — the
                // flag and the seeding method both already existed and had
                // nothing joining them, which meant the one state this view has
                // was unreachable in visual QA.
                if JunoPreviewEnvironment.updateReady {
                    DesktopUpdateModel.shared.setPreviewReady(version: "0.1.12")
                }
                return
            }
            #endif
            DesktopUpdateModel.shared.start()
            // ⌥Space from anywhere. Installed at launch rather than on first
            // use so the shortcut exists before any window does.
            DesktopQuickEntryController.shared.installHotkey()
        }
    }

    /// Opens the main window when SwiftUI declined to.
    ///
    /// AppKit hands every bare command-line token it cannot read as a `-key
    /// value` default to the app as a document to open — `code` in
    /// `--juno-ui-preview --juno-preview-tab code`, or any file dropped on the
    /// icon. Juno has no document type, and on macOS 27 an open request at
    /// launch is enough for SwiftUI to withhold the default `WindowGroup`: the
    /// app came up with a menu bar, a status item and no window. Neither
    /// answering the request from the delegate, claiming it with
    /// `handlesExternalEvents`, nor `defaultLaunchBehavior(.presented)` changed
    /// that; the one thing that does is the same action the reader has — File ›
    /// New Window, which `JunoDesktopCommands` offers exactly while no window
    /// is focused. Invoked once, a turn after launch, and only when no main
    /// window exists, so an ordinary launch is untouched.
    @MainActor
    private static func presentMainWindowIfWithheld() {
        let hasMainWindow = NSApp.windows.contains {
            $0.identifier?.rawValue.hasPrefix(JunoDesktopWindow.mainID) == true
        }
        guard !hasMainWindow,
            let item = NSApp.mainMenu?.items
                .compactMap(\.submenu)
                .flatMap(\.items)
                .first(where: { $0.title == JunoDesktopWindow.newWindowMenuTitle }),
            let action = item.action
        else { return }
        NSApp.sendAction(action, to: item.target, from: item)
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            DesktopUpdateModel.shared.installOnQuitIfStaged()
        }
    }
}

@main
struct JunoDesktopApp: App {
    @NSApplicationDelegateAdaptor(JunoDesktopAppDelegate.self) private var appDelegate

    /// `nil` only under the DEBUG preview harness, which supplies its own
    /// throwaway world and must never touch the account's real data.
    ///
    /// This used to be non-optional and built in `init()` unconditionally, so a
    /// `--juno-ui-preview` launch opened the production encrypted store — and
    /// therefore prompted for the account's Keychain encryption key — before
    /// discarding the whole configuration in favour of `PreviewWorld`. On a build
    /// whose signature differs from the one that created the Keychain item, that
    /// prompt is modal and unanswerable by automation, which is what made visual
    /// QA and the UI suite intermittently impossible to run. A QA harness has no
    /// business holding production credentials it does not use.
    @State private var configuration: JunoDesktopConfiguration?

    init() {
        // Split by `#if` rather than by a ternary on a compile-time-constant
        // flag: in Stable and Next the flag is `false`, so the preview branch is
        // statically dead and the compiler rejects it under warnings-as-errors.
        #if DEBUG
        _configuration = State(
            initialValue: JunoPreviewEnvironment.isActive
                ? nil
                : JunoDesktopConfiguration.live()
        )
        #else
        _configuration = State(initialValue: JunoDesktopConfiguration.live())
        #endif
    }

    var body: some Scene {
        WindowGroup(id: JunoDesktopWindow.mainID) {
            #if DEBUG
            if JunoPreviewEnvironment.isActive {
                JunoDesktopPreviewRoot()
                    .frame(minWidth: 900, minHeight: 620)
                    .junoPreviewAppearance()
            } else {
                liveRoot
            }
            #else
            liveRoot
            #endif
        }
        .defaultSize(width: 1240, height: 800)
        .windowResizability(.contentMinSize)
        .windowStyle(.hiddenTitleBar)
        // `.unified`, not `.unifiedCompact`.
        //
        // `.unifiedCompact` is AppKit's *compact* titlebar mode: it shortens the
        // titlebar and draws every toolbar control at the small metric. That is
        // the whole reason the toolbar actions read as undersized — the compose
        // and overflow buttons came out around 22pt in a 1512pt-wide window,
        // against the ~30pt that Mail, Notes and Xcode land on.
        //
        // It is worth recording what does NOT fix this, because both look like
        // they should and neither moves a pixel. `.controlSize(.large)` on the
        // view carrying `.toolbar { … }` does nothing: toolbar item content is
        // hosted by `NSToolbar` in a hierarchy that is a sibling of the content
        // view, so the content view's environment never reaches it. Putting
        // `.controlSize` / `.imageScale` on the `Button` inside the
        // `ToolbarItem` does nothing either — under Liquid Glass the system owns
        // the toolbar control metric, and the window's toolbar style is the only
        // thing that sets it. Both were built, run and screenshotted before
        // landing here.
        //
        // Compact is the right choice for a utility window with one or two
        // actions. This window is the product's primary surface and carries a
        // search field, so it takes the standard metric.
        .windowToolbarStyle(.unified)
        .windowBackgroundDragBehavior(.enabled)
        .commands {
            JunoDesktopCommands()
        }

        // A real, independently resizable development preview. The scene lives
        // in `JunoCodeUI`; registering it here is what makes the session
        // toolbar's Preview action open a window rather than a decorative
        // control. Each window owns the dev-server process it starts and tears
        // that process down when it closes.
        CodePreviewScene()

        // ⇧⌘N, as in every browser's private window. `Window` rather than
        // `WindowGroup`: two incognito windows would be two separate untracked
        // conversations with one menu item to reach them, and no way to tell
        // which is which.
        Window("Incognito", id: JunoDesktopWindow.incognitoID) {
            if let configuration {
                DesktopIncognitoWindow(configuration: configuration)
                    .frame(minWidth: 560, minHeight: 480)
            }
        }
        .defaultSize(width: 720, height: 720)

        // A `Settings` scene is what puts Juno's settings behind ⌘, and under the
        // application menu, where a Mac user looks for them. Reaching settings
        // only by clicking an account row in the sidebar meant ⌘, did nothing —
        // and left the settings pane unreachable from a window showing Code.
        // The Settings window: General, Code, Usage, Connections. The account's
        // pages live here rather than in a product's navigation column, so
        // opening Usage never replaces the surface the reader was working in.
        Settings {
            DesktopSettingsWindow(configuration: configuration)
                .junoAccountAppearance(configuration)
        }

        Window("Keyboard Shortcuts", id: JunoDesktopWindow.shortcutsID) {
            DesktopShortcutsWindow()
        }
        .defaultSize(width: 640, height: 720)
        .windowResizability(.contentSize)

        // The menu bar item: live sessions, New task, Ask Juno. Read off the
        // shared registry, so it is right with no window open.
        MenuBarExtra {
            DesktopMenuBarExtraContent()
        } label: {
            DesktopMenuBarExtraLabel()
        }
    }

    @ViewBuilder
    private var liveRoot: some View {
        if let configuration {
            JunoDesktopRootView(configuration: configuration)
                .frame(minWidth: 900, minHeight: 620)
        } else {
            // Unreachable outside the preview harness: `configuration` is only
            // nil when the preview branch above is taken.
            JunoEmptyState(
                title: "Juno could not start",
                message: "The application runtime was not composed.",
                icon: .error
            )
        }
    }
}

// `JunoDesktopCommands` and the focused-value plumbing it reads live in
// DesktopCommands.swift.

private extension View {
    /// The account's stored theme and accent, applied to a window that is not
    /// the workspace.
    ///
    /// These modifiers lived only on `JunoDesktopRootView`, so choosing Dark or
    /// switching accent in the ⌘, window restyled every window *except the one
    /// the choice was made in* — the single most confusing possible outcome for a
    /// control whose entire job is to change how things look.
    func junoAccountAppearance(_ configuration: JunoDesktopConfiguration?) -> some View {
        let settings = configuration?.memorySettingsModel?.settings
        let scheme: ColorScheme? =
            switch settings?.theme {
            case .light: .light
            case .dark: .dark
            case .system, .none: nil
            }
        return preferredColorScheme(scheme)
            .onChange(of: settings?.accent) { _, accent in
                JunoAccentSelection.shared.apply(setting: accent)
            }
    }
}
