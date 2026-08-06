import Foundation
import JunoCodeCore

/// Stores the user's explicit hook trust decision outside the repository.
/// Repository configuration is untrusted input and must never be able to turn
/// itself on by being edited. The file contains only hook IDs and the trust bit;
/// the current session permission mode is supplied by the caller at load time.
public struct HookPolicyStore: Sendable {
    private struct Payload: Codable, Sendable {
        let allowedHookIDs: [String]
        let allowUntrustedHooks: Bool
    }

    private let fileURL: URL

    public init(storageRoot: URL, workspaceID: WorkspaceID) {
        let directory = storageRoot.appendingPathComponent("hook-policies", isDirectory: true)
        self.fileURL = directory.appendingPathComponent(
            Digests.sha256Hex(workspaceID.value) + ".json",
            isDirectory: false
        )
    }

    public func load(permissionMode: PermissionMode) -> HookExecutionPolicy {
        guard let data = try? Data(contentsOf: fileURL),
              let payload = try? JSONDecoder().decode(Payload.self, from: data)
        else {
            return HookExecutionPolicy(permissionMode: permissionMode)
        }
        return HookExecutionPolicy(
            allowedHookIDs: Set(payload.allowedHookIDs),
            permissionMode: permissionMode,
            allowUntrustedHooks: payload.allowUntrustedHooks
        )
    }

    public func save(_ policy: HookExecutionPolicy) throws {
        let payload = Payload(
            allowedHookIDs: policy.allowedHookIDs.sorted(),
            allowUntrustedHooks: policy.allowUntrustedHooks
        )
        let data = try JSONEncoder().encode(payload)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: fileURL, options: [.atomic])
    }
}
