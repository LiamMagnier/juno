import Foundation

public enum CommandVerdict: Equatable, Sendable {
    /// The command may be proposed with this risk; the permission policy
    /// decides whether it still needs approval.
    case permitted(risk: ActionRisk, reason: String)
    /// The command is never executed by the agent, in any mode.
    case forbidden(reason: String)

    public var risk: ActionRisk? {
        if case let .permitted(risk, _) = self { return risk }
        return nil
    }
}

/// Argument-aware command safety classification.
///
/// The classifier tokenizes the command line with shell quoting rules, splits
/// it into pipeline segments, and applies per-program rules to each segment.
/// Anything it cannot parse is forbidden. This gate runs before the permission
/// policy: `execute` commands are still approval-gated in most modes, and
/// `critical` commands require approval in every mode.
public struct CommandClassifier: Sendable {
    public init() {}

    public func classify(_ commandLine: String) -> CommandVerdict {
        let trimmed = commandLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return .forbidden(reason: "Empty command.")
        }
        guard trimmed.utf8.count <= 16_384 else {
            return .forbidden(reason: "Command is too long.")
        }
        guard let tokens = ShellTokenizer.tokenize(trimmed) else {
            return .forbidden(reason: "Command could not be parsed safely.")
        }
        if tokens.contains(where: { $0.containsSubstitution }) {
            return .permitted(
                risk: .critical,
                reason: "Command uses shell substitution."
            )
        }

        var worst = ActionRisk.execute
        var worstReason = "Command execution."
        var sawRedirect = false

