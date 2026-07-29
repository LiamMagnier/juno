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
        modelID: String = "anthropic:claude-sonnet-5"
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

    private func imageToolMessages() -> [ModelMessage] {
        [
            .toolCall(id: "capture-1", name: "computer_screenshot", input: [:]),
            .toolResultWithImages(
                id: "capture-1",
                content: "Screenshot captured.",
                isError: false,
                images: [
                    ModelImage(
                        mediaType: "image/png",
                        data: Data([0x01, 0x02, 0x03]),
                        detail: .high
                    ),
                ]
            ),
        ]
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

    func testAnthropicImageToolResultUsesNestedBase64ImageBlock() throws {
        let json = AnthropicRequestBuilder.body(
            for: makeRequest(messages: imageToolMessages()),
            providerModelID: "claude-sonnet-5",
            maxTokens: 1_024
        )
        let messages = try XCTUnwrap(json["messages"]?.arrayValue)
        XCTAssertEqual(messages.count, 2)
        let toolResult = try XCTUnwrap(messages[1]["content"]?.arrayValue?.first)
        XCTAssertEqual(toolResult["type"]?.stringValue, "tool_result")
        XCTAssertEqual(toolResult["tool_use_id"]?.stringValue, "capture-1")

        let content = try XCTUnwrap(toolResult["content"]?.arrayValue)
        XCTAssertEqual(content.count, 2)
        XCTAssertEqual(content[0]["type"]?.stringValue, "text")
        XCTAssertEqual(content[0]["text"]?.stringValue, "Screenshot captured.")
        XCTAssertFalse(content[0]["text"]?.stringValue?.contains("data:") == true)

        XCTAssertEqual(content[1]["type"]?.stringValue, "image")
        let source = try XCTUnwrap(content[1]["source"])
        XCTAssertEqual(source["type"]?.stringValue, "base64")
        XCTAssertEqual(source["media_type"]?.stringValue, "image/png")
        XCTAssertEqual(source["data"]?.stringValue, "AQID")
        XCTAssertFalse(source["data"]?.stringValue?.contains("data:") == true)
    }

    func testOpenAIChatImageToolResultKeepsDataURLOutOfToolText() throws {
        let json = OpenAIChatRequestBuilder.body(
            for: makeRequest(
                messages: imageToolMessages(),
                modelID: "openai:gpt-5.6-sol"
            ),
            providerModelID: "gpt-5.6-sol",
            providerID: "openai",
            maxTokens: 1_024
        )
        let messages = try XCTUnwrap(json["messages"]?.arrayValue)
        XCTAssertEqual(messages.count, 4)

        let toolResult = messages[2]
        XCTAssertEqual(toolResult["role"]?.stringValue, "tool")
        XCTAssertEqual(toolResult["tool_call_id"]?.stringValue, "capture-1")
        XCTAssertEqual(toolResult["content"]?.stringValue, "Screenshot captured.")
        XCTAssertFalse(toolResult["content"]?.stringValue?.contains("data:") == true)

        let imageMessage = messages[3]
        XCTAssertEqual(imageMessage["role"]?.stringValue, "user")
        let image = try XCTUnwrap(imageMessage["content"]?.arrayValue?.first)
        XCTAssertEqual(image["type"]?.stringValue, "image_url")
        XCTAssertEqual(image["image_url"]?["url"]?.stringValue, "data:image/png;base64,AQID")
        XCTAssertEqual(image["image_url"]?["detail"]?.stringValue, "high")
    }

    func testOpenAIResponsesImageToolResultKeepsDataURLOutOfFunctionOutput() throws {
        let json = OpenAIResponsesRequestBuilder.body(
            for: makeRequest(
                messages: imageToolMessages(),
                modelID: "openai:gpt-5.3-codex"
            ),
            providerModelID: "gpt-5.3-codex",
            maxTokens: 1_024
        )
        let input = try XCTUnwrap(json["input"]?.arrayValue)
        XCTAssertEqual(input.count, 3)

        let toolResult = input[1]
        XCTAssertEqual(toolResult["type"]?.stringValue, "function_call_output")
        XCTAssertEqual(toolResult["call_id"]?.stringValue, "capture-1")
        XCTAssertEqual(toolResult["output"]?.stringValue, "Screenshot captured.")
        XCTAssertFalse(toolResult["output"]?.stringValue?.contains("data:") == true)

        let imageMessage = input[2]
        XCTAssertEqual(imageMessage["role"]?.stringValue, "user")
        let image = try XCTUnwrap(imageMessage["content"]?.arrayValue?.first)
        XCTAssertEqual(image["type"]?.stringValue, "input_image")
        XCTAssertEqual(image["image_url"]?.stringValue, "data:image/png;base64,AQID")
        XCTAssertEqual(image["detail"]?.stringValue, "high")
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
        let (_, error) = await collect(client, makeRequest(modelID: "juno:auto"))
        guard case AgentModelClientError.invalidResponse? = error as? AgentModelClientError else {
            return XCTFail("expected invalidResponse for unsupported model")
        }
        XCTAssertNil(streamer.lastRequest, "an unsupported model must not hit the transport")
    }

    func testProviderResolverDefaults() {
        XCTAssertEqual(CodeModelProviderResolver.default.provider(for: "claude-sonnet-5"), .anthropic)
        XCTAssertEqual(CodeModelProviderResolver.default.provider(for: "anthropic/x"), .anthropic)
        XCTAssertNil(CodeModelProviderResolver.default.provider(for: "gpt-5.2"))
        XCTAssertEqual(
            CodeModelProviderResolver.default.route(for: "openai:gpt-5.6-sol"),
            CodeModelRoute(
                providerID: "openai",
                providerModelID: "gpt-5.6-sol",
                wireProtocol: .openAIChat
            )
        )
        XCTAssertEqual(
            CodeModelProviderResolver.default.route(for: "openai:gpt-5.3-codex"),
            CodeModelRoute(
                providerID: "openai",
                providerModelID: "gpt-5.3-codex",
                wireProtocol: .openAIResponses
            )
        )
        XCTAssertEqual(
            CodeModelProviderResolver.default.route(for: "google:gemini-3.5-pro"),
            CodeModelRoute(
                providerID: "google",
                providerModelID: "gemini-3.5-pro",
                wireProtocol: .openAIChat
            )
        )
        XCTAssertFalse(CodeModelProviderResolver.supports("juno:auto"))
    }

    func testOpenAICompatibleTurnUsesRawModelAndAssemblesTools() async throws {
        let sse = """
        data: {"choices":[{"delta":{"content":"Checking. ","reasoning_content":"Inspect first.","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}

        data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"src/main.swift\\"}"}}]},"finish_reason":null}]}

        data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

        data: [DONE]

        """
        let streamer = FakeByteStreamer(canned: .init(body: Data(sse.utf8)))
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let (events, error) = await collect(
            client,
            makeRequest(modelID: "google:gemini-3.5-pro")
        )
        XCTAssertNil(error)
        XCTAssertEqual(streamer.lastRequest?.path, "/api/agent/google/chat/completions")
        let body = try XCTUnwrap(streamer.lastRequest?.body)
        let json = try JSONDecoder().decode(JSONValue.self, from: body)
        XCTAssertEqual(json["model"]?.stringValue, "gemini-3.5-pro")
        XCTAssertNotNil(json["max_tokens"])
        XCTAssertNil(json["max_completion_tokens"])
        XCTAssertTrue(events.contains {
            if case .reasoningSummary("Inspect first.") = $0 { return true }
            return false
        })
        XCTAssertTrue(events.contains {
            if case let .toolCallRequested(id, name, input) = $0 {
                return id == "call_1" && name == "read_file"
                    && input["path"]?.stringValue == "src/main.swift"
            }
            return false
        })
        guard case .turnCompleted(.toolUse) = events.last else {
            return XCTFail("expected tool-use completion")
        }
    }

    func testResponsesTurnUsesResponsesEndpointAndToolEvents() async throws {
        let sse = """
        data: {"type":"response.reasoning_summary_text.delta","delta":"I will inspect."}

        data: {"type":"response.output_text.delta","delta":"Reading the file."}

        data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_2","name":"read_file","arguments":"{\\"path\\":\\"Package.swift\\"}"}}

        data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}

        """
        let streamer = FakeByteStreamer(canned: .init(body: Data(sse.utf8)))
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let (events, error) = await collect(
            client,
            makeRequest(modelID: "openai:gpt-5.3-codex")
        )
        XCTAssertNil(error)
        XCTAssertEqual(streamer.lastRequest?.path, "/api/agent/openai/responses")
        let body = try XCTUnwrap(streamer.lastRequest?.body)
        let json = try JSONDecoder().decode(JSONValue.self, from: body)
        XCTAssertEqual(json["model"]?.stringValue, "gpt-5.3-codex")
        XCTAssertEqual(json["store"]?.boolValue, false)
        XCTAssertEqual(json["reasoning"]?["effort"]?.stringValue, "medium")
        XCTAssertTrue(events.contains {
            if case let .toolCallRequested(id, name, input) = $0 {
                return id == "call_2" && name == "read_file"
                    && input["path"]?.stringValue == "Package.swift"
            }
            return false
        })
        guard case .turnCompleted(.toolUse) = events.last else {
            return XCTFail("expected tool-use completion")
        }
    }
}
