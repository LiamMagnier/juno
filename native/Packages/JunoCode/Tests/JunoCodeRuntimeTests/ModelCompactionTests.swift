import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// A model that answers summary requests from their own script and agent
/// turns from a ``ScriptedModelClient``, so a test can say what each call
/// returns without counting where the summary falls between turns.
final class CompactingModelClient: AgentModelClient, @unchecked Sendable {
    enum Summary {
        case events([ModelStreamEvent])
        case failure(Error)
        case neverFinishes
        case gated([ModelStreamEvent], gate: ScriptedModelGate)
    }

    let turns: ScriptedModelClient
    private let lock = NSLock()
    private var summaries: [Summary]
    private(set) var summaryRequests: [ModelTurnRequest] = []

    init(turns: [ScriptedModelClient.Step], summaries: [Summary]) {
        self.turns = ScriptedModelClient(steps: turns)
        self.summaries = summaries
    }

    static func summary(_ text: String, input: Int? = 1_200, output: Int? = 180) -> Summary {
        .events([
            .usage(inputTokens: input, outputTokens: nil),
            .textDelta("<summary>\n\(text)\n</summary>"),
            .usage(inputTokens: nil, outputTokens: output),
            .turnCompleted(.endTurn),
        ])
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        guard request.systemPrompt == CompactionSummarizer.systemPrompt else {
            return turns.streamTurn(request)
        }
        lock.lock()
        summaryRequests.append(request)
        let summary = summaries.isEmpty ? Self.summary("Nothing further.") : summaries.removeFirst()
        lock.unlock()
        return AsyncThrowingStream { continuation in
            switch summary {
            case let .events(events):
                events.forEach { continuation.yield($0) }
                continuation.finish()
            case let .failure(error):
                continuation.finish(throwing: error)
            case .neverFinishes:
                continuation.onTermination = { _ in }
            case let .gated(events, gate):
                let producer = Task {
                    await gate.arriveAndWait()
                    guard !Task.isCancelled else { return }
                    events.forEach { continuation.yield($0) }
                    continuation.finish()
                }
                continuation.onTermination = { _ in producer.cancel() }
            }
        }
    }
}

/// Collects what an orchestrator reports through its observers.
private final class ObservedCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [ModelCallUsage] = []
    private var compacting: [Bool] = []

    func record(_ usage: ModelCallUsage) {
        lock.lock(); calls.append(usage); lock.unlock()
    }

    func record(compacting value: Bool) {
        lock.lock(); compacting.append(value); lock.unlock()
    }

    var usage: [ModelCallUsage] {
        lock.lock(); defer { lock.unlock() }
        return calls
    }

    var compactingSignals: [Bool] {
        lock.lock(); defer { lock.unlock() }
        return compacting
    }
}

/// Returns a page of about 650 characters, the size of an ordinary file read.
private struct PageTool: CodeTool {
    let name = "read_file"
    let description = "Returns a page of source."
    let inputSchema: JSONValue = [
        "type": "object",
        "properties": ["path": ["type": "string"]],
        "required": ["path"],
        "additionalProperties": false,
    ]

    func assessRisk(input: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Read a page" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        ToolResult(content: CompactionFixtures.page(input["path"]?.stringValue ?? "page"))
    }
}

