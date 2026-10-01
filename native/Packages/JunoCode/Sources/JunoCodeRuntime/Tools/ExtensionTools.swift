import Foundation
import JunoCodeCore

/// Tools from Juno's extension points (§5.8–§5.12), such as MCP resources.
///
/// Owned by Lane F (commands, hooks, MCP, agents and composer inputs).
/// Empty in the seams commit (CODE_AGENT_SPEC §6.0): the lane registers its
/// tools here and the session reaches them through `CodeToolProviders`, so no
/// shared file changes when they land.
public struct ExtensionToolProvider: CodeToolProvider {
    public init() {}

    public func tools(for _: CodeToolProviderContext) async -> [any CodeTool] {
        []
    }
}
