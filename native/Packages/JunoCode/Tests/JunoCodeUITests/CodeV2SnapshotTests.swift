import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
@testable import JunoCodeUI

/// Offscreen pictures of every Code v2 surface on the Mac, light and dark
/// (the owner's rule: visual verification by snapshot, never screen
/// control). Off unless `JUNO_SNAPSHOT_DIR` names a folder.
@MainActor
final class CodeV2SnapshotTests: XCTestCase {
    private var directory: URL?

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render Code v2 snapshots.")
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directory = url
    }

    func testRenderEverySurface() async throws {
        for surface in CodeV2Gallery.Surface.allCases {
            try await renderPair(name: surface.rawValue, size: surface.size) { CodeV2Gallery.view(surface) }
        }
    }

    private func renderPair<V: View>(name: String, size: CGSize, @ViewBuilder _ make: () -> V) async throws {
        for dark in [false, true] {
            try await render(make(), size: size, dark: dark, name: "\(name)-\(dark ? "dark" : "light")")
        }
    }

    private func render<V: View>(_ view: V, size: CGSize, dark: Bool, name: String) async throws {
        guard let directory else { return }
        let hosting = NSHostingView(
            rootView: view
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
        hosting.layoutSubtreeIfNeeded()
        for _ in 0..<8 {
            try await Task.sleep(for: .milliseconds(80))
            hosting.layoutSubtreeIfNeeded()
        }
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
            XCTFail("No bitmap for \(name)")
            return
        }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let data = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try data.write(to: directory.appendingPathComponent(name + ".png"))
        window.contentView = nil
    }
}
