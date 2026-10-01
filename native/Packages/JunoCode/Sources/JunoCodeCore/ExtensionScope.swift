import Foundation

/// Where an extension — a command, an agent, a skill, an MCP server — was
/// declared, which decides how much it is trusted (CODE_AGENT_SPEC §5.8).
///
/// - `project` items live in the repository: whoever wrote the repository
///   wrote them, possibly the agent, so they keep today's per-repository
///   trust.
/// - `user` items are the reader's own configuration in `~/.juno`. They need
///   no workspace trust, the way the reader's own `~/.juno/settings.json`
///   hooks need none.
/// - `claudeImport` items are read, never written, from the reader's Claude
///   Code configuration (`~/.claude`, `~/.claude.json`). They are the
///   reader's too, but written for another tool, so each one starts switched
///   off and is listed as "from Claude Code" until the reader turns it on.
public enum ExtensionScope: String, CaseIterable, Codable, Sendable, Comparable {
    case project
    case user
    case claudeImport

    /// How the scope reads in a list: the reader's words, not a file name.
    public var label: String {
        switch self {
        case .project: "This project"
        case .user: "Yours"
        case .claudeImport: "From Claude Code"
        }
    }

    /// Precedence for one name declared in more than one place: the project
    /// wins over the reader's own, which wins over an import. Lower first.
    private var precedence: Int {
        switch self {
        case .project: 0
        case .user: 1
        case .claudeImport: 2
        }
    }

    public static func < (lhs: ExtensionScope, rhs: ExtensionScope) -> Bool {
        lhs.precedence < rhs.precedence
    }

    /// The scope a display path belongs to. Repository paths are relative;
    /// the reader's own start with `~/.juno`, an import with `~/.claude`.
    public static func of(path: String) -> ExtensionScope {
        if path.hasPrefix("~/.claude") { return .claudeImport }
        if path.hasPrefix("~/") { return .user }
        return .project
    }
}
