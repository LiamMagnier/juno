import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
import JunoScreenControl
@testable import JunoCodeUI

/// Renders screen control's surfaces to PNGs for review (Lane C): the row at
/// the top of a session, the grant sheet, the approval card with its marked
/// crop, the step rows and the settings section.
///
/// Off unless `JUNO_SNAPSHOT_DIR` names a folder. Each view is hosted in an
/// offscreen window, never ordered front, and drawn with `cacheDisplay`: no
/// screen access at all.
@MainActor
final class StudioScreenSnapshotTests: XCTestCase {
    private var directory: URL?

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render Studio snapshots.")
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directory = url
    }

    func testRenderScreenControlRow() async throws {
        let thumbnail = try Self.fakeWindow()
        let states: [(StudioScreenControlNotice, String?, Bool)] = [
            (.active, "TextEdit", false),
            (.active, "Safari", true),
            (.paused, "TextEdit", false),
            (.needsPermission([.screenRecording, .accessibility]), nil, false),
            (.trustLost, nil, false),
            (.ready, nil, false),
        ]
        for dark in [false, true] {
            try await render(
                VStack(spacing: 12) {
                    ForEach(Array(states.enumerated()), id: \.offset) { _, state in
                        StudioScreenControlRow(
                            notice: state.0,
                            app: state.1,
                            thumbnail: thumbnail,
                            markedPoint: [0.62, 0.71],
                            takeover: state.2,
                            stop: {}, start: {}, dismiss: {}
                        )
                    }
                    Spacer()
                }
                .padding(16)
                .frame(maxWidth: .infinity)
                .background(Studio.Surface.canvas),
                size: CGSize(width: 780, height: 560),
                dark: dark,
                name: "screen-control-row-\(dark ? "dark" : "light")"
            )
            // A thread column squeezed by the side panel: the sentence wraps,
            // the buttons give up their long names, nothing truncates.
            try await render(
                VStack(spacing: 12) {
                    StudioScreenControlRow(notice: .active, app: "System Settings", thumbnail: thumbnail, stop: {}, start: {}, dismiss: {})
                    StudioScreenControlRow(notice: .needsPermission([.screenRecording, .accessibility]), stop: {}, start: {}, dismiss: {})
                    Spacer()
                }
                .padding(16)
                .frame(maxWidth: .infinity)
                .background(Studio.Surface.canvas),
                size: CGSize(width: 440, height: 220),
                dark: dark,
                name: "screen-control-row-narrow-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderScreenGrantSheet() async throws {
        let proposal = GrantProposal(
            sessionID: "s",
            reason: "Check the export sheet in the app I just built",
            offers: [
                AppGrantPolicy.offer(request: "TextEdit", bundleID: "com.apple.TextEdit", displayName: "TextEdit", preferences: .default),
                AppGrantPolicy.offer(request: "Terminal", bundleID: "com.apple.Terminal", displayName: "Terminal", preferences: .default),
                AppGrantPolicy.offer(request: "Safari", bundleID: "com.apple.Safari", displayName: "Safari", preferences: .default),
                AppGrantPolicy.offer(request: "Finder", bundleID: "com.apple.finder", displayName: "Finder", preferences: .default),
                AppGrantPolicy.offer(request: "1Password", bundleID: "com.1password.1password", displayName: "1Password", preferences: .default),
                AppGrantPolicy.offer(request: "Juno", bundleID: "com.liammagnier.JunoDesktop", displayName: "Juno", preferences: .default),
            ].map { offer in
                var offer = offer
                if offer.offeredTier == .full { offer.clipboardRead = true }
                return offer
            }
        )
        let approval = ApprovalRequest(
            sessionID: CodeSessionID(value: "snapshot"),
            actionDigest: "grant-digest",
            toolName: ComputerUseToolName.apps,
            summary: proposal.summary,
            risk: .destructive,
            approvalPolicy: .alwaysRequiresApproval,
            requestedAt: Date(timeIntervalSince1970: 1_790_000_000),
            expiresAt: Date(timeIntervalSince1970: 1_790_000_900)
        )
        for dark in [false, true] {
            let controller = Self.controller(with: approval)
            controller.screen.setPreviewApprovalDetail(.grants(proposal), digest: approval.actionDigest)
            try await render(
                VStack {
                    Spacer()
                    StudioApprovalPrompt(controller: controller)
                }
                .padding(Studio.Metrics.gutter)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Studio.Surface.canvas),
                size: CGSize(width: 820, height: 720),
                dark: dark,
                name: "screen-grant-sheet-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderScreenApprovalCard() async throws {
        let window = try Self.fakeWindowImage()
        let point: [Double] = [1180, 760]
        let click = PreparedScreenAction(
            sessionID: "s",
            action: ScreenAction(kind: .leftClick, coordinate: point),
            target: ScreenTargetSummary(bundleID: "com.apple.mail", appName: "Mail", element: "“Envoyer” button", role: "button", title: "Envoyer"),
            point: ScreenPoint(x: 900, y: 600),
            framePoint: point,
            floor: .consequentialControl("envoyer"),
            frameHash: "frame",
            summary: "Click the “Envoyer” button in Mail",
            crop: ScreenControlService.markedCrop(image: window, at: point),
            isInput: true
        )
        let type = PreparedScreenAction(
            sessionID: "s",
            action: ScreenAction(kind: .type, text: "Rapport trimestriel — chiffres définitifs"),
            target: ScreenTargetSummary(bundleID: "com.apple.TextEdit", appName: "TextEdit", element: "“Title” text field", role: "text field", title: "Title"),
            framePoint: [520, 300],
            frameHash: "frame",
            summary: "Type “Rapport trimestriel — chiffres définitifs” into the “Title” text field in TextEdit",
            crop: ScreenControlService.markedCrop(image: window, at: [520, 300]),
            isInput: true
        )
        for (name, prepared) in [("floor", click), ("type", type)] {
            let approval = ApprovalRequest(
                sessionID: CodeSessionID(value: "snapshot"),
                actionDigest: "digest-\(name)",
                toolName: ComputerUseToolName.computer,
                summary: prepared.summary,
                risk: prepared.floor == nil ? .critical : .destructive,
                approvalPolicy: prepared.floor == nil ? .byRisk : .alwaysRequiresApproval,
                requestedAt: Date(timeIntervalSince1970: 1_790_000_000),
                expiresAt: Date(timeIntervalSince1970: 1_790_000_900)
            )
            for dark in [false, true] {
                let controller = Self.controller(with: approval)
                controller.screen.setPreviewApprovalDetail(.action(prepared), digest: approval.actionDigest)
                try await render(
                    VStack {
                        Spacer()
                        StudioApprovalPrompt(controller: controller)
                    }
                    .padding(Studio.Metrics.gutter)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Studio.Surface.canvas),
                    size: CGSize(width: 820, height: 640),
                    dark: dark,
                    name: "screen-approval-\(name)-\(dark ? "dark" : "light")"
                )
            }
        }
    }

    func testRenderScreenStepRows() async throws {
        let thumbnail = try Self.fakeWindow()
        let rows: [(StudioScreenStep, ScreenStepVisual?)] = [
            (
                StudioScreenStep(eventID: "1", toolCallID: "a", verb: "Clicked", app: "TextEdit", succeeded: true,
                                 outcome: "Clicked the “Export…” button in TextEdit."),
                ScreenStepVisual(summary: "", appName: "TextEdit", thumbnail: thumbnail, markedPoint: [0.7, 0.2], succeeded: true, at: Date())
            ),
            (
                StudioScreenStep(eventID: "2", toolCallID: "b", verb: "Typed", app: "TextEdit", element: "“Q3 report”", succeeded: true,
                                 outcome: "Typed 9 characters into the “Name” text field in TextEdit."),
                ScreenStepVisual(summary: "", appName: "TextEdit", thumbnail: thumbnail, markedPoint: [0.4, 0.3], succeeded: true, at: Date())
            ),
            (
                StudioScreenStep(eventID: "3", toolCallID: "c", verb: "Pressed", running: "Pressing keys", app: "TextEdit", element: "cmd+s"),
                nil
            ),
            (
                StudioScreenStep(eventID: "4", toolCallID: "d", verb: "Clicked", app: "Terminal", succeeded: false,
                                 outcome: "Terminal is granted for clicks only; typing, keys, right-click and drags were not sent."),
                nil
            ),
            (
                StudioScreenStep(eventID: "5", toolCallID: "e", verb: "Ran 3 screen actions", app: "TextEdit", succeeded: true,
                                 outcome: "1. Clicked the “File” menu in TextEdit."),
                ScreenStepVisual(summary: "", appName: "TextEdit", thumbnail: thumbnail, markedPoint: nil, succeeded: true, at: Date())
            ),
        ]
        for dark in [false, true] {
            try await render(
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    StudioAssistantMessage(text: "I'll check the export sheet in TextEdit.")
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        StudioScreenStepRow(step: row.0, visual: row.1)
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: Studio.Metrics.measure)
                .padding(Studio.Metrics.gutter)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Studio.Surface.canvas),
                size: CGSize(width: 860, height: 520),
                dark: dark,
                name: "screen-step-rows-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderScreenControlSettings() async throws {
        let suite = "juno.snapshot.screen.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let store = ScreenControlPreferencesStore(defaults: defaults)
        _ = store.set("com.apple.TextEdit", tier: .click)
        _ = store.set("com.example.chat", tier: nil)
        let cases: [(String, ComputerUsePermissionProbe)] = [
            ("partial", ComputerUsePermissionProbe(screenRecording: { .granted }, accessibility: { .denied })),
            ("ready", ComputerUsePermissionProbe(screenRecording: { .granted }, accessibility: { .granted })),
        ]
        for (name, probe) in cases {
            for dark in [false, true] {
                try await render(
                    Form { StudioScreenControlSettings(probe: probe, preferencesStore: store) }
                        .formStyle(.grouped),
                    size: CGSize(width: 680, height: 640),
                    dark: dark,
                    name: "settings-screen-control-\(name)-\(dark ? "dark" : "light")"
                )
            }
        }
    }

    // MARK: - Fixtures

    private static func controller(with approval: ApprovalRequest) -> SessionController {
        var fixture = CodePreviewData.fixture(for: .transcript)
        fixture.pendingApprovals = [approval]
        return SessionController(previewFixture: fixture)
    }

    /// A made-up app window: a title bar, a text area, a dialog with buttons.
    private static func fakeWindowImage() throws -> CGImage {
        let width = 1_600, height = 1_000
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        func fill(_ rect: CGRect, _ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) {
            context.setFillColor(CGColor(srgbRed: red, green: green, blue: blue, alpha: 1))
            // Top-left rects, CoreGraphics draws bottom-left.
            context.fill(CGRect(x: rect.minX, y: CGFloat(height) - rect.maxY, width: rect.width, height: rect.height))
        }
        fill(CGRect(x: 0, y: 0, width: width, height: height), 0.97, 0.96, 0.94)
        fill(CGRect(x: 0, y: 0, width: width, height: 56), 0.89, 0.88, 0.86)
        for (index, length) in [900, 760, 1_100, 640, 980, 520].enumerated() {
            fill(CGRect(x: 120, y: 160 + index * 64, width: length, height: 18), 0.62, 0.61, 0.59)
        }
        fill(CGRect(x: 820, y: 560, width: 560, height: 280), 0.99, 0.99, 0.99)
        fill(CGRect(x: 1_100, y: 730, width: 160, height: 60), 0.18, 0.42, 0.85)
        fill(CGRect(x: 900, y: 730, width: 160, height: 60), 0.88, 0.88, 0.88)
        return try XCTUnwrap(context.makeImage())
    }

    private static func fakeWindow() throws -> Data {
        let image = try fakeWindowImage()
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
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
                // Liquid Glass is composited by the window server; offscreen,
                // the row draws its opaque card instead.
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
