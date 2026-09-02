#if DEBUG
import SwiftUI

/// Detects the development-only UI Preview activation. Because this whole file
/// is behind `#if DEBUG`, the symbol does not exist in Stable/Release builds —
/// the mode is impossible to activate there.
public enum JunoPreviewEnvironment {
    /// True only when launched with `--juno-ui-preview` (or `JUNO_UI_PREVIEW=1`).
    public static var isActive: Bool {
        CommandLine.arguments.contains("--juno-ui-preview")
            || ProcessInfo.processInfo.environment["JUNO_UI_PREVIEW"] == "1"
    }

    /// Optional starting scenario from `--juno-preview-scenario <name>` or the
    /// `JUNO_PREVIEW_SCENARIO` env var, so any state can be screenshotted by
    /// relaunching without tapping through the UI.
    public static var initialScenario: PreviewScenario {
        if let raw = value(for: "--juno-preview-scenario", env: "JUNO_PREVIEW_SCENARIO"),
            let scenario = PreviewScenario(rawValue: raw) {
            return scenario
        }
        return .normal
    }

    /// Shows the real desktop profile-footer update card in its staged state.
    /// This is a visual-QA switch only; it never changes the preview account or
    /// the production updater's network behavior.
    public static var updateReady: Bool {
        CommandLine.arguments.contains("--juno-preview-update-ready")
            || ProcessInfo.processInfo.environment["JUNO_PREVIEW_UPDATE_READY"] == "1"
    }

    /// Optional starting destination (a section rawValue) from
    /// `--juno-preview-tab <name>` or `JUNO_PREVIEW_TAB`.
    public static var initialDestination: String? {
        value(for: "--juno-preview-tab", env: "JUNO_PREVIEW_TAB")
    }

    /// Lands Juno Work on its overview instead of on an open task.
    ///
    /// `--juno-preview-tab work` opens the densest thread in the product, which
    /// is the right default and also means Work's *home* — the page that answers
    /// "what is waiting on me" before any task is picked — had no launch of its
    /// own. Nothing in the window clears a selection either, so the one surface
    /// a reader meets first was the one surface a screenshot could not reach.
    public static var opensWorkOverview: Bool {
        CommandLine.arguments.contains("--juno-preview-work-overview")
            || ProcessInfo.processInfo.environment["JUNO_PREVIEW_WORK_OVERVIEW"] == "1"
    }

    /// Opens one Juno Code session's log, from `--juno-preview-code-session <id>`
    /// or `JUNO_PREVIEW_CODE_SESSION`.
    ///
    /// Code's four interesting states — a run in flight, a run blocked on an
    /// approval, a finished run with a diff, a run that failed — all live behind
    /// a row tap, and the session list looks the same from outside whichever one
    /// you are after. See ``PreviewCodeFixtures`` for the ids.
    public static var initialCodeSession: String? {
        value(for: "--juno-preview-code-session", env: "JUNO_PREVIEW_CODE_SESSION")
    }

    /// Opens one **remote** Code session's thread, from
    /// `--juno-preview-code-remote-session <id>` or
    /// `JUNO_PREVIEW_CODE_REMOTE_SESSION`. See ``PreviewCodeRemoteFixtures``
    /// for the ids.
    public static var initialCodeRemoteSession: String? {
        value(for: "--juno-preview-code-remote-session", env: "JUNO_PREVIEW_CODE_REMOTE_SESSION")
    }

    /// Opens the phone's full-screen voice mode over the fixture call, from
    /// `--juno-preview-voice-fullscreen` or `JUNO_PREVIEW_VOICE_FULLSCREEN=1`.
    public static var opensVoiceFullScreen: Bool {
        CommandLine.arguments.contains("--juno-preview-voice-fullscreen")
            || ProcessInfo.processInfo.environment["JUNO_PREVIEW_VOICE_FULLSCREEN"] == "1"
    }