        for segment in Self.segments(from: tokens) {
            switch Self.classifySegment(segment) {
            case let .forbidden(reason):
                return .forbidden(reason: reason)
            case let .permitted(risk, reason):
                if risk > worst {
                    worst = risk
                    worstReason = reason
                }
            }
            if segment.contains(where: { $0.kind == .redirect && $0.text.hasPrefix("/") }) {
                sawRedirect = true
            }
        }
        if sawRedirect, worst < .critical {
            worst = .critical
            worstReason = "Command redirects output to an absolute path."
        }
        return .permitted(risk: worst, reason: worstReason)
    }

    // MARK: - Segments

    private static func segments(from tokens: [ShellToken]) -> [[ShellToken]] {
        var result: [[ShellToken]] = []
        var current: [ShellToken] = []
        for token in tokens {
            if token.kind == .controlOperator {
                if !current.isEmpty { result.append(current) }
                current = []
            } else {
                current.append(token)
            }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    private static func classifySegment(_ segment: [ShellToken]) -> CommandVerdict {
        var words = segment.filter { $0.kind == .word }.map(\.text)
        // Skip leading VAR=value assignments and `env` wrappers.
        while let first = words.first, first.contains("="), !first.hasPrefix("=") {
            words.removeFirst()
        }
        while words.first == "env" {
            words.removeFirst()
            while let first = words.first, first.contains("=") || first.hasPrefix("-") {
                words.removeFirst()
            }
        }
        guard let rawProgram = words.first else {
            return .permitted(risk: .execute, reason: "Environment assignment only.")
        }
        let program = rawProgram.split(separator: "/").last.map(String.init) ?? rawProgram
        let arguments = Array(words.dropFirst())

        if forbiddenPrograms.contains(program) {
            return .forbidden(reason: "'\(program)' is never run by the agent.")
        }
        switch program {
        case "rm", "rmdir", "unlink":
            return classifyRemove(program: program, arguments: arguments)
        case "dd":
            if arguments.contains(where: { $0.hasPrefix("of=/dev/") }) {
                return .forbidden(reason: "Writing to raw devices is never allowed.")
            }
            return .permitted(risk: .critical, reason: "Raw data copy.")
        case "diskutil":
            if arguments.contains(where: { $0.lowercased().hasPrefix("erase") || $0.lowercased() == "partitiondisk" }) {
                return .forbidden(reason: "Disk erasure is never allowed.")
            }
            return .permitted(risk: .critical, reason: "Disk utility invocation.")
        case "git":
            return classifyGit(arguments: arguments)
        case "curl", "wget", "nc", "ncat", "telnet", "ssh", "scp", "sftp", "rsync", "ftp":
            return .permitted(risk: .critical, reason: "Network access.")
        case "npm", "pnpm", "yarn", "bun":
            if arguments.contains(where: { ["install", "add", "i", "update", "upgrade", "publish"].contains($0) }) {
                return .permitted(risk: .critical, reason: "Dependency installation or publication.")
            }
            return .permitted(risk: .execute, reason: "Package script.")
        case "pip", "pip3", "uv", "brew", "gem", "cargo", "go":
            if arguments.contains(where: { ["install", "add", "get", "publish", "push"].contains($0) }) {
                return .permitted(risk: .critical, reason: "Dependency installation or publication.")
            }
            return .permitted(risk: .execute, reason: "Toolchain command.")
        case "chmod", "chown", "chgrp", "chflags":
            return .permitted(risk: .critical, reason: "Permission or ownership change.")
        case "kill", "killall", "pkill":
            return .permitted(risk: .critical, reason: "Process termination.")
        case "sh", "bash", "zsh", "fish", "dash", "ksh":
            if arguments.contains("-c") {
                return .permitted(risk: .critical, reason: "Nested shell command string.")
            }
            return .permitted(risk: .critical, reason: "Nested shell.")
        case "eval", "exec", "source":
            return .permitted(risk: .critical, reason: "Shell evaluation.")
        case "mv", "cp", "install":
            if arguments.contains(where: { $0.hasPrefix("/") || $0.hasPrefix("~") }) {
                return .permitted(risk: .critical, reason: "Touches paths outside the workspace.")
            }
            return .permitted(risk: .execute, reason: "File move or copy.")
        case "defaults", "osascript", "open", "security", "codesign", "xattr":
            return .permitted(risk: .critical, reason: "System-facing command.")
        default:
            if arguments.contains(where: { $0 == "--force" }) {
                return .permitted(risk: .critical, reason: "Forced operation.")
            }
            return .permitted(risk: .execute, reason: "Command execution.")
        }
    }

    private static func classifyRemove(program: String, arguments: [String]) -> CommandVerdict {
        let targets = arguments.filter { !$0.hasPrefix("-") }
        if targets.isEmpty {
            return .permitted(risk: .critical, reason: "Deletion with no explicit target.")
        }
        for target in targets {
            let normalized = target.hasSuffix("/") && target.count > 1
                ? String(target.dropLast())
                : target
            if normalized == "/" || normalized == "~" || normalized == "$HOME" {
                return .forbidden(reason: "Deleting the root or home directory is never allowed.")
            }
            if normalized.hasPrefix("/") || normalized.hasPrefix("~") {
                return .forbidden(reason: "Deleting absolute paths is never allowed.")
            }
            if normalized == "." || normalized == ".." || normalized.hasPrefix("../") {
                return .forbidden(reason: "Deleting outside or at the workspace root is never allowed.")
            }
            if normalized == "*" {
                return .permitted(risk: .critical, reason: "Wildcard deletion.")
            }
        }
        return .permitted(risk: .critical, reason: "File deletion.")
    }

    private static func classifyGit(arguments: [String]) -> CommandVerdict {
        // Find the subcommand, skipping global options such as -C <path>.
        var index = 0
        var subcommand: String?
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "-C" || argument == "-c" || argument == "--git-dir" || argument == "--work-tree" {
                index += 2
                continue
            }
            if argument.hasPrefix("-") {
                index += 1
                continue
            }
            subcommand = argument
            break
        }
        guard let subcommand else {
            return .permitted(risk: .execute, reason: "Git invocation.")
        }
        let rest = arguments[(index + 1)...]
        switch subcommand {
        case "push":
            if rest.contains(where: { ["--force", "-f", "--force-with-lease", "--delete", "--mirror"].contains($0) }) {
                return .permitted(risk: .critical, reason: "History-rewriting push.")
            }
            return .permitted(risk: .critical, reason: "Publishes commits to a remote.")
        case "reset":
            if rest.contains("--hard") || rest.contains("--merge") {
                return .permitted(risk: .critical, reason: "Destructive reset.")
            }
            return .permitted(risk: .execute, reason: "Git reset.")
        case "clean":
            return .permitted(risk: .critical, reason: "Deletes untracked files.")
        case "rebase", "filter-branch", "filter-repo", "reflog":
            return .permitted(risk: .critical, reason: "Rewrites or expires history.")
        case "checkout", "switch", "restore":
            if rest.contains("--force") || rest.contains("-f") {
                return .permitted(risk: .critical, reason: "Forced checkout discards changes.")
            }
            return .permitted(risk: .execute, reason: "Git checkout.")
        case "branch":
            if rest.contains("-D") {
                return .permitted(risk: .critical, reason: "Force-deletes a branch.")
            }
            return .permitted(risk: .execute, reason: "Git branch.")
        case "stash":
            if rest.first == "drop" || rest.first == "clear" {
                return .permitted(risk: .critical, reason: "Drops stashed work.")
            }
            return .permitted(risk: .execute, reason: "Git stash.")
        case "remote", "fetch", "pull":
            return .permitted(risk: .critical, reason: "Network access.")
        default:
            return .permitted(risk: .execute, reason: "Git \(subcommand).")
        }
    }

    private static let forbiddenPrograms: Set<String> = [
        "sudo", "su", "doas",
        "shutdown", "reboot", "halt", "poweroff",
        "mkfs", "newfs", "fdisk",
        "csrutil", "nvram", "kextload", "kextunload", "launchctl", "systemsetup",
        "passwd", "dscl", "sysadminctl", "visudo",
    ]
}

