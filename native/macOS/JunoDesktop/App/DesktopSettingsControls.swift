import AppKit
import JunoDesignSystem
import SwiftUI

/// A stepped slider with the system's tick marks under it: AppKit's own
/// `NSSlider`, because SwiftUI's `Slider` draws no ticks on macOS 26 even
/// when it is given a step, and a six-stop control without its stops reads
/// as continuous.
///
/// The value only ever lands on a tick (`allowsTickMarkValuesOnly`), the
/// track fills in the window's accent, and `committed` runs once the reader
/// lets go (or after a key press), which is when a row says "Saved".
struct DesktopTickSlider: NSViewRepresentable {
    @Binding var value: Int
    let steps: Int
    var accessibilityLabel: String
    var accessibilityValue: String
    var committed: () -> Void = {}

    @Environment(\.colorScheme) private var colorScheme

    func makeNSView(context: Context) -> NSSlider {
        let slider = NSSlider(
            value: Double(value),
            minValue: 0,
            maxValue: Double(max(steps - 1, 1)),
            target: context.coordinator,
            action: #selector(Coordinator.changed(_:))
        )
        slider.numberOfTickMarks = steps
        slider.allowsTickMarkValuesOnly = true
        slider.tickMarkPosition = .below
        slider.isContinuous = true
        slider.controlSize = .regular
        slider.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return slider
    }

    func updateNSView(_ slider: NSSlider, context: Context) {
        context.coordinator.parent = self
        if Int(slider.doubleValue.rounded()) != value { slider.integerValue = value }
        slider.trackFillColor = NSColor(Color.junoAccent)
        slider.setAccessibilityLabel(accessibilityLabel)
        slider.setAccessibilityValueDescription(accessibilityValue)
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject {
        var parent: DesktopTickSlider

        init(parent: DesktopTickSlider) {
            self.parent = parent
        }

        @objc func changed(_ sender: NSSlider) {
            let step = Int(sender.doubleValue.rounded())
            if step != parent.value { parent.value = step }
            // A drag reports every tick it crosses; the row's status waits
            // for the release. A key press is its own release.
            if NSApp.currentEvent?.type != .leftMouseDragged { parent.committed() }
        }
    }
}

// MARK: - Layout probe

#if DEBUG
/// Where a few landmark views landed, in their window's coordinates (top-left
/// origin), recorded in debug builds only so the chrome tests can prove a
/// pane's opening sits below the toolbar.
@MainActor
enum DesktopLayoutProbe {
    static var frames: [String: CGRect] = [:]
}

extension View {
    func desktopLayoutProbe(_ key: String) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
            DesktopLayoutProbe.frames[key] = frame
        }
    }
}
#else
extension View {
    func desktopLayoutProbe(_ key: String) -> some View { self }
}
#endif
