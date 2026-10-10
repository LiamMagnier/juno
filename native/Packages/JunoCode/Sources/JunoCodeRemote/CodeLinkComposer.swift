import Foundation
import JunoCodeCore
import JunoSync

/// A provider instance and the models it offers, for the Model menu.
public struct CodeLinkModelGroup: Equatable, Sendable, Identifiable {
    public var instance: CodeV2.ProviderInstance
    public var models: [CodeV2.ProviderModel]
    public var id: String { instance.id }

    /// "Claude (your subscription)", "Alevr", "ChatGPT (Codex)".
    public var title: String { instance.label }

    /// A subscription the person signed in to on the Mac, not Alevr's credits.
    public var isSubscription: Bool { CodeV2.runsOnEnvServer(instance.kind) }

    /// The one honest line under the group.
    public var note: String {
        if isSubscription { return "Counts against your \(CodeV2ProviderDirectory.vendorName(instance)) plan on the Mac." }
        if instance.kind == .byok { return "Billed to your own key." }
        return "Billed to your Alevr plan."
    }
}

/// The remote composer's choices, as plain data: model, effort, mode,
/// plan mode, team and skills, and the `turn.start` they make.
public struct CodeLinkComposerState: Equatable, Sendable {
    public var selection: CodeV2.ModelSelection?
    public var runtimeMode: CodeV2.RuntimeMode = .ask
    public var interactionMode: CodeV2.InteractionMode = .default
    public var team: CodeV2Team.Preset = .solo
    /// Selected skill names (from `skills.list`).
    public var skills: [String] = []

    public init(
        selection: CodeV2.ModelSelection? = nil, runtimeMode: CodeV2.RuntimeMode = .ask,
        interactionMode: CodeV2.InteractionMode = .default, team: CodeV2Team.Preset = .solo, skills: [String] = []
    ) {
        self.selection = selection
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.team = team
        self.skills = skills
    }

    /// The modes the Mode menu offers, gentlest first.
    public static let modes: [CodeV2.RuntimeMode] = [.ask, .autoEdit, .auto, .full, .readOnly]

    // MARK: Catalogue

    /// Every instance that can run a turn now, in the picker's order, with its models.
    public static func catalogue(_ instances: [CodeV2.ProviderInstance]) -> [CodeLinkModelGroup] {
        CodeV2ProviderDirectory(instances: instances).rail.compactMap { instance in
            guard instance.status == .ready || instance.status == .limited,
                  let models = instance.models, !models.isEmpty
            else { return nil }
            return CodeLinkModelGroup(instance: instance, models: models)
        }
    }

    public static func model(_ selection: CodeV2.ModelSelection?, in catalogue: [CodeLinkModelGroup]) -> (CodeLinkModelGroup, CodeV2.ProviderModel)? {
        guard let selection, let group = catalogue.first(where: { $0.instance.id == selection.instanceId }),
              let model = group.models.first(where: { $0.id == selection.model })
        else { return nil }
        return (group, model)
    }

    /// The model's effort levels, else its runtime's.
    public func effortLevels(in catalogue: [CodeLinkModelGroup]) -> [CodeV2.EffortLevel] {
        guard let (group, model) = Self.model(selection, in: catalogue) else { return [] }
        return model.effortLevels ?? group.instance.capabilities?.effortLevels ?? []
    }

    /// Picks a model, keeping the effort when the new model offers it.
    public mutating func choose(instance: CodeV2.ProviderInstance, model: CodeV2.ProviderModel) {
        let levels = model.effortLevels ?? instance.capabilities?.effortLevels ?? []
        let effort = selection?.effort.flatMap { levels.contains($0) ? $0 : nil } ?? model.defaultEffort
        selection = CodeV2.ModelSelection(instanceId: instance.id, model: model.id, effort: effort)
    }

    public mutating func setEffort(_ effort: CodeV2.EffortLevel?) {
        selection?.effort = effort
    }

    /// The default when nothing is chosen: the catalogue's default model, else its first.
    public mutating func fillDefault(from catalogue: [CodeLinkModelGroup]) {
        if let selection, Self.model(selection, in: catalogue) != nil { return }
        if selection != nil, catalogue.isEmpty { return }
        for group in catalogue {
            if let model = group.models.first(where: { $0.isDefault == true }) {
                choose(instance: group.instance, model: model)
                return
            }
        }
        if let group = catalogue.first, let model = group.models.first { choose(instance: group.instance, model: model) }
    }

