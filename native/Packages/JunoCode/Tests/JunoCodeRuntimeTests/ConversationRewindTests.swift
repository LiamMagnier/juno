import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// A tool that holds its wave open until released, so a test can steer while
/// a batch is mid-flight.
private struct HeldTool: CodeTool {
    let gate: ScriptedModelGate
    let name = "held_step"
    let description = "Waits for the test."
    let inputSchema: JSONValue = ["type": "object", "properties": [:]]

    func assessRisk(input: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Held step" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        await gate.arriveAndWait()
        return ToolResult(content: "held step finished")
    }
}

/// Records which turns the orchestrator opened, in order.
private actor TurnRecorder: TurnCheckpointing {
    private(set) var opened: [String] = []

    func openTurn(id: String, sessionID: CodeSessionID, openedAt: Date) async {
        opened.append(id)
    }

    func capturePreImage(of path: WorkspacePath, sessionID: CodeSessionID) async {}
    func recordAgentWrite(to path: WorkspacePath, sessionID: CodeSessionID) async {}
}

final class ConversationRewindTests: XCTestCase {
    private var baseURL: URL!
    private var workspaceURL: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        baseURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-rewind-\(UUID().uuidString)")
        workspaceURL = baseURL.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        try "hello\n".write(
            to: workspaceURL.appendingPathComponent("notes.txt"),
            atomically: true,
            encoding: .utf8
        )
        store = CodeSessionStore(directoryURL: baseURL.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Rewind",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: baseURL)
    }

