import Foundation
import JunoCodeCore

/// The reader's trust in a project's skills, kept in Juno's private storage
/// beside the hook and MCP decisions, never in the repository.
///
/// A skill is trusted by identifier *and* content: the file's digest at the
/// moment the reader trusted it. An edit — a collaborator's, or the agent's
/// own — makes it a skill the reader has not read, and it stops being offered
/// until they trust it again. Repository skills start untrusted.
public struct SkillPolicyStore: Sendable {
    private struct Payload: Codable, Sendable {
        /// Skill identifier → trusted content digest.
        var trusted: [String: String]
    }

    private let fileURL: URL

    public init(storageRoot: URL, workspaceID: WorkspaceID) {
        let directory = storageRoot.appendingPathComponent("skill-policies", isDirectory: true)
        self.fileURL = directory.appendingPathComponent(
            Digests.sha256Hex(workspaceID.value) + ".json",
            isDirectory: false
        )
    }

    public enum TrustState: Equatable, Sendable {
        case untrusted
        case trusted
        /// Trusted once, edited since.
        case changedSinceTrusted
    }

    public func state(of skill: SkillDefinition) -> TrustState {
        guard let digest = load().trusted[skill.id] else { return .untrusted }
        return digest == skill.contentDigest ? .trusted : .changedSinceTrusted
    }

    public func isTrusted(_ skill: SkillDefinition) -> Bool {
        state(of: skill) == .trusted
    }

    /// Trusts the skill as it reads now, or withdraws trust.
    public func setTrusted(_ skill: SkillDefinition, trusted: Bool) throws {
        var payload = load()
        payload.trusted[skill.id] = trusted ? skill.contentDigest : nil
        let data = try JSONEncoder().encode(payload)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: fileURL, options: [.atomic])
    }

    /// Changes whenever any trust decision does, for a session to notice.
    public func fingerprint() -> String {
        let trusted = load().trusted
        return Digests.sha256Hex(trusted.keys.sorted().map { $0 + "=" + (trusted[$0] ?? "") }.joined(separator: ","))
    }

    private func load() -> Payload {
        guard let data = try? Data(contentsOf: fileURL),
              let payload = try? JSONDecoder().decode(Payload.self, from: data)
        else { return Payload(trusted: [:]) }
        return payload
    }
}

/// The skills a session may load: discovered fresh from the workspace, then
/// only those the reader trusts as they read now and has not switched off.
public struct WorkspaceSkillProvider: SkillProviding {
    private let access: any WorkspaceAccessing
    private let policy: SkillPolicyStore
    private let disabledIDs: Set<String>

    public init(access: any WorkspaceAccessing, policy: SkillPolicyStore, disabledIDs: Set<String>) {
        self.access = access
        self.policy = policy
        self.disabledIDs = disabledIDs
    }

    public func offered() -> [SkillDefinition] {
        SkillDiscovery(access: access).discover().skills.filter {
            !disabledIDs.contains($0.id) && policy.isTrusted($0)
        }
    }

    public func availableSkills() async -> [SkillSummary] {
        offered().map {
            SkillSummary(name: $0.name, description: $0.description ?? "", path: $0.path)
        }
    }

    public func loadSkill(named name: String) async throws -> LoadedSkill {
        let wanted = name.lowercased()
        let discovered = SkillDiscovery(access: access).discover().skills
        guard let skill = discovered.first(where: { $0.name == wanted }), !disabledIDs.contains(skill.id) else {
            throw SkillLoadError.unknown(name: name, available: offered().map(\.name))
        }
        switch policy.state(of: skill) {
        case .trusted:
            return LoadedSkill(name: skill.name, path: skill.path, body: skill.instructions)
        case .changedSinceTrusted:
            throw SkillLoadError.changedSinceTrusted(name: skill.name)
        case .untrusted:
            throw SkillLoadError.unknown(name: name, available: offered().map(\.name))
        }
    }
}
