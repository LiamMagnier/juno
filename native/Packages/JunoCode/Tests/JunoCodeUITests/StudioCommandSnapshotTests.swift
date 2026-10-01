import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoDesignSystem
@testable import JunoCodeUI

/// The command centre's surfaces as PNGs for review (CODE_AGENT_SPEC §6.6):
/// the slash menu, the `/context`, `/cost`, `/permissions` and `/agents`
/// sheets, the `@` picker, the hooks list with every handler kind, and the
/// loop line. Off unless `JUNO_SNAPSHOT_DIR` names a folder; drawn offscreen
/// with `cacheDisplay`, never on the screen.
@MainActor
final class StudioCommandSnapshotTests: XCTestCase {
    private var directory: URL?

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render Studio snapshots.")
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directory = url
    }

    private let models = [ModelOption(modelID: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5")]

    func testRenderSlashMenu() async throws {
        for (typed, name) in [("/", "all"), ("/go", "goal"), ("/re", "re")] {
            let controller = SessionController(previewFixture: CodePreviewData.fixture(for: .transcript))
            controller.composerText = typed
            for dark in [false, true] {
                try await render(
                    StudioSessionView(controller: controller, models: models, openReview: { _ in }),
                    size: CGSize(width: 900, height: 820),
                    dark: dark,
                    name: "slash-menu-\(name)-\(dark ? "dark" : "light")"
                )
            }
        }
    }

    func testRenderContextSheet() async throws {
        let breakdown = ContextBreakdown(
            estimates: [
                .system: 3_400, .tools: 11_200, .instructions: 1_900, .skills: 420, .sessionState: 180,
                .conversation: 22_000, .images: 14_400, .toolResults: 61_000,
            ],
            reportedTotal: 131_244,
            window: 200_000,
            compactionFraction: 0.8,
            imageCount: 9
        )
        for dark in [false, true] {
            try await render(
                StudioSheetFrame(
                    title: "Context",
                    subtitle: "What the model reads on each turn, by part. Each part is Juno's estimate, scaled to the size the provider last reported.",
                    done: {}
                ) {
                    StudioContextBreakdownView(breakdown: breakdown)
                },
                size: CGSize(width: 600, height: 560),
                dark: dark,
                name: "sheet-context-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderCostSheet() async throws {
        func ledger(_ model: String, input: Int, read: Int, output: Int) -> SessionUsageLedger {
            var ledger = SessionUsageLedger()
            for _ in 0..<12 {
                ledger.record(ModelCallUsage(purpose: .turn, inputTokens: input, outputTokens: output, cacheReadTokens: read, modelID: model))
            }
            return ledger
        }
        var session = ledger("anthropic:claude-sonnet-5", input: 48_000, read: 41_000, output: 1_800)
        let child = ledger("anthropic:claude-haiku-4-5", input: 9_000, read: 0, output: 600)
        session.add(child)
        let pricing: (String) -> CodeUsagePricing? = { model in
            model.contains("haiku")
                ? .forModel(model, providerID: "anthropic", inputPerMillion: 1, outputPerMillion: 5)
                : .forModel(model, providerID: "anthropic", inputPerMillion: 3, outputPerMillion: 15)
        }
        let breakdown = CostBreakdown(session: session, subagents: [("Survey the tests", child)], pricing: pricing)
        for dark in [false, true] {
            try await render(
                StudioSheetFrame(
                    title: "Cost",
                    subtitle: "This session's model calls at the models' published rates. An estimate: what is billed comes from the providers' own counts.",
                    done: {}
                ) {
                    StudioCostBreakdownView(breakdown: breakdown)
                },
                size: CGSize(width: 600, height: 560),
                dark: dark,
                name: "sheet-cost-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderPermissionsSheet() async throws {
        let controller = SessionController(previewFixture: CodePreviewData.fixture(for: .approval))
        for dark in [false, true] {
            try await render(
                StudioPermissionsSheet(controller: controller, done: {}),
                size: CGSize(width: 600, height: 560),
                dark: dark,
                name: "sheet-permissions-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderAgentsSheet() async throws {
        let controller = SessionController(previewFixture: CodePreviewData.fixture(for: .transcript))
        try await render(
            StudioAgentsSheet(controller: controller, done: {}),
            size: CGSize(width: 600, height: 560),
            dark: false,
            name: "sheet-agents-light"
        )
    }

    func testRenderMentionPicker() async throws {
        let entries = try [
            FileEntry(path: WorkspacePath("src/components"), isDirectory: true, byteCount: nil),
            FileEntry(path: WorkspacePath("src/components/SettingsMenu.tsx"), isDirectory: false, byteCount: 2_400),
            FileEntry(path: WorkspacePath("src/components/SettingsMenu.test.tsx"), isDirectory: false, byteCount: 1_100),
        ]
        for dark in [false, true] {
            try await render(
                VStack {
                    Spacer()
                    StudioMentionPicker(special: [.diff, .shell(id: "sh-1")], files: entries, highlighted: 2, choose: { _ in })
                        .padding(JunoSpace.regular)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Studio.Surface.canvas),
                size: CGSize(width: 620, height: 260),
                dark: dark,
                name: "mention-picker-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderHooksSettings() async throws {
        let guardHook = HookDefinition(
            event: .preToolUse, matcher: HookMatcher(pattern: "Bash"), command: "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard-rm.sh",
            source: .claude, path: ".claude/settings.json"
        )
        let ci = HookDefinition(
            event: .stop, command: "http://localhost:8787/juno/stop", source: .claude, path: ".claude/settings.json",
            kind: .http, url: URL(string: "http://localhost:8787/juno/stop")
        )
        let judge = HookDefinition(
            event: .stop, command: "Did Juno run the tests it changed? $ARGUMENTS", timeoutSeconds: 30, source: .juno,
            path: HookConfigurationFile.junoUser.path, trust: .readerConfiguration, kind: .prompt
        )
        let compact = HookDefinition(event: .preCompact, matcher: HookMatcher(pattern: "auto"), command: "./scripts/save-notes.sh", source: .juno, path: ".juno/settings.json")
        let done = HookDefinition(event: .taskCompleted, command: "./scripts/check-done.sh", source: .juno, path: ".juno/settings.json")
        let hooks = HookDiscoveryResult(hooks: [guardHook, ci, judge, compact, done])
        let policy = HookExecutionPolicy(allowedHookIDs: [guardHook.id, ci.id, compact.id], allowUntrustedHooks: true)
        for dark in [false, true] {
            try await render(
                Form { StudioHooksSettings(hooks: hooks, policy: policy, setAllowed: { _ in }) }
                    .formStyle(.grouped),
                size: CGSize(width: 720, height: 900),
                dark: dark,
                name: "settings-hooks-protocol-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderLoopLineAndAside() async throws {
        let commands = CommandCenterModel()
        commands.startLoop(every: 600, prompt: "check the deploy and say if it is green", host: SnapshotHost())
        try await render(
            VStack(spacing: JunoSpace.snug) {
                Spacer()
                StudioCommandStatusLines(commands: commands)
            }
            .padding(JunoSpace.regular)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Studio.Surface.canvas),
            size: CGSize(width: 720, height: 80),
            dark: false,
            name: "loop-line-light"
        )
        commands.stopLoops()
        try await render(
            StudioAsideSheet(
                aside: CommandCenterModel.Aside(
                    question: "Why did the lexer test fail earlier?",
                    answer: "The column was zero-based; Lexer.advance() now counts from one, and the test passes."
                ),
                done: {}
            ),
            size: CGSize(width: 600, height: 560),
            dark: false,
            name: "sheet-aside-light"
        )
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

@MainActor
private final class SnapshotHost: SlashCommandHost {
    var commandSessionIsBusy: Bool { false }
    var commandHasProject: Bool { true }
    var commandBehavior: AgentBehavior { .code }
    var commandGoal: SessionGoal? { nil }
    var commandCheckCommands: [String] { [] }
    func commandSend(_: String, behavior _: AgentBehavior?) async -> String? { nil }
    func commandCompact(focus _: String?) async {}
    func commandSetModel(_: String) async {}
    func commandNotice(_: String?) {}
    func commandCreateGoal(objective _: String) async -> String? { nil }
    func commandClearGoal() async -> String? { nil }
    func commandSetGoalLifecycle(_: GoalLifecycle) async {}
    func commandRediscoverChecks() async -> [String] { [] }
    func commandRunCheck(_: String) async {}
    func commandTranscriptMarkdown() -> String { "" }
    func commandDeliverExport(_: String, toFile _: Bool) async -> String? { nil }
    func commandFork(prompt _: String?) async -> String? { nil }
    func commandAskAside(_: String) async -> String { "" }
}
