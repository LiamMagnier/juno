import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

/// Explicit reader consent for repository-declared MCP startup. The policy is
/// private app data, keyed by workspace, and stores exact declaration digests
/// rather than repository-controlled names.
public struct MCPServerPolicyStore: Sendable {
    private struct Payload: Codable, Sendable {
        let allowedServerDigests: [String]
    }

    private let fileURL: URL

    public init(storageRoot: URL, workspaceID: WorkspaceID) {
        let directory = storageRoot.appendingPathComponent("mcp-policies", isDirectory: true)
        self.fileURL = directory.appendingPathComponent(
            Digests.sha256Hex(workspaceID.value) + ".json",
            isDirectory: false
        )
    }

    public func allows(_ server: MCPServerConfiguration) -> Bool {
        guard server.enabled,
              let data = try? Data(contentsOf: fileURL),
              let payload = try? JSONDecoder().decode(Payload.self, from: data)
        else { return false }
        return Set(payload.allowedServerDigests).contains(server.consentDigest)
    }

    public func set(_ server: MCPServerConfiguration, allowed: Bool) throws {
        var digests = loadDigests()
        if allowed, server.enabled {
            digests.insert(server.consentDigest)
        } else {
            digests.remove(server.consentDigest)
        }
        let data = try JSONEncoder().encode(Payload(allowedServerDigests: digests.sorted()))
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: fileURL, options: [.atomic])
    }

    private func loadDigests() -> Set<String> {
        guard let data = try? Data(contentsOf: fileURL),
              let payload = try? JSONDecoder().decode(Payload.self, from: data)
        else { return [] }
        return Set(payload.allowedServerDigests)
    }
}

public extension MCPServerPolicyStore {
    /// Who may start a server, by where it was declared (§5.8):
    ///
    /// - a project server, only with this workspace's consent for its exact
    ///   declaration, as before;
    /// - a server in the reader's own `~/.juno/mcp.json`, always: it is the
    ///   reader's configuration and needs no workspace trust (switching it
    ///   off in Settings still removes its tools);
    /// - a server imported from Claude Code's `~/.claude.json`, only once the
    ///   reader has turned it on.
    static func startupAuthorizer(
        project: MCPServerPolicyStore,
        imports: UserExtensionPolicyStore?
    ) -> MCPServerStartupAuthorizer {
        { configuration in
            guard configuration.enabled else { return false }
            switch configuration.scope {
            case .project:
                return project.allows(configuration)
            case .user:
                return true
            case .claudeImport:
                return imports?.isEnabled(kind: "mcp", name: configuration.name) ?? false
            }
        }
    }
}
