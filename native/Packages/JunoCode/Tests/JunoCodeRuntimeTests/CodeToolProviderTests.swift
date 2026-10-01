import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

private struct NamedTool: CodeTool {
    let name: String
    let description = "A provided tool."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    func summary(input _: JSONValue) -> String { name }
    func execute(input _: JSONValue, context _: ToolContext) async throws -> ToolResult { ToolResult(content: name) }
}

private struct FixedProvider: CodeToolProvider {
    let names: [String]

    func tools(for _: CodeToolProviderContext) async -> [any CodeTool] {
        names.map { NamedTool(name: $0) }
    }
}

/// Each lane registers its tools from its own file through a
/// `CodeToolProvider` (CODE_AGENT_SPEC §6.0). Providers only add tools, in
/// order, and only to Code turns.
final class CodeToolProviderTests: XCTestCase {
    private var base: URL!

    override func setUp() {
        base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-providers-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    private func context(_ behavior: AgentBehavior) throws -> CodeToolProviderContext {
        let workspace = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspace)
        let executor = CommandExecutionService(workspaceRootURL: workspace)
        let session = CodeSessionID()
        return CodeToolProviderContext(
            sessionID: session,
            workspaceID: access.workspaceID,
            workspaceRoot: workspace,
            behavior: behavior,
            supportsVision: true,
            computerUseActive: false,
            store: CodeSessionStore(directoryURL: base.appendingPathComponent("store")),
            permissions: PermissionCoordinator(sessionID: session, mode: .workspaceWrite),
            files: FileOperationService(
                access: access,
                checkpoints: CheckpointStore(directoryURL: base.appendingPathComponent("checkpoints"), access: access)
            ),
            executor: executor,
            git: GitService(executor: executor),
            tests: TestRunnerService(access: access, executor: executor)
        )
    }

    func testProvidersAddTheirToolsInOrderToACodeTurn() async throws {
        let tools = await ToolRegistry.providedTools(
            by: [FixedProvider(names: ["b_tool", "a_tool"]), FixedProvider(names: []), FixedProvider(names: ["c_tool"])],
            for: try context(.code)
        )
        XCTAssertEqual(tools.map(\.name), ["b_tool", "a_tool", "c_tool"])
    }

    func testReadOnlyBehavioursGetNoProvidedTools() async throws {
        for behavior in [AgentBehavior.ask, .plan, .survey] {
            let tools = await ToolRegistry.providedTools(by: [FixedProvider(names: ["write_tool"])], for: try context(behavior))
            XCTAssertTrue(tools.isEmpty, "\(behavior) stays read-only by construction")
        }
    }

    func testTheLaneProvidersStartEmpty() async throws {
        // Lane B's provider has landed; RunChecksToolTests covers what it offers.
        let lanes: [any CodeToolProvider] = [
            GoalToolProvider(), ScreenToolProvider(),
            ShipToolProvider(), ExtensionToolProvider(),
        ]
        let tools = await ToolRegistry.providedTools(by: lanes, for: try context(.code))
        XCTAssertTrue(tools.isEmpty, "the seams commit adds no tool, so the tool list is unchanged")
    }
}
