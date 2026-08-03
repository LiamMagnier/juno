import JunoCore
import XCTest
@testable import JunoChatKit

/// The comparison's contract, which is mostly about the races it must not lose.
///
/// Three panes streaming at once, each restartable while the previous run is
/// still delivering frames, is exactly the shape that produces "the answer under
/// GPT's name was written by Claude" — and that failure is invisible, because
/// both halves look like plausible answers. These pin the parts that prevent it.
@MainActor
final class NativeCompareModelTests: XCTestCase {

    private func account() throws -> AccountID { try AccountID("account-1") }

    private func makeModel(_ client: CompareClient) -> NativeCompareModel {
        let model = NativeCompareModel(client: client)
        model.start(for: try! account(), models: ["a:one", "b:two"])
        return model
    }

    // MARK: - Fan-out

    func testOnePromptStartsOneRequestPerPane() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        XCTAssertEqual(model.panes.count, 2)

        model.submit("compare this")
        await client.waitForRequests(2)

        XCTAssertEqual(client.requests.count, 2)
        XCTAssertEqual(Set(client.requests.map(\.modelID)), ["a:one", "b:two"])
        // Every pane asks its own question of its own model, and the private
        // branch carries the whole history — which here is the one prompt.
        XCTAssertTrue(client.requests.allSatisfy { $0.history.map(\.content) == ["compare this"] })
        // Distinct generation ids, or Stop would cancel the wrong pane.
        XCTAssertEqual(Set(client.requests.map(\.generationID)).count, 2)
    }

    func testAPaneIsStreamingUntilItsOwnRunFinishes() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        model.submit("go")
        await client.waitForRequests(2)

        let first = model.panes[0].id
        client.emit(.textDelta("half"), to: client.requests[0].generationID)
        await settle()
        XCTAssertEqual(model.runs[first]?.content, "half")
        XCTAssertTrue(model.anyStreaming)

        client.finish(client.requests[0].generationID, content: "half an answer")
        client.finish(client.requests[1].generationID, content: "another")
        await settle()

        XCTAssertEqual(model.runs[first]?.status, .done)
        XCTAssertEqual(model.runs[first]?.content, "half an answer")
        XCTAssertFalse(model.anyStreaming)
    }

    /// The server's final text wins over the accumulated deltas, exactly as the
    /// persisted path does — a reconnect can repeat a delta.
    func testTheFinalMessageReplacesTheStreamedDeltas() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        model.submit("go")
        await client.waitForRequests(2)

        let pane = model.panes[0].id
        client.emit(.textDelta("dupe dupe "), to: client.requests[0].generationID)
        client.finish(client.requests[0].generationID, content: "the real answer")
        await settle()
        XCTAssertEqual(model.runs[pane]?.content, "the real answer")
    }

    // MARK: - The run token

    /// The bug this exists to prevent: a pane's model changes mid-run, and the
    /// dying run's last delta lands in the new run's content — so the pane shows
    /// two models' answers spliced together, under one model's name.
    func testFramesFromASupersededRunAreDropped() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        model.submit("go")
        await client.waitForRequests(2)
        let pane = model.panes[0].id
        let firstGeneration = client.requests[0].generationID

        model.setModel("c:three", for: pane)
        await client.waitForRequests(3)
        XCTAssertEqual(model.panes[0].modelID, "c:three")

        // The old run, still alive, tries to write.
        client.emit(.textDelta("from the OLD model"), to: firstGeneration)
        client.emit(.textDelta("from the new model"), to: client.requests[2].generationID)
        await settle()

        XCTAssertEqual(model.runs[pane]?.content, "from the new model")
    }

    /// Changing a pane's model with nothing on the board must not start a run —
    /// there is no prompt to answer, and a pane that "answers" nothing would be
    /// billing for a question the reader never asked.
    func testChangingAModelBeforeAnyPromptOnlyResetsThePane() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        model.setModel("c:three", for: model.panes[0].id)
        await settle()
        XCTAssertTrue(client.requests.isEmpty)
        XCTAssertEqual(model.runs[model.panes[0].id]?.status, .idle)
    }

    // MARK: - Panes

    func testAPaneAddedMidBoardAnswersThePromptAlreadyOnIt() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        model.submit("the question")
        await client.waitForRequests(2)
        client.finish(client.requests[0].generationID, content: "one")
        client.finish(client.requests[1].generationID, content: "two")
        await settle()

        model.addPane(modelID: "c:three")
        await client.waitForRequests(3)
        XCTAssertEqual(client.requests[2].modelID, "c:three")
        XCTAssertEqual(client.requests[2].history.map(\.content), ["the question"])
    }

    /// Two panes is the minimum, because one pane is not a comparison.
    func testTheLastTwoPanesCannotBeRemoved() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        XCTAssertFalse(model.canRemovePane)
        model.removePane(model.panes[0].id)
        XCTAssertEqual(model.panes.count, 2)

        model.addPane(modelID: "c:three")
        XCTAssertTrue(model.canRemovePane)
        model.removePane(model.panes[2].id)
        XCTAssertEqual(model.panes.count, 2)
    }

    /// An abandoned private stream would otherwise run — and bill — to completion
    /// for a column nobody is looking at.
    func testRemovingAStreamingPaneCancelsItServerSide() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        model.addPane(modelID: "c:three")
        model.submit("go")
        await client.waitForRequests(3)

        let doomed = model.panes[2]
        let generation = client.requests.first { $0.modelID == "c:three" }!.generationID
        model.removePane(doomed.id)
        await client.waitForCancels(1)

        XCTAssertEqual(client.cancelled, [generation])
        XCTAssertNil(model.runs[doomed.id])
    }

    // MARK: - Stopping

    /// Stop prefers the cancel endpoint: the server closes the stream with the
    /// partial answer and the correct spend. Aborting locally alone would abandon
    /// a generation that keeps running.
    func testStopCancelsEveryInFlightGenerationServerSide() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        model.submit("go")
        await client.waitForRequests(2)

        model.stopAll()
        // Checked before the await: `stopping` means "a stop is in flight" and
        // clears itself once nothing is streaming, so asserting it *after*
        // waiting for the cancels asserts whichever of the two got there first.
        XCTAssertTrue(model.stopping, "the composer shows stopping without waiting for the server")

        await client.waitForCancels(2)
        XCTAssertEqual(Set(client.cancelled), Set(client.requests.map(\.generationID)))
    }

    // MARK: - Failure

    func testAFailedFrameLeavesThePaneRetryable() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        model.submit("go")
        await client.waitForRequests(2)

        client.emit(
            .failed(message: "The model is overloaded.", finishReason: .error, generationID: nil, userMessageID: nil),
            to: client.requests[0].generationID
        )
        await settle()

        let run = model.runs[model.panes[0].id]
        XCTAssertEqual(run?.status, .error)
        XCTAssertEqual(run?.errorMessage, "The model is overloaded.")
        XCTAssertEqual(run?.errorAction, .retry)
    }

    /// A stream that ends without a terminal frame is a dropped connection, not a
    /// finished answer. Reporting it as done would show a truncated reply as
    /// complete, which is the one thing a comparison must not do.
    func testAStreamThatEndsWithoutATerminalFrameIsAnError() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        model.submit("go")
        await client.waitForRequests(2)

        client.emit(.textDelta("partial"), to: client.requests[0].generationID)
        client.close(client.requests[0].generationID)
        await settle()

        let run = model.runs[model.panes[0].id]
        XCTAssertEqual(run?.status, .error)
        XCTAssertEqual(run?.errorMessage, "The connection dropped before this model finished. Run it again.")
    }

    // MARK: - Receipt

    func testTheReceiptComesFromTheServerAndIsNotInventedWhenAbsent() async throws {
        let client = CompareClient()
        let model = makeModel(client)
        model.submit("go")
        await client.waitForRequests(2)

        client.finish(
            client.requests[0].generationID,
            content: "answered",
            promptTokens: 120,
            completionTokens: 340,
            costUsd: 0.0042
        )
        client.finish(client.requests[1].generationID, content: "answered too")
        await settle()

        let priced = model.runs[model.panes[0].id]
        XCTAssertEqual(priced?.promptTokens, 120)
        XCTAssertEqual(priced?.completionTokens, 340)
        XCTAssertEqual(priced?.costUsd, 0.0042)

        // No usage on the wire, no pricing supplied: no number. A zero here would
        // read as "this answer was free".
        let unpriced = model.runs[model.panes[1].id]
        XCTAssertNil(unpriced?.promptTokens)
        XCTAssertNil(unpriced?.costUsd)
    }

    /// The web's client-side fallback: when the server sends no cost, estimate it
    /// from the streamed usage and the manifest's published prices.
    func testCostFallsBackToTheManifestPriceWhenTheServerSendsNone() async throws {
        let client = CompareClient()
        let model = NativeCompareModel(client: client) { _ in
            NativeModelPricing(
                priceClass: "standard", inputPerMillion: 3, outputPerMillion: 15, currency: "USD"
            )
        }
        model.start(for: try account(), models: ["a:one", "b:two"])
        model.submit("go")
        await client.waitForRequests(2)

        client.finish(
            client.requests[0].generationID,
            content: "answered",
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
            costUsd: nil
        )
        await settle()
        XCTAssertEqual(model.runs[model.panes[0].id]?.costUsd ?? 0, 18, accuracy: 0.0001)
    }

    // MARK: - Helpers

    /// Lets the model's per-pane tasks drain. They are owned by the model and not
    /// exposed, so this yields rather than awaiting a handle.
    private func settle() async {
        for _ in 0..<80 {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(2))
        }
    }
}

