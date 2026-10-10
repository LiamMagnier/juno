import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
@testable import JunoCodeUI

/// The Preview pane in the states the owner's report was about, as PNGs for
/// review by eye: the servers Alevr found when the launch file did not read,
/// a server started from a Claude Code style file with its page loaded, and a
/// malformed file said in words. Off unless `JUNO_SNAPSHOT_DIR` names a
/// folder; rendered offscreen, never on screen.
@MainActor
final class PreviewLaunchSnapshotTests: XCTestCase {
    private var directory: URL?
    private var root: URL!

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render Preview snapshots.")
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directory = url
        PreviewPage.backgroundHostMode = .offscreen
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("alevr-preview-launch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = root.resolvingSymlinksInPath().standardizedFileURL
    }

    override func tearDown() async throws {
        if let root {
            let key = PreviewKey(checkoutRoot: root, name: "site")
            await PreviewRegistry.shared.remove(key)
            PreviewPageRegistry.shared.remove(key)
            try? FileManager.default.removeItem(at: root)
        }
    }

    private func write(_ relative: String, _ text: String) throws {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    /// `.juno/launch.json` holds `{}`; the project has a Vite app and a Go
    /// API. The pane says what is wrong with the file and offers each server
    /// it found with a one-click Start.
    func testRenderDiscoveredServers() async throws {
        try write(".juno/launch.json", "{}")
        try write("package.json", #"{"scripts":{"dev":"vite","preview":"vite preview","build":"vite build"}}"#)
        try write("package-lock.json", "{}")
        try write("apps/docs/package.json", #"{"scripts":{"dev":"astro dev"}}"#)
        let lease = PreviewLeaseModel()
        lease.bind(sessionID: CodeSessionID(value: "snapshot-discovered"), workspaceRoot: root)
        XCTAssertTrue(lease.catalog.isDiscovered)
        XCTAssertEqual(lease.catalog.configurations.map(\.name), ["dev", "preview", "apps/docs dev"])
        try await Task.sleep(for: .milliseconds(200))
        for dark in [false, true] {
            try await render(
                PreviewPaneView(lease: lease, style: .dock, close: {}, openInWindow: {}),
                size: CGSize(width: 480, height: 600), dark: dark, name: "preview-discovered-\(dark ? "dark" : "light")"
            )
        }
    }

    /// A Claude Code style `.claude/launch.json` with comments: the server
    /// picks its own port, Alevr reads it from the output and loads the page.
    func testRenderRunningFromAClaudeFile() async throws {
        try write("serve.py", """
        import http.server, socketserver
        s = socketserver.TCPServer(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
        print("  Local:   http://localhost:%d/" % s.server_address[1], flush=True)
        s.serve_forever()
        """)
        try write("index.html", """
        <!doctype html><html><body style="font-family:-apple-system;margin:0;padding:32px;background:#faf8f5;color:#1c1b1a">
        <h1 style="font-weight:600;margin:0 0 8px">Field notes</h1>
        <p style="color:#6b6760;margin:0 0 24px">Served by python on a port it chose itself.</p>
        <button style="font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #d8d3cc;background:white">New note</button>
        </body></html>
        """)
        try write(".claude/launch.json", """
        // Claude Code's format
        {
          "version": "0.0.1",
          "configurations": [
            { "name": "site", "runtimeExecutable": "python3", "runtimeArgs": ["-u", "serve.py"], },
          ],
        }
        """)
        let session = CodeSessionID(value: "snapshot-running")
        let catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertEqual(catalog.issues, [])
        let site = try XCTUnwrap(catalog.configuration(named: "site"))
        let outcome = await PreviewRegistry.shared.start(site, checkoutRoot: root, session: session)
        guard case let .ready(url, _) = outcome.result else {
            return XCTFail("did not start: \(outcome.result) \(outcome.recentLog)")
        }
        let lease = PreviewLeaseModel()
        lease.bind(sessionID: session, workspaceRoot: root)
        lease.selectedName = "site"
        try await Task.sleep(for: .milliseconds(300))
        await lease.refreshSnapshots()
        XCTAssertEqual(lease.page?.origin.map { PreviewOrigin.sameOrigin($0, url) }, true)
        try await Task.sleep(for: .milliseconds(900))
        for dark in [false, true] {
            try await render(
                PreviewPaneView(lease: lease, style: .window),
                size: CGSize(width: 820, height: 600), dark: dark, name: "preview-running-claude-file-\(dark ? "dark" : "light")"
            )
        }
    }

    /// A file with a value of the wrong type, and nothing else in the
    /// project to run: the pane says exactly what is wrong and where.
    func testRenderMalformedFile() async throws {
        try write(".juno/launch.json", #"{ "configurations": [ { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": "five thousand" } ] }"#)
        let lease = PreviewLeaseModel()
        lease.bind(sessionID: CodeSessionID(value: "snapshot-malformed"), workspaceRoot: root)
        XCTAssertEqual(
            lease.fileProblem,
            ".juno/launch.json: configurations[0].port (\"web\") should be a port number like 3000, but it is the text \"five thousand\"."
        )
        lease.requestStart()
        XCTAssertEqual(lease.notice, "Fix the launch file to start a server; Alevr found no other server to start in the project.")
        XCTAssertEqual(lease.statusSentence, "The launch file did not read")
        try await Task.sleep(for: .milliseconds(200))
        for dark in [false, true] {
            try await render(
                PreviewPaneView(lease: lease, style: .dock, close: {}, openInWindow: {}),
                size: CGSize(width: 480, height: 520), dark: dark, name: "preview-malformed-\(dark ? "dark" : "light")"
            )
        }
    }

    private func render<V: View>(_ view: V, size: CGSize, dark: Bool, name: String) async throws {
        guard let directory else { return }
        let hosting = NSHostingView(
            rootView: view
                .frame(width: size.width, height: size.height)
                .environment(\.colorScheme, dark ? .dark : .light)
                .environment(\.junoSnapshotOpaqueGlass, true)
        )
        hosting.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: CGRect(origin: CGPoint(x: -10_000, y: -10_000), size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        for _ in 0..<8 {
            try await Task.sleep(for: .milliseconds(100))
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
