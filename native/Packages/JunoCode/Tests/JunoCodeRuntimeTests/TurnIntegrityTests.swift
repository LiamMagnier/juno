import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// A tool that holds its wave open until released, so a test can act while a
/// batch is mid-flight.
private struct GatedTool: CodeTool {
    let gate: ScriptedModelGate
    let name = "gated_step"
    let description = "Waits for the test."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Gated step" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        await gate.arriveAndWait()
        return ToolResult(content: "gated step finished")
    }
}

final class TurnIntegrityTests: XCTestCase {
    // MARK: - The repair pass

    func testRepairAnswersOrphanedCallsBeforeTheNextUserTurn() {
        let broken: [ModelMessage] = [
            .user("Fix the build"),
            .assistant("Reading two files."),
            .toolCall(id: "a", name: "read_file", input: ["path": "a.swift"]),
            .toolCall(id: "b", name: "read_file", input: ["path": "b.swift"]),
            .toolResult(id: "a", content: "a", isError: false),
            .user("Actually, stop."),
        ]
        let repaired = ConversationIntegrity.repaired(broken)

        XCTAssertEqual(repaired.count, 7)
        XCTAssertEqual(repaired[4], .toolResult(id: "a", content: "a", isError: false))
        XCTAssertEqual(
            repaired[5],
            .toolResult(id: "b", content: ConversationIntegrity.notExecutedMessage, isError: true)
        )
        XCTAssertEqual(repaired[6], .user("Actually, stop."))
        XCTAssertTrue(ConversationIntegrity.isValid(repaired))
    }

    func testRepairMovesUserTextWedgedBetweenCallsAndResults() {
        let wedged: [ModelMessage] = [
            .user("Go"),
            .toolCall(id: "a", name: "grep", input: [:]),
            .user("steer"),
            .toolResult(id: "a", content: "hit", isError: false),
        ]
        XCTAssertEqual(ConversationIntegrity.repaired(wedged), [
            .user("Go"),
            .toolCall(id: "a", name: "grep", input: [:]),
            .toolResult(id: "a", content: "hit", isError: false),
            .user("steer"),
        ])
    }

    func testRepairDropsResultsThatAnswerNoCall() {
        let stray: [ModelMessage] = [
            .user("Go"),
            .toolResult(id: "ghost", content: "?", isError: false),
            .assistant("Done."),
        ]
        XCTAssertEqual(ConversationIntegrity.repaired(stray), [.user("Go"), .assistant("Done.")])
    }

    func testRepairKeepsInterleavedReasoningInsideOneTurn() {
        let turn: [ModelMessage] = [
            .user("Go"),
            .assistantThinking(text: "first", signature: "s1"),
            .toolCall(id: "a", name: "grep", input: [:]),
            .assistantThinking(text: "second", signature: "s2"),
            .toolCall(id: "b", name: "grep", input: [:]),
            .toolResult(id: "a", content: "1", isError: false),
            .toolResult(id: "b", content: "2", isError: false),
        ]
        XCTAssertEqual(ConversationIntegrity.repaired(turn), turn)
    }

    func testValidHistoryIsUnchanged() {
        let valid: [ModelMessage] = [
            .user("Go"),
            .assistant("Looking."),
            .toolCall(id: "a", name: "grep", input: [:]),
            .toolResult(id: "a", content: "hit", isError: false),
            .assistant("Done."),
            .user("Thanks"),
        ]
        XCTAssertEqual(ConversationIntegrity.repaired(valid), valid)
    }

    // MARK: - The loop

