import AppKit
import Foundation
import JunoCodeUI
import JunoCodeCore
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
    @Test
    func drawsFullAgentTrace() async throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("code-v2", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var items = CodeV2Fixtures.multiAgentSnapshot.items
        items = items.map { item in
            guard case var .subagent(agent) = item, agent.agentId == "w2" else { return item }
            agent.title = "Client total migration"
            agent.task = "Update src/cart/useCartTotal.ts to fetch the server total. Preserve loading and error states. Run the cart tests and report the changed files, test results, and any remaining risks."
            return .subagent(agent)
        }
        var reasoning = CodeV2.Reasoning(id: "trace-reasoning", turnId: "t1", createdAt: "2026-10-11T10:04:00Z", text: "The hook must keep its existing loading state while the server computes tax and coupons. I will check the current consumers before changing its return shape.", summary: true)
        reasoning.agentId = "w2"
        items.append(.reasoning(reasoning))
        var command = CodeV2.CommandExecution(id: "trace-command", turnId: "t1", createdAt: "2026-10-11T10:04:01Z", callId: "trace-command", command: "pnpm test --filter cart", output: "15 cart tests passed", exitCode: 0, status: .completed)
        command.agentId = "w2"
        items.append(.commandExecution(command))
        let nodes = items.compactMap { item -> CodeV2AgentNode? in
            guard case let .subagent(agent) = item else { return nil }
            return CodeV2AgentNode(subagent: agent, items: items)
        }
        for dark in [false, true] {
            let size = CGSize(width: 560, height: 780)
            let hosting = NSHostingView(rootView: CodeV2AgentsPane(nodes: nodes, selected: .constant("w2"))
                .frame(width: size.width, height: size.height)
                .environment(\.colorScheme, dark ? .dark : .light)
                .environment(\.junoSnapshotOpaqueGlass, true))
            hosting.frame = CGRect(origin: .zero, size: size)
            let window = NSWindow(contentRect: CGRect(origin: CGPoint(x: -10_000, y: -10_000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = hosting
            for _ in 0..<8 { try await Task.sleep(for: .milliseconds(80)); hosting.layoutSubtreeIfNeeded() }
            let rep = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: rep)
            try #require(rep.representation(using: .png, properties: [:])).write(to: root.appendingPathComponent("agent-trace-\(dark ? "dark" : "light").png"))
            window.contentView = nil
        }
    }

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
