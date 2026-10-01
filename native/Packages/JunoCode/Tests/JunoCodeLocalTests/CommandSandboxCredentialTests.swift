import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The credential read deny-list (S3, D-019): commands the agent runs cannot
/// read the keys to the reader's other machines and accounts, while a
/// toolchain keeps reading what it needs. Run for real under `sandbox-exec`,
/// against a home folder made for the test.
final class CommandSandboxCredentialTests: XCTestCase {
    private var base: URL!
    private var workspace: URL!
    private var home: URL!

    private let secrets = [
        ".ssh/id_ed25519",
        ".aws/credentials",
        ".config/gh/hosts.yml",
        ".config/gcloud/application_default_credentials.json",
        ".kube/config",
        ".netrc",
        ".git-credentials",
        ".docker/config.json",
        "Library/Keychains/login.keychain-db",
        "Library/Application Support/Google/Chrome/Default/Cookies",
        "Library/Application Support/Firefox/Profiles/x/logins.json",
        "Library/Cookies/Cookies.binarycookies",
    ]

    override func setUpWithError() throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable on this machine")
        base = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("juno-creds-\(UUID().uuidString)")
        workspace = base.appendingPathComponent("workspace")
        home = base.appendingPathComponent("home")
        let manager = FileManager.default
        try manager.createDirectory(at: workspace, withIntermediateDirectories: true)
        for path in secrets {
            let url = home.appendingPathComponent(path)
            try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try "SECRET-\(path)".write(to: url, atomically: true, encoding: .utf8)
        }
        try "registry=https://registry.npmjs.org/".write(to: home.appendingPathComponent(".npmrc"), atomically: true, encoding: .utf8)
        try "let x = 1".write(to: workspace.appendingPathComponent("main.swift"), atomically: true, encoding: .utf8)
    }

    override func tearDown() {
        if let base { try? FileManager.default.removeItem(at: base) }
    }

    private func profile(protectsPolicyFiles: Bool = true, workspaceRoot: URL? = nil) -> CommandSandboxProfile {
        CommandSandboxProfile(
            workspaceRoot: workspaceRoot ?? workspace,
            protectsPolicyFiles: protectsPolicyFiles,
            homeDirectory: home.path
        )
    }

    private func run(_ command: String, _ profile: CommandSandboxProfile) async throws -> (output: String, exitCode: Int32) {
        let service = CommandExecutionService(workspaceRootURL: profile.workspaceRoot, sandbox: profile)
        var output = ""
        var exitCode: Int32 = -1
        for try await event in service.stream(command, timeoutSeconds: 30, outputLimit: .commandOutput) {
            switch event {
            case let .stdout(text), let .stderr(text): output += text
            case let .completed(result): exitCode = result.exitCode
            }
        }
        return (output, exitCode)
    }

    func testAgentCommandsCannotReadCredentials() async throws {
        let profile = profile()
        for path in secrets {
            let result = try await run("cat '\(home.path)/\(path)'", profile)
            XCTAssertNotEqual(result.exitCode, 0, "\(path) was readable: \(result.output)")
            XCTAssertFalse(result.output.contains("SECRET-"), "\(path) leaked")
        }
        // Nor by listing the folder, or copying it somewhere readable.
        let listing = try await run("ls '\(home.path)/.ssh'", profile)
        XCTAssertNotEqual(listing.exitCode, 0)
        XCTAssertFalse(listing.output.contains("id_ed25519"))
        let copy = try await run("cp '\(home.path)/.aws/credentials' leaked.txt", profile)
        XCTAssertNotEqual(copy.exitCode, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspace.appendingPathComponent("leaked.txt").path))
    }

    func testALinkIntoACredentialFolderIsNoWayRound() async throws {
        try FileManager.default.createSymbolicLink(
            at: workspace.appendingPathComponent("keys"),
            withDestinationURL: home.appendingPathComponent(".ssh")
        )
        let result = try await run("cat keys/id_ed25519", profile())
        XCTAssertNotEqual(result.exitCode, 0)
        XCTAssertFalse(result.output.contains("SECRET-"))
    }

    func testToolchainsKeepWorking() async throws {
        let profile = profile()
        // A package manager's registry settings, the workspace, the system.
        for command in [
            "cat '\(home.path)/.npmrc'",
            "cat main.swift",
            "ls /usr/bin > /dev/null",
            "/usr/bin/git --version",
            // Existence stays visible, so a tool that looks before it reads
            // does not fail on the home folder's entries.
            "test -e '\(home.path)/.ssh/id_ed25519'",
        ] {
            let result = try await run(command, profile)
            XCTAssertEqual(result.exitCode, 0, "\(command) failed: \(result.output)")
        }
    }

    func testTheReadersOwnTerminalKeepsItsCredentials() async throws {
        let terminal = profile(protectsPolicyFiles: false)
        XCTAssertFalse(terminal.protectsCredentials, "git push over SSH and gh are the reader's to use")
        let result = try await run("cat '\(home.path)/.ssh/id_ed25519'", terminal)
        XCTAssertEqual(result.exitCode, 0, result.output)
        XCTAssertTrue(result.output.contains("SECRET-"))
    }

    func testAWorkspaceInsideACredentialFolderStaysReadable() async throws {
        let inside = home.appendingPathComponent(".config/gh/project")
        try FileManager.default.createDirectory(at: inside, withIntermediateDirectories: true)
        try "ok".write(to: inside.appendingPathComponent("file.txt"), atomically: true, encoding: .utf8)
        let profile = profile(workspaceRoot: inside)
        let mine = try await run("cat file.txt", profile)
        XCTAssertEqual(mine.exitCode, 0, mine.output)
        let next = try await run("cat '\(home.path)/.config/gh/hosts.yml'", profile)
        XCTAssertNotEqual(next.exitCode, 0, "the rest of the folder stays closed")
    }

    func testTheProfileNamesEveryCredentialPathAndOnlyDeniesReadingData() {
        let text = profile().profileText()
        for path in [".ssh", ".aws", ".config/gh", ".netrc", "Library/Keychains"] {
            XCTAssertTrue(text.contains("(deny file-read-data (subpath \"\(CommandSandboxProfile.resolved(home.path + "/" + path))\"))"), path)
        }
        XCTAssertTrue(text.contains("(deny file-read-data (subpath \"/Library/Keychains\"))"))
        XCTAssertFalse(text.contains("deny file-read-metadata"))
        // The denials come after the broad read allowance, so they win.
        let allow = text.range(of: "(allow file-read*)")!.lowerBound
        let deny = text.range(of: "(deny file-read-data")!.lowerBound
        XCTAssertLessThan(allow, deny)
    }
}
