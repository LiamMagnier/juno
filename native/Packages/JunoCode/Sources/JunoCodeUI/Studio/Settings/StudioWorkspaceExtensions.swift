import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

/// What one project declares: its MCP servers, hooks, skills and agents, read
/// through the workspace's own access gateway.
///
/// A value the Settings page loads per project, because these live in the
/// repository and not in the account: a `.mcp.json` is a fact about a folder.
/// The page reads them on demand — opening Settings must not spawn an MCP
/// server — and the counts it shows for tools come from the live session's
/// registry when one is open, and are honestly absent otherwise.
public struct CodeWorkspaceExtensions: Equatable, Sendable {
    public var mcpServers: [MCPServerConfiguration] = []
    public var mcpConfigurationError: String?
    public var hooks: HookDiscoveryResult = HookDiscoveryResult()
    /// The reader's trust decision for the project's hooks, from private
    /// storage.
    public var hookPolicy: HookExecutionPolicy = .denyAll
    public var skills: SkillDiscoveryResult = SkillDiscoveryResult()
    /// Whether the reader trusts each skill as it reads now, by identifier.
    public var skillTrust: [String: SkillPolicyStore.TrustState] = [:]
    public var agents: [CustomAgentDefinition] = []
    /// Tools each connected MCP server reports, by server name, when a live
    /// session has connected to it. Nil means "not connected yet".
    public var mcpToolCounts: [String: Int] = [:]
    /// Exact declarations the reader explicitly approved for startup. A changed
    /// command, endpoint, argument, header or environment becomes unapproved.
    public var approvedMCPServerDigests: Set<String> = []

    public init() {}

    /// Reads a workspace's declarations. Pure filesystem work through the
    /// gateway; nothing is started.
    public static func discover(in context: WorkspaceContext) async -> CodeWorkspaceExtensions {
        var extensions = CodeWorkspaceExtensions()
        extensions.mcpServers = (try? MCPConfigurationLoader.load(from: context.access)) ?? []
        extensions.approvedMCPServerDigests = Set(
            extensions.mcpServers.filter(context.mcpPolicyStore.allows).map(\.consentDigest)
        )
        extensions.mcpConfigurationError = context.mcpConfigurationError
        extensions.hooks = HookDiscovery(
            access: context.access,
            userSettingsDirectory: context.userSettingsDirectory
        ).discover()
        // The mode does not matter to what the page shows — whether each hook
        // is allowed — so any will do.
        extensions.hookPolicy = context.hookPolicyStore.load(permissionMode: .readOnly)
        extensions.skills = SkillDiscovery(access: context.access).discover()
        for skill in extensions.skills.skills {
            extensions.skillTrust[skill.id] = context.skillPolicyStore.state(of: skill)
        }
        extensions.agents = CustomAgentDiscovery(access: context.access).discover()
        if let registry = context.mcpRegistry {
            for server in extensions.mcpServers {
                if let tools = try? await registry.cachedTools(for: server.name) {
                    extensions.mcpToolCounts[server.name] = tools.count
                }
            }
        }
        return extensions
    }
}
