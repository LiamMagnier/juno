import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// `multi_edit` and the multi-file `apply_patch`, end to end through the
/// registry against a real workspace.
final class EditToolsTests: XCTestCase {
    private var workspaceURL: URL!
    private var registry: ToolRegistry!
    private var checkpoints: CheckpointStore!
    private var permissions: PermissionCoordinator!
    private let sessionID = CodeSessionID()

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-edit-tools-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        checkpoints = CheckpointStore(
            directoryURL: workspaceURL.deletingLastPathComponent()
                .appendingPathComponent(workspaceURL.lastPathComponent + "-checkpoints"),
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
        try? FileManager.default.removeItem(
            at: workspaceURL.deletingLastPathComponent()
                .appendingPathComponent(workspaceURL.lastPathComponent + "-checkpoints")
        )
    }

    private func put(_ text: String, _ name: String) throws {
        let url = workspaceURL.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func read(_ name: String) -> String? {
        try? String(contentsOf: workspaceURL.appendingPathComponent(name), encoding: .utf8)
    }

    private func invoke(_ tool: String, _ input: JSONValue) async throws -> ToolResult {
        try await registry.invoke(
            toolName: tool,
            input: input,
            context: ToolContext(sessionID: sessionID, toolCallID: "call", emitOutput: { _, _ in }),
            permissions: permissions
        )
    }

    // MARK: - multi_edit

    func testMultiEditAppliesEveryEditAsOneCheckpointedWrite() async throws {
        try put("let a = 1\nlet b = 2\nlet c = 3\n", "src/v.swift")
        let result = try await invoke("multi_edit", [
            "path": "src/v.swift",
            "edits": [
                ["old_string": "let a = 1", "new_string": "let a = 10"],
                ["old_string": "let c = 3", "new_string": "let c = 30"],
            ],
            "base_sha256": .string(FileFingerprint(of: "let a = 1\nlet b = 2\nlet c = 3\n").sha256),
        ])
        XCTAssertFalse(result.isError)
        XCTAssertEqual(read("src/v.swift"), "let a = 10\nlet b = 2\nlet c = 30\n")
        XCTAssertEqual(result.sideEffects.count, 1)
        let recorded = await checkpoints.checkpoints(for: sessionID)
        XCTAssertEqual(recorded.count, 1)
    }

    func testMultiEditLeavesTheFileAloneWhenAnyEditFails() async throws {
        try put("alpha\nbeta\n", "a.txt")
        do {
            _ = try await invoke("multi_edit", [
                "path": "a.txt",
                "edits": [
                    ["old_string": "alpha", "new_string": "ALPHA"],
                    ["old_string": "gamma", "new_string": "GAMMA"],
                ],
            ])
            XCTFail("expected the second edit to fail")
        } catch {
            XCTAssertTrue(String(describing: error).contains("Edit 2"), "\(error)")
        }
        XCTAssertEqual(read("a.txt"), "alpha\nbeta\n")
    }

    func testMultiEditRefusesAStaleBase() async throws {
        try put("x\n", "a.txt")
        do {
            _ = try await invoke("multi_edit", [
                "path": "a.txt",
                "edits": [["old_string": "x", "new_string": "y"]],
                "base_sha256": .string(FileFingerprint(of: "something else").sha256),
            ])
            XCTFail("expected a refusal")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .concurrentModification(path: "a.txt"))
        }
        XCTAssertEqual(read("a.txt"), "x\n")
    }

    func testMultiEditValidatesItsEditsBeforeAskingAnything() {
        let tool = MultiEditTool(files: StubFiles())
        XCTAssertNotNil(tool.precheck(input: ["path": "a", "edits": []]))
        XCTAssertNotNil(tool.precheck(input: ["path": "a", "edits": [["old_string": "a"]]]))
        XCTAssertNil(tool.precheck(input: ["path": "a", "edits": [["old_string": "a", "new_string": "b"]]]))
    }

    // MARK: - apply_patch

    func testAPatchChangesSeveralFilesAtOnce() async throws {
        try put("func run() {\n    let a = 1\n    let b = 2\n}\n", "src/app.swift")
        try put("obsolete\n", "old.txt")
        try put("rename me\n", "src/name.swift")
        let patch = """
            *** Begin Patch
            *** Update File: src/app.swift
            @@ func run() {
                 let a = 1
            -    let b = 2
            +    let b = 3
            *** Add File: docs/notes.md
            +Notes
            *** Delete File: old.txt
            *** Update File: src/name.swift
            *** Move to: src/renamed.swift
            @@
            -rename me
            +renamed
            *** End Patch
            """
        let result = try await invoke("apply_patch", ["patch": .string(patch)])
        XCTAssertFalse(result.isError)
        XCTAssertEqual(read("src/app.swift"), "func run() {\n    let a = 1\n    let b = 3\n}\n")
        XCTAssertEqual(read("docs/notes.md"), "Notes\n")
        XCTAssertNil(read("old.txt"))
        XCTAssertNil(read("src/name.swift"))
        XCTAssertEqual(read("src/renamed.swift"), "renamed\n")
        XCTAssertEqual(result.sideEffects.count, 4)
        XCTAssertTrue(result.content.contains("R src/name.swift → src/renamed.swift"), result.content)

        let recorded = await checkpoints.checkpoints(for: sessionID)
        XCTAssertEqual(recorded.count, 1, "one checkpoint for the whole patch")
    }

