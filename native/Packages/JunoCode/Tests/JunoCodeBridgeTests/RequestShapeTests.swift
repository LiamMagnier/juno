import XCTest
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeBridge

final class RequestShapeTests: XCTestCase {
    private func request(_ messages: [ModelMessage]) -> ModelTurnRequest {
        ModelTurnRequest(
            sessionID: CodeSessionID(),
            systemPrompt: "system",
            messages: messages,
            tools: [
                ModelToolDescriptor(name: "read_file", description: "r", inputSchema: ["type": "object"]),
                ModelToolDescriptor(name: "grep", description: "g", inputSchema: ["type": "object"]),
            ],
            modelID: "anthropic:claude-sonnet-5",
            reasoningEffort: nil
        )
    }

    private let loop: [ModelMessage] = [
        .user("Look"),
        .assistantThinking(text: "plan", signature: "sig"),
        .assistant("Reading both."),
        .toolCall(id: "a", name: "read_file", input: ["path": "a"]),
        .toolCall(id: "b", name: "grep", input: ["pattern": "x"]),
        .toolResult(id: "a", content: "A", isError: false),
        .toolResult(id: "b", content: "B", isError: false),
    ]

    func testAnthropicCachesToolsSystemAndTheNewestBlock() throws {
        let body = AnthropicRequestBuilder.body(for: request(loop), providerModelID: "claude-sonnet-5", maxTokens: 4_096)
        let system = try XCTUnwrap(body["system"]?.arrayValue?.first)
        XCTAssertEqual(system["cache_control"]?["type"]?.stringValue, "ephemeral")
        let tools = try XCTUnwrap(body["tools"]?.arrayValue)
        XCTAssertNil(tools[0]["cache_control"])
        XCTAssertEqual(tools[1]["cache_control"]?["type"]?.stringValue, "ephemeral")

        let messages = try XCTUnwrap(body["messages"]?.arrayValue)
        let lastBlock = try XCTUnwrap(messages.last?["content"]?.arrayValue?.last)
        XCTAssertEqual(lastBlock["cache_control"]?["type"]?.stringValue, "ephemeral")
        let breakpoints = messages.flatMap { $0["content"]?.arrayValue ?? [] }
            .filter { $0["cache_control"] != nil }
        // The newest block, and the previous request's newest: the prompt.
        XCTAssertEqual(breakpoints.count, 2)
        XCTAssertEqual(breakpoints.first?["text"]?.stringValue, "Look")
    }

    /// A step with ten parallel calls puts twenty-odd blocks between the
    /// newest breakpoint and the last cache write, past the lookback a
    /// breakpoint searches. The fourth breakpoint sits on that write itself.
    func testAnthropicMarksThePreviousRequestsTailSoWideStepsStillHitTheCache() throws {
        let calls = (0..<10).map { index in
            ModelMessage.toolCall(id: "c\(index)", name: "grep", input: ["pattern": .string("p\(index)")])
        }
        let results = (0..<10).map { index in
            ModelMessage.toolResult(id: "c\(index)", content: "r\(index)", isError: false)
        }
        let history: [ModelMessage] = [
            .user("First"),
            .assistant("One call."),
            .toolCall(id: "a", name: "read_file", input: ["path": "a"]),
            .toolResult(id: "a", content: "A", isError: false),
            .user("<session_state from=\"juno\" sections=\"goal:1\">\n<goal>\nx\n</goal>\n</session_state>"),
            .assistantThinking(text: "fan out", signature: "sig"),
        ] + calls + results
        let body = AnthropicRequestBuilder.body(
            for: request(history),
            providerModelID: "claude-sonnet-5",
            maxTokens: 4_096
        )
        let messages = try XCTUnwrap(body["messages"]?.arrayValue)
        XCTAssertEqual(messages.count, 5)
        // The user turn before the wide step ends in the state block, which
        // was the previous request's final block.
        let previousTail = try XCTUnwrap(messages[2]["content"]?.arrayValue)
        XCTAssertEqual(previousTail.map { $0["type"]?.stringValue }, ["tool_result", "text"])
        XCTAssertNil(previousTail[0]["cache_control"])
        XCTAssertEqual(previousTail[1]["cache_control"]?["type"]?.stringValue, "ephemeral")
        let newest = try XCTUnwrap(messages[4]["content"]?.arrayValue)
        XCTAssertEqual(newest.count, 10)
        XCTAssertEqual(newest.last?["cache_control"]?["type"]?.stringValue, "ephemeral")

        let marked = messages.flatMap { $0["content"]?.arrayValue ?? [] }
            .filter { $0["cache_control"] != nil }
        XCTAssertEqual(marked.count, 2, "two in the messages, plus tools and system: Anthropic's four")
    }

    func testAnthropicReplaysThinkingFirstInTheAssistantTurn() throws {
        let body = AnthropicRequestBuilder.body(for: request(loop), providerModelID: "claude-sonnet-5", maxTokens: 4_096)
        let messages = try XCTUnwrap(body["messages"]?.arrayValue)
        XCTAssertEqual(messages.count, 3)
        let assistant = try XCTUnwrap(messages[1]["content"]?.arrayValue)
        XCTAssertEqual(assistant.map { $0["type"]?.stringValue }, ["thinking", "text", "tool_use", "tool_use"])
        XCTAssertEqual(assistant[0]["signature"]?.stringValue, "sig")
    }

    /// Chat Completions requires every `tool` message to answer the assistant
    /// message right before it; one assistant message per call was a 400.
    func testOpenAIChatGroupsParallelCallsIntoOneAssistantMessage() throws {
        let body = OpenAIChatRequestBuilder.body(
            for: request(loop),
            providerModelID: "gpt-5.6-sol",
            providerID: "openai",
            maxTokens: 4_096
        )
        let messages = try XCTUnwrap(body["messages"]?.arrayValue)
        XCTAssertEqual(messages.map { $0["role"]?.stringValue }, ["system", "user", "assistant", "tool", "tool"])
        XCTAssertEqual(messages[2]["tool_calls"]?.arrayValue?.count, 2)
        XCTAssertEqual(messages[2]["content"]?.stringValue, "Reading both.")
    }

    func testThinkingDeltasAssembleIntoOneSignedBlock() throws {
        var decoder = AnthropicStreamDecoder()
        var events: [ModelStreamEvent] = []
        for line in [
            #"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan "}}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"it."}}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}"#,
            #"{"type":"content_block_stop","index":0}"#,
            #"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"cache_read_input_tokens":900,"output_tokens":5}}"#,
        ] {
            events += try decoder.events(from: Data(line.utf8))
        }
        let blocks = events.compactMap { event -> String? in
            if case let .thinkingBlock(text, signature) = event { return text + "|" + signature }
            return nil
        }
        XCTAssertEqual(blocks, ["Plan it.|abc"])
        let usage = events.compactMap { event -> Int? in
            if case let .usage(input, _) = event { return input }
            return nil
        }
        XCTAssertEqual(usage, [910], "the context meter must count cached tokens too")
    }

    func testPlanBudgetRefusalIsNotAProviderQuota() {
        XCTAssertNotEqual(
            AgentModelClientError.planLimitReached(message: "x"),
            AgentModelClientError.quotaExhausted(message: "x")
        )
    }
}
