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
/// | `run_command`, `run_tests`, `shell_start` | `Bash` | `command`, `timeout` (ms) |
/// | `read_file` | `Read` | `file_path` (absolute) |
/// | `write_file`, `create_file` | `Write` | `file_path`, `content` |
/// | `apply_patch`, `edit_file` | `Edit` | `file_path`, `old_string`, `new_string`, `replace_all`; a patch envelope `file_paths`, once per file |
/// | `multi_edit` | `MultiEdit` | `file_path` |
/// | `glob`, `find_files` | `Glob` | `pattern` |
/// | `grep` | `Grep` | `pattern`, `glob`, `-i` |
/// | `list_directory` | `LS` | `path` (absolute) |
/// | `web_fetch` | `WebFetch` | `url` |
/// | `web_search` | `WebSearch` | `query` |
/// | `delegate_task` | `Task` | `prompt`, `description` |
/// | `todo_write`, `ask_user`, `exit_plan` | `TodoWrite`, `AskUserQuestion`, `ExitPlanMode` | — |
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
        "shell_start": "Bash",
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
        "todo_write": "TodoWrite",
        "ask_user": "AskUserQuestion",
        "exit_plan": "ExitPlanMode",
    ]

    /// The name hooks see for a Juno tool.
    public static func hookName(for toolName: String) -> String {
        names[toolName] ?? toolName
    }

    /// The files an `apply_patch` envelope touches, in order, a move's
    /// destination included; empty for any other call.
    public static func patchFiles(toolName: String, input: JSONValue) -> [String] {
        guard toolName == "apply_patch",
              let text = input["patch"]?.stringValue,
              let envelope = try? PatchEnvelope.parse(text)
        else { return [] }
        return envelope.paths
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
            // A patch envelope names its files inside the patch. `file_path`
            // is the one this run is about — a multi-file patch meets the
            // hooks once per file, `path` set to each — or its only file;
            // `file_paths` lists them all.
            let files = patchFiles(toolName: toolName, input: input)
            fields["file_path"] = absolute("path") ?? files.first.map { .string(absolutePath($0, root: root)) }
            if !files.isEmpty {
                fields["file_paths"] = .array(files.map { .string(absolutePath($0, root: root)) })
            }
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
            if let path = absolute("path") { fields["path"] = path }
            if let both = input["context"] { fields["-C"] = both }
            if let before = input["before_context"] { fields["-B"] = before }
            if let after = input["after_context"] { fields["-A"] = after }
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
            if let path = input["path"]?.stringValue ?? patchFiles(toolName: toolName, input: input).first {
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
