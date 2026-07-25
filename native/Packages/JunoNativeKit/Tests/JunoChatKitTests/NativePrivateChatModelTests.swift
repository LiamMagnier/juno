import JunoCore
import XCTest
@testable import JunoChatKit

/// The incognito session's contract, which is mostly about what it does *not* do.
@MainActor
final class NativePrivateChatModelTests: XCTestCase {
    private func makeAccount() throws -> AccountID { try AccountID("account-1") }

    // MARK: - History

    /// The server keeps no history for a private chat, so the whole transcript
    /// travels with every request. Getting this wrong means the model answers each
    /// turn as though it were the first.
    func testSendsTheWholeTranscriptWithEachTurn() async throws {
        let client = RecordingClient()
        let model = NativePrivateChatModel(client: client)
        model.start(for: try makeAccount())

        model.send(prompt: "first", modelID: "anthropic:opus", reasoningEffort: nil)
        await client.waitForRequest()
        XCTAssertEqual(client.requests.count, 1)
        XCTAssertEqual(
            client.requests[0].history.map(\.content),
            ["first"]
        )

        client.finish(with: "one")
        await model.settle()

        model.send(prompt: "second", modelID: "anthropic:opus", reasoningEffort: nil)
        await client.waitForRequest()
        XCTAssertEqual(
            client.requests[1].history.map(\.content),
            ["first", "one", "second"],
            "The second turn must carry the first exchange."
        )
        XCTAssertEqual(
            client.requests[1].history.map(\.role),
            [.user, .assistant, .user]
        )
    }

    /// The empty assistant placeholder the UI streams into must NOT be sent — a
    /// blank assistant turn makes the model answer its own silence.
    func testTheEmptyAssistantPlaceholderIsNotSent() async throws {
        let client = RecordingClient()
        let model = NativePrivateChatModel(client: client)
        model.start(for: try makeAccount())

        model.send(prompt: "hello", modelID: "m", reasoningEffort: nil)
        await client.waitForRequest()

        XCTAssertEqual(model.turns.count, 2, "The UI needs a placeholder to stream into.")
        XCTAssertEqual(client.requests[0].history.count, 1, "But it must not be sent.")
        XCTAssertFalse(client.requests[0].history.contains { $0.content.isEmpty })
    }

    // MARK: - Streaming

    func testStreamsDeltasIntoTheAssistantTurn() async throws {
        let client = RecordingClient()
        let model = NativePrivateChatModel(client: client)
        model.start(for: try makeAccount())
        model.send(prompt: "hi", modelID: "m", reasoningEffort: nil)
        await client.waitForRequest()

        client.emit(.textDelta("Hel"))
        client.emit(.textDelta("lo"))
        client.emit(.reasoningDelta("thinking"))
        await model.settle()

        XCTAssertEqual(model.turns.last?.content, "Hello")
        XCTAssertEqual(model.turns.last?.reasoning, "thinking")
    }

    /// The server's own final text wins: a reconnect can replay a delta, and the
    /// persisted path already resolves that the same way.
    func testTheCompletedMessageReplacesAccumulatedDeltas() async throws {
        let client = RecordingClient()
        let model = NativePrivateChatModel(client: client)
        model.start(for: try makeAccount())
        model.send(prompt: "hi", modelID: "m", reasoningEffort: nil)
        await client.waitForRequest()

        client.emit(.textDelta("Hel"))
        client.emit(.textDelta("Hello"))
        client.finish(with: "Hello")
        await model.settle()

        XCTAssertEqual(model.turns.last?.content, "Hello")
        XCTAssertFalse(model.isStreaming)
    }

    func testAFailureIsSurfacedAndStopsStreaming() async throws {
        let client = RecordingClient()
        let model = NativePrivateChatModel(client: client)
        model.start(for: try makeAccount())
        model.send(prompt: "hi", modelID: "m", reasoningEffort: nil)
        await client.waitForRequest()

        client.emit(
            .failed(message: "Budget exceeded", finishReason: .error, generationID: nil, userMessageID: nil)
        )
        await model.settle()

        XCTAssertEqual(model.lastErrorDescription, "Budget exceeded")
        XCTAssertFalse(model.isStreaming)
    }

    // MARK: - Nothing survives

