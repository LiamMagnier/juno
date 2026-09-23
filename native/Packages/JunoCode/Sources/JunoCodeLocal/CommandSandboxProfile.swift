import Foundation
import JunoCodeCore

/// Environment-level containment for locally executed commands.
///
/// Juno already classifies commands by risk and scrubs the environment they
/// run in, and both are worth having — but neither is a boundary. A classifier
/// works on the text of a command, and any command it recognises can be
/// spelled another way: through a variable, a generated script, a here-doc, a
/// `python -c`, a Makefile target. Nothing that inspects a string can be the
/// thing that stops `curl … | sh` from reading `~/.ssh`.
///
/// This is the boundary: a macOS sandbox profile applied by the kernel, under
/// which a command physically cannot write outside the granted workspace or
/// open a socket, however it is written.
///
/// `sandbox-exec` is formally deprecated by Apple and still the only mechanism
/// available to a non-root process that wants to confine a child it did not
/// write. The alternative — a dedicated XPC execution service, or a VM — is a
/// larger change; this is deliberately the smaller one that can ship now, and
/// it is a real kernel-enforced boundary rather than an advisory one.
public struct CommandSandboxProfile: Equatable, Sendable {
    /// How much of the filesystem the command may change.
    public enum FilesystemAccess: String, Equatable, Sendable, CaseIterable {
        /// Reads anywhere the app can, writes nowhere.
        case readOnly
        /// Writes inside the workspace; may not delete it or escape it.
        case readWrite
    }

    public let workspaceRoot: URL
    public let filesystem: FilesystemAccess
    /// Off by default on the profile initializer. The normal Code workspace
    /// passes `true` only after its runtime permission gate authorizes the
    /// command; callers such as the preview server keep this false or allow
    /// localhost explicitly. A command never grants this capability itself.
    public let allowsNetwork: Bool
    /// Whether a long-lived local service may bind and connect on loopback.
    /// This is deliberately separate from arbitrary network access: a preview
    /// needs localhost, but a command should not gain a path to the Internet.
    public let allowsLocalhost: Bool
    /// Extra roots a command legitimately needs: caches, toolchains, temp.
    public let additionalWritablePaths: [String]
    /// Whether the project's policy files are refused to commands.
    ///
    /// On for everything the agent runs. Off for the reader's own terminal:
    /// they may edit those files in any editor anyway, and refusing their
    /// `git pull` or `git checkout` because it updates a tracked
    /// `.juno/settings.json` would protect nothing.
    public let protectsPolicyFiles: Bool
    /// The reader's home folder, whose toolchain folders the profile protects.
    public let homeDirectory: String

    public init(
        workspaceRoot: URL,
        filesystem: FilesystemAccess = .readWrite,
        allowsNetwork: Bool = false,
        allowsLocalhost: Bool = false,
        additionalWritablePaths: [String] = CommandSandboxProfile.defaultWritablePaths,
        protectsPolicyFiles: Bool = true,
        homeDirectory: String = NSHomeDirectory()
    ) {
        self.workspaceRoot = workspaceRoot
        self.filesystem = filesystem
        self.allowsNetwork = allowsNetwork
        self.allowsLocalhost = allowsLocalhost
        self.additionalWritablePaths = additionalWritablePaths
        self.protectsPolicyFiles = protectsPolicyFiles
        self.homeDirectory = homeDirectory
    }

    /// Paths a real build cannot function without.
    ///
    /// Without these the containment is not "safe", it is "unusable": swiftc,
    /// npm, cargo and every test runner write to a temporary directory and a
    /// module cache. A user whose builds all fail turns containment off, which
    /// leaves them with less protection than a slightly wider profile would.
    /// Deliberately NOT `/private/tmp`. That directory is world-writable and
    /// shared with every other process on the machine, so granting it hands a
    /// command a staging area outside the workspace that anything else can
    /// read — which is most of what an exfiltration attempt needs. macOS points
    /// `TMPDIR` at a per-user directory under `/private/var/folders`, which is
    /// what toolchains actually use, so this costs nothing real.
    public static let defaultWritablePaths: [String] = [
        "/private/var/folders",
        "/private/var/tmp",
        "/dev/null",
        "/dev/dtracehelper",
        "/dev/tty",
        "/dev/urandom",
        "/dev/random",
    ]

