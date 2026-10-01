import Foundation
import JunoCodeCore

/// An agent `delegate_task` can start by name (CODE_AGENT_SPEC §5.2): one of
/// Juno's built-ins, or a custom agent from `.juno/agents`, `.claude/agents`,
/// `~/.juno/agents`, or an imported `~/.claude/agents` file the reader turned
/// on.
///
/// An agent narrows; it never widens. Its `mode` can make a write-capable
/// task read-only but not the reverse, its `tools` list can only remove tools
/// from the registry the task's mode allows, its step cap can only lower the
/// child's, and the parent's permission rules and mode bind it as they bind
/// every child. Its instructions are context, like an `AGENTS.md`: they cannot
/// grant a permission or skip an approval.
public struct SubagentDefinition: Equatable, Sendable {
    public enum Isolation: String, Equatable, Sendable {
        /// Runs in its own Git worktree. Write-capable children always do;
        /// for a read-only agent this changes nothing.
        case worktree
    }

    /// What `delegate_task`'s `agent` field names: lowercased.
    public let name: String
    public let displayName: String
    public let description: String
    public let instructions: String
    /// A model id, or nil for the task's or the parent's.
    public let model: String?
    /// Tool names the agent may use, Claude Code's (`Read`, `Grep`, `Bash`…)
    /// or Juno's, or nil for every tool its mode allows.
    public let tools: [String]?
    /// The most the agent may do; nil leaves it to the task.
    public let mode: SubagentExecutionMode?
    public let isolation: Isolation?
    public let maxSteps: Int?
    /// Where it was defined, as a reader would find it: "Built in", or the
    /// file's path.
    public let origin: String

    public init(
        name: String,
        displayName: String? = nil,
        description: String,
        instructions: String,
        model: String? = nil,
        tools: [String]? = nil,
        mode: SubagentExecutionMode? = nil,
        isolation: Isolation? = nil,
        maxSteps: Int? = nil,
        origin: String
    ) {
        self.name = name.lowercased()
        self.displayName = displayName ?? name
        self.description = description
        self.instructions = instructions
        self.model = model
        self.tools = tools
        self.mode = mode
        self.isolation = isolation
        self.maxSteps = maxSteps
        self.origin = origin
    }

    /// The narrower of the task's mode and the agent's.
    public func effectiveMode(requested: SubagentExecutionMode) -> SubagentExecutionMode {
        guard let mode else { return requested }
        return mode == .readOnly || requested == .readOnly ? .readOnly : .workspaceWrite
    }

    /// The child's step cap: the lower of the default and the agent's.
    public func effectiveSteps(default steps: Int) -> Int {
        guard let maxSteps, maxSteps > 0 else { return steps }
        return min(steps, maxSteps)
    }

    /// The registry's tools the agent may use, in the registry's order.
    public func allowedTools(from tools: [any CodeTool]) -> [any CodeTool] {
        guard let allowlist = self.tools else { return tools }
        let allowed = Set(allowlist.flatMap(Self.junoNames(for:)))
        return tools.filter { allowed.contains($0.name) }
    }

    /// Juno's tools for one name an agent file lists. Claude Code's names map
    /// to the tools hooks already show under them (`HookToolNames`); any
    /// other name is taken as Juno's own, or an MCP tool's.
    static func junoNames(for name: String) -> [String] {
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

    /// Juno's built-in agents. Read-only by construction.
    ///
    /// The reviewer's JSON findings protocol and the verifier's checks belong
    /// to the verification lane (§1.9, §1.8); these are the agents as targets,
    /// with prompts that already ask for the same shape.
    public static let builtIns: [SubagentDefinition] = [
        SubagentDefinition(
            name: "explorer",
            displayName: "Explorer",
            description: "Read-only search: finds where things are and how they connect.",
            instructions: """
                You are Juno's explorer. Search the project read-only and answer the question you \
                were given with file paths and line numbers. Prefer breadth first, then read the \
                files that matter. Do not propose changes unless asked.
                """,
            mode: .readOnly,
            maxSteps: 18,
            origin: "Built in"
        ),
        SubagentDefinition(
            name: "reviewer",
            displayName: "Reviewer",
            description: "Reads a diff in a fresh context and reports correctness, security and unmet requirements.",
            instructions: """
                You are Juno's reviewer. Read the change you were given as a careful reviewer would. \
                Report only correctness problems, security problems and requirements the change does \
                not meet; a clean review is a valid answer. For each finding give a priority (P0 to P3), \
                a confidence from 0 to 1, the path and line, a one-line title and a short explanation.
                """,
            mode: .readOnly,
            maxSteps: 18,
            origin: "Built in"
        ),
        SubagentDefinition(
            name: "verifier",
            displayName: "Verifier",
            description: "Checks whether work meets its criteria, reading the code and the recorded evidence.",
            instructions: """
                You are Juno's verifier. For each criterion you were given, find the evidence that it \
                is met (a recorded check, a file and line) or say plainly that there is none. Effort, \
                intent and a plausible summary are not evidence.
                """,
            mode: .readOnly,
            maxSteps: 18,
            origin: "Built in"
        ),
    ]
}
