import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// The session's volatile facts ride in `<session_state>` blocks rather than
/// the system prompt, so the prefix every request starts with never changes
/// under the model — and images stay as they were sent until compaction.
final class SessionStateTests: XCTestCase {
    private var baseURL: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        baseURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-session-state-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: baseURL.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "State",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: baseURL)
    }

    // MARK: - The block

    func testABlockNamesEachSectionsFingerprintOnItsFirstLine() throws {
        let goal = SessionStateSection(name: "goal", body: "Objective: ship it")
        let skills = SessionStateSection(name: "skills", body: "No skills are enabled.")
        let text = try XCTUnwrap(SessionState.render([goal, skills]))

        XCTAssertTrue(text.hasPrefix(SessionState.marker))
        XCTAssertTrue(text.contains("<goal>\nObjective: ship it\n</goal>"))
        XCTAssertTrue(text.hasSuffix("</session_state>"))
        XCTAssertEqual(
            SessionState.fingerprints(in: text),
            ["goal": goal.fingerprint, "skills": skills.fingerprint]
        )
        XCTAssertNil(SessionState.render([]))
        XCTAssertNil(SessionState.fingerprints(in: "An ordinary prompt"))
    }

    func testOnlySectionsWhoseFactsChangedAreSentAgain() throws {
        let environment = SessionStateSection(name: "environment", body: "Date: Monday")
        let goal = SessionStateSection(name: "goal", body: "No goal is set.")
        let history: [ModelMessage] = [
            .user("Start"),
            .user(try XCTUnwrap(SessionState.render([environment, goal]))),
            .assistant("Working."),
        ]

        XCTAssertEqual(SessionState.changedSections([environment, goal], since: history), [])
        let newGoal = SessionStateSection(name: "goal", body: "Objective: ship it")
        XCTAssertEqual(SessionState.changedSections([environment, newGoal], since: history), [newGoal])

        // A narrower fingerprint keeps a section quiet while only its
        // incidental text moves.
        let quiet = SessionStateSection(name: "environment", body: "Date: Monday, 10:02", fingerprintSource: "Monday")
        let seen = history + [.user(try XCTUnwrap(SessionState.render([quiet])))]
        let later = SessionStateSection(name: "environment", body: "Date: Monday, 10:07", fingerprintSource: "Monday")
        XCTAssertEqual(SessionState.changedSections([later], since: seen), [])
    }

    func testAStateBlockIsNobodysTurn() throws {
        let block = ModelMessage.user(try XCTUnwrap(SessionState.render([
            SessionStateSection(name: "goal", body: "Objective: x"),
        ])))
        XCTAssertTrue(block.isSessionState)
        XCTAssertFalse(block.isReaderMessage)
        XCTAssertNil(block.userText)
        XCTAssertFalse(ModelMessage.user("Hello").isSessionState)

        // A cut never lands on the block, and it never hides the tool results
        // in front of it from the step that follows.
        let history: [ModelMessage] = [
            .user("Start"),
            .toolCall(id: "a", name: "read_file", input: [:]),
            .toolResult(id: "a", content: "A", isError: false),
            block,
            .assistant("Next step."),
        ]
        XCTAssertFalse(ConversationCompactor.isBoundary(at: 3, in: history))
        XCTAssertTrue(ConversationCompactor.isBoundary(at: 4, in: history))
    }

    // MARK: - In the loop

    /// The acceptance test for the stable prefix: a goal created and advanced
    /// between turns reaches the model, while every request's system prompt
    /// and tool list stay byte for byte the same and each request's history
    /// is the previous one's with more appended.
    func testAGoalUpdateNeverChangesTheSystemPromptOrToolsAndOnlyAppendsToTheHistory() async throws {
        let model = ScriptedModelClient(steps: [
            .toolCalls([
                ("g1", "update_goal", [
                    "action": "create",
                    "objective": "Ship the feature",
                    "steps": ["Build", "Verify"],
                ]),
            ], text: "Setting a goal."),
            .text("Goal set."),
            .toolCalls([
                ("g2", "update_goal", [
                    "action": "set_objective",
                    "objective": "Ship the feature today",
                ]),
            ], text: ""),
            .text("Updated."),
        ])
        let orchestrator = makeOrchestrator(
            model: model,
            registry: ToolRegistry(tools: [UpdateGoalTool(store: store)])
        )

        try await orchestrator.submit(prompt: "Plan the feature")
        await orchestrator.awaitCompletion()
        try await orchestrator.submit(prompt: "Change the deadline")
        await orchestrator.awaitCompletion()

        let requests = model.receivedRequests
        XCTAssertEqual(requests.count, 4)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let firstTools = try encoder.encode(requests[0].tools)
        for request in requests {
            XCTAssertEqual(request.systemPrompt, "You are Juno Code.")
            XCTAssertEqual(try encoder.encode(request.tools), firstTools)
        }
        for (earlier, later) in zip(requests, requests.dropFirst()) {
            XCTAssertEqual(
                Array(later.messages.prefix(earlier.messages.count)),
                earlier.messages,
                "a later request only appends to an earlier one's history"
            )
        }

        let blocks = requests.last!.messages.compactMap { message -> String? in
            guard message.isSessionState, case let .user(text) = message else { return nil }
            return text
        }
        XCTAssertEqual(blocks.count, 3, "no goal, the new goal, then the changed objective")
        XCTAssertTrue(blocks[0].contains("No goal is set."))
        XCTAssertTrue(blocks[1].contains("Objective: Ship the feature\n"))
        XCTAssertTrue(blocks[2].contains("Objective: Ship the feature today"))
        // The block rides after the results the model has not seen yet.
        guard case .toolResult(id: "g1", _, _)? = requests[1].messages.dropLast().last else {
            return XCTFail("the state block follows the call's result")
        }
        XCTAssertTrue(requests[1].messages.last?.isSessionState == true)
        // The persisted history keeps the blocks, so a resumed session
        // replays exactly what was sent.
        let persisted = await store.loadConversation(sessionID: session.id)
        XCTAssertEqual(persisted.filter(\.isSessionState).count, 3)
    }

    func testImagesStayAsSentUntilCompactionRewritesThem() async throws {
        let model = ScriptedModelClient(steps: [
            .toolCalls([("s1", "capture_state_image", [:])], text: ""),
            .text("I can see it."),
            .text("Still here."),
        ])
        let orchestrator = makeOrchestrator(
            model: model,
            registry: ToolRegistry(tools: [StateImageTool()]),
            maximumConversationBytes: 1_024 * 1_024
        )

        try await orchestrator.submit(prompt: "Look at the screen")
        await orchestrator.awaitCompletion()
        try await orchestrator.submit(prompt: "And now?")
        await orchestrator.awaitCompletion()

        let requests = model.receivedRequests
        XCTAssertEqual(requests.count, 3)
        for request in requests.dropFirst() {
            XCTAssertTrue(
                request.messages.contains { !$0.images.isEmpty },
                "the screenshot is sent as it was, turn after turn"
            )
        }
        // The store never holds the bytes.
        let persisted = await store.loadConversation(sessionID: session.id)
        XCTAssertFalse(persisted.contains { !$0.images.isEmpty })

        // A fold is when answered images become text.
        let compaction = await orchestrator.compactNow()
        XCTAssertNotNil(compaction)
        try await orchestrator.submit(prompt: "One more")
        await orchestrator.awaitCompletion()
        let afterFold = try XCTUnwrap(model.receivedRequests.last)
        XCTAssertFalse(afterFold.messages.contains { !$0.images.isEmpty })
    }

    func testPastTheImageBudgetTheOldestAnsweredImagesBecomeTextTogether() {
        func image(_ id: String) -> ModelMessage {
            .toolResultWithImages(
                id: id,
                content: "shot",
                isError: false,
                images: [ModelImage(mediaType: "image/png", data: Data(repeating: 1, count: 10))]
            )
        }
        var history: [ModelMessage] = [.user("Watch")]
        for index in 0..<5 {
            history.append(.toolCall(id: "c\(index)", name: "screenshot", input: [:]))
            history.append(image("c\(index)"))
        }
        XCTAssertNil(ImageRetention.withinBudget(history, maximumImages: 5, maximumBytes: 1_000))

        history.append(.toolCall(id: "c5", name: "screenshot", input: [:]))
        history.append(image("c5"))
        let bounded = try? XCTUnwrap(
            ImageRetention.withinBudget(history, maximumImages: 5, maximumBytes: 1_000)
        )
        let kept = bounded?.filter { !$0.images.isEmpty }.compactMap(\.toolResultID)
        // Down to half the budget in one go, newest kept, and the result the
        // model has not answered yet is never touched.
        XCTAssertEqual(kept, ["c4", "c5"])
    }

    /// The images the history keeps by default travel as base64, a third
    /// larger than their bytes. With the text the byte guard allows they
    /// must leave room inside the 16 MB body the agent proxy accepts
    /// (`MAX_AGENT_BODY_BYTES` in `src/lib/agent-proxy.ts`) for the images a
    /// new step brings; at 12 MB they alone filled it.
    func testTheDefaultImageBudgetFitsTheProxysBodyWithRoomForANewStep() {
        let configuration = AgentOrchestrator.Configuration(systemPrompt: "sys")
        let proxyBodyLimit = 16 * 1_024 * 1_024
        let retainedOnTheWire = configuration.maximumRetainedImageBytes * 4 / 3
        XCTAssertLessThanOrEqual(
            retainedOnTheWire + configuration.maximumConversationBytes,
            proxyBodyLimit - 2 * 1_024 * 1_024
        )
    }

    func testACompactionSummaryReusesTheSessionsOwnPrefixWhereItIsCached() async throws {
        let model = PrefixCachingModelClient(turns: [
            .toolCalls([("r1", "noop_state_tool", [:])], text: "Step one."),
            .text("First done."),
            .text("Second done."),
        ])
        let orchestrator = makeOrchestrator(
            model: model,
            registry: ToolRegistry(tools: [NoopStateTool()]),
            contextWindowTokens: 200_000
        )
        try await orchestrator.submit(prompt: "First task")
        await orchestrator.awaitCompletion()
        try await orchestrator.submit(prompt: "Second task")
        await orchestrator.awaitCompletion()
        let lastTurn = try XCTUnwrap(model.turnRequests.last)

        let event = await orchestrator.compactNow()

        XCTAssertEqual(event?.summarySource, .model)
        let summary = try XCTUnwrap(model.summaryRequests.first)
        XCTAssertEqual(model.summaryRequests.count, 1)
        XCTAssertEqual(summary.systemPrompt, lastTurn.systemPrompt)
        XCTAssertEqual(summary.tools, lastTurn.tools)
        XCTAssertEqual(summary.reasoningEffort, lastTurn.reasoningEffort)
        XCTAssertEqual(
            Array(summary.messages.prefix(lastTurn.messages.count)),
            lastTurn.messages,
            "the summary starts with the prefix the last turn cached"
        )
    }

    func testAContinuationThatIsNotASummaryFallsBackToTheTranscript() async throws {
        let model = PrefixCachingModelClient(
            turns: [.text("Done."), .text("Done again.")],
            continuationReply: "I will keep working instead."
        )
        let orchestrator = makeOrchestrator(
            model: model,
            registry: ToolRegistry(tools: [NoopStateTool()]),
            contextWindowTokens: 200_000
        )
        try await orchestrator.submit(prompt: "First task")
        await orchestrator.awaitCompletion()
        try await orchestrator.submit(prompt: "Second task")
        await orchestrator.awaitCompletion()

        let event = await orchestrator.compactNow()

        XCTAssertEqual(event?.summarySource, .model)
        XCTAssertEqual(model.summaryRequests.count, 2)
        XCTAssertEqual(model.summaryRequests.last?.systemPrompt, CompactionSummarizer.systemPrompt)
        XCTAssertEqual(model.summaryRequests.last?.tools, [])
    }

    // MARK: - Helpers

    private func makeOrchestrator(
        model: any AgentModelClient,
        registry: ToolRegistry,
        maximumConversationBytes: Int = 4 * 1_024 * 1_024,
        contextWindowTokens: Int? = nil
    ) -> AgentOrchestrator {
        let store = self.store!
        let sessionID = session.id
        return AgentOrchestrator(
            sessionID: sessionID,
            model: model,
            registry: registry,
            permissions: PermissionCoordinator(sessionID: sessionID, mode: .fullAccess),
            store: store,
            configuration: AgentOrchestrator.Configuration(
                contextWindowTokens: contextWindowTokens,
                maximumConversationBytes: maximumConversationBytes,
                systemPrompt: "You are Juno Code.",
                sessionState: {
                    let goal = try? await store.goal(for: sessionID)
                    return [
                        SessionStateSection(
                            name: "goal",
                            body: goal.map { "Objective: \($0.objective)\n" } ?? "No goal is set."
                        ),
                    ]
                }
            ),
            modelID: "test-model",
            reasoningEffort: .medium
        )
    }
}

