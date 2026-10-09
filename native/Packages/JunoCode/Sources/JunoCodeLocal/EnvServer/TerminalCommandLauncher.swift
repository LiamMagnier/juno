import Foundation

/// Opens Terminal with a vendor's install or sign-in command typed at the
/// prompt, not run (DESIGN §5.13: "Alevr opens a terminal with the install
/// command so you can read it first").
///
/// No AppleScript and no Automation permission: Alevr writes a `.command`
/// file and asks Launch Services to open it in Terminal (`open -a Terminal`).
/// The file starts an interactive login zsh whose start-up files are shims
/// that load the user's own (`~/.zshenv`, `~/.zprofile`, `~/.zshrc`,
/// `~/.zlogin`) and then push the command onto the line editor with
/// `print -z`. The user sees it at the prompt, reads it, and presses Return.
public struct TerminalCommandLauncher: Sendable {
    public struct Script: Equatable, Sendable {
        /// The `.command` file Terminal opens.
        public var commandFile: URL
        /// The shim `ZDOTDIR` and the files in it, by name.
        public var zdotdir: URL
        public var files: [String: String]
        public var commandFileContents: String
    }

    public let directory: URL
    private let opener: @Sendable (URL) throws -> Void

    public init(
        directory: URL = FileManager.default.temporaryDirectory.appendingPathComponent("alevr-terminal", isDirectory: true),
        opener: @escaping @Sendable (URL) throws -> Void = TerminalCommandLauncher.openInTerminal
    ) {
        self.directory = directory
        self.opener = opener
    }

    /// Single-quotes `text` for zsh: `it's` → `'it'\''s'`.
    public static func shellQuote(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Builds the files for `command`, run from `workingDirectory`.
    public func script(command: String, title: String, workingDirectory: String? = nil, id: String = UUID().uuidString) -> Script {
        let root = directory.appendingPathComponent(id, isDirectory: true)
        let zdotdir = root.appendingPathComponent("zdotdir", isDirectory: true)
        let home = "${ALEVR_USER_ZDOTDIR:-$HOME}"
        var files: [String: String] = [:]
        for name in [".zshenv", ".zprofile", ".zlogin"] {
            files[name] = "[ -f \"\(home)/\(name)\" ] && source \"\(home)/\(name)\"\n"
        }
        files[".zshrc"] = """
            [ -f "\(home)/.zshrc" ] && source "\(home)/.zshrc"
            print -P '%F{8}Alevr typed this for you. Read it, then press Return to run it.%f'
            print -z -- \(Self.shellQuote(command))

            """
        var lines = [
            "#!/bin/zsh",
            "# \(title). Written by Alevr; safe to delete.",
            "printf '\\033]0;%s\\007' \(Self.shellQuote(title))",
        ]
        if let workingDirectory { lines.append("cd \(Self.shellQuote(workingDirectory)) 2>/dev/null") }
        lines += [
            "export ALEVR_USER_ZDOTDIR=\"${ZDOTDIR:-$HOME}\"",
            "export ZDOTDIR=\(Self.shellQuote(zdotdir.path))",
            "exec /bin/zsh -il",
        ]
        return Script(
            commandFile: root.appendingPathComponent("alevr.command"),
            zdotdir: zdotdir,
            files: files,
            commandFileContents: lines.joined(separator: "\n") + "\n"
        )
    }

    /// Writes the files and opens Terminal.
    @discardableResult
    public func open(command: String, title: String, workingDirectory: String? = nil) throws -> Script {
        let script = script(command: command, title: title, workingDirectory: workingDirectory)
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: script.zdotdir, withIntermediateDirectories: true)
        for (name, contents) in script.files {
            try contents.write(to: script.zdotdir.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        try script.commandFileContents.write(to: script.commandFile, atomically: true, encoding: .utf8)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.commandFile.path)
        try opener(script.commandFile)
        return script
    }

    /// `open -a Terminal <file>`.
    public static func openInTerminal(_ file: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", "Terminal", file.path]
        try process.run()
    }
}
