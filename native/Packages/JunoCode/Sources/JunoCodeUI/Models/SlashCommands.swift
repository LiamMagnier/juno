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
/// Four sources, and the precedence matters (CODE_AGENT_SPEC §5.4, §5.8):
///
/// 1. **The workspace**, from `.juno/commands/*.md` — and `.claude/commands/*.md`
///    as well, because a repository that already carries those should not have
///    to duplicate them to be useful here. A workspace command **overrides** a
///    command of the same name from anywhere else: the repository knows more
///    about how it wants to be reviewed than Juno's defaults do.
/// 2. **The reader's own**, from `~/.juno/commands/*.md`.
/// 3. **Claude Code's**, from `~/.claude/commands/*.md`, read only and each off
///    until the reader turns it on (choosing one in the menu does).
/// 4. **The built-ins** below: a few prompts, and the session's verbs —
///    `/goal`, `/verify`, `/review`, `/context`, `/cost` and the rest — which
///    run handlers (`SlashCommandHandlers.swift`) instead of inserting text.
///
/// A replaced command is still listed, dimmed, with what replaced it.
///
/// A command file's body is a *prompt*, not policy. It is inserted into the
/// composer where the reader can see and edit it before anything is sent — it
/// never silently becomes a system instruction, it never bypasses the behavior
/// and permission contract set beside it, and it can never become a verb.

// MARK: - A command

