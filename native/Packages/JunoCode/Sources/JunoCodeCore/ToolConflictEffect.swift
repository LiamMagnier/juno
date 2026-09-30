import Foundation

/// Describes the side-effect class of a tool call so the runtime scheduler
/// can determine whether multiple tool requests from a model turn can execute
/// concurrently without races or corruption.
public enum ToolConflictEffect: Hashable, Sendable {
    /// Read-only inspection that modifies no state (e.g. reading files, grep,
    /// glob, inspecting git status or directory listings).
    case readOnly(paths: Set<String>)

    /// Mutates one or more specific file paths. Can run concurrently with
    /// mutations or reads of completely disjoint files, but must serialize
    /// when paths overlap.
    case fileMutation(paths: Set<String>)

    /// Changes session state that no file holds — the todo list, a pending
    /// question, one background shell's input — named by key. Calls on the
    /// same key keep their order; anything else may run beside them.
    case sessionMutation(keys: Set<String>)

    /// Mutates repository-wide or workspace-wide state (e.g. git checkout,
    /// branch switches, worktree modifications).
    case workspaceMutation

    /// Arbitrary process execution, tests, shell commands, or computer use
    /// that cannot be guaranteed safe to run alongside other tools.
    case exclusive

    /// Returns `true` if this effect conflicts with `other` and therefore
    /// cannot execute concurrently.
    public func conflicts(with other: ToolConflictEffect) -> Bool {
        switch (self, other) {
        case (.readOnly, .readOnly):
            // Pure reads never conflict with each other, regardless of paths.
            return false

        case (.readOnly(let reads), .fileMutation(let writes)),
             (.fileMutation(let writes), .readOnly(let reads)):
            // A read and a write conflict if they target the same file.
            return !reads.intersection(writes).isEmpty

        case (.fileMutation(let writes1), .fileMutation(let writes2)):
            // Two writes conflict if their target file sets overlap.
            return !writes1.intersection(writes2).isEmpty

        case (.sessionMutation(let first), .sessionMutation(let second)):
            return !first.intersection(second).isEmpty

        case (.sessionMutation, .readOnly), (.readOnly, .sessionMutation),
             (.sessionMutation, .fileMutation), (.fileMutation, .sessionMutation):
            // Session state and the files are disjoint.
            return false

        case (.workspaceMutation, .readOnly),
             (.readOnly, .workspaceMutation):
            // Workspace mutations (e.g. git branch switch) invalidate file reads.
            return true

        case (.workspaceMutation, _),
             (_, .workspaceMutation):
            return true

        case (.exclusive, _),
             (_, .exclusive):
            return true
        }
    }
}

/// Standard classifier extracting `ToolConflictEffect` from canonical tool names
/// and their input payloads.
public enum ToolEffectClassifier {
    public static func classify(toolName: String, input: JSONValue) -> ToolConflictEffect {
        switch toolName {
        case "read_file", "list_directory":
            if let path = input["path"]?.stringValue {
                return .readOnly(paths: [path])
            }
            return .readOnly(paths: [])

        case "grep", "glob", "find_files", "web_search", "web_fetch",
             "git_status", "git_diff", "git_log", "inspect_active_editor", "use_skill":
            return .readOnly(paths: [])

        case "write_file", "create_file", "apply_patch", "multi_edit", "delete_file", "move_file":
            let paths = mutatedPaths(toolName: toolName, input: input)
            return paths.isEmpty ? .workspaceMutation : .fileMutation(paths: paths)

        case "todo_write":
            return .sessionMutation(keys: ["todos"])

        case "ask_user", "exit_plan":
            // Both wait on the reader; one card at a time, in the order asked.
            return .sessionMutation(keys: ["reader"])

        case "shell_output", "shell_write", "shell_kill":
            // In order per shell, so output read after a write sees its answer.
            let id = input["id"]?.stringValue ?? ""
            return .sessionMutation(keys: ["shell:" + id])

        case "update_goal":
            // Goal updates mutate session metadata and lifecycle in the session store;
            // they alter turn continuation and must run exclusively.
            return .exclusive

        case "delegate_task":
            // Subagents execute in isolated worktrees (for writers) or are read-only.
            // They have their own child run loops.
            return .readOnly(paths: [])

        case "git_commit":
            return .workspaceMutation

        case "run_command", "run_tests", "shell_start":
            return .exclusive

        default:
            // Screen control, previews, MCP tools and anything unknown.
            return .exclusive
        }
    }

    /// The files an editing call writes, both ends of a move and every file of
    /// a multi-file patch included.
    static func mutatedPaths(toolName: String, input: JSONValue) -> Set<String> {
        switch toolName {
        case "move_file":
            return Set([input["from"]?.stringValue, input["to"]?.stringValue].compactMap { $0 })
        case "apply_patch":
            if let text = input["patch"]?.stringValue {
                return Set((try? PatchEnvelope.parse(text).paths) ?? [])
            }
            return Set([input["path"]?.stringValue].compactMap { $0 })
        default:
            return Set([input["path"]?.stringValue].compactMap { $0 })
        }
    }
}
