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
        let service = contained
            ? CommandExecutionService(
                workspaceRootURL: workspaceURL,
                sandbox: CommandSandboxProfile(
                    workspaceRoot: workspaceURL,
                    filesystem: .readWrite,
                    allowsNetwork: allowsNetwork
                )
            )
            : CommandExecutionService(workspaceRootURL: workspaceURL)

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
