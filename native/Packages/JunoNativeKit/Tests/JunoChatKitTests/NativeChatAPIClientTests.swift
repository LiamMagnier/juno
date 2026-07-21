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
