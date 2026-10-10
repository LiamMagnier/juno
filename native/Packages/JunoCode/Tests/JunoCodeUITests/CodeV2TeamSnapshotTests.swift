import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoDesignSystem
@testable import JunoCodeUI

/// Offscreen pictures of the Team orchestrator on the Mac, light and dark
/// (never screen control). Off unless `JUNO_SNAPSHOT_DIR` names a folder.
@MainActor
final class CodeV2TeamSnapshotTests: XCTestCase {
    func testRenderTheTeamSurfaces() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render the Team snapshots.")
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for surface in CodeV2TeamGallery.Surface.allCases {
            for dark in [false, true] {
                try await render(CodeV2TeamGallery.view(surface), size: surface.size, dark: dark,
                                 to: directory.appendingPathComponent("mac-\(surface.rawValue)-\(dark ? "dark" : "light").png"))
            }
        }
    }

    /// The chip's words and the editor's model are what the snapshots show.
    func testTheGalleryTeamReadsAsTheOwnerAskedForIt() {
        XCTAssertEqual(CodeV2TeamGallery.team.teamSummary, "Opus plans · Sonnet ×2 builds · GPT verifies")
        XCTAssertEqual(CodeV2TeamGallery.runningSnapshot.items.compactMap { item -> CodeV2.TeamPhase? in
            if case let .subagent(agent) = item { return agent.phase }
            return nil
        }, [.plan, .build, .build])
        let nodes = CodeV2TeamGallery.runningSnapshot.items.compactMap { item -> CodeV2AgentNode? in
            if case let .subagent(agent) = item { return CodeV2AgentNode(subagent: agent, items: CodeV2TeamGallery.runningSnapshot.items) }
            return nil
        }
        XCTAssertEqual(nodes.map(\.roleLabel), ["Architect", "Builder 1", "Builder 2"])
        XCTAssertEqual(CodeV2AgentCopy.headline(nodes), "Plan → Build")
    }

    private func render<V: View>(_ view: V, size: CGSize, dark: Bool, to url: URL) async throws {
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
        let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        window.contentView = nil
    }
}
