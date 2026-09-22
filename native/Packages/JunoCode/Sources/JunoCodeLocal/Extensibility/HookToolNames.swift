import Foundation
import JunoCodeCore

/// How Juno's tools look to a hook.
///
/// Hooks written for Claude Code match on Claude's tool names and read
/// Claude's field names from `tool_input`, so a repository's
/// `"matcher": "Edit|Write"` guard and its `jq -r .tool_input.file_path`
/// formatter have to see the same shapes here. The mapping:
///
/// | Juno tool | Hooks see | `tool_input` adds |
/// |---|---|---|
/// | `run_command`, `run_tests` | `Bash` | `command`, `timeout` (ms) |
/// | `read_file` | `Read` | `file_path` (absolute) |
/// | `write_file`, `create_file` | `Write` | `file_path`, `content` |
/// | `apply_patch`, `edit_file` | `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
/// | `multi_edit` | `MultiEdit` | `file_path` |
/// | `glob`, `find_files` | `Glob` | `pattern` |
/// | `grep` | `Grep` | `pattern`, `glob`, `-i` |
/// | `list_directory` | `LS` | `path` (absolute) |
/// | `web_fetch` | `WebFetch` | `url` |
/// | `web_search` | `WebSearch` | `query` |
/// | `delegate_task` | `Task` | `prompt`, `description` |
/// | `mcp__server__tool` | unchanged | — |
///
/// Every other tool — `delete_file`, `move_file`, the `git_*` tools,
/// `update_goal`, screen control and previews — has no Claude Code
/// equivalent and keeps Juno's own name. Juno's original fields always stay
/// in `tool_input` beside the added ones, and a matcher may use either name.
public enum HookToolNames {
    private static let names: [String: String] = [
        "run_command": "Bash",
        "run_tests": "Bash",
        "read_file": "Read",
        "write_file": "Write",
        "create_file": "Write",
        "apply_patch": "Edit",
        "edit_file": "Edit",
        "multi_edit": "MultiEdit",
        "glob": "Glob",
        "find_files": "Glob",
        "grep": "Grep",
        "list_directory": "LS",
        "web_fetch": "WebFetch",
        "web_search": "WebSearch",
        "delegate_task": "Task",
    ]

    /// The name hooks see for a Juno tool.
    public static func hookName(for toolName: String) -> String {
        names[toolName] ?? toolName
    }

    /// The input hooks see: Juno's fields, with Claude Code's names for the
    /// same values added. Paths become absolute, as Claude Code sends them.
    public static func hookInput(toolName: String, input: JSONValue, root: String?) -> JSONValue {
        guard var fields = input.objectValue else { return input }
        func absolute(_ key: String) -> JSONValue? {
            input[key]?.stringValue.map { .string(absolutePath($0, root: root)) }
        }
        switch hookName(for: toolName) {
        case "Bash":
            if let seconds = input["timeout_seconds"]?.numberValue {
                fields["timeout"] = .number(seconds * 1_000)
            }
        case "Read", "Write", "MultiEdit":
            fields["file_path"] = absolute("path")
        case "Edit":
            fields["file_path"] = absolute("path")
            fields["old_string"] = input["target"] ?? input["old_string"]
            fields["new_string"] = input["replacement"] ?? input["new_string"]
            fields["replace_all"] = input["replace_all"] ?? .bool(false)
        case "Glob":
            fields["pattern"] = input["pattern"] ?? input["query"]
        case "Grep":
            if let include = input["include"] { fields["glob"] = include }
            if let caseSensitive = input["case_sensitive"]?.boolValue {
                fields["-i"] = .bool(!caseSensitive)
            }
        case "LS":
            fields["path"] = .string(absolutePath(input["path"]?.stringValue ?? "", root: root))
        case "Task":
            fields["prompt"] = input["task"]
            fields["description"] = input["title"] ?? input["task"]
        default:
            break
        }
        return .object(fields)
    }

    /// `tool_response`: whether the call worked and what it returned, plus the
    /// fields Claude Code's hooks most often read (`filePath` after a write,
    /// `stdout` after a command).
    public static func hookResponse(
        toolName: String,
        input: JSONValue,
        result: HookToolResult,
        root: String?
    ) -> JSONValue {
        let content = OutputLimiter.applyKeepingEnds(
            OutputLimit(maximumBytes: HookExecutionLimits.maximumToolResponseBytes),
            to: result.content
        ).text
        var fields: [String: JSONValue] = [
            "success": .bool(result.succeeded),
            "content": .string(content),
        ]
        switch hookName(for: toolName) {
        case "Bash":
            fields["stdout"] = .string(content)
            fields["stderr"] = .string("")
            fields["interrupted"] = .bool(false)
        case "Read", "Write", "Edit", "MultiEdit":
            if let path = input["path"]?.stringValue {
                fields["filePath"] = .string(absolutePath(path, root: root))
            }
        default:
            break
        }
        return .object(fields)
    }

    private static func absolutePath(_ path: String, root: String?) -> String {
        guard !path.hasPrefix("/"), let root, !root.isEmpty else { return path }
        guard !path.isEmpty, path != "." else { return root }
        return (URL(fileURLWithPath: root, isDirectory: true)
            .appendingPathComponent(path).standardizedFileURL.path)
    }
}
