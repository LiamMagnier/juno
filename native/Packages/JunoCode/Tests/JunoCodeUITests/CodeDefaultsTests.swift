import Foundation
import Testing
import JunoCodeCore
@testable import JunoCodeUI

/// The standing Code preferences persist, and a session created from them
/// starts with what they say.
@MainActor
struct CodeDefaultsTests {
    private func store() -> UserDefaults {
        let name = "juno.tests.code-defaults.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test
    func valuesPersistAcrossInstances() {
        let suite = store()
        let first = CodeDefaults(store: suite)
        first.permissionMode = .workspaceWrite
        first.modelID = "anthropic:claude-opus-4-8"
        first.reasoningEffort = .high
        first.environment = .worktree
        first.worktreeLocation = "/tmp/worktrees"
        first.setMCPServer("github", enabled: false)
        first.setHook("claude:1", enabled: false)
        first.setSkill("juno:review", enabled: false)

        let second = CodeDefaults(store: suite)
        #expect(second.permissionMode == .workspaceWrite)
        #expect(second.modelID == "anthropic:claude-opus-4-8")
        #expect(second.reasoningEffort == .high)
        #expect(second.environment == .worktree)
        #expect(second.worktreeLocation == "/tmp/worktrees")
        #expect(!second.isMCPServerEnabled("github"))
        #expect(second.isMCPServerEnabled("linear"))
        #expect(!second.isHookEnabled("claude:1"))
        #expect(!second.isSkillEnabled("juno:review"))
    }

    @Test
    func cloudAndDeviceAreNeverStandingDefaults() {
        let defaults = CodeDefaults(store: store())
        defaults.environment = .cloud
        #expect(defaults.environment == .local)
        defaults.environment = .worktree
        #expect(defaults.environment == .worktree)
    }

    @Test
    func instantIsStoredAsAbsence() {
        let suite = store()
        let defaults = CodeDefaults(store: suite)
        defaults.reasoningEffort = .low
        defaults.reasoningEffort = nil
        #expect(CodeDefaults(store: suite).reasoningEffort == nil)
    }

    @Test
    func aConfigurationFallsBackToAnAvailableModel() {
        let defaults = CodeDefaults(store: store())
        defaults.modelID = "gone:model"
        defaults.permissionMode = .fullAccess
        let models = [
            ModelOption(modelID: "a:one", displayName: "One"),
            ModelOption(modelID: "a:two", displayName: "Two"),
        ]
        let configuration = defaults.configuration(availableModels: models)
        #expect(configuration.modelID == "a:one")
        #expect(configuration.permissionMode == .fullAccess)
        #expect(configuration.behavior == .code)

        defaults.modelID = "a:two"
        #expect(defaults.configuration(availableModels: models).modelID == "a:two")
    }
}
