import Foundation
import JunoCodeCore

/// Reads and writes the three Juno Code settings files.
///
/// Stateless on purpose: every read goes to disk. The files are small, a
/// session reads them once per run, and a cache would be one more thing to
/// invalidate when the reader edits `settings.json` in their own editor.
public struct CodeSettingsStore: Sendable {
    public enum Scope: String, CaseIterable, Sendable {
        /// `~/.juno/settings.json`
        case user
        /// `<project>/.juno/settings.json`, shared through Git.
        case project
        /// `<project>/.juno/settings.local.json`, this Mac only.
        case local
    }

    public let userDirectory: URL
    /// The reader's approvals of project files, kept outside every project.
    public let approvals: CodeSettingsApprovalStore

    public init(
        userDirectory: URL = CodeSettingsStore.defaultUserDirectory,
        approvals: CodeSettingsApprovalStore = CodeSettingsApprovalStore()
    ) {
        self.userDirectory = userDirectory
        self.approvals = approvals
    }

    public static var defaultUserDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".juno", isDirectory: true)
    }

    public func url(for scope: Scope, projectRoot: URL?) -> URL? {
        switch scope {
        case .user:
            return userDirectory.appendingPathComponent("settings.json")
        case .project:
            return projectRoot?.appendingPathComponent(".juno/settings.json")
        case .local:
            return projectRoot?.appendingPathComponent(".juno/settings.local.json")
        }
    }

    /// One file, or an empty document when it is absent or unreadable.
    public func load(_ scope: Scope, projectRoot: URL?) -> CodeSettingsFile {
        guard let url = url(for: scope, projectRoot: projectRoot),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(CodeSettingsFile.self, from: data)
        else { return CodeSettingsFile() }
        return file
    }

    /// Whether a file exists but could not be read — worth telling the reader
    /// rather than silently running without their rules.
    public func loadError(_ scope: Scope, projectRoot: URL?) -> String? {
        guard let url = url(for: scope, projectRoot: projectRoot),
              let data = try? Data(contentsOf: url)
        else { return nil }
        do {
            _ = try JSONDecoder().decode(CodeSettingsFile.self, from: data)
            return nil
        } catch {
            return "\(url.lastPathComponent) could not be read: \(error.localizedDescription)"
        }
    }

    /// The reader's personal instructions file, `~/.juno/JUNO.md` or
    /// `~/.juno/AGENTS.md` — the one that follows them into every project.
    public func userInstructionsFile(maximumBytes: Int = 32 * 1_024) -> String? {
        for name in ["JUNO.md", "AGENTS.md"] {
            let url = userDirectory.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url), !data.isEmpty else { continue }
            let text = String(decoding: data.prefix(maximumBytes), as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return text }
        }
        return nil
    }

    public func userInstructionsURL() -> URL {
        userDirectory.appendingPathComponent("JUNO.md")
    }

    /// Every layer, lowest first, each marked with whether the reader has
    /// approved it as it now reads.
    public func layers(projectRoot: URL?) -> [CodeSettingsLayer] {
        var layers = [CodeSettingsLayer(load(.user, projectRoot: nil), origin: .user, isApproved: true)]
        if let projectRoot {
            for (scope, origin) in [(Scope.project, CodeSettingsLayer.Origin.project), (.local, .local)] {
                layers.append(
                    CodeSettingsLayer(
                        load(scope, projectRoot: projectRoot),
                        origin: origin,
                        isApproved: isApproved(scope, projectRoot: projectRoot)
                    )
                )
            }
        }
        return layers
    }

    /// Every layer applied, lowest first.
    public func resolved(projectRoot: URL?) -> ResolvedCodeSettings {
        ResolvedCodeSettings.resolve(
            layers(projectRoot: projectRoot),
            projectRoot: projectRoot,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser
        )
    }

    // MARK: - Approval

    /// A digest of the file's exact bytes, or nil when there is no file.
    public func digest(_ scope: Scope, projectRoot: URL?) -> String? {
        guard let url = url(for: scope, projectRoot: projectRoot),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return Digests.sha256Hex(data)
    }

    /// Whether the file may widen what the agent can do. The reader's own
    /// file always may; a project file only as the reader approved it, and a
    /// file that is not there asks for nothing.
    public func isApproved(_ scope: Scope, projectRoot: URL?) -> Bool {
        guard scope != .user else { return true }
        guard let projectRoot, let digest = digest(scope, projectRoot: projectRoot) else { return true }
        return approvals.approvedDigest(scope, projectRoot: projectRoot) == digest
    }

    /// The project files that ask for something the reader has not approved,
    /// and so are in force only where they narrow the agent.
    public func awaitingApproval(projectRoot: URL?) -> [Scope] {
        guard let projectRoot else { return [] }
        return [Scope.project, .local].filter { scope in
            !isApproved(scope, projectRoot: projectRoot)
                && load(scope, projectRoot: projectRoot).loosensAnything
        }
    }

    /// Approves the file as it now reads. Any later change to it, by anyone,
    /// withdraws the approval.
    public func approve(_ scope: Scope, projectRoot: URL) throws {
        guard scope != .user else { return }
        try approvals.setApprovedDigest(
            digest(scope, projectRoot: projectRoot),
            scope,
            projectRoot: projectRoot
        )
    }

    public func save(_ file: CodeSettingsFile, to scope: Scope, projectRoot: URL?) throws {
        guard let url = url(for: scope, projectRoot: projectRoot) else {
            throw CocoaError(.fileNoSuchFile)
        }
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(file).write(to: url, options: .atomic)
        if scope == .local, let projectRoot {
            ensureLocalFileIsIgnored(projectRoot: projectRoot)
        }
    }

    /// Read-modify-write of one file, on the reader's behalf.
    ///
    /// A file the reader had approved, or that did not exist, is approved as
    /// written: the change is theirs. One that was awaiting approval stays
    /// that way, so an edit made through Juno can never approve what someone
    /// else put in the file first.
    public func update(
        _ scope: Scope,
        projectRoot: URL?,
        _ change: (inout CodeSettingsFile) -> Void
    ) throws {
        let wasApproved = isApproved(scope, projectRoot: projectRoot)
        var file = load(scope, projectRoot: projectRoot)
        change(&file)
        try save(file, to: scope, projectRoot: projectRoot)
        if wasApproved, scope != .user, let projectRoot {
            try approve(scope, projectRoot: projectRoot)
        }
    }

    /// Adds one allow rule — what "Always allow" on an approval writes.
    public func addAllowRule(_ rule: PermissionRule, scope: Scope, projectRoot: URL?) throws {
        try update(scope, projectRoot: projectRoot) { file in
            var permissions = file.permissions ?? CodeSettingsFile.Permissions()
            var allow = permissions.allow ?? []
            if !allow.contains(rule) { allow.append(rule) }
            permissions.allow = allow
            file.permissions = permissions
        }
    }

    /// `settings.local.json` is personal. A reader who commits it by accident
    /// publishes their allow-list, so the first write adds it to the
    /// project's `.juno/.gitignore`.
    private func ensureLocalFileIsIgnored(projectRoot: URL) {
        let ignore = projectRoot.appendingPathComponent(".juno/.gitignore")
        let line = "settings.local.json"
        let existing = (try? String(contentsOf: ignore, encoding: .utf8)) ?? ""
        guard !existing.split(separator: "\n").contains(where: { $0.trimmingCharacters(in: .whitespaces) == line })
        else { return }
        let updated = existing.isEmpty || existing.hasSuffix("\n")
            ? existing + line + "\n"
            : existing + "\n" + line + "\n"
        try? updated.write(to: ignore, atomically: true, encoding: .utf8)
    }
}

