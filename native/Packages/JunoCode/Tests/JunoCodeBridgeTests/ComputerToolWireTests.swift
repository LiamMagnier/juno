import XCTest
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeBridge

/// Computer use on each provider's wire (CODE_AGENT_SPEC §3.4).
final class ComputerToolWireTests: XCTestCase {
    private let computerTool = ModelToolDescriptor(
        name: "computer", description: "Operate one Mac app.",
        inputSchema: ["type": "object", "properties": ["action": ["type": "string"]], "required": ["action"]]
    )
    private let batchTool = ModelToolDescriptor(name: "computer_batch", description: "Batch.", inputSchema: ["type": "object"])
    private let appsTool = ModelToolDescriptor(name: "computer_apps", description: "Apps.", inputSchema: ["type": "object"])
    private let readTool = ModelToolDescriptor(name: "read_file", description: "Read.", inputSchema: ["type": "object"])

    private func request(_ messages: [ModelMessage] = [.user("Fix the export sheet")], tools: [ModelToolDescriptor]? = nil) -> ModelTurnRequest {
        ModelTurnRequest(
            sessionID: CodeSessionID(),
            systemPrompt: "system",
            messages: messages,
            tools: tools ?? [readTool, computerTool, batchTool, appsTool],
            modelID: "anthropic:claude-opus-5-5",
            reasoningEffort: nil
        )
    }

    private func anthropic(_ request: ModelTurnRequest, model: String) -> JSONValue {
        ComputerToolWire.anthropic(
            AnthropicRequestBuilder.body(for: request, providerModelID: model, maxTokens: 1_024),
            providerModelID: model
        )
    }

    func testOpus55DeclaresTheToolsetAndNeverTheOldTool() throws {
        let body = anthropic(request(), model: "claude-opus-5-5")
        let tools = try XCTUnwrap(body["tools"]?.arrayValue)
        let toolsets = tools.filter { $0["type"]?.stringValue == "computer_toolset_20260801" }
        XCTAssertEqual(toolsets.count, 1)
        XCTAssertNil(toolsets[0]["name"], "the toolset entry has no name")
        XCTAssertNil(toolsets[0]["display_width_px"], "and no display size")
        XCTAssertFalse(tools.contains { $0["name"]?.stringValue == "computer" }, "no other tool may be named computer")
        XCTAssertFalse(tools.contains { $0["name"]?.stringValue == "computer_batch" }, "the toolset batches natively")
        XCTAssertTrue(tools.contains { $0["name"]?.stringValue == "computer_apps" })
        let encoded = body.canonicalJSONString()
        XCTAssertFalse(encoded.contains("computer_20251124"), "400 on Opus 5.5 since 2026-09-22")
        XCTAssertFalse(encoded.contains("computer-use-2025-11-24"))
        // The tools breakpoint stays on a function tool.
        XCTAssertNotNil(tools.last?["cache_control"])
        XCTAssertNotNil(tools.last?["name"])
    }

    func testModelsWithoutTheToolsetKeepTheFunctionTool() throws {
        for model in ["claude-haiku-4-5", "claude-sonnet-5", "claude-fable-5-1"] {
            let body = anthropic(request(), model: model)
            let tools = try XCTUnwrap(body["tools"]?.arrayValue)
            XCTAssertTrue(tools.contains { $0["name"]?.stringValue == "computer" }, model)
            XCTAssertFalse(body.canonicalJSONString().contains("computer_toolset_20260801"), model)
            XCTAssertFalse(body.canonicalJSONString().contains("computer_20251124"), model)
        }
    }

    func testReplayedHistoryGoesOutAsToolsetMembersWithToolsetNameOnEveryResult() throws {
        let messages: [ModelMessage] = [
            .user("Save it"),
            .toolCall(id: "toolu_1", name: "computer", input: ["action": "left_click", "coordinate": [412, 300], "app": "com.apple.TextEdit"]),
            .toolCall(id: "toolu_2", name: "read_file", input: ["path": "a.swift"]),
            .toolResultWithImages(id: "toolu_1", content: "Clicked.", isError: false, images: [ModelImage(mediaType: "image/png", data: Data([1, 2, 3]), detail: .original)]),
            .toolResult(id: "toolu_2", content: "file", isError: false),
        ]
        let body = anthropic(request(messages), model: "claude-opus-5-5")
        let all = try XCTUnwrap(body["messages"]?.arrayValue).flatMap { $0["content"]?.arrayValue ?? [] }
        let use = try XCTUnwrap(all.first { $0["id"]?.stringValue == "toolu_1" })
        XCTAssertEqual(use["name"]?.stringValue, "left_click", "the action is the block's name")
        XCTAssertEqual(use["toolset_name"]?.stringValue, "computer")
        XCTAssertNil(use["input"]?["action"])
        XCTAssertNil(use["input"]?["app"], "Juno's own fields are not toolset fields")
        XCTAssertEqual(use["input"]?["coordinate"], [412, 300])
        let result = try XCTUnwrap(all.first { $0["tool_use_id"]?.stringValue == "toolu_1" })
        XCTAssertEqual(result["toolset_name"]?.stringValue, "computer", "a result without it is rejected")
        let other = try XCTUnwrap(all.first { $0["tool_use_id"]?.stringValue == "toolu_2" })
        XCTAssertNil(other["toolset_name"])
        let read = try XCTUnwrap(all.first { $0["id"]?.stringValue == "toolu_2" })
        XCTAssertEqual(read["name"]?.stringValue, "read_file")
    }