    /// Package-manager and build caches under the home folder.
    ///
    /// `npm install`, `cargo build` and `pod install` all write to a cache
    /// outside the project first; without these the first dependency install
    /// of every session failed inside the sandbox, which taught readers to
    /// turn containment off.
    ///
    /// The test for an entry: nothing written there is later run, or read as
    /// configuration, by a process outside the sandbox. The list used to
    /// hold whole tool roots — `~/.bun`, `~/.yarn`, `~/Library/pnpm` — which
    /// are also where those tools keep their own binaries and global bins,
    /// all on the reader's PATH. A command could replace one, and the reader's
    /// next use of that tool from their own shell ran it with full access,
    /// long after the session. Nor did the broader entries pass:
    /// `~/Library/Caches` holds app updaters' staging folders and Playwright's
    /// browsers, `~/.cache` pre-commit's hook environments, `~/.swiftpm` and
    /// `~/Library/org.swift.swiftpm` SwiftPM's mirror and registry
    /// configuration, DerivedData the products Xcode runs, `~/.npm` the
    /// packages `npx` runs, and `~/.cargo` and `~/go/pkg` the extracted
    /// sources every later build compiles.
    ///
    /// What is shared with the reader now is package-manager download caches
    /// and stores, and never a folder with a binary or a settings file in it
    /// (`protectedToolchainPaths` holds that line whatever this list says).
    /// The tools whose shared folders mixed a cache with those things write
    /// to a cache Juno owns instead (`commandCacheEnvironment`). SwiftPM needs
    /// none of it: it warns and builds without its user-level caches. Xcode
    /// needs a `-derivedDataPath` inside the workspace.
    public static var toolchainCachePaths: [String] {
        toolchainCachePaths(homeDirectory: NSHomeDirectory())
    }

    public static func toolchainCachePaths(homeDirectory home: String) -> [String] {
        [
            "/.bun/install/cache",
            "/Library/pnpm/store", "/.pnpm-store", "/Library/Caches/pnpm",
            "/.yarn/berry/cache", "/Library/Caches/Yarn",
            // DENO_DIR is ~/Library/Caches/deno unless the reader moved it;
            // ~/.deno itself holds `deno install`'s scripts.
            "/Library/Caches/deno",
            "/.deno/deps", "/.deno/remote", "/.deno/npm", "/.deno/gen", "/.deno/registries",
            "/.rustup/tmp",
            // Not yet moved to a cache Juno owns, and short of the test above:
            // Gradle keeps compiled build scripts here and CocoaPods keeps spec
            // repositories whose install hooks run. Nothing else lets those
            // builds work in the sandbox yet.
            "/.gradle/caches", "/.m2/repository", "/.cocoapods", "/Library/Caches/CocoaPods",
            "/Library/Developer/CoreSimulator/Caches",
        ].map { home + $0 } + [commandCacheRoot(homeDirectory: home)]
    }

    /// Where agent-run tools keep what they would otherwise write into the
    /// reader's own tool folders. Only sandboxed commands are pointed here, so
    /// nothing outside the sandbox ever builds from it.
    public static func commandCacheRoot(homeDirectory: String = NSHomeDirectory()) -> String {
        homeDirectory + "/Library/Caches/JunoCode/CommandCaches"
    }

    /// The variables that point those tools at `commandCacheRoot`.
    ///
    /// Cargo's home holds its binaries, its `env` script, its configuration
    /// and the extracted crate sources every build compiles, so it moves as a
    /// whole. The reader's `~/.cargo/config.toml` is still read for a project
    /// under their home folder, because Cargo also looks for configuration in
    /// every parent folder. npm's cache also holds the packages `npx` runs;
    /// Go's module cache is extracted source and its build cache is compiled
    /// output; node-gyp's folder holds the headers native modules compile
    /// against; pip's holds built wheels. `XDG_CACHE_HOME` stands in for
    /// `~/.cache`.
    public static func commandCacheEnvironment(homeDirectory: String = NSHomeDirectory()) -> [String: String] {
        let root = commandCacheRoot(homeDirectory: homeDirectory)
        return [
            "CARGO_HOME": root + "/cargo",
            "npm_config_cache": root + "/npm",
            "npm_config_devdir": root + "/node-gyp",
            "GOMODCACHE": root + "/go/mod",
            "GOCACHE": root + "/go/build",
            "PIP_CACHE_DIR": root + "/pip",
            "XDG_CACHE_HOME": root + "/xdg",
        ]
    }

    /// Whether commands under this profile may use Juno's own caches.
    public var grantsCommandCache: Bool {
        filesystem == .readWrite
            && additionalWritablePaths.contains(Self.commandCacheRoot(homeDirectory: homeDirectory))
    }

