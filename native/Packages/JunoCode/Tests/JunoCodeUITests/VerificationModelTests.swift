import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeUI

private struct NoTools: VerifyDiscoveryEnvironment {
    func isInstalled(_: String) async -> Bool { false }
    func run(_: [String], in _: URL) async -> String? { nil }
}

/// When the recipe card asks, and what each answer does (CODE_AGENT_SPEC §1.8).
@MainActor
final class VerificationModelTests: XCTestCase {
    private var base: URL!
    private var project: URL!
    private var model: VerificationModel!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-verify-model-\(UUID().uuidString)")
        project = base.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try #"{"scripts": {"test": "vitest run", "lint": "eslint ."}, "devDependencies": {"vitest": "3"}}"#
            .write(to: project.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        let base = base!
        model = VerificationModel(makeStore: { root in
            VerifyRecipeStore(
                workspaceRoot: root,
                approvals: VerifyRecipeApprovalStore(directory: base.appendingPathComponent("approvals")),
                settings: CodeSettingsStore(
                    userDirectory: base.appendingPathComponent("home/.juno"),
                    approvals: CodeSettingsApprovalStore(directory: base.appendingPathComponent("settings-approvals"))
                ),
                discovery: VerifyRecipeDiscovery(workspaceRoot: root, environment: NoTools())
            )
        })
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: base)
    }

    private let session = CodeSessionID()
    private var sequence = 0

    private func event(_ payload: SessionEventPayload) -> SessionEvent {
        sequence += 1
        return SessionEvent(sessionID: session, sequence: sequence, timestamp: Date(), payload: payload)
    }

    private func changed() throws -> SessionEvent {
        event(.fileChanged(FileChangedEvent(path: try WorkspacePath("src/a.ts"), kind: .modified, linesAdded: 1, linesRemoved: 0, checkpointID: nil)))
    }

    func testTheCardWaitsForTheFirstRunThatChangesAFile() async throws {
        let prompt = event(.userPrompt(UserPromptEvent(text: "explain the code")))
        await model.update(workspaceRoot: project, events: [prompt])
        XCTAssertNil(model.proposal, "nothing changed, nothing to check")

        let edit = try changed()
        await model.update(workspaceRoot: project, events: [prompt, edit])
        let proposal = try XCTUnwrap(model.proposal)
        XCTAssertEqual(proposal.kind, .discovered)
        XCTAssertEqual(proposal.recipe.checks.map(\.commandLine), ["npm run lint", "npm test"])
        XCTAssertFalse(model.runWithoutAsking, "the second option is off until ticked")

        // A new message with no change yet does not take the card away.
        await model.update(workspaceRoot: project, events: [prompt, edit, event(.userPrompt(UserPromptEvent(text: "next")))])
        XCTAssertNotNil(model.proposal)
    }

    func testNotNowIsNotAskedAgainInThisSession() async throws {
        let events = [event(.userPrompt(UserPromptEvent(text: "fix"))), try changed()]
        await model.update(workspaceRoot: project, events: events)
        XCTAssertNotNil(model.proposal)
        model.dismiss()
        XCTAssertNil(model.proposal)
        await model.update(workspaceRoot: project, events: events + [event(.userPrompt(UserPromptEvent(text: "more"))), try changed()])
        XCTAssertNil(model.proposal)
    }

    func testAcceptingSavesTheRecipeAndOnlyWritesRulesWhenTicked() async throws {
        await model.update(workspaceRoot: project, events: [event(.userPrompt(UserPromptEvent(text: "fix"))), try changed()])
        XCTAssertNotNil(model.proposal)
        await model.accept(workspaceRoot: project)
        XCTAssertNil(model.proposal)
        XCTAssertEqual(model.confirmation, "Saved 2 checks to .juno/verify.json.")
        XCTAssertTrue(FileManager.default.fileExists(atPath: project.appendingPathComponent(".juno/verify.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: project.appendingPathComponent(".juno/settings.local.json").path))
    }

    func testTickingRunWithoutAskingWritesTheListedRules() async throws {
        await model.update(workspaceRoot: project, events: [event(.userPrompt(UserPromptEvent(text: "fix"))), try changed()])
        let rules = try XCTUnwrap(model.proposal?.rules)
        XCTAssertEqual(rules.map(\.description), ["Bash(npm run lint)", "Bash(npm test)", "Bash(npx vitest run *)"])
        model.runWithoutAsking = true
        await model.accept(workspaceRoot: project)
        XCTAssertEqual(model.confirmation, "Saved 2 checks to .juno/verify.json. They run without asking in this repository.")
        let local = CodeSettingsStore(userDirectory: base.appendingPathComponent("home/.juno")).load(.local, projectRoot: project)
        XCTAssertEqual(local.permissions?.allow, rules)
    }

    func testAChangedFileAsksAgainBeforeItsCommandsAreUsed() async throws {
        let recipe = VerifyRecipe(checks: [VerifyCheck(id: "t", kind: .test, run: .shell("npm test"))])
        let folder = project.appendingPathComponent(".juno")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try recipe.encoded().write(to: folder.appendingPathComponent("verify.json"))
        await model.update(workspaceRoot: project, events: [])
        guard case .changed? = model.proposal?.kind else { return XCTFail("an unaccepted file asks at once") }
        await model.accept(workspaceRoot: project)
        XCTAssertEqual(model.confirmation, "Using the checks in .juno/verify.json.")
        await model.update(workspaceRoot: project, events: [event(.userPrompt(UserPromptEvent(text: "x")))])
        XCTAssertNil(model.proposal, "accepted bytes ask nothing")
    }

    func testTheCardSaysTheExactRulesAndItsTwoAnswersApart() {
        let rules = [PermissionRule(tool: "Bash", specifier: "npm test")]
        XCTAssertEqual(
            StudioVerifyRecipeCard.rulesCaption(rules, on: true),
            "Adds Bash(npm test) to .juno/settings.local.json, which stays on this Mac. You can remove them in /permissions."
        )
        XCTAssertTrue(StudioVerifyRecipeCard.rulesCaption(rules, on: false).hasPrefix("Otherwise each command asks before it runs"))
        XCTAssertEqual(
            StudioVerifyRecipeCard.title(for: .init(recipe: VerifyRecipe(checks: []), kind: .discovered)),
            "Use these as this project's checks?"
        )
    }

    /// A recipe file that appeared while the card for found checks was open
    /// is kept, and the card says so instead of overwriting it.
    func testAFileThatAppearedWhileTheCardWasOpenIsKept() async throws {
        await model.update(workspaceRoot: project, events: [event(.userPrompt(UserPromptEvent(text: "x"))), try changed()])
        guard case .discovered? = model.proposal?.kind else { return XCTFail("expected the found checks") }
        let theirs = VerifyRecipe(checks: [VerifyCheck(id: "theirs", kind: .test, run: .shell("make test"))])
        let folder = project.appendingPathComponent(".juno")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try theirs.encoded().write(to: folder.appendingPathComponent("verify.json"))
        await model.accept(workspaceRoot: project)
        XCTAssertNil(model.proposal)
        XCTAssertEqual(model.problem, ".juno/verify.json appeared while this was open, so it was kept as it is. Look at its checks.")
        XCTAssertEqual(try VerifyRecipe.decode(Data(contentsOf: folder.appendingPathComponent("verify.json"))), theirs)
    }

    /// The run report's divider renders the model's commands as code, never as
    /// a link: a backtick inside a command must not open a `[words](url)`.
    func testTheReportDividerNeverMakesALink() {
        let caption = "Checked with `npm test -- \"`[Open settings](https://example.com/phish)`\"`"
        let rendered = StudioRunReportRow.inlineCode(caption)
        XCTAssertTrue(rendered.runs.allSatisfy { $0.link == nil })
        XCTAssertTrue(String(rendered.characters).contains("Open settings"), "the words stay, as text")
    }
}