    func testAToolsetMemberCallComesBackAsTheComputerTool() throws {
        var decoder = AnthropicStreamDecoder()
        _ = try decoder.events(from: Data(
            #"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"left_click","toolset_name":"computer","input":{}}}"#.utf8
        ))
        _ = try decoder.events(from: Data(
            #"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"coordinate\": [10, 20]}"}}"#.utf8
        ))
        let events = try decoder.events(from: Data(#"{"type":"content_block_stop","index":1}"#.utf8))
        guard case let .toolCallRequested(id, name, input)? = events.first else {
            return XCTFail("expected a call, got \(events)")
        }
        XCTAssertEqual(id, "toolu_9")
        XCTAssertEqual(name, "computer")
        XCTAssertEqual(input["action"]?.stringValue, "left_click")
        XCTAssertEqual(input["coordinate"], [10, 20])
    }

    func testAMemberWithNoArgumentsIsStillACall() throws {
        var decoder = AnthropicStreamDecoder()
        _ = try decoder.events(from: Data(
            #"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_s","name":"screenshot","toolset_name":"computer","input":{}}}"#.utf8
        ))
        let events = try decoder.events(from: Data(#"{"type":"content_block_stop","index":0}"#.utf8))
        guard case let .toolCallRequested(_, name, input)? = events.first else { return XCTFail("\(events)") }
        XCTAssertEqual(name, "computer")
        XCTAssertEqual(input, ["action": "screenshot"])
    }

    func testAnOrdinaryToolUseIsUntouched() {
        let call = ComputerToolWire.internalCall(name: "read_file", toolsetName: nil, arguments: #"{"path":"a"}"#)
        XCTAssertEqual(call.name, "read_file")
        XCTAssertEqual(call.arguments, #"{"path":"a"}"#)
    }

    func testOpenAIResponsesImagesCarryDetailOriginal() throws {
        let messages: [ModelMessage] = [
            .user("Look"),
            .toolCall(id: "c1", name: "computer", input: ["action": "screenshot"]),
            .toolResultWithImages(id: "c1", content: "Screenshot.", isError: false, images: [ModelImage(mediaType: "image/png", data: Data([1]), detail: .original)]),
        ]
        let body = ComputerToolWire.openAI(
            OpenAIResponsesRequestBuilder.body(for: request(messages), providerModelID: "gpt-5.5-codex", maxTokens: 1_024),
            providerID: "openai",
            wire: .openAIResponses
        )
        XCTAssertTrue(body.canonicalJSONString().contains(#""detail":"original""#))
        XCTAssertTrue(try XCTUnwrap(body["tools"]?.arrayValue).contains { $0["name"]?.stringValue == "computer" })
    }

    func testOpenAIChatHasNoOriginalSoItGetsHighInsideTheBox() throws {
        let messages: [ModelMessage] = [
            .user("Look"),
            .toolCall(id: "c1", name: "computer", input: ["action": "screenshot"]),
            .toolResultWithImages(id: "c1", content: "Screenshot.", isError: false, images: [ModelImage(mediaType: "image/png", data: Data([1]), detail: .original)]),
        ]
        let body = ComputerToolWire.openAI(
            OpenAIChatRequestBuilder.body(for: request(messages), providerModelID: "gpt-5.5", providerID: "openai", maxTokens: 1_024),
            providerID: "openai",
            wire: .openAIChat
        )
        let encoded = body.canonicalJSONString()
        XCTAssertFalse(encoded.contains(#""detail":"original""#))
        XCTAssertTrue(encoded.contains(#""detail":"high""#))
    }

    func testRoutesWithoutAKnownTupleConventionLoseOnlyTheTupleTools() throws {
        for provider in ["google", "qwen", "deepseek", "mistral"] {
            let body = ComputerToolWire.openAI(
                OpenAIChatRequestBuilder.body(for: request(), providerModelID: "model", providerID: provider, maxTokens: 1_024),
                providerID: provider,
                wire: .openAIChat
            )
            let names = body["tools"]?.arrayValue?.compactMap { $0["function"]?["name"]?.stringValue } ?? []
            XCTAssertEqual(names, ["read_file", "computer_apps"], provider)
        }
    }

    func testEveryOtherRouteKeepsThePortableToolAndSeesItsScreenshots() throws {
        let portable = ModelToolDescriptor(
            name: "computer_use",
            description: "Use an app",
            inputSchema: ["type": "object", "properties": ["action": ["type": "string"]], "required": ["action"]]
        )
        let messages: [ModelMessage] = [
            .user("Look"),
            .toolCall(id: "c1", name: "computer_use", input: ["action": "screenshot"]),
            .toolResultWithImages(id: "c1", content: "Looked at Pages.", isError: false, images: [ModelImage(mediaType: "image/jpeg", data: Data([1]), detail: .original)]),
        ]
        for provider in ["google", "xai", "deepseek"] {
            let body = ComputerToolWire.openAI(
                OpenAIChatRequestBuilder.body(
                    for: request(messages, tools: [readTool, portable, computerTool]), providerModelID: "m", providerID: provider, maxTokens: 1_024
                ),
                providerID: provider,
                wire: .openAIChat
            )
            let names = body["tools"]?.arrayValue?.compactMap { $0["function"]?["name"]?.stringValue } ?? []
            XCTAssertEqual(names, ["read_file", "computer_use"], provider)
            let encoded = body.canonicalJSONString()
            XCTAssertTrue(encoded.contains("image_url"), "the screenshot reaches the model")
            XCTAssertFalse(encoded.contains(#""detail":"original""#), "no lab but OpenAI Responses knows original")
        }
    }
}