    func testAHunkThatDoesNotMatchLeavesEveryFileUntouched() async throws {
        try put("one\n", "a.txt")
        try put("two\n", "b.txt")
        let patch = """
            *** Begin Patch
            *** Update File: a.txt
            -one
            +ONE
            *** Update File: b.txt
            -three
            +THREE
            *** End Patch
            """
        do {
            _ = try await invoke("apply_patch", ["patch": .string(patch)])
            XCTFail("expected the second file's hunk to fail")
        } catch {
            let text = String(describing: error)
            XCTAssertTrue(text.contains("b.txt") && text.contains("No file was changed"), text)
        }
        XCTAssertEqual(read("a.txt"), "one\n")
        XCTAssertEqual(read("b.txt"), "two\n")
    }

    func testAnAddOntoAnExistingFileRefusesTheWholePatch() async throws {
        try put("keep\n", "a.txt")
        try put("exists\n", "b.txt")
        let patch = """
            *** Begin Patch
            *** Update File: a.txt
            -keep
            +changed
            *** Add File: b.txt
            +clobber
            *** End Patch
            """
        do {
            _ = try await invoke("apply_patch", ["patch": .string(patch)])
            XCTFail("expected a refusal")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .alreadyExists(path: "b.txt"))
        }
        XCTAssertEqual(read("a.txt"), "keep\n")
        XCTAssertEqual(read("b.txt"), "exists\n")
    }

    func testTheOriginalSingleReplacementStillWorks() async throws {
        try put("let x = 1\n", "a.swift")
        let result = try await invoke("apply_patch", [
            "path": "a.swift", "target": "let x = 1", "replacement": "let x = 2",
        ])
        XCTAssertEqual(result.content, "Patched a.swift (+1 −1).")
        XCTAssertEqual(read("a.swift"), "let x = 2\n")
    }

    func testAMalformedPatchIsRefusedBeforeApproval() {
        let tool = ApplyPatchTool(files: StubFiles())
        XCTAssertNotNil(tool.precheck(input: ["patch": "*** Update File: a\n+x"]))
        XCTAssertNotNil(tool.precheck(input: ["patch": "*** Begin Patch\n*** Delete File: ../escape\n*** End Patch"]))
        XCTAssertNotNil(tool.precheck(input: ["path": "a"]), "neither form is complete")
        XCTAssertNotNil(tool.precheck(input: [
            "patch": "*** Begin Patch\n*** Delete File: a\n*** End Patch", "path": "a",
        ]))
    }

    func testAPatchIsAsRiskyAsItsRiskiestOperation() {
        let tool = ApplyPatchTool(files: StubFiles())
        func risk(_ patch: String) -> ActionRisk { tool.assessRisk(input: ["patch": .string(patch)]) }
        XCTAssertEqual(risk("*** Begin Patch\n*** Add File: a\n+x\n*** End Patch"), .write)
        XCTAssertEqual(risk("*** Begin Patch\n*** Add File: a\n+x\n*** Delete File: b\n*** End Patch"), .critical)
        XCTAssertEqual(
            risk("*** Begin Patch\n*** Add File: .juno/settings.local.json\n+{}\n*** End Patch"),
            .destructive
        )
        XCTAssertEqual(
            ToolRuleSubjects.subject(
                toolName: "apply_patch",
                input: ["patch": "*** Begin Patch\n*** Add File: a\n+x\n*** Delete File: b\n*** End Patch"]
            ),
            .paths(["a", "b"])
        )
        XCTAssertEqual(
            ToolRuleSubjects.subject(toolName: "move_file", input: ["from": "secrets/k", "to": "src/k"]),
            .paths(["secrets/k", "src/k"])
        )
    }

    func testADenyRuleOnAnyFileOfAPatchRefusesIt() async throws {
        await permissions.setRules(PermissionRuleSet(deny: [PermissionRule(tool: "Edit", specifier: "secrets/**")]))
        try put("a\n", "src/a.txt")
        let patch = """
            *** Begin Patch
            *** Update File: src/a.txt
            -a
            +b
            *** Add File: secrets/new.key
            +key
            *** End Patch
            """
        do {
            _ = try await invoke("apply_patch", ["patch": .string(patch)])
            XCTFail("expected the rule to deny it")
        } catch let error as ToolError {
            guard case .denied = error else { return XCTFail("\(error)") }
        }
        XCTAssertEqual(read("src/a.txt"), "a\n")
    }
}

/// Precheck and risk never touch the disk; a stub proves it.
private struct StubFiles: FileOperating {
    func read(_ path: WorkspacePath, limit: OutputLimit) async throws -> FileReadResult { throw StubError() }
    func create(_ path: WorkspacePath, content: String, sessionID: CodeSessionID) async throws -> FileMutationResult { throw StubError() }
    func write(_ path: WorkspacePath, content: String, expectedBase: FileFingerprint?, sessionID: CodeSessionID) async throws -> FileMutationResult { throw StubError() }
    func applyPatch(_ path: WorkspacePath, patch: TextPatch, expectedBase: FileFingerprint?, sessionID: CodeSessionID) async throws -> FileMutationResult { throw StubError() }
    func delete(_ path: WorkspacePath, sessionID: CodeSessionID) async throws -> FileMutationResult { throw StubError() }
    func move(from source: WorkspacePath, to destination: WorkspacePath, sessionID: CodeSessionID) async throws -> FileMutationResult { throw StubError() }
    func readData(_ path: WorkspacePath, maximumBytes: Int) async throws -> FileDataReadResult { throw StubError() }
    func applyChangeSet(_ changes: [FileChangeRequest], sessionID: CodeSessionID) async throws -> [FileMutationResult] { throw StubError() }
    struct StubError: Error {}
}
