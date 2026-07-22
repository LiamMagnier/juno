import XCTest
import JunoCodeCore
import JunoCodeRuntime
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
@testable import JunoCodeBridge

/// A byte-stream transport that replays a canned response, capturing the
/// request body for assertions.
private final class FakeByteStreamer: NativeAuthenticatedByteStreaming, @unchecked Sendable {
    struct Canned {
        var statusCode = 200
        var contentType = "text/event-stream"
        var body: Data
    }

    private let canned: Canned
    private(set) var lastRequest: NativeBearerRequest?

    init(canned: Canned) {
        self.canned = canned
    }

    func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPByteStreamResponse {
        lastRequest = request
        let bytes = AsyncThrowingStream<UInt8, any Error> { continuation in
            for byte in canned.body { continuation.yield(byte) }
            continuation.finish()
        }
        return HTTPByteStreamResponse(
            statusCode: canned.statusCode,
            headers: try! HTTPHeaders(["Content-Type": canned.contentType]),
            bytes: bytes
        )
    }
}

/// A transport whose stream throws partway, simulating a network drop.
private struct DroppingByteStreamer: NativeAuthenticatedByteStreaming {
    struct DropError: Error {}
    let prefix: Data

    func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPByteStreamResponse {
        let prefix = self.prefix
        let bytes = AsyncThrowingStream<UInt8, any Error> { continuation in
            for byte in prefix { continuation.yield(byte) }
            continuation.finish(throwing: DropError())
        }
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try! HTTPHeaders(["Content-Type": "text/event-stream"]),
            bytes: bytes
        )
    }
}

final class BackendCodeModelClientTests: XCTestCase {
    private let accountID = try! AccountID("account-1")

    private func makeRequest(
        messages: [ModelMessage] = [.user("Hello")],
        modelID: String = "claude-sonnet-5"
    ) -> ModelTurnRequest {
        ModelTurnRequest(
            sessionID: CodeSessionID(),
            systemPrompt: "You are Juno Code.",
            messages: messages,
            tools: [
                ModelToolDescriptor(
                    name: "read_file",
                    description: "Read a file",
                    inputSchema: [
                        "type": "object",
                        "properties": ["path": ["type": "string"]],
                        "required": ["path"],
                    ]
                )
            ],
            modelID: modelID,
            reasoningEffort: .medium
        )
    }

    private func collect(
        _ client: BackendCodeModelClient,
        _ request: ModelTurnRequest
    ) async -> (events: [ModelStreamEvent], error: Error?) {
        var events: [ModelStreamEvent] = []
        do {
            for try await event in client.streamTurn(request) {
                events.append(event)
            }
            return (events, nil)
        } catch {
            return (events, error)
        }
    }

    func testTextTurnStreamsDeltasAndCompletes() async {
        let sse = """
        event: message_start
        data: {"type":"message_start","message":{"id":"msg_1"}}

        event: content_block_start
        data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

        event: content_block_delta
        data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}

        event: content_block_delta
        data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there."}}

        event: content_block_stop
        data: {"type":"content_block_stop","index":0}

        event: message_delta
        data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

        event: message_stop
        data: {"type":"message_stop"}

        """
        let streamer = FakeByteStreamer(canned: .init(body: Data(sse.utf8)))
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let (events, error) = await collect(client, makeRequest())
        XCTAssertNil(error)
        let text = events.compactMap { event -> String? in
            if case let .textDelta(delta) = event { return delta }
            return nil
        }.joined()
        XCTAssertEqual(text, "Hello there.")
        guard case .turnCompleted(.endTurn) = events.last else {
            return XCTFail("expected endTurn completion, got \(String(describing: events.last))")
        }
    }

    func testToolUseTurnAssemblesInputAndReportsToolUse() async {
        let sse = """
        event: content_block_start
        data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}

        event: content_block_delta
        data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}

        event: content_block_delta
        data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"src/main.swift\\"}"}}

        event: content_block_stop
        data: {"type":"content_block_stop","index":0}

        event: message_delta
        data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}

        event: message_stop
        data: {"type":"message_stop"}

        """
        let streamer = FakeByteStreamer(canned: .init(body: Data(sse.utf8)))
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let (events, error) = await collect(client, makeRequest())
        XCTAssertNil(error)
        guard let call = events.compactMap({ event -> (String, String, JSONValue)? in
            if case let .toolCallRequested(id, name, input) = event { return (id, name, input) }
            return nil
        }).first else {
            return XCTFail("expected a tool call")
        }
        XCTAssertEqual(call.0, "toolu_1")
        XCTAssertEqual(call.1, "read_file")
        XCTAssertEqual(call.2["path"]?.stringValue, "src/main.swift")
        guard case .turnCompleted(.toolUse) = events.last else {
            return XCTFail("expected toolUse completion")
        }
    }

