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

    private func composer(_ selection: CodeV2.ModelSelection, roles: CodeV2RoleDraft? = nil) -> CodeV2ComposerModel {
        CodeV2ComposerModel(selection: selection, runtimeMode: .autoEdit, roles: roles)
    }

    // MARK: Window

    func testWorkspaceWorkingWithChanges() async throws {
        let session = CodeV2EnvSession(preview: CodeV2Fixtures.workingSnapshot)
        session.setPreviewDiff(thread: CodeV2Fixtures.diffFiles)
        let dock = CodeV2DockController()
        dock.show(.changes)
        if let hunk = CodeV2Fixtures.diffFiles.dropFirst().first?.hunks.first {
            dock.decisions.set(.accepted, for: hunk)
        }
        let model = composer(CodeV2Fixtures.claudeSelection, roles: CodeV2Fixtures.leadWorkers)
        try await renderPair(name: "workspace-working", size: CGSize(width: 1280, height: 860)) {
            window(
                CodeV2EnvSessionView(session: session, composer: model, directory: CodeV2Fixtures.directory, dock: dock),
                dock: CodeV2EnvDockView(session: session, dock: dock)
            )
        }
    }

    func testWorkspaceMultiAgentWithApprovalTakeover() async throws {
        let session = CodeV2EnvSession(preview: CodeV2Fixtures.multiAgentSnapshot)
        let dock = CodeV2DockController()
        dock.selectAgent("w2")
        let model = composer(CodeV2Fixtures.claudeSelection, roles: CodeV2Fixtures.leadWorkers)
        try await renderPair(name: "workspace-multi-agent", size: CGSize(width: 1280, height: 860)) {
            window(
                CodeV2EnvSessionView(session: session, composer: model, directory: CodeV2Fixtures.directory, dock: dock),
                dock: CodeV2EnvDockView(session: session, dock: dock)
            )
        }
    }

    func testWorkspaceBestOfN() async throws {
        var snapshot = CodeV2Fixtures.workingSnapshot
        var draft = CodeV2Fixtures.leadWorkers
        draft.preset = .bestOfN
        snapshot.routing = draft.routing
        let session = CodeV2EnvSession(preview: snapshot)
        let dock = CodeV2DockController()
        dock.show(.agents)
        try await renderPair(name: "dock-best-of-n", size: CGSize(width: 680, height: 420)) {
            CodeV2EnvDockView(session: session, dock: dock, bestOfN: CodeV2Fixtures.bestOfNCandidates)
        }
    }

    func testWorkspaceComputerUse() async throws {
        let session = CodeV2EnvSession(preview: CodeV2Fixtures.computerSnapshot)
        let dock = CodeV2DockController()
        dock.show(.screen)
        let model = composer(CodeV2Fixtures.claudeSelection)
        try await renderPair(name: "workspace-computer-use", size: CGSize(width: 1280, height: 760)) {
            window(
                CodeV2EnvSessionView(session: session, composer: model, directory: CodeV2Fixtures.directory, dock: dock),
                dock: CodeV2EnvDockView(session: session, dock: dock)
            )
        }
    }

    func testComposerLimited() async throws {
        let session = CodeV2EnvSession(preview: CodeV2Fixtures.limitedSnapshot)
        let model = composer(CodeV2Fixtures.claudeSelection)
        try await renderPair(name: "session-limited", size: CGSize(width: 820, height: 560)) {
            CodeV2EnvSessionView(session: session, composer: model, directory: CodeV2Fixtures.directory)
        }
    }

    // MARK: Popovers

    func testModelPicker() async throws {
        try await renderPair(name: "model-picker-subscription", size: CGSize(width: 700, height: 600)) {
            popover(CodeV2ModelPicker(
                directory: CodeV2Fixtures.directory,
                selection: .constant(CodeV2Fixtures.claudeSelection),
                threadTokens: 184_000,
                openConnections: {}
            ))
        }
        try await renderPair(name: "model-picker-alevr", size: CGSize(width: 700, height: 600)) {
            popover(CodeV2ModelPicker(
                directory: CodeV2Fixtures.directory,
                selection: .constant(CodeV2Fixtures.alevrSelection),
                threadTokens: 184_000,
                openConnections: {}
            ))
        }
    }

    func testContextTierSelector() async throws {
        try await renderPair(name: "context-tiers-alevr", size: CGSize(width: 520, height: 520)) {
            popover(CodeV2TierSelector(
                instance: CodeV2Fixtures.alevr, model: CodeV2Fixtures.gpt,
                selection: .constant(CodeV2Fixtures.alevrSelection), lean: .constant(false),
                threadTokens: 184_000
            ))
        }
        try await renderPair(name: "context-tiers-subscription", size: CGSize(width: 520, height: 360)) {
            popover(CodeV2TierSelector(
                instance: CodeV2Fixtures.claude, model: CodeV2Fixtures.claude.models![0],
                selection: .constant(CodeV2Fixtures.claudeSelection), lean: .constant(false),
                threadTokens: 184_000
            ))
        }
    }

    func testOrchestratePicker() async throws {
        try await renderPair(name: "orchestrate-lead-workers", size: CGSize(width: 680, height: 620)) {
            popover(CodeV2OrchestratePicker(directory: CodeV2Fixtures.directory, draft: .constant(CodeV2Fixtures.leadWorkers)))
        }
        var best = CodeV2Fixtures.leadWorkers
        best.preset = .bestOfN
        best.candidates = [CodeV2Fixtures.claudeSelection, CodeV2Fixtures.codexSelection, CodeV2Fixtures.alevrSelection]
        try await renderPair(name: "orchestrate-best-of-n", size: CGSize(width: 680, height: 560)) {
            popover(CodeV2OrchestratePicker(directory: CodeV2Fixtures.directory, draft: .constant(best)))
        }
    }

    func testContextCard() async throws {
        try await renderPair(name: "context-card", size: CGSize(width: 340, height: 220)) {
            popover(CodeV2ContextCard(
                reading: CodeV2ContextReading(usedTokens: 184_000, maxTokens: 272_000, costUsd: 1.84),
                compact: {}
            ))
        }
    }

    // MARK: Settings

    func testConnections() async throws {
        let hub = EnvServerHub(previewInstances: [
            CodeV2Fixtures.claude, CodeV2Fixtures.codex, CodeV2Fixtures.gemini,
            CodeV2Fixtures.grok, CodeV2Fixtures.deepseekHarness, CodeV2Fixtures.opencode,
        ])
        let keys = CodeV2KeysModel(preview: [
            ByokKeyRecord(provider: .anthropic, hint: "sk-ant-…4f2a", addedAt: CodeV2Fixtures.origin.addingTimeInterval(-86_400 * 9),
                          lastUsedAt: nil, isValid: true, location: .account),
        ])
        try await renderPair(name: "settings-connections", size: CGSize(width: 760, height: 1180)) {
            CodeV2ConnectionsView(hub: hub, keys: keys, alevrPlanLine: "Plus plan. $12.40 of $40 used this month.")
        }
    }

    // MARK: Harness

    private func window<Center: View, Dock: View>(_ center: Center, dock: Dock) -> some View {
        HStack(spacing: 0) {
            center
            Rectangle().fill(Studio.Surface.hairline).frame(width: 1)
            dock.frame(width: 460)
        }
        .background(Studio.Surface.canvas)
    }

    private func popover<Content: View>(_ content: Content) -> some View {
        ZStack {
            Studio.Surface.canvas
            content
                .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.menu, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Studio.Radius.menu, style: .continuous).strokeBorder(Studio.Surface.hairline))
                .shadow(color: .black.opacity(0.16), radius: 20, y: 10)
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
