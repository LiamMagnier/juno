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
    /// session's custom agents, a custom agent replacing a built-in of the
    /// same name.
    var subagentTargets: [SubagentDefinition] {
        var byName: [String: SubagentDefinition] = [:]
        for agent in SubagentDefinition.builtIns { byName[agent.name] = agent }
        for agent in customAgents.map(\.subagent) { byName[agent.name] = agent }
        return byName.values.sorted { $0.name < $1.name }
    }
}
