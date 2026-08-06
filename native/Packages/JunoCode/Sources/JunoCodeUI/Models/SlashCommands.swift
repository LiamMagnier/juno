import Foundation
import JunoCodeCore
import JunoCodeLocal

/// Saved prompts, addressed by typing `/name` in the composer.
///
/// Every agent people compare Juno Code to has this — Claude Code reads
/// `.claude/commands/*.md`, Codex has its own prompt library — and it is the
/// feature a team actually notices the absence of, because the prompts worth
/// keeping are the repository's own: "review this the way we review", "run the
/// suite the way CI runs it". Juno Code had no way to keep one, so every session
/// retyped them.
///
/// Two sources, and the precedence matters:
///
/// 1. **The workspace**, from `.juno/commands/*.md` — and `.claude/commands/*.md`
///    as well, because a repository that already carries those should not have
///    to duplicate them to be useful here. A workspace command **overrides** a
///    built-in of the same name: the repository knows more about how it wants to
///    be reviewed than Juno's defaults do.
/// 2. **The built-ins** below, so a fresh workspace with no `.juno` directory
///    still has something behind the slash.
///
/// A command's body is a *prompt*, not policy. It is inserted into the composer
/// where the reader can see and edit it before anything is sent — it never
/// silently becomes a system instruction, and it never bypasses the behavior and
/// permission contract set beside it.

// MARK: - A command

public struct CodeSlashCommand: Identifiable, Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        case builtIn
        /// Discovered in the workspace, at this path.
        case workspace(String)

        public var isWorkspace: Bool {
            if case .workspace = self { return true }
            return false
        }
    }

    /// The word typed after the slash, lowercased. Also the identity: a
    /// workspace file named `review.md` replaces the built-in `/review`.
    public let name: String
    public let summary: String
    /// The prompt inserted into the composer.
    public let prompt: String
    /// A behavior the command implies, applied only when the reader has not
    /// already chosen one for this turn. Nil means "leave the contract alone".
    public let behavior: AgentBehavior?
    public let source: Source

    public var id: String { name }

    public init(
        name: String,
        summary: String,
        prompt: String,
        behavior: AgentBehavior? = nil,
        source: Source = .builtIn
    ) {
        self.name = name.lowercased()
        self.summary = summary
        self.prompt = prompt
        self.behavior = behavior
        self.source = source
    }

    /// The prompt with the reader's own words substituted in.
    ///
    /// `$ARGUMENTS` is the placeholder Claude Code established and repositories
    /// already write, so the same command file works in both. A command with no
    /// placeholder simply gets the argument appended — dropping what the reader
    /// typed after the command name would silently lose their input.
    public func expanded(argument: String) -> String {
        let trimmed = argument.trimmingCharacters(in: .whitespacesAndNewlines)
        if prompt.contains(Self.argumentToken) {
            return prompt.replacingOccurrences(of: Self.argumentToken, with: trimmed)
        }
        guard !trimmed.isEmpty else { return prompt }
        return "\(prompt)\n\n\(trimmed)"
    }

    static let argumentToken = "$ARGUMENTS"
}

// MARK: - Parsing a command file

public extension CodeSlashCommand {
    /// Parse one `*.md` command file.
    ///
    /// The format is the one already in the wild: an optional `---` frontmatter
    /// block carrying `description:` and `behavior:`, then the prompt body.
    /// Anything unrecognised in the frontmatter is ignored rather than rejected —
    /// these files are shared with other tools, and refusing to load a command
    /// because it carries a key Juno does not read would make the feature
    /// useless on any repository that already has one.
    ///
    /// Returns nil only when there is no prompt left after the frontmatter: a
    /// command that would insert nothing is not a command.
    static func parse(name: String, contents: String, path: String) -> CodeSlashCommand? {
        var description: String?
        var behavior: AgentBehavior?
        var body = contents

        if let frontmatter = Self.frontmatter(of: contents) {
            body = frontmatter.body
            for line in frontmatter.header.split(separator: "\n", omittingEmptySubsequences: true) {
                let parts = line.split(separator: ":", maxSplits: 1).map {
                    $0.trimmingCharacters(in: .whitespaces)
                }
                guard parts.count == 2 else { continue }
                let value = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                switch parts[0].lowercased() {
                case "description", "summary": description = value
                case "behavior", "mode": behavior = Self.behavior(named: value)
                default: continue
                }
            }
        }

        let prompt = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return nil }

