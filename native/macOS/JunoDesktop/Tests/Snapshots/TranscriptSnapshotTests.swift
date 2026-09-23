import AppKit
import Foundation
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// The transcript, photographed offscreen in both appearances (§2 of the
/// Phase 2 brief).
///
/// Off by default: set `JUNO_SNAPSHOT_DIR` (through xcodebuild, as
/// `TEST_RUNNER_JUNO_SNAPSHOT_DIR`) and the suite writes
/// `<dir>/transcript/<fixture>-<light|dark>.png`. Nothing is put on screen — no
/// window is ordered in, and the test host runs as an accessory — so it needs
/// no Screen Recording permission and cannot capture anything but the view
/// under test. `npm run native:snapshots:transcript` runs it.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the transcript snapshots."
    ),
    .serialized
)
struct TranscriptSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("transcript", isDirectory: true)
    }

    @Test(arguments: TranscriptSnapshotFixtures.all.map(\.name))
    func fixtureDrawsInBothAppearances(_ name: String) async throws {
        let fixture = try #require(TranscriptSnapshotFixtures.all.first { $0.name == name })
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                fixture.view(),
                name: fixture.name,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }

    /// The one thing the harness has to prove about itself: that a web view
    /// that is never placed in a window still paints, so the artifact fixtures
    /// can use real stills instead of empty rectangles.
    @Test
    func anOffscreenWebViewPaintsAStill() async throws {
        let still = try await SnapshotStills.still(html: """
            <!doctype html><html><body style="margin:0;background:#1D1D1B">
            <div style="margin:40px;height:120px;border-radius:16px;background:#E27D5F"></div>
            </body></html>
            """)
        let rep = try #require(still.representations.first as? NSBitmapImageRep
            ?? still.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let png = rep.representation(using: .png, properties: [:]) {
            try png.write(to: directory.appendingPathComponent("harness-webview-still.png"))
        }
        // Mostly the dark ground, with the coral block in it: far from white.
        let white = TranscriptSnapshotRenderer.differingFraction(
            of: rep, from: (red: 255, green: 255, blue: 255)
        )
        #expect(white > 0.5, "the offscreen web view painted nothing")
    }
}
