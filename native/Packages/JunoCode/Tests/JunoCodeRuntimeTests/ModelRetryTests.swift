import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// The typed retry policy: backoff with jitter, the provider's own
/// `retry-after`, fallback only when opted into and only after waiting has
/// failed, a fold and one more try when the window overflows, and each stop
/// reason handled for what it is.
final class ModelRetryTests: XCTestCase {
    private var baseURL: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        baseURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-model-retry-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: baseURL.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Retry",
            configuration: AgentConfiguration(modelID: "anthropic:claude-opus-5-5"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: baseURL)
    }

    // MARK: - The policy

    func testBackoffDoublesWithJitterWithinTheCap() {
        let policy = ModelRetryPolicy(
            maximumRetries: 5,
            baseDelay: .seconds(1),
            maximumDelay: .seconds(4),
            maximumTotalWait: .seconds(100)
        )
        XCTAssertEqual(policy.delay(forRetry: 1, retryAfter: nil, waited: .zero, jitter: 1), .seconds(1))
        XCTAssertEqual(policy.delay(forRetry: 1, retryAfter: nil, waited: .zero, jitter: 0), .milliseconds(500))
        XCTAssertEqual(policy.delay(forRetry: 2, retryAfter: nil, waited: .zero, jitter: 1), .seconds(2))
        XCTAssertEqual(policy.delay(forRetry: 3, retryAfter: nil, waited: .zero, jitter: 1), .seconds(4))
        XCTAssertEqual(policy.delay(forRetry: 5, retryAfter: nil, waited: .zero, jitter: 1), .seconds(4), "capped")
        XCTAssertNil(policy.delay(forRetry: 6, retryAfter: nil, waited: .zero, jitter: 1), "out of retries")
    }

    func testRetryAfterIsHonouredUnlessItAsksTooMuch() {
        let policy = ModelRetryPolicy(maximumRetries: 3, maximumTotalWait: .seconds(90), maximumRetryAfter: .seconds(60))
        XCTAssertEqual(policy.delay(forRetry: 1, retryAfter: 7, waited: .zero, jitter: 0.3), .seconds(7))
        XCTAssertEqual(policy.delay(forRetry: 1, retryAfter: 0.25, waited: .zero, jitter: 0.3), .milliseconds(250))
        XCTAssertNil(policy.delay(forRetry: 1, retryAfter: 3_600, waited: .zero, jitter: 0.3), "an hour means give up")
        XCTAssertNil(
            policy.delay(forRetry: 2, retryAfter: 30, waited: .seconds(70), jitter: 0.3),
            "past the total waiting budget"
        )
    }

    func testFailuresAreClassifiedForWhatWillHelp() {
        let policy = ModelRetryPolicy.standard
        XCTAssertEqual(ModelFailure(AgentModelClientError.rateLimited(retryAfter: 3)).retryAfter, 3)
        XCTAssertEqual(ModelFailure(AgentModelClientError.overloaded(retryAfter: nil)).retryLimit(policy), 4)
        XCTAssertEqual(ModelFailure(AgentModelClientError.transport(message: "reset")).retryLimit(policy), 4)
        XCTAssertEqual(ModelFailure(URLError(.networkConnectionLost)).retryLimit(policy), 4)
        XCTAssertEqual(ModelFailure(AgentModelClientError.invalidResponse(message: "x")).retryLimit(policy), 1)
        XCTAssertEqual(ModelFailure(AgentModelClientError.unauthorized).retryLimit(policy), 0)
        XCTAssertEqual(ModelFailure(AgentModelClientError.quotaExhausted(message: "x")).retryLimit(policy), 0)
        XCTAssertTrue(ModelFailure(AgentModelClientError.quotaExhausted(message: "x")).warrantsFallback)
        XCTAssertFalse(ModelFailure(AgentModelClientError.unauthorized).warrantsFallback)
        XCTAssertFalse(ModelFailure(AgentModelClientError.contextWindowExceeded(message: "x")).warrantsFallback)
    }

    // MARK: - In the loop

    func testARateLimitWaitsWhatTheProviderAskedThenCarriesOn() async throws {
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.rateLimited(retryAfter: 3)),
            .failure(AgentModelClientError.overloaded(retryAfter: nil)),
            .text("Answered."),
        ])
        let sleeps = SleepRecorder()
        let orchestrator = makeOrchestrator(model: model, sleeps: sleeps)

        try await orchestrator.submit(prompt: "Hello")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed)
        // The provider's three seconds, then the second backoff at full jitter.
        XCTAssertEqual(sleeps.values, [.seconds(3), .seconds(2)])
        let notices = await errors()
        XCTAssertEqual(notices.count, 2)
        XCTAssertTrue(notices[0].message.contains("limiting how fast"))
        XCTAssertTrue(notices[0].message.contains("Retrying in 3 s (retry 1 of 4)"))
        XCTAssertTrue(notices[1].message.contains("overloaded"))
    }

    func testWithoutOptingInThereIsNoFallbackEvenWhenRetriesRunOut() async throws {
        let model = ScriptedModelClient(steps: Array(
            repeating: .failure(AgentModelClientError.rateLimited(retryAfter: nil)),
            count: 5
        ) + [.text("Never reached.")])
        let orchestrator = makeOrchestrator(model: model, sleeps: SleepRecorder())

        try await orchestrator.submit(prompt: "Hello")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .failed)
        XCTAssertEqual(model.receivedRequests.count, 5)
        XCTAssertTrue(model.receivedRequests.allSatisfy { $0.modelID == "anthropic:claude-opus-5-5" })
    }

    func testAnOptedInFallbackComesOnlyAfterBackoffAndGetsItsOwnThinkingSetting() async throws {
        let model = ScriptedModelClient(steps: Array(
            repeating: .failure(AgentModelClientError.overloaded(retryAfter: nil)),
            count: 5
        ) + [.text("Answered by the fallback.")])
        let orchestrator = makeOrchestrator(
            model: model,
            sleeps: SleepRecorder(),
            fallback: FixedFallback(model: "openai:gpt-6", effort: .low)
        )

        try await orchestrator.submit(prompt: "Hello")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed)
        let requests = model.receivedRequests
        XCTAssertEqual(requests.count, 6)
        XCTAssertTrue(requests.prefix(5).allSatisfy {
            $0.modelID == "anthropic:claude-opus-5-5" && $0.reasoningEffort == .xhigh
        })
        XCTAssertEqual(requests.last?.modelID, "openai:gpt-6")
        XCTAssertEqual(requests.last?.reasoningEffort, .low, "recomputed for the fallback, not the primary's")
        let notices = await errors()
        XCTAssertTrue(notices.contains { $0.message.contains("Switching from 'anthropic:claude-opus-5-5' to 'openai:gpt-6'") })
    }

    func testAQuotaFailureGoesStraightToAnOptedInFallback() async throws {
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.quotaExhausted(message: "Insufficient Balance")),
            .text("Fallback answered."),
        ])
        let sleeps = SleepRecorder()
        let orchestrator = makeOrchestrator(
            model: model,
            sleeps: sleeps,
            fallback: FixedFallback(model: "google:gemini-4-pro", effort: nil)
        )

        try await orchestrator.submit(prompt: "Hello")
        await orchestrator.awaitCompletion()

        XCTAssertEqual(sleeps.values, [], "waiting does not refill a provider's balance")
        XCTAssertEqual(model.receivedRequests.map(\.modelID), ["anthropic:claude-opus-5-5", "google:gemini-4-pro"])
        XCTAssertNil(model.receivedRequests.last?.reasoningEffort)
    }

    func testRejectedCredentialsAreNotRetried() async throws {
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.unauthorized),
            .text("Never reached."),
        ])
        let orchestrator = makeOrchestrator(model: model, sleeps: SleepRecorder())

        try await orchestrator.submit(prompt: "Hello")
        await orchestrator.awaitCompletion()

        XCTAssertEqual(model.receivedRequests.count, 1)
        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .failed)
    }

    func testAContextOverflowFoldsTheHistoryAndTriesOnce() async throws {
        try await store.saveConversation(sessionID: session.id, messages: longHistory())
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.contextWindowExceeded(message: "prompt is too long")),
            .text("Fits now."),
        ])
        let orchestrator = makeOrchestrator(model: model, sleeps: SleepRecorder())

        try await orchestrator.submit(prompt: "Carry on")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed)
        let events = await store.events(for: session.id).map(\.payload)
        XCTAssertTrue(events.contains {
            if case .compaction = $0 { return true }
            return false
        })
        let requests = model.receivedRequests.filter { $0.systemPrompt == "sys" }
        XCTAssertEqual(requests.count, 2)
        XCTAssertLessThan(requests[1].messages.count, requests[0].messages.count, "the retry sends the folded history")
    }

    func testASecondOverflowInARowFailsTheRun() async throws {
        try await store.saveConversation(sessionID: session.id, messages: longHistory())
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.contextWindowExceeded(message: "prompt is too long")),
            .failure(AgentModelClientError.contextWindowExceeded(message: "prompt is too long")),
            .text("Never reached."),
        ])
        let orchestrator = makeOrchestrator(model: model, sleeps: SleepRecorder())

        try await orchestrator.submit(prompt: "Carry on")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .failed)
    }

    func testAReplyCutOffByTheWindowIsFoldedAndAskedAgain() async throws {
        try await store.saveConversation(sessionID: session.id, messages: longHistory())
        let model = ScriptedModelClient(steps: [
            .events([.textDelta("I was about to"), .turnCompleted(.contextWindowExceeded)]),
            .text("Done after the fold."),
        ])
        let orchestrator = makeOrchestrator(model: model, sleeps: SleepRecorder())

        try await orchestrator.submit(prompt: "Carry on")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed)
        let retried = try XCTUnwrap(model.receivedRequests.last { $0.systemPrompt == "sys" })
        XCTAssertFalse(retried.messages.contains(.assistant("I was about to")), "the cut-off reply is not kept")
    }

    func testARefusalEndsTheRunAndLeavesNoRefusedTurnInTheHistory() async throws {
        let model = ScriptedModelClient(steps: [
            .events([.textDelta("I can't help with that."), .turnCompleted(.refusal)]),
            .text("Sure, here is the plan."),
        ])
        let orchestrator = makeOrchestrator(model: model, sleeps: SleepRecorder())

        try await orchestrator.submit(prompt: "Something borderline")
        await orchestrator.awaitCompletion()
        let refused = try await store.session(id: session.id)
        XCTAssertEqual(refused.status, .failed)
        let notices = await errors()
        XCTAssertTrue(notices.contains { $0.message.contains("declined") })

        try await orchestrator.submit(prompt: "Something else")
        await orchestrator.awaitCompletion()
        let next = try XCTUnwrap(model.receivedRequests.last)
        XCTAssertFalse(next.messages.contains(.assistant("I can't help with that.")))
        // The reader still saw what the model wrote.
        let said = await store.events(for: session.id).compactMap { event -> String? in
            if case let .assistantMessage(message) = event.payload { return message.text }
            return nil
        }
        XCTAssertTrue(said.contains("I can't help with that."))
    }

    func testAPausedTurnIsSentBackForTheModelToContinue() async throws {
        let model = ScriptedModelClient(steps: [
            .events([.textDelta("Working through the search"), .turnCompleted(.pauseTurn)]),
            .text("and here is the answer."),
        ])
        let orchestrator = makeOrchestrator(model: model, sleeps: SleepRecorder())

        try await orchestrator.submit(prompt: "Search")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed)
        XCTAssertEqual(model.receivedRequests.count, 2)
        XCTAssertEqual(model.receivedRequests[1].messages.last, .assistant("Working through the search"))
    }

    func testStopDuringABackoffEndsTheRunPromptly() async throws {
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.rateLimited(retryAfter: 30)),
            .text("Never reached."),
        ])
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: []),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "sys"),
            modelID: "anthropic:claude-opus-5-5",
            reasoningEffort: .xhigh
        )
        try await orchestrator.submit(prompt: "Hello")
        for _ in 0..<200 {
            if await errors().contains(where: { $0.message.contains("Retrying in 30 s") }) { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let started = ContinuousClock.now
        await orchestrator.stop()
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(5))
        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .cancelled)
        XCTAssertEqual(model.receivedRequests.count, 1)
    }

    // MARK: - Helpers

    private func makeOrchestrator(
        model: ScriptedModelClient,
        sleeps: SleepRecorder,
        fallback: (any ModelFallbackResolver)? = nil
    ) -> AgentOrchestrator {
        AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: []),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: AgentOrchestrator.Configuration(
                // No model summary: an overflow's fold is structural here.
                compactionSummary: nil,
                systemPrompt: "sys",
                retrySleep: { duration in sleeps.record(duration) },
                retryJitter: { 1 }
            ),
            modelID: "anthropic:claude-opus-5-5",
            reasoningEffort: .xhigh,
            fallbackResolver: fallback
        )
    }

    private func errors() async -> [ErrorEvent] {
        await store.events(for: session.id).compactMap { event in
            if case let .errorOccurred(error) = event.payload { return error }
            return nil
        }
    }

    /// Several steps of an earlier request, so there is something to fold.
    private func longHistory() -> [ModelMessage] {
        var history: [ModelMessage] = [.user("Start the migration")]
        for index in 0..<8 {
            history.append(.assistant("Step \(index)."))
            history.append(.toolCall(id: "h\(index)", name: "read_file", input: ["path": .string("f\(index)")]))
            history.append(.toolResult(id: "h\(index)", content: String(repeating: "x", count: 400), isError: false))
        }
        history.append(.assistant("Paused there."))
        return history
    }
}

private final class SleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [Duration] = []

    func record(_ duration: Duration) {
        lock.lock(); recorded.append(duration); lock.unlock()
    }

    var values: [Duration] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }
}

private struct FixedFallback: ModelFallbackResolver {
    let model: String
    let effort: ReasoningEffort?

    func resolveFallback(for currentModelID: String) async -> String? {
        currentModelID == model ? nil : model
    }

    func reasoningEffort(for modelID: String, preferred _: ReasoningEffort?) -> ReasoningEffort? {
        modelID == model ? effort : nil
    }
}
