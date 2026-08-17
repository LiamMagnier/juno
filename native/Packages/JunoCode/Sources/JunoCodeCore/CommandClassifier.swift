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
            // `$(…)` hides a whole second command from every rule below, so the
            // classification has to assume the worst about what it expands to.
            // It stays out of the `destructive` tier because the substitution
            // itself is not an escape — `echo $(git rev-parse HEAD)` is routine —
            // but it can never be treated as bounded.
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
            // A DYLD_/LD_/PATH override redirects which binary runs, so it can
            // substitute anything for a command that looks bounded. Not
            // something a mode setting may waive.
            return .permitted(
                risk: .destructive,
                reason: "Environment override '\(name)' can change which code is executed."
            )
        }
        guard let rawProgram = words.first else {
            if let reason = escapingPathReason(in: segmentWords + redirectTargets) {
                return .permitted(risk: .destructive, reason: reason)
            }
            return .permitted(risk: .execute, reason: "Environment inspection or assignment.")
        }
        let program = rawProgram.split(separator: "/").last.map(String.init) ?? rawProgram
        let arguments = Array(words.dropFirst())

        if forbiddenPrograms.contains(program) {
            return .forbidden(reason: "'\(program)' is never run by the agent.")
        }
        if isLongRunningPreviewServer(program: program, arguments: arguments) {
            return .forbidden(
                reason: "'\(program)' is a preview server. Use open_preview to start and manage local preview servers."
            )
        }
        let verdict: CommandVerdict
        switch program {
        case "rm", "rmdir", "unlink":
            verdict = classifyRemove(program: program, arguments: arguments)
        case "dd":
            if arguments.contains(where: { $0.hasPrefix("of=/dev/") }) {
                return .forbidden(reason: "Writing to raw devices is never allowed.")
            }
            verdict = .permitted(risk: .destructive, reason: "Raw data copy.")
        case "diskutil":
            if arguments.contains(where: { $0.lowercased().hasPrefix("erase") || $0.lowercased() == "partitiondisk" }) {
                return .forbidden(reason: "Disk erasure is never allowed.")
            }
            verdict = .permitted(risk: .destructive, reason: "Disk utility invocation.")
        case "git":
            verdict = classifyGit(arguments: arguments)
        case let executable where remoteAccessPrograms.contains(executable):
            // A remote shell or a sync to another host acts on a machine this
            // workspace grant says nothing about.
            verdict = .permitted(
                risk: .destructive,
                reason: "'\(program)' acts on another machine."
            )
        case let executable where networkPrograms.contains(executable):
            verdict = .permitted(risk: .critical, reason: "Network access.")
        case "npm", "pnpm", "yarn":
            verdict = classifyPackageManager(program: program, arguments: arguments)
        case "pip", "pip3", "gem":
            verdict = .permitted(
                risk: .critical,
                reason: "\(program) can run install hooks or contact a registry."
            )
        case "brew":
            // Homebrew installs and unlinks software for the whole machine, well
            // outside the folder this session was pointed at.
            verdict = .permitted(
                risk: .destructive,
                reason: "Homebrew changes software outside this workspace."
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
            verdict = .permitted(
                risk: .destructive,
                reason: "Permission or ownership change."
            )
        case "kill", "killall", "pkill":
            // The target is a process on the user's Mac, chosen by name or pid;
            // nothing scopes it to this workspace.
            verdict = .permitted(risk: .destructive, reason: "Process termination.")
        case let executable where interpreterPrograms.contains(executable):
            // Running the project's own tests and scripts. Arbitrary code, but
            // code from the folder the session was granted — which is precisely
            // what `critical` means and why full access proceeds.
            //
            // An INLINE program breaks that assumption. `python3 -c "…"`,
            // `node -e "…"`, `bash -c "…"` run code the model wrote, not code
            // from the granted folder, and the string is opaque to every rule in
            // this file: an `rm -rf /`, a `chmod`, a `curl | sh` inside it is
            // never seen. So it is not ordinary development — it escapes the
            // workspace boundary, which is the definition of `destructive`.
            //
            // This is load-bearing beyond the risk ladder: the macOS entitlements
            // file justifies disabling the App Sandbox on the soundness of this
            // classifier, and an unread `-c` string is the one input it cannot
            // reason about at all.
            if hasInlineProgramArgument(program: executable, arguments: arguments) {
                verdict = .permitted(
                    risk: .destructive,
                    reason: "'\(program)' runs an inline program this classifier cannot inspect."
                )
            } else {
                verdict = .permitted(
                    risk: .critical,
                    reason: "'\(program)' can evaluate code or launch another executable."
                )
            }
        case "eval", "exec", "source", ".":
            verdict = .permitted(risk: .critical, reason: "Shell evaluation.")
        case "mv", "cp", "install":
            verdict = .permitted(risk: .execute, reason: "File move or copy.")
        case "defaults", "osascript", "open", "security", "codesign", "xattr":
            // System preferences, driving other apps, and the keychain.
            verdict = .permitted(risk: .destructive, reason: "System-facing command.")
        case "gh", "docker", "podman", "kubectl", "helm", "terraform", "tofu",
             "aws", "gcloud", "az":
            // These act on infrastructure and services, where a mistake is not
            // recoverable by a workspace checkpoint.
            verdict = .permitted(
                risk: .destructive,
                reason: "External service or machine control."
            )
        case let executable where boundedPrograms.contains(executable):
            verdict = .permitted(risk: .execute, reason: "Bounded developer command.")
        default:
            // An unknown program is not necessarily dangerous — `just`, `bazel`,
            // `poetry`, `pytest`, `uvicorn` and every project-local tool land
            // here — but it is unclassified, so it stays gated everywhere except
            // full access.
            verdict = .permitted(
                risk: .critical,
                reason: "Unrecognized executable '\(program)'."
            )
        }

        if case .forbidden = verdict {
            return verdict
        }
        // Naming a path outside the grant — absolute, `..`, `~`, `$HOME`, a
        // `file://` URL — is destructive whatever the program is.
        //
        // Checked *before* the explicit-path rule below, which is a reordering
        // and not just a move: with the old order `/tmp/swift` returned "explicit
        // executable path" and never reached this test, so leaving the workspace
        // and being path-qualified were reported as the same thing at the same
        // risk. They are now distinguishable, which is what lets the second rule
        // relax without opening the first.
        if let reason = escapingPathReason(in: segmentWords + redirectTargets) {
            return .permitted(risk: .destructive, reason: reason)
        }
        // A path-qualified program that got past the check above resolves inside
        // the workspace: `./gradlew`, `./scripts/test.sh`, `bin/tool`. It still
        // must not inherit a familiar binary's lower classification — `./git` is
        // not git — but running a script out of the folder Juno may already write
        // to is ordinary development, not an escape from it.
        if rawProgram.contains("/") {
            return .permitted(risk: .critical, reason: "Executable from the workspace.")
        }
        if let flag = arguments.first(where: isUniversallyRiskyArgument) {
            // A short, deliberately chosen list: forcing, deleting, disabling a
            // sandbox, or widening scope to --global/--system.
            return .permitted(risk: .destructive, reason: "Risky option '\(flag)'.")
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
                // `git -c core.pager=…` / `-c core.sshCommand=…` runs an
                // arbitrary external helper of the caller's choosing.
                return .permitted(
                    risk: .destructive,
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
        case "filter-branch", "filter-repo":
            // Rewrites every commit in the repository. Not something a checkpoint
            // can put back.
            return .permitted(
                risk: .destructive,
                reason: "Rewrites the repository's entire history."
            )
        case "reset", "clean", "checkout", "switch", "restore", "stash", "rebase",
             "reflog", "commit", "merge",
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

    /// Fetching over the network. Ordinary work for a build or a test suite, so
    /// these are `critical` rather than `destructive`: the bytes land in the
    /// workspace.
    private static let networkPrograms: Set<String> = [
        "curl", "wget", "ftp",
    ]

    /// Acting on *another machine* — a shell, a copy, or a raw socket. The
    /// workspace grant says nothing about the far end, so no mode waives these.
    private static let remoteAccessPrograms: Set<String> = [
        "nc", "ncat", "telnet", "ssh", "scp", "sftp", "rsync",
    ]

    /// Flags that make an interpreter execute a string ARGUMENT rather than a
    /// file from the workspace, **per program**.
    ///
    /// Per program because the same letter means unrelated things depending on
    /// who reads it. `-c` is inline code to `sh` and `python`, but it is the
    /// classpath to `java` (`-cp`), a config file to `deno`, `eslint`, `jest`
    /// and `prettier`, and a syntax-ONLY check to `perl` and `ruby` — which
    /// parses a file and deliberately runs nothing. A single shared set matched
    /// every one of those, so `java -cp … Main`, `npx eslint -c …`,
    /// `python3 -m pytest -p …` and `perl -c script.pl` all came out
    /// `destructive`, and `.destructive` requires approval in EVERY mode. Full
    /// access stopped meaning full access on the commands a build runs on
    /// almost every turn.
    ///
    /// Matched on the whole token, so a path like `-config.py` is not a flag;
    /// `--eval=…` is caught by the prefix check below because it carries its
    /// program inline just the same.
    private static let inlineProgramFlags: [String: Set<String>] = {
        var flags: [String: Set<String>] = [:]
        for program in shellPrograms {
            flags[program] = ["-c", "--command"]
        }
        for program in ["node", "deno", "bun", "tsx", "ts-node", "js", "qjs"] {
            flags[program] = ["-e", "--eval", "-p", "--print"]
        }
        for program in ["python", "python2", "python3", "pypy", "pypy3"] {
            flags[program] = ["-c"]
        }
        // -e/-E is the inline one for these two; -c is `--check`, a parse with
        // no execution.
        for program in ["perl", "ruby"] {
            flags[program] = ["-e", "-E"]
        }
        for program in ["lua", "luajit", "R", "Rscript", "groovy"] {
            flags[program] = ["-e"]
        }
        flags["julia"] = ["-e", "-E"]
        flags["php"] = ["-r"]
        // Absent on purpose: java, npx, uv, dotnet-script, tclsh, wish, expect.
        // They are handed a script path, a class or a package name — there is no
        // flag that turns an argument into the program.
        return flags
    }()

    /// Shells, where clustered short flags are real: `sh -lc "…"` is as inline
    /// as `sh -c "…"`.
    private static let shellPrograms: Set<String> = [
        "sh", "bash", "zsh", "fish", "dash", "ksh",
    ]

    /// True when this interpreter was handed a program on the command line.
    ///
    /// Every argument is examined, not just the leading flag run, because a flag
    /// that takes a value would otherwise end the scan early and hide what
    /// follows it — `python3 -W ignore -c "…"` is still inline code. The cost is
    /// that a script's OWN `-c` argument can be mistaken for the interpreter's;
    /// that direction over-asks rather than under-asks, which is the right way
    /// for this check to be wrong.
    private static func hasInlineProgramArgument(
        program: String,
        arguments: [String]
    ) -> Bool {
        guard let inlineFlags = inlineProgramFlags[program] else { return false }
        for argument in arguments {
            if inlineFlags.contains(argument) { return true }
            // `--eval=…`, `--command=…`: the program is inline in one token.
            if let separator = argument.firstIndex(of: "="),
               inlineFlags.contains(String(argument[argument.startIndex..<separator])) {
                return true
            }
            // Clustered short flags, e.g. `sh -lc "…"`. Shells only: elsewhere a
            // single-dash letter run is far more likely to be `-cp` or `-rn`.
            if shellPrograms.contains(program), argument.hasPrefix("-"), !argument.hasPrefix("--"),
               argument.count > 2, argument.dropFirst().allSatisfy({ $0.isLetter }),
               argument.contains("c") {
                return true
            }
        }
        return false
    }

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

    private static func isLongRunningPreviewServer(program: String, arguments: [String]) -> Bool {
        if program == "http-server" || program == "live-server" || program == "serve" {
            return true
        }
        if ["python", "python2", "python3", "pypy", "pypy3"].contains(program) {
            if let mIndex = arguments.firstIndex(of: "-m"), mIndex + 1 < arguments.count {
                let module = arguments[mIndex + 1]
                if module == "http.server" || module == "SimpleHTTPServer" {
                    return true
                }
            }
        }
        if program == "npx" {
            let nonFlags = arguments.filter { !$0.hasPrefix("-") }
            if let first = nonFlags.first, ["serve", "http-server", "live-server"].contains(first) {
                return true
            }
        }
        return false
    }
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
