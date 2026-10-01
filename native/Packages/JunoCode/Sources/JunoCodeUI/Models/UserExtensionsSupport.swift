import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

public extension WorkspaceContext {
    /// The reader's own configuration folders beside the `~/.juno` this
    /// workspace reads settings from (§5.8), or nil where it reads none — a
    /// test that must not pick up whoever runs it.
    var userExtensionDirectories: UserExtensionDirectories? {
        userSettingsDirectory.map { UserExtensionDirectories(junoHome: $0) }
    }

    /// Which Claude Code imports the reader has turned on.
    var userExtensionPolicy: UserExtensionPolicyStore? {
        userSettingsDirectory.map { UserExtensionPolicyStore(junoHome: $0) }
    }
}

extension SessionController {
    /// The agents `delegate_task` may name (§5.2): Juno's built-ins and the
    /// session's custom agents. See ``SubagentDefinition/targets(custom:)``.
    var subagentTargets: [SubagentDefinition] {
        SubagentDefinition.targets(custom: customAgents)
    }
}

public extension SubagentDefinition {
    /// The agents a session's `delegate_task` may name: Juno's built-ins and
    /// `custom`, by name.
    ///
    /// A built-in's name belongs to the built-in unless the reader's own
    /// `~/.juno/agents` takes it. The reviewer and the verifier are how Juno
    /// checks its own work, and a project file is one the agent can write
    /// without asking in Auto-edit (`.juno/agents` is not a policy path): a
    /// `.juno/agents/reviewer.md` that answers "no findings" would have
    /// turned every self-review into the agent grading itself. Such a file is
    /// listed in `/agents` as not used, never silently applied.
    static func targets(custom: [CustomAgentDefinition]) -> [SubagentDefinition] {
        var byName: [String: SubagentDefinition] = [:]
        for agent in builtIns { byName[agent.name] = agent }
        for agent in custom where !agent.isShadowedByBuiltIn {
            byName[agent.targetName] = agent.subagent
        }
        return byName.values.sorted { $0.name < $1.name }
    }

    /// The built-ins' names.
    static var builtInNames: Set<String> { Set(builtIns.map(\.name)) }
}

public extension CustomAgentDefinition {
    /// True for a project's or an imported agent that has a built-in's name:
    /// the built-in keeps the name (``SubagentDefinition/targets(custom:)``).
    var isShadowedByBuiltIn: Bool {
        scope != .user && SubagentDefinition.builtInNames.contains(targetName)
    }
}