    /// Renders the signed-out onboarding instead of the fixture account, from
    /// `--juno-preview-signed-out` or `JUNO_PREVIEW_SIGNED_OUT=1`. The
    /// sign-in screen is otherwise unreachable in the harness, which always
    /// carries a session.
    public static var signedOut: Bool {
        CommandLine.arguments.contains("--juno-preview-signed-out")
            || ProcessInfo.processInfo.environment["JUNO_PREVIEW_SIGNED_OUT"] == "1"
    }

    /// Opens Settings on one of its pages, from `--juno-preview-settings-route
    /// <name>` or `JUNO_PREVIEW_SETTINGS_ROUTE` — `voice`, `archived`,
    /// `notifications`, `code`, `appearance`, …
    public static var initialSettingsRoute: String? {
        value(for: "--juno-preview-settings-route", env: "JUNO_PREVIEW_SETTINGS_ROUTE")
    }

    /// Opens the densest Work thread directly on its Files & cost surface.
    /// This keeps artifact/version QA deterministic and avoids relying on
    /// screen-coordinate automation against a resizable macOS window.
    public static var opensWorkFiles: Bool {
        CommandLine.arguments.contains("--juno-preview-work-files")
            || ProcessInfo.processInfo.environment["JUNO_PREVIEW_WORK_FILES"] == "1"
    }

    /// Optional accent override from `--juno-preview-accent <name>` or
    /// `JUNO_PREVIEW_ACCENT`, so each of the five accents can be screenshotted by
    /// relaunching instead of tapping into Settings and back out.
    ///
    /// The accent is an account setting, and the fixture account has exactly one —
    /// which meant four of the five palettes had no reachable state to inspect.
    public static var initialAccent: String? {
        value(for: "--juno-preview-accent", env: "JUNO_PREVIEW_ACCENT")
    }

    /// Optional fixed window size from `--juno-preview-size <width>x<height>` or
    /// `JUNO_PREVIEW_SIZE`.
    ///
    /// Responsive QA needs the *same* window at a known size on every run.
    /// Resizing the window from outside needs Accessibility permission the
    /// capture shell does not always have, and `defaultSize` loses to AppKit's
    /// restored state. Pinning the size from inside the preview is the only
    /// method that is reproducible without granting the automation a way to
    /// drive arbitrary applications.
    public static var windowSize: CGSize? {
        guard let raw = value(for: "--juno-preview-size", env: "JUNO_PREVIEW_SIZE") else {
            return nil
        }
        let parts = raw.lowercased().split(separator: "x")
        guard parts.count == 2,
              let width = Double(parts[0]), let height = Double(parts[1]),
              width > 0, height > 0
        else { return nil }
        return CGSize(width: width, height: height)
    }

    /// Optional appearance override from `--juno-preview-appearance light|dark` or
    /// `JUNO_PREVIEW_APPEARANCE`.
    ///
    /// Light and dark are a stated design requirement, but there was no way to
    /// capture dark from outside the app: appearance is either the account's theme
    /// setting — which the fixture account has one value for — or the system's,
    /// and flipping the system appearance to take a screenshot changes every other
    /// window on the reviewer's Mac. Neither is reproducible in a capture script,
    /// which is why dark had never actually been inspected.
    public static var appearance: PreviewAppearance? {
        guard let raw = value(
            for: "--juno-preview-appearance", env: "JUNO_PREVIEW_APPEARANCE"
        ) else { return nil }
        return PreviewAppearance(rawValue: raw.lowercased())
    }

    private static func value(for flag: String, env: String) -> String? {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: flag), index + 1 < arguments.count {
            return arguments[index + 1]
        }
        return ProcessInfo.processInfo.environment[env]
    }
}

/// The appearance a preview launch is pinned to.
public enum PreviewAppearance: String, Sendable, CaseIterable {
    case light
    case dark

    public var colorScheme: ColorScheme {
        switch self {
        case .light: .light
        case .dark: .dark
        }
    }
}

