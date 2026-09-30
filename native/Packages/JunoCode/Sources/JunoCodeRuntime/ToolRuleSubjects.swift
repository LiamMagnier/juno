import Foundation
import JunoCodeCore

/// What a permission rule sees of each invocation.
///
/// One mapping here rather than a method on every tool: the rule grammar is
/// about *kinds* of action — a command, a path, a host — and keeping the
/// projection in one place is what keeps `Edit(src/**)` meaning the same thing
/// for all six editing tools.
public enum ToolRuleSubjects {
    public static func subject(toolName: String, input: JSONValue) -> PermissionRuleSubject? {
        switch toolName {
        case "run_command", "run_tests", "shell_start":
            return input["command"]?.stringValue.map(PermissionRuleSubject.command)
        case "git_status":
            return .command("git status")
        case "git_diff":
            return .command("git diff")
        case "git_log":
            return .command("git log")
        case "git_commit":
            return .command("git commit")
        case "move_file":
            // Both ends: the file leaves one folder and lands in another, and
            // an `Edit(secrets/**)` deny speaks about either.
            let ends = [input["from"]?.stringValue, input["to"]?.stringValue].compactMap { $0 }
            return ends.isEmpty ? nil : .paths(ends)
        case "apply_patch":
            if let text = input["patch"]?.stringValue {
                guard let paths = try? PatchEnvelope.parse(text).paths, !paths.isEmpty else { return nil }
                return paths.count == 1 ? .path(paths[0]) : .paths(paths)
            }
            return input["path"]?.stringValue.map(PermissionRuleSubject.path)
        case "read_file", "write_file", "create_file", "multi_edit",
             "delete_file", "list_directory", "grep", "glob", "find_files":
            return input["path"]?.stringValue.map(PermissionRuleSubject.path)
        case "web_fetch":
            guard let text = input["url"]?.stringValue,
                  let host = URL(string: text)?.host
            else { return nil }
            return .domain(host)
        default:
            return nil
        }
    }
}
