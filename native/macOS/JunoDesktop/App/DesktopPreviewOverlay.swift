import Foundation
import SwiftUI
#if DEBUG
import JunoPreviewSupport
#endif

/// Presents one overlay class from a launch argument, for visual QA.
///
/// **Why this exists.** `JunoOverlays.swift` states the app's overlay contract —
/// what the system draws, what the app must add, and what it must never add. The
/// contract was written and applied to ten macOS presentations, and then not one
/// of them was ever looked at, because every overlay in this app needs a click to
/// appear: a sheet opens from a toolbar button, an alert from a row's context
/// menu, a popover from the composer. The capture harness launches the app and
/// photographs the window; it cannot click. So "the sheet paints a warm ground
/// under the system's platter" was a claim in a comment with no picture behind it.
///
/// This is the missing switch, and the rest of the harness is exactly this shape:
/// `--juno-preview-tab` picks a destination, `--juno-preview-appearance` picks
/// light or dark, and each one exists because a state that needed looking at was
/// otherwise only reachable by hand.
///
/// **What it does not do.** It presents the app's *real* overlays from their own
/// state — the same `.sheet`, `.alert`, `.confirmationDialog` and `.popover` the
/// reader gets — rather than a gallery of mock-ups. A mock-up would prove nothing
/// about the contract, because the contract is about how a production surface
/// meets the system's platter.
///
/// Usage:
///
///     --juno-ui-preview --juno-preview-tab projects --juno-preview-overlay sheet
///     --juno-ui-preview --juno-preview-tab projects --juno-preview-overlay alert
///     --juno-ui-preview --juno-preview-tab projects --juno-preview-overlay confirm
///     --juno-ui-preview --juno-preview-tab settings --juno-preview-overlay sheet
///     --juno-ui-preview --juno-preview-tab chat   --juno-preview-overlay popover
///     --juno-ui-preview --juno-preview-tab chat   --juno-preview-overlay add-menu
///
/// DEBUG-only in substance: in a Stable build ``View/desktopPreviewOverlays``
/// compiles down to the view it was applied to, and the enum below does not
/// exist at all, so the mode cannot be activated in a shipped app.
#if DEBUG
enum DesktopPreviewOverlay: String, CaseIterable {
    /// The destination's own primary sheet.
    case sheet
    /// An `.alert` carrying a text field — the rename dialog.
    case alert
    /// A `.confirmationDialog` with a destructive role — delete.
    case confirm
    /// A `.popover` anchored to a composer control — the model selector.
    case popover
    /// The composer's "+" menu, which is the other popover anchored to that same
    /// strip and the one with rows, groups, state and two drawers in it. It was
    /// rebuilt against the design system's own tokens without anybody being able
    /// to photograph it, which is the exact gap this file was written to close.
    case addMenu = "add-menu"

    /// The overlay `--juno-preview-overlay <name>` asks for, if any.
    ///
    /// Read from the arguments on each access rather than held in a model: the
    /// harness relaunches for every capture, which is what makes each picture
    /// reproducible, and there is no state here worth keeping between launches.
    static var requested: DesktopPreviewOverlay? {
        guard JunoPreviewEnvironment.isActive else { return nil }
        let arguments = CommandLine.arguments
        let raw: String?
        if let index = arguments.firstIndex(of: "--juno-preview-overlay"),
            index + 1 < arguments.count {
            raw = arguments[index + 1]
        } else {
            raw = ProcessInfo.processInfo.environment["JUNO_PREVIEW_OVERLAY"]
        }
        return raw.flatMap(DesktopPreviewOverlay.init(rawValue:))
    }
}
#endif

extension View {
    /// Presents whichever of this screen's overlays the launch asked for.
    ///
    /// A screen passes only the classes it actually owns; the Projects index owns
    /// a sheet, an alert and a confirmation dialog, Settings owns a sheet, and
    /// Chat owns the composer popover. Passing `nil` for a class means "this
    /// screen has none", which is why the argument for it is simply omitted at
    /// the call site rather than being a closure that does nothing.
    ///
    /// **The delay is not superstition.** A presentation attached to a view that
    /// is still being built is dropped on macOS, and an `NSPopover` in particular
    /// dismisses itself when its anchor is rebuilt — which the preview world does
    /// several times as its observable models activate.
    /// ``JunoDesktopPreviewRoot`` already documents that race for the model
    /// selector and works around it by not using a popover at all. Waiting for
    /// the world to settle is the version of that workaround which still
    /// exercises the real presentation.
    func desktopPreviewOverlays(
        sheet: (() -> Void)? = nil,
        alert: (() -> Void)? = nil,
        confirm: (() -> Void)? = nil,
        popover: (() -> Void)? = nil,
        addMenu: (() -> Void)? = nil
    ) -> some View {
        #if DEBUG
        return task {
            guard let requested = DesktopPreviewOverlay.requested else { return }
            let present: (() -> Void)?
            switch requested {
            case .sheet: present = sheet
            case .alert: present = alert
            case .confirm: present = confirm
            case .popover: present = popover
            case .addMenu: present = addMenu
            }
            guard let present else { return }
            try? await Task.sleep(for: .milliseconds(1200))
            present()
        }
        #else
        return self
        #endif
    }
}
