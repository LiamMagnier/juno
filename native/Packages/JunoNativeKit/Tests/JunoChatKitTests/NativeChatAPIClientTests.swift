import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoChatKit

final class NativeChatAPIClientTests: XCTestCase {
    private let accountID = try! AccountID("account-a")

    func testCatalogAndIdempotentUserAppendUseExistingBearerRoutes() async throws {
        let sender = ChatQueueSender(responses: [
            response(#"{"manifestVersion":"v1-catalog","contractDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generatedAt":"2026-07-22T00:00:00.000Z","models":[{"id":"openai:gpt-5","provider":{"id":"openai","displayName":"OpenAI"},"displayName":"GPT-5","availability":"available","minimumPlan":"free","supportedReasoningEfforts":["low","high"],"reasoning":{"canDisable":true},"capabilities":{"streaming":true}}]}"#),
            response(#"{"conversationId":"conv_12345678","messages":[{"clientId":"client-12345678","id":"msg_12345678","role":"USER","content":"Hello Juno","createdAt":"2026-07-22T00:01:00.000Z","created":true}]}"#),
        ])
        let client = NativeChatAPIClient(sender: sender, streamer: EmptyChatStreamer())

        let catalog = try await client.modelCatalog(for: accountID)
        let appended = try await client.appendUserMessage(
            conversationID: "conv_12345678",
            clientID: "client-12345678",
            content: "  Hello Juno  ",
            for: accountID
        )

        XCTAssertEqual(catalog.models.map(\.id), ["openai:gpt-5"])
        XCTAssertEqual(catalog.models.first?.supportedReasoningEfforts, [.low, .high])
        XCTAssertEqual(appended.id, "msg_12345678")
        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.path), [
            "/api/v1/models",
            "/api/conversations/conv_12345678/messages",
        ])
        XCTAssertEqual(requests.last?.method, .post)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(requests.last?.body))
                as? [String: Any]
        )
        let turns = try XCTUnwrap(object["turns"] as? [[String: Any]])
        XCTAssertEqual(turns.first?["clientId"] as? String, "client-12345678")
        XCTAssertEqual(turns.first?["content"] as? String, "Hello Juno")
    }

    func testRealSSEFramesDecodeProgressivelyAndGenerationRequestDoesNotReappend() async throws {
        let body = """
        data: {"type":"meta","conversationId":"conv_12345678","userMessageId":null,"title":"A real chat","generationId":"juno-native-generation-1"}

        data: {"type":"reasoning","text":"Checking"}

        data: {"type":"delta","text":"Hello "}

        data: {"type":"delta","text":"there"}

        data: {"type":"sources","sources":[{"title":"Juno","url":"https://chat.liams.dev/docs","snippet":"Docs"}]}

        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hello there","reasoning":"Checking","model":"openai:gpt-5","createdAt":"2026-07-22T00:02:00.000Z","sources":[]},"artifacts":[],"memoryUpdated":false,"quota":{"plan":"FREE","used":1,"limit":10,"remaining":9},"finishReason":"stop"}

        """
        let streamer = ChatQueueStreamer(responses: [streamResponse(body)])
        let client = NativeChatAPIClient(sender: ChatQueueSender(), streamer: streamer)
        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "openai:gpt-5",
                reasoningEffort: .high,
                generationID: "juno-native-generation-1"
            ),
            for: accountID
        )
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }

        XCTAssertEqual(events.count, 6)
        XCTAssertEqual(events[1], .reasoningDelta("Checking"))
        XCTAssertEqual(events[2], .textDelta("Hello "))
        XCTAssertEqual(events[3], .textDelta("there"))
        guard case .completed(let completed) = events.last else {
            return XCTFail("Expected the authoritative done frame")
        }
        XCTAssertEqual(completed.id, "assistant_12345678")
        XCTAssertEqual(completed.content, "Hello there")
        XCTAssertEqual(completed.finishReason, .stop)

        let streamedRequests = await streamer.requests
        let request = try XCTUnwrap(streamedRequests.first)
        XCTAssertEqual(request.path, "/api/chat")
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(request.body))
                as? [String: Any]
        )
        XCTAssertEqual(object["conversationId"] as? String, "conv_12345678")
        XCTAssertEqual(object["regenerate"] as? Bool, true)
        XCTAssertNil(object["message"])
        XCTAssertEqual(object["client"] as? String, "app")
        XCTAssertEqual(object["reasoningEffort"] as? String, "high")
    }

    /// The prompt-cache split rides the live `done` frame — the server reads it
    /// off the in-flight accumulator, because `Message` has no column for it.
    func testDoneFrameCarriesThePromptCacheSplit() async throws {
        let body = """
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hi","reasoning":null,"model":"anthropic:claude-opus-5","createdAt":"2026-07-22T00:02:00.000Z","sources":[],"promptTokens":12000,"completionTokens":300,"costUsd":0.0182,"cacheReadTokens":9600,"cacheWriteTokens":1400},"finishReason":"stop"}

        """
        let streamer = ChatQueueStreamer(responses: [streamResponse(body)])
        let client = NativeChatAPIClient(sender: ChatQueueSender(), streamer: streamer)
        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "anthropic:claude-opus-5",
                reasoningEffort: .high,
                generationID: "juno-native-generation-1"
            ),
            for: accountID
        )
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }

        guard case .completed(let completed) = events.last else {
            return XCTFail("Expected the authoritative done frame")
        }
        XCTAssertEqual(completed.promptTokens, 12_000)
        XCTAssertEqual(completed.cacheReadTokens, 9_600)
        XCTAssertEqual(completed.cacheWriteTokens, 1_400)
        XCTAssertEqual(try XCTUnwrap(completed.cacheHitRate), 0.8, accuracy: 1e-9)
    }

    /// A persisted message re-read after a sync has no cache columns. Absent has
    /// to stay absent: rendering it as 0 would report a cache miss that never
    /// happened, and every older server sends exactly this shape.
    func testADoneFrameWithoutCacheFieldsLeavesThemUnknown() async throws {
        let body = """
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Hi","reasoning":null,"model":"openai:gpt-5","createdAt":"2026-07-22T00:02:00.000Z","sources":[],"promptTokens":900,"completionTokens":100},"finishReason":"stop"}

        """
        let streamer = ChatQueueStreamer(responses: [streamResponse(body)])
        let client = NativeChatAPIClient(sender: ChatQueueSender(), streamer: streamer)
        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "openai:gpt-5",
                reasoningEffort: .high,
                generationID: "juno-native-generation-1"
            ),
            for: accountID
        )
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }

        guard case .completed(let completed) = events.last else {
            return XCTFail("Expected the authoritative done frame")
        }
        XCTAssertEqual(completed.promptTokens, 900)
        XCTAssertNil(completed.cacheReadTokens)
        XCTAssertNil(completed.cacheWriteTokens)
        XCTAssertNil(completed.cacheHitRate)
    }

    func testStreamWithoutTerminalFrameRequiresSyncRecoveryInsteadOfRepost() async throws {
        let streamer = ChatQueueStreamer(responses: [streamResponse(
            "data: {\"type\":\"delta\",\"text\":\"Partial\"}\n\n"
        )])
        let client = NativeChatAPIClient(sender: ChatQueueSender(), streamer: streamer)
        let stream = try await client.generationEvents(
            NativeChatGenerationRequest(
                conversationID: "conv_12345678",
                modelID: "openai:gpt-5",
                reasoningEffort: nil,
                generationID: "juno-native-generation-2"
            ),
            for: accountID
        )
        do {
            for try await _ in stream {}
            XCTFail("A dropped SSE must enter recovery")
        } catch {
            XCTAssertEqual(
                error as? NativeChatAPIError,
                .streamEndedWithoutTerminalEvent
            )
        }
        let requestCount = await streamer.requests.count
        XCTAssertEqual(requestCount, 1)
    }

    func testV1ErrorEnvelopeKeepsCodeMessageAndRetryability() async throws {
        let sender = ChatQueueSender(responses: [response(
            #"{"error":{"code":"server_unavailable","message":"Catalog is warming up.","requestId":"req-1","retryable":true,"retryAfterMs":250}}"#,
            statusCode: 503
        )])
        let client = NativeChatAPIClient(sender: sender, streamer: EmptyChatStreamer())

        do {
            _ = try await client.modelCatalog(for: accountID)
            XCTFail("Expected the typed server failure")
        } catch {
            XCTAssertEqual(
                error as? NativeChatAPIError,
                .server(
                    statusCode: 503,
                    code: "server_unavailable",
                    message: "Catalog is warming up.",
                    retryable: true
                )
            )
        }
    }

    func testChatApprovalStreamRecoveryAndDigestBoundDecision() async throws {
        let pending = """
        {"id":"approval_12345678","surface":"chat","sessionId":"generation_12345678","conversationId":"conv_12345678","connectorId":"apple-mail","connectorLabel":"Apple Mail","toolName":"send_message","action":"send_message","riskClass":"external_write","preview":"Apple Mail wants to send a message.","detail":{"to":"person@example.com","subject":"Hello","body":"Safe preview"},"receiptDigest":"digest_12345678","status":"pending","decision":null,"canAllowScope":false,"derivedFromUntrusted":false,"expiresAt":"2026-07-22T00:15:00.000Z","decidedAt":null,"completedAt":null,"createdAt":"2026-07-22T00:00:00.000Z"}
        """
        let decided = """
        {"id":"approval_12345678","surface":"chat","sessionId":"generation_12345678","conversationId":"conv_12345678","connectorId":"apple-mail","connectorLabel":"Apple Mail","toolName":"send_message","action":"send_message","riskClass":"external_write","preview":"Apple Mail wants to send a message.","detail":{"to":"person@example.com","subject":"Hello","body":"Safe preview"},"receiptDigest":"digest_12345678","status":"allowed","decision":"allow_once","canAllowScope":false,"derivedFromUntrusted":false,"expiresAt":"2026-07-22T00:15:00.000Z","decidedAt":"2026-07-22T00:01:00.000Z","completedAt":null,"createdAt":"2026-07-22T00:00:00.000Z"}
        """
        let streamBody = """
        data: {"type":"meta","conversationId":"conv_12345678","userMessageId":null,"title":"Approval chat","generationId":"juno-native-generation-approval"}

        data: {"type":"approval","approval":\(pending)}

        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"Done","reasoning":null,"model":"openai:gpt-5","createdAt":"2026-07-22T00:02:00.000Z","sources":[]},"finishReason":"stop"}

        """
        let streamer = ChatQueueStreamer(responses: [streamResponse(streamBody)])
        let sender = ChatQueueSender(responses: [
            response(#"{"approvals":[\#(pending)]}"#),
            response(#"{"approval":\#(decided)}"#),
        ])
        let client = NativeChatAPIClient(sender: sender, streamer: streamer)

        let events = try await collect(
            client.generationEvents(
                NativeChatGenerationRequest(
                    conversationID: "conv_12345678",
                    modelID: "openai:gpt-5",
                    reasoningEffort: nil,
                    generationID: "juno-native-generation-approval"
                ),
                for: accountID
            )
        )
        guard case .approval(let streamedApproval) = events[1] else {
            return XCTFail("Expected the streamed approval receipt")
        }
        XCTAssertEqual(streamedApproval.receiptDigest, "digest_12345678")
        XCTAssertEqual(streamedApproval.detail["to"]?.stringValue, "person@example.com")

        let recovered = try await client.chatApprovals(
            conversationID: "conv_12345678",
            includeRecent: true,
            for: accountID
        )
        let approval = try XCTUnwrap(recovered.first)
        let result = try await client.decideChatApproval(
            approval,
            decision: .allowOnce,
            for: accountID
        )
        XCTAssertEqual(result.status, .allowed)
        XCTAssertEqual(result.receiptDigest, approval.receiptDigest)

        let requests = await sender.requests
        XCTAssertEqual(requests[0].path, "/api/approvals")
        XCTAssertEqual(
            requests[0].queryItems,
            [
                URLQueryItem(name: "conversationId", value: "conv_12345678"),
                URLQueryItem(name: "includeRecent", value: "1"),
            ]
        )
        XCTAssertEqual(requests[1].path, "/api/approvals/approval_12345678")
        let decisionBody = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(requests[1].body))
                as? [String: String]
        )
        XCTAssertEqual(decisionBody["decision"], "allow_once")
        XCTAssertEqual(decisionBody["receiptDigest"], "digest_12345678")
    }

    private func collect(
        _ stream: AsyncThrowingStream<NativeChatServerEvent, any Error>
    ) async throws -> [NativeChatServerEvent] {
        var events: [NativeChatServerEvent] = []
        for try await event in stream { events.append(event) }
        return events
    }

    private func response(_ body: String, statusCode: Int = 200) -> HTTPResponse {
        HTTPResponse(
            statusCode: statusCode,
            headers: try! HTTPHeaders(["content-type": "application/json"]),
            body: Data(body.utf8)
        )
    }

    private func streamResponse(_ body: String, statusCode: Int = 200)
        -> HTTPByteStreamResponse
    {
        let data = Data(body.utf8)
        return HTTPByteStreamResponse(
            statusCode: statusCode,
            headers: try! HTTPHeaders([
                "content-type": statusCode == 200
                    ? "text/event-stream; charset=utf-8" : "application/json",
            ]),
            bytes: AsyncThrowingStream { continuation in
                Task {
                    for byte in data {
                        continuation.yield(byte)
                        await Task.yield()
                    }
                    continuation.finish()
                }
            }
        )
    }
}

private actor ChatQueueSender: NativeAuthenticatedRequestSending {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse] = []) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws
        -> HTTPResponse
    {
        requests.append(request)
        guard !responses.isEmpty else {
            return HTTPResponse(
                statusCode: 500,
                headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
        }
        return responses.removeFirst()
    }
}

private actor ChatQueueStreamer: NativeAuthenticatedByteStreaming {
    private var responses: [HTTPByteStreamResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPByteStreamResponse]) { self.responses = responses }

    func stream(_ request: NativeBearerRequest, for _: AccountID) async throws
        -> HTTPByteStreamResponse
    {
        requests.append(request)
        return responses.removeFirst()
    }
}

private actor EmptyChatStreamer: NativeAuthenticatedByteStreaming {
    func stream(_: NativeBearerRequest, for _: AccountID) async throws
        -> HTTPByteStreamResponse
    {
        throw NativeChatAPIError.malformedResponse
    }
}