        return CodeSlashCommand(
            name: name,
            // Falling back to the first line rather than to a generic string:
            // an undescribed command still has to be tellable apart from its
            // neighbours in the menu.
            summary: description ?? Self.firstLine(of: prompt),
            prompt: prompt,
            behavior: behavior,
            source: .workspace(path)
        )
    }

    private static func frontmatter(of contents: String) -> (header: String, body: String)? {
        let lines = contents.components(separatedBy: "\n")
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---" else { return nil }
        guard let end = lines.dropFirst().firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces) == "---"
        }) else { return nil }
        let header = lines[1..<end].joined(separator: "\n")
        let body = lines[(end + 1)...].joined(separator: "\n")
        return (header, body)
    }

    private static func behavior(named value: String) -> AgentBehavior? {
        switch value.lowercased() {
        case "ask": .ask
        case "plan": .plan
        case "code": .code
        default: nil
        }
    }

    private static func firstLine(of prompt: String) -> String {
        let line = prompt.components(separatedBy: "\n").first ?? prompt
        let cleaned = line.trimmingCharacters(in: CharacterSet(charactersIn: "# ").union(.whitespaces))
        return cleaned.count > 80 ? String(cleaned.prefix(80)) + "…" : cleaned
    }
}

// MARK: - The library

public struct CodeSlashCommandLibrary: Equatable, Sendable {
    public let commands: [CodeSlashCommand]

    public init(commands: [CodeSlashCommand]) {
        self.commands = commands
    }

    public static let builtIn = CodeSlashCommandLibrary(commands: CodeSlashCommandLibrary.defaults)

    /// The defaults. Deliberately few: every one of these is a prompt a reader
    /// would otherwise type most days, and a long list of speculative commands
    /// would just be a menu to scroll past.
    public static let defaults: [CodeSlashCommand] = [
        CodeSlashCommand(
            name: "review",
            summary: "Review the working changes for correctness and risk",
            prompt: """
                Review the changes currently in this working tree. Focus on correctness, \
                regressions, security, and missing tests. Quote the specific lines you are \
                describing and say plainly which findings you are confident about and which \
                you are not.
                """,
            behavior: .ask
        ),
        CodeSlashCommand(
            name: "explain",
            summary: "Explain how something in this project works",
            prompt: """
                Explain how the following works in this project, reading the real code before \
                answering and citing the files you relied on:

                $ARGUMENTS
                """,
            behavior: .ask
        ),
        CodeSlashCommand(
            name: "plan",
            summary: "Produce an implementation plan without changing anything",
            prompt: """
                Produce a concrete, ordered implementation plan for the following. List the \
                files you would touch, the risks, and how the result would be validated. \
                Change nothing yet.

                $ARGUMENTS
                """,
            behavior: .plan
        ),
        CodeSlashCommand(
            name: "test",
            summary: "Run this project's tests and interpret the result",
            prompt: """
                Work out how this project runs its tests, run them, and report the result. If \
                anything fails, show the actual output and explain the cause before proposing \
                a fix.
                """,
            behavior: .code
        ),
        CodeSlashCommand(
            name: "fix",
            summary: "Diagnose and fix a failure",
            prompt: """
                Diagnose and fix the following. Reproduce it first, show the evidence for the \
                cause rather than guessing, then make the smallest change that fixes it and \
                verify the fix.

                $ARGUMENTS
                """,
            behavior: .code
        ),
        CodeSlashCommand(
            name: "goal",
            summary: "Run a durable, verified multi-step goal",
            prompt: """
                Create a durable goal for the request below with a concise \
                objective and concrete ordered steps using update_goal. Then \
                carry it through, updating each step as it changes. Record \
                specific verification evidence before marking it complete.

                $ARGUMENTS
                """,
            behavior: .code
        ),
        CodeSlashCommand(
            name: "commit",
            summary: "Stage and describe the working changes",
            prompt: """
                Review the working changes, then write a commit message that says what changed \
                and why. Show me the message and the exact files before committing anything.
                """,
            behavior: .code
        ),
    ]

    /// Workspace commands layered over the built-ins, workspace winning.
    public static func merged(
        builtIn: [CodeSlashCommand] = defaults,
        workspace: [CodeSlashCommand]
    ) -> CodeSlashCommandLibrary {
        var byName: [String: CodeSlashCommand] = [:]
        for command in builtIn { byName[command.name] = command }
        for command in workspace { byName[command.name] = command }
        // Workspace commands first, then built-ins: a reader who wrote a command
        // is looking for theirs, and alphabetical order within each group keeps
        // the menu stable as files are added.
        let all = byName.values.sorted { left, right in
            if left.source.isWorkspace != right.source.isWorkspace {
                return left.source.isWorkspace
            }
            return left.name < right.name
        }
        return CodeSlashCommandLibrary(commands: all)
    }

    /// Commands matching what has been typed after the slash.
    ///
    /// Prefix matches rank above substring matches, so typing `/re` offers
    /// `review` before `create-release`.
    public func matches(_ query: String) -> [CodeSlashCommand] {
        let needle = query.lowercased().trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return commands }
        let prefixed = commands.filter { $0.name.hasPrefix(needle) }
        let contained = commands.filter {
            !$0.name.hasPrefix(needle)
                && ($0.name.contains(needle) || $0.summary.lowercased().contains(needle))
        }
        return prefixed + contained
    }

    public func command(named name: String) -> CodeSlashCommand? {
        commands.first { $0.name == name.lowercased() }
    }
}