final class ModelCompactionTests: XCTestCase {
    private var baseURL: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        baseURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-compaction-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: baseURL.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Compaction",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: baseURL)
    }

    /// A 100-token window by default: a turn that reports 90 tokens makes the
    /// next iteration compact, which is how a real run reaches the threshold.
    private func makeOrchestrator(
        _ model: CompactingModelClient,
        summary: CompactionSummarizer.Limits? = .standard,
        contextWindowTokens: Int = 100,
        maximumConversationBytes: Int = 16_384,
        tools: [any CodeTool] = []
    ) -> AgentOrchestrator {
        AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: tools),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: AgentOrchestrator.Configuration(
                contextWindowTokens: contextWindowTokens,
                maximumConversationBytes: maximumConversationBytes,
                compactionSummary: summary,
                systemPrompt: "You are Juno Code."
            ),
            modelID: "test-model",
            reasoningEffort: .medium
        )
    }

    private func fullTurn(_ text: String) -> ScriptedModelClient.Step {
        .events([.textDelta(text), .usage(inputTokens: 90, outputTokens: 4), .turnCompleted(.endTurn)])
    }

    private func compactions() async -> [CompactionEvent] {
        await store.events(for: session.id).compactMap { event in
            if case let .compaction(value) = event.payload { return value }
            return nil
        }
    }

    private func firstCompaction() async throws -> CompactionEvent {
        let events = await compactions()
        return try XCTUnwrap(events.first, "expected a compaction event")
    }

    private func anchorText(of messages: [ModelMessage]) -> String? {
        if case let .user(text) = messages.first { return text }
        return nil
    }

    /// A persisted history long enough to fold, with tool pairs throughout.
    private func seedHistory() async throws {
        var messages: [ModelMessage] = [.user("Add line numbers to parser errors")]
        for step in 0..<6 {
            messages.append(.assistant("Step \(step)."))
            messages.append(.toolCall(id: "c\(step)", name: "read_file", input: ["path": .string("P\(step).swift")]))
            messages.append(.toolResult(id: "c\(step)", content: "contents \(step)", isError: false))
        }
        messages.append(.user("Keep the old error type public"))
        messages.append(.assistant("Done: ParserError stays public."))
        try await store.saveConversation(sessionID: session.id, messages: messages)
    }

    // MARK: - Automatic compaction

    func testAutomaticCompactionAsksTheSessionModelForTheSummary() async throws {
        let model = CompactingModelClient(
            turns: [fullTurn("First turn finished."), .text("Follow-up answered.")],
            summaries: [CompactingModelClient.summary("**Current work.** The first turn finished.")]
        )
        let orchestrator = makeOrchestrator(model)
        let observed = ObservedCalls()
        await orchestrator.observeCallUsage { observed.record($0) }
        await orchestrator.observeCompaction { observed.record(compacting: $0) }

        try await orchestrator.submit(prompt: "Original request")
        await orchestrator.awaitCompletion()
        try await orchestrator.submit(prompt: "Follow up")
        await orchestrator.awaitCompletion()

        // One summary call, made with the session's own model, between the turns.
        XCTAssertEqual(model.summaryRequests.count, 1)
        XCTAssertEqual(model.summaryRequests.first?.modelID, "test-model")
        XCTAssertEqual(model.turns.receivedRequests.count, 2)

        let followUp = try XCTUnwrap(model.turns.receivedRequests.last)
        let anchor = try XCTUnwrap(anchorText(of:followUp.messages))
        XCTAssertTrue(anchor.hasPrefix("Original request"))
        XCTAssertTrue(anchor.contains("**Current work.** The first turn finished."))
        XCTAssertTrue(followUp.messages.contains(.user("Follow up")))
        XCTAssertTrue(ConversationIntegrity.isValid(followUp.messages))

        let event = try await firstCompaction()
        XCTAssertEqual(event.summarySource, .model)
        XCTAssertFalse(event.requestedByUser)
        XCTAssertNil(event.fallbackReason)
        XCTAssertEqual(event.summary, "**Current work.** The first turn finished.")
        XCTAssertEqual(event.beforeTokens, 90)

        // The summary survives a relaunch.
        let persisted = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(anchorText(of:persisted)?.contains("The first turn finished.") == true)
        XCTAssertTrue(ConversationIntegrity.isValid(persisted))

        XCTAssertEqual(observed.compactingSignals, [true, false])
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
    }

    func testTheSummaryCallCountsTowardTheSessionsUsage() async throws {
        let model = CompactingModelClient(
            turns: [fullTurn("First."), fullTurn("Second.")],
            summaries: [CompactingModelClient.summary("Summary.", input: 1_200, output: 180)]
        )
        let orchestrator = makeOrchestrator(model)
        let observed = ObservedCalls()
        await orchestrator.observeCallUsage { observed.record($0) }

        try await orchestrator.submit(prompt: "One")
        await orchestrator.awaitCompletion()
        try await orchestrator.submit(prompt: "Two")
        await orchestrator.awaitCompletion()

        let totals = await orchestrator.usageTotals
        XCTAssertEqual(totals.requests, 3)
        XCTAssertEqual(totals.inputTokens, 90 + 1_200 + 90)
        XCTAssertEqual(totals.outputTokens, 4 + 180 + 4)
        XCTAssertEqual(observed.usage.map(\.purpose), [.turn, .compactionSummary, .turn])
        XCTAssertEqual(observed.usage[1].inputTokens, 1_200)

        let event = try await firstCompaction()
        XCTAssertEqual(event.summaryInputTokens, 1_200)
        XCTAssertEqual(event.summaryOutputTokens, 180)
    }

    func testAFailedSummaryFallsBackAndTheRunStillCompletes() async throws {
        let model = CompactingModelClient(
            turns: [fullTurn("First turn finished."), .text("Follow-up answered.")],
            summaries: [.failure(AgentModelClientError.transport(message: "503 overloaded"))]
        )
        let orchestrator = makeOrchestrator(model)

        try await orchestrator.submit(prompt: "Original request")
        await orchestrator.awaitCompletion()
        try await orchestrator.submit(prompt: "Follow up")
        await orchestrator.awaitCompletion()

        let followUp = try XCTUnwrap(model.turns.receivedRequests.last)
        let anchor = try XCTUnwrap(anchorText(of:followUp.messages))
        XCTAssertTrue(anchor.contains(ConversationCompactor.structuralHeader))
        XCTAssertTrue(anchor.contains("First turn finished."))
        XCTAssertTrue(ConversationIntegrity.isValid(followUp.messages))

        let event = try await firstCompaction()
        XCTAssertEqual(event.summarySource, .structural)
        XCTAssertEqual(event.fallbackReason, "the model call failed")
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
    }

    func testAHungSummaryTimesOutAndTheRunCarriesOn() async throws {
        let model = CompactingModelClient(
            turns: [fullTurn("First turn finished."), .text("Follow-up answered.")],
            summaries: [.neverFinishes]
        )
        var limits = CompactionSummarizer.Limits.standard
        limits.timeout = .milliseconds(150)
        let orchestrator = makeOrchestrator(model, summary: limits)

        try await orchestrator.submit(prompt: "Original request")
        await orchestrator.awaitCompletion()
        let started = ContinuousClock.now
        try await orchestrator.submit(prompt: "Follow up")
        await orchestrator.awaitCompletion()

        XCTAssertLessThan(ContinuousClock.now - started, .seconds(10))
        let event = try await firstCompaction()
        XCTAssertEqual(event.summarySource, .structural)
        XCTAssertEqual(event.fallbackReason, "the model took too long")
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
    }

    func testAnEmptySummaryFallsBack() async throws {
        let model = CompactingModelClient(
            turns: [fullTurn("First turn finished."), .text("Follow-up answered.")],
            summaries: [.events([.textDelta(""), .turnCompleted(.endTurn)])]
        )
        let orchestrator = makeOrchestrator(model)

        try await orchestrator.submit(prompt: "Original request")
        await orchestrator.awaitCompletion()
        try await orchestrator.submit(prompt: "Follow up")
        await orchestrator.awaitCompletion()

        let event = try await firstCompaction()
        XCTAssertEqual(event.summarySource, .structural)
        XCTAssertEqual(event.fallbackReason, "the model did not return a summary")
    }

    func testWithTheModelSummaryOffNoSummaryCallIsMade() async throws {
        let model = CompactingModelClient(
            turns: [fullTurn("First turn finished."), .text("Follow-up answered.")],
            summaries: []
        )
        let orchestrator = makeOrchestrator(model, summary: nil)

        try await orchestrator.submit(prompt: "Original request")
        await orchestrator.awaitCompletion()
        try await orchestrator.submit(prompt: "Follow up")
        await orchestrator.awaitCompletion()

        XCTAssertTrue(model.summaryRequests.isEmpty)
        let event = try await firstCompaction()
        XCTAssertEqual(event.summarySource, .structural)
        XCTAssertNil(event.fallbackReason)
    }

    /// A window that refills within a turn is not worth a summary call per
    /// turn: the compaction right after one writes notes instead.
    func testACompactionRightAfterAnotherDoesNotCallTheModelAgain() async throws {
        let model = CompactingModelClient(
            turns: [fullTurn("One done."), fullTurn("Two done."), fullTurn("Three done.")],
            summaries: [CompactingModelClient.summary("First summary.")]
        )
        let orchestrator = makeOrchestrator(model)

        for prompt in ["One", "Two", "Three"] {
            try await orchestrator.submit(prompt: prompt)
            await orchestrator.awaitCompletion()
        }

        let events = await compactions()
        XCTAssertEqual(events.map(\.summarySource), [.model, .structural])
        XCTAssertEqual(model.summaryRequests.count, 1)
        XCTAssertNil(events.last?.fallbackReason)
        // The notes fold the model's summary in rather than losing it.
        XCTAssertTrue(events.last?.summary.contains(
            ConversationCompactor.modelSummaryHeader + "\nFirst summary.\n\n" + ConversationCompactor.notesSinceSummaryHeader
        ) == true)
    }

    /// The guard path at real sizes. The model writes a summary of about ten
    /// thousand characters; one step later the window is full again, so the
    /// next compaction writes notes without asking the model — over a step
    /// of twenty parallel reads, more notes than their budget holds. The
    /// summary must come through whole: it is the only record of the
    /// request's first half.
    func testNotesRightAfterAModelSummaryCarryItWhole() async throws {
        let summary = CompactionFixtures.realisticSummary
        func read(_ id: String) -> (id: String, name: String, input: JSONValue) {
            (id: id, name: "read_file", input: ["path": .string("Sources/Parser/\(id).swift")])
        }
        let full: [ModelStreamEvent] = [.usage(inputTokens: 45_000, outputTokens: 20)]
        let model = CompactingModelClient(
            turns: [
                // The first request: six steps, the third a batch of twenty reads.
                .toolCalls([read("s1")], text: "Reading the lexer."),
                .toolCalls([read("s2")], text: "Reading the parser."),
                .toolCalls((0..<20).map { read("batch\($0)") }, text: "Reading every token source."),
                .toolCalls([read("s4")], text: "Reading the errors."),
                .toolCalls([read("s5")], text: "Reading the tests."),
                .toolCalls([read("s6")], text: "Reading the fixtures."),
                .events([.textDelta("Read everything.")] + full + [.turnCompleted(.endTurn)]),
                // The second: one step that fills the window again, then done.
                .events([.toolCallRequested(id: "t1", name: "read_file", input: ["path": .string("Sources/Parser/t1.swift")])]
                    + full + [.turnCompleted(.toolUse)]),
                .text("ParserError stays public."),
            ],
            summaries: [CompactingModelClient.summary(summary)]
        )
        let orchestrator = makeOrchestrator(
            model,
            contextWindowTokens: 50_000,
            maximumConversationBytes: 4 * 1_024 * 1_024,
            tools: [PageTool()]
        )

        try await orchestrator.submit(prompt: "Add line numbers to parser errors")
        await orchestrator.awaitCompletion()
        try await orchestrator.submit(prompt: "Keep the old error type public")
        await orchestrator.awaitCompletion()

        let events = await compactions()
        XCTAssertEqual(events.map(\.summarySource), [.model, .structural])
        XCTAssertEqual(model.summaryRequests.count, 1, "the second compaction is the guard's, not a failure")
        let notes = try XCTUnwrap(events.last)
        XCTAssertNil(notes.fallbackReason)
        XCTAssertEqual(ConversationCompactor.carriedMemory(from: notes.summary).summary, summary)
        XCTAssertTrue(notes.summary.contains("older notes dropped"), "the batch overflowed the notes' budget")
        XCTAssertTrue(notes.summary.contains("batch19"), "the newest notes are kept")

        // What the model is sent next holds the whole summary.
        let last = try XCTUnwrap(model.turns.receivedRequests.last)
        XCTAssertTrue(anchorText(of: last.messages)?.contains(summary) == true)
        XCTAssertTrue(ConversationIntegrity.isValid(last.messages))
        let persisted = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(anchorText(of: persisted)?.contains(summary) == true)
        XCTAssertTrue(ConversationIntegrity.isValid(persisted))
    }

    /// The failure path at real sizes: a history the model already
    /// summarised, twenty large steps since, and a summary call that fails.
    /// The notes carry the earlier summary whole, and the next summary the
    /// model writes starts from all of it rather than from nothing.
    func testAFailedSummaryAfterAModelSummaryCarriesItWhole() async throws {
        let summary = CompactionFixtures.realisticSummary
        var original: [ModelMessage] = [.user("Add line numbers to parser errors")]
        original += CompactionFixtures.largeSteps(3)
        original.append(.user("Keep the old error type public"))
        let first = try XCTUnwrap(ConversationCompactor.plan(original, maximumBytes: 1, recentTurns: 1, force: true))
        let history = first.result(modelSummary: summary).messages
            + CompactionFixtures.largeSteps(20, from: 100)
            + [.assistant("Read all of them.")]
        try await store.saveConversation(sessionID: session.id, messages: history)
        let model = CompactingModelClient(
            turns: [.text("Noted.")],
            summaries: [
                .failure(AgentModelClientError.transport(message: "503 overloaded")),
                CompactingModelClient.summary("Folded again."),
            ]
        )
        // A window large enough that nothing but `/compact` folds.
        let orchestrator = makeOrchestrator(
            model,
            contextWindowTokens: 200_000,
            maximumConversationBytes: 400_000
        )

        let failedEvent = await orchestrator.compactNow()
        let failed = try XCTUnwrap(failedEvent)

        XCTAssertEqual(failed.summarySource, .structural)
        XCTAssertEqual(failed.fallbackReason, "the model call failed")
        XCTAssertEqual(ConversationCompactor.carriedMemory(from: failed.summary).summary, summary)
        XCTAssertTrue(failed.summary.contains("older notes dropped"), "the span overflowed the notes' budget")
        let persisted = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(anchorText(of: persisted)?.contains(summary) == true)
        XCTAssertTrue(ConversationIntegrity.isValid(persisted))

        try await orchestrator.submit(prompt: "Now the error messages")
        await orchestrator.awaitCompletion()
        let foldedEvent = await orchestrator.compactNow()
        let folded = try XCTUnwrap(foldedEvent)

        XCTAssertEqual(folded.summarySource, .model)
        guard model.summaryRequests.count == 2, case let .user(prompt) = model.summaryRequests[1].messages.first else {
            return XCTFail("expected a second summary request")
        }
        XCTAssertTrue(prompt.contains("<earlier-summary>"))
        XCTAssertTrue(prompt.contains(CompactionSummarizer.escaped(summary)))
    }

    // MARK: - /compact

    func testCompactNowPassesTheFocusAndKeepsTheHistoryValid() async throws {
        try await seedHistory()
        let model = CompactingModelClient(
            turns: [],
            summaries: [CompactingModelClient.summary("Kept: ParserError stays public.")]
        )
        let orchestrator = makeOrchestrator(model)

        let compacted = await orchestrator.compactNow(focus: "  the public error type  ")
        let event = try XCTUnwrap(compacted)

        XCTAssertTrue(event.requestedByUser)
        XCTAssertEqual(event.summarySource, .model)
        XCTAssertEqual(event.focus, "the public error type")
        guard case let .user(prompt) = model.summaryRequests.first?.messages.first else {
            return XCTFail("expected a summary request")
        }
        XCTAssertTrue(prompt.contains("the public error type"))
        XCTAssertTrue(prompt.contains("<tool-call name=\"read_file\">"))

        let persisted = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(ConversationIntegrity.isValid(persisted))
        XCTAssertTrue(anchorText(of:persisted)?.hasPrefix("Add line numbers to parser errors") == true)
        XCTAssertTrue(anchorText(of:persisted)?.contains("Kept: ParserError stays public.") == true)
        XCTAssertLessThan(persisted.count, 21)
        // Whatever was kept verbatim kept each call beside its result.
        let calls = Set(persisted.compactMap(\.toolCallID))
        for result in persisted.compactMap(\.toolResultID) {
            XCTAssertTrue(calls.contains(result))
        }
    }

    func testCompactNowFallsBackWhenTheModelRefuses() async throws {
        try await seedHistory()
        let model = CompactingModelClient(
            turns: [],
            summaries: [.events([.textDelta("I can't help with that."), .turnCompleted(.endTurn)])]
        )
        let orchestrator = makeOrchestrator(model)

        let compacted = await orchestrator.compactNow()
        let event = try XCTUnwrap(compacted)

        XCTAssertEqual(event.summarySource, .structural)
        XCTAssertEqual(event.fallbackReason, "the model did not return a summary")
        let persisted = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(anchorText(of:persisted)?.contains(ConversationCompactor.structuralHeader) == true)
        XCTAssertTrue(ConversationIntegrity.isValid(persisted))
    }

    /// A prompt sent while `/compact` waits on the model joins the history
    /// after the fold, not before it — otherwise the fold would drop it.
    func testAPromptSentDuringCompactNowWaitsForTheFold() async throws {
        try await seedHistory()
        let gate = ScriptedModelGate()
        let model = CompactingModelClient(
            turns: [.text("Answered after the fold.")],
            summaries: [.gated(
                [.textDelta("<summary>Folded.</summary>"), .turnCompleted(.endTurn)],
                gate: gate
            )]
        )
        let orchestrator = makeOrchestrator(model)

        let compaction = Task { await orchestrator.compactNow() }
        await gate.waitUntilArrived()
        let isCompacting = await orchestrator.isCompacting
        XCTAssertTrue(isCompacting)
        let submission = Task { try await orchestrator.submit(prompt: "Next request") }
        try await Task.sleep(for: .milliseconds(100))
        let startedEarly = await orchestrator.isRunning
        XCTAssertFalse(startedEarly, "the prompt must wait for the fold")

        await gate.release()
        let event = await compaction.value
        try await submission.value
        await orchestrator.awaitCompletion()

        XCTAssertEqual(event?.summarySource, .model)
        let request = try XCTUnwrap(model.turns.receivedRequests.first)
        XCTAssertTrue(anchorText(of:request.messages)?.contains("Folded.") == true)
        XCTAssertEqual(request.messages.last, .user("Next request"))
        XCTAssertEqual(request.messages.filter { $0 == .user("Next request") }.count, 1)
    }

    func testStopDuringCompactNowKeepsTheStructuralSummary() async throws {
        try await seedHistory()
        let gate = ScriptedModelGate()
        let model = CompactingModelClient(
            turns: [],
            summaries: [.gated([.turnCompleted(.endTurn)], gate: gate)]
        )
        let orchestrator = makeOrchestrator(model)

        let compaction = Task { await orchestrator.compactNow(focus: "anything") }
        await gate.waitUntilArrived()
        await orchestrator.stop()
        let event = await compaction.value

        XCTAssertEqual(event?.summarySource, .structural)
        XCTAssertEqual(event?.fallbackReason, "it was stopped")
        let isCompacting = await orchestrator.isCompacting
        XCTAssertFalse(isCompacting)
        let persisted = await store.loadConversation(sessionID: session.id)
        XCTAssertTrue(ConversationIntegrity.isValid(persisted))
    }
}
