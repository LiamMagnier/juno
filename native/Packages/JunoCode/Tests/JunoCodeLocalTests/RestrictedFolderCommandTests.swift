import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// Real kernel-boundary tests use only disposable sibling folders and local
/// sockets. Passing these does not prove absolute sandbox security.
final class RestrictedFolderCommandTests: XCTestCase {
    private var fixture: URL!
    private var workspace: URL!
    private var outside: URL!

    override func setUpWithError() throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "Mandatory containment cannot be exercised on this host")
        fixture = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("alevr-restricted-\(UUID().uuidString)", isDirectory: true)
        workspace = fixture.appendingPathComponent("authorized", isDirectory: true)
        outside = fixture.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try "private fixture contents".write(to: outside.appendingPathComponent("secret.txt"), atomically: true, encoding: .utf8)
    }

    override func tearDownWithError() throws {
        if let fixture { try FileManager.default.removeItem(at: fixture) }
    }

    private func run(_ command: String) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        try await CommandExecutionService.restrictedFolder(workspaceRootURL: workspace).run(command, timeoutSeconds: 3)
    }

    func testAuthorizedReadWriteWorksWithoutGlobalTempGrants() async throws {
        let output = try await run("printf hello > result.txt && cat result.txt")
        XCTAssertTrue(output.result.succeeded, output.stderr)
        XCTAssertEqual(output.stdout, "hello")
        let prepared = try CommandExecutionService.restrictedFolder(workspaceRootURL: workspace).prepare("echo ok")
        let profile = prepared.arguments[1]
        XCTAssertFalse(profile.contains("(allow file-read*)"))
        XCTAssertFalse(profile.contains("(allow file-write* (subpath \"/private/var/folders\"))"))
    }

    func testSiblingReadAndWriteAreRefused() async throws {
        let read = try await run("cat ../outside/secret.txt")
        XCTAssertFalse(read.result.succeeded)
        XCTAssertFalse(read.stdout.contains("private fixture contents"))
        let write = try await run("printf unsafe > ../outside/modified.txt")
        XCTAssertFalse(write.result.succeeded)
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("modified.txt").path))
    }

    func testSymlinkEscapeCannotReadOrWrite() async throws {
        try FileManager.default.createSymbolicLink(at: workspace.appendingPathComponent("escape"), withDestinationURL: outside)
        let read = try await run("cat escape/secret.txt")
        XCTAssertFalse(read.result.succeeded)
        XCTAssertFalse(read.stdout.contains("private fixture contents"))
        let write = try await run("printf unsafe > escape/modified.txt")
        XCTAssertFalse(write.result.succeeded)
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("modified.txt").path))
    }

    func testRootReplacementDoesNotExpandAnAlreadyConfiguredGrant() async throws {
        let executor = CommandExecutionService.restrictedFolder(workspaceRootURL: workspace)
        let original = fixture.appendingPathComponent("original", isDirectory: true)
        try FileManager.default.moveItem(at: workspace, to: original)
        try FileManager.default.createSymbolicLink(at: workspace, withDestinationURL: outside)
        let output = try await executor.run("printf unsafe > modified.txt", timeoutSeconds: 3)
        XCTAssertFalse(output.result.succeeded)
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("modified.txt").path))
    }

    func testLoopbackAndInternetSocketsAreRefused() async throws {
        for address in ["127.0.0.1", "169.254.169.254"] {
            // No listener or external service is contacted when Seatbelt denies
            // socket creation. The timeout also bounds a regression.
            let output = try await run("/usr/bin/curl -v --noproxy '*' --connect-timeout 1 http://\(address):9/")
            XCTAssertFalse(output.result.succeeded)
            XCTAssertTrue(output.stderr.contains("Operation not permitted"), "must prove sandbox refusal, not a closed port: \(output.stderr)")
        }
    }

    func testCredentialFixtureInsideWorkspaceIsStillUnreadable() async throws {
        let credentials = workspace.appendingPathComponent(".ssh", isDirectory: true)
        try FileManager.default.createDirectory(at: credentials, withIntermediateDirectories: true)
        try "fixture-key-only".write(to: credentials.appendingPathComponent("id_test"), atomically: true, encoding: .utf8)
        let executor = CommandExecutionService(workspaceRootURL: workspace, sandbox: CommandSandboxProfile(
            workspaceRoot: workspace, additionalWritablePaths: ["/dev/null"],
            homeDirectory: workspace.path, restrictsReadsToWorkspace: true
        ))
        let result = try await executor.run("cat .ssh/id_test", timeoutSeconds: 3)
        XCTAssertFalse(result.result.succeeded)
        XCTAssertFalse(result.stdout.contains("fixture-key-only"))
    }

    func testCancellationStopsDelayedMutation() async throws {
        let workspace = self.workspace!
        let task = Task {
            try await CommandExecutionService.restrictedFolder(workspaceRootURL: workspace)
                .run("printf started > started.txt; sleep 1; printf unsafe > after-stop.txt", timeoutSeconds: 3)
        }
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: workspace.appendingPathComponent("started.txt").path) { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: workspace.appendingPathComponent("started.txt").path))
        task.cancel()
        do {
            let output = try await task.value
            XCTAssertTrue(output.result.wasCancelled)
        } catch is CancellationError {
            // A cancelled AsyncThrowingStream may finish the iterator before
            // its terminal event; callers receive explicit cancellation.
        }
        try await Task.sleep(for: .milliseconds(1100))
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspace.appendingPathComponent("after-stop.txt").path))
    }
}
