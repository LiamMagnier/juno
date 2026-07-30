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
            #if DEBUG
            guard !JunoPreviewEnvironment.isActive else { return }
            #endif
            DesktopUpdateModel.shared.start()
        }
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
        Settings {
            JunoDesktopSettingsScene(configuration: configuration)
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
            ContentUnavailableView(
                "Juno could not start",
                systemImage: "exclamationmark.triangle",
                description: Text("The application runtime was not composed.")
            )
        }
    }
}

// `JunoDesktopCommands` and the focused-value plumbing it reads live in
// DesktopCommands.swift.

/// Hosts the settings pane in the `Settings` scene.
///
/// Settings are account data, so they need a signed-in session and the
/// synchronized settings model. When neither exists there is genuinely nothing to
/// configure, and saying so is better than presenting controls whose writes would
/// be discarded.
private struct JunoDesktopSettingsScene: View {
    let configuration: JunoDesktopConfiguration?

    var body: some View {
        Group {
            if let configuration,
                let settingsModel = configuration.memorySettingsModel,
                case .signedIn(let session) = configuration.authModel.phase
            {
                DesktopSettingsScreen(
                    model: settingsModel,
                    authModel: configuration.authModel,
                    session: session,
                    accountDataClient: configuration.accountDataClient,
                    shareClient: configuration.shareClient
                )
            } else {
                ContentUnavailableView(
                    "Sign in to change settings",
                    systemImage: "person.crop.circle",
                    description: Text(
                        "Juno's settings belong to your account and sync across your devices."
                    )
                )
            }
        }
        .frame(minWidth: 520, minHeight: 460)
    }
}