// MARK: - What the composer has typed

/// The slash token currently being typed, if any.
///
/// Pure so the rule — *only at the very start of an empty-ish composer, only
/// while the reader is still on the command word* — can be asserted rather than
/// discovered by typing into the app. Getting this wrong in either direction is
/// bad: too eager and the menu covers the composer whenever a prompt mentions a
/// path like `/usr/bin`; too lazy and the feature appears not to exist.
public struct CodeSlashToken: Equatable, Sendable {
    /// The partial command name, without the slash.
    public let query: String
    /// Everything after the first space — the command's argument, if the reader
    /// has moved past the name.
    public let argument: String
    /// True while the caret is still inside the command word, which is the only
    /// time the menu should be showing.
    public let isNamingCommand: Bool

    public init?(composerText: String) {
        // Leading whitespace is allowed (a stray space before `/` is a typo, not
        // a decision), but anything else before the slash means this is prose.
        let text = composerText.drop { $0 == " " || $0 == "\t" }
        guard text.first == "/" else { return nil }
        let rest = text.dropFirst()
        // A second slash immediately after is a path (`//`), not a command.
        guard rest.first != "/" else { return nil }
        // A newline means the reader has moved on to a second line; whatever the
        // first line was, it is no longer being typed.
        guard !rest.contains("\n") else { return nil }

        if let space = rest.firstIndex(of: " ") {
            query = String(rest[rest.startIndex..<space])
            argument = String(rest[rest.index(after: space)...])
            isNamingCommand = false
        } else {
            query = String(rest)
            argument = ""
            isNamingCommand = true
        }
        // `/` followed by a digit or punctuation is a path or a fraction.
        guard query.isEmpty || query.first?.isLetter == true else { return nil }
    }
}

// MARK: - Discovery

public extension WorkspaceContext {
    /// The command files this workspace carries.
    ///
    /// Commands and skills are read from both supported conventions, with
    /// .juno last so a repository migrating from .claude can override one
    /// prompt at a time. A skill is represented by its SKILL.md as a slash
    /// prompt: it remains visible and editable before sending, while keeping
    /// the same safe behavior/permission contract as every other command.
    ///
    /// Unreadable files are skipped rather than failing the lot: one malformed
    /// prompt must not take the whole menu down.
    func slashCommands() async -> [CodeSlashCommand] {
        var byName: [String: CodeSlashCommand] = [:]
        for directory in [".claude/commands", ".juno/commands"] {
            for command in Self.commands(in: directory, access: access) {
                byName[command.name] = command
            }
        }
        for directory in [".claude/skills", ".juno/skills"] {
            for skill in Self.skills(in: directory, access: access) {
                byName[skill.name] = skill
            }
        }
        return Array(byName.values)
    }

    private static func commands(
        in directory: String,
        access: WorkspaceAccess
    ) -> [CodeSlashCommand] {
        guard let path = try? WorkspacePath(directory),
            let url = try? access.resolveForReading(path),
            let entries = try? FileManager.default.contentsOfDirectory(
                at: url,
                includingPropertiesForKeys: nil
            )
        else { return [] }

        return entries.compactMap { entry -> CodeSlashCommand? in
            guard entry.pathExtension.lowercased() == "md" else { return nil }
           let name = entry.deletingPathExtension().lastPathComponent
           guard !name.isEmpty else { return nil }
            let relative = directory + "/" + entry.lastPathComponent
            guard let filePath = try? WorkspacePath(relative),
                let fileURL = try? access.resolveForReading(filePath),
                let contents = try? String(contentsOf: fileURL, encoding: .utf8)
            else { return nil }
            return CodeSlashCommand.parse(
                name: name,
                contents: contents,
                path: "\(directory)/\(entry.lastPathComponent)"
            )
        }
    }

    /// Discovers the portable skill layout used by Claude Code and compatible
    /// tools: one directory per skill with a SKILL.md at its root.
    private static func skills(
        in directory: String,
        access: WorkspaceAccess
    ) -> [CodeSlashCommand] {
        guard let path = try? WorkspacePath(directory),
            let url = try? access.resolveForReading(path),
            let entries = try? FileManager.default.contentsOfDirectory(
                at: url,
                includingPropertiesForKeys: [.isDirectoryKey]
            )
        else { return [] }

        return entries.compactMap { entry -> CodeSlashCommand? in
            guard (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
           else { return nil }
           let name = entry.lastPathComponent
           guard !name.isEmpty else { return nil }
            let relative = directory + "/" + name + "/SKILL.md"
            guard let skillPath = try? WorkspacePath(relative),
                let skillURL = try? access.resolveForReading(skillPath),
                let contents = try? String(contentsOf: skillURL, encoding: .utf8)
            else { return nil }
            return CodeSlashCommand.parse(
                name: name,
                contents: contents,
                path: "\(directory)/\(name)/SKILL.md"
            )
        }
    }
}
