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

    public init(userDirectory: URL = CodeSettingsStore.defaultUserDirectory) {
        self.userDirectory = userDirectory
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

    /// Every layer applied, lowest first. The two files inside the project
    /// apply without their allow rules for screen input, which only the
    /// reader's own file may hold.
    public func resolved(projectRoot: URL?) -> ResolvedCodeSettings {
        var layers = [load(.user, projectRoot: nil)]
        if projectRoot != nil {
            layers.append(load(.project, projectRoot: projectRoot).withoutScreenInputAllowances)
            layers.append(load(.local, projectRoot: projectRoot).withoutScreenInputAllowances)
        }
        return ResolvedCodeSettings.resolve(layers)
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

    /// Read-modify-write of one file.
    public func update(
        _ scope: Scope,
        projectRoot: URL?,
        _ change: (inout CodeSettingsFile) -> Void
    ) throws {
        var file = load(scope, projectRoot: projectRoot)
        change(&file)
        try save(file, to: scope, projectRoot: projectRoot)
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

    /// Where an "Always allow" answer is saved. Ordinarily this project's
    /// personal file: it is this reader's trust, not the team's. With no
    /// project, and for screen input wherever it was given, the reader's own
    /// file — no project file can allow screen input
    /// (`CodeSettingsFile.withoutScreenInputAllowances`), and the screen it
    /// acts on is the same whichever project asked.
    public static func alwaysAllowScope(for rule: PermissionRule, projectRoot: URL?) -> Scope {
        if rule.coversScreenInput || projectRoot == nil { return .user }
        return .local
    }

    /// Saves an "Always allow" answer to the file `alwaysAllowScope` names.
    public func rememberAllowRule(_ rule: PermissionRule, projectRoot: URL?) throws {
        try addAllowRule(
            rule,
            scope: Self.alwaysAllowScope(for: rule, projectRoot: projectRoot),
            projectRoot: projectRoot
        )
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
