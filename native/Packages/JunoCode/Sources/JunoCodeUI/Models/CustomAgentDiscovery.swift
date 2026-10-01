import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

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
    public enum Isolation: String, Equatable, Sendable {
        /// Runs in its own Git worktree. Write-capable children always do;
        /// for a read-only agent this changes nothing.
        case worktree
    }

    /// `<source>:<file stem>` — stable across launches, unique within a
    /// workspace, and the value ``AgentConfiguration/customAgentID`` stores.
    public let id: String
    public let name: String
    public let description: String
    public let instructions: String
    public let source: ExtensibilitySource
    /// The path the definition was read from: workspace-relative for a
    /// project agent, `~/.juno/agents/…` or `~/.claude/agents/…` for the
    /// reader's own.
    public let path: String
    /// `model:` — a model id, or nil for the parent's.
    public let model: String?
    /// `tools:` — the tools it may use, comma-separated in the file.
    public let tools: [String]?
    /// `mode:` — `read_only` or `workspace_write`; the most it may do.
    public let mode: SubagentExecutionMode?
    /// `isolation: worktree`.
    public let isolation: CustomAgentDefinition.Isolation?
    /// `maxSteps:` — a cap on the sub-agent's steps.
    public let maxSteps: Int?

    public init(
        id: String,
        name: String,
        description: String,
        instructions: String,
        source: ExtensibilitySource,
        path: String,
        model: String? = nil,
        tools: [String]? = nil,
        mode: SubagentExecutionMode? = nil,
        isolation: CustomAgentDefinition.Isolation? = nil,
        maxSteps: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.instructions = instructions
        self.source = source
        self.path = path
        self.model = model
        self.tools = tools
        self.mode = mode
        self.isolation = isolation
        self.maxSteps = maxSteps
    }

    /// The label the role picker shows — the frontmatter name, or the file stem
    /// when the file has none.
    public var displayName: String { name }

    /// Where it was declared: this project, the reader's own, or Claude
    /// Code's, imported.
    public var scope: ExtensionScope { ExtensionScope.of(path: path) }

    /// What `delegate_task`'s `agent` field calls it: the name, lowercased,
    /// with spaces as hyphens.
    public var targetName: String {
        name.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: "-")
    }

    /// The agent as a sub-agent target (§5.2), in Lane B's runtime terms.
    ///
    /// Its instructions are context for the child, never a grant: they are
    /// framed as this agent's, after Juno's own. A missing `mode:` leaves the
    /// task's mode (`workspaceWrite` only permits what the task asked for);
    /// `read_only` narrows. Claude Code tool names map to Juno's.
    public var subagent: SubagentDefinition {
        SubagentDefinition(
            name: targetName,
            description: description.isEmpty ? "Custom agent from \(path)" : description,
            prompt: "You are working as the \(name) agent (\(path)). Its instructions:\n\(instructions)",
            mode: mode ?? .workspaceWrite,
            tools: tools.map { names in
                var mapped: [String] = []
                for name in names.flatMap(Self.junoToolNames(for:)) where !mapped.contains(name) {
                    mapped.append(name)
                }
                return mapped
            },
            model: model,
            maxSteps: maxSteps,
            source: .custom(path: path)
        )
    }

    /// Juno's tools for one name an agent file lists. Claude Code's names map
    /// to the tools hooks already show under them (`HookToolNames`); any
    /// other name is taken as Juno's own, or an MCP tool's.
    static func junoToolNames(for name: String) -> [String] {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        switch trimmed {
        case "Read": return ["read_file"]
        case "Write": return ["write_file", "create_file"]
        case "Edit": return ["apply_patch", "edit_file"]
        case "MultiEdit": return ["multi_edit"]
        case "Bash": return ["run_command", "run_tests"]
        case "Glob": return ["glob", "find_files"]
        case "Grep": return ["grep"]
        case "LS": return ["list_directory"]
        case "WebFetch": return ["web_fetch"]
        case "WebSearch": return ["web_search"]
        default: return [trimmed]
        }
    }
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
    private let access: (any WorkspaceAccessing)?
    /// The reader's own folders, for `~/.juno/agents` and the read-only
    /// `~/.claude/agents` import (§5.8). Nil reads the project alone.
    private let user: UserExtensionDirectories?

    /// Bounded like the skill and instruction readers: an agent file is a
    /// system prompt, and an unbounded one is an unbounded prompt.
    public static let maximumBytes = 64 * 1_024

    public init(access: (any WorkspaceAccessing)?, user: UserExtensionDirectories? = nil) {
        self.access = access
        self.user = user
    }

    /// Every agent declared anywhere, the overridden ones included, for the
    /// `/agents` sheet: one name declared in more than one place resolves to
    /// the project's, then the reader's, then the import.
    public func discoverAll() -> (agents: [CustomAgentDefinition], overridden: [CustomAgentDefinition]) {
        var byName: [String: CustomAgentDefinition] = [:]
        var overridden: [CustomAgentDefinition] = []
        for agent in discoverProject() + discoverUser(.user) + discoverUser(.claudeImport) {
            let key = agent.targetName
            if let existing = byName[key] {
                if agent.scope < existing.scope {
                    overridden.append(existing)
                    byName[key] = agent
                } else {
                    overridden.append(agent)
                }
            } else {
                byName[key] = agent
            }
        }
        return (byName.values.sorted { $0.name.lowercased() < $1.name.lowercased() }, overridden)
    }

    /// The agents a session may use: the project's and the reader's own, and
    /// an imported one only once the reader turned it on.
    public func discoverEnabled(imports: UserExtensionPolicyStore?) -> [CustomAgentDefinition] {
        discoverAll().agents.filter { agent in
            agent.scope != .claudeImport
                || (imports?.isEnabled(kind: "agent", name: agent.targetName) ?? false)
        }
    }

    private func discoverUser(_ scope: ExtensionScope) -> [CustomAgentDefinition] {
        guard let user, let folder = user.folder(.agents, scope: scope) else { return [] }
        var byName: [String: CustomAgentDefinition] = [:]
        for entry in UserExtensionDirectories.entries(of: folder.url, directories: false) {
            guard entry.pathExtension.lowercased() == "md" else { continue }
            let stem = entry.deletingPathExtension().lastPathComponent
            guard Self.isSafeName(stem),
                  let contents = UserExtensionDirectories.readText(at: entry, maximumBytes: Self.maximumBytes),
                  let agent = Self.parse(
                      stem: stem,
                      contents: contents,
                      source: scope == .claudeImport ? .claude : .juno,
                      path: "\(folder.displayPath)/\(entry.lastPathComponent)",
                      idPrefix: scope == .claudeImport ? "claude-user" : "user"
                  )
            else { continue }
            byName[agent.targetName] = agent
        }
        return Array(byName.values)
    }

    public static func agentsDirectory(for source: ExtensibilitySource) -> String {
        switch source {
        case .claude: ".claude/agents"
        case .juno: ".juno/agents"
        }
    }

    /// The project's agents alone, as before user scope existed.
    public func discover() -> [CustomAgentDefinition] {
        discoverProject()
    }

    private func discoverProject() -> [CustomAgentDefinition] {
        guard let access else { return [] }
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
    ///
    /// Front matter (§5.2): `name`, `description`, `model`, `tools` (a
    /// comma-separated list or `[A, B]`), `mode` (`read_only`,
    /// `workspace_write`; Claude Code's `permissionMode: plan` reads as
    /// read-only), `isolation: worktree` and `maxSteps`. Anything else is
    /// ignored: these files are shared with other tools.
    public static func parse(
        stem: String,
        contents: String,
        source: ExtensibilitySource,
        path: String,
        idPrefix: String? = nil
    ) -> CustomAgentDefinition? {
        var name = stem
        var description = ""
        var model: String?
        var tools: [String]?
        var mode: SubagentExecutionMode?
        var isolation: CustomAgentDefinition.Isolation?
        var maxSteps: Int?
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
                case "model":
                    // `inherit` is Claude Code's word for the parent's model.
                    if !value.isEmpty, value.lowercased() != "inherit" { model = value }
                case "tools":
                    let list = value
                        .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
                        .split(separator: ",")
                        .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"'")) }
                        .filter { !$0.isEmpty }
                    tools = list.isEmpty ? nil : list
                case "mode", "permissionmode":
                    switch value.lowercased() {
                    case "read_only", "readonly", "read-only", "plan": mode = .readOnly
                    case "workspace_write", "write", "acceptedits": mode = .workspaceWrite
                    default: break
                    }
                case "isolation":
                    isolation = value.lowercased() == "worktree" ? .worktree : nil
                case "maxsteps", "max_steps", "maxturns":
                    maxSteps = Int(value).flatMap { $0 > 0 ? $0 : nil }
                default: continue
                }
            }
        }
        let instructions = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instructions.isEmpty else { return nil }
        return CustomAgentDefinition(
            id: "\(idPrefix ?? source.rawValue):\(stem.lowercased())",
            name: name,
            description: description,
            instructions: instructions,
            source: source,
            path: path,
            model: model,
            tools: tools,
            mode: mode,
            isolation: isolation,
            maxSteps: maxSteps
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
