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

    private static func value(for flag: String, env: String) -> String? {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: flag), index + 1 < arguments.count {
            return arguments[index + 1]
        }
        return ProcessInfo.processInfo.environment[env]
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
        DispatchQueue.main.async { [weak view] in
            guard let window = view?.window else { return }
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
