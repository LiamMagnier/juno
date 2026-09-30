import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// The collected turn the Mac's Work runs are driven by: the model's items in
/// stream order, and the Code loop's retry policy applied to failures.
final class ModelTurnCollectorTests: XCTestCase {
    private func request() -> ModelTurnRequest {
        ModelTurnRequest(
            sessionID: CodeSessionID(),
            systemPrompt: "sys",
            messages: [.user("Tidy the downloads folder")],
            tools: [],
            modelID: "anthropic:claude-opus-5-5",
            reasoningEffort: nil
        )
    }

    func testTheTurnIsCollectedInStreamOrderWithItsReasoning() async throws {
        let model = ScriptedModelClient(steps: [
            .events([
                .thinkingBlock(text: "Plan", signature: "sig"),
                .textDelta("Listing first."),
                .toolCallRequested(id: "a", name: "list", input: ["path": "~/Downloads"]),
                .thinkingBlock(text: "Then", signature: "sig2"),
                .toolCallMalformed(id: "b", name: "move", rawArguments: "{\"from\":", error: "Unexpected end of file", extraContent: nil),
                .usage(inputTokens: 900, outputTokens: nil),
                .cacheUsage(readTokens: 800, writeTokens: nil),
                .usage(inputTokens: nil, outputTokens: 60),
                // A compatible provider calling a tool turn a normal end.
                .turnCompleted(.endTurn),
            ]),
        ])

        let turn = try await ModelTurnCollector.collect(request(), model: model)

        XCTAssertEqual(turn.items, [
            .assistantThinking(text: "Plan", signature: "sig"),
            .assistant("Listing first."),
            .toolCall(id: "a", name: "list", input: ["path": "~/Downloads"]),
            .assistantThinking(text: "Then", signature: "sig2"),
            .toolCall(id: "b", name: "move", input: [:]),
        ])
        XCTAssertEqual(turn.text, "Listing first.")
        XCTAssertEqual(turn.toolCalls.map(\.id), ["a", "b"])
        XCTAssertEqual(turn.stopReason, .toolUse)
        XCTAssertTrue(turn.malformedResults["b"]?.contains("Unexpected end of file") == true)
        XCTAssertNil(turn.malformedResults["a"])
        XCTAssertEqual(turn.usage?.cacheReadTokens, 800)
        XCTAssertEqual(turn.usage?.outputTokens, 60)
    }

    func testARateLimitIsWaitedOutAsTheProviderAsked() async throws {
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.rateLimited(retryAfter: 2)),
            .failure(AgentModelClientError.transport(message: "connection reset")),
            .text("Done."),
        ])
        let waits = WaitRecorder()

        let turn = try await ModelTurnCollector.collect(
            request(),
            model: model,
            sleep: { waits.record($0) },
            jitter: { 1 },
            onRetry: { waits.notice($0) }
        )

        XCTAssertEqual(turn.text, "Done.")
        XCTAssertEqual(waits.durations, [.seconds(2), .seconds(2)])
        XCTAssertEqual(waits.notices.map(\.attempt), [1, 2])
        XCTAssertTrue(waits.notices[0].sentence.contains("limiting how fast"))
    }

    func testWhatWaitingCannotFixFailsAtOnceInWordsForAPerson() async {
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.unauthorized),
            .text("Never reached."),
        ])
        do {
            _ = try await ModelTurnCollector.collect(request(), model: model, sleep: { _ in })
            XCTFail("rejected credentials are not retried")
        } catch let failure as ModelTurnCollector.Failure {
            XCTAssertEqual(failure.sentence, "The model provider rejected Juno's credentials.")
            XCTAssertEqual(model.receivedRequests.count, 1)
        } catch {
            XCTFail("expected a typed failure, got \(error)")
        }
    }

    func testCancellationDuringAWaitEndsTheTurn() async {
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.overloaded(retryAfter: 30)),
            .text("Never reached."),
        ])
        let request = self.request()
        let task = Task { try await ModelTurnCollector.collect(request, model: model) }
        try? await Task.sleep(for: .milliseconds(50))
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled wait ends the turn")
        } catch {
            XCTAssertTrue(error is CancellationError, "got \(error)")
        }
        XCTAssertEqual(model.receivedRequests.count, 1)
    }
}

private final class WaitRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var waits: [Duration] = []
    private var retries: [ModelTurnCollector.Retry] = []

    func record(_ duration: Duration) {
        lock.lock(); waits.append(duration); lock.unlock()
    }

    func notice(_ retry: ModelTurnCollector.Retry) {
        lock.lock(); retries.append(retry); lock.unlock()
    }

    var durations: [Duration] {
        lock.lock(); defer { lock.unlock() }
        return waits
    }

    var notices: [ModelTurnCollector.Retry] {
        lock.lock(); defer { lock.unlock() }
        return retries
    }
}
