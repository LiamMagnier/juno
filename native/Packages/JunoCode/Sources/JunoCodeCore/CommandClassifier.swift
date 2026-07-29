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
        let redirectTargets = segment.filter { $0.kind == .redirect }.map(\.text)
        if redirectTargets.contains(where: \.isEmpty) {
            return .forbidden(reason: "Redirection is missing a target.")
        }

        let segmentWords = segment.filter { $0.kind == .word }.map(\.text)
        var words = segmentWords
        var environmentAssignments: [String] = []
        // Skip leading VAR=value assignments and `env` wrappers.
        while let first = words.first, first.contains("="), !first.hasPrefix("=") {
            environmentAssignments.append(first)
            words.removeFirst()
        }
        while words.first == "env" {
            words.removeFirst()
            while let first = words.first, first.contains("=") || first.hasPrefix("-") {
                if first.contains("="), !first.hasPrefix("-") {
                    environmentAssignments.append(first)
                }
                words.removeFirst()
            }
        }
        if let assignment = (environmentAssignments + words).first(where: isRiskyAssignment) {
            let name = assignment.split(separator: "=", maxSplits: 1).first.map(String.init)
                ?? assignment
            return .permitted(
                risk: .critical,
                reason: "Environment override '\(name)' can change which code is executed."
            )
        }
        guard let rawProgram = words.first else {
            if let reason = escapingPathReason(in: segmentWords + redirectTargets) {
                return .permitted(risk: .critical, reason: reason)
            }
            return .permitted(risk: .execute, reason: "Environment inspection or assignment.")
        }
        let program = rawProgram.split(separator: "/").last.map(String.init) ?? rawProgram
        let arguments = Array(words.dropFirst())

        if forbiddenPrograms.contains(program) {
            return .forbidden(reason: "'\(program)' is never run by the agent.")
        }
        let verdict: CommandVerdict
        switch program {
        case "rm", "rmdir", "unlink":
            verdict = classifyRemove(program: program, arguments: arguments)
        case "dd":
            if arguments.contains(where: { $0.hasPrefix("of=/dev/") }) {
                return .forbidden(reason: "Writing to raw devices is never allowed.")
            }
            verdict = .permitted(risk: .critical, reason: "Raw data copy.")
        case "diskutil":
            if arguments.contains(where: { $0.lowercased().hasPrefix("erase") || $0.lowercased() == "partitiondisk" }) {
                return .forbidden(reason: "Disk erasure is never allowed.")
            }
            verdict = .permitted(risk: .critical, reason: "Disk utility invocation.")
        case "git":
            verdict = classifyGit(arguments: arguments)
        case let executable where networkPrograms.contains(executable):
            verdict = .permitted(risk: .critical, reason: "Network access.")
        case "npm", "pnpm", "yarn":
            verdict = classifyPackageManager(program: program, arguments: arguments)
        case "pip", "pip3", "brew", "gem":
            verdict = .permitted(
                risk: .critical,
                reason: "Package-manager access can change the system or contact a registry."
            )
        case "cargo":
            verdict = classifyCargo(arguments: arguments)
        case "go":
            verdict = classifyGo(arguments: arguments)
        case "swift":
            verdict = classifySwift(arguments: arguments)
        case "find":
            verdict = classifyFind(arguments: arguments)
        case "rg", "grep", "egrep", "fgrep":
            verdict = classifySearch(program: program, arguments: arguments)
        case "chmod", "chown", "chgrp", "chflags":
            verdict = .permitted(risk: .critical, reason: "Permission or ownership change.")
        case "kill", "killall", "pkill":
            verdict = .permitted(risk: .critical, reason: "Process termination.")
        case let executable where interpreterPrograms.contains(executable):
            verdict = .permitted(
                risk: .critical,
                reason: "'\(program)' can evaluate code or launch another executable."
            )
        case "eval", "exec", "source", ".":
            verdict = .permitted(risk: .critical, reason: "Shell evaluation.")
        case "mv", "cp", "install":
            verdict = .permitted(risk: .execute, reason: "File move or copy.")
        case "defaults", "osascript", "open", "security", "codesign", "xattr":
            verdict = .permitted(risk: .critical, reason: "System-facing command.")
        case "gh", "docker", "podman", "kubectl", "helm", "terraform", "tofu",
             "aws", "gcloud", "az":
            verdict = .permitted(
                risk: .critical,
                reason: "External service or machine control."
            )
        case let executable where boundedPrograms.contains(executable):
            verdict = .permitted(risk: .execute, reason: "Bounded developer command.")
        default:
            verdict = .permitted(
                risk: .critical,
                reason: "Unrecognized executable '\(program)'."
            )
        }

        if case .forbidden = verdict {
            return verdict
        }
        // Calling a familiar binary through an explicit path can bypass PATH
        // policy (for example `./git` or `/tmp/swift`). It therefore cannot
        // inherit the familiar binary's lower risk classification.
        if rawProgram.contains("/") {
            return .permitted(risk: .critical, reason: "Explicit executable path.")
        }
        if let reason = escapingPathReason(in: segmentWords + redirectTargets) {
            return .permitted(risk: .critical, reason: reason)
        }
        if let flag = arguments.first(where: isUniversallyRiskyArgument) {
            return .permitted(risk: .critical, reason: "Risky option '\(flag)'.")
        }
        return verdict
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
            if argument == "-c" || argument.hasPrefix("--config-env") {
                return .permitted(
                    risk: .critical,
                    reason: "Inline Git configuration can invoke external helpers."
                )
            }
            if argument == "-C" || argument == "--git-dir" || argument == "--work-tree" {
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
            return .permitted(risk: .critical, reason: "Publishes commits to a remote.")
        case "fetch", "pull", "clone", "ls-remote", "submodule", "lfs":
            return .permitted(risk: .critical, reason: "Git network access.")
        case "remote":
            if rest.isEmpty || rest.allSatisfy({ ["-v", "--verbose"].contains($0) }) {
                return .permitted(risk: .execute, reason: "Read Git remotes.")
            }
            if rest.first == "get-url" {
                return .permitted(risk: .execute, reason: "Read a Git remote URL.")
            }
            return .permitted(risk: .critical, reason: "Changes Git remote configuration.")
        case "reset", "clean", "checkout", "switch", "restore", "stash", "rebase",
             "filter-branch", "filter-repo", "reflog", "commit", "merge",
             "cherry-pick", "revert", "am", "rm", "worktree", "gc", "prune":
            return .permitted(
                risk: .critical,
                reason: "Git operation can discard work, run hooks, or rewrite repository state."
            )
        case "branch":
            if rest.contains(where: {
                ["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--force"]
                    .contains($0)
            }) {
                return .permitted(risk: .critical, reason: "Changes an existing Git branch.")
            }
            return .permitted(risk: .execute, reason: "Git branch.")
        case "tag":
            if rest.contains(where: { ["-d", "--delete", "-f", "--force", "-s", "--sign"].contains($0) }) {
                return .permitted(risk: .critical, reason: "Deletes, replaces, or signs a Git tag.")
            }
            return .permitted(risk: .execute, reason: "Git tag.")
        case "config":
            let readOnlyOptions: Set<String> = [
                "--get", "--get-all", "--get-regexp", "--get-urlmatch",
                "--list", "-l", "--show-origin", "--show-scope",
                "--name-only", "--null", "-z",
            ]
            if !rest.isEmpty, rest.allSatisfy({ $0.hasPrefix("-") && readOnlyOptions.contains($0) }) {
                return .permitted(risk: .execute, reason: "Read Git configuration.")
            }
            return .permitted(risk: .critical, reason: "Changes or broadly exposes Git configuration.")
        case "status", "diff", "log", "show", "rev-parse", "rev-list", "describe",
             "ls-files", "ls-tree", "cat-file", "name-rev", "shortlog", "blame",
             "grep", "count-objects", "for-each-ref", "merge-base", "show-ref",
             "symbolic-ref", "verify-pack", "help", "version", "add", "apply", "init":
            return .permitted(risk: .execute, reason: "Bounded Git operation.")
        default:
            // Git resolves unknown subcommands through aliases and `git-*`
            // executables. Treating them as ordinary commands would recreate
            // the same approval bypass as an unknown top-level executable.
            return .permitted(risk: .critical, reason: "Unrecognized Git subcommand.")
        }
    }

    private static func classifyPackageManager(
        program: String,
        arguments: [String]
    ) -> CommandVerdict {
        guard let subcommand = arguments.first(where: { !$0.hasPrefix("-") }) else {
            return .permitted(risk: .execute, reason: "\(program) version or help.")
        }
        if ["list", "ls", "why"].contains(subcommand) {
            return .permitted(risk: .execute, reason: "Inspect local package metadata.")
        }
        return .permitted(
            risk: .critical,
            reason: "\(program) can run package scripts or contact a registry."
        )
    }

    private static func classifyCargo(arguments: [String]) -> CommandVerdict {
        guard let subcommand = arguments.first(where: { !$0.hasPrefix("-") }) else {
            return .permitted(risk: .execute, reason: "Cargo version or help.")
        }
        switch subcommand {
        case "build", "check", "test", "doc", "fmt", "clippy", "metadata", "tree":
            return .permitted(risk: .execute, reason: "Cargo workspace command.")
        default:
            return .permitted(
                risk: .critical,
                reason: "Cargo subcommand can execute a binary, change dependencies, or use the network."
            )
        }
    }

    private static func classifyGo(arguments: [String]) -> CommandVerdict {
        guard let subcommand = arguments.first(where: { !$0.hasPrefix("-") }) else {
            return .permitted(risk: .execute, reason: "Go version or help.")
        }
        switch subcommand {
        case "build", "test", "vet", "fmt", "list", "doc":
            return .permitted(risk: .execute, reason: "Go workspace command.")
        default:
            return .permitted(
                risk: .critical,
                reason: "Go subcommand can execute code, change dependencies, or use the network."
            )
        }
    }

    private static func classifySwift(arguments: [String]) -> CommandVerdict {
        if arguments.contains(where: { ["-e", "-interpret", "-frontend"].contains($0) }) {
            return .permitted(risk: .critical, reason: "Swift interpreter invocation.")
        }
        guard let subcommand = arguments.first(where: { !$0.hasPrefix("-") }) else {
            return .permitted(risk: .execute, reason: "Swift version or help.")
        }
        switch subcommand {
        case "build", "test", "format":
            return .permitted(risk: .execute, reason: "Swift workspace command.")
        case "package":
            if arguments.contains(where: {
                ["resolve", "update", "edit", "unedit", "reset", "purge-cache"].contains($0)
            }) {
                return .permitted(risk: .critical, reason: "Swift package dependency mutation.")
            }
            return .permitted(risk: .execute, reason: "Swift package inspection.")
        default:
            return .permitted(
                risk: .critical,
                reason: "Swift invocation can interpret or run code."
            )
        }
    }

    private static func classifyFind(arguments: [String]) -> CommandVerdict {
        let activePrimitives: Set<String> = [
            "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0",
        ]
        if arguments.contains(where: { activePrimitives.contains($0) || $0 == "-L" }) {
            return .permitted(
                risk: .critical,
                reason: "Find invocation can execute commands, write files, delete, or follow symlinks."
            )
        }
        return .permitted(risk: .execute, reason: "Workspace file search.")
    }

    private static func classifySearch(
        program: String,
        arguments: [String]
    ) -> CommandVerdict {
        if arguments.contains(where: {
            ["--follow", "--dereference-recursive"].contains($0)
                || (program == "grep" && $0 == "-R")
                || (program == "rg" && $0 == "-L")
        }) {
            return .permitted(risk: .critical, reason: "Search follows symbolic links.")
        }
        return .permitted(risk: .execute, reason: "Workspace text search.")
    }

    private static func escapingPathReason(in words: [String]) -> String? {
        for word in words where !word.isEmpty {
            if word.hasPrefix("~") || word.contains("$HOME") || word.contains("${HOME}") {
                return "Command refers to the user's home directory."
            }
            if word.hasPrefix("file://") {
                return "Command refers to an absolute file URL."
            }

            var candidates = [word]
            if let equals = word.firstIndex(of: "=") {
                candidates.append(String(word[word.index(after: equals)...]))
            }
            if word.hasPrefix("@") {
                candidates.append(String(word.dropFirst()))
            }
            if word.hasPrefix("-"), let slash = word.firstIndex(of: "/") {
                candidates.append(String(word[slash...]))
            }

            for candidate in candidates {
                if candidate.hasPrefix("/") {
                    return "Command refers to an absolute path."
                }
                let components = candidate.split(separator: "/", omittingEmptySubsequences: false)
                if components.contains("..") {
                    return "Command refers to a parent directory."
                }
            }
        }
        return nil
    }

    private static func isUniversallyRiskyArgument(_ argument: String) -> Bool {
        let name = argument.split(separator: "=", maxSplits: 1).first.map(String.init) ?? argument
        return riskyArguments.contains(name)
    }

    private static func isRiskyAssignment(_ argument: String) -> Bool {
        guard let equals = argument.firstIndex(of: "=") else { return false }
        let name = String(argument[..<equals])
        guard !name.hasPrefix("-") else { return false }
        return riskyEnvironmentNames.contains(name)
            || riskyEnvironmentPrefixes.contains(where: { name.hasPrefix($0) })
    }

    private static let forbiddenPrograms: Set<String> = [
        "sudo", "su", "doas",
        "shutdown", "reboot", "halt", "poweroff",
        "mkfs", "newfs", "fdisk",
        "csrutil", "nvram", "kextload", "kextunload", "launchctl", "systemsetup",
        "passwd", "dscl", "sysadminctl", "visudo",
    ]

    private static let networkPrograms: Set<String> = [
        "curl", "wget", "nc", "ncat", "telnet", "ssh", "scp", "sftp", "rsync", "ftp",
    ]

    private static let interpreterPrograms: Set<String> = [
        "sh", "bash", "zsh", "fish", "dash", "ksh",
        "python", "python2", "python3", "pypy", "pypy3",
        "node", "npx", "deno", "bun", "tsx", "ts-node",
        "ruby", "perl", "php", "lua", "luajit",
        "R", "Rscript", "julia", "tclsh", "wish", "expect",
        "java", "js", "qjs", "groovy", "dotnet-script", "uv",
    ]

    /// Commands whose ordinary form is useful for workspace inspection or a
    /// bounded build. Program-specific interpreters, package runners, network
    /// clients, system tools, and unknown executables are deliberately absent.
    private static let boundedPrograms: Set<String> = [
        "pwd", "cd", "pushd", "popd",
        "ls", "tree", "stat", "file", "basename", "dirname", "readlink", "realpath",
        "cat", "head", "tail", "cut", "sort", "uniq", "wc", "tr", "cmp", "comm", "diff",
        "echo", "printf", "true", "false", "test", "[", "expr",
        "date", "uname", "sw_vers", "whoami", "id", "ps", "env",
        "md5", "md5sum", "sha1sum", "sha256sum", "shasum",
        "jq",
        "swiftc", "xcodebuild", "clang", "clang++", "gcc", "g++",
        "make", "cmake", "ninja", "ctest",
        "tsc", "eslint", "prettier", "biome", "swiftlint", "swiftformat",
    ]

    private static let riskyArguments: Set<String> = [
        "--force", "--force-with-lease", "--delete", "--overwrite",
        "--no-preserve-root", "--unsafe", "--unsafe-paths",
        "--no-sandbox", "--disable-sandbox", "--privileged",
        "--allow-root", "--global", "--system", "--ext-diff", "--textconv",
    ]

    private static let riskyEnvironmentNames: Set<String> = [
        "PATH", "FPATH", "CDPATH", "HOME", "SHELL", "ZDOTDIR",
        "BASH_ENV", "ENV",
        "PAGER", "MANPAGER", "EDITOR", "VISUAL", "LESSOPEN",
        "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "RUBYOPT", "PERL5OPT",
        "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS",
        "MAKEFLAGS", "MFLAGS",
        "CC", "CXX", "LD", "AR", "RANLIB",
        "RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER",
        "SWIFT_EXEC", "SWIFT_DRIVER_SWIFT_FRONTEND_EXEC", "SWIFT_DRIVER_CLANG_EXEC",
    ]

    private static let riskyEnvironmentPrefixes: [String] = [
        "DYLD_", "LD_", "GIT_CONFIG_", "GIT_SSH", "GIT_EXTERNAL_",
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
        var redirectTargetPending = false
        let characters = Array(input)
        var index = 0

        func flushWord(allowEmptyRedirect: Bool = false) {
            guard hasCurrent || (redirectTargetPending && allowEmptyRedirect) else {
                return
            }
            let kind: ShellTokenKind = redirectTargetPending ? .redirect : .word
            tokens.append(
                ShellToken(
                    text: current,
                    kind: kind,
                    containsSubstitution: currentHasSubstitution
                )
            )
            current = ""
            currentHasSubstitution = false
            hasCurrent = false
            redirectTargetPending = false
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
                flushWord(allowEmptyRedirect: true)
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
                flushWord(allowEmptyRedirect: true)
                index += 1
                while index < characters.count,
                      [">", "<", "&"].contains(String(characters[index]))
                {
                    index += 1
                }
                while index < characters.count,
                      [" ", "\t", "\n"].contains(String(characters[index]))
                {
                    index += 1
                }
                redirectTargetPending = true
                currentHasSubstitution =
                    index < characters.count && characters[index] == "("
            default:
                hasCurrent = true
                current.append(character)
                index += 1
            }
        }
        flushWord(allowEmptyRedirect: true)
        return tokens
    }
}
