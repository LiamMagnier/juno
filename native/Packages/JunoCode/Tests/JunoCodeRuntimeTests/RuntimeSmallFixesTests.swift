import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// Approval events in order, provider-safe MCP names, and moves judged by
/// both of their paths.
final class RuntimeSmallFixesTests: XCTestCase {
    private var baseURL: URL!

    override func setUp() {
        baseURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-small-fixes-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: baseURL)
    }

    // MARK: - Approval events

    /// Each request is written before its resolution, however quickly the
    /// reader answers, across many gated calls in a row.
    func testApprovalEventsAreWrittenInTheOrderTheyHappened() async throws {
        let store = CodeSessionStore(directoryURL: baseURL)
        let session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Approvals",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
        let calls = (0..<12).map { index in
            (id: "w\(index)", name: "gated_write", input: JSONValue.object([:]))
        }
        let model = ScriptedModelClient(steps: [.toolCalls(calls, text: ""), .text("All done.")])
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .askBeforeChanges)
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: [GatedWriteTool()]),
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "sys"),
            modelID: "test-model",
            reasoningEffort: nil
        )
        // Approve every request the moment it appears.
        let approver = Task {
            while !Task.isCancelled {
                for request in await permissions.pendingApprovals {
                    await permissions.resolve(approvalID: request.id, decision: .approved)
                }
                await Task.yield()
            }
        }
        try await orchestrator.submit(prompt: "Write twelve times")
        await orchestrator.awaitCompletion()
        approver.cancel()
        // The writer drains after the run.
        for _ in 0..<200 {
            let resolved = await store.events(for: session.id).filter {
                if case .approvalResolved = $0.payload { return true }
                return false
            }
            if resolved.count == calls.count { break }
            try await Task.sleep(for: .milliseconds(5))
        }

        var requested: [String: Int] = [:]
        var resolvedAfterRequest = 0
        for event in await store.events(for: session.id) {
            switch event.payload {
            case let .approvalRequested(request):
                requested[request.id] = event.sequence
            case let .approvalResolved(resolution):
                let requestSequence = try XCTUnwrap(requested[resolution.approvalID], "resolved before requested")
                XCTAssertLessThan(requestSequence, event.sequence)
                resolvedAfterRequest += 1
            default:
                continue
            }
        }
        XCTAssertEqual(resolvedAfterRequest, calls.count)
        let final = try await store.session(id: session.id)
        XCTAssertFalse(final.hasPendingApproval, "nothing is left marked as waiting")
    }

    // MARK: - MCP names

    func testMCPNamesAreAlwaysWhatProvidersAccept() {
        let accepted = try! NSRegularExpression(pattern: "^[a-zA-Z0-9_-]{1,64}$")
        func name(server: String, tool: String) -> String {
            MCPCodeTool(
                registry: try! MCPToolRegistry(workspaceRootURL: baseURL, configurations: []),
                reference: MCPToolReference(
                    serverID: server,
                    definition: MCPToolDefinition(name: tool, inputSchema: ["type": "object"])
                )
            ).name
        }
        let names = [
            name(server: "notes", tool: "résumé"),
            name(server: "notes", tool: "日本語"),
            name(server: "notes", tool: "中文"),
            name(server: "nötes", tool: "ⅷ"),
            name(server: "notes", tool: String(repeating: "长", count: 80)),
            name(server: "files", tool: "read.file"),
        ]
        for value in names {
            XCTAssertEqual(
                accepted.numberOfMatches(in: value, range: NSRange(value.startIndex..., in: value)),
                1,
                "\(value) must match ^[a-zA-Z0-9_-]{1,64}$"
            )
        }
        XCTAssertNotEqual(names[1], names[2], "two names in another script do not collide")
        XCTAssertEqual(name(server: "search", tool: "search"), "mcp__search__search", "ASCII names are unchanged")
        XCTAssertEqual(names[5], "mcp__files__read_file", "ASCII punctuation still maps without a digest")
    }

    // MARK: - move_file

    func testAMoveOutOfADeniedFolderIsRefused() async {
        let permissions = PermissionCoordinator(sessionID: CodeSessionID(), mode: .fullAccess)
        await permissions.setRules(PermissionRuleSet(deny: [PermissionRule(tool: "Edit", specifier: "secrets/**")]))
        let subject = ToolRuleSubjects.subject(
            toolName: "move_file",
            input: ["from": "secrets/key.pem", "to": "public/key.pem"]
        )
        XCTAssertEqual(subject, .paths(["secrets/key.pem", "public/key.pem"]))
        let outcome = await permissions.authorize(
            toolName: "move_file",
            actionDigest: "digest",
            risk: .write,
            summary: "Move",
            subject: subject
        )
        guard case .denied = outcome else {
            return XCTFail("the source's deny applies, got \(outcome)")
        }
    }
}

/// A write, so every call asks in Ask mode.
private struct GatedWriteTool: CodeTool {
    let name = "gated_write"
    let description = "Writes nothing, but asks first."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input: JSONValue) -> ActionRisk { .write }
    func summary(input: JSONValue) -> String { "Write" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        ToolResult(content: "written")
    }
}
