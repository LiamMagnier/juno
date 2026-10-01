import Foundation
import JunoCodeCore

/// Tools from Juno's extension points (§5.8–§5.12), offered to Code turns
/// through `CodeToolProviders`.
///
/// Owned by Lane F (commands, hooks, MCP, agents and composer inputs). The
/// three tools that follow background sub-agents (`await_subagents`,
/// `inspect_subagent`, `cancel_subagent`) are Lane B's, registered by
/// `VerificationToolProvider` over `BackgroundSubagents` with the rest of the
/// §5.2 runtime: Lane F's own copies were folded into those at integration,
/// so each name is offered once.
public struct ExtensionToolProvider: CodeToolProvider {
    public init() {}

    public func tools(for _: CodeToolProviderContext) async -> [any CodeTool] {
        []
    }
}
