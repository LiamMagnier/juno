import Foundation
import JunoCodeCore
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
