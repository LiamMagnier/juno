import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// Background shells: started under the command executor's rules, read
/// incrementally from their spill logs, written to, stopped, and owned by the
/// session that started them.
final class ShellSessionManagerTests: XCTestCase {
    private var root: URL!
    private var workspaceURL: URL!
    private var manager: ShellSessionManager!
    private let owner = CodeSessionID()

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-shells-\(UUID().uuidString)")
        workspaceURL = root.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("sub"),
            withIntermediateDirectories: true
        )
        manager = ShellSessionManager(
            executor: CommandExecutionService(workspaceRootURL: workspaceURL),
            logDirectory: root.appendingPathComponent("logs")
        )
    }

    override func tearDown() async throws {
        await manager.terminateAll()
        try? FileManager.default.removeItem(at: root)
    }

    private func start(_ command: String, directory: String? = nil, owner: CodeSessionID? = nil) async throws -> ShellSessionInfo {
        try await manager.start(
            command: command,
            workingDirectory: try directory.map(WorkspacePath.init),
            name: nil,
            ownerSessionID: owner ?? self.owner,
            risk: .execute
        )
    }

    /// Everything the shell prints until `predicate` holds or `seconds` pass.
    private func collect(
        _ id: String,
        seconds: Double = 5,
        until predicate: (String) -> Bool
    ) async throws -> String {
        var text = ""
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            let chunk = try await manager.output(
                id: id, ownerSessionID: owner, since: nil, tailLines: nil,
                maximumBytes: 64 * 1_024, waitSeconds: 0.5
            )
            text += chunk.text
            if predicate(text) { break }
        }
        return text
    }

    private func waitUntilEnded(_ id: String, seconds: Double = 5) async throws -> ShellSessionInfo {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let info = manager.info(id: id), !info.state.isRunning { return info }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        return try XCTUnwrap(manager.info(id: id))
    }

    func testAShellKeepsRunningAndItsOutputIsReadIncrementally() async throws {
        let shell = try await start("for i in 1 2 3; do echo line$i; sleep 0.2; done; sleep 30")
        XCTAssertTrue(shell.state.isRunning)
        XCTAssertTrue(shell.id.hasPrefix("sh-"))

        let text = try await collect(shell.id) { $0.contains("line3") }
        XCTAssertEqual(text, "line1\nline2\nline3\n", "each read returns only what is new")
        XCTAssertTrue(try XCTUnwrap(manager.info(id: shell.id)).state.isRunning)

        let stopped = try await manager.kill(id: shell.id, ownerSessionID: owner, signal: .terminate)
        XCTAssertEqual(stopped.state, .signalled(signal: SIGTERM))
    }

    func testAnExplicitOffsetPagesThroughTheLog() async throws {
        let shell = try await start("printf 'abcdefghij'")
        _ = try await waitUntilEnded(shell.id)
        let first = try await manager.output(
            id: shell.id, ownerSessionID: owner, since: 0, tailLines: nil, maximumBytes: 256, waitSeconds: 0.2
        )
        XCTAssertEqual(first.text, "abcdefghij")
        let page = try await manager.output(
            id: shell.id, ownerSessionID: owner, since: 3, tailLines: nil, maximumBytes: 256, waitSeconds: 0
        )
        XCTAssertEqual(page.text, "defghij")
        XCTAssertEqual(page.startOffset, 3)
        XCTAssertEqual(page.nextOffset, 10)
    }

    func testTheExitCodeIsKept() async throws {
        let shell = try await start("echo done; exit 3")
        let ended = try await waitUntilEnded(shell.id)
        XCTAssertEqual(ended.state, .exited(code: 3))
        let text = try await collect(shell.id, seconds: 1) { $0.contains("done") }
        XCTAssertEqual(text, "done\n")
    }

    func testInputReachesAProcessThatReadsIt() async throws {
        let shell = try await start("cat")
        let written = try await manager.write(id: shell.id, ownerSessionID: owner, text: "ping\n")
        XCTAssertEqual(written, 5)
        let echoed = try await collect(shell.id) { $0.contains("ping") }
        XCTAssertEqual(echoed, "ping\n")
    }

    func testInputIsRefusedWhenTheProcessIsNotReading() async throws {
        let shell = try await start("sleep 30")
        // More than a pipe holds: the part that fits is accepted, and then
        // nothing more can be, because nobody is reading.
        let payload = String(repeating: "x", count: 200_000)
        let first = try await manager.write(id: shell.id, ownerSessionID: owner, text: payload)
        XCTAssertLessThan(first, payload.utf8.count)
        do {
            _ = try await manager.write(id: shell.id, ownerSessionID: owner, text: "more")
            XCTFail("expected a refusal")
        } catch let error as ShellSessionError {
            XCTAssertEqual(error, .notReading(id: shell.id))
        }
    }

    func testInputToAnEndedShellIsRefused() async throws {
        let shell = try await start("true")
        let ended = try await waitUntilEnded(shell.id)
        do {
            _ = try await manager.write(id: shell.id, ownerSessionID: owner, text: "x")
            XCTFail("expected a refusal")
        } catch let error as ShellSessionError {
            XCTAssertEqual(error, .notRunning(id: shell.id, state: ended.state))
        }
    }

    func testAnotherSessionCannotTouchTheShell() async throws {
        let shell = try await start("sleep 30")
        let stranger = CodeSessionID()
        for attempt in [
            { _ = try await self.manager.write(id: shell.id, ownerSessionID: stranger, text: "x") },
            { _ = try await self.manager.kill(id: shell.id, ownerSessionID: stranger, signal: .kill) },
            {
                _ = try await self.manager.output(
                    id: shell.id, ownerSessionID: stranger, since: nil, tailLines: nil,
                    maximumBytes: 1_024, waitSeconds: 0
                )
            },
        ] as [() async throws -> Void] {
            do {
                try await attempt()
                XCTFail("expected a refusal")
            } catch let error as ShellSessionError {
                XCTAssertEqual(error, .notOwned(id: shell.id))
            }
        }
        XCTAssertTrue(manager.sessions(ownedBy: stranger).isEmpty)
        XCTAssertEqual(manager.sessions(ownedBy: owner).map(\.id), [shell.id])
    }

    func testEndingASessionStopsOnlyItsShellsAndTheirChildren() async throws {
        let marker = "7\(Int.random(in: 100_000...999_999))"
        let mine = try await start("sleep \(marker) & sleep \(marker); wait")
        let other = CodeSessionID()
        let theirs = try await start("sleep 30", owner: other)
        try await Task.sleep(nanoseconds: 300_000_000)

        await manager.terminateAll(ownedBy: owner)
        XCTAssertNil(manager.info(id: mine.id), "an ended session's shells are forgotten")
        XCTAssertTrue(try XCTUnwrap(manager.info(id: theirs.id)).state.isRunning)

        try await Task.sleep(nanoseconds: 500_000_000)
        let check = try await CommandExecutionService(workspaceRootURL: workspaceURL)
            .run("pgrep -f 'sleep \(marker)' | wc -l", timeoutSeconds: 10)
        XCTAssertEqual(check.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "0")
        let logs = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("logs").path)
        XCTAssertFalse(logs.contains("\(mine.id).log"), "its log is removed with it")
    }

    func testRunsWhereAskedWithTheExecutorsEnvironment() async throws {
        let shell = try await start("pwd; echo $TERM $NO_COLOR", directory: "sub")
        let text = try await collect(shell.id) { $0.contains("dumb") }
        let lines = text.split(separator: "\n").map(String.init)
        XCTAssertTrue(lines.first?.hasSuffix("/sub") ?? false, text)
        XCTAssertEqual(lines.last, "dumb 1")

        do {
            _ = try await start("pwd", directory: "missing")
            XCTFail("expected a refusal")
        } catch let error as ShellSessionError {
            guard case .invalidWorkingDirectory = error else { return XCTFail("\(error)") }
        }
    }

    func testForbiddenCommandsNeverStart() async throws {
        do {
            _ = try await start("sudo rm -rf cache")
            XCTFail("expected a refusal")
        } catch let error as ShellSessionError {
            guard case .forbidden = error else { return XCTFail("\(error)") }
        }
    }

    func testAContainedShellCannotWriteOutsideTheWorkspace() async throws {
        try XCTSkipUnless(CommandSandboxProfile.isAvailable, "sandbox-exec is unavailable")
        let contained = ShellSessionManager(
            executor: CommandExecutionService.contained(workspaceRootURL: workspaceURL),
            logDirectory: root.appendingPathComponent("contained-logs")
        )
        let outside = NSHomeDirectory() + "/juno-shell-escape-\(UUID().uuidString)"
        let shell = try await contained.start(
            command: "touch '\(outside)'; echo status=$?",
            workingDirectory: nil,
            name: nil,
            ownerSessionID: owner,
            risk: .execute
        )
        var text = ""
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, !text.contains("status=") {
            text += try await contained.output(
                id: shell.id, ownerSessionID: owner, since: nil, tailLines: nil, maximumBytes: 4_096, waitSeconds: 0.5
            ).text
        }
        XCTAssertTrue(text.contains("status=1"), text)
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside))
        await contained.terminateAll()
    }

    func testAnOversizedLogDropsItsOldestOutput() async throws {
        let small = ShellSessionManager(
            executor: CommandExecutionService(workspaceRootURL: workspaceURL),
            logDirectory: root.appendingPathComponent("small-logs"),
            retainedBytes: 4_096
        )
        let shell = try await small.start(
            command: "for i in $(seq 1 2000); do echo line-$i; done",
            workingDirectory: nil, name: "noisy", ownerSessionID: owner, risk: .execute
        )
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, small.info(id: shell.id)?.state.isRunning == true {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try await Task.sleep(nanoseconds: 200_000_000)
        let page = try await small.output(
            id: shell.id, ownerSessionID: owner, since: 0, tailLines: nil, maximumBytes: 64 * 1_024, waitSeconds: 0
        )
        XCTAssertGreaterThan(page.droppedBytes, 0)
        XCTAssertTrue(page.text.hasSuffix("line-2000\n"), String(page.text.suffix(40)))
        XCTAssertLessThanOrEqual(page.text.utf8.count, 4_096)

        let tail = try await small.output(
            id: shell.id, ownerSessionID: owner, since: nil, tailLines: 2, maximumBytes: 4_096, waitSeconds: 0
        )
        XCTAssertEqual(tail.text, "line-1999\nline-2000\n")
        await small.terminateAll()
    }

    func testABurstTooLargeToShowKeepsItsEnds() async throws {
        let shell = try await start("for i in $(seq 1 3000); do echo row-$i; done")
        _ = try await waitUntilEnded(shell.id)
        try await Task.sleep(nanoseconds: 200_000_000)
        let chunk = try await manager.output(
            id: shell.id, ownerSessionID: owner, since: nil, tailLines: nil, maximumBytes: 2_048, waitSeconds: 0
        )
        XCTAssertTrue(chunk.text.hasPrefix("row-1\n"))
        XCTAssertTrue(chunk.text.hasSuffix("row-3000\n"))
        XCTAssertGreaterThan(chunk.omittedBytes, 0)
        XCTAssertEqual(chunk.nextOffset, chunk.info.outputBytes)
    }

    func testDecoderHoldsBackASplitCharacter() {
        let decoder = UTF8StreamDecoder()
        let bytes = Array("é!".utf8)
        XCTAssertNil(decoder.decode(Data(bytes[0..<1])))
        XCTAssertEqual(decoder.decode(Data(bytes[1...])), "é!")
    }
}
