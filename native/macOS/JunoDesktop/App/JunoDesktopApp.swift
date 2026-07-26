import JunoDesignSystem
import SwiftUI
#if DEBUG
import JunoPreviewSupport
#endif

@main
struct JunoDesktopApp: App {
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
        WindowGroup {
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
                    accountDataClient: configuration.accountDataClient
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
