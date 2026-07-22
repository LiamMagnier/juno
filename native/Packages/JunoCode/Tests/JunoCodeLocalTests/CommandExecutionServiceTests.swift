import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class CommandExecutionServiceTests: XCTestCase {
    private var workspaceURL: URL!
    private var service: CommandExecutionService!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-cmd-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
        service = CommandExecutionService(workspaceRootURL: workspaceURL)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    func testCapturesStdoutStderrAndExitCode() async throws {
        let outcome = try await service.run(
            "echo out; echo err 1>&2; exit 3",
            timeoutSeconds: 10
        )
        XCTAssertEqual(outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "out")
        XCTAssertEqual(outcome.stderr.trimmingCharacters(in: .whitespacesAndNewlines), "err")
        XCTAssertEqual(outcome.result.exitCode, 3)
        XCTAssertFalse(outcome.result.succeeded)
    }

    func testRunsInWorkspaceDirectory() async throws {
        let outcome = try await service.run("pwd", timeoutSeconds: 10)
        let reported = outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(
            URL(fileURLWithPath: reported).resolvingSymlinksInPath().path,
            workspaceURL.resolvingSymlinksInPath().path
        )
    }

    func testEnvironmentIsScrubbed() async throws {
        // The parent test process carries at least PATH/HOME plus whatever CI
        // sets; the child must only see the fixed allowlist.
        setenv("JUNO_TEST_SECRET_TOKEN", "super-secret", 1)
        defer { unsetenv("JUNO_TEST_SECRET_TOKEN") }
        let outcome = try await service.run("env", timeoutSeconds: 10)
        XCTAssertFalse(outcome.stdout.contains("JUNO_TEST_SECRET_TOKEN"))
        XCTAssertFalse(outcome.stdout.contains("super-secret"))
        XCTAssertTrue(
            outcome.stdout.contains("PATH="),
            "stdout: \(outcome.stdout) stderr: \(outcome.stderr) result: \(outcome.result)"
        )
        XCTAssertTrue(outcome.stdout.contains("TERM=dumb"), "stdout was: \(outcome.stdout)")
    }

    func testForbiddenCommandIsRefused() async {
        do {
            _ = try await service.run("sudo id", timeoutSeconds: 10)
            XCTFail("expected refusal")
        } catch let error as CommandExecutionError {
            guard case .forbidden = error else {
                return XCTFail("unexpected error \(error)")
            }
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testTimeoutKillsProcess() async throws {
        let started = Date()
        let outcome = try await service.run("sleep 30", timeoutSeconds: 1)
        XCTAssertTrue(outcome.result.wasTimeout)
        XCTAssertNotEqual(outcome.result.exitCode, 0)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
    }

    func testOutputLimitTruncatesAndStops() async throws {
        let outcome = try await service.run(
            "yes truncated-line-content",
            timeoutSeconds: 15,
            outputLimit: OutputLimit(maximumBytes: 10_000)
        )
        XCTAssertTrue(outcome.result.wasTruncated)
        XCTAssertLessThanOrEqual(outcome.stdout.utf8.count, 10_100)
    }

    func testCancellationKillsChildProcessGroup() async throws {
        let marker = "986423"
        let service = self.service!
        let task = Task {
            try await service.run(
                "sleep \(marker) & sleep \(marker)",
                timeoutSeconds: 60
            )
        }
        // Give the shell time to spawn.
        try await Task.sleep(nanoseconds: 700_000_000)
        task.cancel()
        _ = try? await task.value
        try await Task.sleep(nanoseconds: 1_500_000_000)
        let check = try await service.run(
            "pgrep -f 'sleep \(marker)' | wc -l",
            timeoutSeconds: 10
        )
        XCTAssertEqual(
            check.stdout.trimmingCharacters(in: .whitespacesAndNewlines),
            "0",
            "children of a cancelled command must be terminated"
        )
    }

    func testSecretsAreRedactedFromOutput() async throws {
        let outcome = try await service.run(
            "echo ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
            timeoutSeconds: 10
        )
        XCTAssertFalse(outcome.stdout.contains("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"))
        XCTAssertTrue(outcome.stdout.contains(SecretRedactor.placeholder))
    }

    func testQuotedDataIsNotExecuted() async throws {
        let outcome = try await service.run("echo 'sudo id'", timeoutSeconds: 10)
        XCTAssertEqual(
            outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines),
            "sudo id"
        )
        XCTAssertEqual(outcome.result.exitCode, 0)
    }
}
