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
    /// The agents `delegate_task` may name (§5.2): Lane B's built-ins, then
    /// the session's custom agents (Lane F's discovery). See
    /// ``CustomSubagentTargets``.
    var subagentTargets: any SubagentDefinitionResolving {
        SubagentDefinitions(custom: CustomSubagentTargets(customAgents))
    }
}

/// A session's custom agents as sub-agent targets, by name.
///
/// A built-in's name always belongs to the built-in (``SubagentDefinitions``
/// asks the built-ins first). The reviewer and the verifier are how Juno
/// checks its own work, and their answers are parsed (the reviewer's JSON
/// findings, §1.9): a `.juno/agents/reviewer.md` that answers "no findings"
/// would turn every self-review into the agent grading itself, and one in
/// `~/.juno/agents` would break the review's protocol. Such a file is listed
/// in `/agents` as not used, never silently applied.
public struct CustomSubagentTargets: SubagentDefinitionResolving {
    private let definitions: [SubagentDefinition]

    public init(_ custom: [CustomAgentDefinition]) {
        var byName: [String: SubagentDefinition] = [:]
        for agent in custom where !agent.isShadowedByBuiltIn {
            byName[agent.targetName] = agent.subagent
        }
        definitions = byName.values.sorted { $0.name < $1.name }
    }

    public func definition(named name: String) async -> SubagentDefinition? {
        let wanted = name.lowercased()
        return definitions.first { $0.name == wanted }
    }

    public func all() async -> [SubagentDefinition] {
        definitions
    }
}

public extension CustomAgentDefinition {
    /// True for any custom agent that has a built-in's name: the built-in
    /// keeps the name (``CustomSubagentTargets``).
    var isShadowedByBuiltIn: Bool {
        BuiltInAgents.named(targetName) != nil
    }
}
