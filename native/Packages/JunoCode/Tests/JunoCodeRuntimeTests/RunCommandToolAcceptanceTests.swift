import Foundation
import XCTest
import JunoCore
@testable import JunoCodeCore
@testable import JunoCodeRuntime

private final class MockCommandExecutor: CommandExecuting, @unchecked Sendable {
    func stream(_ commandLine: String, timeoutSeconds: Double, outputLimit: OutputLimit) -> AsyncThrowingStream<CommandEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(
                .completed(
                    CommandResult(
                        exitCode: 0,
                        wasTimeout: false,
                        wasCancelled: false,
                        wasTruncated: false,
                        durationSeconds: 0.1
                    )
                )
            )
            continuation.finish()
        }
    }
}

final class RunCommandToolAcceptanceTests: XCTestCase {
    private var tool: RunCommandTool!

    override func setUp() {
        super.setUp()
        tool = RunCommandTool(executor: MockCommandExecutor(), changes: nil)
    }

    func testRunCommandRejectsBackgroundExecutionWithAmpersand() {
        let backgroundCommands = [
            "npx -y serve -l 3000 . &",
            "python3 -m http.server 3000 &",
            "npm run dev &",
            "vite &",
            "next dev &",
            "sleep 10 &",
        ]

        for cmd in backgroundCommands {
            let input: JSONValue = ["command": .string(cmd)]
            let error = tool.precheck(input: input)
            guard case let .denied(reason) = error else {
                XCTFail("Expected .denied for command: \(cmd), got: \(String(describing: error))")
                continue
            }
            XCTAssertTrue(
                reason.contains("open_preview"),
                "Expected reason to direct to open_preview for command: \(cmd), got: \(reason)"
            )
        }
    }

    func testRunCommandRejectsUnmanagedPreviewServers() {
        let devServerCommands = [
            "python3 -m http.server",
            "python -m http.server 8080",
            "npx serve",
            "npx -y serve -l 3000 .",
            "http-server",
            "live-server",
            "npm run dev",
            "pnpm run dev",
            "yarn dev",
            "vite",
            "next dev",
        ]

        for cmd in devServerCommands {
            let input: JSONValue = ["command": .string(cmd)]
            let error = tool.precheck(input: input)
            guard case let .denied(reason) = error else {
                XCTFail("Expected .denied for dev server command: \(cmd), got: \(String(describing: error))")
                continue
            }
            XCTAssertTrue(
                reason.contains("open_preview"),
                "Expected reason to direct to open_preview for command: \(cmd), got: \(reason)"
            )
        }
    }

    func testRunCommandPermitsStandardFiniteCommands() {
        let normalCommands = [
            "ls -la",
            "swift test",
            "npm test",
            "git status",
            "echo hello",
            "pytest",
            "python3 script.py",
        ]

        for cmd in normalCommands {
            let input: JSONValue = ["command": .string(cmd)]
            let error = tool.precheck(input: input)
            XCTAssertNil(error, "Expected nil (permitted) for command: \(cmd), got: \(String(describing: error))")
        }
    }
}
