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

    /// Optional starting destination (a section rawValue) from
    /// `--juno-preview-tab <name>` or `JUNO_PREVIEW_TAB`.
    public static var initialDestination: String? {
        value(for: "--juno-preview-tab", env: "JUNO_PREVIEW_TAB")
    }

    private static func value(for flag: String, env: String) -> String? {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: flag), index + 1 < arguments.count {
            return arguments[index + 1]
        }
        return ProcessInfo.processInfo.environment[env]
    }
}

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
        .onAppear { if world == nil { world = try? PreviewWorld(scenario: scenario) } }
        .onChange(of: scenario) { _, newValue in
            world = try? PreviewWorld(scenario: newValue)
        }
    }
}
#endif