    private func orchestrator(
        _ model: ScriptedModelClient,
        tools: [any CodeTool] = [],
        turns: (any TurnCheckpointing)? = nil
    ) -> AgentOrchestrator {
        AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: tools),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: .init(systemPrompt: "sys"),
            modelID: "test-model",
            reasoningEffort: nil,
            turnCheckpoints: turns
        )
    }

    private func recordedTurns() async -> [ConversationTurn] {
        ConversationRewind.turns(in: await store.events(for: session.id))
    }

    private func standardTools(files: any FileOperating) throws -> [any CodeTool] {
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        let executor = CommandExecutionService(workspaceRootURL: workspaceURL)
        return ToolRegistry.standard(
            files: files,
            index: WorkspaceIndexService(access: access),
            executor: executor,
            git: GitService(executor: executor),
            tests: TestRunnerService(access: access, executor: executor)
        ).allTools
    }

    // MARK: - Recording the rewind point

    func testEveryTurnRecordsWhereItsMessageLanded() async throws {
        let agent = orchestrator(ScriptedModelClient(steps: [.text("One."), .text("Two.")]))
        try await agent.submit(prompt: "First")
        await agent.awaitCompletion()
        try await agent.submit(prompt: "Second", modelPrompt: "Second\n\nBEGIN EXPLICIT FILE CONTEXT")
        await agent.awaitCompletion()

        let turns = ConversationRewind.turns(in: await store.events(for: session.id))
        let conversation = await store.loadConversation(sessionID: session.id)
        XCTAssertEqual(turns.map(\.text), ["First", "Second"])
        XCTAssertEqual(turns.map(\.conversationIndex), [0, 2])
        XCTAssertEqual(conversation[2], .user("Second\n\nBEGIN EXPLICIT FILE CONTEXT"))
    }

    func testTheOrchestratorOpensATurnForEachPromptAndAppliedInstruction() async throws {
        let gate = ScriptedModelGate()
        let recorder = TurnRecorder()
        let agent = orchestrator(
            ScriptedModelClient(steps: [
                .toolCalls([("held", "held_step", [:])], text: "Working."),
                .text("Understood."),
            ]),
            tools: [HeldTool(gate: gate)],
            turns: recorder
        )

        try await agent.submit(prompt: "Do the work")
        await gate.waitUntilArrived()
        _ = try await agent.steer(prompt: "Stop after this step.")
        await gate.release()
        await agent.awaitCompletion()

        let turns = ConversationRewind.turns(in: await store.events(for: session.id))
        let opened = await recorder.opened
        XCTAssertEqual(turns.map(\.kind), [.prompt, .steer])
        XCTAssertEqual(opened, turns.map(\.id), "each turn is named by the row the reader sees")
    }

    // MARK: - Rewinding

    func testRewindingToALaterPromptCutsBothRecordsJustBeforeIt() async throws {
        let agent = orchestrator(
            ScriptedModelClient(steps: [
                .toolCalls([("read", "read_file", ["path": "notes.txt"])], text: "Reading."),
                .text("It says hello."),
                .text("A summary."),
            ]),
            tools: try standardTools(files: plainFiles())
        )
        try await agent.submit(prompt: "What does notes.txt say?")
        await agent.awaitCompletion()
        try await agent.submit(prompt: "Summarise it")
        await agent.awaitCompletion()
        let before = await store.loadConversation(sessionID: session.id)
        let turnsSoFar = await recordedTurns()
        let second = try XCTUnwrap(turnsSoFar.last)
        let index = try XCTUnwrap(second.conversationIndex)

        let plan = try await store.rewindConversation(
            sessionID: session.id,
            to: second.id
        )

        let after = await store.loadConversation(sessionID: session.id)
        XCTAssertEqual(after, Array(before[..<index]))
        XCTAssertTrue(ConversationIntegrity.isValid(after), "\(after)")
        XCTAssertEqual(plan.turn.text, "Summarise it")
        let events = await store.events(for: session.id)
        XCTAssertEqual(events.map(\.sequence), Array(0..<events.count), "renumbered without gaps")
        XCTAssertEqual(ConversationRewind.turns(in: events).map(\.text), ["What does notes.txt say?"])
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)

        // The next turn continues from the cut, in a runtime that reloads it.
        let resumedModel = ScriptedModelClient(steps: [.text("Listed.")])
        let resumed = orchestrator(resumedModel)
        try await resumed.submit(prompt: "List the files instead")
        await resumed.awaitCompletion()
        XCTAssertEqual(resumedModel.receivedRequests.first?.messages, after + [.user("List the files instead")])
        let appended = await store.events(for: session.id)
        XCTAssertEqual(appended.map(\.sequence), Array(0..<appended.count))
    }

    func testRewindingToASteerKeepsAValidHistoryAndDoesNotDeliverItAgain() async throws {
        let gate = ScriptedModelGate()
        let agent = orchestrator(
            ScriptedModelClient(steps: [
                .toolCalls([("held", "held_step", [:])], text: "Working."),
                .text("Understood."),
            ]),
            tools: [HeldTool(gate: gate)]
        )
        try await agent.submit(prompt: "Do the work")
        await gate.waitUntilArrived()
        _ = try await agent.steer(prompt: "Stop after this step.")
        await gate.release()
        await agent.awaitCompletion()
        let turnsSoFar = await recordedTurns()
        let steer = try XCTUnwrap(turnsSoFar.last)

        let plan = try await store.rewindConversation(
            sessionID: session.id,
            to: steer.id
        )

        let after = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(ConversationIntegrity.isValid(after), "\(after)")
        XCTAssertEqual(after.last, .toolResult(id: "held", content: "held step finished", isError: false))
        XCTAssertEqual(plan.status, .cancelled, "a run cut at a steer did not finish")
        let events = await store.events(for: session.id)
        XCTAssertFalse(events.contains {
            if case .userInstruction = $0.payload { return true }
            return false
        }, "the steer's row goes with its turn")
        guard case .statusChanged(StatusChangedEvent(status: .cancelled)) = events.last?.payload else {
            return XCTFail("a transcript cut mid-run must end the run, not leave it running")
        }

        let resumedModel = ScriptedModelClient(steps: [.text("Trying another way.")])
        let resumed = orchestrator(resumedModel)
        try await resumed.submit(prompt: "Do it differently")
        await resumed.awaitCompletion()
        let sent = try XCTUnwrap(resumedModel.receivedRequests.first?.messages)
        XCTAssertFalse(sent.contains(.user("Stop after this step.")), "a rewound steer is not re-delivered")
        XCTAssertTrue(ConversationIntegrity.isValid(sent))
    }

    func testARewoundSessionReadsBackTheSameAfterARelaunch() async throws {
        let agent = orchestrator(ScriptedModelClient(steps: [.text("One."), .text("Two.")]))
        try await agent.submit(prompt: "First")
        await agent.awaitCompletion()
        try await agent.submit(prompt: "Second")
        await agent.awaitCompletion()
        let turnsSoFar = await recordedTurns()
        let second = try XCTUnwrap(turnsSoFar.last)
        try await store.rewindConversation(sessionID: session.id, to: second.id)
        let events = await store.events(for: session.id)
        let conversation = await store.loadConversation(sessionID: session.id)

        let relaunched = CodeSessionStore(directoryURL: baseURL.appendingPathComponent("store"))

        let reloadedEvents = await relaunched.events(for: session.id)
        let reloadedConversation = await relaunched.loadConversation(sessionID: session.id)
        XCTAssertEqual(reloadedEvents, events)
        XCTAssertEqual(reloadedConversation, conversation)
        let status = try await relaunched.session(id: session.id).status
        XCTAssertEqual(status, .completed)
        // New events continue the renumbered sequence rather than colliding
        // with it.
        let next = try await relaunched.appendEvent(
            sessionID: session.id,
            payload: .assistantMessage(AssistantMessageEvent(text: "after"))
        )
        XCTAssertEqual(next.sequence, events.count)
    }

    func testRewindingTheFirstPromptLeavesAnEmptyConversation() async throws {
        let agent = orchestrator(ScriptedModelClient(steps: [.text("One.")]))
        try await agent.submit(prompt: "First")
        await agent.awaitCompletion()
        let turnsSoFar = await recordedTurns()
        let first = try XCTUnwrap(turnsSoFar.first)

        let plan = try await store.rewindConversation(sessionID: session.id, to: first.id)

        let conversation = await store.loadConversation(sessionID: session.id)
        XCTAssertEqual(conversation, [])
        XCTAssertEqual(plan.status, .idle)
        let events = await store.events(for: session.id)
        XCTAssertEqual(events.count, 1)
        guard case .sessionCreated = events.first?.payload else {
            return XCTFail("only the session's creation is left")
        }
    }

    func testAGoalTheRewoundTurnsCreatedDoesNotOutliveThem() async throws {
        let agent = orchestrator(
            ScriptedModelClient(steps: [
                .text("One."),
                .toolCalls(
                    [("goal", "update_goal", ["action": "create", "objective": "Ship", "steps": ["Build"]])],
                    text: ""
                ),
                .text("Goal set."),
            ]),
            tools: [UpdateGoalTool(store: store)]
        )
        try await agent.submit(prompt: "Hello")
        await agent.awaitCompletion()
        try await agent.submit(prompt: "Set a goal")
        await agent.awaitCompletion()
        let hasGoal = try await store.session(id: session.id).goal != nil
        XCTAssertTrue(hasGoal)
        let turnsSoFar = await recordedTurns()
        let second = try XCTUnwrap(turnsSoFar.last)

        try await store.rewindConversation(sessionID: session.id, to: second.id)

        let goal = try await store.session(id: session.id).goal
        XCTAssertNil(goal)
    }

    // MARK: - The plan, from records alone

    private func event(_ sequence: Int, _ payload: SessionEventPayload, id: String? = nil) -> SessionEvent {
        SessionEvent(
            id: id ?? "event-\(sequence)",
            sessionID: session.id,
            sequence: sequence,
            timestamp: Date(timeIntervalSince1970: TimeInterval(sequence)),
            payload: payload
        )
    }

    func testAnIndexIsCarriedPastACompactionAndAFoldedTurnIsRefused() throws {
        let original: [ModelMessage] = [
            .user("A"), .assistant("a"),
            .user("B"), .assistant("b"),
            .user("C"), .assistant("c"),
        ]
        let compacted = try XCTUnwrap(
            ConversationCompactor.compact(original, maximumBytes: 1, recentTurns: 1, force: true)
        )
        let events = [
            event(0, .userPrompt(UserPromptEvent(text: "A", conversationIndex: 0)), id: "A"),
            event(1, .userPrompt(UserPromptEvent(text: "B", conversationIndex: 2)), id: "B"),
            event(2, .userPrompt(UserPromptEvent(text: "C", conversationIndex: 4)), id: "C"),
            event(3, .compaction(CompactionEvent(
                summary: compacted.summary,
                beforeMessageCount: original.count,
                afterMessageCount: compacted.messages.count
            ))),
        ]

        let toC = try ConversationRewind.plan(
            rewindingTo: "C", events: events, conversation: compacted.messages
        )
        XCTAssertEqual(toC.messages.count, 1, "C's message moved up by the three the summary replaced")
        XCTAssertEqual(toC.messages.first, compacted.messages.first)

        XCTAssertThrowsError(try ConversationRewind.plan(
            rewindingTo: "B", events: events, conversation: compacted.messages
        )) { error in
            XCTAssertEqual(error as? ConversationRewindError, .summarized)
        }

        // The first message is the compaction's anchor, so it can still be cut
        // before: that is rewinding everything.
        let toA = try ConversationRewind.plan(
            rewindingTo: "A", events: events, conversation: compacted.messages
        )
        XCTAssertEqual(toA.messages, [])
    }

    func testTurnsRecordedBeforeRewindExistedAreMatchedByCount() throws {
        let conversation: [ModelMessage] = [.user("A"), .assistant("a"), .user("B"), .assistant("b")]
        let events = [
            event(0, .userPrompt(UserPromptEvent(text: "A")), id: "A"),
            event(1, .assistantMessage(AssistantMessageEvent(text: "a"))),
            event(2, .userPrompt(UserPromptEvent(text: "B")), id: "B"),
            event(3, .assistantMessage(AssistantMessageEvent(text: "b"))),
        ]

        let plan = try ConversationRewind.plan(
            rewindingTo: "B", events: events, conversation: conversation
        )
        XCTAssertEqual(plan.messages, [.user("A"), .assistant("a")])

        XCTAssertThrowsError(try ConversationRewind.plan(
            rewindingTo: "B",
            events: events,
            conversation: Array(conversation.dropFirst(2))
        )) { error in
            XCTAssertEqual(error as? ConversationRewindError, .notRecorded)
        }
    }

    func testAConversationThatDisagreesWithTheTranscriptIsRefused() {
        let events = [
            event(0, .userPrompt(UserPromptEvent(text: "A", conversationIndex: 0)), id: "A"),
            event(1, .userPrompt(UserPromptEvent(text: "B", conversationIndex: 1)), id: "B"),
        ]
        XCTAssertThrowsError(try ConversationRewind.plan(
            rewindingTo: "B",
            events: events,
            conversation: [.user("A"), .assistant("a")]
        )) { error in
            XCTAssertEqual(error as? ConversationRewindError, .outOfSync)
        }
    }

    func testATurnLeavesWithItsContractAndEverythingAfterIt() throws {
        let path = try WorkspacePath("notes.txt")
        let change = FileChangedEvent(path: path, kind: .modified, linesAdded: 1, linesRemoved: 1, checkpointID: "c")
        let events = [
            event(0, .userPrompt(UserPromptEvent(text: "A", conversationIndex: 0)), id: "A"),
            event(1, .statusChanged(StatusChangedEvent(status: .completed))),
            event(2, .turnConfiguration(TurnConfigurationEvent(
                behavior: .code, permissionMode: .fullAccess, modelID: "m", reasoningEffort: nil
            ))),
            event(3, .userPrompt(UserPromptEvent(text: "B", conversationIndex: 2)), id: "B"),
            event(4, .fileChanged(change)),
            event(5, .statusChanged(StatusChangedEvent(status: .completed))),
        ]
        let conversation: [ModelMessage] = [.user("A"), .assistant("a"), .user("B"), .assistant("b")]

        let plan = try ConversationRewind.plan(rewindingTo: "B", events: events, conversation: conversation)

        XCTAssertEqual(plan.events.map(\.id), ["A", "event-1"], "the contract written for B goes with B")
        XCTAssertEqual(plan.status, .completed)
        XCTAssertEqual(plan.messages, [.user("A"), .assistant("a")])
    }

    // MARK: - With the turn store

    func testAnAgentWriteIsSnapshottedUnderThePromptThatCausedIt() async throws {
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        let turns = TurnCheckpointStore(directoryURL: baseURL.appendingPathComponent("turns"), access: access)
        let files = TurnCapturingFileOperations(base: try plainFiles(access: access), turns: turns)
        let agent = orchestrator(
            ScriptedModelClient(steps: [
                .toolCalls(
                    [(
                        "write",
                        "write_file",
                        [
                            "path": "notes.txt",
                            "content": "changed\n",
                            "base_sha256": .string(FileFingerprint(of: "hello\n").sha256),
                        ]
                    )],
                    text: "Editing."
                ),
                .text("Done."),
            ]),
            tools: try standardTools(files: files),
            turns: turns
        )

        try await agent.submit(prompt: "Change notes")
        await agent.awaitCompletion()

        let turnsSoFar = await recordedTurns()
        let prompt = try XCTUnwrap(turnsSoFar.first)
        let recorded = await turns.turns(for: session.id)
        XCTAssertEqual(recorded.map(\.id), [prompt.id])
        XCTAssertEqual(recorded.first?.files.map(\.path.value), ["notes.txt"])

        try await turns.restore(sessionID: session.id, toTurn: prompt.id, force: false)
        XCTAssertEqual(
            try String(contentsOf: workspaceURL.appendingPathComponent("notes.txt"), encoding: .utf8),
            "hello\n"
        )
    }

    private func plainFiles(access: WorkspaceAccess? = nil) throws -> FileOperationService {
        let access = try access ?? WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        return FileOperationService(
            access: access,
            checkpoints: CheckpointStore(directoryURL: baseURL.appendingPathComponent("cp"), access: access)
        )
    }
}
