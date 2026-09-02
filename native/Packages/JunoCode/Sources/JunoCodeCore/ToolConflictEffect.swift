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
        case "read_file":
            if let path = input["path"]?.stringValue {
                return .readOnly(paths: [path])
            }
            return .readOnly(paths: [])

        case "grep", "glob", "web_search", "fetch_url":
            return .readOnly(paths: [])

        case "git_status", "git_diff", "git_log":
            return .readOnly(paths: [])

        case "write_file", "apply_patch", "delete_file":
            if let path = input["path"]?.stringValue {
                return .fileMutation(paths: [path])
            }
            return .workspaceMutation

        case "update_goal":
            // Goal updates mutate session metadata and lifecycle in the session store;
            // they alter turn continuation and must run exclusively.
            return .exclusive

        case "delegate_task":
            // Subagents execute in isolated worktrees (for writers) or are read-only.
            // They have their own child run loops.
            return .readOnly(paths: [])

        case "git_commit", "git_checkout", "git_branch":
            return .workspaceMutation

        case "run_command", "run_tests", "terminal_command":
            return .exclusive

        case "computer_action", "screen_capture":
            return .exclusive

        default:
            return .exclusive
        }
    }
}
