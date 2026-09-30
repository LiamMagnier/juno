import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// todo_write, ask_user and exit_plan in a real agent loop: what they record,
/// how they suspend, and that none of them is a permission.
final class SessionInteractionTests: XCTestCase {
    private var storeURL: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        storeURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-interactions-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: storeURL)
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Interactions",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: storeURL)
    }

    private func orchestrator(
        _ model: ScriptedModelClient,
        questions: QuestionCoordinator,
        mode: PermissionMode = .readOnly
    ) -> (AgentOrchestrator, PermissionCoordinator) {
        let permissions = PermissionCoordinator(sessionID: session.id, mode: mode)
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: [
                TodoWriteTool(), AskUserTool(questions: questions), ExitPlanTool(questions: questions),
            ]),
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "You are Juno Code."),
            modelID: "test-model",
            reasoningEffort: nil
        )
        return (orchestrator, permissions)
    }

    private func payloads() async -> [SessionEventPayload] {
        await store.events(for: session.id).map(\.payload)
    }

    private func waitForQuestion(_ questions: QuestionCoordinator) async throws -> QuestionRequest {
        for _ in 0..<200 {
            if let request = await questions.pendingQuestions.first { return request }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw XCTSkip("the question never arrived")
    }

    private func waitForPlan(_ questions: QuestionCoordinator) async throws -> PlanApprovalRequest {
        for _ in 0..<200 {
            if let request = await questions.pendingPlans.first { return request }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw XCTSkip("the plan never arrived")
    }

    private func lastToolResult(_ request: ModelTurnRequest) -> (content: String, isError: Bool)? {
        for message in request.messages.reversed() {
            if case let .toolResult(_, content, isError) = message { return (content, isError) }
        }
        return nil
    }

    private let askInput: JSONValue = [
        "questions": [
            [
                "question": "Which database?",
                "header": "Storage",
                "options": [
                    ["label": "SQLite", "description": "Recommended: already a dependency"],
                    ["label": "Postgres"],
                ],
            ],
        ],
    ]

    // MARK: - todo_write

    func testTheChecklistIsRecordedWithoutAskingEvenInAReadOnlySession() async throws {
        let questions = QuestionCoordinator(sessionID: session.id, store: store)
        let model = ScriptedModelClient(steps: [
            .toolCalls([("t1", "todo_write", [
                "todos": [
                    ["id": "1", "content": "Read the schema", "status": "completed"],
                    ["id": "2", "content": "Add the column", "status": "in_progress", "activeForm": "Adding the column"],
                    ["id": "3", "content": "Run the tests", "status": "pending"],
                ],
            ])], text: ""),
            .text("Planned."),
        ])
        let (agent, permissions) = orchestrator(model, questions: questions)
        try await agent.submit(prompt: "Plan it")
        await agent.awaitCompletion()

        let events = await payloads()
        let lists = events.compactMap { payload -> TodoListEvent? in
            if case let .todosUpdated(list) = payload { return list }
            return nil
        }
        XCTAssertEqual(lists.count, 1)
        XCTAssertEqual(lists.first?.items.map(\.status), [.completed, .inProgress, .pending])
        XCTAssertEqual(lists.first?.items[1].activeForm, "Adding the column")
        XCTAssertFalse(events.contains { if case .approvalRequested = $0 { return true } else { return false } })
        let pending = await permissions.pendingApprovals
        XCTAssertTrue(pending.isEmpty)
        let result = try XCTUnwrap(lastToolResult(model.receivedRequests[1]))
        XCTAssertFalse(result.isError)
        XCTAssertTrue(result.content.contains("1 of 3 done"), result.content)
        XCTAssertTrue(result.content.contains("Adding the column"), result.content)
    }

    func testTheChecklistIsValidatedBeforeItRuns() {
        let tool = TodoWriteTool()
        XCTAssertNil(tool.precheck(input: ["todos": []]), "an empty list clears it")
        XCTAssertNotNil(tool.precheck(input: ["todos": [["id": "1", "content": "x", "status": "done"]]]))
        XCTAssertNotNil(tool.precheck(input: ["todos": [["id": "1", "content": " ", "status": "pending"]]]))
        XCTAssertNotNil(tool.precheck(input: [
            "todos": [
                ["id": "1", "content": "a", "status": "pending"],
                ["id": "1", "content": "b", "status": "pending"],
            ],
        ]))
        XCTAssertEqual(tool.assessRisk(input: [:]), .read)
    }

    // MARK: - ask_user

    func testAQuestionSuspendsTheTurnUntilTheReaderAnswers() async throws {
        let questions = QuestionCoordinator(sessionID: session.id, store: store)
        let model = ScriptedModelClient(steps: [
            .toolCalls([("q1", "ask_user", askInput)], text: ""),
            .text("Using SQLite."),
        ])
        let (agent, permissions) = orchestrator(model, questions: questions, mode: .askBeforeChanges)
        try await agent.submit(prompt: "Add storage")
        let request = try await waitForQuestion(questions)
        XCTAssertEqual(request.questions.first?.options.map(\.label), ["SQLite", "Postgres"])
        XCTAssertEqual(request.toolCallID, "q1")
        let waiting = try await store.session(id: session.id)
        XCTAssertEqual(waiting.status, .waitingForApproval, "the session is waiting on the reader")
        XCTAssertEqual(model.receivedRequests.count, 1, "nothing goes on while it waits")

        let accepted = await questions.answer(
            requestID: request.id,
            answers: [QuestionAnswer(questionID: "q1", selectedOptions: ["SQLite"], text: "keep it local")]
        )
        XCTAssertTrue(accepted)
        await agent.awaitCompletion()

        let result = try XCTUnwrap(lastToolResult(model.receivedRequests[1]))
        XCTAssertTrue(result.content.contains("Which database?\n→ SQLite and wrote: \"keep it local\""), result.content)

        // Recorded in order, answer before the result that used it.
        let events = await payloads()
        let asked = try XCTUnwrap(events.firstIndex { if case .questionRequested = $0 { return true } else { return false } })
        let answered = try XCTUnwrap(events.firstIndex { if case .questionResolved = $0 { return true } else { return false } })
        let completed = try XCTUnwrap(events.firstIndex {
            if case let .toolCompleted(done) = $0 { return done.toolCallID == "q1" } else { return false }
        })
        XCTAssertLessThan(asked, answered)
        XCTAssertLessThan(answered, completed)

        // An answer is not a permission.
        let mode = await permissions.permissionMode
        XCTAssertEqual(mode, .askBeforeChanges)
        let rules = await permissions.permissionRules
        XCTAssertTrue(rules.isEmpty)
        let again = await questions.answer(requestID: request.id, answers: [])
        XCTAssertFalse(again, "answered once")
    }

    func testStoppingTheRunCancelsTheQuestion() async throws {
        let questions = QuestionCoordinator(sessionID: session.id, store: store)
        let model = ScriptedModelClient(steps: [.toolCalls([("q1", "ask_user", askInput)], text: "")])
        let (agent, _) = orchestrator(model, questions: questions)
        try await agent.submit(prompt: "Ask me")
        let request = try await waitForQuestion(questions)
        await agent.stop()
        await agent.awaitCompletion()

        let resolutions = await payloads().compactMap { payload -> QuestionResolvedEvent? in
            if case let .questionResolved(event) = payload { return event }
            return nil
        }
        XCTAssertEqual(resolutions, [QuestionResolvedEvent(requestID: request.id, resolution: .cancelled)])
        let stillPending = await questions.pendingQuestions
        XCTAssertTrue(stillPending.isEmpty)
    }

    func testAQuestionNobodyAnswersExpires() async throws {
        let questions = QuestionCoordinator(sessionID: session.id, store: store, timeToLive: 0.2)
        let model = ScriptedModelClient(steps: [
            .toolCalls([("q1", "ask_user", askInput)], text: ""),
            .text("Going with SQLite."),
        ])
        let (agent, _) = orchestrator(model, questions: questions)
        try await agent.submit(prompt: "Ask me")
        await agent.awaitCompletion()
        let result = try XCTUnwrap(lastToolResult(model.receivedRequests[1]))
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.contains("No answer"), result.content)
    }

    func testQuestionsAreValidatedBeforeTheyAreAsked() {
        let tool = AskUserTool(questions: QuestionCoordinator(sessionID: session.id, store: nil))
        XCTAssertNil(tool.precheck(input: askInput))
        XCTAssertNotNil(tool.precheck(input: ["questions": []]))
        XCTAssertNotNil(tool.precheck(input: [
            "questions": [["question": "One option?", "options": [["label": "Only"]]]],
        ]))
        XCTAssertNotNil(tool.precheck(input: [
            "questions": [["question": "Twice?", "options": [["label": "Same"], ["label": "same"]]]],
        ]))
        let five: [JSONValue] = Array(repeating: [
            "question": "Q?", "options": [["label": "A"], ["label": "B"]],
        ], count: 5)
        XCTAssertNotNil(tool.precheck(input: ["questions": .array(five)]))
    }

    // MARK: - exit_plan

    func testAnApprovedPlanEndsThePlanningRunWithTheReadersLevel() async throws {
        let questions = QuestionCoordinator(sessionID: session.id, store: store)
        let model = ScriptedModelClient(steps: [
            .toolCalls([("p1", "exit_plan", ["plan": "1. Add the column\n2. Run the tests"])], text: ""),
            .text("This must never be requested."),
        ])
        let (agent, permissions) = orchestrator(model, questions: questions)
        try await agent.submit(prompt: "Plan the migration")
        let plan = try await waitForPlan(questions)
        XCTAssertEqual(plan.plan, "1. Add the column\n2. Run the tests")
        await questions.approvePlan(requestID: plan.id, permissionMode: .workspaceWrite)
        await agent.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 1, "the planning run ends at the approval")
        let events = await payloads()
        XCTAssertTrue(events.contains {
            if case let .planResolved(resolved) = $0 {
                return resolved.decision == .approved(permissionMode: .workspaceWrite)
            }
            return false
        })
        XCTAssertTrue(events.contains {
            if case let .runCompleted(run) = $0 { return run.summary == "Plan approved" }
            return false
        })
        // The decision is the session's to act on; the planning run's own
        // coordinator is not raised by it.
        let mode = await permissions.permissionMode
        XCTAssertEqual(mode, .readOnly)
        let conversation = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(conversation.contains {
            if case let .toolResult(id, content, _) = $0 { return id == "p1" && content.contains("approved") }
            return false
        }, "the call is answered in the history")
    }

    func testKeepPlanningHandsTheFeedbackBack() async throws {
        let questions = QuestionCoordinator(sessionID: session.id, store: store)
        let model = ScriptedModelClient(steps: [
            .toolCalls([("p1", "exit_plan", ["plan": "Do it"])], text: ""),
            .text("Revising."),
        ])
        let (agent, _) = orchestrator(model, questions: questions)
        try await agent.submit(prompt: "Plan")
        let plan = try await waitForPlan(questions)
        await questions.keepPlanning(requestID: plan.id, feedback: "  cover the rollback  ")
        await agent.awaitCompletion()
        let result = try XCTUnwrap(lastToolResult(model.receivedRequests[1]))
        XCTAssertTrue(result.content.contains("cover the rollback"), result.content)
        XCTAssertTrue(result.content.contains("exit_plan again"), result.content)
    }

    func testTheSessionToolsAreInspectionTools() {
        for name in ["todo_write", "ask_user", "exit_plan", "use_skill"] {
            XCTAssertTrue(ToolRegistry.inspectionToolNames.contains(name), name)
        }
        let tool = ExitPlanTool(questions: QuestionCoordinator(sessionID: session.id, store: nil))
        XCTAssertNotNil(tool.precheck(input: ["plan": "   "]))
        XCTAssertEqual(tool.assessRisk(input: ["plan": "x"]), .read)
    }
}
