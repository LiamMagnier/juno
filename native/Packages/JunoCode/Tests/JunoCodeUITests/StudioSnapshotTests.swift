import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import XCTest
import JunoCodeCore
import JunoCodeLocal
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
                StudioSettingsView(
                    workbench: nil,
                    initialSection: section,
                    screenControlProbe: Self.probe(.granted, .denied)
                ),
                size: CGSize(width: 880, height: 640),
                dark: false,
                name: "settings-\(section.rawValue)"
            )
        }
    }

    /// The Permissions page's screen-control section on its own, so it is not
    /// below the fold: one grant allowed and one not, then both allowed.
    func testRenderScreenControlSettings() async throws {
        let cases: [(String, ComputerUsePermissionProbe)] = [
            ("partial", Self.probe(.granted, .denied)),
            ("ready", Self.probe(.granted, .granted)),
        ]
        for (name, probe) in cases {
            for dark in [false, true] {
                try await render(
                    Form { StudioScreenControlSettings(probe: probe) }
                        .formStyle(.grouped),
                    size: CGSize(width: 680, height: 360),
                    dark: dark,
                    name: "settings-screen-control-\(name)-\(dark ? "dark" : "light")"
                )
            }
        }
    }

    /// A project's shared allow list holding a screen-input rule, which the
    /// session never applies, beside one it does.
    func testRenderProjectAllowListWithScreenInputRule() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-studio-rules-\(UUID().uuidString)")
        let project = root.appendingPathComponent("repo", isDirectory: true)
        try FileManager.default.createDirectory(
            at: project.appendingPathComponent(".juno"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        try Data(#"{"permissions":{"allow":["Bash(npm test *)","computer_click"]}}"#.utf8)
            .write(to: project.appendingPathComponent(".juno/settings.json"))
        let settings = CodeSettingsModel(
            store: CodeSettingsStore(userDirectory: root.appendingPathComponent("home/.juno"))
        )
        settings.selectProject(project)
        for dark in [false, true] {
            try await render(
                Form { StudioRuleListSection(list: .allow, scope: .project, settings: settings) }
                    .formStyle(.grouped),
                size: CGSize(width: 680, height: 260),
                dark: dark,
                name: "settings-project-allow-screen-input-\(dark ? "dark" : "light")"
            )
        }
    }

    /// Every state of the banner at the top of a session, and the capture it
    /// opens to.
    func testRenderScreenControlBanner() async throws {
        let capture = ComputerUseCapture(
            sessionID: CodeSessionID(value: "snapshot"),
            imageData: try Self.fakeScreen(),
            capturedAt: Date(timeIntervalSince1970: 1_790_000_000)
        )
        let notices: [(StudioScreenControlNotice, ComputerUseCapture?)] = [
            (.active, capture),
            (.active, nil),
            (.needsPermission([.screenRecording, .accessibility]), nil),
            (.needsPermission([.accessibility]), nil),
            (.ready, nil),
        ]
        for dark in [false, true] {
            try await render(
                VStack(spacing: 16) {
                    ForEach(Array(notices.enumerated()), id: \.offset) { _, item in
                        StudioScreenControlCapsule(
                            notice: item.0,
                            capture: item.1,
                            stop: {},
                            start: {},
                            dismiss: {}
                        )
                    }
                    Spacer()
                }
                .padding(16)
                .frame(maxWidth: .infinity)
                .background(Studio.Surface.canvas),
                size: CGSize(width: 760, height: 420),
                dark: dark,
                name: "screen-control-banner-\(dark ? "dark" : "light")"
            )
            // A thread column squeezed by the side panel: the grant names
            // must wrap, not truncate.
            try await render(
                VStack {
                    StudioScreenControlCapsule(
                        notice: .needsPermission([.screenRecording, .accessibility]),
                        stop: {},
                        start: {},
                        dismiss: {}
                    )
                    Spacer()
                }
                .padding(16)
                .frame(maxWidth: .infinity)
                .background(Studio.Surface.canvas),
                size: CGSize(width: 440, height: 120),
                dark: dark,
                name: "screen-control-banner-narrow-\(dark ? "dark" : "light")"
            )
            try await render(
                StudioCaptureDetail(capture: capture)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Studio.Surface.raised),
                size: CGSize(width: 584, height: 420),
                dark: dark,
                name: "screen-control-capture-\(dark ? "dark" : "light")"
            )
        }
    }

    // MARK: - Fixtures

    private static func probe(
        _ screen: ComputerUsePermissionState,
        _ accessibility: ComputerUsePermissionState
    ) -> ComputerUsePermissionProbe {
        ComputerUsePermissionProbe(screenRecording: { screen }, accessibility: { accessibility })
    }

    /// A made-up desktop — wallpaper, one window with a title bar and a few
    /// lines of text, a menu bar — encoded as JPEG the way the driver encodes
    /// a capture.
    private static func fakeScreen() throws -> Data {
        let width = 1_440, height = 900
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(
            CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        )
        func fill(_ rect: CGRect, _ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) {
            context.setFillColor(CGColor(srgbRed: red, green: green, blue: blue, alpha: 1))
            context.fill(rect)
        }
        fill(CGRect(x: 0, y: 0, width: width, height: height), 0.33, 0.42, 0.52)
        fill(CGRect(x: 220, y: 140, width: 1_000, height: 640), 0.97, 0.96, 0.94)
        fill(CGRect(x: 220, y: 740, width: 1_000, height: 40), 0.88, 0.87, 0.85)
        let lengths = [760, 620, 700, 540, 720, 480, 660, 600, 380]
        for (line, length) in lengths.enumerated() {
            fill(CGRect(x: 280, y: 660 - line * 52, width: length, height: 14), 0.55, 0.54, 0.52)
        }
        fill(CGRect(x: 0, y: height - 28, width: width, height: 28), 0.93, 0.93, 0.93)
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
        )
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
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
