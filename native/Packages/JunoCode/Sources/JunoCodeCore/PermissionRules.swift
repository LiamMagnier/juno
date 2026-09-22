import Foundation

/// What a permission rule is matched against, beyond the tool's name.
public enum PermissionRuleSubject: Equatable, Sendable {
    /// A shell command line, checked segment by segment.
    case command(String)
    /// A workspace-relative path.
    case path(String)
    /// A host name, for tools that reach the network.
    case domain(String)
}

/// One `Tool` or `Tool(specifier)` rule, in the syntax Claude Code and its
/// peers settled on, so a rule a reader already wrote elsewhere means the same
/// thing here.
///
/// | Rule | Matches |
/// |---|---|
/// | `Bash` | every command |
/// | `Bash(npm run test *)` | commands starting `npm run test ` |
/// | `Bash(git status)` | exactly `git status` |
/// | `Read(.env)` | any `.env`, in any folder |
/// | `Edit(src/**)` | edits under `src/` |
/// | `WebFetch(domain:*.apple.com)` | fetches from apple.com's subdomains |
/// | `mcp__github` / `mcp__github__*` | every tool of one MCP server |
/// | `run_command` | Juno's own tool names work too |
public struct PermissionRule: Hashable, Codable, Sendable, CustomStringConvertible {
    public let tool: String
    public let specifier: String?

    public init(tool: String, specifier: String? = nil) {
        self.tool = tool
        let trimmed = specifier?.trimmingCharacters(in: .whitespaces)
        self.specifier = (trimmed?.isEmpty ?? true) ? nil : trimmed
    }

    /// Parses `Tool` or `Tool(specifier)`; nil for text that is neither.
    public init?(parsing text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let open = trimmed.firstIndex(of: "(") {
            guard trimmed.hasSuffix(")") else { return nil }
            let name = trimmed[..<open].trimmingCharacters(in: .whitespaces)
            let inner = trimmed[trimmed.index(after: open)..<trimmed.index(before: trimmed.endIndex)]
            guard !name.isEmpty, Self.isToolName(name) else { return nil }
            self.init(tool: name, specifier: String(inner))
        } else {
            guard Self.isToolName(trimmed) else { return nil }
            self.init(tool: trimmed)
        }
    }