    /// What no command may write, whatever the allow rules above say.
    ///
    /// Every folder on the PATH Juno builds, where a replaced binary would run
    /// next time the reader typed its name; `~/.deno/bin`, where
    /// `deno install` puts its scripts; and the configuration files other
    /// tools read from the home folder. Denied after the allowances, and later
    /// rules win, so no later change to the allow list, and no folder a
    /// settings file adds, can re-open one.
    static func protectedToolchainPaths(homeDirectory home: String) -> [String] {
        var seen = Set<String>()
        return (
            ToolchainEnvironment.candidateToolchainDirectories(homeDirectory: home)
                + ToolchainEnvironment.defaultBasePaths
                + [
                    home + "/.deno/bin", home + "/.cargo/bin",
                    home + "/.cargo/env", home + "/.cargo/env.fish", home + "/.cargo/env.nu",
                    home + "/.cargo/config", home + "/.cargo/config.toml",
                    home + "/.cargo/credentials", home + "/.cargo/credentials.toml",
                    home + "/.swiftpm/configuration", home + "/Library/org.swift.swiftpm/configuration",
                    home + "/.cocoapods/config.yaml",
                    home + "/.yarnrc", home + "/.yarnrc.yml", home + "/.npmrc",
                ]
        ).filter { seen.insert($0).inserted }
    }

    /// The SBPL profile text.
    ///
    /// Default-deny, then the narrowest set of allowances that lets an ordinary
    /// build run. Reads are broadly permitted because a compiler must see its
    /// own toolchain and the system headers; *writes* are what the workspace
    /// grant is about, and they are enumerated.
    public func profileText() -> String {
        var lines: [String] = [
            "(version 1)",
            "(deny default)",
            // Building means running compilers, linkers and test binaries.
            "(allow process-exec process-fork)",
            "(allow signal (target same-sandbox))",
            "(allow sysctl-read)",
            "(allow mach-lookup)",
            // A toolchain reads far more than the workspace: SDKs, headers,
            // caches, the user's own config. Reading is not the risk the
            // workspace grant addresses — leaving the workspace with a *write*
            // is, along with sending its contents somewhere.
            "(allow file-read*)",
            "(allow file-read-metadata)",
        ]

        if filesystem == .readWrite {
            for path in ([workspaceRoot.path] + additionalWritablePaths).map(Self.resolved) {
                lines.append("(allow file-write* (subpath \(Self.quote(path))))")
            }
            // The project's policy files, and Juno's folder itself, are not a
            // command's to write, whatever the mode: a shell redirect would
            // otherwise reach what the file tools ask about every time. Later
            // rules win in SBPL, so these denies override the workspace grant.
            // The folder is denied as an entry only, so worktrees and other
            // files inside it stay writable while a swap of the whole folder
            // does not. Both the path as named and as resolved are listed, in
            // case either part of it is a link.
            let protected = protectsPolicyFiles
                ? WorkspacePolicyPaths.files + [WorkspacePolicyPaths.folder]
                : []
            for relative in protected {
                let named = workspaceRoot.path + "/" + relative
                for path in Set([Self.resolved(workspaceRoot.path) + "/" + relative, Self.resolved(named)]).sorted() {
                    lines.append("(deny file-write* (literal \(Self.quote(path))))")
                }
            }
            lines += toolchainDenials()
            // ioctl on a tty is what makes interactive-ish tools work at all.
            lines.append("(allow file-ioctl (subpath \"/dev\"))")
        }

        if allowsNetwork {
            lines.append("(allow network-outbound)")
            lines.append("(allow network-inbound)")
            lines.append("(allow system-socket)")
        } else if allowsLocalhost {
            // Seatbelt's localhost filter covers arbitrary loopback ports but
            // not LAN or Internet addresses. Both address families are named
            // because modern dev servers may prefer IPv6 when it is available.
            lines.append("(allow network-inbound (local ip4 \"localhost:*\"))")
            lines.append("(allow network-inbound (local ip6 \"localhost:*\"))")
            lines.append("(allow network-outbound (remote ip4 \"localhost:*\"))")
            lines.append("(allow network-outbound (remote ip6 \"localhost:*\"))")
            lines.append("(allow system-socket)")
        } else {
            // Stated rather than implied by `deny default`, so a reader of the
            // profile can see the decision was made.
            lines.append("; network denied: no (allow network-*) rule is present")
        }

        return lines.joined(separator: "\n") + "\n"
    }

