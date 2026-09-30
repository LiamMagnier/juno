import Foundation
import JunoCodeCore
import JunoCodeLocal

/// The skills a session may load, read as the reader has them at the moment
/// of asking: their Settings switches and their trust in each skill's current
/// text.
///
/// `use_skill` is registered once per orchestrator so the tool list stays the
/// same for a whole session, which keeps the cached prefix warm. A provider
/// holding the switches from when it was built would then keep loading a
/// skill the reader had since switched off, so this one asks again each time.
struct SessionSkillProvider: SkillProviding {
    let context: WorkspaceContext

    /// The skills offered now: discovered fresh, trusted as they read, and
    /// not switched off.
    @MainActor
    static func offered(in context: WorkspaceContext) -> [SkillDefinition] {
        context.skillProvider(disabledIDs: CodeDefaults.shared.disabledSkills).offered()
    }

    func availableSkills() async -> [SkillSummary] {
        await current().availableSkills()
    }

    func loadSkill(named name: String) async throws -> LoadedSkill {
        try await current().loadSkill(named: name)
    }

    private func current() async -> WorkspaceSkillProvider {
        let disabled = await MainActor.run { CodeDefaults.shared.disabledSkills }
        return context.skillProvider(disabledIDs: disabled)
    }
}