    func testRequestBodyIsAnthropicShaped() async throws {
        let sse = """
        data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

        data: {"type":"message_stop"}

        """
        let streamer = FakeByteStreamer(canned: .init(body: Data(sse.utf8)))
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        _ = await collect(
            client,
            makeRequest(messages: [
                .user("Fix it"),
                .assistant("Reading."),
                .toolCall(id: "t1", name: "read_file", input: ["path": "a.swift"]),
                .toolResult(id: "t1", content: "contents", isError: false),
            ])
        )
        let request = try XCTUnwrap(streamer.lastRequest)
        XCTAssertEqual(request.path, "/api/agent/anthropic/v1/messages")
        XCTAssertEqual(request.method, .post)
        XCTAssertEqual(request.headers["accept"], "text/event-stream")
        let body = try XCTUnwrap(request.body)
        let json = try JSONDecoder().decode(JSONValue.self, from: body)
        XCTAssertEqual(json["model"]?.stringValue, "claude-sonnet-5")
        XCTAssertEqual(json["stream"]?.boolValue, true)
        XCTAssertNotNil(json["tools"]?.arrayValue)
        // Adjacent assistant text + tool_use merge into one assistant message;
        // the tool_result becomes a following user message.
        let messages = try XCTUnwrap(json["messages"]?.arrayValue)
        XCTAssertEqual(messages.count, 3) // user, assistant(text+tool_use), user(tool_result)
        XCTAssertEqual(messages[0]["role"]?.stringValue, "user")
        XCTAssertEqual(messages[1]["role"]?.stringValue, "assistant")
        XCTAssertEqual(messages[1]["content"]?.arrayValue?.count, 2)
        XCTAssertEqual(messages[2]["role"]?.stringValue, "user")
        XCTAssertEqual(
            messages[2]["content"]?.arrayValue?.first?["type"]?.stringValue,
            "tool_result"
        )
    }

    func testDroppedStreamWithoutCompletionThrows() async {
        // A valid text delta, then the connection dies before message_stop.
        let prefix = """
        data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}

        """
        let streamer = DroppingByteStreamer(prefix: Data(prefix.utf8))
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let (events, error) = await collect(client, makeRequest())
        XCTAssertNotNil(error, "a dropped stream must fail, never a false success")
        XCTAssertFalse(events.contains {
            if case .turnCompleted = $0 { return true }
            return false
        })
    }

    func testCleanStreamEndWithoutCompletionThrows() async {
        // Stream ends normally but no terminal message_stop arrived.
        let sse = """
        data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}

        """
        let streamer = FakeByteStreamer(canned: .init(body: Data(sse.utf8)))
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let (_, error) = await collect(client, makeRequest())
        guard case AgentModelClientError.transport? = error as? AgentModelClientError else {
            return XCTFail("expected transport failure, got \(String(describing: error))")
        }
    }

    func testErrorEventThrows() async {
        let sse = """
        data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}

        """
        let streamer = FakeByteStreamer(canned: .init(body: Data(sse.utf8)))
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let (_, error) = await collect(client, makeRequest())
        guard case let AgentModelClientError.transport(message)? = error as? AgentModelClientError else {
            return XCTFail("expected transport error")
        }
        XCTAssertEqual(message, "Overloaded")
    }

    func testNon2xxThrowsWithServerMessage() async {
        let body = #"{"error":"Rate limit exceeded. Try again shortly."}"#
        let streamer = FakeByteStreamer(
            canned: .init(statusCode: 429, contentType: "application/json", body: Data(body.utf8))
        )
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let (_, error) = await collect(client, makeRequest())
        guard case let AgentModelClientError.transport(message)? = error as? AgentModelClientError else {
            return XCTFail("expected transport error")
        }
        XCTAssertEqual(message, "Rate limit exceeded. Try again shortly.")
    }

    func testUnsupportedModelFailsClosed() async {
        let streamer = FakeByteStreamer(canned: .init(body: Data()))
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let (_, error) = await collect(client, makeRequest(modelID: "gpt-5.2"))
        guard case AgentModelClientError.invalidResponse? = error as? AgentModelClientError else {
            return XCTFail("expected invalidResponse for unsupported model")
        }
        XCTAssertNil(streamer.lastRequest, "an unsupported model must not hit the transport")
    }

    func testProviderResolverDefaults() {
        XCTAssertEqual(CodeModelProviderResolver.default.provider(for: "claude-sonnet-5"), .anthropic)
        XCTAssertEqual(CodeModelProviderResolver.default.provider(for: "anthropic/x"), .anthropic)
        XCTAssertNil(CodeModelProviderResolver.default.provider(for: "gpt-5.2"))
    }
}
