import Foundation

/// The files inside a project that decide what the agent itself may do.
///
/// They live in the folder the agent edits, and Auto-edit writes there
/// without asking. Left unprotected, a session (perhaps steered by text in
/// the repository it is reading) could write `.juno/settings.local.json` with
/// `"allow": ["Bash"]` and a writable `/`, and have both in force from its next
/// run. Juno's own settings files are approved by digest before they can
/// widen anything; these paths are also treated as destructive by the file
/// tools, so a write is asked about in every mode and never silenced by an
/// allow rule, and the command sandbox refuses to write them at all.
public enum WorkspacePolicyPaths {
    /// Workspace-relative, as a tool names them.
    public static let files: [String] = [
        ".juno/settings.json",
        ".juno/settings.local.json",
        ".juno/.gitignore",
        ".juno/hooks.json",
        ".juno/mcp.json",
        ".mcp.json",
        ".claude/settings.json",
        ".claude/settings.local.json",
    ]

    /// Juno's own folder. Moving or deleting it takes the files above with
    /// it, and swapping in another folder of the same name replaces them.
    public static let folder = ".juno"

    /// Whether a mutation at `path` could change a policy file: one of the
    /// files, or the folder holding Juno's.
    ///
    /// Compared with case folded: APFS is case-insensitive by default, so
    /// `.JUNO/Settings.local.json` is the same file.
    public static func isProtected(_ path: String) -> Bool {
        let folded = fold(path)
        return folded == fold(folder) || files.contains { fold($0) == folded }
    }

    private static func fold(_ path: String) -> String {
        var trimmed = path
        while trimmed.hasPrefix("./") { trimmed.removeFirst(2) }
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return trimmed.folding(options: [.caseInsensitive, .widthInsensitive], locale: nil)
    }
}