    public var description: String {
        specifier.map { "\(tool)(\($0))" } ?? tool
    }

    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let rule = PermissionRule(parsing: text) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Not a permission rule: \(text)")
            )
        }
        self = rule
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }

    private static func isToolName(_ name: String) -> Bool {
        name.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" || $0 == "*" }
    }

    // MARK: - Matching

    /// Tool families the friendly names stand for.
    static let families: [String: Set<String>] = [
        // Git's own tools are shell commands with a narrower surface, so a
        // rule about `git commit` reads the same whichever tool runs it. A
        // repository hook is a shell command too, asked about as one: the
        // reader's rule about `npm run lint` means the same when a hook runs
        // it.
        "bash": ["run_command", "run_tests", "git_status", "git_diff", "git_log", "git_commit", "hook"],
        "shell": ["run_command", "run_tests", "git_status", "git_diff", "git_log", "git_commit", "hook"],
        "read": ["read_file", "list_directory", "find_files", "glob", "grep"],
        "edit": ["create_file", "write_file", "apply_patch", "multi_edit", "delete_file", "move_file"],
        "write": ["create_file", "write_file", "apply_patch", "multi_edit", "delete_file", "move_file"],
        "git": ["git_status", "git_diff", "git_log", "git_commit"],
        "websearch": ["web_search"],
        "webfetch": ["web_fetch"],
        "agent": ["delegate_task"],
        "task": ["delegate_task"],
    ]

    /// Whether this rule names `toolName` at all, ignoring the specifier.
    public func covers(toolName: String) -> Bool {
        let lowered = tool.lowercased()
        if let family = Self.families[lowered] {
            return family.contains(toolName)
        }
        if lowered.hasPrefix("mcp__") {
            if lowered.hasSuffix("__*") {
                return toolName.lowercased().hasPrefix(String(lowered.dropLast()))
            }
            let segments = lowered.components(separatedBy: "__")
            // `mcp__server` covers the whole server.
            if segments.count == 2 {
                return toolName.lowercased().hasPrefix(lowered + "__")
            }
        }
        return lowered == toolName.lowercased()
    }

    /// Whether this rule names a tool that clicks, types, presses keys or
    /// scrolls on the reader's Mac. Only the reader's own settings file may
    /// allow one of those without asking; see
    /// `CodeSettingsFile.withoutScreenInputAllowances`.
    public var coversScreenInput: Bool {
        ComputerUseToolName.input.contains { covers(toolName: $0) }
    }

    /// Whether this rule matches one invocation. A rule without a specifier
    /// matches every invocation of the tools it covers.
    func matches(toolName: String, subject: PermissionRuleSubject?) -> Bool {
        guard covers(toolName: toolName) else { return false }
        guard let specifier else { return true }
        switch subject {
        case let .command(command)?:
            return Self.commandMatches(pattern: specifier, command: command)
        case let .path(path)?:
            return Self.pathMatches(pattern: specifier, path: path)
        case let .domain(host)?:
            guard specifier.lowercased().hasPrefix("domain:") else { return false }
            return Self.domainMatches(pattern: String(specifier.dropFirst(7)), host: host)
        case nil:
            // A specific rule cannot vouch for an invocation it cannot see.
            return false
        }
    }

    static func commandMatches(pattern: String, command: String) -> Bool {
        let command = command.trimmingCharacters(in: .whitespacesAndNewlines)
        var pattern = pattern
        // The older `prefix:*` form.
        if pattern.hasSuffix(":*") {
            let prefix = String(pattern.dropLast(2))
            return command == prefix || command.hasPrefix(prefix + " ")
        }
        if pattern.hasSuffix(" *") {
            // `npm run *` also matches a bare `npm run`.
            let prefix = String(pattern.dropLast(2))
            if command == prefix { return true }
        }
        pattern = pattern.trimmingCharacters(in: .whitespaces)
        return wildcardMatch(pattern: Array(pattern), text: Array(command), starCrossesSlash: true)
    }

    /// gitignore-style: a pattern without a slash matches the name in any
    /// folder; `**` crosses folders; `*` stays within one.
    static func pathMatches(pattern: String, path: String) -> Bool {
        var pattern = pattern
        var path = path
        if pattern.hasPrefix("./") { pattern.removeFirst(2) }
        if path.hasPrefix("./") { path.removeFirst(2) }
        if pattern.hasSuffix("/") { pattern += "**" }
        let anchored = pattern.hasPrefix("/")
        if anchored { pattern.removeFirst() }
        if !anchored, !pattern.contains("/") {
            let name = path.split(separator: "/").last.map(String.init) ?? path
            return wildcardMatch(pattern: Array(pattern), text: Array(name), starCrossesSlash: false)
                || wildcardMatch(pattern: Array(pattern), text: Array(path), starCrossesSlash: false)
        }
        return wildcardMatch(pattern: Array(pattern), text: Array(path), starCrossesSlash: false)
    }

    static func domainMatches(pattern: String, host: String) -> Bool {
        let pattern = pattern.lowercased()
        let host = host.lowercased()
        if pattern.hasPrefix("*.") {
            let base = String(pattern.dropFirst(2))
            return host == base || host.hasSuffix("." + base)
        }
        return host == pattern
    }

    /// `*` any run (optionally stopping at `/`), `**` any run across `/`,
    /// `?` one character. Iterative with backtracking to the last star.
    static func wildcardMatch(pattern: [Character], text: [Character], starCrossesSlash: Bool) -> Bool {
        var p = 0, t = 0
        var starP = -1, starT = -1, starCrosses = false
        while t < text.count {
            if p < pattern.count, pattern[p] == "*" {
                let isDouble = p + 1 < pattern.count && pattern[p + 1] == "*"
                starCrosses = starCrossesSlash || isDouble
                p += isDouble ? 2 : 1
                // `**/` also matches zero folders.
                if isDouble, p < pattern.count, pattern[p] == "/" { p += 1 }
                starP = p
                starT = t
            } else if p < pattern.count, pattern[p] == "?" || pattern[p] == text[t] {
                p += 1
                t += 1
            } else if starP >= 0, starCrosses || text[starT] != "/" {
                starT += 1
                t = starT
                p = starP
            } else {
                return false
            }
        }
        while p < pattern.count, pattern[p] == "*" { p += 1 }
        return p == pattern.count
    }
}

/// What the rules said about one invocation.
public enum PermissionRuleDecision: Equatable, Sendable {
    case allow(PermissionRule)
    case ask(PermissionRule)
    case deny(PermissionRule)
}

/// The reader's standing allow / ask / deny lists.
///
/// Deny beats ask beats allow, regardless of which file a rule came from or
/// how specific it is — the order every peer uses, and the only one in which
/// adding a rule can never quietly weaken a denial.
public struct PermissionRuleSet: Equatable, Sendable, Codable {
    public var allow: [PermissionRule]
    public var ask: [PermissionRule]
    public var deny: [PermissionRule]

    public init(allow: [PermissionRule] = [], ask: [PermissionRule] = [], deny: [PermissionRule] = []) {
        self.allow = allow
        self.ask = ask
        self.deny = deny
    }

    public static let empty = PermissionRuleSet()

    public var isEmpty: Bool { allow.isEmpty && ask.isEmpty && deny.isEmpty }

