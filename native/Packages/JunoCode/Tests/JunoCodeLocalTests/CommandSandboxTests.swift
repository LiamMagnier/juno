import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// Kernel-enforced containment for locally executed commands.
///
/// The classifier and the scrubbed environment are both worth having and
/// neither is a boundary: a classifier reads the *text* of a command, and any
/// command it recognises can be spelled another way — through a variable, a
/// generated script, a here-doc, a `python -c`. These exercise the thing that
/// holds regardless of spelling, by actually running commands and checking the
/// kernel refused them.
final class CommandSandboxTests: XCTestCase {
    private var workspaceURL: URL!
    private var outsideURL: URL!

    override func setUpWithError() throws {
        try XCTSkipUnless(
            CommandSandboxProfile.isAvailable,
            "sandbox-exec is unavailable on this machine"
        )
        let base = URL(fileURLWithPath: "/private/tmp")
            .appendingPathComponent("juno-sandbox-\(UUID().uuidString)")
        workspaceURL = base.appendingPathComponent("workspace")
        outsideURL = base.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outsideURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let workspaceURL {
            try? FileManager.default.removeItem(at: workspaceURL.deletingLastPathComponent())
        }
    }

    private func run(
        _ command: String,
        contained: Bool = true,
        allowsNetwork: Bool = false
    ) async throws -> (output: String, exitCode: Int32) {
        try await run(
            command,
            sandbox: contained
                ? CommandSandboxProfile(
                    workspaceRoot: workspaceURL,
                    filesystem: .readWrite,
                    allowsNetwork: allowsNetwork
                )
                : nil
        )
    }

    private func run(
        _ command: String,
        sandbox: CommandSandboxProfile?
    ) async throws -> (output: String, exitCode: Int32) {
        let service = CommandExecutionService(workspaceRootURL: workspaceURL, sandbox: sandbox)

        var output = ""
        var exitCode: Int32 = -1
        for try await event in service.stream(
            command,
            timeoutSeconds: 30,
            outputLimit: .commandOutput
        ) {
            switch event {
            case let .stdout(text): output += text
            case let .stderr(text): output += text
            case let .completed(result):
                exitCode = Int32(result.exitCode)
            }
        }
        return (output, exitCode)
    }

    // MARK: - Filesystem

    func testACommandMayWriteInsideTheGrantedWorkspace() async throws {
        // Containment that broke ordinary builds would simply be switched off,
        // leaving less protection than a slightly wider profile.
        let result = try await run("echo hello > note.txt && cat note.txt")
        XCTAssertEqual(result.exitCode, 0, result.output)
        XCTAssertTrue(result.output.contains("hello"))
    }

