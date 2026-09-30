import Foundation
import JunoCodeCore

/// The workspace paths one tool call reaches, for context that belongs to a
/// place: a folder's instruction file is due the first time a call reads,
/// writes, lists or runs a command there.
public enum ToolTouchedPaths {
    public static func paths(toolName: String, input: JSONValue) -> [WorkspacePath] {
        let raw: [String]
        switch toolName {
        case "read_file", "write_file", "create_file", "multi_edit", "delete_file",
             "list_directory", "grep":
            raw = [input["path"]?.stringValue].compactMap { $0 }
        case "apply_patch":
            if let text = input["patch"]?.stringValue {
                raw = (try? PatchEnvelope.parse(text).paths) ?? []
            } else {
                raw = [input["path"]?.stringValue].compactMap { $0 }
            }
        case "move_file":
            raw = [input["from"]?.stringValue, input["to"]?.stringValue].compactMap { $0 }
        case "run_command", "shell_start":
            raw = [input["cwd"]?.stringValue].compactMap { $0 }
        default:
            raw = []
        }
        return raw.compactMap { try? WorkspacePath($0) }
    }
}
