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

/// Hosts the real authenticated screens over a ``PreviewWorld`` and adds a
/// discreet "UI Preview" badge plus a scenario switcher. Switching scenarios
/// rebuilds the world from fresh in-memory fixtures.
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
        ZStack(alignment: .bottomTrailing) {
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
            // A compact, movable dev control that stays clear of navigation
            // bars, tab bars and composers so it never masks real chrome.
            badge
                .padding(.trailing, 12)
                .padding(.bottom, bottomInset)
        }
        .onAppear { if world == nil { world = try? PreviewWorld(scenario: scenario) } }
        .onChange(of: scenario) { _, newValue in
            world = try? PreviewWorld(scenario: newValue)
        }
    }

    // Lift the badge clear of the tab bar / composer so it never overlaps them.
    private var bottomInset: CGFloat {
        #if os(iOS)
        return 150
        #else
        return 40
        #endif
    }

    /// A compact circular control so the dev overlay occupies the smallest
    /// possible footprint; the current scenario shows a checkmark in its menu.
    private var badge: some View {
        Menu {
            Section("UI Preview scenario") {
                Picker("Scenario", selection: $scenario) {
                    ForEach(PreviewScenario.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
            }
        } label: {
            Image(systemName: "eye.trianglebadge.exclamationmark.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.black)
                .frame(width: 34, height: 34)
                .background(.yellow.opacity(0.92), in: Circle())
                .shadow(radius: 4, y: 1)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel("UI Preview, scenario \(scenario.title)")
        .accessibilityIdentifier("juno.preview.badge")
    }
}
#endif
