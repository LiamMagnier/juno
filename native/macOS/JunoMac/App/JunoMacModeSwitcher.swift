import AppKit
import JunoDesignSystem
import SwiftUI

/// The Chat / Code switch at the top of the sidebar.
///
/// **Why this hosts `NSSegmentedControl` rather than a SwiftUI `Picker`.**
///
/// The requirement is two *equal-width* segments spanning the sidebar. Both
/// SwiftUI picker styles were built and measured against that, and neither does
/// it on macOS:
///
/// - `.pickerStyle(.tabs)` — `SwiftUI.TabsPickerStyle`, new in the macOS 27 SDK
///   and the closest thing to an explicit tab control. It centres its tabs and
///   sizes to content by design; a width frame gives it a wider box and the
///   control stays the same small pill in the middle of it.
/// - `.pickerStyle(.segmented)` — same outcome. Unlike iOS, a macOS segmented
///   picker has an intrinsic width, and `.frame(maxWidth: .infinity)` only
///   enlarges the box it is centred in.
///
/// `NSSegmentedControl` is the AppKit control both styles are built on, and it
/// exposes `segmentDistribution`, which is the actual API for this layout.
/// Hosting it is the opposite of hand-rolling: it *is* the system's segmented
/// control, so the material (Liquid Glass on macOS 26+ via `.automatic` — the
/// system picks the era-appropriate treatment, nothing is faked), the hover and
/// pressed states, the focus ring, Full Keyboard Access and the VoiceOver tab
/// semantics all come from AppKit rather than from us.
///
/// A `TabView` was considered and rejected on architecture rather than looks: a
/// `TabView` owns the content it switches, whereas each Juno mode owns a whole
/// `NavigationSplitView` including its own sidebar. This control selects between
/// two entire window layouts, which is a selection control's job.
struct JunoMacModeSwitcher: View {
    @Binding var mode: JunoMacProductMode

    var body: some View {
        // No band, no divider, no background. The rejected build wrapped this
        // in a `.bar` strip with a rule under it, which made the switch read as
        // something bolted above the sidebar. It now sits directly on the
        // sidebar material inside the header region, on the same horizontal
        // grid as the rows below it.
        JunoMacSegmentedModeControl(mode: $mode)
            .frame(height: 22)
            .accessibilityIdentifier("juno.mac.mode-switcher")
    }
}

/// Thin host for the system segmented control.
private struct JunoMacSegmentedModeControl: NSViewRepresentable {
    @Binding var mode: JunoMacProductMode

    func makeNSView(context: Context) -> NSSegmentedControl {
        let control = NSSegmentedControl()
        control.segmentCount = JunoMacProductMode.allCases.count
        control.trackingMode = .selectOne
        // The reason this type exists: equal shares of the available width.
        control.segmentDistribution = .fillEqually
        control.segmentStyle = .automatic
        control.controlSize = .small
        control.target = context.coordinator
        control.action = #selector(Coordinator.selectionChanged(_:))
        // Let the control take the width the sidebar offers instead of hugging
        // its labels, and let it shrink rather than overflow a narrow sidebar.
        control.setContentHuggingPriority(.defaultLow, for: .horizontal)
        control.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        for (index, mode) in JunoMacProductMode.allCases.enumerated() {
            control.setLabel(mode.shortTitle, forSegment: index)
            // The symbol is supplementary; the label identifies the destination
            // and stays visible at every sidebar width.
            control.setImage(
                NSImage(
                    systemSymbolName: mode.systemImage,
                    accessibilityDescription: nil
                ),
                forSegment: index
            )
            control.setImageScaling(.scaleProportionallyDown, forSegment: index)
            // Width 0 means "no fixed width", which is what lets
            // `.fillEqually` divide the space evenly.
            control.setWidth(0, forSegment: index)
        }
        control.setAccessibilityLabel(String(localized: "mode.switcher.label"))
        control.setAccessibilityIdentifier("juno.mac.mode-control")
        return control
    }

    func updateNSView(_ control: NSSegmentedControl, context: Context) {
        context.coordinator.mode = $mode
        let index = JunoMacProductMode.allCases.firstIndex(of: mode) ?? 0
        if control.selectedSegment != index {
            control.selectedSegment = index
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(mode: $mode)
    }

    @MainActor
    final class Coordinator: NSObject {
        var mode: Binding<JunoMacProductMode>

        init(mode: Binding<JunoMacProductMode>) {
            self.mode = mode
        }

        @objc func selectionChanged(_ sender: NSSegmentedControl) {
            let cases = JunoMacProductMode.allCases
            guard cases.indices.contains(sender.selectedSegment) else { return }
            let selected = cases[sender.selectedSegment]
            guard selected != mode.wrappedValue else { return }
            mode.wrappedValue = selected
        }
    }
}