    /// Takes a thread's own settings (opening it).
    public mutating func adopt(_ snapshot: CodeV2.SessionSnapshot) {
        selection = snapshot.selection
        runtimeMode = snapshot.runtimeMode
        interactionMode = snapshot.interactionMode
        team = snapshot.routing.map { CodeV2Team.Preset($0.preset) } ?? .solo
        skills = (snapshot.skills ?? []).filter { $0.once != true }.map(\.name)
    }

    // MARK: Turn

    /// The team's routing, nil for Solo.
    public var routing: CodeV2.RoleRouting? {
        guard team != .solo, let selection else { return nil }
        var draft = CodeV2RoleDraft(lead: selection)
        draft.applyTeamPreset(team)
        return draft.routing
    }

    /// The selected skills as activations, from what `skills.list` reported.
    public func activations(from available: [CodeV2.LocalSkillSummary]) -> [CodeV2.SkillActivation]? {
        let chosen = skills.compactMap { name in available.first { $0.name == name } }
        guard !chosen.isEmpty else { return nil }
        return chosen.map { CodeV2.SkillActivation(name: $0.name, source: $0.source, path: $0.path) }
    }

    /// `turn.start` for `text` in `sessionId`; nil without a model.
    public func turnStart(
        sessionId: String, text: String, skills available: [CodeV2.LocalSkillSummary] = []
    ) -> CodeLinkClient.TurnStartParams? {
        guard let selection else { return nil }
        return CodeLinkClient.TurnStartParams(
            sessionId: sessionId,
            input: CodeV2.UserInput(text: text, skills: activations(from: available)),
            selection: selection,
            routing: routing,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode
        )
    }

    // MARK: Thread sync

    /// What the thread carries to other devices.
    public var prefs: ThreadSyncPrefs {
        ThreadSyncPrefs(
            model: selection.map { "\($0.instanceId):\($0.model)" },
            effort: selection?.effort?.rawValue,
            mode: runtimeMode.rawValue,
            interactionMode: interactionMode.rawValue,
            team: team.contractPreset.rawValue,
            skills: skills
        )
    }

    /// Applies another device's prefs. The model resolves against the
    /// catalogue (instance ids contain colons, so the longest known one wins).
    public mutating func apply(_ prefs: ThreadSyncPrefs, catalogue: [CodeLinkModelGroup]) {
        if let raw = prefs.model {
            let match = catalogue
                .filter { raw.hasPrefix($0.instance.id + ":") }
                .max { $0.instance.id.count < $1.instance.id.count }
            if let group = match {
                let modelID = String(raw.dropFirst(group.instance.id.count + 1))
                if let model = group.models.first(where: { $0.id == modelID }) {
                    choose(instance: group.instance, model: model)
                }
            }
        }
        if let effort = prefs.effort.flatMap(CodeV2.EffortLevel.init(rawValue:)) { setEffort(effort) }
        if let mode = prefs.mode.flatMap(CodeV2.RuntimeMode.init(rawValue:)) { runtimeMode = mode }
        if let mode = prefs.interactionMode.flatMap(CodeV2.InteractionMode.init(rawValue:)) { interactionMode = mode }
        if let team = prefs.team.flatMap(CodeV2.RolePreset.init(rawValue:)) { self.team = CodeV2Team.Preset(team) }
        if let skills = prefs.skills { self.skills = skills }
    }

    // MARK: Words

    /// The Model chip: "Opus 5.5 · High".
    public func modelLabel(in catalogue: [CodeLinkModelGroup]) -> String {
        guard let selection else { return "Choose a model" }
        let name = Self.model(selection, in: catalogue)?.1.label ?? CodeV2Formatting.modelName(selection.model)
        guard let effort = selection.effort, effort != .none else { return name }
        return "\(name) · \(effort.title)"
    }

    /// Full access said plainly, where the person chooses it.
    public static let fullAccessWarning =
        "Full access runs any command and edits any file in this folder on your Mac without asking. Use it in a worktree you can throw away."
}
