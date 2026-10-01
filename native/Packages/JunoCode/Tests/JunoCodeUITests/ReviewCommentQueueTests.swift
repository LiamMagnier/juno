import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Line comments queued into the next message, Keep per hunk, the review
/// scopes, and findings on their lines (CODE_AGENT_SPEC §5.10).
@MainActor
final class ReviewCommentQueueTests: XCTestCase {
    /// The newest user message that is not the session state block.
    private static func readerMessage(in request: ModelTurnRequest) -> String? {
        request.messages.reversed().lazy.compactMap { message -> String? in
            guard case let .user(text) = message, !text.hasPrefix("<session_state") else { return nil }
            return text
        }.first
    }

    func testALineCommentSurvivesAControllerReload() async throws {
        let fixture = try await ShipFixture.make(model: ShipScriptedModel([]))
        defer { fixture.remove() }
        let (session, controller) = try await fixture.session()
        controller.queueLineComment(path: "src/menu.tsx", line: 41, quotedLine: "onClick={toggle}", text: "Open on pointerdown")

        let reloaded = SessionController(
            session: session,
            context: controller.context,
            store: fixture.workbench.sessionStore,
            modelClient: ShipScriptedModel([])
        )
        reloaded.bindShipState()
        XCTAssertEqual(reloaded.reviewQueue.comments.map(\.location), ["src/menu.tsx:41"])
        XCTAssertEqual(reloaded.reviewQueue.comments.first?.text, "Open on pointerdown")
    }

    func testTheCommentsRideOnTheNextMessageAsPathLineBlocks() async throws {
        let model = ShipScriptedModel([ShipScriptedModel.reply("On it.")])
        let fixture = try await ShipFixture.make(model: model)
        defer { fixture.remove() }
        let (_, controller) = try await fixture.session()
        controller.queueLineComment(path: "src/menu.tsx", line: 41, quotedLine: "  onClick={toggle}", text: "Open on pointerdown")
        controller.queueLineComment(path: "src/menu.tsx", line: 12, isOldLine: true, quotedLine: "import x", text: "Why was this removed?")

        try await fixture.send("Also rename the prop", on: controller)

        let request = try XCTUnwrap(model.requests.first)
        // The session state travels as its own message; the reader's is the
        // one that carries the comments.
        guard let text = Self.readerMessage(in: request) else { return XCTFail("no reader message") }
        XCTAssertTrue(text.hasSuffix("""
        Also rename the prop

        Review comments on the diff:

        src/menu.tsx:41
        >   onClick={toggle}
        Open on pointerdown

        src/menu.tsx:12 (removed line)
        > import x
        Why was this removed?
        """), text)
        XCTAssertTrue(controller.reviewQueue.comments.isEmpty, "sent comments leave the queue")
        XCTAssertEqual(controller.composerText, "", "the message the reader sent left the composer as usual")
    }

    func testSendingTheCommentsAloneLeavesTheDraftUntouched() async throws {
        let model = ShipScriptedModel([ShipScriptedModel.reply("Fixed.")])
        let fixture = try await ShipFixture.make(model: model)
        defer { fixture.remove() }
        let (_, controller) = try await fixture.session()
        controller.composerText = "A half-written thought"
        controller.queueLineComment(path: "a.swift", line: 3, quotedLine: "let x = 1", text: "Use a constant")

        let sent = await controller.sendQueuedComments()
        XCTAssertTrue(sent)
        await controller.awaitCurrentRun()

        XCTAssertEqual(controller.composerText, "A half-written thought", "the draft is never the transport")
        guard let request = model.requests.first, let text = Self.readerMessage(in: request) else {
            return XCTFail("nothing sent")
        }
        XCTAssertTrue(text.hasSuffix("Review comments on the diff:\n\na.swift:3\n> let x = 1\nUse a constant"), text)
        XCTAssertFalse(text.contains("A half-written thought"), "the draft did not go")
        XCTAssertTrue(controller.reviewQueue.comments.isEmpty)
    }

    // MARK: - Keep