    private var workspaceURL: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-integrity-\(UUID().uuidString)")
        workspaceURL = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        try "hello\n".write(
            to: workspaceURL.appendingPathComponent("notes.txt"),
            atomically: true,
            encoding: .utf8
        )
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Integrity",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: workspaceURL.deletingLastPathComponent())
    }

    private func standardTools() throws -> [any CodeTool] {
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        let checkpoints = CheckpointStore(
            directoryURL: workspaceURL.deletingLastPathComponent().appendingPathComponent("cp"),
            access: access
        )
        let executor = CommandExecutionService(workspaceRootURL: workspaceURL)
        return ToolRegistry.standard(
            files: FileOperationService(access: access, checkpoints: checkpoints),
            index: WorkspaceIndexService(access: access),
            executor: executor,
            git: GitService(executor: executor),
            tests: TestRunnerService(access: access, executor: executor)
        ).allTools
    }

    /// The bug that bricked sessions: a steer applied between two tool waves
    /// put the reader's text between the calls and their results, and the
    /// call that never ran was left with no result at all.
    func testSteerDuringABatchLeavesEveryCallAnsweredBeforeTheSteer() async throws {
        let toolGate = ScriptedModelGate()
        let model = ScriptedModelClient(steps: [
            .toolCalls(
                [
                    ("slow", "gated_step", [:]),
                    ("later", "read_file", ["path": "notes.txt"]),
                ],
                text: "Two steps."
            ),
            .text("Understood, stopping there."),
        ])
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: try standardTools() + [GatedTool(gate: toolGate)]),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: .init(systemPrompt: "sys"),
            modelID: "test-model",
            reasoningEffort: nil
        )

        try await orchestrator.submit(prompt: "Do both")
        await toolGate.waitUntilArrived()
        _ = try await orchestrator.steer(prompt: "Skip the second step.")
        await toolGate.release()
        await orchestrator.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 2)
        let second = model.receivedRequests[1].messages
        XCTAssertTrue(ConversationIntegrity.isValid(second), "\(second)")
        XCTAssertTrue(second.contains(
            .toolResult(id: "later", content: ConversationIntegrity.notExecutedMessage, isError: true)
        ))
        let steerIndex = try XCTUnwrap(second.firstIndex(of: .user("Skip the second step.")))
        let lastResultIndex = try XCTUnwrap(second.lastIndex { $0.toolResultID != nil })
        XCTAssertGreaterThan(steerIndex, lastResultIndex)

        let saved = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(ConversationIntegrity.isValid(saved))
    }

    /// A goal ending mid-batch used to save the unexecuted call unanswered.
    func testGoalPauseMidBatchSavesAValidHistory() async throws {
        _ = try await store.createGoal(sessionID: session.id, objective: "Pause", steps: ["Wait"])
        let model = ScriptedModelClient(steps: [
            .toolCalls(
                [
                    ("pause", "update_goal", ["action": "set_lifecycle", "lifecycle": "paused"]),
                    ("after", "read_file", ["path": "notes.txt"]),
                ],
                text: ""
            ),
        ])
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: try standardTools() + [UpdateGoalTool(store: store)]),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: .init(systemPrompt: "sys"),
            modelID: "test-model",
            reasoningEffort: nil
        )
        try await orchestrator.submit(prompt: "Pause")
        await orchestrator.awaitCompletion()

        let saved = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(ConversationIntegrity.isValid(saved), "\(saved)")
    }

    /// Reasoning comes back where it was, signature intact, so a tool loop
    /// with thinking on continues instead of being rejected.
    func testThinkingBlocksAreReplayedInStreamOrder() async throws {
        let model = ScriptedModelClient(steps: [
            .events([
                .reasoningSummary("Look first."),
                .thinkingBlock(text: "Look first.", signature: "sig-1"),
                .textDelta("Reading."),
                .toolCallRequested(id: "r", name: "read_file", input: ["path": "notes.txt"]),
                .turnCompleted(.toolUse),
            ]),
            .text("It says hello."),
        ])
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: try standardTools()),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: .init(systemPrompt: "sys"),
            modelID: "test-model",
            reasoningEffort: .medium
        )
        try await orchestrator.submit(prompt: "What does notes.txt say?")
        await orchestrator.awaitCompletion()

        let second = model.receivedRequests[1].messages
        let thinking = try XCTUnwrap(second.firstIndex(of: .assistantThinking(text: "Look first.", signature: "sig-1")))
        let text = try XCTUnwrap(second.firstIndex(of: .assistant("Reading.")))
        let call = try XCTUnwrap(second.firstIndex { $0.toolCallID == "r" })
        XCTAssertLessThan(thinking, text)
        XCTAssertLessThan(text, call)
    }
}