private struct StateImageTool: CodeTool {
    let name = "capture_state_image"
    let description = "Capture a deterministic image."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Capture" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        ToolResult(
            content: "Captured.",
            images: [ModelImage(mediaType: "image/png", data: Data([0x89, 0x50, 0x4E, 0x47]))]
        )
    }
}

private struct NoopStateTool: CodeTool {
    let name = "noop_state_tool"
    let description = "Does nothing."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Nothing" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        ToolResult(content: "ok")
    }
}

/// A provider that caches prompt prefixes: agent turns from a script, summary
/// requests answered — in either shape — by the continuation reply or a
/// well-formed summary.
private final class PrefixCachingModelClient: AgentModelClient, @unchecked Sendable {
    private let turns: ScriptedModelClient
    private let continuationReply: String?
    private let lock = NSLock()
    private var summaries: [ModelTurnRequest] = []

    init(turns: [ScriptedModelClient.Step], continuationReply: String? = nil) {
        self.turns = ScriptedModelClient(steps: turns)
        self.continuationReply = continuationReply
    }

    var turnRequests: [ModelTurnRequest] { turns.receivedRequests }
    var summaryRequests: [ModelTurnRequest] {
        lock.lock(); defer { lock.unlock() }
        return summaries
    }

    func cachesPromptPrefix(for _: String) -> Bool { true }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        let isContinuation: Bool
        if case let .user(text)? = request.messages.last,
           text.hasPrefix("Juno is about to shorten this conversation")
        {
            isContinuation = true
        } else {
            isContinuation = false
        }
        guard isContinuation || request.systemPrompt == CompactionSummarizer.systemPrompt else {
            return turns.streamTurn(request)
        }
        lock.lock()
        summaries.append(request)
        lock.unlock()
        let text = isContinuation && continuationReply != nil
            ? continuationReply!
            : "<summary>\n1. Requests and intent: the tasks.\n</summary>"
        return AsyncThrowingStream { continuation in
            continuation.yield(.usage(inputTokens: 900, outputTokens: nil))
            continuation.yield(.textDelta(text))
            continuation.yield(.usage(inputTokens: nil, outputTokens: 40))
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}