    /// The rules refusing writes to `protectedToolchainPaths`, as named and as
    /// resolved.
    ///
    /// One of those folders can hold a cache from `toolchainCachePaths`:
    /// pnpm keeps its store inside the folder its global binaries live in.
    /// Only that reviewed list is carved out of a denial. A path that reaches
    /// the allow list any other way, a settings file's writable folder
    /// included, stays refused inside a protected folder.
    ///
    /// The folders above each one, up to the home folder, are denied as
    /// entries too, as `.juno` is. Otherwise a grant of `~/.bun` could still
    /// move the folder aside and put a link or a new folder in its place,
    /// and the reader's PATH would follow it.
    private func toolchainDenials() -> [String] {
        let caches = Self.toolchainCachePaths(homeDirectory: homeDirectory)
        let cachePaths = Set(caches + caches.map(Self.resolved))
        let homes: Set<String> = [homeDirectory, Self.resolved(homeDirectory)]
        var lines: [String] = []
        var denials = Set<String>()
        var entries = Set<String>()
        for path in Self.protectedToolchainPaths(homeDirectory: homeDirectory) {
            // `~/.swiftpm/configuration` is a link to the other one, so the
            // same folder can come up twice.
            for denied in Set([path, Self.resolved(path)]).sorted() where denials.insert(denied).inserted {
                let kept = cachePaths.filter { $0.hasPrefix(denied + "/") }.sorted()
                if kept.isEmpty {
                    lines.append("(deny file-write* (subpath \(Self.quote(denied))))")
                } else {
                    let exceptions = kept.map { "(require-not (subpath \(Self.quote($0))))" }
                    lines.append(
                        "(deny file-write* (require-all (subpath \(Self.quote(denied))) "
                            + exceptions.joined(separator: " ") + "))"
                    )
                }
                var parent = (denied as NSString).deletingLastPathComponent
                while !parent.isEmpty, parent != "/", !homes.contains(parent) {
                    entries.insert(parent)
                    parent = (parent as NSString).deletingLastPathComponent
                }
            }
        }
        for entry in entries.sorted() {
            lines.append("(deny file-write* (literal \(Self.quote(entry))))")
        }
        return lines
    }

    /// The path the kernel will actually see, symlinks resolved.
    ///
    /// This is load-bearing, and getting it wrong fails *closed* in a way that
    /// looks like a bug rather than a security hole: Foundation's
    /// `standardizedFileURL` rewrites `/private/tmp/x` to `/tmp/x`, but `/tmp`
    /// is a symlink and the sandbox authorises resolved paths — so a profile
    /// naming `/tmp/x` grants nothing at all, and every write inside the
    /// granted workspace was refused.
    ///
    /// The same resolution is what stops the opposite error: a workspace
    /// reached through a symlink must be authorised as its real location, not
    /// as the link, or the grant covers a path the user did not choose.
    /// `realpath(3)`, not Foundation.
    ///
    /// Both `standardizedFileURL` and `resolvingSymlinksInPath()` special-case
    /// a leading `/private` and strip it — so both turn `/private/tmp/x` back
    /// into `/tmp/x`, which is precisely the wrong direction. `realpath` is the
    /// one that answers the question the kernel is asking.
    ///
    /// A path that does not exist yet cannot be resolved directly, so the
    /// deepest existing ancestor is resolved and the remainder re-appended —
    /// that ancestor is where any symlink would be.
    static func resolved(_ path: String) -> String {
        var remainder: [String] = []
        var candidate = (path as NSString).standardizingPath

        while !candidate.isEmpty, candidate != "/" {
            if let real = realpath(candidate, nil) {
                defer { free(real) }
                let base = String(cString: real)
                return remainder.isEmpty
                    ? base
                    : ([base] + remainder.reversed()).joined(separator: "/")
            }
            remainder.append((candidate as NSString).lastPathComponent)
            candidate = (candidate as NSString).deletingLastPathComponent
        }
        return path
    }

    /// SBPL string literal quoting.
    ///
    /// A workspace path is user-supplied — it is whatever folder they granted —
    /// and an unescaped quote or backslash in it would end the literal early
    /// and turn the rest of the path into profile source. That is profile
    /// injection: a folder named `foo") (allow network-outbound) (" ` would
    /// otherwise switch the network back on.
    static func quote(_ value: String) -> String {
        var out = "\""
        for character in value {
            switch character {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            default: out.append(character)
            }
        }
        return out + "\""
    }

    /// Wraps a command so the kernel applies the profile to it.
    ///
    /// The profile is passed with `-p` rather than written to a file: a
    /// temporary profile file is another path to manage, another thing to leak
    /// on a crash, and another thing an agent-authored command could try to
    /// rewrite between our writing it and the kernel reading it.
    public func wrap(command: String) -> (executable: String, arguments: [String]) {
        (
            executable: "/usr/bin/sandbox-exec",
            arguments: ["-p", profileText(), "/bin/zsh", "-c", command]
        )
    }

    /// Whether containment can be applied on this machine.
    public static var isAvailable: Bool {
        FileManager.default.isExecutableFile(atPath: "/usr/bin/sandbox-exec")
    }
}
