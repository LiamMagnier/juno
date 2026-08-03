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
        settleTarget = model
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
        client.emit(.textDelta("half"), to: generation(forPane: 0, in: model))
        await settle()
        XCTAssertEqual(model.runs[first]?.content, "half")
        XCTAssertTrue(model.anyStreaming)

        client.finish(generation(forPane: 0, in: model), content: "half an answer")
        client.finish(generation(forPane: 1, in: model), content: "another")
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
        client.emit(.textDelta("dupe dupe "), to: generation(forPane: 0, in: model))
        client.finish(generation(forPane: 0, in: model), content: "the real answer")
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
        let firstGeneration = generation(forPane: 0, in: model)

        model.setModel("c:three", for: pane)
        await client.waitForRequests(3)
        XCTAssertEqual(model.panes[0].modelID, "c:three")

        // The old run, still alive, tries to write. The third request is pane
        // 0 being re-dispatched under its new model — not a third pane — so the
        // new generation is still pane 0's.
        client.emit(.textDelta("from the OLD model"), to: firstGeneration)
        client.emit(.textDelta("from the new model"), to: generation(forPane: 0, in: model))
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
        client.finish(generation(forPane: 0, in: model), content: "one")
        client.finish(generation(forPane: 1, in: model), content: "two")
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

        // Addressed by pane, not by `requests[0]`. The panes are dispatched
        // concurrently, so the first recorded request is not reliably the first
        // pane's — emitting at it failed this assertion on whichever pane
        // happened to lose the race.
        let paneID = model.panes[0].id
        let generationID = try XCTUnwrap(model.generationID(forPane: paneID))
        client.emit(
            .failed(message: "The model is overloaded.", finishReason: .error, generationID: nil, userMessageID: nil),
            to: generationID
        )
        await waitUntil("the failed frame to reach the pane") {
            model.runs[paneID]?.status == .error
        }

        let run = model.runs[paneID]
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

        client.emit(.textDelta("partial"), to: generation(forPane: 0, in: model))
        client.close(generation(forPane: 0, in: model))
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
            generation(forPane: 0, in: model),
            content: "answered",
            promptTokens: 120,
            completionTokens: 340,
            costUsd: 0.0042
        )
        client.finish(generation(forPane: 1, in: model), content: "answered too")
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
            generation(forPane: 0, in: model),
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
    /// The generation id belonging to a pane, by index.
    ///
    /// Tests used to address streams as `client.requests[n].generationID`, but
    /// the panes are dispatched concurrently — that is the feature — so the
    /// order requests happen to be recorded in is not the order of the panes.
    /// Emitting at the wrong pane failed the assertion on the right one,
    /// intermittently, and looked like a bug in the model.
    private func generation(forPane index: Int, in model: NativeCompareModel) -> String {
        guard index < model.panes.count,
            let id = model.generationID(forPane: model.panes[index].id)
        else {
            XCTFail("pane \(index) has no in-flight generation")
            return ""
        }
        return id
    }

    /// Waits for the model to stop changing, rather than for a fixed delay.
    ///
    /// This was a flat ~160ms spin, which is a guess about how long a frame
    /// takes to cross an `AsyncStream`. On a loaded machine the guess is
    /// sometimes wrong, and the failure lands in whichever test ran while the
    /// CPU was busy rather than in the one that is broken. Quiescence — two
    /// consecutive observations with no change — is the condition those
    /// assertions actually depend on.
    private func settle(timeout: Duration = .seconds(5)) async {
        func signature(_ model: NativeCompareModel?) -> String {
            guard let model else { return "" }
            return model.panes
                .map { pane in
                    let run = model.runs[pane.id]
                    return "\(pane.id):\(run?.status as Any):\(run?.content.count ?? -1)"
                }
                .joined(separator: "|")
        }

        let deadline = ContinuousClock.now + timeout
        var previous: String?
        var stableRounds = 0
        while ContinuousClock.now < deadline {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(2))
            let current = signature(settleTarget)
            if let previous, previous == current {
                stableRounds += 1
                if stableRounds >= 3 { return }
            } else {
                stableRounds = 0
            }
            previous = current
        }
    }

    /// Set by `makeModel` so `settle()` can observe the model without every
    /// call site having to pass it.
    private weak var settleTarget: NativeCompareModel?

    /// Waits for a state to actually arrive, rather than for a fixed number of
    /// milliseconds to pass.
    ///
    /// `settle()` spins for ~160ms and then asserts. That is a guess about how
    /// long a frame takes to cross an `AsyncStream`, and on a loaded machine it
    /// is sometimes wrong — which shows up as a failure in whichever test ran
    /// while the CPU was busy, not in the one that is actually broken.
    private func waitUntil(
        _ description: String,
        timeout: Duration = .seconds(5),
        _ condition: () -> Bool
    ) async {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if condition() { return }
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("timed out waiting for \(description)")
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
        // The continuation is stored BEFORE the request is recorded, so that a
        // test observing `requests.count` can rely on `emit` having somewhere
        // to deliver to.
        //
        // The other order left a window: `record` and `store` take the lock
        // separately, and a test polling from another thread could see the
        // request between them. It then emitted into a generation with no
        // continuation yet, the frame was dropped, and the pane never left
        // `submitting` — a failure that looked like a bug in the model and was
        // really a race in this double.
        let stream = AsyncThrowingStream<NativeChatServerEvent, any Error> { continuation in
            store(continuation, for: request.generationID)
        }
        record(request)
        return stream
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
