import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
@testable import JunoCodeUI

/// Renders the Studio surfaces to PNGs for visual review.
///
/// Off unless `JUNO_SNAPSHOT_DIR` names a folder: these are pictures for a
/// person to look at, not assertions, so they cost nothing in an ordinary run.
/// Each view is hosted in an offscreen window — never ordered front — and drawn
/// with `cacheDisplay`, so producing them needs no screen access at all.
@MainActor
final class StudioSnapshotTests: XCTestCase {
    private var directory: URL?

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render Studio snapshots.")
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directory = url
    }

    func testRenderSessionScenarios() async throws {
        for scenario in [CodePreviewScenario.transcript, .approval, .streaming, .diffs, .error] {
            let fixture = CodePreviewData.fixture(for: scenario)
            let controller = SessionController(previewFixture: fixture)
            for dark in [false, true] {
                try await render(
                    StudioSessionView(
                        controller: controller,
                        models: [ModelOption(modelID: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5")],
                        openReview: { _ in }
                    ),
                    size: CGSize(width: 900, height: 820),
                    dark: dark,
                    name: "session-\(scenario.rawValue)-\(dark ? "dark" : "light")"
                )
            }
        }
    }

    func testRenderSidePanel() async throws {
        let controller = SessionController(previewFixture: CodePreviewData.fixture(for: .diffs))
        for dark in [false, true] {
            try await render(
                StudioSidePanel(
                    controller: controller,
                    tab: .constant(.changes),
                    createPullRequest: {},
                    close: {}
                ),
                size: CGSize(width: 460, height: 820),
                dark: dark,
                name: "panel-changes-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderLanding() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-studio-landing-\(UUID().uuidString)")
        let project = root.appendingPathComponent("juno")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let workbench = WorkbenchModel(
            dependencies: WorkbenchModel.Dependencies(
                storageRootURL: root.appendingPathComponent("storage"),
                modelClient: UnconfiguredModelClient(),
                availableModels: [ModelOption(modelID: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5")]
            )
        )
        await workbench.bootstrap()
        let record = await workbench.addWorkspace(grantedURL: project)
        for dark in [false, true] {
            try await render(
                StudioLanding(
                    workbench: workbench,
                    code: nil,
                    project: record,
                    isStarting: false,
                    selectProject: { _ in },
                    addProject: {},
                    startLocal: { _ in },
                    openTask: { _ in }
                ),
                size: CGSize(width: 900, height: 720),
                dark: dark,
                name: "landing-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderSettings() async throws {
        for section in [StudioSettingsSection.general, .permissions, .agent, .appearance] {
            try await render(
                StudioSettingsView(workbench: nil, initialSection: section),
                size: CGSize(width: 880, height: 640),
                dark: false,
                name: "settings-\(section.rawValue)"
            )
        }
    }

    // MARK: - Rendering

    private func render<V: View>(_ view: V, size: CGSize, dark: Bool, name: String) async throws {
        guard let directory else { return }
        let hosting = NSHostingView(
            rootView: view
                .frame(width: size.width, height: size.height)
                .environment(\.colorScheme, dark ? .dark : .light)
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
        // Let `.task` work and the first layout passes settle.
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