    func testACommandCannotWriteOutsideTheWorkspace() async throws {
        let target = outsideURL.appendingPathComponent("escaped.txt").path
        let result = try await run("echo escaped > \(target)")

        XCTAssertNotEqual(result.exitCode, 0, "the write should have been refused")
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: target),
            "a command wrote outside the granted workspace"
        )
    }

    /// The case a text classifier cannot catch: the path never appears in the
    /// command it inspects, because a second shell composes it at runtime.
    func testShellIndirectionDoesNotEscapeTheWorkspace() async throws {
        let target = outsideURL.appendingPathComponent("indirect.txt").path
        let result = try await run(
            "D=\(outsideURL.path); F=indirect.txt; sh -c \"echo via-indirection > $D/$F\""
        )

        XCTAssertNotEqual(result.exitCode, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target))
    }

    /// And the case where the escape is written by the command itself.
    func testAGeneratedScriptCannotEscapeEither() async throws {
        let target = outsideURL.appendingPathComponent("generated.txt").path
        let result = try await run(
            "printf 'echo generated > %s\\n' \(target) > run.sh && chmod +x run.sh && ./run.sh"
        )

        XCTAssertNotEqual(result.exitCode, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target))
    }

    /// A symlink pointing out of the workspace must not become a way through
    /// it — the kernel authorises the resolved path, not the link.
    func testASymlinkOutOfTheWorkspaceIsNotAWayThrough() async throws {
        let target = outsideURL.appendingPathComponent("via-symlink.txt")
        try FileManager.default.createSymbolicLink(
            at: workspaceURL.appendingPathComponent("escape"),
            withDestinationURL: outsideURL
        )

        let result = try await run("echo through-the-link > escape/via-symlink.txt")

        XCTAssertNotEqual(result.exitCode, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

    /// Reading the user's credentials is exactly what an exfiltration attempt
    /// starts with. Reads are broadly allowed so toolchains work, so this is
    /// documented as a known limit of the profile rather than left implied:
    /// what the profile stops is the *write* and the *send*, not the read.
    func testWritesAreConfinedEvenThoughReadsAreBroad() async throws {
        let target = outsideURL.appendingPathComponent("stolen.txt").path
        let result = try await run("cat /etc/hosts > \(target)")

        XCTAssertNotEqual(result.exitCode, 0, "the exfiltrating write must fail")
        XCTAssertFalse(FileManager.default.fileExists(atPath: target))
    }

    // MARK: - Network

    func testNetworkIsDeniedByDefault() async throws {
        // A dependency fetch is a decision the user makes for a session, not
        // something a command grants itself mid-run.
        let result = try await run(
            "curl --max-time 5 -sS http://example.com > out.txt; echo exit=$?"
        )
        XCTAssertFalse(
            result.output.contains("exit=0"),
            "an outbound request succeeded under a profile that denies network"
        )
    }

    func testNetworkCanBeGrantedExplicitly() async throws {
        let profile = CommandSandboxProfile(
            workspaceRoot: workspaceURL,
            filesystem: .readWrite,
            allowsNetwork: true
        )
        XCTAssertTrue(profile.profileText().contains("(allow network-outbound)"))
    }

    func testLocalhostCanBeAllowedWithoutGrantingTheInternet() {
        let profile = CommandSandboxProfile(
            workspaceRoot: workspaceURL,
            allowsLocalhost: true
        )
        let text = profile.profileText()
        XCTAssertTrue(text.contains("(allow network-inbound (local ip4 \"localhost:*\"))"))
        XCTAssertTrue(text.contains("(allow network-outbound (remote ip6 \"localhost:*\"))"))
        XCTAssertFalse(text.contains("(allow network-outbound)\n"))
    }

    // MARK: - Profile text

    func testTheDefaultProfileDeniesEverythingItDoesNotName() throws {
        let profile = CommandSandboxProfile(workspaceRoot: workspaceURL)
        let text = profile.profileText()

        XCTAssertTrue(text.contains("(deny default)"))
        XCTAssertFalse(text.contains("(allow network-outbound)"))
        XCTAssertTrue(
            text.contains(
                "(allow file-write* (subpath \(CommandSandboxProfile.quote(CommandSandboxProfile.resolved(workspaceURL.path))))"
            )
        )
    }

    /// The bug this pins cost every write inside the workspace.
    ///
    /// The sandbox authorises resolved paths, but Foundation's
    /// `standardizedFileURL` rewrites `/private/tmp/x` to `/tmp/x` — and `/tmp`
    /// is a symlink. A profile naming the unresolved path grants nothing, so
    /// containment looked like it worked and actually denied everything.
    func testTheProfileNamesTheResolvedPathTheKernelWillSee() throws {
        let viaSymlink = URL(fileURLWithPath: "/tmp/juno-resolve-check")
        let text = CommandSandboxProfile(workspaceRoot: viaSymlink).profileText()

        XCTAssertTrue(
            text.contains("/private/tmp/juno-resolve-check"),
            "the profile must name the resolved path"
        )
        XCTAssertFalse(
            text.contains("(subpath \"/tmp/juno-resolve-check\")"),
            "an unresolved path grants nothing, because /tmp is a symlink"
        )
    }

    /// A shell redirect must not reach what the file tools ask about every
    /// time: the project's policy files, or Juno's folder as a whole.
    func testACommandCannotWriteThePolicyFiles() async throws {
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent(".juno"),
            withIntermediateDirectories: true
        )
        let writes = [
            #"echo '{"permissions":{"allow":["Bash"]}}' > .juno/settings.local.json"#,
            #"echo '{}' > .juno/settings.json"#,
            #"echo '{}' > .mcp.json"#,
            "mv .juno .juno-old",
            "rm -rf .juno",
        ]
        for command in writes {
            let result = try await run(command)
            XCTAssertNotEqual(result.exitCode, 0, "\(command) was allowed: \(result.output)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspaceURL.appendingPathComponent(".juno/settings.local.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspaceURL.appendingPathComponent(".mcp.json").path))

        // The rest of the folder stays usable: worktrees live there.
        let worktree = try await run("mkdir -p .juno/worktrees/task && echo ok > .juno/worktrees/task/file && cat .juno/worktrees/task/file")
        XCTAssertEqual(worktree.exitCode, 0, worktree.output)
    }

    /// The reader's own terminal may update them: a `git pull` that changes a
    /// tracked `.juno/settings.json` is theirs to run.
    func testTheReadersTerminalProfileLeavesThePolicyFilesWritable() {
        let agent = CommandSandboxProfile(workspaceRoot: workspaceURL).profileText()
        let reader = CommandSandboxProfile(workspaceRoot: workspaceURL, protectsPolicyFiles: false).profileText()
        XCTAssertTrue(agent.contains("settings.local.json"))
        XCTAssertFalse(reader.contains("settings.local.json"))
        XCTAssertFalse(reader.contains(".juno"))
    }

    // MARK: - Toolchain folders

    /// The reported hole: `~/.bun`, `~/.yarn` and `~/Library/pnpm` were
    /// writable whole, and they hold binaries on the reader's PATH that the
    /// reader runs from their own shell, outside any sandbox.
    func testNoCacheEntryContainsAFolderOnThePath() {
        let home = "/Users/reader"
        let caches = CommandSandboxProfile.toolchainCachePaths(homeDirectory: home)
        for removed in [
            "/.bun", "/.yarn", "/Library/pnpm", "/.deno", "/.cache", "/Library/Caches",
            "/.swiftpm", "/Library/org.swift.swiftpm", "/Library/Developer/Xcode/DerivedData",
            "/.npm", "/go/pkg", "/.cargo/registry", "/.cargo/git",
        ] {
            XCTAssertFalse(caches.contains(home + removed), "\(removed) is writable again")
        }
        let protected = CommandSandboxProfile.protectedToolchainPaths(homeDirectory: home)
        for path in ToolchainEnvironment.candidateToolchainDirectories(homeDirectory: home) + [home + "/.deno/bin"] {
            XCTAssertTrue(protected.contains(path), path)
            for cache in caches {
                XCTAssertFalse(path == cache || path.hasPrefix(cache + "/"), "\(cache) grants \(path)")
            }
        }
        XCTAssertTrue(caches.contains(home + "/.bun/install/cache"))
        XCTAssertTrue(caches.contains(home + "/Library/pnpm/store"))
        XCTAssertTrue(caches.contains(home + "/.yarn/berry/cache"))
    }

    /// Later rules win in SBPL, so the denials must come after every grant.
    func testToolchainFoldersAreDeniedAfterEveryGrant() throws {
        let home = workspaceURL.deletingLastPathComponent().appendingPathComponent("home").path
        let profile = CommandSandboxProfile(
            workspaceRoot: workspaceURL,
            additionalWritablePaths: CommandSandboxProfile.defaultWritablePaths
                + CommandSandboxProfile.toolchainCachePaths(homeDirectory: home)
                + [home],
            homeDirectory: home
        )
        let lines = profile.profileText().split(separator: "\n").map(String.init)
        let lastGrant = try XCTUnwrap(lines.lastIndex { $0.hasPrefix("(allow file-write*") })
        for path in [home + "/.bun/bin", home + "/.cargo/bin", home + "/.deno/bin", home + "/.local/bin", "/opt/homebrew/bin"] {
            let denial = try XCTUnwrap(
                lines.firstIndex { $0.hasPrefix("(deny file-write*") && $0.contains(CommandSandboxProfile.quote(path)) },
                "no denial for \(path)"
            )
            XCTAssertGreaterThan(denial, lastGrant, path)
        }
    }

    /// End to end, with the whole home folder granted as a later change to the
    /// allow list might: the binaries and settings stay unwritable, and so
    /// does moving their folders aside, while the caches inside those tools'
    /// folders stay usable.
    func testBinaryFoldersStayUnwritableWhateverIsGranted() async throws {
        let home = workspaceURL.deletingLastPathComponent().appendingPathComponent("home")
        let manager = FileManager.default
        for folder in [".bun/bin", ".bun/install/cache", "Library/pnpm/store", ".cargo/bin", ".deno"] {
            try manager.createDirectory(at: home.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        let bun = home.appendingPathComponent(".bun/bin/bun")
        try "original".write(to: bun, atomically: true, encoding: .utf8)
        try "original".write(to: home.appendingPathComponent(".cargo/env"), atomically: true, encoding: .utf8)
        let profile = CommandSandboxProfile(
            workspaceRoot: workspaceURL,
            additionalWritablePaths: CommandSandboxProfile.defaultWritablePaths + [home.path],
            homeDirectory: home.path
        )
        let h = home.path
        for command in [
            "echo evil > \(h)/.bun/bin/bun",
            "echo evil > \(h)/Library/pnpm/pnpm",
            "echo evil >> \(h)/.cargo/env",
            "echo evil > \(h)/.cargo/bin/cargo",
            "mkdir -p \(h)/.deno/bin && echo evil > \(h)/.deno/bin/tool",
            "echo evil > \(h)/.npmrc",
            // Relative, because the classifier refuses an absolute `rm` itself.
            "cd \(h)/.bun && rm -rf bin",
            "mv \(h)/.bun \(h)/.bun-aside",
        ] {
            let result = try await run(command, sandbox: profile)
            XCTAssertNotEqual(result.exitCode, 0, "\(command) was allowed: \(result.output)")
        }
        XCTAssertEqual(try String(contentsOf: bun, encoding: .utf8), "original")
        XCTAssertEqual(try String(contentsOf: home.appendingPathComponent(".cargo/env"), encoding: .utf8), "original")
        XCTAssertFalse(manager.fileExists(atPath: h + "/.npmrc"))

        for command in [
            "echo ok > \(h)/.bun/install/cache/package",
            "mkdir -p \(h)/Library/pnpm/store/v3 && echo ok > \(h)/Library/pnpm/store/v3/file",
        ] {
            let result = try await run(command, sandbox: profile)
            XCTAssertEqual(result.exitCode, 0, "\(command) was refused: \(result.output)")
        }
    }

    /// Crate sources, npx's packages and the like go to a cache Juno owns,
    /// never the reader's `~/.cargo` or `~/.npm`, which stay unwritable.
    func testToolsWriteTheirCachesWhereJunoOwnsThem() async throws {
        let home = workspaceURL.deletingLastPathComponent().appendingPathComponent("home")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let profile = CommandSandboxProfile(
            workspaceRoot: workspaceURL,
            additionalWritablePaths: CommandSandboxProfile.defaultWritablePaths
                + CommandSandboxProfile.toolchainCachePaths(homeDirectory: home.path),
            homeDirectory: home.path
        )
        XCTAssertTrue(profile.grantsCommandCache)
        let root = CommandSandboxProfile.commandCacheRoot(homeDirectory: home.path)

        let result = try await run(
            #"mkdir -p "$CARGO_HOME/registry/src" && echo ok > "$CARGO_HOME/registry/src/crate" && echo "$CARGO_HOME|$npm_config_cache|$XDG_CACHE_HOME""#,
            sandbox: profile
        )
        XCTAssertEqual(result.exitCode, 0, result.output)
        XCTAssertTrue(result.output.contains("\(root)/cargo|\(root)/npm|\(root)/xdg"), result.output)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root + "/cargo/registry/src/crate"))

        for command in [
            "mkdir -p \(home.path)/.cargo/registry/src && echo evil > \(home.path)/.cargo/registry/src/crate",
            "mkdir -p \(home.path)/.npm/_npx && echo evil > \(home.path)/.npm/_npx/package",
            "mkdir -p \(home.path)/Library/Caches/ms-playwright",
        ] {
            let refused = try await run(command, sandbox: profile)
            XCTAssertNotEqual(refused.exitCode, 0, "\(command) was allowed: \(refused.output)")
        }

        // A profile that does not grant the cache does not point tools at it.
        let plain = try await run(#"echo "cargo=$CARGO_HOME""#)
        XCTAssertTrue(plain.output.contains("cargo=\n") || plain.output.hasSuffix("cargo="), plain.output)
    }

    func testAReadOnlyProfileGrantsNoWriteAtAll() throws {
        let profile = CommandSandboxProfile(workspaceRoot: workspaceURL, filesystem: .readOnly)
        XCTAssertFalse(profile.profileText().contains("file-write*"))
    }

    /// A workspace path is whatever folder the user granted, so it is untrusted
    /// text inside a profile. Unescaped, a crafted folder name would close the
    /// string literal early and append rules of its own — switching the network
    /// back on from a directory name.
    func testAPathCannotInjectRulesIntoTheProfile() throws {
        let hostile = URL(
            fileURLWithPath: "/private/tmp/evil\") (allow network-outbound) (\""
        )
        let text = CommandSandboxProfile(workspaceRoot: hostile).profileText()

        // The injected text is still *present* — it is part of a path — but it
        // must be inside a quoted literal, never standing as a rule of its own.
        // SBPL is line-oriented, so a rule the profile actually applies is one
        // that begins a line.
        let rules = text.split(separator: "\n").map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        XCTAssertFalse(
            rules.contains("(allow network-outbound)"),
            "a directory name injected a rule into the sandbox profile"
        )
        XCTAssertTrue(text.contains("\\\""), "the quote should have been escaped")

        // And the escaping must survive the parser: sandbox-exec rejects a
        // malformed profile outright, which would turn injection into an
        // availability bug instead of a containment one.
        XCTAssertTrue(
            CommandSandboxProfile.quote("a\"b\\c").hasPrefix("\""),
            "quoting must produce a well-formed literal"
        )
    }

    // MARK: - Developer mode

    /// The escape hatch has to exist and has to be visibly different, or a user
    /// whose build genuinely needs the network turns off something they cannot
    /// see the shape of.
    func testDeveloperModeIsUnconfinedAndSaysSo() async throws {
        let contained = CommandExecutionService.contained(workspaceRootURL: workspaceURL)
        XCTAssertTrue(contained.isContained)

        let developer = CommandExecutionService(workspaceRootURL: workspaceURL)
        XCTAssertFalse(developer.isContained)

        let target = outsideURL.appendingPathComponent("developer-mode.txt").path
        let result = try await run("echo unconfined > \(target)", contained: false)
        XCTAssertEqual(result.exitCode, 0, result.output)
        XCTAssertTrue(FileManager.default.fileExists(atPath: target))
    }
}
