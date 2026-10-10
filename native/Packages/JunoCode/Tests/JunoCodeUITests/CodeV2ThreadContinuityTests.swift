import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeUI

/// Remote control's sync seam for a Code v2 thread (REMOTE-CONTROL.md §5):
/// the composer's choices as the strings the backend stores, applied back
/// from another device, and an env session found by its Code thread.
@MainActor
final class CodeV2ThreadContinuityTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "code-v2-continuity-\(UUID().uuidString)"

    override func setUp() async throws {
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    private func composer() -> CodeV2ComposerModel {
        CodeV2ComposerModel(selection: CodeV2.ModelSelection(instanceId: "claude", model: "claude-opus-5", effort: .high))
    }

    func testTheComposerReadsAsSyncedPrefs() {
        let composer = composer()
        composer.runtimeMode = .full
        composer.interactionMode = .plan
        let skills = CodeSkillsModel(threadKey: "t1", defaults: defaults, selectedIDs: ["user:tidy", "project:repo-rules"])
        let prefs = CodeV2SyncedPrefs(composer: composer, skills: skills)
        XCTAssertEqual(prefs, CodeV2SyncedPrefs(
            model: "claude/claude-opus-5", effort: "high", mode: "full", interactionMode: "plan", team: "solo",
            skills: ["tidy", "repo-rules"]
        ))
    }

    func testModelKeysSplitAtTheFirstSlash() {
        XCTAssertEqual(CodeV2SyncedPrefs.parseModel("openrouter/meta-llama/llama-5")?.instanceId, "openrouter")
        XCTAssertEqual(CodeV2SyncedPrefs.parseModel("openrouter/meta-llama/llama-5")?.model, "meta-llama/llama-5")
        XCTAssertNil(CodeV2SyncedPrefs.parseModel("no-slash"))
        XCTAssertNil(CodeV2SyncedPrefs.parseModel("/model"))
    }

    func testAnotherDevicesChoicesApplyAndUnknownValuesAreLeftAlone() {
        let composer = composer()
        let skills = CodeSkillsModel(threadKey: "t2", defaults: defaults)
        CodeV2SyncedPrefs(
            model: "codex/gpt-6", effort: "low", mode: "ask", interactionMode: "plan", team: "lead-workers", skills: ["tidy"]
        ).apply(to: composer, skills: skills)
        XCTAssertEqual(composer.selection.instanceId, "codex")
        XCTAssertEqual(composer.selection.model, "gpt-6")
        XCTAssertEqual(composer.selection.effort, .low)
        XCTAssertEqual(composer.runtimeMode, .ask)
        XCTAssertEqual(composer.interactionMode, .plan)
        XCTAssertEqual(composer.roles.preset, .leadWorkers)
        XCTAssertEqual(skills.selectedIDs, ["user:tidy"])

        CodeV2SyncedPrefs(model: "garbage", effort: "turbo", mode: "yolo", team: "crowd").apply(to: composer, skills: skills)
        XCTAssertEqual(composer.selection.model, "gpt-6")
        XCTAssertEqual(composer.selection.effort, .low)
        XCTAssertEqual(composer.runtimeMode, .ask)
        XCTAssertEqual(composer.roles.preset, .leadWorkers)
    }

    func testRemoteSkillsKeepTheSourceOfAChoiceAlreadyMade() {
        let skills = CodeSkillsModel(threadKey: "t3", defaults: defaults, selectedIDs: ["project:repo-rules"])
        skills.adoptRemote(names: ["repo-rules", "tidy", "tidy"])
        XCTAssertEqual(skills.selectedIDs, ["project:repo-rules", "user:tidy"])
        XCTAssertEqual(defaults.stringArray(forKey: CodeSkillsModel.storageKey("t3")), ["project:repo-rules", "user:tidy"])
    }

    func testAnEnvSessionIsFoundByItsThread() {
        let bindings = CodeV2SessionBindings(defaults: defaults, key: "bindings")
        bindings.bind("thread-1", to: .init(envSessionId: "env-a", cwd: "/p", selection: .init(instanceId: "claude", model: "opus")))
        XCTAssertEqual(bindings.threadID(forEnvSession: "env-a"), "thread-1")
        XCTAssertNil(bindings.threadID(forEnvSession: "env-b"))
    }
}
