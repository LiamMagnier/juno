import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoDesignSystem
@testable import JunoCodeUI

/// The Preview's surfaces as PNGs for review by eye (CODE_AGENT_SPEC §6.4):
/// the pane with its subtitle in words and its menus, the configuration
/// approval card, the thread's check rows, and the annotate toolbar. Off
/// unless `JUNO_SNAPSHOT_DIR` names a folder; rendered offscreen with
/// `cacheDisplay`, never on screen. No status capsule, pill or dot may
/// appear in any of them.
@MainActor
final class PreviewSnapshotTests: XCTestCase {
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
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-preview-snap-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("apps/web/public"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".juno"), withIntermediateDirectories: true)
        try """
        { "version": "0.0.1", "configurations": [
          { "name": "web", "runtimeExecutable": "pnpm", "runtimeArgs": ["run", "dev"], "cwd": "apps/web", "port": 3000, "autoPort": true,
            "env": { "NEXT_TELEMETRY_DISABLED": "1", "NEXT_PUBLIC_API": "http://127.0.0.1:8000" } },
          { "name": "site", "runtimeExecutable": "juno:static", "cwd": "apps/web/public" }
        ] }
        """.write(to: root.appendingPathComponent(".juno/launch.json"), atomically: true, encoding: .utf8)
        try "<!doctype html><html><body style='font-family:-apple-system;padding:24px'><h1>Settings</h1><button>Open menu</button></body></html>"
            .write(to: root.appendingPathComponent("apps/web/public/index.html"), atomically: true, encoding: .utf8)
    }

    override func tearDown() async throws {
        if let root {
            await PreviewRegistry.shared.remove(PreviewKey(checkoutRoot: root, name: "site"))
            PreviewPageRegistry.shared.remove(PreviewKey(checkoutRoot: root, name: "site"))
            try? FileManager.default.removeItem(at: root)
        }
    }

    private func configuration(_ name: String) throws -> ResolvedPreviewConfiguration {
        try XCTUnwrap(LaunchConfigurationStore.load(workspaceRoot: root).configuration(named: name))
    }

    // MARK: - Pane

    /// The pane stopped (empty state in words) and running (subtitle in
    /// words, menus, no capsule), at dock and window widths.
    func testRenderPreviewPane() async throws {
        let session = CodeSessionID(value: "snapshot-session")
        let stopped = PreviewLeaseModel()
        stopped.bind(sessionID: session, workspaceRoot: root)
        stopped.selectedName = "web"
        try await Task.sleep(for: .milliseconds(200))
        for dark in [false, true] {
            try await render(
                PreviewPaneView(lease: stopped, style: .dock, close: {}, openInWindow: {}),
                size: CGSize(width: 460, height: 560), dark: dark, name: "preview-pane-stopped-\(dark ? "dark" : "light")"
            )
        }

        _ = await PreviewRegistry.shared.start(try configuration("site"), checkoutRoot: root, session: session)
        let running = PreviewLeaseModel()
        running.bind(sessionID: session, workspaceRoot: root)
        running.selectedName = "site"
        try await Task.sleep(for: .milliseconds(400))
        await running.refreshSnapshots()
        running.page?.setViewport(.preset(.phone))
        try await Task.sleep(for: .milliseconds(600))
        for dark in [false, true] {
            try await render(
                PreviewPaneView(lease: running, style: .window),
                size: CGSize(width: 820, height: 620), dark: dark, name: "preview-pane-running-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderPreviewConfigApproval() async throws {
        let web = try configuration("web")
        for dark in [false, true] {
            try await render(
                ScrollView {
                    PreviewConfigApprovalCard(configuration: web, cancel: {}, startOnce: {}, always: {})
                        .padding(JunoSpace.region)
                        .frame(maxWidth: 560)
                        .frame(maxWidth: .infinity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Studio.Surface.canvas),
                size: CGSize(width: 600, height: 460), dark: dark, name: "preview-config-approval-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderPreviewBanners() async throws {
        let rows = VStack(spacing: 0) {
            PreviewBannerRow(text: "Juno is using the preview.", actions: [("Stop", {})])
            PreviewBannerRow(text: "The page asks: \"Delete project?\"", actions: [("Cancel", {}), ("OK", {})])
            PreviewBannerRow(
                text: "The server tried to reach fonts.googleapis.com while offline. Let this project's server use the internet?",
                actions: [("Keep offline", {}), ("Allow", {})]
            )
            PreviewBannerRow(
                text: "Port 3000 is in use by node (pid 4211). When it is, start web on a free port instead?",
                actions: [("Keep this port", {}), ("Use a free port", {})]
            )
            Spacer(minLength: 0)
        }
        .background(Studio.Surface.canvas)
        for dark in [false, true] {
            try await render(rows, size: CGSize(width: 520, height: 230), dark: dark, name: "preview-banners-\(dark ? "dark" : "light")")
        }
    }

    // MARK: - Thread rows

    func testRenderPreviewCheckRow() async throws {
        let passed = PreviewEvidence.mint(PreviewObservation(
            route: "/settings", viewport: "desktop", httpStatus: 200, newConsoleErrors: [], errorOverlay: nil,
            newServerErrors: [], screenshotHash: "4f2a", workspaceRevision: 4
        ))
        let failed = PreviewEvidence.mint(PreviewObservation(
            route: "/settings", viewport: "phone", httpStatus: 200, newConsoleErrors: ["TypeError: menu is undefined"],
            errorOverlay: "Failed to compile ./src/components/SettingsMenu.tsx", newServerErrors: [], screenshotHash: "9c1e",
            workspaceRevision: 4
        ))
        let rows = VStack(alignment: .leading, spacing: JunoSpace.regular) {
            StudioAssistantMessage(text: "The menu opens on pointerdown now.")
            PreviewCheckRow(record: passed)
            PreviewCheckRow(record: failed)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: Studio.Metrics.measure)
        .padding(Studio.Metrics.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Studio.Surface.canvas)
        for dark in [false, true] {
            try await render(rows, size: CGSize(width: 760, height: 260), dark: dark, name: "preview-check-rows-\(dark ? "dark" : "light")")
        }
    }

    // MARK: - Annotate

    func testRenderAnnotateToolbar() async throws {
        var annotation = PreviewAnnotation(
            route: "/settings",
            selector: "main > section.panel > button:nth-of-type(2)",
            role: "button",
            name: "Open menu",
            box: CGRect(x: 412, y: 300, width: 88, height: 28),
            styles: [("font-size", "13px"), ("padding", "6px 10px")],
            sourceHint: "src/components/SettingsMenu.tsx:41",
            note: "This should open on hover too.",
            screenshot: Self.sampleCrop()
        )
        annotation.note = "This should open on hover too."
        for dark in [false, true] {
            try await render(
                VStack {
                    Spacer()
                    PreviewAnnotateToolbar(annotation: .constant(annotation), send: {}, cancel: {})
                        .frame(maxWidth: 520)
                        .padding(JunoSpace.snug)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Studio.Surface.raised),
                size: CGSize(width: 560, height: 240), dark: dark, name: "preview-annotate-\(dark ? "dark" : "light")"
            )
        }
    }

    private static func sampleCrop() -> ModelImage? {
        let image = NSImage(size: CGSize(width: 104, height: 44), flipped: false) { rect in
            NSColor(white: 0.96, alpha: 1).setFill()
            rect.fill()
            NSColor.systemBlue.setFill()
            NSBezierPath(roundedRect: rect.insetBy(dx: 8, dy: 8), xRadius: 6, yRadius: 6).fill()
            return true
        }
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:])
        else { return nil }
        return ModelImage(mediaType: "image/png", data: png)
    }

    // MARK: - Rendering

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
        for _ in 0..<6 {
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