public extension View {
    /// Pins the preview to `--juno-preview-appearance` when one is given, and
    /// otherwise follows the account theme and the system as normal.
    func junoPreviewAppearance() -> some View {
        preferredColorScheme(JunoPreviewEnvironment.appearance?.colorScheme)
    }
}

public extension View {
    /// Pins the preview window to `--juno-preview-size WxH` when one is given,
    /// and otherwise leaves sizing alone.
    ///
    /// This sets the size on the `NSWindow` rather than wrapping the content in
    /// a fixed `.frame`. A fixed frame does not decide how large SwiftUI makes
    /// the window: with `.frame(width: 1000, height: 700)` the window still
    /// opened at the split view's own ideal (1180×760), so every "responsive"
    /// capture in an earlier pass was silently taken at the same size.
    func junoPreviewWindowSize() -> some View {
        modifier(JunoPreviewWindowSize())
    }
}

private struct JunoPreviewWindowSize: ViewModifier {
    func body(content: Content) -> some View {
        #if canImport(AppKit)
        content.background(JunoWindowSizer(size: JunoPreviewEnvironment.windowSize))
        #else
        content
        #endif
    }
}

#if canImport(AppKit)
import AppKit

/// Reaches the hosting `NSWindow` and sets its content size once.
private struct JunoWindowSizer: NSViewRepresentable {
    let size: CGSize?

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        guard let size else { return view }
        // JunoDesktop's scene already declares this exact default. Reapplying
        // it after a window containing NavigationSplitView has entered its
        // first layout pass is both redundant and, on macOS 27, capable of
        // raising AppKit's update-constraints exception. Non-default responsive
        // captures still take the controlled resize path below.
        guard abs(size.width - 1_240) >= 1 || abs(size.height - 800) >= 1 else {
            return view
        }
        DispatchQueue.main.async { [weak view] in
            guard let window = view?.window else { return }
            // `setContentSize(_:)` is not an idempotent no-op in AppKit. Even
            // when the window already has the requested size it posts another
            // constraint update through every hosting view. A dense split-view
            // preview can still be inside its first constraint pass here, and
            // posting the redundant update re-enters AppKit's display cycle and
            // aborts with `_postWindowNeedsUpdateConstraints`. Most captures use
            // the scene's 1240x800 default, so avoid touching the window at all
            // when it is already within a pixel of the requested content size.
            if let current = window.contentView?.bounds.size,
                abs(current.width - size.width) < 1,
                abs(current.height - size.height) < 1
            {
                return
            }
            // The content minimum has to come down too, or a window whose
            // content declares `minWidth: 900` refuses anything narrower.
            window.contentMinSize = CGSize(
                width: min(window.contentMinSize.width, size.width),
                height: min(window.contentMinSize.height, size.height)
            )
            window.setContentSize(size)
            window.center()
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}
#endif

/// Hosts the real authenticated screens over a ``PreviewWorld``. The world is
/// rebuilt from fresh in-memory fixtures whenever the scenario changes. There is
/// deliberately **no floating chrome**: the "Preview" indicator lives inside the
/// app's own UI (e.g. the sidebar footer) so nothing ever overlays real
/// navigation, and scenarios are selected by relaunching with
/// `--juno-preview-scenario <name>`.
public struct JunoPreviewContainer<Content: View>: View {
    @State private var scenario: PreviewScenario
    @State private var world: PreviewWorld?
    private let content: (PreviewWorld) -> Content

    public init(
        initialScenario: PreviewScenario = .normal,
        @ViewBuilder content: @escaping (PreviewWorld) -> Content
    ) {
        _scenario = State(initialValue: initialScenario)
        self.content = content
    }

    public var body: some View {
        Group {
            if let world {
                content(world)
                    .id(world.scenario)
                    .task(id: world.scenario) { await world.activate() }
            } else {
                ProgressView("Building preview…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .junoPreviewWindowSize()
        .onAppear { if world == nil { world = try? PreviewWorld(scenario: scenario) } }
        .onChange(of: scenario) { _, newValue in
            world = try? PreviewWorld(scenario: newValue)
        }
    }
}
#endif