    /// The whole promise. Resetting has to leave nothing behind, because there is
    /// no other copy and no way to reopen the session.
    func testResetDropsTheTranscript() async throws {
        let client = RecordingClient()
        let model = NativePrivateChatModel(client: client)
        model.start(for: try makeAccount())
        model.send(prompt: "secret", modelID: "m", reasoningEffort: nil)
        await client.waitForRequest()
        client.finish(with: "answer")
        await model.settle()
        XCTAssertFalse(model.isEmpty)

        model.reset()
        XCTAssertTrue(model.isEmpty)
        XCTAssertNil(model.lastErrorDescription)
        XCTAssertFalse(model.isStreaming)
    }

    /// Signing out, or switching account, must not leave one account's incognito
    /// transcript visible to the next.
    func testStoppingClearsEverythingAndRefusesToSend() async throws {
        let client = RecordingClient()
        let model = NativePrivateChatModel(client: client)
        model.start(for: try makeAccount())
        model.send(prompt: "secret", modelID: "m", reasoningEffort: nil)
        await client.waitForRequest()

        model.stop()
        XCTAssertTrue(model.isEmpty)

        // With no account there is nothing to send as.
        model.send(prompt: "again", modelID: "m", reasoningEffort: nil)
        XCTAssertTrue(model.isEmpty)
        XCTAssertEqual(client.requests.count, 1)
    }

    func testEmptyPromptsAreIgnored() async throws {
        let client = RecordingClient()
        let model = NativePrivateChatModel(client: client)
        model.start(for: try makeAccount())

        model.send(prompt: "   \n ", modelID: "m", reasoningEffort: nil)
        XCTAssertTrue(model.isEmpty)
        XCTAssertTrue(client.requests.isEmpty)
    }

    /// One generation at a time. A second send while streaming would interleave two
    /// answers into the same placeholder.
    func testASecondSendIsRefusedWhileStreaming() async throws {
        let client = RecordingClient()
        let model = NativePrivateChatModel(client: client)
        model.start(for: try makeAccount())
        model.send(prompt: "one", modelID: "m", reasoningEffort: nil)
        await client.waitForRequest()

        model.send(prompt: "two", modelID: "m", reasoningEffort: nil)
        XCTAssertEqual(client.requests.count, 1)
        XCTAssertEqual(model.turns.count, 2)
    }
}

// MARK: - Doubles

/// Captures requests and lets a test drive the event stream by hand.
private final class RecordingClient: NativePrivateChatSending, @unchecked Sendable {
    private let lock = NSLock()
    private var storedRequests: [NativeChatPrivateGenerationRequest] = []
    private var continuation: AsyncThrowingStream<NativeChatServerEvent, any Error>.Continuation?

    var requests: [NativeChatPrivateGenerationRequest] {
        lock.lock(); defer { lock.unlock() }; return storedRequests
    }

    func privateGenerationEvents(
        _ request: NativeChatPrivateGenerationRequest,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<NativeChatServerEvent, any Error> {
        // `NSLock.lock()` is unavailable from an async context, so the mutation is
        // pushed into a synchronous helper rather than held across a suspension.
        record(request)
        return AsyncThrowingStream { continuation in
            store(continuation)
        }
    }

    private func record(_ request: NativeChatPrivateGenerationRequest) {
        lock.lock(); defer { lock.unlock() }
        storedRequests.append(request)
    }

    private func store(
        _ continuation: AsyncThrowingStream<NativeChatServerEvent, any Error>.Continuation
    ) {
        lock.lock(); defer { lock.unlock() }
        self.continuation = continuation
    }

    func emit(_ event: NativeChatServerEvent) {
        lock.lock(); let continuation = self.continuation; lock.unlock()
        continuation?.yield(event)
    }

    func finish(with content: String) {
        emit(
            .completed(
                NativeCompletedChatMessage(
                    id: "private-1",
                    content: content,
                    reasoning: nil,
                    model: "m",
                    createdAt: Date(timeIntervalSince1970: 0),
                    sources: [],
                    finishReason: .stop
                )
            )
        )
        lock.lock(); let continuation = self.continuation; lock.unlock()
        continuation?.finish()
    }

    /// Waits for the model's send task to reach the client. Polling rather than a
    /// continuation because the model owns the `Task` and does not expose it.
    func waitForRequest() async {
        let target = requests.count + 1
        for _ in 0..<200 where requests.count < target {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(5))
        }
    }
}

private extension NativePrivateChatModel {
    /// Lets queued main-actor work from the event stream land before asserting.
    func settle() async {
        for _ in 0..<20 {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(5))
        }
    }
}