    func testKeepStagesExactlyThatHunk() async throws {
        let lines = (1...30).map { "line \($0)" }
        let fixture = try await ShipFixture.make(
            model: ShipScriptedModel([]),
            git: true,
            files: ["file.txt": lines.joined(separator: "\n") + "\n"]
        )
        defer { fixture.remove() }
        var changed = lines
        changed[1] = "line 2 changed"
        changed[27] = "line 28 changed"
        try (changed.joined(separator: "\n") + "\n").write(
            to: fixture.workspace.appendingPathComponent("file.txt"),
            atomically: true,
            encoding: .utf8
        )
        let git = GitService(executor: CommandExecutionService(workspaceRootURL: fixture.workspace))
        let diff = try DiffEngine.diff(
            old: lines.joined(separator: "\n") + "\n",
            new: changed.joined(separator: "\n") + "\n"
        )
        XCTAssertEqual(diff.hunks.count, 2, "two separate changes")

        try await git.stageHunk(path: "file.txt", matching: diff.hunks[0])

        let staged = try ShipFixture.shell("git diff --cached", in: fixture.workspace)
        let unstaged = try ShipFixture.shell("git diff", in: fixture.workspace)
        XCTAssertTrue(staged.contains("+line 2 changed"), staged)
        XCTAssertFalse(staged.contains("line 28 changed"), "only the kept hunk is staged")
        XCTAssertTrue(unstaged.contains("+line 28 changed"), unstaged)
        XCTAssertFalse(unstaged.contains("line 2 changed"))

        do {
            try await git.stageHunk(path: "file.txt", matching: diff.hunks[0])
            XCTFail("keeping it twice is reported, not repeated")
        } catch let error as GitStageHunkError {
            XCTAssertEqual(error, .alreadyStaged)
        }
    }

    // MARK: - Scopes

    func testTheFourScopesListTheRightFiles() async throws {
        let fixture = try await ShipFixture.make(
            model: ShipScriptedModel([
                ShipScriptedModel.call("e", "create_file", ["path": "e.txt", "content": "made by the turn\n"]),
                ShipScriptedModel.reply("Made e.txt."),
            ]),
            git: true,
            files: ["a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n"]
        )
        defer { fixture.remove() }
        let workspace = fixture.workspace
        try ShipFixture.shell("git checkout -q -b feature && echo 'a2' > a.txt && git commit -qam 'change a'", in: workspace)
        try ShipFixture.shell("echo 'b2' > b.txt && git add b.txt && echo 'c2' > c.txt && echo d > d.txt", in: workspace)

        let (_, controller) = try await fixture.session()
        try await fixture.send("Make e.txt", on: controller)

        func paths(_ scope: ReviewScope) async -> [String] {
            await controller.loadReviewScope(scope)
            return controller.reviewQueue.scopedFiles.map(\.path).filter { !$0.hasPrefix(".juno") }.sorted()
        }
        let uncommitted = await paths(.uncommitted)
        XCTAssertEqual(uncommitted, ["b.txt", "c.txt", "d.txt", "e.txt"])
        let staged = await paths(.staged)
        XCTAssertEqual(staged, ["b.txt"])
        let branch = await paths(.branch)
        XCTAssertEqual(branch, ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"], "against the merge base with main")
        let lastTurn = await paths(.lastTurn)
        XCTAssertEqual(lastTurn, ["e.txt"])
        await controller.loadReviewScope(.staged)
        let stagedDiff = try XCTUnwrap(controller.reviewQueue.scopedFiles.first?.diff)
        XCTAssertEqual(stagedDiff.linesAdded, 1)
        XCTAssertEqual(stagedDiff.linesRemoved, 1)
    }

    // MARK: - Findings

    func testFindingsSitOnTheirLinesInWordsAndFixThisQueuesAComment() async throws {
        let fixture = try await ShipFixture.make(model: ShipScriptedModel([]))
        defer { fixture.remove() }
        let (session, controller) = try await fixture.session()
        _ = try await fixture.workbench.sessionStore.appendEvent(
            sessionID: session.id,
            payload: .reviewCompleted(ReviewRecord(
                round: 1,
                findings: [
                    ReviewFinding(priority: .p3, confidence: 0.5, path: "src/menu.tsx", line: 3, title: "Unused prop"),
                    ReviewFinding(priority: .p1, confidence: 0.85, path: "src/menu.tsx", line: 41, title: "Closes on the opening click"),
                    ReviewFinding(priority: .p2, confidence: 0.7, path: "src/menu.tsx", line: 9, title: "Gap", criterion: "c2"),
                ],
                overall: .incorrect,
                workspaceRevision: 3
            ))
        )
        for _ in 0..<200 where controller.inlineFindings.isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }
        let findings = controller.inlineFindings
        XCTAssertEqual(findings.map(\.line), [41, 9, 3], "most serious first")
        XCTAssertEqual(findings.map(\.words), [
            "Correctness, high confidence",
            "Requirement c2, medium confidence",
            "Minor, low confidence",
        ])

        controller.fixFinding(findings[0], quotedLine: "onClick={toggle}")
        XCTAssertEqual(controller.reviewQueue.comments.map(\.location), ["src/menu.tsx:41"])
        XCTAssertTrue(controller.reviewQueue.comments[0].text.hasPrefix("Fix this (Correctness, high confidence): Closes on the opening click"))
        XCTAssertFalse(controller.inlineFindings.contains { $0.line == 41 }, "a finding queued as a comment leaves the diff")

        controller.reviewQueue.dismiss(try XCTUnwrap(controller.inlineFindings.first { $0.line == 3 }))
        XCTAssertEqual(controller.inlineFindings.map(\.line), [9])
    }
}
