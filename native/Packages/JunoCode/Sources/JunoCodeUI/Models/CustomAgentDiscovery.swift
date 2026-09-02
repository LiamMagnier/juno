import Foundation
import JunoCodeCore
import JunoCodeLocal

/// A workspace-authored agent: a Markdown file whose frontmatter names it and
/// whose body is the instruction it works under.
///
/// The format is the one Claude Code established for `.claude/agents/*.md`
/// (`name:`, `description:`, then the system prompt), read from `.juno/agents`
/// as well so a repository can carry Juno's own without duplicating the file.
/// It is discovered, never trusted: an agent's instructions are context for the
/// model in the same sense a `CLAUDE.md` is, and cannot widen permissions,
/// pick a model or bypass an approval.
public struct CustomAgentDefinition: Identifiable, Equatable, Sendable {
    /// `<source>:<file stem>` — stable across launches, unique within a
    /// workspace, and the value ``AgentConfiguration/customAgentID`` stores.
    public let id: String
    public let name: String
    public let description: String
    public let instructions: String
    public let source: ExtensibilitySource
    /// The workspace-relative path the definition was read from.
    public let path: String

    public init(
        id: String,
        name: String,
        description: String,
        instructions: String,
        source: ExtensibilitySource,
        path: String
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.instructions = instructions
        self.source = source
        self.path = path
    }

    /// The label the role picker shows — the frontmatter name, or the file stem
    /// when the file has none.
    public var displayName: String { name }
}

/// One entry in a role picker: a built-in ``AgentRole`` or a discovered agent.
public enum AgentRoleOption: Identifiable, Equatable, Sendable {
    case builtIn(AgentRole)
    case custom(CustomAgentDefinition)

    public var id: String {
        switch self {
        case .builtIn(let role): "builtin:\(role.rawValue)"
        case .custom(let agent): agent.id
        }
    }

    public var label: String {
        switch self {
        case .builtIn(let role):
            switch role {
            case .engineer: "Engineer"
            case .reviewer: "Reviewer"
            case .explainer: "Explainer"
            }
        case .custom(let agent): agent.displayName
        }
    }

    public var detail: String {
        switch self {
        case .builtIn(let role):
            switch role {
            case .engineer: "A pragmatic senior engineer who carries the task through."
            case .reviewer: "Reviews for correctness and risk; changes nothing unasked."
            case .explainer: "Explains code and trade-offs in plain language."
            }
        case .custom(let agent):
            agent.description.isEmpty ? agent.path : agent.description
        }
    }

    /// Built-ins first, then the workspace's own, so a picker with nothing
    /// discovered is the same picker it always was.
    public static func options(custom: [CustomAgentDefinition]) -> [AgentRoleOption] {
        AgentRole.allCases.map(AgentRoleOption.builtIn) + custom.map(AgentRoleOption.custom)
    }
}

/// Reads `.claude/agents/*.md` and `.juno/agents/*.md` through the workspace's
/// own access gateway, so a symlink cannot pull a file in from outside the
/// granted folder.
public struct CustomAgentDiscovery: Sendable {
    private let access: any WorkspaceAccessing

    /// Bounded like the skill and instruction readers: an agent file is a
    /// system prompt, and an unbounded one is an unbounded prompt.
    public static let maximumBytes = 64 * 1_024

    public init(access: any WorkspaceAccessing) {
        self.access = access
    }

    public static func agentsDirectory(for source: ExtensibilitySource) -> String {
        switch source {
        case .claude: ".claude/agents"
        case .juno: ".juno/agents"
        }
    }

    public func discover() -> [CustomAgentDefinition] {
        var byName: [String: CustomAgentDefinition] = [:]
        // Claude first, Juno second, so the Juno file wins a name collision —
        // the same precedence slash commands and skills use.
        for source in [ExtensibilitySource.claude, .juno] {
            let directory = Self.agentsDirectory(for: source)
            guard let directoryPath = try? WorkspacePath(directory),
                  let directoryURL = try? access.resolveForReading(directoryPath),
                  let entries = try? FileManager.default.contentsOfDirectory(
                      at: directoryURL,
                      includingPropertiesForKeys: [.isRegularFileKey]
                  )
            else { continue }
            for entry in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                guard entry.pathExtension.lowercased() == "md" else { continue }
                let stem = entry.deletingPathExtension().lastPathComponent
                guard Self.isSafeName(stem) else { continue }
                let relative = "\(directory)/\(entry.lastPathComponent)"
                guard let filePath = try? WorkspacePath(relative),
                      let fileURL = try? access.resolveForReading(filePath),
                      let data = try? Data(contentsOf: fileURL),
                      data.count <= Self.maximumBytes,
                      let contents = String(data: data, encoding: .utf8),
                      let agent = Self.parse(
                          stem: stem,
                          contents: contents,
                          source: source,
                          path: relative
                      )
                else { continue }
                byName[agent.name.lowercased()] = agent
            }
        }
        return byName.values.sorted { $0.name.lowercased() < $1.name.lowercased() }
    }

    /// Parses one agent file. Public so the format is pinned by a test rather
    /// than by whichever repository happens to be open.
    public static func parse(
        stem: String,
        contents: String,
        source: ExtensibilitySource,
        path: String
    ) -> CustomAgentDefinition? {
        var name = stem
        var description = ""
        var body = contents
        if let frontmatter = frontmatter(of: contents) {
            body = frontmatter.body
            for line in frontmatter.header.split(separator: "\n", omittingEmptySubsequences: true) {
                let parts = line.split(separator: ":", maxSplits: 1).map {
                    $0.trimmingCharacters(in: .whitespaces)
                }
                guard parts.count == 2 else { continue }
                let value = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                switch parts[0].lowercased() {
                case "name": if !value.isEmpty { name = value }
                case "description": description = value
                default: continue
                }
            }
        }
        let instructions = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instructions.isEmpty else { return nil }
        return CustomAgentDefinition(
            id: "\(source.rawValue):\(stem.lowercased())",
            name: name,
            description: description,
            instructions: instructions,
            source: source,
            path: path
        )
    }

    private static func frontmatter(of contents: String) -> (header: String, body: String)? {
        let lines = contents.components(separatedBy: "\n")
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---" else { return nil }
        guard let end = lines.dropFirst().firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces) == "---"
        }) else { return nil }
        return (
            lines[1..<end].joined(separator: "\n"),
            lines[(end + 1)...].joined(separator: "\n")
        )
    }

    /// Letters, digits, `-` and `_` only. A stem is also part of the stored
    /// identifier, and an identifier with a path separator in it is a path.
    static func isSafeName(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 64 && name.allSatisfy {
            $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_"
        }
    }
}