/// A transport that keeps one live stream per generation id, so a test can drive
/// three panes independently and hand a frame to exactly one of them.
private final class CompareClient: NativeCompareSending, @unchecked Sendable {
    private let lock = NSLock()
    private var storedRequests: [NativeChatPrivateGenerationRequest] = []
    private var continuations: [String: AsyncThrowingStream<NativeChatServerEvent, any Error>.Continuation] = [:]
    private var storedCancels: [String] = []

    var requests: [NativeChatPrivateGenerationRequest] {
        lock.lock(); defer { lock.unlock() }; return storedRequests
    }

    var cancelled: [String] {
        lock.lock(); defer { lock.unlock() }; return storedCancels
    }

    func privateGenerationEvents(
        _ request: NativeChatPrivateGenerationRequest,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<NativeChatServerEvent, any Error> {
        record(request)
        return AsyncThrowingStream { continuation in
            store(continuation, for: request.generationID)
        }
    }

    func cancelGeneration(id: String, for accountID: AccountID) async throws -> Bool {
        // `withLock` rather than a bare lock/unlock pair: the latter is
        // unavailable from an async context because a suspension while holding
        // the lock would block the executor's thread.
        let continuation = lock.withLock {
            storedCancels.append(id)
            return continuations[id]
        }
        // A real cancel closes the stream server-side with what was produced.
        continuation?.finish()
        return true
    }

    func emit(_ event: NativeChatServerEvent, to generationID: String) {
        lock.lock(); let continuation = continuations[generationID]; lock.unlock()
        continuation?.yield(event)
    }

    func close(_ generationID: String) {
        lock.lock(); let continuation = continuations[generationID]; lock.unlock()
        continuation?.finish()
    }

    func finish(
        _ generationID: String,
        content: String,
        promptTokens: Int? = nil,
        completionTokens: Int? = nil,
        costUsd: Double? = nil
    ) {
        emit(
            .completed(
                NativeCompletedChatMessage(
                    id: "compare-\(generationID)",
                    content: content,
                    reasoning: nil,
                    model: "m",
                    createdAt: Date(timeIntervalSince1970: 0),
                    sources: [],
                    finishReason: .stop,
                    promptTokens: promptTokens,
                    completionTokens: completionTokens,
                    costUsd: costUsd
                )
            ),
            to: generationID
        )
        close(generationID)
    }

    func waitForRequests(_ count: Int) async {
        for _ in 0..<300 where requests.count < count {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    func waitForCancels(_ count: Int) async {
        for _ in 0..<300 where cancelled.count < count {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    private func record(_ request: NativeChatPrivateGenerationRequest) {
        lock.lock(); defer { lock.unlock() }
        storedRequests.append(request)
    }

    private func store(
        _ continuation: AsyncThrowingStream<NativeChatServerEvent, any Error>.Continuation,
        for generationID: String
    ) {
        lock.lock(); defer { lock.unlock() }
        continuations[generationID] = continuation
    }
}