public struct CodeSlashCommand: Identifiable, Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        case builtIn
        /// Discovered in the workspace, at this path.
        case workspace(String)
        /// The reader's own `~/.juno/commands`, at this path.
        case user(String)
        /// Claude Code's `~/.claude/commands`, read only, at this path.
        case claudeImport(String)

        public var isWorkspace: Bool {
            if case .workspace = self { return true }
            return false
        }

        /// Where it was declared, or nil for a built-in.
        public var scope: ExtensionScope? {
            switch self {
            case .builtIn: nil
            case .workspace: .project
            case .user: .user
            case .claudeImport: .claudeImport
            }
        }

        public var path: String? {
            switch self {
            case .builtIn: nil
            case let .workspace(path), let .user(path), let .claudeImport(path): path
            }
        }

        /// The source in the reader's words.
        public var label: String { scope?.label ?? "Built in" }

        /// Whose command it is, before its name: "this project's /review".
        public var possessive: String {
            switch self {
            case .builtIn: "Juno's"
            case .workspace: "this project's"
            case .user: "your"
            case .claudeImport: "Claude Code's"
            }
        }

        /// Precedence for one name: lower wins.
        var rank: Int {
            switch self {
            case .workspace: 0
            case .user: 1
            case .claudeImport: 2
            case .builtIn: 3
            }
        }
    }

    /// Something the composer *does* rather than a prompt it inserts.
    ///
    /// Most commands are saved prompts; a few are verbs on the session itself.
    /// `/compact` is the first: it has no sentence to put in the composer, only
    /// a fold of the model context to perform, so it is an action the composer
    /// dispatches to the controller instead of text it hands to the reader.
    public enum Action: String, CaseIterable, Equatable, Sendable {
        /// `/goal [objective | pause | resume | edit | clear]` (§2.8).
        case goal
        /// `/verify [setup | ids…]`: run the project's checks now.
        case verify
        /// `/review [uncommitted | branch | last-turn | <commit>] [--fix]`.
        case review
        /// `/context`: what fills the context window.
        case context
        /// `/cost`, also `/usage`: tokens and cost.
        case cost
        /// Fold older turns into a summary; the argument, if any, says what
        /// the summary should keep.
        case compact
        /// Choose one of the reader's messages to go back to: `/rewind`, the
        /// typed twin of esc esc.
        case rewind
        /// `/resume`: open another session, interrupted runs included.
        case resume
        /// `/model [id]`.
        case model
        /// `/init`: a turn that proposes `AGENTS.md` and the project's checks.
        case initProject = "init"
        /// `/memory`: the instruction files.
        case memory
        /// `/permissions`: rules by scope, recent denials.
        case permissions
        /// `/agents`: built-in and custom agents.
        case agents
        /// `/mcp`: MCP servers by scope.
        case mcp
        /// `/hooks`: hooks by event.
        case hooks
        /// `/tasks`: background shells and sub-agents.
        case tasks
        /// `/fork [prompt]`: a new session from this conversation.
        case fork
        /// `/loop [interval] <prompt>`.
        case loop
        /// `/export [file]`: the conversation as Markdown.
        case export
        /// `/btw <question>`: a side question.
        case btw
    }

    /// Other names the command answers to: `/usage` for `/cost`.
    public let aliases: [String]
    /// False for a Claude Code command the reader has not turned on: listed,
    /// and turned on by choosing it.
    public let isEnabled: Bool
    /// The command that replaced this one, when a higher scope declared the
    /// same name: "this project's /review".
    public let replacedBy: String?

    /// The verb this command performs, or nil for an ordinary saved prompt.
    public let action: Action?

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
    /// What an action takes after its name, shown beside it in the menu —
    /// the only place a reader would learn that `/compact` accepts anything.
    /// Nil for prompts: their argument lands in text the reader can see.
    public let argumentHint: String?

    public var id: String { name }

    public init(
        name: String,
        summary: String,
        prompt: String,
        behavior: AgentBehavior? = nil,
        source: Source = .builtIn,
        action: Action? = nil,
        argumentHint: String? = nil,
        aliases: [String] = [],
        isEnabled: Bool = true,
        replacedBy: String? = nil
    ) {
        self.name = name.lowercased()
        self.summary = summary
        self.prompt = prompt
        self.behavior = behavior
        self.source = source
        self.action = action
        self.argumentHint = argumentHint
        self.aliases = aliases.map { $0.lowercased() }
        self.isEnabled = isEnabled
        self.replacedBy = replacedBy
    }

    /// A copy with one thing different, for discovery and merging.
    func with(source: Source? = nil, isEnabled: Bool? = nil, replacedBy: String?? = nil) -> CodeSlashCommand {
        CodeSlashCommand(
            name: name,
            summary: summary,
            prompt: prompt,
            behavior: behavior,
            source: source ?? self.source,
            action: action,
            argumentHint: argumentHint,
            aliases: aliases,
            isEnabled: isEnabled ?? self.isEnabled,
            replacedBy: replacedBy ?? self.replacedBy
        )
    }

    /// Whether `name` is this command's name or one of its aliases.
    public func answers(to name: String) -> Bool {
        let lowered = name.lowercased()
        return self.name == lowered || aliases.contains(lowered)
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
        case "survey", "recon", "reconnaissance": .survey
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
    /// One per name: the commands that run.
    public let commands: [CodeSlashCommand]
    /// Commands a same-named one from a higher scope replaced, listed after
    /// the rest so the reader can see both (§5.8).
    public let overridden: [CodeSlashCommand]

    public init(commands: [CodeSlashCommand], overridden: [CodeSlashCommand] = []) {
        self.commands = commands
        self.overridden = overridden
    }

    public static let builtIn = CodeSlashCommandLibrary(commands: CodeSlashCommandLibrary.defaults)

    /// The defaults: a few prompts a reader would otherwise type most days,
    /// and the session's verbs (§5.4). `/boost` and `/teamwork-preview` are
    /// gone: they promised features that do not exist.
    public static let defaults: [CodeSlashCommand] = prompts + verbs

    static let prompts: [CodeSlashCommand] = [
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
            name: "survey",
            summary: "Map the repository and surface risks before implementation",
            prompt: """
                Survey this project before implementation. Build a concise map of its entry points, \
                main modules, runtime boundaries, conventions, recent changes, and the highest-risk unknowns. \
                Use read-only inspection only. Delegate independent reconnaissance in parallel when it will \
                make the map more reliable, then cite the files and evidence behind each conclusion.

                $ARGUMENTS
                """,
            behavior: .survey
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
            name: "commit",
            summary: "Stage and describe the working changes",
            prompt: """
                Review the working changes, then write a commit message that says what changed \
                and why. Show me the message and the exact files before committing anything.
                """,
            behavior: .code
        ),
    ]

    static let verbs: [CodeSlashCommand] = [
        verb(.goal, "Set a goal Juno keeps working toward until it is met", hint: "objective, or pause · resume · edit · clear"),
        verb(.verify, "Run this project's checks now", hint: "setup, or check ids"),
        verb(.review, "Review changes for correctness and risk", hint: "uncommitted · branch · last-turn · commit, --fix"),
        verb(.context, "See what fills the context window"),
        verb(.cost, "See this session's tokens and cost", aliases: ["usage"]),
        verb(.compact, "Summarise older turns to free up context", hint: "what to keep"),
        verb(.rewind, "Go back to before one of your messages"),
        verb(.resume, "Open another session, or resume one Juno was interrupted in"),
        verb(.model, "Switch this session's model", hint: "model id"),
        verb(.initProject, "Scan the project and propose AGENTS.md, checks and a launch file"),
        verb(.memory, "Open your and the project's instruction files"),
        verb(.permissions, "See and change what Juno may do without asking"),
        verb(.agents, "See the built-in and custom agents"),
        verb(.mcp, "See MCP servers, their tools and their consent"),
        verb(.hooks, "See the hooks and when each last ran"),
        verb(.tasks, "See background shells and sub-agents"),
        verb(.fork, "Start a new session from this conversation", hint: "first message"),
        verb(.loop, "Run a prompt again on an interval", hint: "interval, prompt · stop"),
        verb(.export, "Copy the conversation as Markdown", hint: "file"),
        verb(.btw, "Ask a side question without adding it to the conversation", hint: "question"),
    ]

    private static func verb(
        _ action: CodeSlashCommand.Action,
        _ summary: String,
        hint: String? = nil,
        aliases: [String] = []
    ) -> CodeSlashCommand {
        CodeSlashCommand(
            name: action.rawValue,
            summary: summary,
            prompt: "",
            action: action,
            argumentHint: hint,
            aliases: aliases
        )
    }

    /// Workspace commands layered over the built-ins, workspace winning.
    public static func merged(
        builtIn: [CodeSlashCommand] = defaults,
        workspace: [CodeSlashCommand]
    ) -> CodeSlashCommandLibrary {
        merged(builtIn: builtIn, workspace: workspace, user: [])
    }

    /// Every scope layered (§5.8): the project's files win a name, then the
    /// reader's own, then Claude Code's (only those turned on), then the
    /// built-ins. What lost a name is kept in ``overridden``; a Claude Code
    /// command that is off is listed after everything, to be turned on.
    public static func merged(
        builtIn: [CodeSlashCommand] = defaults,
        workspace: [CodeSlashCommand],
        user: [CodeSlashCommand]
    ) -> CodeSlashCommandLibrary {
        let candidates = (workspace + user.filter(\.isEnabled) + builtIn)
            .sorted { $0.source.rank < $1.source.rank }
        var winners: [String: CodeSlashCommand] = [:]
        var overridden: [CodeSlashCommand] = []
        for command in candidates {
            if let winner = winners[command.name] ?? winners.values.first(where: { $0.answers(to: command.name) }) {
                overridden.append(command.with(replacedBy: .some("\(winner.source.possessive) /\(winner.name)")))
            } else {
                winners[command.name] = command
            }
        }
        // Workspace commands first, then the reader's, then built-ins: a
        // reader who wrote a command is looking for theirs, and alphabetical
        // order within each group keeps the menu stable as files are added.
        let all = winners.values.sorted { left, right in
            if left.source.rank != right.source.rank {
                return left.source.rank < right.source.rank
            }
            return left.name < right.name
        }
        let dormant = user.filter { !$0.isEnabled && winners[$0.name] == nil }
            .sorted { $0.name < $1.name }
        return CodeSlashCommandLibrary(
            commands: all,
            overridden: overridden.sorted { $0.name < $1.name } + dormant
        )
    }

    /// Commands matching what has been typed after the slash.
    ///
    /// Prefix matches rank above substring matches, so typing `/re` offers
    /// `review` before `create-release`. Replaced and dormant commands come
    /// last, so the one that runs is always first.
    public func matches(_ query: String) -> [CodeSlashCommand] {
        let needle = query.lowercased().trimmingCharacters(in: .whitespaces)
        func rank(_ pool: [CodeSlashCommand]) -> [CodeSlashCommand] {
            guard !needle.isEmpty else { return pool }
            let prefixed = pool.filter { $0.name.hasPrefix(needle) || $0.aliases.contains { $0.hasPrefix(needle) } }
            let contained = pool.filter { command in
                !prefixed.contains(command)
                    && (command.name.contains(needle) || command.summary.lowercased().contains(needle))
            }
            return prefixed + contained
        }
        return rank(commands) + rank(overridden)
    }

    /// The command that runs for `name`, an alias included.
    public func command(named name: String) -> CodeSlashCommand? {
        commands.first { $0.answers(to: name) }
    }

    /// The library without session verbs, for a composer that has no session
    /// yet: `/compact` on the landing screen would have nothing to fold.
    public func excludingActions() -> CodeSlashCommandLibrary {
        CodeSlashCommandLibrary(
            commands: commands.filter { $0.action == nil },
            overridden: overridden.filter { $0.action == nil }
        )
    }

    /// The session verb the composer holds, when the reader typed one out by
    /// name — `/compact`, or `/compact keep the API decisions` — with its
    /// argument trimmed.
    ///
    /// The menu only shows while the name is being typed, so once the reader
    /// has moved on to the argument, sending is what runs the verb. Without
    /// this the whole line would go to the model as a message.
    public func typedAction(in composerText: String) -> (command: CodeSlashCommand, argument: String)? {
        guard let token = CodeSlashToken(composerText: composerText),
              let command = command(named: token.query),
              command.action != nil
        else { return nil }
        return (command, token.argument.trimmingCharacters(in: .whitespacesAndNewlines))
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

// MARK: - The reader's own commands (§5.8)

public extension WorkspaceContext {
    /// The reader's own commands and skills, `~/.juno/commands` and
    /// `~/.juno/skills`, and Claude Code's, `~/.claude/commands` and
    /// `~/.claude/skills`, read only — each Claude Code one off until the
    /// reader turns it on. Empty where this workspace reads no user folder.
    func userSlashCommands() -> [CodeSlashCommand] {
        guard let user = userExtensionDirectories else { return [] }
        return CodeSlashCommand.userCommands(in: user, imports: userExtensionPolicy)
    }
}

public extension CodeSlashCommand {
    /// The kind a command import is switched on under.
    static let importKind = "command"

    /// Every command and skill in the reader's folders, Juno's winning a
    /// name over Claude Code's.
    static func userCommands(
        in user: UserExtensionDirectories,
        imports: UserExtensionPolicyStore?
    ) -> [CodeSlashCommand] {
        var byName: [String: CodeSlashCommand] = [:]
        for scope in [ExtensionScope.claudeImport, .user] {
            var found: [CodeSlashCommand] = []
            if let folder = user.folder(.commands, scope: scope) {
                for entry in UserExtensionDirectories.entries(of: folder.url, directories: false)
                where entry.pathExtension.lowercased() == "md" {
                    let name = entry.deletingPathExtension().lastPathComponent
                    let path = "\(folder.displayPath)/\(entry.lastPathComponent)"
                    guard !name.isEmpty,
                          let contents = UserExtensionDirectories.readText(at: entry, maximumBytes: 64 * 1_024),
                          let command = parse(name: name, contents: contents, path: path)
                    else { continue }
                    found.append(command.with(source: scope == .user ? .user(path) : .claudeImport(path)))
                }
            }
            if let folder = user.folder(.skills, scope: scope) {
                for entry in UserExtensionDirectories.entries(of: folder.url, directories: true) {
                    let name = entry.lastPathComponent
                    let path = "\(folder.displayPath)/\(name)/SKILL.md"
                    guard let contents = UserExtensionDirectories.readText(
                        at: entry.appendingPathComponent("SKILL.md"),
                        maximumBytes: 256 * 1_024
                    ), let command = parse(name: name, contents: contents, path: path)
                    else { continue }
                    found.append(command.with(source: scope == .user ? .user(path) : .claudeImport(path)))
                }
            }
            for command in found {
                let enabled = scope != .claudeImport
                    || (imports?.isEnabled(kind: importKind, name: command.name) ?? false)
                byName[command.name] = command.with(isEnabled: enabled)
            }
        }
        return byName.values.sorted { $0.name < $1.name }
    }
}
