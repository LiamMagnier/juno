import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoDesignSystem
@testable import JunoCodeUI

/// Lane E's surfaces as pictures: the Runs list, the CI bar, line comments
/// and findings in the diff, the interrupted row, and Fork from here
/// (CODE_AGENT_SPEC §6.5). Off unless `JUNO_SNAPSHOT_DIR` names a folder;
/// each view is drawn offscreen with `cacheDisplay`, never on the screen.
@MainActor
final class ShipSnapshotTests: XCTestCase {
    private var directory: URL?
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render the ship lane's snapshots.")
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directory = url
    }

    // MARK: - Runs list

    func testRenderRunsList() async throws {
        func entry(
            _ title: String,
            _ group: RunGroup,
            _ sentence: String,
            actions: [RunRowAction] = [],
            approval: ApprovalRequest? = nil
        ) -> RunIndexEntry {
            RunIndexEntry(
                sessionID: CodeSessionID(),
                title: title,
                project: "juno",
                group: group,
                sentence: sentence,
                approval: approval,
                actions: actions,
                updatedAt: now
            )
        }
        let approval = ApprovalRequest(
            sessionID: CodeSessionID(), actionDigest: "d", toolName: "run_command",
            summary: "Run: npm install", risk: .critical, requestedAt: now, expiresAt: now
        )
        let sections = [
            RunIndexSection(group: .needsYou, entries: [
                entry("Fix the settings menu", .needsYou, "Waiting for you to allow `npm install`", actions: [.allowOnce, .decline], approval: approval),
                entry("Migrate the store", .needsYou, "Stopped at the step limit. Keep going?", actions: [.keepGoing]),
            ]),
            RunIndexSection(group: .working, entries: [
                entry("Speed up search", .working, "Checking: `swift test`"),
            ]),
            RunIndexSection(group: .readyForReview, entries: [
                entry("Dark mode for the composer", .readyForReview, "Done · checked with `npm test` · 3 files"),
            ]),
            RunIndexSection(group: .interrupted, entries: [
                entry("Upgrade the parser", .interrupted, "Juno quit while this was running", actions: [.resume]),
            ]),
            RunIndexSection(group: .failed, entries: [
                entry("Rename the API", .failed, "Stopped with an error: the provider timed out", actions: [.retry]),
            ]),
        ]
        let view = StudioRunsList(sections: sections, open: { _ in }, answer: { _, _ in .done })
            .padding(JunoSpace.regular)
            .frame(width: 300, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(Studio.Surface.canvas)
        for dark in [false, true] {
            try await render(view, size: CGSize(width: 300, height: 620), dark: dark, name: "runs-list-\(dark ? "dark" : "light")")
        }
    }

    // MARK: - CI bar

    func testRenderCIBar() async throws {
        let ref = GitHubPullRequestRef(number: 42, url: "https://github.com/o/r/pull/42")
        let failing = CIStatusEvent(pullRequestNumber: 42, checks: [
            CICheck(name: "lint", state: .passed),
            CICheck(name: "build", state: .passed),
            CICheck(name: "typecheck", state: .passed),
            CICheck(name: "test (ubuntu)", state: .failed),
        ])
        let running = CIStatusEvent(pullRequestNumber: 42, checks: [
            CICheck(name: "lint", state: .passed),
            CICheck(name: "test (ubuntu)", state: .running),
        ])
        let states: [(String, PullRequestModel)] = [
            ("failing", { let model = PullRequestModel(); model.show(ref, status: failing, canFix: true); return model }()),
            ("running", { let model = PullRequestModel(); model.show(ref, status: running); return model }()),
            ("autofix", {
                let model = PullRequestModel()
                model.show(ref, status: failing, autoFix: CIAutoFixPolicy(isEnabled: true, attempts: [42: 1]), canFix: true)
                return model
            }()),
            ("autofix-stopped", {
                let model = PullRequestModel()
                model.show(ref, status: failing, autoFix: CIAutoFixPolicy(isEnabled: true, attempts: [42: 3]), autoFixStopped: true)
                return model
            }()),
        ]
        for (name, model) in states {
            for dark in [false, true] {
                try await render(
                    StudioCIBar(pullRequest: model)
                        .padding(JunoSpace.regular)
                        .frame(width: 720)
                        .background(Studio.Surface.canvas),
                    size: CGSize(width: 720, height: 120),
                    dark: dark,
                    name: "ci-bar-\(name)-\(dark ? "dark" : "light")"
                )
            }
        }
    }

    // MARK: - Diff

    private func hunk() throws -> DiffHunk {
        let old = "import x\nfunction Menu() {\n  const [open, setOpen] = useState(false)\n  return <button onClick={toggle}>Menu</button>\n}\n"
        let new = "function Menu() {\n  const [open, setOpen] = useState(false)\n  return <button onPointerDown={toggle}>Menu</button>\n}\n"
        return try XCTUnwrap(try DiffEngine.diff(old: old, new: new).hunks.first)
    }

    func testRenderDiffLineComments() async throws {
        let hunk = try hunk()
        let comment = QueuedReviewComment(path: "src/menu.tsx", line: 3, quotedLine: "  return <button onPointerDown={toggle}>Menu</button>", text: "Keep keyboard activation working too.")
        let review = StudioLineReview(
            path: "src/menu.tsx",
            comments: { line in line.newLineNumber == 3 ? [comment] : [] },
            findings: { _ in [] },
            addComment: { _, _ in },
            sendAll: {},
            removeComment: { _ in },
            fixFinding: { _, _ in },
            dismissFinding: { _ in }
        )
        let view = VStack(alignment: .leading, spacing: JunoSpace.snug) {
            StudioHunkView(hunk: hunk, layout: .unified, wraps: true, isReverting: false, isKept: false, failure: nil, review: review, keep: {}, revert: {})
            StudioHunkView(hunk: hunk, layout: .unified, wraps: true, isReverting: false, isKept: true, failure: nil, review: nil, keep: {}, revert: {})
            StudioLineCommentField(location: "src/menu.tsx:2", add: { _ in }, sendAll: { _ in }, cancel: {})
        }
        .padding(JunoSpace.regular)
        .frame(width: 460, alignment: .topLeading)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Studio.Surface.canvas)
        for dark in [false, true] {
            try await render(view, size: CGSize(width: 460, height: 560), dark: dark, name: "diff-line-comments-\(dark ? "dark" : "light")")
        }
    }

    func testRenderInlineFindings() async throws {
        let hunk = try hunk()
        let finding = InlineFinding(
            key: "r:0", path: "src/menu.tsx", line: 3, priority: .p1, confidence: 0.85,
            words: ReviewFindingsProjection.words(priority: .p1, confidence: 0.85),
            title: "Menu closes on the same pointerdown that opens it",
            body: "The document listener runs after the button's handler.", criterion: nil
        )
        let minor = InlineFinding(
            key: "r:1", path: "src/menu.tsx", line: 1, priority: .p3, confidence: 0.5,
            words: ReviewFindingsProjection.words(priority: .p3, confidence: 0.5),
            title: "The onOpenChange prop is unused", body: "", criterion: nil
        )
        let review = StudioLineReview(
            path: "src/menu.tsx",
            comments: { _ in [] },
            findings: { line in [finding, minor].filter { $0.line == line.newLineNumber } },
            addComment: { _, _ in },
            sendAll: {},
            removeComment: { _ in },
            fixFinding: { _, _ in },
            dismissFinding: { _ in }
        )
        let view = StudioHunkView(hunk: hunk, layout: .unified, wraps: true, isReverting: false, isKept: false, failure: nil, review: review, keep: {}, revert: {})
            .padding(JunoSpace.regular)
            .frame(width: 460, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(Studio.Surface.canvas)
        for dark in [false, true] {
            try await render(view, size: CGSize(width: 460, height: 420), dark: dark, name: "diff-inline-findings-\(dark ? "dark" : "light")")
        }
    }

    // MARK: - Interrupted and fork

    func testRenderInterruptedRow() async throws {
        let view = StudioInterruptedRow(unknownCalls: ["Run: npm run migrate"], resume: { true })
            .padding(JunoSpace.regular)
            .frame(width: 720)
            .background(Studio.Surface.canvas)
        for dark in [false, true] {
            try await render(view, size: CGSize(width: 720, height: 110), dark: dark, name: "interrupted-row-\(dark ? "dark" : "light")")
        }
    }

    /// The worktree line with a setup waiting for approval: the command is
    /// drawn verbatim, never as Markdown, so formatting cannot hide part of
    /// the bytes the approval remembers.
    func testRenderWorktreeSetupLine() async throws {
        let controller = SessionController(previewFixture: CodePreviewData.fixture(for: .transcript))
        let info = SessionWorktreeInfo(
            rootPath: "/Users/me/juno/.juno/worktrees/juno-fix-settings-1a2b",
            branch: "juno/fix-settings-12345ab",
            baseBranch: "main",
            baseRevision: "1feb392c0ffee"
        )
        let setup = "npm ci && echo `whoami` [docs](https://example.com) **done**"
        for dark in [false, true] {
            try await render(
                StudioWorktreeLine(controller: controller, info: info, setup: setup)
                    .padding(JunoSpace.regular)
                    .frame(width: 720)
                    .background(Studio.Surface.canvas),
                size: CGSize(width: 720, height: 130),
                dark: dark,
                name: "worktree-setup-\(dark ? "dark" : "light")"
            )
        }
    }

    func testRenderForkFromTurn() async throws {
        let controller = SessionController(previewFixture: CodePreviewData.fixture(for: .transcript))
        let turn = try XCTUnwrap(controller.rewindTurns.last)
        let preview = RewindPreview(
            turn: turn,
            files: [TurnRestoreFile(path: try WorkspacePath("Sources/Parser/Tokenizer.swift"), change: .revert, hasDiverged: false)],
            codeUnavailable: nil,
            conversationUnavailable: nil
        )
        for dark in [false, true] {
            try await render(
                StudioRewindPanel(
                    preview: preview,
                    phase: .choosing,
                    isRunning: false,
                    choose: { _ in },
                    restoreAnyway: { _ in },
                    cancel: {},
                    stop: {},
                    shellWarning: "These turns ran `npm run generate` and 1 more command. Files those commands changed are not restored.",
                    fork: { _ in }
                )
                .padding(JunoSpace.regular)
                .frame(width: 400)
                .background(Studio.Surface.raised),
                size: CGSize(width: 400, height: 600),
                dark: dark,
                name: "rewind-fork-\(dark ? "dark" : "light")"
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
