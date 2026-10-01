import Foundation
import JunoCodeCore

/// The reader's own configuration folders, injectable so a test never reads
/// the home folder of whoever runs it.
public struct UserExtensionDirectories: Equatable, Sendable {
    /// `~/.juno`: commands, agents, skills, `mcp.json`, `settings.json`.
    public let junoHome: URL
    /// `~/.claude`: Claude Code's commands, agents and skills, read only.
    public let claudeHome: URL
    /// `~/.claude.json`: Claude Code's user `mcpServers`, read only.
    public let claudeConfigFile: URL

    public init(junoHome: URL, claudeHome: URL, claudeConfigFile: URL) {
        self.junoHome = junoHome
        self.claudeHome = claudeHome
        self.claudeConfigFile = claudeConfigFile
    }

    /// The folders beside a `~/.juno` folder: its parent is the home folder
    /// that holds `.claude` and `.claude.json`.
    public init(junoHome: URL) {
        let home = junoHome.deletingLastPathComponent()
        self.init(
            junoHome: junoHome,
            claudeHome: home.appendingPathComponent(".claude", isDirectory: true),
            claudeConfigFile: home.appendingPathComponent(".claude.json", isDirectory: false)
        )
    }

    public static var standard: UserExtensionDirectories {
        UserExtensionDirectories(
            junoHome: FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".juno", isDirectory: true)
        )
    }

    /// One kind of item's folder in a scope, with the path a reader
    /// recognises.
    public func folder(_ kind: Kind, scope: ExtensionScope) -> (url: URL, displayPath: String)? {
        switch scope {
        case .project:
            return nil
        case .user:
            return (junoHome.appendingPathComponent(kind.rawValue, isDirectory: true), "~/.juno/\(kind.rawValue)")
        case .claudeImport:
            return (claudeHome.appendingPathComponent(kind.rawValue, isDirectory: true), "~/.claude/\(kind.rawValue)")
        }
    }

    public enum Kind: String, Sendable {
        case commands
        case agents
        case skills
    }

    /// Reads a small UTF-8 file in one of the reader's folders, refusing
    /// anything over `maximumBytes` or that is not a regular file. Symlinks
    /// are followed: these are the reader's own folders, and a reader who
    /// links their dotfiles in from elsewhere means it.
    public static func readText(at url: URL, maximumBytes: Int) -> String? {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true,
              (values.fileSize ?? 0) <= maximumBytes,
              let data = try? Data(contentsOf: url),
              data.count <= maximumBytes
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// The entries of one of the reader's folders, sorted, or none.
    public static func entries(of url: URL, directories: Bool) -> [URL] {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }
        return entries
            .filter { ((try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true) == directories }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}

/// Which items imported from Claude Code the reader has turned on.
///
/// Kept in the reader's own `~/.juno` folder, beside `settings.json`: the
/// decision is about the reader's configuration, not any project, and no
/// repository can reach it. Items are keyed by kind and name, so turning on
/// `~/.claude/agents/reviewer.md` keeps it on when the file is edited — it
/// is the reader's file, and an edit is the reader's edit.
public struct UserExtensionPolicyStore: Sendable {
    private struct Payload: Codable, Sendable {
        var enabledImports: [String]
    }

    private let fileURL: URL

    public init(junoHome: URL) {
        self.fileURL = junoHome.appendingPathComponent("imports.json", isDirectory: false)
    }

    public static func key(kind: String, name: String) -> String {
        "\(kind):\(name.lowercased())"
    }

    public func isEnabled(kind: String, name: String) -> Bool {
        load().contains(Self.key(kind: kind, name: name))
    }

    public func setEnabled(_ enabled: Bool, kind: String, name: String) throws {
        var keys = load()
        let key = Self.key(kind: kind, name: name)
        if enabled { keys.insert(key) } else { keys.remove(key) }
        let data = try JSONEncoder().encode(Payload(enabledImports: keys.sorted()))
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: fileURL, options: [.atomic])
    }

    /// Changes whenever a decision does, for a session to notice.
    public func fingerprint() -> String {
        Digests.sha256Hex(load().sorted().joined(separator: ","))
    }

    private func load() -> Set<String> {
        guard let data = try? Data(contentsOf: fileURL),
              let payload = try? JSONDecoder().decode(Payload.self, from: data)
        else { return [] }
        return Set(payload.enabledImports)
    }
}
