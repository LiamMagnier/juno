import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// Local sub-agents are labelled read-only. These check the label is enforced
/// rather than merely written down.
///
/// The work order's requirement is that local sub-agents either do isolated
/// writer work safely, or are *explicitly* read-only until that ships. The
/// second is what Juno does — so the claim needs to be a guarantee the runtime
/// makes, not a sentence in a tool description and a system prompt that a model
/// is free to ignore.
///
/// Two independent layers, and each is checked on its own: a regression in
/// either one alone would otherwise be invisible behind the other.
final class SubagentContainmentTests: XCTestCase {
    private func standardRegistry() throws -> ToolRegistry {
        let workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-subagent-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("src"),
            withIntermediateDirectories: true
        )
        addTeardownBlock { try? FileManager.default.removeItem(at: workspaceURL) }

        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        let checkpoints = CheckpointStore(
            directoryURL: workspaceURL.appendingPathComponent(".juno-checkpoints"),
            access: access
        )
        let executor = CommandExecutionService(workspaceRootURL: workspaceURL)
        return ToolRegistry.standard(
            files: FileOperationService(access: access, checkpoints: checkpoints),
            index: WorkspaceIndexService(access: access),
            executor: executor,
            git: GitService(executor: executor),
            tests: TestRunnerService(access: access, executor: executor)
        )
    }

    /// Layer one: a child cannot even *see* a mutating tool, so there is no
    /// call for the permission layer to refuse.
    func testAChildRegistryAdvertisesNoToolThatCanChangeAnything() throws {
        let child = try standardRegistry().inspectionOnly()
        let names = Set(child.allTools.map(\.name))

        for mutating in [
            "create_file", "write_file", "apply_patch", "delete_file", "move_file",
            "run_command", "run_tests", "git_commit",
        ] {
            XCTAssertFalse(names.contains(mutating), "a sub-agent must not be offered \(mutating)")
        }
        XCTAssertNil(child.tool(named: "write_file"))
    }

    func testAChildCanStillDoTheInvestigationItIsFor() throws {
        // Containment that removed the reading tools would make delegation
        // useless, and the pressure would be to hand children the full set.
        let names = Set(try standardRegistry().inspectionOnly().allTools.map(\.name))
        for reading in ["read_file", "grep", "glob", "list_directory", "git_diff"] {
            XCTAssertTrue(names.contains(reading), "a sub-agent needs \(reading)")
        }
    }

    /// Layer two: even handed a mutating tool, the child's permission mode
    /// refuses it — and refuses rather than prompting, because no reader is
    /// attached to a sub-agent to answer a prompt.
    func testAReadOnlyChildIsRefusedEveryMutationAtThePermissionLayer() async throws {
        let coordinator = PermissionCoordinator(sessionID: CodeSessionID(), mode: .readOnly)
        nonisolated(unsafe) var sawPrompt = false
        await coordinator.addObserver { update in
            if case .requested = update { sawPrompt = true }
        }

        for risk in ActionRisk.allCases where risk != .read {
            let outcome = await coordinator.authorize(
                toolName: "write_file",
                actionDigest: "digest-\(risk.rawValue)",
                risk: risk,
                summary: "Write something"
            )
            guard case .denied = outcome else {
                return XCTFail("a read-only sub-agent allowed a \(risk) action")
            }
        }
        XCTAssertFalse(sawPrompt, "a sub-agent has no reader to answer a prompt")
    }

    /// A pinned tool must not become a prompt inside a sub-agent either: the
    /// refusal has to outrank the pin, or delegation would hang forever on an
    /// approval nobody can give.
    func testAPinnedToolIsRefusedInAChildRatherThanSuspending() async throws {
        let coordinator = PermissionCoordinator(sessionID: CodeSessionID(), mode: .readOnly)
        let outcome = await coordinator.authorize(
            toolName: "run_tests",
            actionDigest: "digest",
            risk: .critical,
            summary: "Run tests: swift test",
            approvalPolicy: .alwaysRequiresApproval
        )
        guard case .denied = outcome else {
            return XCTFail("a pinned tool must be refused, not suspended, in a sub-agent")
        }
    }

    /// Reads still work, or the child could not investigate at all.
    func testAReadOnlyChildMayRead() async throws {
        let coordinator = PermissionCoordinator(sessionID: CodeSessionID(), mode: .readOnly)
        let outcome = await coordinator.authorize(
            toolName: "read_file",
            actionDigest: "digest",
            risk: .read,
            summary: "Read src/main.swift"
        )
        guard case .allowed = outcome else {
            return XCTFail("a sub-agent must be able to read")
        }
    }
}
