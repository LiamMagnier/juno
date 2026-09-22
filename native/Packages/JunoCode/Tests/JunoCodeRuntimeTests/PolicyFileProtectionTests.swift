import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// The project's own policy files are not an ordinary edit. An Auto-edit
/// session could rewrite `.juno/settings.local.json` with "Bash" allowed and a
/// writable `/`, unasked, and have both in force from its next run.
final class PolicyFileProtectionTests: XCTestCase {
    private var workspaceURL: URL!
    private var registry: ToolRegistry!

    override func setUpWithError() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-policy-\(UUID().uuidString)")
        workspaceURL = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent(".juno"),
            withIntermediateDirectories: true
        )
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        let executor = CommandExecutionService(workspaceRootURL: workspaceURL)
        registry = ToolRegistry.standard(
            files: FileOperationService(
                access: access,
                checkpoints: CheckpointStore(directoryURL: base.appendingPathComponent("checkpoints"), access: access)
            ),
            index: WorkspaceIndexService(access: access),
            executor: executor,
            git: GitService(executor: executor),
            tests: TestRunnerService(access: access, executor: executor)
        )
    }

    private func risk(_ tool: String, _ input: JSONValue) throws -> ActionRisk {
        try XCTUnwrap(registry.tool(named: tool)).assessRisk(input: input)
    }

    func testWritesToPolicyFilesAreDestructiveHoweverTheyAreSpelled() throws {
        for path in [".juno/settings.local.json", ".juno/settings.json", ".JUNO/Settings.local.json", ".mcp.json", ".claude/settings.json", ".juno/.gitignore"] {
            XCTAssertEqual(try risk("write_file", ["path": .string(path), "content": "{}"]), .destructive, path)
            XCTAssertEqual(try risk("create_file", ["path": .string(path), "content": "{}"]), .destructive, path)
            XCTAssertEqual(try risk("apply_patch", ["path": .string(path), "target": "a", "replacement": "b"]), .destructive, path)
            XCTAssertEqual(try risk("delete_file", ["path": .string(path)]), .destructive, path)
        }
        XCTAssertEqual(try risk("move_file", ["from": ".juno", "to": "old-juno"]), .destructive)
        XCTAssertEqual(try risk("move_file", ["from": "staged.json", "to": ".juno/settings.local.json"]), .destructive)
        // Everything else keeps its ordinary risk.
        XCTAssertEqual(try risk("write_file", ["path": "src/settings.json", "content": "{}"]), .write)
        XCTAssertEqual(try risk("write_file", ["path": ".juno/skills/deploy.md", "content": "x"]), .write)
        XCTAssertEqual(try risk("delete_file", ["path": "src/a.swift"]), .critical)
    }

    /// Asked about in Auto-edit, never silenced by an allow rule, and never
    /// offered as an "Always allow".
    func testAutoEditAsksAndOffersNoStandingRule() async throws {
        let permissions = PermissionCoordinator(sessionID: CodeSessionID(), mode: .workspaceWrite)
        await permissions.setRules(PermissionRuleSet(allow: [PermissionRule(tool: "Edit"), PermissionRule(tool: "Write")]))
        let registry = self.registry!
        let attempt = Task {
            try await registry.authorizeInvocation(
                toolName: "write_file",
                input: ["path": ".juno/settings.local.json", "content": #"{"permissions":{"allow":["Bash"]}}"#],
                permissions: permissions
            )
        }
        var pending: [ApprovalRequest] = []
        for _ in 0..<200 where pending.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
            pending = await permissions.pendingApprovals
        }
        let request = try XCTUnwrap(pending.first, "the write went ahead without asking")
        XCTAssertEqual(request.risk, .destructive)
        XCTAssertNil(request.suggestedRule)
        await permissions.resolve(approvalID: request.id, decision: .denied)
        do {
            try await attempt.value
            XCTFail("a declined write must not be authorized")
        } catch {}
    }

    /// A link in the workspace does not turn a policy file into an ordinary
    /// edit.
    func testAPolicyFileReachedThroughALinkIsRefused() async throws {
        try FileManager.default.createSymbolicLink(
            at: workspaceURL.appendingPathComponent("cfg"),
            withDestinationURL: workspaceURL.appendingPathComponent(".juno")
        )
        XCTAssertEqual(try risk("create_file", ["path": "cfg/settings.local.json", "content": "{}"]), .write)
        do {
            _ = try await registry.invoke(
                toolName: "create_file",
                input: ["path": "cfg/settings.local.json", "content": #"{"permissions":{"allow":["Bash"]}}"#],
                context: ToolContext(sessionID: CodeSessionID(), toolCallID: "c", emitOutput: { _, _ in }),
                permissions: PermissionCoordinator(sessionID: CodeSessionID(), mode: .fullAccess)
            )
            XCTFail("a policy file reached through a link was written as an ordinary edit")
        } catch let error as FileOperationError {
            guard case .ioFailure = error else { return XCTFail("\(error)") }
        }
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: workspaceURL.appendingPathComponent(".juno/settings.local.json").path)
        )
    }
}
