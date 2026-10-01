import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
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

    func testRenderCompactionDivider() async throws {
        let modelSummary = CompactionEvent(
            summary: """
                **Requests and intent.** Parser errors carry line and column; "keep ParserError public".

                **Files and code.** `Sources/Parser/Lexer.swift` now tracks positions; \
                `Sources/Parser/ParserError.swift` gained `line` and `column`.

                **Errors and fixes.** `swift test` failed on `testNestedBlocks`: the column was \
                zero-based. Fixed in `Lexer.advance()`.

                **Current work.** Updating the three call sites in `Parser.swift`.

                **Next step.** Run `swift test --filter ParserTests`.
                """,
            beforeMessageCount: 48,
            afterMessageCount: 7,
            beforeTokens: 161_000,
            requestedByUser: true,
            summarySource: .model,
            focus: "the error-type decisions",
            summaryInputTokens: 52_000,
            summaryOutputTokens: 700
        )
        let fallback = CompactionEvent(
            summary: """
                Earlier conversation memory:
                - User: Add line numbers to parser errors
                - Called read_file {"path":"Sources/Parser/Lexer.swift"}
                - Result: 214 lines read.
                """,
            beforeMessageCount: 30,
            afterMessageCount: 8,
            summarySource: .structural,
            fallbackReason: "the model took too long"
        )
        for dark in [false, true] {
            try await render(
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    StudioAssistantMessage(text: "The lexer now records where each token starts.")
                    StudioCompactionDivider(event: modelSummary, isExpanded: .constant(false))
                    StudioCompactionDivider(event: modelSummary, isExpanded: .constant(true))
                    StudioCompactionDivider(event: fallback, isExpanded: .constant(true))
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: Studio.Metrics.measure)
                .padding(Studio.Metrics.gutter)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Studio.Surface.canvas),
                size: CGSize(width: 860, height: 820),
                dark: dark,
                name: "compaction-\(dark ? "dark" : "light")"
            )
        }
    }

    /// The autonomous loop's placeholder rows from the seams commit, one of
    /// each, so a lane replacing one can compare. Words only: no pills, no dots.
    func testRenderAutonomousLoopPlaceholderRows() async throws {
        let rows = VStack(alignment: .leading, spacing: JunoSpace.regular) {
            StudioAssistantMessage(text: "The menu now opens on pointerdown.")
            StudioContinuedRow(event: RunContinuedEvent(
                reason: .gate(.checksFailing), detail: "`npm test` failed after the last edit", revision: 3, origin: .gate
            ))
            StudioVerificationRow(record: VerificationRecord(
                command: "npm test", kind: .test, exitCode: 1, passed: false, workspaceRevision: 3, durationMs: 9_200
            ))
            StudioVerificationRow(record: VerificationRecord(
                command: "npx vitest run src/components", kind: .test, exitCode: 0, passed: true, workspaceRevision: 4, durationMs: 8_100
            ))
            PreviewCheckRow(record: UIVerificationRecord(
                surface: .web, target: "/settings", viewport: "desktop and phone", checks: [], passed: true, workspaceRevision: 4
            ))
            StudioReviewFindingsRow(record: ReviewRecord(
                round: 1,
                findings: [ReviewFinding(priority: .p3, confidence: 0.7, path: "src/components/SettingsMenu.tsx", line: 12, title: "The onOpenChange prop is unused")],
                overall: .correct,
                workspaceRevision: 4
            ))
            StudioScreenStepRow(step: StudioScreenStep(eventID: "s", verb: "Clicked", app: "TextEdit", element: "Save button", succeeded: true))
            StudioGoalVerdictRow(event: GoalVerdictEvent(goalID: "g1", verdict: .met, reason: "Both criteria have fresh evidence.", revision: 4))
            StudioCIStatusRow(event: CIStatusEvent(checks: [CICheck(name: "lint", state: .passed), CICheck(name: "test (ubuntu)", state: .failed)]))
            StudioRunReportRow(event: RunOutcomeEvent(
                endReason: .doneChecked,
                summary: "Done: the settings menu opens on click again.",
                verification: "Worked for 4m 12s · Checked with `npm test`",
                checks: [
                    RunOutcomeCheck(label: "npm run typecheck", passed: true, detail: "passed · 11 s · after the last edit"),
                    RunOutcomeCheck(label: "Preview /settings, desktop and phone", passed: true, detail: "no new console errors"),
                ],
                notChecked: ["Safari (the Preview is WebKit)"]
            ))
            Spacer(minLength: 0)
        }
        .frame(maxWidth: Studio.Metrics.measure)
        .padding(Studio.Metrics.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Studio.Surface.canvas)
        for dark in [false, true] {
            try await render(rows, size: CGSize(width: 860, height: 760), dark: dark, name: "loop-rows-\(dark ? "dark" : "light")")
        }
    }

    /// The `/` menu with `/compact` offered, and dimmed while a run works.
    func testRenderCompactInTheSlashMenu() async throws {
        for (scenario, name) in [(CodePreviewScenario.transcript, "idle"), (.streaming, "running")] {
            let controller = SessionController(previewFixture: CodePreviewData.fixture(for: scenario))
            controller.composerText = "/co"
            try await render(
                StudioSessionView(
                    controller: controller,
                    models: [ModelOption(modelID: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5")],
                    openReview: { _ in }
                ),
                size: CGSize(width: 900, height: 820),
                dark: false,
                name: "slash-compact-\(name)"
            )
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

    func testRenderRewind() async throws {
        let fixture = CodePreviewData.fixture(for: .transcript)
        let controller = SessionController(previewFixture: fixture)
        let turn = try XCTUnwrap(controller.rewindTurns.last)
        let preview = RewindPreview(
            turn: turn,
            files: [
                TurnRestoreFile(path: try WorkspacePath("Sources/Parser/Tokenizer.swift"), change: .revert, hasDiverged: false),
                TurnRestoreFile(path: try WorkspacePath("Sources/Parser/Recovery.swift"), change: .remove, hasDiverged: false),
                TurnRestoreFile(path: try WorkspacePath("Tests/ParserTests.swift"), change: .revert, hasDiverged: true),
            ],
            codeUnavailable: nil,
            conversationUnavailable: nil
        )
        let phases: [(String, StudioRewindPanel.Phase)] = [
            ("choosing", .choosing),
            ("diverged", .diverged(.codeAndConversation, paths: ["Tests/ParserTests.swift"])),
        ]
        for (name, phase) in phases {
            for dark in [false, true] {
                try await render(
                    StudioRewindPanel(
                        preview: preview,
                        phase: phase,
                        isRunning: false,
                        choose: { _ in },
                        restoreAnyway: { _ in },
                        cancel: {},
                        stop: {}
                    )
                    .padding(JunoSpace.regular)
                    .frame(width: 380)
                    .background(Studio.Surface.raised),
                    size: CGSize(width: 380, height: 460),
                    dark: dark,
                    name: "rewind-\(name)-\(dark ? "dark" : "light")"
                )
            }
        }
        try await render(
            StudioUserMessage(text: turn.text) { _ in
                StudioRewindButton(controller: controller, turnID: turn.id, isRowHovered: true)
            }
            .padding(JunoSpace.section)
            .background(Studio.Surface.canvas),
            size: CGSize(width: 760, height: 140),
            dark: false,
            name: "rewind-row-hovered"
        )
        for dark in [false, true] {
            try await render(
                StudioRewindPicker(controller: controller, dismiss: {})
                    .background(Studio.Surface.raised),
                size: CGSize(width: 480, height: 420),
                dark: dark,
                name: "rewind-picker-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderSettings() async throws {
        for section in [StudioSettingsSection.general, .permissions, .agent, .appearance] {
            try await render(
                StudioSettingsView(
                    workbench: nil,
                    initialSection: section,
                    screenControlProbe: ComputerUsePermissionProbe(screenRecording: { .granted }, accessibility: { .denied })
                ),
                size: CGSize(width: 880, height: 640),
                dark: false,
                name: "settings-\(section.rawValue)"
            )
        }
    }

    /// The hooks section of Tools & MCP, with a project's hooks allowed, one
    /// edited since, and one of the reader's own.
    func testRenderHooksSettings() async throws {
        func hook(_ event: HookLifecycleEvent, _ command: String, matcher: String? = nil, file: HookConfigurationFile) -> HookDefinition {
            HookDefinition(
                event: event,
                matcher: HookMatcher(pattern: matcher),
                command: command,
                source: file.source,
                path: file.path,
                trust: file.trust
            )
        }
        let guardHook = hook(.preToolUse, "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard-rm.sh", matcher: "Bash", file: .claudeProject)
        let format = hook(.postToolUse, "jq -r .tool_input.file_path | xargs swift-format -i", matcher: "Edit|Write", file: .claudeProject)
        let context = hook(.sessionStart, "git status --short", file: .junoProject)
        let notify = hook(.notification, "~/bin/notify \"Juno needs you\"", file: .junoUser)
        let hooks = HookDiscoveryResult(hooks: [notify, guardHook, format, context])
        let policy = HookExecutionPolicy(allowedHookIDs: [guardHook.id, format.id], allowUntrustedHooks: true)
        for dark in [false, true] {
            try await render(
                Form {
                    StudioHooksSettings(hooks: hooks, policy: policy, setAllowed: { _ in })
                }
                .formStyle(.grouped),
                size: CGSize(width: 720, height: 760),
                dark: dark,
                name: "settings-hooks-\(dark ? "dark" : "light")"
            )
        }
        // A project that switches its own hooks off: the reader's still run.
        let projectOff = HookDiscoveryResult(hooks: [notify], disabledBy: HookConfigurationFile.claudeLocal.path)
        XCTAssertFalse(projectOff.disablesReaderHooks)
        try await render(
            Form {
                StudioHooksSettings(hooks: projectOff, policy: policy, setAllowed: { _ in })
            }
            .formStyle(.grouped),
            size: CGSize(width: 720, height: 360),
            dark: false,
            name: "settings-hooks-project-off"
        )
    }

    // The screen-control settings, row, grant sheet, approval card and
    // step rows render in `StudioScreenSnapshotTests` (Lane C).

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
            store: CodeSettingsStore(
                userDirectory: root.appendingPathComponent("home/.juno"),
                approvals: CodeSettingsApprovalStore(directory: root.appendingPathComponent("approvals"))
            )
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

    // MARK: - Fixtures

    // MARK: - Rendering

    private func render<V: View>(_ view: V, size: CGSize, dark: Bool, name: String) async throws {
        guard let directory else { return }
        let hosting = NSHostingView(
            rootView: view
                .frame(width: size.width, height: size.height)
                .environment(\.colorScheme, dark ? .dark : .light)
                // Liquid Glass is composited by the window server; offscreen,
                // the composer draws its Reduce Transparency card instead.
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
