import Foundation

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
    /// Off by default. A build that needs to fetch dependencies is a decision
    /// the user makes per session, not something a command grants itself.
    public let allowsNetwork: Bool
    /// Extra roots a command legitimately needs: caches, toolchains, temp.
    public let additionalWritablePaths: [String]

    public init(
        workspaceRoot: URL,
        filesystem: FilesystemAccess = .readWrite,
        allowsNetwork: Bool = false,
        additionalWritablePaths: [String] = CommandSandboxProfile.defaultWritablePaths
    ) {
        self.workspaceRoot = workspaceRoot
        self.filesystem = filesystem
        self.allowsNetwork = allowsNetwork
        self.additionalWritablePaths = additionalWritablePaths
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
            // ioctl on a tty is what makes interactive-ish tools work at all.
            lines.append("(allow file-ioctl (subpath \"/dev\"))")
        }

        if allowsNetwork {
            lines.append("(allow network-outbound)")
            lines.append("(allow network-inbound)")
            lines.append("(allow system-socket)")
        } else {
            // Stated rather than implied by `deny default`, so a reader of the
            // profile can see the decision was made.
            lines.append("; network denied: no (allow network-*) rule is present")
        }

        return lines.joined(separator: "\n") + "\n"
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