// MARK: - Tokenizer

enum ShellTokenKind: Equatable, Sendable {
    case word
    case controlOperator
    case redirect
}

struct ShellToken: Equatable, Sendable {
    let text: String
    let kind: ShellTokenKind
    let containsSubstitution: Bool
}

enum ShellTokenizer {
    /// Tokenizes with POSIX-ish quoting. Returns nil for input that cannot be
    /// parsed safely (unbalanced quotes or trailing escape).
    static func tokenize(_ input: String) -> [ShellToken]? {
        var tokens: [ShellToken] = []
        var current = ""
        var currentHasSubstitution = false
        var hasCurrent = false
        let characters = Array(input)
        var index = 0

        func flushWord() {
            guard hasCurrent else { return }
            let kind: ShellTokenKind = current.hasPrefix(">") || current.hasPrefix("<")
                ? .redirect
                : .word
            let text: String
            if kind == .redirect {
                text = String(current.drop(while: { $0 == ">" || $0 == "<" }))
            } else {
                text = current
            }
            tokens.append(
                ShellToken(text: text, kind: kind, containsSubstitution: currentHasSubstitution)
            )
            current = ""
            currentHasSubstitution = false
            hasCurrent = false
        }

        while index < characters.count {
            let character = characters[index]
            switch character {
            case "'":
                hasCurrent = true
                index += 1
                var closed = false
                while index < characters.count {
                    if characters[index] == "'" {
                        closed = true
                        break
                    }
                    current.append(characters[index])
                    index += 1
                }
                guard closed else { return nil }
                index += 1
            case "\"":
                hasCurrent = true
                index += 1
                var closed = false
                while index < characters.count {
                    let inner = characters[index]
                    if inner == "\"" {
                        closed = true
                        break
                    }
                    if inner == "\\", index + 1 < characters.count {
                        index += 1
                        current.append(characters[index])
                    } else {
                        if inner == "`" { currentHasSubstitution = true }
                        if inner == "$", index + 1 < characters.count, characters[index + 1] == "(" {
                            currentHasSubstitution = true
                        }
                        current.append(inner)
                    }
                    index += 1
                }
                guard closed else { return nil }
                index += 1
            case "\\":
                guard index + 1 < characters.count else { return nil }
                hasCurrent = true
                current.append(characters[index + 1])
                index += 2
            case " ", "\t", "\n":
                flushWord()
                index += 1
            case ";", "&", "|":
                flushWord()
                // Collapse &&, ||, |&, ; into one control operator token.
                var op = String(character)
                while index + 1 < characters.count,
                      [";", "&", "|"].contains(String(characters[index + 1]))
                {
                    index += 1
                    op.append(characters[index])
                }
                tokens.append(ShellToken(text: op, kind: .controlOperator, containsSubstitution: false))
                index += 1
            case "`":
                hasCurrent = true
                currentHasSubstitution = true
                current.append(character)
                index += 1
            case "$":
                hasCurrent = true
                if index + 1 < characters.count, characters[index + 1] == "(" {
                    currentHasSubstitution = true
                }
                current.append(character)
                index += 1
            case ">", "<":
                flushWord()
                var redirect = String(character)
                index += 1
                while index < characters.count, characters[index] == ">" || characters[index] == "&" {
                    redirect.append(characters[index])
                    index += 1
                }
                while index < characters.count, characters[index] == " " {
                    index += 1
                }
                var target = ""
                while index < characters.count,
                      ![" ", "\t", "\n", ";", "&", "|", ">", "<"].contains(String(characters[index]))
                {
                    target.append(characters[index])
                    index += 1
                }
                tokens.append(
                    ShellToken(text: target, kind: .redirect, containsSubstitution: false)
                )
            default:
                hasCurrent = true
                current.append(character)
                index += 1
            }
        }
        flushWord()
        return tokens
    }
}
