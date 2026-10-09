import AppKit
import Foundation
import JunoCodeUI
import JunoDesignSystem
import SwiftUI
import Testing

/// Alevr Code v2 on the Mac, drawn offscreen inside the app (so the web
/// icon set and the provider marks come from the app's asset catalog):
/// `$JUNO_SNAPSHOT_DIR/code-v2/<surface>-<light|dark>.png` for every
/// surface in ``CodeV2Gallery``. Glass draws its Reduce Transparency recipe
/// offscreen, as in every other snapshot set.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Code v2 snapshots."
    ),
    .serialized
)
struct CodeV2SnapshotTests {
    @Test(arguments: CodeV2Gallery.Surface.allCases)
    func drawsInBothAppearances(_ surface: CodeV2Gallery.Surface) async throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("code-v2", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for dark in [false, true] {
            let size = surface.size
            let hosting = NSHostingView(
                rootView: CodeV2Gallery.view(surface)
                    .frame(width: size.width, height: size.height)
                    .environment(\.colorScheme, dark ? .dark : .light)
                    .environment(\.junoSnapshotOpaqueGlass, true)
                    .environment(\.codeV2Now, CodeV2Fixtures.now)
            )
            hosting.frame = CGRect(origin: .zero, size: size)
            let window = NSWindow(
                contentRect: CGRect(origin: CGPoint(x: -10_000, y: -10_000), size: size),
                styleMask: [.borderless], backing: .buffered, defer: false
            )
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = hosting
            for _ in 0..<8 {
                try await Task.sleep(for: .milliseconds(80))
                hosting.layoutSubtreeIfNeeded()
            }
            let rep = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: rep)
            let data = try #require(rep.representation(using: .png, properties: [:]))
            let url = root.appendingPathComponent("\(surface.rawValue)-\(dark ? "dark" : "light").png")
            try data.write(to: url)
            window.contentView = nil
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}
