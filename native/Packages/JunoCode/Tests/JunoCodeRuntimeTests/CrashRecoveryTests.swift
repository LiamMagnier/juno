import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// A tool batch is saved before it runs, and a restore tells the model what
/// became of each call the app stopped in the middle of: finished, outcome
/// unknown, or never run.
final class CrashRecoveryTests: XCTestCase {
    private var storeURL: URL!

    override func setUp() {
        storeURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-crash-recovery-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: storeURL)
    }

    func testTheTranscriptDecidesWhatEachUnansweredCallIsTold() {
        let sessionID = CodeSessionID()
        func event(_ payload: SessionEventPayload, _ sequence: Int) -> SessionEvent {
            SessionEvent(sessionID: sessionID, sequence: sequence, timestamp: Date(), payload: payload)
        }
        let events = [
            event(.toolProposed(ToolProposedEvent(toolCallID: "a", toolName: "t", input: [:], risk: .read, summary: "a")), 1),
            event(.toolProposed(ToolProposedEvent(toolCallID: "b", toolName: "t", input: [:], risk: .read, summary: "b")), 2),
            event(.toolProposed(ToolProposedEvent(toolCallID: "c", toolName: "t", input: [:], risk: .read, summary: "c")), 3),
            event(.toolProposed(ToolProposedEvent(toolCallID: "d", toolName: "t", input: [:], risk: .read, summary: "d")), 4),
            event(.toolStarted(ToolStartedEvent(toolCallID: "a")), 5),
            event(.toolCompleted(ToolCompletedEvent(toolCallID: "a", status: .succeeded, resultSummary: "wrote 3 files", durationSeconds: 1)), 6),
            event(.toolStarted(ToolStartedEvent(toolCallID: "b")), 7),
            event(.toolCompleted(ToolCompletedEvent(toolCallID: "d", status: .denied, resultSummary: "The user declined this action.", durationSeconds: 0)), 8),
        ]
        let states = ConversationIntegrity.interruptedCalls(in: events)
        XCTAssertEqual(states["a"], .finished(succeeded: true, summary: "wrote 3 files"))
        XCTAssertEqual(states["b"], .started)
        XCTAssertNil(states["c"])
        XCTAssertEqual(states["d"], .notRun(summary: "The user declined this action."))

        let history: [ModelMessage] = [
            .user("Go"),
            .toolCall(id: "a", name: "t", input: [:]),
            .toolCall(id: "b", name: "t", input: [:]),
            .toolCall(id: "c", name: "t", input: [:]),
            .toolCall(id: "d", name: "t", input: [:]),
        ]
        let repaired = ConversationIntegrity.repaired(history, interrupted: states)
        XCTAssertTrue(ConversationIntegrity.isValid(repaired))
        let results = Dictionary(uniqueKeysWithValues: repaired.compactMap { message -> (String, (String, Bool))? in
            guard case let .toolResult(id, content, isError) = message else { return nil }
            return (id, (content, isError))
        })
        XCTAssertTrue(results["a"]!.0.contains("stopped before this result was saved"))
        XCTAssertTrue(results["a"]!.0.contains("wrote 3 files"))
        XCTAssertFalse(results["a"]!.1)
        XCTAssertEqual(results["b"]!.0, ConversationIntegrity.outcomeUnknownMessage)
        XCTAssertTrue(results["b"]!.1)
        XCTAssertEqual(results["c"]!.0, ConversationIntegrity.notExecutedMessage)
        XCTAssertEqual(results["d"]!.0, "Not executed: The user declined this action.")
    }

    func testAReusedCallIDStartsOverAtItsNewProposal() {
        let sessionID = CodeSessionID()
        func event(_ payload: SessionEventPayload, _ sequence: Int) -> SessionEvent {
            SessionEvent(sessionID: sessionID, sequence: sequence, timestamp: Date(), payload: payload)
        }
        let states = ConversationIntegrity.interruptedCalls(in: [
            event(.toolProposed(ToolProposedEvent(toolCallID: "c1", toolName: "t", input: [:], risk: .read, summary: "")), 1),
            event(.toolStarted(ToolStartedEvent(toolCallID: "c1")), 2),
            event(.toolCompleted(ToolCompletedEvent(toolCallID: "c1", status: .succeeded, resultSummary: "old", durationSeconds: 0)), 3),
            event(.toolProposed(ToolProposedEvent(toolCallID: "c1", toolName: "t", input: [:], risk: .read, summary: "")), 4),
        ])
        XCTAssertNil(states["c1"], "the later proposal never started")
    }

    /// The acceptance test: the app stops while the second of three calls is
    /// running. The next launch reads the same files; the model is told the
    /// first finished, the second's outcome is unknown, and the third never
    /// ran.
    func testARestoreAfterTheAppStoppedMidBatchTellsTheModelWhatHappened() async throws {
        let storeA = CodeSessionStore(directoryURL: storeURL)
        let session = try await storeA.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Crash",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
        let gate = ScriptedModelGate()
        let first = ScriptedModelClient(steps: [
            .toolCalls([
                ("c1", "quick_tool", [:]),
                ("c2", "blocking_tool", [:]),
                ("c3", "quick_tool", [:]),
            ], text: "Three steps."),
        ])
        let running = orchestrator(session: session.id, store: storeA, model: first, gate: gate)
        try await running.submit(prompt: "Do three things")
        await gate.waitUntilArrived()

        // Everything the turn proposed is on disk before it ran.
        let saved = await storeA.loadConversation(sessionID: session.id)
        XCTAssertEqual(saved.compactMap(\.toolCallID), ["c1", "c2", "c3"])

        // The next launch: a fresh store over the same files.
        let storeB = CodeSessionStore(directoryURL: storeURL)
        let relaunched = try await storeB.session(id: session.id)
        XCTAssertEqual(relaunched.status, .failed, "marked interrupted at launch")
        let next = ScriptedModelClient(steps: [.text("I'll check the workspace first.")])
        let resumed = orchestrator(session: session.id, store: storeB, model: next, gate: ScriptedModelGate())
        try await resumed.submit(prompt: "Carry on")
        await resumed.awaitCompletion()

        let request = try XCTUnwrap(next.receivedRequests.first)
        XCTAssertTrue(ConversationIntegrity.isValid(request.messages))
        var results: [String: String] = [:]
        for case let .toolResult(id, content, _) in request.messages {
            results[id] = content
        }
        XCTAssertTrue(results["c1"]?.contains("The tool finished") == true)
        XCTAssertEqual(results["c2"], ConversationIntegrity.outcomeUnknownMessage)
        XCTAssertEqual(results["c3"], ConversationIntegrity.notExecutedMessage)

        await gate.release()
        await running.stop()
    }

    private func orchestrator(
        session: CodeSessionID,
        store: CodeSessionStore,
        model: ScriptedModelClient,
        gate: ScriptedModelGate
    ) -> AgentOrchestrator {
        AgentOrchestrator(
            sessionID: session,
            model: model,
            registry: ToolRegistry(tools: [QuickTool(), BlockingTool(gate: gate)]),
            permissions: PermissionCoordinator(sessionID: session, mode: .fullAccess),
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "sys"),
            modelID: "test-model",
            reasoningEffort: nil
        )
    }
}

private struct QuickTool: CodeTool {
    let name = "quick_tool"
    let description = "Finishes at once."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Quick" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        ToolResult(content: "done quickly")
    }
}

/// Runs until its gate is released: the call the app stops in the middle of.
private struct BlockingTool: CodeTool {
    let gate: ScriptedModelGate
    let name = "blocking_tool"
    let description = "Blocks."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Block" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        await gate.arriveAndWait()
        return ToolResult(content: "finally")
    }
}