/// The reader's approval of a project's settings files, kept in Juno's own
/// storage rather than the project.
///
/// Like `HookPolicyStore` and `MCPServerPolicyStore`: repository content is
/// untrusted input and must never be able to approve itself by being edited.
/// What is stored is a digest of the exact bytes approved, per file, so any
/// change to the file, by a teammate's commit or the agent's own write,
/// withdraws the approval until the reader looks again. Keyed by the
/// project's canonical path, because the settings files belong to a folder,
/// not to an account.
public struct CodeSettingsApprovalStore: Sendable {
    private struct Payload: Codable, Sendable {
        var project: String?
        var local: String?
    }

    public let directory: URL

    public init(directory: URL = CodeSettingsApprovalStore.defaultDirectory) {
        self.directory = directory
    }

    public static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("JunoCode", isDirectory: true)
            .appendingPathComponent("settings-approvals", isDirectory: true)
    }

    public func approvedDigest(_ scope: CodeSettingsStore.Scope, projectRoot: URL) -> String? {
        let payload = load(projectRoot)
        switch scope {
        case .user: return nil
        case .project: return payload.project
        case .local: return payload.local
        }
    }

    /// Records `digest` as the approved version of the file, or withdraws the
    /// approval when it is nil.
    public func setApprovedDigest(
        _ digest: String?,
        _ scope: CodeSettingsStore.Scope,
        projectRoot: URL
    ) throws {
        var payload = load(projectRoot)
        switch scope {
        case .user: return
        case .project: payload.project = digest
        case .local: payload.local = digest
        }
        let url = fileURL(projectRoot)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(payload).write(to: url, options: .atomic)
    }

    private func load(_ projectRoot: URL) -> Payload {
        guard let data = try? Data(contentsOf: fileURL(projectRoot)),
              let payload = try? JSONDecoder().decode(Payload.self, from: data)
        else { return Payload() }
        return payload
    }

    private func fileURL(_ projectRoot: URL) -> URL {
        let canonical = projectRoot.resolvingSymlinksInPath().standardizedFileURL.path
        return directory.appendingPathComponent(Digests.sha256Hex(canonical) + ".json")
    }
}
