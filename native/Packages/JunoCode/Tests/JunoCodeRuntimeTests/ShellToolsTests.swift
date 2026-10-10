import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// The shell tools and run_command's working directory, end to end through a
/// registry over a real workspace.
final class ShellToolsTests: XCTestCase {
    private var root: URL!
    private var workspaceURL: URL!
    private var shells: ShellSessionManager!
    private var registry: ToolRegistry!
    private var permissions: PermissionCoordinator!
    private let sessionID = CodeSessionID()

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-shell-tools-\(UUID().uuidString)")
        workspaceURL = root.appendingPathComponent("workspace").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("app/src"),
            withIntermediateDirectories: true
        )
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        let executor = CommandExecutionService(workspaceRootURL: workspaceURL)
        shells = ShellSessionManager(executor: executor, logDirectory: root.appendingPathComponent("logs"))
        registry = ToolRegistry.standard(
            files: FileOperationService(
                access: access,
                checkpoints: CheckpointStore(directoryURL: root.appendingPathComponent("checkpoints"), access: access)
            ),
            index: WorkspaceIndexService(access: access),
            executor: executor,
            git: GitService(executor: executor),
            tests: TestRunnerService(access: access, executor: executor),
            shells: shells,
            workingDirectories: SessionWorkingDirectories(),
            workspaceRoot: workspaceURL.path
        )
        permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
    }

    override func tearDown() async throws {
        await shells.terminateAll()
        try? FileManager.default.removeItem(at: root)
    }

    private func invoke(_ tool: String, _ input: JSONValue) async throws -> ToolResult {
        try await registry.invoke(
            toolName: tool,
            input: input,
            context: ToolContext(sessionID: sessionID, toolCallID: "call", emitOutput: { _, _ in }),
            permissions: permissions
        )
    }

    private func header(_ content: String) throws -> [String: Any] {
        let line = content.prefix { $0 != "\n" }
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
    }

    // MARK: - run_command's folder

    func testShellStartPointsWebServersAtThePreview() throws {
        let start = try XCTUnwrap(registry.tool(named: "shell_start"))
        XCTAssertTrue(start.description.contains("prefer preview_server start"))
        XCTAssertTrue(start.description.contains("opens in the Preview pane"))
    }

    func testALoneCdMovesLaterCommandsAndACdInsideACommandDoesNot() async throws {
        let moved = try await invoke("run_command", ["command": "cd app/src"])
        XCTAssertTrue(moved.content.contains("now app/src"), moved.content)
        let here = try await invoke("run_command", ["command": "pwd"])
        XCTAssertTrue(here.content.hasPrefix(workspaceURL.appendingPathComponent("app/src").path), here.content)
        XCTAssertTrue(here.content.contains("in app/src"), "the footer says where it ran")

        _ = try await invoke("run_command", ["command": "cd lib; pwd"])
        let still = try await invoke("run_command", ["command": "pwd"])
        XCTAssertTrue(still.content.hasPrefix(workspaceURL.appendingPathComponent("app/src").path), still.content)

        _ = try await invoke("run_command", ["command": "cd .."])
        let up = try await invoke("run_command", ["command": "pwd"])
        XCTAssertTrue(up.content.hasPrefix(workspaceURL.appendingPathComponent("app").path + "\n"), up.content)

        let elsewhere = try await invoke("run_command", ["command": "pwd", "cwd": "app/src"])
        XCTAssertTrue(elsewhere.content.hasPrefix(workspaceURL.appendingPathComponent("app/src").path), elsewhere.content)

        _ = try await invoke("run_command", ["command": "cd"])
        let home = try await invoke("run_command", ["command": "pwd"])
        XCTAssertTrue(home.content.hasPrefix(workspaceURL.path + "\n"), home.content)
    }

    func testACdCannotLeaveTheWorkspaceOrGoNowhere() async throws {
        for target in ["cd ..", "cd /etc", "cd missing"] {
            do {
                // Straight to the tool: what is refused here is the move,
                // whatever the permission layer would have said first.
                _ = try await registry.executeAuthorized(
                    toolName: "run_command",
                    input: ["command": .string(target)],
                    context: ToolContext(sessionID: sessionID, toolCallID: "call", emitOutput: { _, _ in })
                )
                XCTFail("\(target) should be refused")
            } catch let error as ToolError {
                guard case .executionFailed = error else { return XCTFail("\(error)") }
            }
        }
        let absolute = try await registry.executeAuthorized(
            toolName: "run_command",
            input: ["command": .string("cd \(workspaceURL.path)/app")],
            context: ToolContext(sessionID: sessionID, toolCallID: "call", emitOutput: { _, _ in })
        )
        XCTAssertTrue(absolute.content.contains("now app"), absolute.content)
    }

    func testALoneCdIsNotAskedAboutLikeTheEscapeItsTextSuggests() throws {
        let run = try XCTUnwrap(registry.tool(named: "run_command"))
        XCTAssertEqual(run.assessRisk(input: ["command": "cd .."]), .read)
        XCTAssertEqual(run.assessRisk(input: ["command": "cd .. && ls"]), .destructive)
        XCTAssertNil(RunCommandTool.wholeCommandDirectoryChange("cd a && make"))
        XCTAssertNil(RunCommandTool.wholeCommandDirectoryChange("cd $(pwd)"))
        XCTAssertEqual(RunCommandTool.wholeCommandDirectoryChange("cd 'my dir'"), "'my dir'")
        XCTAssertEqual(RunCommandTool.wholeCommandDirectoryChange("  cd  "), "")
    }

    func testChainsAndRedirectsAreNotBackgroundJobs() {
        XCTAssertFalse(ShellBackgrounding.runsInBackground("make && make test"))
        XCTAssertFalse(ShellBackgrounding.runsInBackground("swift build 2>&1 | tail"))
        XCTAssertFalse(ShellBackgrounding.runsInBackground("echo '&'"))
        XCTAssertTrue(ShellBackgrounding.runsInBackground("npm run dev &"))
        XCTAssertTrue(ShellBackgrounding.runsInBackground("a & b"))
    }

    func testBackgroundJobsArePointedAtShellStart() async throws {
        do {
            _ = try await invoke("run_command", ["command": "sleep 5 &"])
            XCTFail("expected a refusal")
        } catch let error as ToolError {
            guard case let .denied(reason) = error else { return XCTFail("\(error)") }
            XCTAssertTrue(reason.contains("shell_start"), reason)
        }
    }

    // MARK: - Shell tools

    func testStartReadWriteAndStopAShell() async throws {
        let started = try await invoke("shell_start", ["command": "cat", "name": "echo", "cwd": "app"])
        let fields = try header(started.content)
        let id = try XCTUnwrap(fields["id"] as? String)
        XCTAssertEqual(fields["status"] as? String, "running")
        XCTAssertEqual(fields["cwd"] as? String, "app")

        let wrote = try await invoke("shell_write", ["id": .string(id), "text": "hello\n"])
        XCTAssertEqual(wrote.content, "Wrote 6 bytes to \(id).")
        let output = try await invoke("shell_output", ["id": .string(id), "wait_seconds": 3])
        XCTAssertTrue(output.content.hasSuffix("\nhello\n"), output.content)

        let listing = try await invoke("shell_output", [:])
        XCTAssertTrue(listing.content.contains("\(id) \"echo\": running"), listing.content)

        let stopped = try await invoke("shell_kill", ["id": .string(id)])
        XCTAssertTrue(stopped.content.contains("killed by SIGTERM"), stopped.content)
        do {
            _ = try await invoke("shell_write", ["id": .string(id), "text": "late\n"])
            XCTFail("expected a refusal")
        } catch {
            XCTAssertTrue(String(describing: error).contains("not running"), "\(error)")
        }
    }

    func testAShellThatFailsAtOnceSaysSo() async throws {
        let result = try await invoke("shell_start", ["command": "echo broken >&2; exit 2"])
        XCTAssertTrue(result.isError)
        let fields = try header(result.content)
        XCTAssertEqual(fields["status"] as? String, "exited")
        XCTAssertEqual(fields["exit_code"] as? Int, 2)
        XCTAssertTrue(result.content.contains("broken"))
    }

    func testAShellStartsInTheSessionsFolder() async throws {
        _ = try await invoke("run_command", ["command": "cd app/src"])
        let started = try await invoke("shell_start", ["command": "pwd"])
        XCTAssertEqual(try header(started.content)["cwd"] as? String, "app/src")
        XCTAssertTrue(started.content.contains("/app/src\n"), started.content)
    }

    func testRisksAndRefusals() throws {
        let start = try XCTUnwrap(registry.tool(named: "shell_start"))
        XCTAssertEqual(start.assessRisk(input: ["command": "ls"]), .execute, "never below execute")
        XCTAssertEqual(start.assessRisk(input: ["command": "npm run dev"]), .critical)
        XCTAssertNotNil(start.precheck(input: ["command": "npm run dev &"]))
        XCTAssertNotNil(start.precheck(input: ["command": "sudo rm -rf cache"]))
        XCTAssertNil(start.precheck(input: ["command": "make && make test"]))
        XCTAssertEqual(
            ToolRuleSubjects.subject(toolName: "shell_start", input: ["command": "npm run dev"]),
            .command("npm run dev")
        )
        let output = try XCTUnwrap(registry.tool(named: "shell_output"))
        XCTAssertEqual(output.assessRisk(input: ["id": "sh-1"]), .read)
        let kill = try XCTUnwrap(registry.tool(named: "shell_kill"))
        XCTAssertNotNil(kill.precheck(input: ["id": "sh-1", "signal": "SIGSTOP"]))
    }

    func testAWriteIsAskedAboutAtTheTierTheShellStartedAt() async throws {
        let info = try await shells.start(
            command: "cat", workingDirectory: nil, name: nil, ownerSessionID: sessionID, risk: .critical
        )
        let write = try XCTUnwrap(registry.tool(named: "shell_write"))
        XCTAssertEqual(write.assessRisk(input: ["id": .string(info.id), "text": "x"]), .critical)
        XCTAssertEqual(write.assessRisk(input: ["id": "sh-unknown", "text": "x"]), .execute)
    }

    func testTextForAShellReadingItsProgramIsAlwaysAsked() async throws {
        // `bash` starts at `critical`, which Full Access runs unasked; what is
        // typed into it afterwards is a program nothing has read.
        let start = try XCTUnwrap(registry.tool(named: "shell_start"))
        XCTAssertEqual(start.assessRisk(input: ["command": "bash"]), .critical)
        let shell = try await shells.start(
            command: "bash", workingDirectory: nil, name: nil, ownerSessionID: sessionID, risk: .critical
        )
        let write = try XCTUnwrap(registry.tool(named: "shell_write"))
        XCTAssertEqual(write.assessRisk(input: ["id": .string(shell.id), "text": "ls\n"]), .destructive)
        XCTAssertEqual(PermissionPolicy.ruling(mode: .fullAccess, risk: .destructive), .requireApproval)
        XCTAssertEqual(PermissionPolicy.ruling(mode: .fullAccess, risk: .critical), .allow)
        // The whole text is what the reader is asked about.
        let long = String(repeating: "x", count: 300) + "\nrm -rf build\n"
        XCTAssertTrue(write.summary(input: ["id": .string(shell.id), "text": .string(long)]).hasSuffix("⏎rm -rf build⏎"))
        XCTAssertNotNil(write.precheck(input: ["id": .string(shell.id), "text": ""]))
        XCTAssertNotNil(write.precheck(input: [
            "id": .string(shell.id),
            "text": .string(String(repeating: "x", count: ShellWriteTool.maximumTextBytes + 1)),
        ]))
        XCTAssertNil(write.precheck(input: ["id": .string(shell.id), "text": "ls\n"]))
        XCTAssertEqual(ToolEffectClassifier.classify(toolName: "shell_write", input: ["id": .string(shell.id)]), .exclusive)
    }

    func testAStartForARunAlreadyStoppedStartsNothing() async throws {
        let tool = try XCTUnwrap(registry.tool(named: "shell_start"))
        let context = ToolContext(sessionID: sessionID, toolCallID: "call", emitOutput: { _, _ in })
        let task = Task { [tool, context] in
            try await tool.execute(input: ["command": "sleep 30"], context: context)
        }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected a cancellation")
        } catch is CancellationError {}
        XCTAssertTrue(shells.sessions(ownedBy: sessionID).isEmpty)
    }

    func testAPlanSessionCannotReachTheShellTools() {
        let names = Set(registry.inspectionOnly().allTools.map(\.name))
        for name in ["shell_start", "shell_write", "shell_kill", "run_command"] {
            XCTAssertFalse(names.contains(name), name)
        }
    }
}
