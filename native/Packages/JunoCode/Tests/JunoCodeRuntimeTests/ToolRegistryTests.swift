import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

final class ToolRegistryTests: XCTestCase {
    private var workspaceURL: URL!
    private var registry: ToolRegistry!
    private var permissions: PermissionCoordinator!
    private let sessionID = CodeSessionID()

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-registry-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("src"),
            withIntermediateDirectories: true
        )
        try "let answer = 42\n".write(
            to: workspaceURL.appendingPathComponent("src/main.swift"),
            atomically: true,
            encoding: .utf8
        )
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        let checkpoints = CheckpointStore(
            directoryURL: workspaceURL.appendingPathComponent(".juno-checkpoints"),
            access: access
        )
        let files = FileOperationService(access: access, checkpoints: checkpoints)
        let executor = CommandExecutionService(workspaceRootURL: workspaceURL)
        registry = ToolRegistry.standard(
            files: files,
            index: WorkspaceIndexService(access: access),
            executor: executor,
            git: GitService(executor: executor),
            tests: TestRunnerService(access: access, executor: executor)
        )
        permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    private func context() -> ToolContext {
        ToolContext(sessionID: sessionID, toolCallID: "call", emitOutput: { _, _ in })
    }

    func testRegistryExposesTheFullToolSet() {
        let names = Set(registry.allTools.map(\.name))
        let expected: Set<String> = [
            "read_file", "list_directory", "find_files", "glob", "grep",
            "create_file", "write_file", "apply_patch", "delete_file", "move_file",
            "run_command", "git_status", "git_diff", "git_log", "git_commit",
            "run_tests",
        ]
        XCTAssertEqual(names, expected)
    }

    func testInspectionRegistryCannotEvenAdvertiseMutatingTools() {
        let inspection = registry.inspectionOnly()
        XCTAssertEqual(
            Set(inspection.allTools.map(\.name)),
            ToolRegistry.inspectionToolNames
        )
        XCTAssertNil(inspection.tool(named: "write_file"))
        XCTAssertNil(inspection.tool(named: "run_command"))
        XCTAssertNil(inspection.tool(named: "run_tests"))
        XCTAssertNil(inspection.tool(named: "git_commit"))
    }

    func testReadFileThroughRegistry() async throws {
        let result = try await registry.invoke(
            toolName: "read_file",
            input: ["path": "src/main.swift"],
            context: context(),
            permissions: permissions
        )
        XCTAssertTrue(result.content.contains("let answer = 42"))
        XCTAssertFalse(result.isError)
    }

    func testInputValidationRejectsBadShapes() async {
        do {
            _ = try await registry.invoke(
                toolName: "read_file",
                input: ["wrong": "field"],
                context: context(),
                permissions: permissions
            )
            XCTFail("expected invalid input")
        } catch let error as ToolError {
            guard case .invalidInput = error else {
                return XCTFail("unexpected \(error)")
            }
        } catch {
            XCTFail("unexpected \(error)")
        }
        do {
            _ = try await registry.invoke(
                toolName: "unknown_tool",
                input: [:],
                context: context(),
                permissions: permissions
            )
            XCTFail("expected unknown tool")
        } catch let error as ToolError {
            XCTAssertEqual(error, .unknownTool(name: "unknown_tool"))
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testPathTraversalIsRejectedAtInput() async {
        do {
            _ = try await registry.invoke(
                toolName: "read_file",
                input: ["path": "../outside.txt"],
                context: context(),
                permissions: permissions
            )
            XCTFail("expected rejection")
        } catch let error as ToolError {
            guard case .invalidInput = error else {
                return XCTFail("unexpected \(error)")
            }
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testWriteIsDeniedInReadOnlyMode() async {
        let readOnly = PermissionCoordinator(sessionID: sessionID, mode: .readOnly)
        do {
            _ = try await registry.invoke(
                toolName: "write_file",
                input: ["path": "src/new.swift", "content": "x"],
                context: context(),
                permissions: readOnly
            )
            XCTFail("expected denial")
        } catch let error as ToolError {
            guard case .denied = error else {
                return XCTFail("unexpected \(error)")
            }
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("src/new.swift").path
            ),
            "denied tool must not run"
        )
    }

    func testApprovalGateSuspendsToolExecution() async throws {
        let ask = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        let requested = expectation(description: "requested")
        nonisolated(unsafe) var requestID: String?
        await ask.addObserver { update in
            if case let .requested(request) = update {
                requestID = request.id
                requested.fulfill()
            }
        }
        let registry = self.registry!
        let context = self.context()
        let invocation = Task {
            try await registry.invoke(
                toolName: "create_file",
                input: ["path": "approved.txt", "content": "yes"],
                context: context,
                permissions: ask
            )
        }
        await fulfillment(of: [requested], timeout: 5)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("approved.txt").path
            ),
            "file must not exist while approval is pending"
        )
        await ask.resolve(approvalID: requestID!, decision: .approved)
        let result = try await invocation.value
        XCTAssertFalse(result.isError)
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("approved.txt").path
            )
        )
    }

    /// Deletion is gated up to and including `workspaceWrite`, and a denial
    /// leaves the file alone.
    ///
    /// The mode is `workspaceWrite` rather than the fixture's full access because
    /// deleting a file *inside the granted folder* is checkpointed and revertible,
    /// so full access now carries it out without asking — that is the whole point
    /// of the tier split, and `AgentOrchestratorTests`
    /// `testFullAccessDeletesInsideTheWorkspaceWithoutAsking` pins it. What must
    /// never become silent is leaving the folder, which is `destructive`.
    func testDeleteRequiresApprovalBelowFullAccess() async throws {
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .workspaceWrite)
        let requested = expectation(description: "requested")
        nonisolated(unsafe) var requestID: String?
        await permissions.addObserver { update in
            if case let .requested(request) = update {
                requestID = request.id
                requested.fulfill()
            }
        }
        let registry = self.registry!
        let context = self.context()
        let invocation = Task {
            try await registry.invoke(
                toolName: "delete_file",
                input: ["path": "src/main.swift"],
                context: context,
                permissions: permissions
            )
        }
        await fulfillment(of: [requested], timeout: 5)
        await permissions.resolve(approvalID: requestID!, decision: .denied)
        do {
            _ = try await invocation.value
            XCTFail("expected denial")
        } catch let error as ToolError {
            guard case .denied = error else {
                return XCTFail("unexpected \(error)")
            }
        }
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("src/main.swift").path
            )
        )
    }

    func testForbiddenCommandNeverReachesApproval() async {
        do {
            _ = try await registry.invoke(
                toolName: "run_command",
                input: ["command": "sudo rm -rf /"],
                context: context(),
                permissions: permissions
            )
            XCTFail("expected refusal")
        } catch let error as ToolError {
            guard case .denied = error else {
                return XCTFail("unexpected \(error)")
            }
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    /// Test commands and commit hooks stay approval-bound below full access, and
    /// their approval binds the *exact* command.
    ///
    /// The digest coupling is the security property here and is unchanged: an
    /// approval for `swift test` may not be replayed for `cargo test`. What
    /// changed is only which modes stop — `critical` is now waived by full access
    /// alone.
    func testTestCommandsAndCommitHooksStayApprovalBoundBelowFullAccess() throws {
        let runTests = try XCTUnwrap(registry.tool(named: "run_tests"))
        let gitCommit = try XCTUnwrap(registry.tool(named: "git_commit"))

        XCTAssertEqual(runTests.assessRisk(input: [:]), .critical)
        for command in [
            "swift test",
            "cargo test",
            "go test ./...",
            "project-doctor --fix",
        ] {
            XCTAssertEqual(
                runTests.assessRisk(input: ["command": .string(command)]),
                .critical,
                "\(command) must remain approval-bound"
            )
        }
        XCTAssertNotNil(registry.validateInput(toolName: "run_tests", input: [:]))
        XCTAssertEqual(
            runTests.precheck(input: [:]),
            .invalidInput(message: "Missing non-empty 'command'.")
        )
        XCTAssertEqual(
            runTests.precheck(input: ["command": " \n\t "]),
            .invalidInput(message: "Missing non-empty 'command'.")
        )
        XCTAssertNotEqual(
            runTests.actionDigest(input: ["command": "swift test"]),
            runTests.actionDigest(input: ["command": "cargo test"]),
            "Approval must bind the exact explicit test command"
        )
        XCTAssertNotNil(
            runTests.precheck(input: ["command": "sudo rm -rf /"])
        )
        XCTAssertEqual(gitCommit.assessRisk(input: ["message": "Ship"]), .critical)
        // Gated everywhere below full access…
        for mode in [PermissionMode.askBeforeChanges, .workspaceWrite] {
            XCTAssertEqual(
                PermissionPolicy.ruling(mode: mode, risk: .critical),
                .requireApproval,
                "\(mode) must still ask before a test command or a commit"
            )
        }
        // …and carried out by full access, which is what the mode now promises.
        XCTAssertEqual(
            PermissionPolicy.ruling(mode: .fullAccess, risk: .critical),
            .allow
        )
        // The boundary full access does not cross.
        XCTAssertEqual(
            PermissionPolicy.ruling(mode: .fullAccess, risk: .destructive),
            .requireApproval
        )
    }

    func testRunCommandStreamsOutput() async throws {
        nonisolated(unsafe) var streamed: [String] = []
        let context = ToolContext(
            sessionID: sessionID,
            toolCallID: "call",
            emitOutput: { channel, text in
                if channel == .stdout { streamed.append(text) }
            }
        )
        let result = try await registry.invoke(
            toolName: "run_command",
            input: ["command": "echo streaming-works"],
            context: context,
            permissions: permissions
        )
        XCTAssertTrue(result.content.contains("streaming-works"))
        XCTAssertTrue(result.content.contains("[exit 0"))
        XCTAssertTrue(streamed.joined().contains("streaming-works"))
    }

    func testGrepAndGlobTools() async throws {
        let grep = try await registry.invoke(
            toolName: "grep",
            input: ["pattern": "answer"],
            context: context(),
            permissions: permissions
        )
        XCTAssertTrue(grep.content.contains("src/main.swift:1"))

        let glob = try await registry.invoke(
            toolName: "glob",
            input: ["pattern": "**/*.swift"],
            context: context(),
            permissions: permissions
        )
        XCTAssertTrue(glob.content.contains("src/main.swift"))
    }

    func testMutationEmitsFileChangedSideEffect() async throws {
        let result = try await registry.invoke(
            toolName: "write_file",
            input: [
                "path": "src/main.swift",
                "content": "let answer = 43\n",
                "base_sha256": .string(FileFingerprint(of: "let answer = 42\n").sha256),
            ],
            context: context(),
            permissions: permissions
        )
        guard case let .fileChanged(event)? = result.sideEffects.first else {
            return XCTFail("expected fileChanged side effect")
        }
        XCTAssertEqual(event.path.value, "src/main.swift")
        XCTAssertEqual(event.kind, .modified)
        XCTAssertNotNil(event.checkpointID)
    }

    /// The guard that makes the fingerprint mean something: without a base, an
    /// overwrite of an existing file is refused rather than silently discarding
    /// whatever the agent had not read.
    func testWriteFileRefusesToOverwriteWithoutABase() async throws {
        do {
            _ = try await registry.invoke(
                toolName: "write_file",
                input: ["path": "src/main.swift", "content": "clobbered\n"],
                context: context(),
                permissions: permissions
            )
            XCTFail("an unguarded overwrite must be refused")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .baseFingerprintRequired(path: "src/main.swift"))
        }

        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent("src/main.swift"),
                encoding: .utf8
            ),
            "let answer = 42\n"
        )
    }

    /// A malformed fingerprint is a different failure from a stale one, and
    /// saying "the file changed" for it sends the model to re-read a file
    /// nobody has touched.
    func testWriteFileRejectsAMalformedFingerprintAsInvalidInput() async throws {
        do {
            _ = try await registry.invoke(
                toolName: "write_file",
                input: [
                    "path": "src/main.swift",
                    "content": "nope\n",
                    "base_sha256": "not-a-digest",
                ],
                context: context(),
                permissions: permissions
            )
            XCTFail("a malformed fingerprint must be rejected")
        } catch let error as ToolError {
            guard case .invalidInput = error else {
                return XCTFail("expected invalidInput, got \(error)")
            }
        }
    }

    /// The read contract the write tools depend on, exercised through the
    /// registry rather than against the renderer in isolation.
    func testReadFileReturnsAFingerprintTheWriteToolAccepts() async throws {
        let read = try await registry.invoke(
            toolName: "read_file",
            input: ["path": "src/main.swift"],
            context: context(),
            permissions: permissions
        )
        let header = String(read.content.prefix(while: { $0 != "\n" }))
        let fields = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(header.utf8)) as? [String: Any]
        )
        let digest = try XCTUnwrap(fields["base_sha256"] as? String)

        _ = try await registry.invoke(
            toolName: "write_file",
            input: [
                "path": "src/main.swift",
                "content": "let answer = 44\n",
                "base_sha256": .string(digest),
            ],
            context: context(),
            permissions: permissions
        )
        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent("src/main.swift"),
                encoding: .utf8
            ),
            "let answer = 44\n"
        )
    }
}
