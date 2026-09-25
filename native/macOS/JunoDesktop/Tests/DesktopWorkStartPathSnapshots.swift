import AppKit
import Foundation
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// Looks at this Mac's Work setup, in both appearances, as macOS draws it:
/// the start path and the settings card's reason row, which moved into
/// `DesktopWorkSettings.swift` with the host tile when Phase 5 Stage D removed
/// the old Work window (track B takes them into Settings › Permissions). The
/// window's own column footer went with the window.
///
/// This exists because a green build proves nothing about layout on this
/// platform. The repo's own record has one constant putting the same control
/// 38pt down one column and 86pt down another, from one view — a defect no
/// compiler and no unit test could have seen, and which was found by looking.
///
/// Drawn by ``TranscriptSnapshotRenderer``: an `NSHostingView` in a window that
/// is never ordered in, photographed with `cacheDisplay`. This used to
/// `orderBack` a real window, which put it on screen during a test run; the
/// offscreen path draws the same layout, colour and wrapping without showing
/// anything. What neither can capture is Liquid Glass, which the window server
/// composites — `native/Scripts/capture-desktop.sh` is the tool for that.
///
/// Off by default. Set `JUNO_WORK_SNAPSHOT_DIR` to a directory and run the
/// suite to produce the images.
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

            // Switched off: the state the reader actually met, now with the way
            // out on it.
            try await capture(
                named: "work-start-path-off",
                in: directory,
                appearance: appearance,
                size: CGSize(width: 760, height: 620)
            ) { host in
                DesktopWorkStartPath(host: host, blocker: .switchedOff, compose: {})
            }

            // One step in: Work is on, and this Mac still advertises nothing.
            // The second dead end, which is the one nobody had a route out of.
            try await capture(
                named: "work-start-path-nothing-allowed",
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
                named: "work-settings-reason",
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
        }
    }

    /// Draws one view offscreen and writes `<name>-<light|dark>.png`.
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

        let url = try await TranscriptSnapshotRenderer.render(
            content(host)
                .frame(width: size.width, height: size.height)
                // The canvas the detail column and the sidebar are drawn on.
                .background(Color.junoCanvasWarm),
            name: name,
            width: size.width,
            appearance: appearance,
            into: directory
        )
        #expect(FileManager.default.fileExists(atPath: url.path))
    }
}
