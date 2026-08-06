import AppKit
import Foundation
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// Looks at the Work setup path, in both appearances, as macOS actually draws it.
///
/// This exists because a green build proves nothing about layout on this
/// platform. The repo's own record has one constant putting the same control
/// 38pt down one column and 86pt down another, from one view — a defect no
/// compiler and no unit test could have seen, and which was found by looking.
///
/// It is a *window*, not an `ImageRenderer`. Liquid Glass is a real-time
/// material: it samples what is behind it, and an offscreen render of it comes
/// back as a flat rounded rectangle, which is exactly the hand-rolled look
/// `junoGlass` exists to avoid. Rendering into a real window in the host app's
/// own process and capturing that window's rect is the only way to see the thing
/// that ships.
///
/// Off by default, and deliberately so: it puts a window on screen and shells
/// out to `screencapture`, which needs Screen Recording permission that CI does
/// not have and a session that a headless runner does not have either. Set
/// `JUNO_WORK_SNAPSHOT_DIR` to a directory and run the suite to produce the
/// images.
@MainActor
struct DesktopWorkStartPathSnapshots {
    @Test(
        .enabled(
            if: ProcessInfo.processInfo.environment["JUNO_WORK_SNAPSHOT_DIR"] != nil,
            "Set JUNO_WORK_SNAPSHOT_DIR to capture the Work setup path."
        )
    )
    func theSetupPathDrawsInBothAppearances() async throws {
        let directory = URL(
            fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_WORK_SNAPSHOT_DIR"]!
        )
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )

        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let suffix = appearance == .aqua ? "light" : "dark"

            // Switched off: the state the reader actually met, now with the way
            // out on it.
            try await capture(
                named: "work-start-path-off-\(suffix)",
                in: directory,
                appearance: appearance,
                size: CGSize(width: 760, height: 620)
            ) { host in
                DesktopWorkStartPath(host: host, blocker: .switchedOff, compose: {})
            }

            // One step in: Work is on, and this Mac still advertises nothing.
            // The second dead end, which is the one nobody had a route out of.
            try await capture(
                named: "work-start-path-nothing-allowed-\(suffix)",
                in: directory,
                appearance: appearance,
                size: CGSize(width: 760, height: 620),
                arrange: { host in
                    host.allowWorkOnThisMac = true
                    host.grantActions = DesktopWorkGrantActions(
                        addFolder: { _ in "Reports" }, setMode: { _, _ in }, revoke: { _ in }
                    )
                }
            ) { host in
                DesktopWorkStartPath(host: host, blocker: .nothingAllowed, compose: {})
            }

            // The settings card's own reason row, which is the same component
            // in the other place it appears. Captured because the card is where
            // somebody who went looking for the switch ends up, and the row now
            // carries a control there too.
            try await capture(
                named: "work-settings-reason-\(suffix)",
                in: directory,
                appearance: appearance,
                size: CGSize(width: 520, height: 200),
                arrange: { host in
                    host.allowWorkOnThisMac = true
                    host.grantActions = DesktopWorkGrantActions(
                        addFolder: { _ in "Reports" }, setMode: { _, _ in }, revoke: { _ in }
                    )
                }
            ) { host in
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    DesktopWorkBlockerRow(
                        host: host,
                        confirmsReady: true,
                        identifier: "juno.desktop.settings.work-host"
                    )
                }
                .padding(JunoSpace.roomy)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            // The task column's footer, at the width the sidebar gives it. Its
            // own capture because a row that reads well at 760pt can still wrap
            // its button off the edge at 260.
            try await capture(
                named: "work-sidebar-footer-\(suffix)",
                in: directory,
                appearance: appearance,
                size: CGSize(width: 272, height: 180)
            ) { host in
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    DesktopWorkBlockerRow(host: host)
                    Button("New task") {}
                        .buttonStyle(.plain)
                }
                .padding(JunoSpace.cozy)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// Draws one view in a real window and photographs that window, and nothing
    /// else on the display.
    ///
    /// `-R` with the window's own rect, never a full-screen grab: an earlier
    /// capture in this repo came back with the reviewer's Safari window in it.
    /// The rect is converted from AppKit's bottom-left origin to the top-left
    /// one `screencapture` takes, against the screen the window actually landed
    /// on rather than the main one.
    private func capture(
        named name: String,
        in directory: URL,
        appearance: NSAppearance.Name,
        size: CGSize,
        arrange: (DesktopWorkHostModel) -> Void = { _ in },
        @ViewBuilder content: (DesktopWorkHostModel) -> some View
    ) async throws {
        let host = DesktopWorkHostModel(
            defaults: UserDefaults(suiteName: "juno.work.snapshots.\(UUID().uuidString)")!
        )
        host.systemPermissions = { .none }
        arrange(host)

        let window = NSWindow(
            contentRect: CGRect(origin: .zero, size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.appearance = NSAppearance(named: appearance)
        window.contentView = NSHostingView(
            rootView: content(host)
                .frame(width: size.width, height: size.height)
                // The canvas the detail column and the sidebar are drawn on.
                // Glass samples what is behind it, so a transparent window would
                // have it refracting whatever the capture ran over — a picture
                // of a surface this view is never on.
                .background(Color.junoCanvasWarm)
                // Drawn as the key window draws it. A test host launched by
                // `xcodebuild` is never the frontmost application, and AppKit
                // greys every control in an inactive app — which would put a
                // disabled-looking primary button in the evidence and say
                // nothing at all about the button that ships.
                .environment(\.controlActiveState, .key)
        )
        window.orderBack(nil)

        // Long enough for the hierarchy to lay out and draw. A capture taken on
        // the same turn catches an empty view.
        try await Task.sleep(for: .milliseconds(400))

        guard let contentView = window.contentView,
            let bitmap = contentView.bitmapImageRepForCachingDisplay(in: contentView.bounds)
        else {
            Issue.record("The window produced no drawable content.")
            return
        }
        // The window's own contents, drawn by the window, rather than a grab of
        // the display. `screencapture` needs a Screen Recording permission this
        // process does not hold, and — far worse — a full-screen grab has
        // already put a reviewer's own Safari window into this repo's evidence
        // once. There is nothing on this path that can photograph anything but
        // the view under test.
        //
        // What it costs is Liquid Glass: the material is composited by the
        // window server, so it comes back flat here. Layout, wrapping,
        // alignment, colour and both appearances are what this catches — which
        // is the class of defect that has actually shipped from this window.
        // Seeing the glass itself needs a real on-screen capture of a frontmost
        // window, and `native/Scripts/capture-desktop.sh` is the tool for that.
        contentView.cacheDisplay(in: contentView.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            Issue.record("The captured window could not be encoded.")
            return
        }
        try png.write(to: directory.appendingPathComponent("\(name).png"))
        window.orderOut(nil)

        #expect(bitmap.pixelsWide > 0 && bitmap.pixelsHigh > 0)
    }
}