    /// Rules from `other` added after these.
    public func merging(_ other: PermissionRuleSet) -> PermissionRuleSet {
        PermissionRuleSet(
            allow: Self.unique(allow + other.allow),
            ask: Self.unique(ask + other.ask),
            deny: Self.unique(deny + other.deny)
        )
    }

    public func evaluate(toolName: String, subject: PermissionRuleSubject?) -> PermissionRuleDecision? {
        // A chained command is as dangerous as its worst part and only as
        // trusted as its least-trusted one.
        if case let .command(line)? = subject {
            let segments = ShellSegments.split(line)
            if let rule = firstMatch(deny, toolName: toolName, segments: segments, any: true) {
                return .deny(rule)
            }
            if let rule = firstMatch(ask, toolName: toolName, segments: segments, any: true) {
                return .ask(rule)
            }
            if let rule = firstMatch(allow, toolName: toolName, segments: segments, any: false) {
                return .allow(rule)
            }
            return nil
        }
        if let rule = deny.first(where: { $0.matches(toolName: toolName, subject: subject) }) {
            return .deny(rule)
        }
        if let rule = ask.first(where: { $0.matches(toolName: toolName, subject: subject) }) {
            return .ask(rule)
        }
        if let rule = allow.first(where: { $0.matches(toolName: toolName, subject: subject) }) {
            return .allow(rule)
        }
        return nil
    }

    private func firstMatch(
        _ rules: [PermissionRule],
        toolName: String,
        segments: [String],
        any: Bool
    ) -> PermissionRule? {
        if any {
            for segment in segments {
                if let rule = rules.first(where: { $0.matches(toolName: toolName, subject: .command(segment)) }) {
                    return rule
                }
            }
            return nil
        }
        // Every segment must be allowed; report the rule that allowed the first.
        var first: PermissionRule?
        for segment in segments {
            guard let rule = rules.first(where: { $0.matches(toolName: toolName, subject: .command(segment)) })
            else { return nil }
            first = first ?? rule
        }
        return first
    }

    private static func unique(_ rules: [PermissionRule]) -> [PermissionRule] {
        var seen = Set<PermissionRule>()
        return rules.filter { seen.insert($0).inserted }
    }

    /// The rule an "Always allow" answer should save for this invocation:
    /// narrow enough to mean what the reader saw, wide enough that the next
    /// ordinary variation does not ask again.
    public static func suggestedRule(toolName: String, subject: PermissionRuleSubject?) -> PermissionRule {
        switch subject {
        case let .command(line)?:
            let tokens = ShellSegments.split(line).first?
                .split(separator: " ", omittingEmptySubsequences: true)
                .map(String.init) ?? []
            guard let program = tokens.first else { return PermissionRule(tool: "Bash") }
            // `npm run test`, `git commit`, `swift build`: the subcommand is
            // what the reader approved, not every use of the program.
            let prefixLength = Self.subcommandPrograms.contains(program) ? 2 : 1
            let prefix = tokens.prefix(prefixLength)
                .filter { !$0.hasPrefix("-") }
                .joined(separator: " ")
            return PermissionRule(tool: "Bash", specifier: prefix + " *")
        case .path?:
            return PermissionRule(tool: "Edit")
        case let .domain(host)?:
            return PermissionRule(tool: "WebFetch", specifier: "domain:" + host)
        case nil:
            return PermissionRule(tool: toolName)
        }
    }

    static let subcommandPrograms: Set<String> = [
        "npm", "pnpm", "yarn", "bun", "npx", "git", "swift", "cargo", "go", "make",
        "xcodebuild", "xcrun", "gh", "docker", "kubectl", "pip", "pip3", "poetry",
        "uv", "bundle", "rails", "mix", "dotnet", "gradle", "./gradlew", "mvn", "deno",
    ]
}

/// Splits a command line on `&&`, `||`, `;`, `|` and newlines, outside quotes.
public enum ShellSegments {
    public static func split(_ line: String) -> [String] {
        var segments: [String] = []
        var current = ""
        var quote: Character?
        var escaped = false
        let characters = Array(line)
        var index = 0
        func flush() {
            let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { segments.append(trimmed) }
            current = ""
        }
        while index < characters.count {
            let character = characters[index]
            if escaped {
                current.append(character)
                escaped = false
            } else if character == "\\" {
                current.append(character)
                escaped = true
            } else if let open = quote {
                current.append(character)
                if character == open { quote = nil }
            } else if character == "\"" || character == "'" {
                current.append(character)
                quote = character
            } else if character == ";" || character == "\n" {
                flush()
            } else if character == "&" || character == "|" {
                // `&&`, `||` and `|` separate; a lone `&` backgrounds, which
                // also ends the command.
                if index + 1 < characters.count, characters[index + 1] == character {
                    index += 1
                }
                flush()
            } else {
                current.append(character)
            }
            index += 1
        }
        flush()
        return segments.isEmpty ? [line.trimmingCharacters(in: .whitespacesAndNewlines)] : segments
    }
}
