import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// The autonomous loop end to end with a scripted model (CODE_AGENT_SPEC §1,
/// §6.1): open todos, checks the runtime runs itself, failing checks, the soft
/// step limit and Keep going, the output limit, Retry, and runtime notes that
/// never pass for the reader.
final class AutonomousLoopTests: XCTestCase {
    private var base: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-loop-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Loop",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
    }

    private let recipe = GateRecipe(checks: [GateRecipeCheck(id: "swift-test", kind: .test, command: "swift test")])

    private func settings(review: ReviewPolicy = .off, stepLimit: Int = 200) -> AutonomySettings {
        AutonomySettings(reviewBeforeFinish: review, stepLimit: stepLimit)
    }

    private func orchestrator(
        _ model: ScriptedModelClient,
        settings: AutonomySettings? = nil,
        recipe: GateRecipe? = nil,
        permissions: PermissionCoordinator? = nil,
        checkRunner: (any GateCheckRunning)? = nil,
        compactionSummary: CompactionSummarizer.Limits? = nil,
        sessionState: (@Sendable () async -> [SessionStateSection])? = nil,
        retries: Int = 4,
        clock: TestClock? = nil
    ) -> AgentOrchestrator {
        let settings = settings ?? self.settings()
        let recipe = recipe ?? self.recipe
        let permissions = permissions ?? PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let ledger = RunLedgerRecorder(sessionID: session.id, store: store)
        let now: @Sendable () -> Date = { clock?.now ?? Date() }
        let autonomy = AutonomyConfiguration(
            settings: settings,
            ledger: ledger,
            recipe: { recipe },
            checkRunner: checkRunner,
            clock: now
        )
        return AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: [EditStubTool(), CheckStubTool(), DiffStubTool(), NoopStubTool(), TodoWriteTool()]),
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(
                compactionSummary: compactionSummary,
                systemPrompt: "You are Juno Code.",
                sessionState: sessionState,
                retryPolicy: ModelRetryPolicy(maximumRetries: retries),
                retrySleep: { _ in },
                autonomy: autonomy
            ),
            modelID: "test-model",
            reasoningEffort: nil,
            completionGate: AutonomyGate(settings: settings, recipe: { recipe })
        )
    }

    private func payloads() async -> [SessionEventPayload] {
        await store.events(for: session.id).map(\.payload)
    }

    private func continuations() async -> [RunContinuedEvent] {
        await payloads().compactMap {
            if case let .runContinued(event) = $0 { return event }
            return nil
        }
    }

    private func endReasons() async -> [RunEndReason?] {
        await payloads().compactMap {
            if case let .runCompleted(run) = $0 { return run.endReason }
            return nil
        }
    }

    private func userPrompts() async -> Int {
        await payloads().filter { if case .userPrompt = $0 { return true } else { return false } }.count
    }

    // MARK: - Open todos

    func testOpenTodosGetOneFencedContinuationThenTheRunFinishes() async throws {
        let model = ScriptedModelClient(steps: [
            .call("todo_write", ["todos": [
                ["id": "1", "content": "Find the bug", "status": "completed"],
                ["id": "2", "content": "Fix the bug", "status": "in_progress"],
            ]]),
            .text("Done."),
            .call("todo_write", ["todos": [
                ["id": "1", "content": "Find the bug", "status": "completed"],
                ["id": "2", "content": "Fix the bug", "status": "completed"],
            ]]),
            .text("Both are done."),
        ])
        let runtime = orchestrator(model)

        try await runtime.submit(prompt: "Fix the bug")
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 4)
        let note = try XCTUnwrap(lastRuntimeNote(model.receivedRequests[2]))
        XCTAssertTrue(note.hasPrefix("<juno_runtime reason=\"todos_open\""))
        XCTAssertTrue(note.contains("Fix the bug"))
        let recorded = await continuations()
        XCTAssertEqual(recorded.map(\.reason), [.gate(.todosOpen)])
        XCTAssertEqual(recorded.first?.origin, .gate)
        let ended = await endReasons()
        XCTAssertEqual(ended, [.doneUnchecked])
        let prompts = await userPrompts()
        XCTAssertEqual(prompts, 1, "a continuation adds no reader message")
    }

    // MARK: - Checks

    func testAnEditAfterAPassingCheckIsCheckedByTheRuntimeWhenARuleAllowsIt() async throws {
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .askBeforeChanges)
        await permissions.setRules(PermissionRuleSet(allow: [
            PermissionRule(tool: "Bash", specifier: "swift test"),
            PermissionRule(tool: "edit_stub"),
        ]))
        let allowed = GateRecipe(checks: [
            GateRecipeCheck(id: "swift-test", kind: .test, command: "swift test", runsWithoutPrompt: true),
        ])
        let runner = RecordingCheckRunner(permissions: permissions, recipe: allowed)
        let model = ScriptedModelClient(steps: [
            .call("check_stub", ["passed": true]),
            .call("edit_stub", ["path": "Sources/Menu.swift"]),
            .text("Done."),
        ])
        let runtime = orchestrator(model, recipe: allowed, permissions: permissions, checkRunner: runner)

        try await runtime.submit(prompt: "Fix the menu")
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 3, "the runtime ran the check itself: no extra turn")
        let ran = await runner.ran
        XCTAssertEqual(ran, [["swift-test"]])
        let ended = await endReasons()
        XCTAssertEqual(ended, [.doneChecked])
        let recorded = await payloads().compactMap { payload -> VerificationRecord? in
            if case let .verificationRecorded(record) = payload { return record }
            return nil
        }
        XCTAssertEqual(recorded.last?.checkID, "swift-test")
        XCTAssertEqual(recorded.last?.workspaceRevision, 1, "stamped after the edit")
    }

    func testACheckThatWouldPromptIsLeftToTheModel() async throws {
        let model = ScriptedModelClient(steps: [
            .call("edit_stub"),
            .text("Done."),
            .call("check_stub", ["passed": true]),
            .text("Checked."),
        ])
        let runtime = orchestrator(model)

        try await runtime.submit(prompt: "Fix it")
        await runtime.awaitCompletion()

        let recorded = await continuations()
        XCTAssertEqual(recorded.map(\.reason), [.gate(.unverified)])
        XCTAssertTrue(recorded.first?.detail.contains("`swift test`") == true)
        let ended = await endReasons()
        XCTAssertEqual(ended, [.doneChecked])
    }

    func testAFailingCheckGetsOneContinuationThenAFixPasses() async throws {
        let model = ScriptedModelClient(steps: [
            .calls([("edit_stub", [:]), ("check_stub", ["passed": false, "excerpt": "error: expected 2, got 3"])]),
            .text("Done."),
            .calls([("edit_stub", [:]), ("check_stub", ["passed": true])]),
            .text("Fixed and checked."),
        ])
        let runtime = orchestrator(model)

        try await runtime.submit(prompt: "Fix it")
        await runtime.awaitCompletion()

        let recorded = await continuations()
        XCTAssertEqual(recorded.map(\.reason), [.gate(.checksFailing)])
        let note = try XCTUnwrap(lastRuntimeNote(model.receivedRequests[2]))
        XCTAssertTrue(note.contains("expected 2, got 3"))
        let ended = await endReasons()
        XCTAssertEqual(ended, [.doneChecked])
    }

    func testTheSameFailureTwiceEndsChecksFailing() async throws {
        let model = ScriptedModelClient(steps: [
            .calls([("edit_stub", [:]), ("check_stub", ["passed": false, "excerpt": "error: expected 2, got 3"])]),
            .text("Done."),
            .calls([("edit_stub", [:]), ("check_stub", ["passed": false, "excerpt": "error: expected 2, got 3"])]),
            .text("It still fails the same way."),
        ])
        let runtime = orchestrator(model)

        try await runtime.submit(prompt: "Fix it")
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 4)
        let recorded = await continuations()
        XCTAssertEqual(recorded.map(\.reason), [.gate(.checksFailing)])
        let ended = await endReasons()
        XCTAssertEqual(ended, [.checksFailing])
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed, "a soft end, never a failed run")
    }

    // MARK: - The step limit

    func testTheStepLimitEndsInAToolsOffWrapUpAndKeepGoingGrantsAnotherBlock() async throws {
        var steps: [ScriptedModelClient.Step] = (0..<9).map { _ in .call("noop_stub") }
        steps.append(.call("noop_stub"))      // the wrap-up turn tries a call anyway
        steps.append(.text("Continuing from where I stopped."))
        let model = ScriptedModelClient(steps: steps)
        let runtime = orchestrator(model, settings: settings(stepLimit: 10))

        try await runtime.submit(prompt: "Do a long task")
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 10)
        let wrapUp = model.receivedRequests[9]
        // The tools stay declared: a history with tool calls is refused
        // without their definitions, and they are part of the cached prefix.
        // They are off all the same: the note says so and the call never runs.
        XCTAssertEqual(wrapUp.tools.map(\.name), model.receivedRequests[8].tools.map(\.name))
        XCTAssertTrue(lastRuntimeNote(wrapUp)?.hasPrefix("<juno_runtime reason=\"wrap_up\"") == true)
        XCTAssertTrue(lastRuntimeNote(wrapUp)?.contains("tools are off") == true)
        let started = await payloads().filter { if case .toolStarted = $0 { return true } else { return false } }.count
        XCTAssertEqual(started, 9, "the call the wrap-up turn made never ran")
        var ended = await endReasons()
        XCTAssertEqual(ended, [.stepLimit])
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
        let divider = await payloads().compactMap { payload -> String? in
            if case let .runCompleted(run) = payload { return run.endDetail }
            return nil
        }
        XCTAssertEqual(divider, ["Stopped at 10 steps. Keep going?"])

        try await runtime.resume(note: .keepGoing)
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 11)
        XCTAssertFalse(model.receivedRequests[10].tools.isEmpty, "Keep going granted another block")
        XCTAssertFalse(
            lastRuntimeNote(model.receivedRequests[10])?.contains("reason=\"wrap_up\"") == true,
            "the turn after Keep going is a working turn, not another wrap-up"
        )
        let history = model.receivedRequests[10].messages
        let callIDs = history.compactMap { message -> String? in
            switch message {
            case let .toolCall(id, _, _), let .toolCallWithExtra(id, _, _, _): id
            default: nil
            }
        }
        let resultIDs = Set(history.compactMap { message -> String? in
            switch message {
            case let .toolResult(id, _, _), let .toolResultWithImages(id, _, _, _): id
            default: nil
            }
        })
        let unanswered = callIDs.contains { !resultIDs.contains($0) }
        XCTAssertFalse(unanswered, "the dropped wrap-up call left no unanswered call in the history")
        ended = await endReasons()
        XCTAssertEqual(ended, [.stepLimit, .doneUnchecked])
        let prompts = await userPrompts()
        XCTAssertEqual(prompts, 1)
    }

    // MARK: - The output limit

    func testAReplyCutOffAtTheOutputLimitIsResumedOnce() async throws {
        let model = ScriptedModelClient(steps: [
            .events([
                .textDelta("Writing the file"),
                .toolCallRequested(id: "cut", name: "edit_stub", input: ["path": "src/half"]),
                .turnCompleted(.maxTokens),
            ]),
            .text("Done in smaller pieces."),
        ])
        let runtime = orchestrator(model)

        try await runtime.submit(prompt: "Write a big file")
        await runtime.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 2)
        let note = try XCTUnwrap(lastRuntimeNote(model.receivedRequests[1]))
        XCTAssertTrue(note.contains("reason=\"output_limit\""))
        XCTAssertTrue(note.contains("cut off"), "the dropped call is named")
        let ranEdit = await payloads().contains {
            if case .fileChanged = $0 { return true } else { return false }
        }
        XCTAssertFalse(ranEdit, "a half-written call is never run")
        XCTAssertFalse(model.receivedRequests[1].messages.contains { $0.toolCallID == "cut" })
        let ended = await endReasons()
        XCTAssertEqual(ended, [.doneUnchecked])
    }

    // MARK: - Resume and Retry

    func testRetryAndResumeAddNoReaderMessage() async throws {
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.transport(message: "offline")),
            .text("Recovered."),
            .text("Carried on."),
        ])
        let runtime = orchestrator(model, retries: 0)

        try await runtime.submit(prompt: "Fix it")
        await runtime.awaitCompletion()
        var ended = await endReasons()
        XCTAssertEqual(ended, [.error])

        try await runtime.resume(note: .retry)
        await runtime.awaitCompletion()
        try await runtime.resume(note: .afterQuit(unknownOutcomes: ["Run swift test"]))
        await runtime.awaitCompletion()

        let prompts = await userPrompts()
        XCTAssertEqual(prompts, 1)
        let last = try XCTUnwrap(model.receivedRequests.last)
        let readerMessages = last.messages.filter(\.isReaderMessage)
        XCTAssertEqual(readerMessages.count, 1, "the reader's one message, never repeated")
        let notes = last.messages.compactMap { message -> String? in
            guard case let .user(text) = message, RuntimeNote.isRuntimeNote(text) else { return nil }
            return text
        }
        XCTAssertEqual(notes.count, 2)
        XCTAssertTrue(notes[0].contains("reason=\"retry\""))
        XCTAssertTrue(notes[1].contains("reason=\"after_quit\""))
        XCTAssertTrue(notes[1].contains("Run swift test"))
        ended = await endReasons()
        XCTAssertEqual(ended, [.error, .doneUnchecked, .doneUnchecked])
    }

    /// The run budget counts working time only. A Retry three hours after an
    /// error carries on working; it does not wrap up at once because the
    /// clock kept running while nothing did.
    func testARetryHoursAfterAnErrorDoesNotWrapUpAtOnce() async throws {
        let clock = TestClock()
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.transport(message: "offline")),
            .text("Recovered."),
        ])
        let runtime = orchestrator(
            model,
            settings: AutonomySettings(reviewBeforeFinish: .off, runBudget: Budget(minutes: 60)),
            retries: 0,
            clock: clock
        )

        try await runtime.submit(prompt: "Fix it")
        await runtime.awaitCompletion()
        clock.advance(minutes: 180)
        try await runtime.resume(note: .retry)
        await runtime.awaitCompletion()

        let retried = try XCTUnwrap(model.receivedRequests.last)
        XCTAssertTrue(lastRuntimeNote(retried)?.contains("reason=\"retry\"") == true, "a working turn, not a wrap-up")
        let ended = await endReasons()
        XCTAssertEqual(ended, [.error, .doneUnchecked])
        let ledger = await runtime.ledgerSnapshot()
        XCTAssertLessThan(ledger.minutes(at: clock.now), 1, "three idle hours are not the run's minutes")
    }

    /// Juno quit mid-run: the journal's last step boundary is when the run
    /// stopped working, not the moment it is resumed.
    func testAJournalFromAQuitStopsCountingAtItsLastStep() async throws {
        let started = Date(timeIntervalSince1970: 1_800_000_000)
        var ledger = RunLedger(startedAt: started)
        ledger.steps = 4
        try await store.saveRunJournal(
            RunJournal(ledger: ledger, active: true, updatedAt: started.addingTimeInterval(20 * 60)),
            for: session.id
        )
        let relaunched = RunLedgerRecorder(sessionID: session.id, store: store)
        let resumedAt = started.addingTimeInterval(10 * 3_600)
        await relaunched.resumeRun(stepAllowance: 200, at: resumedAt)
        let restored = await relaunched.snapshot()
        XCTAssertEqual(restored.steps, 4, "the run carries on from its journal")
        XCTAssertEqual(restored.minutes(at: resumedAt.addingTimeInterval(5 * 60)), 25, accuracy: 0.01)
        XCTAssertNil(restored.budgetReached(Budget(minutes: 60), at: resumedAt.addingTimeInterval(5 * 60)))
    }

    // MARK: - Compaction

    func testARuntimeNoteIsNeverQuotedAsTheReaderByCompaction() async throws {
        let model = ScriptedModelClient(steps: [
            .call("todo_write", ["todos": [["id": "1", "content": "Fix the bug", "status": "in_progress"]]]),
            .text("Done."),
            .call("todo_write", ["todos": [["id": "1", "content": "Fix the bug", "status": "completed"]]]),
            .text("Finished."),
            .text("Second task done."),
        ])
        let runtime = orchestrator(model)
        try await runtime.submit(prompt: "Fix the bug")
        await runtime.awaitCompletion()
        try await runtime.submit(prompt: "Now tidy up")
        await runtime.awaitCompletion()

        let event = await runtime.compactNow()
        let compaction = try XCTUnwrap(event)
        XCTAssertFalse(compaction.summary.contains("User: <juno_runtime"))
        let persisted = await store.loadConversation(sessionID: session.id)
        // Whatever the memory says about the note, the reader's words it
        // quotes are theirs alone.
        for message in persisted where message.isReaderMessage {
            guard case let .user(text) = message else { continue }
            XCTAssertFalse(text.hasPrefix(RuntimeNote.openingPrefix), "a runtime note is never the reader's message")
        }
        XCTAssertFalse(
            CompactionSummarizer.transcript(of: [.user(RuntimeContinuation.note(for: .todosOpen, detail: "1 todo was still open", revision: 0).rendered)], maximumCharacters: 10_000)
                .contains("<user>"),
            "the summarizer sees a runtime note as Juno's, not a <user> turn"
        )
    }
}
